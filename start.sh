#!/usr/bin/env bash
# Starts the routing engine and the app together. Ctrl-C stops both.
set -e

GH_JAR="$(ls graphhopper-web-*.jar 2>/dev/null | head -1)"
if [ -z "$GH_JAR" ]; then
  echo "Routing engine not found. Run ./setup.sh first."
  exit 1
fi
if [ ! -d "graph-cache" ]; then
  echo "Routing graph not built yet. Run ./setup.sh first."
  exit 1
fi

cleanup() {
  echo ""
  echo "Shutting down"
  kill $GH_PID $APP_PID 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "==> Starting routing engine on :8989"
java -Xmx4g -jar "$GH_JAR" server config-example.yml > graphhopper.log 2>&1 &
GH_PID=$!

echo "    waiting for it to come up"
until curl -s "http://localhost:8989/health" >/dev/null 2>&1; do
  if ! kill -0 $GH_PID 2>/dev/null; then
    echo "Routing engine failed to start. Last few lines of graphhopper.log:"
    tail -20 graphhopper.log
    exit 1
  fi
  sleep 2
done
echo "    ready"

echo "==> Starting the app on :3000"
node server.js &
APP_PID=$!

echo ""
echo "Open http://localhost:3000"
echo "Ctrl-C to stop both."
wait
