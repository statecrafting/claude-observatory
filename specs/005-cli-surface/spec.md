---
id: "005-cli-surface"
title: "CLI surface: watch, log, stats, snapshot, diff"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: low
depends_on:
  - "001-observed-universe"
  - "002-filesystem-watcher"
  - "003-event-classification"
  - "004-event-store"
origin:
  retroactive: true
summary: >
  The command dispatcher and the five data-plane commands: live watch with
  raw/no-db/quiet flags, event-log querying with since/path/kind/action/limit
  filters, aggregate stats (by kind, hottest paths, biggest churn), snapshot
  capture/listing, and snapshot diffing (added/removed/changed with
  replaced-vs-touched discrimination). Also the shared line formatter with
  NO_COLOR-aware ANSI output.
establishes:
  - "src/index.ts"
  - "src/format.ts"
  - "src/commands/watch.ts"
  - "src/commands/query.ts"
  - "src/commands/snapshot.ts"
---

# 005: CLI surface

## 1. Purpose

The CLI is the tool's control plane. This spec pins command semantics, flag
grammar, and output shapes precisely enough that the future orchestrator (and
its tests) can drive and parse them.

## 2. Territory

`src/index.ts` (dispatch and usage text), `src/format.ts` (event line format,
byte/time formatting, color), `src/commands/watch.ts`,
`src/commands/query.ts` (`log`, `stats`), `src/commands/snapshot.ts`
(`snapshot`, `diff`).

## 3. Behavior

- **B-1 (dispatch).** `assertLayout()` runs before any command. Unknown
  command prints usage and exits 1; no command prints usage and exits 0.
  There is no `--help` or version flag in v1.
- **B-2 (watch).** Prints a startup line with tracked-entry count and db/raw
  state, streams one formatted line per event (print happens before the db
  insert), and shuts down cleanly on SIGINT/SIGTERM (stop watcher, close db,
  print `observatory: stopped`, exit 0). `--raw` appends the raw-note line,
  `--no-db` disables persistence entirely, `--quiet` suppresses per-event
  output.
- **B-3 (log).** Filters compose as ANDed SQL conditions: `--since` (spec
  004 B-6), `--path` glob (spec 004 B-7), exact `--kind` and `--action`,
  `--limit` defaulting to 200. Selection is newest-N, displayed oldest-first;
  the footer reports the count and whether the limit was reached.
- **B-4 (stats).** Within the optional `--since` window: total count and
  span, per-kind counts with churn (sum of absolute deltas), top 15 hottest
  paths by event count, top 10 paths by churn. Zero events reports
  `no events recorded` and exits cleanly.
- **B-5 (snapshot).** `snapshot` takes a snapshot labeled `manual` by
  default or `--label <s>`; `--list` enumerates snapshots with id, time,
  entry count, label.
- **B-6 (diff).** Takes two snapshot ids (first two fully-numeric args),
  keys on path, and reports added (with size), removed, and changed, where a
  change note is size delta when sizes differ, `replaced` when only the
  inode differs, else `touched`. Sections cap at 200 printed lines with a
  `... n more` tail. Missing/empty snapshots exit 1 with a usage hint.
- **B-7 (formatting).** Event lines are
  `time  delta  kind  label  relPath` with fixed padding; delta renders only
  for modified/replaced. Color is enabled only on a TTY without NO_COLOR;
  byte counts use decimal units with one decimal and a sign.

## 4. Out of scope

`explain`/`peek` (spec 006), `daemon` (spec 007), JSON output modes, and a
`--help` system. A future typed API (orchestrator specs) supersedes parsing
these text outputs; the shapes above remain for humans.

## 5. Known defects (recorded, not blessed)

- Unknown flags are silently ignored everywhere; flag values are found by
  positional `indexOf`, so `--label` as the last arg stores SQL NULL and
  prints `undefined`.
- A bad `--since` value throws a stack trace instead of exiting cleanly.
- `log` creates an empty database as a side effect of querying (openDb on a
  read path).
- `diff` ignores non-numeric arguments rather than rejecting them, and
  compares mode bits it never displays.
