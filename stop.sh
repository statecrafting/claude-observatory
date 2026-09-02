#!/usr/bin/env bash
# stop.sh: stop everything ./start.sh started (spec 023 B-5).
#
#   ./stop.sh [--no-watcher]
#
# The orchestrator daemon gets exactly what `orchestrator daemon stop` sends:
# one SIGTERM, then a wait for its lock to release (spec 021 B-6). Nothing
# here escalates to SIGKILL; a daemon that ignores SIGTERM is reported with
# its pid and lock path and the operator decides. The watcher is stopped the
# same way (spec 007 B-2) and, because that verb does not wait, this script
# polls the old pid briefly so "stopped" is a fact rather than a hope.

set -uo pipefail
cd "$(dirname "$0")"

watcher=1
for arg in "$@"; do
  case "$arg" in
    --no-watcher) watcher=0 ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "stop.sh: unknown flag: $arg" >&2
      echo "usage: ./stop.sh [--no-watcher]" >&2
      exit 3
      ;;
  esac
done

step() { printf '\n[stop] %s\n' "$1"; }
status=0

step "orchestrator daemon (bun src/index.ts orchestrator daemon stop)"
if ! bun src/index.ts orchestrator daemon stop; then
  status=1
fi

if [ "$watcher" -eq 1 ]; then
  step "observatory watcher (bun src/index.ts daemon stop)"
  pidfile="data/daemon.pid"
  pid=""
  [ -f "$pidfile" ] && pid="$(tr -d '[:space:]' < "$pidfile")"
  bun src/index.ts daemon stop
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "stop.sh: watcher pid $pid is still alive 5s after SIGTERM" >&2
      status=1
    else
      echo "watcher pid $pid has exited"
    fi
  fi
else
  step "observatory watcher left alone (--no-watcher)"
fi

step "status"
# `daemon status` exits 2 when nothing holds the lock; here that is the
# outcome we want, so only the text is reported.
bun src/index.ts orchestrator daemon status || true
bun src/index.ts daemon status || true

exit "$status"
