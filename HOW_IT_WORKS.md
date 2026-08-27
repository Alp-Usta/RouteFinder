# RouteFinder — how it works

A walkthrough of what the code does and why, written to be read start to finish.

---

## The problem

A dispatcher gets a manifest: a few hundred packages, each with a tracking number
and a postal code. They have some number of drivers, each booked for a block of
2 to 4 hours, each driving their own car: a sedan, an SUV or a pickup.

Somebody has to decide which packages go with which driver. Do it badly and a
driver spends the whole block in the car, or turns up with a package that won't
fit in their trunk, or runs an hour past their block.

RouteFinder makes that decision. It does **not** decide what order the driver
visits the stops in on the road. The driver's own delivery app handles that once
they're loaded.

---

## The three files

| File | What lives there |
|---|---|
| `server.js` | Everything: intake, geocoding, the main planner, the API |
| `cluster_planner.js` | An alternative planner, switchable in the UI |
| `index.html` | The whole front end. Plain JS, no framework |

---

## What happens when you press Calculate

### 1. Intake

The manifest comes in as CSV. The parser handles quoted fields, byte-order
marks, unit suffixes on dimensions, and several spellings of each column header,
because the export format isn't consistent between versions.

Every package is sorted into one of three piles:

- **Deliverable** — goes to a driver
- **Returns** — the destination field holds a facility code rather than a
  customer address. These go back to a warehouse and are never routed
- **Held** — a business address while the "residential only" switch is on

Only the first pile goes any further. A blank destination or blank address type
counts as a customer address and residential respectively, because blank usually
means nobody filled it in, not that it's a business.

### 2. Sizing

For each package, length × width × height gives a cubic volume in litres.

Two wrinkles:

**Envelopes.** A padded mailer squashes into the gap between two boxes. Charging
it full volume badly overstates the space it takes. Anything under 6 cm thick and
under 6 L is charged at a quarter of its cubic.

**The longest side is tracked separately.** A 142.9 cm package is only 29 L, so
the volume math says a sedan can take it. It cannot: it won't go through the
trunk opening. Both numbers are checked independently everywhere.

### 3. Geocoding

Each postal code becomes a lat/lng. A local database handles almost everything;
Nominatim is the fallback for anything it misses.

Packages sharing a postal code become one **stop**, since a driver parks once and walks.

### 4. The drive-time matrix

Every stop-to-stop drive time comes from a self-hosted GraphHopper instance
running OpenStreetMap data. For N stops this is an N×N grid of seconds.

Unreachable pairs get 99999 as a sentinel. Every piece of code that reads the
matrix has to check for it, or that number gets treated as a real distance and
the arithmetic goes silently wrong.

**This matrix is the input to everything downstream.** Not straight-line
distance, not ZIP proximity: actual road drive times.

### 5. Splitting by state

Stops are bucketed by state and each bucket is planned separately. That is
deliberate — no driver should get stops in two states.

The fleet is divided across the buckets before planning, proportional to how
much work each state holds, with the longest blocks going to the busiest state.

> This used to be a bug: every bucket got handed the full driver list, so a
> two-state manifest produced roughly double the routes you asked for. It never
> showed up on single-state data, which is all that gets run day to day.

---

## The planner

### The constraints

| Constraint | What it stops |
|---|---|
| Van capacity | Too many packages for one vehicle |
| Cubic volume | Load bigger than the vehicle's usable space |
| Longest item | A package that won't physically fit through the opening |
| Block time | Route running past the driver's booked hours |
| Drive share | Spending the block driving instead of delivering |
| Max gap between stops | Long hops between consecutive stops |
| Route width | The route sprawling across the map |
| Drive-out allowance | Seeding a driver absurdly far from the warehouse |

Two of these deserve explaining.

**Drive share** is the one that fixed long blocks. The time budget alone stopped
constraining anything when packages were spread thin — few packages means little
service time, so a 4-hour budget would happily permit 3 hours of driving. Local
driving is now capped at 55% of the block.

The drive *out* to the first stop is excluded from that cap. You pay it once, and
a long run to a tight cluster is a perfectly good route. What's capped is the
driving between stops, which you pay all day.

**Relaxation** handles the case where nothing fits. Rather than giving up, the
planner retries with more slack, in tiers. Each tier adds a fixed amount.

> It used to *multiply* instead of add, which compounded with the per-hour
> scaling. A 4-hour driver ended up allowed roughly six times what a 2-hour
> driver got — which is exactly why 2-hour routes always looked fine and 4-hour
> ones sprawled.

### How a route gets built (auto mode)

**Seeding.** Each driver gets a starting stop. The score prefers areas with lots
of packages, counting both the stop itself and everything within reach of it. A
ZIP with one package but five more next door is a six-package area and gets
treated as one.

The drive out from the warehouse counts against a seed, but only lightly. Getting
packages delivered matters more than saving a few minutes at the start.

**Growing.** The driver takes the best available stop, repeatedly, until nothing
fits. If nothing fits at all, relaxation loosens a tier and it tries again.

**When two drivers are similarly close** to a package, the one with less work
takes it. Beyond a few minutes of difference, distance decides and balance
doesn't get a vote.

### Manual mode

With a fixed fleet the planner can't invent drivers, so it works differently: it
fills **one driver at a time, starting from the densest area left**. Take the
busiest cluster, give it to a driver, grow that driver until something stops it,
then move to the next. Whatever nobody can reach goes to the unassigned pile to
be handed out by hand.

> This replaced an earlier approach that seeded every driver first and then let
> them bid in parallel. That commits to positions before knowing where the work
> is, and it showed: drivers anchored on near-empty areas while the busy ones
> went unclaimed. On the test manifest the rewrite took delivery from 21 packages
> to 28 and average block usage from 30% to 53%.

Two things made the difference, and both are worth knowing because they look
like sensible rules until you measure them:

**A cap on how far a driver may start from the warehouse** ruled out 8 of 19
areas holding 19 of 32 packages, including both dense ones. The test now asks
whether the drive out *plus the work waiting there* fits the block. A 43-minute
run to six packages is a good day. A 43-minute run to one package isn't, and the
scoring rejects that on its own.

**The gap-between-stops limit was starving everyone.** Instrumenting the
assignment loop showed 205 rejections, every single one that limit — not time,
not capacity. Drivers were finishing at 10% of their block with hours to spare
because nothing was within reach. A driver with an empty block now gets extra
reach; one nearly full keeps the tight limit.

**Orphans.** Anything still homeless goes to the nearest route with room. Width
and step rules are relaxed here, but there's still a hard distance cap — bolting
a far orphan onto the nearest route is what used to draw long tentacles across
the map. Better to leave it unassigned and say why.

**Clean-up.** Overlapping routes get merged. Stops get swapped between routes
where another driver is genuinely closer. Empty drivers get filled by peeling
outliers off the heaviest routes.

**Scoring.** When choosing the next stop, distance from the last stop isn't
enough on its own. A stop can sit right next to where the driver already is and
still stretch the route's overall span — and span is what eats the block. So a
stop that widens the route gets penalised even when it's nearby.

---

## The second planner

`cluster_planner.js` takes the opposite approach: settle the geography first,
then hand out the work.

It runs **k-medoids** on the drive-time matrix. Pick k centres, assign every stop
to one, move each centre to whichever stop is most central to its cluster,
repeat. Then match clusters to drivers by capacity.

Stops are assigned in order of **regret** — how much worse their second-choice
cluster would be. Whoever has the least room to compromise picks first.

**Why bother.** The default planner grows routes one at a time, so what ends up
together depends partly on who bid first. Clustering first makes the grouping a
property of the map instead.

**What it's better at.** Load balance, clearly. On the test manifest the default
planner gave three drivers 27%, 74% and 37% of their blocks. Cluster-first gave
51%, 55% and 66%.

**Caveat:** matching clusters to drivers is where a bug once shipped. Each cluster
is built against one specific driver, so sorting both lists and zipping them can
drop an SUV-sized cluster onto a sedan. Every pairing is fit-checked now.

The default planner is still the default. The switch is in the UI, along with a
"run both and compare" button.

---

## Safety checks

Planning won't break its own rules. Moving a package by hand will. Every route is
checked on the way out:

- Over the block time
- Over the package limit
- Over cubic capacity
- Carrying an item too long for the vehicle
- Containing an unreachable stop
- Containing an oversized gap between stops

Errors are red and mean don't dispatch. Warnings are amber and mean look at it.
The banner is clickable and opens just the flagged routes.

A manual move is never *blocked* for breaking a limit. That's the point of an
override: the dispatcher can see something the solver can't. The move goes
through, the consequence gets reported, and the route is marked as hand-adjusted
so nobody forgets an hour later.

> This caught a real bug on its first run: a route flagged *"A 142.9cm item will
> not fit a Sedan."* That was the cluster-matching bug above. The check found it
> after a full regression suite had passed.

---

## Measuring whether any of this helps

The comparison is against what you'd get with no software: manifest top to
bottom, dealt into equal piles, one per driver.

Each pile is then sequenced the same way a real route is, because the driver's
app would sequence it either way. That takes stop ordering out of the comparison
entirely and leaves only the part this app is responsible for.

**Why the headline is a problem count, not a percentage.** Manifests usually
arrive ZIP-sorted, and ZIP codes are roughly geographic, so chopping one into
even piles produces surprisingly sensible piles. On raw drive time the gap is
small and sometimes negative.

The catch is that those piles aren't dispatchable. Nothing checks whether a pile
fits the block, fits the vehicle, or contains an item too long for the trunk. On
the test manifest, three of them fail. This plan is built to fail none.

Drive time is reported alongside, so both numbers are visible.

---

## Moving packages by hand

Every stop has a move link. You can move the whole stop or tick individual
packages out of it. Bags are excluded, since splitting one is never allowed.

The dialog shows a map with the stop being moved in amber and every candidate
driver's stops in their own colour, so you can see whose area it actually falls
in. Drivers are listed nearest first. A search box filters the package list and
also accepts a barcode scan: scan one, it ticks the match and clears itself.

Moves work in both directions with the unassigned pile, so a stop can be parked
to relieve a driver and picked back up later.

**The server recomputes the whole plan after a move** rather than patching the
two routes involved. A move changes stop order, which changes drive time, which
changes whether the route still fits its block. Patching means re-deriving all of
that by hand and getting it subtly wrong. Undo goes 20 steps back.

## Advice the app offers

**Remote areas.** Stops that sit far from the warehouse or have no neighbour
within reach are flagged before dispatch, with actions to assign them or park
them. These are the ones that quietly stretch a route across the map.

**Route relief.** When a driver has nothing assigned, the app ranks the working
routes by how much strain they're under and suggests which stop to move. A route
straining on *load* gets its heaviest stop suggested; one straining on *distance*
gets its outlier, since removing that shortens the route most. Single-stop routes
are excluded, because moving their only stop just relocates the idle driver.

---

## The front end

Plain HTML, CSS and JavaScript with MapLibre GL for the map. No framework.

Notable pieces:

**The scanner.** Type or scan the last four digits of a tracking number and it
says which driver has it, which stop, and the ETA. It searches routed packages
*and* screened-out ones. A return package used to report NOT FOUND, which reads
like a bad scan when really the package just belongs in a different bin.

**Per-stop ETA.** Set a departure time and every stop shows a clock time. Derived
from the drive-time matrix plus service time for everything delivered before it.

**Constraint editor.** All 56 tunables as sliders with typed inputs beside them.
Times are entered in minutes. Overrides apply to the next calculation only and
are reset server-side afterwards, so one person's experiment can't leak into
anyone else's run.

**Exception pages.** Returns and held addresses each get their own page with
per-package reasons and a CSV export.

---

## Things worth knowing before changing anything

**The 99999 sentinel.** Unreachable pairs in the matrix. Every read has to check
for it. Miss one and it becomes a 27-hour drive that the arithmetic accepts.

**The warehouse is at `route[0]`, but only on real routes.** Overflow routes have
no warehouse. Never identify it by position — there's an `isWarehouse` flag for
exactly this reason. Getting it wrong silently drops the first overflow stop from
the scanner, the dashboard, the route list and the CSV export.

**Config overrides must be reset.** They're applied per request and restored in a
`finally` block. Without that, one request's tweak changes everyone's next run.

**Client and server both compute package volume.** The client needs it for the
load summary before you press Calculate; the server can't trust the client. The
constants are duplicated and have to stay in sync.

**Bag integrity is absolute.** Packages in the same bag never get split across
drivers. `splitBigZips` skips bags entirely, and manual moves refuse to split one.

**Every routing constant must be reachable from the editor.** Three were once
hardcoded where no control could touch them, so tightening a limit changed the
safety check and not the routing — one part of the code obeyed the new number
and another didn't. There's an automated check for this now. If tuning a setting
only moves the warnings, look for a constant that slipped past the schema.

---

## Still open

- **Saved constraint presets.** The editor is session-only, so tuning is lost on
  reload. The only planned feature still outstanding.

Deliberately not built: weather integration, time-of-day traffic weighting, and
loading-order guidance. Each was measured or reasoned about and judged not worth
the complexity for what it would change. The reasoning is in the project
contract.
