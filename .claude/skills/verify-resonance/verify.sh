#!/usr/bin/env bash
# Launches, checks, drives and stops one verification instance of Resonance.
# Usage: verify.sh launch|doctor|cleanup, or verify.sh drive <spec> [title regex]. PORT (default 4193) picks the instance.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
port=${PORT:-4193}
out=e2e/.out/verify
pidfile=$out/server-$port.pid
mkdir -p "$out"

alive() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
assets() { grep -o 'assets/[A-Za-z0-9_.-]*\.js' | sort -u; }

case ${1:-} in
launch)
  if alive; then echo "already running: http://localhost:$port/ (pid $(cat "$pidfile"))"; exit 0; fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null; then echo "port $port is taken by another process; pick another PORT"; exit 1; fi
  npm run build >"$out/build.log" 2>&1 || { tail -20 "$out/build.log"; exit 1; }
  nohup node_modules/.bin/vite preview --port "$port" --strictPort >"$out/server-$port.log" 2>&1 &
  echo $! >"$pidfile"
  for _ in $(seq 60); do
    if curl -sf "http://localhost:$port/" | grep -q '<title>Resonance'; then echo "ready: http://localhost:$port/ (pid $(cat "$pidfile"))"; exit 0; fi
    sleep 0.5
  done
  echo "not ready after 30 s"; tail -20 "$out/server-$port.log"; exit 1
  ;;
doctor)
  alive || { echo "FAIL: no instance started by verify.sh on port $port"; exit 1; }
  pid=$(cat "$pidfile")
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | grep -qx "$pid" || { echo "FAIL: port $port is not served by pid $pid"; exit 1; }
  served=$(curl -sf "http://localhost:$port/" | assets)
  [ "$served" = "$(assets <dist/index.html)" ] || { echo "FAIL: the server is not serving dist/ as built now"; exit 1; }
  stale=$(find src index.html beacon.html -newer dist/index.html -type f | head -1)
  dirty=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')
  echo "OK: http://localhost:$port/ pid $pid, commit $(git rev-parse --short HEAD), $dirty changed files${stale:+, WARNING: $stale changed after the build, relaunch}"
  ;;
drive)
  [ $# -ge 2 ] || { echo "usage: verify.sh drive <spec> [title regex]"; exit 1; }
  alive || { echo "launch first"; exit 1; }
  E2E_PORT=$port npx playwright test "$2" ${3:+-g "$3"} --reporter=list
  ;;
cleanup)
  if alive; then
    pid=$(cat "$pidfile")
    kill "$pid"
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  fi
  rm -f "$pidfile"
  echo "stopped port $port; evidence kept in $out/"
  ;;
*)
  sed -n 2,3p "$0"; exit 1
  ;;
esac
