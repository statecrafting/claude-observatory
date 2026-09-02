#!/usr/bin/env bash
# start.sh: boot everything in this checkout with one command (spec 023 B-5).
#
# Order: preflight, dependencies, dashboard build, orchestrator daemon,
# observatory watcher, then both status views. Every step is one of the
# repository's own CLI verbs; this script adds no capability of its own.
#
#   ./start.sh [--restart] [--skip-build] [--no-watcher]
#
#   --restart      run ./stop.sh first (the answer to the daemon's
#                  "code-stale" idle after a self-repo merge, spec 026 D-7)
#   --skip-build   do not rebuild web/dist (the dashboard, spec 024)
#   --no-watcher   leave the ~/.claude watcher daemon (spec 007) alone
#
# The API and dashboard address follows the CLI's own resolution (023 D-6):
# OBSERVATORY_ORCHESTRATOR_URL, else http://127.0.0.1:4519.

set -euo pipefail
cd "$(dirname "$0")"

restart=0
build=1
watcher=1
for arg in "$@"; do
  case "$arg" in
    --restart) restart=1 ;;
    --skip-build) build=0 ;;
    --no-watcher) watcher=0 ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "start.sh: unknown flag: $arg" >&2
      echo "usage: ./start.sh [--restart] [--skip-build] [--no-watcher]" >&2
      exit 3
      ;;
  esac
done

url="${OBSERVATORY_ORCHESTRATOR_URL:-http://127.0.0.1:4519}"

step() { printf '\n[start] %s\n' "$1"; }

step "preflight"
for tool in bun spec-spine git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "start.sh: $tool is not on PATH; the daemon cannot run without it" >&2
    [ "$tool" = spec-spine ] && echo "start.sh: run /setup (or: npm install -g spec-spine)" >&2
    exit 1
  fi
done
echo "bun $(bun --version), $(spec-spine --version), HEAD $(git rev-parse --short HEAD) ($(git branch --show-current))"

if [ "$restart" -eq 1 ]; then
  step "restart requested: stopping first"
  if [ "$watcher" -eq 1 ]; then ./stop.sh; else ./stop.sh --no-watcher; fi
fi

step "dependencies (bun install --frozen-lockfile)"
bun install --frozen-lockfile

if [ "$build" -eq 1 ]; then
  step "dashboard (bun run web:build)"
  bun run web:build
else
  step "dashboard build skipped (--skip-build)"
fi

step "orchestrator daemon (bun src/index.ts orchestrator daemon start)"
bun src/index.ts orchestrator daemon start

if [ "$watcher" -eq 1 ]; then
  step "observatory watcher (bun src/index.ts daemon start)"
  bun src/index.ts daemon start
else
  step "observatory watcher skipped (--no-watcher)"
fi

step "status"
bun src/index.ts orchestrator status
echo
bun src/index.ts daemon status
echo
echo "dashboard: $url/"
