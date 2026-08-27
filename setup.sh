#!/usr/bin/env bash
# One-time setup. Downloads the routing engine and a map, installs node packages,
# and builds the routing graph. Run this once, then use ./start.sh from then on.
set -e

GH_VERSION="10.0"
GH_JAR="graphhopper-web-${GH_VERSION}.jar"
GH_URL="https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/${GH_JAR}"

# Change this if you deliver somewhere other than the US northeast.
# Full list of regions: https://download.geofabrik.de/
MAP_URL="${MAP_URL:-https://download.geofabrik.de/north-america/us-northeast-latest.osm.pbf}"
MAP_FILE="$(basename "$MAP_URL")"

echo "==> Checking what you have installed"
command -v java >/dev/null || { echo "Java is missing. Install JDK 17 or newer, then run this again."; exit 1; }
command -v node >/dev/null || { echo "Node is missing. Install Node 18 or newer, then run this again."; exit 1; }
echo "    java: $(java -version 2>&1 | head -1)"
echo "    node: $(node -v)"

echo "==> Installing node packages"
npm install

if [ ! -f "$GH_JAR" ]; then
  echo "==> Downloading the routing engine (about 100 MB)"
  curl -L -o "$GH_JAR" "$GH_URL"
else
  echo "==> Routing engine already here, skipping"
fi

if [ ! -f "$MAP_FILE" ]; then
  echo "==> Downloading map data (about 500 MB, this takes a while)"
  curl -L -o "$MAP_FILE" "$MAP_URL"
else
  echo "==> Map data already here, skipping"
fi

# Point the config at whichever map file actually got downloaded.
#
# This matters more than it looks. The Geofabrik "latest" links hand you a file
# named after the region, but a dated snapshot is named after its date, so the
# filename in config-example.yml almost never matches what you just downloaded.
# GraphHopper then fails with a file-not-found that reads like a config problem.
CONFIG="config-example.yml"
if [ ! -f "$CONFIG" ]; then
  echo "Can't find $CONFIG. It should be in the repo root next to server.js."
  exit 1
fi

CURRENT="$(grep -E '^[[:space:]]*datareader\.file:' "$CONFIG" | head -1 | sed 's/.*: *//; s/"//g; s/^ *//; s/ *$//')"

if [ "$CURRENT" = "$MAP_FILE" ]; then
  echo "==> Config already points at $MAP_FILE"
else
  echo "==> Pointing config at the map you downloaded"
  echo "    was:  ${CURRENT:-(not set)}"
  echo "    now:  $MAP_FILE"
  # Any leading whitespace, quoted or not. Portable between GNU and BSD sed.
  sed "s|^\([[:space:]]*\)datareader\.file:.*|\1datareader.file: \"${MAP_FILE}\"|" \
      "$CONFIG" > "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "$CONFIG"
fi

# Confirm it took, rather than trusting the edit
VERIFY="$(grep -E '^[[:space:]]*datareader\.file:' "$CONFIG" | head -1 | sed 's/.*: *//; s/"//g; s/^ *//; s/ *$//')"
if [ "$VERIFY" != "$MAP_FILE" ]; then
  echo "Could not update $CONFIG automatically."
  echo "Open it and set this line by hand, then run setup again:"
  echo "    datareader.file: \"${MAP_FILE}\""
  exit 1
fi
if [ ! -f "$MAP_FILE" ]; then
  echo "Config points at ${MAP_FILE} but that file isn't here. Download may have failed."
  exit 1
fi

if [ ! -d "graph-cache" ]; then
  echo "==> Building the routing graph"
  echo "    First run only. Expect 10 to 30 minutes depending on the machine."
  echo "    It will say 'Started server' when it's ready. That's your cue to stop it."
  java -Xmx4g -jar "$GH_JAR" server config-example.yml &
  GH_PID=$!
  # Wait for it to finish importing and come up, then shut it down
  until curl -s "http://localhost:8989/health" >/dev/null 2>&1; do
    if ! kill -0 $GH_PID 2>/dev/null; then
      echo "The routing engine stopped early. Check the output above."
      exit 1
    fi
    sleep 10
  done
  echo "==> Graph built"
  kill $GH_PID 2>/dev/null || true
  wait $GH_PID 2>/dev/null || true
else
  echo "==> Routing graph already built, skipping"
fi

echo ""
echo "Setup finished. Start the app with:"
echo "    ./start.sh"
