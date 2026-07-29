---
id: "002-filesystem-watcher"
title: "State-diffing filesystem watcher"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: engine
implementation: complete
risk: medium
depends_on:
  - "001-observed-universe"
  - "003-event-classification"
origin:
  retroactive: true
summary: >
  The event engine: two fs.watch handles (recursive over the watch root,
  non-recursive over the home directory for the state file and its atomic
  temp siblings), per-path trailing-edge debounce at 200 ms, a shadow state
  table diffed on flush, inode-change detection distinguishing atomic replace
  from in-place modification, shallow directory reconcile as the FSEvents
  coalescing safety net, and subtree adoption/forgetting on directory
  create/delete. Emits ObservedEvent records into a caller-supplied sink.
establishes:
  - "src/watcher.ts"
---

# 002: State-diffing filesystem watcher

## 1. Purpose

Raw fs.watch notifications are unreliable in count and meaning. The watcher
turns them into semantically stable events by diffing a shadow table of the
universe, so downstream consumers see created/modified/replaced/deleted with
byte deltas, not notification noise.

## 2. Territory

`src/watcher.ts`: the `Observatory` class, `RawNote`, `ObservedEvent`,
`EventSink`, `WatcherOptions`.

## 3. Behavior

- **B-1 (two watchers).** Watcher A: `fs.watch(WATCH_ROOT, recursive)`,
  ignore-filtered per spec 001 B-5. Watcher B: non-recursive watch of the
  home directory, kept precisely so atomic rename-replace of `~/.claude.json`
  is visible; it passes only names starting with `.claude.json` and applies
  no ignore filter.
- **B-2 (seed).** `start()` seeds the shadow table from `walkUniverse()`
  without emitting events and reports the tracked-entry count.
- **B-3 (debounce).** Per-path trailing-edge debounce, default 200 ms. Every
  raw note is appended to the path's pending list; the timer resets on each
  note; one flush can therefore represent many raw notes, all preserved in
  the emitted event's `raw` field.
- **B-4 (diff state machine).** On flush, with prev = shadow entry and cur =
  fresh lstat: absent/absent emits nothing; present/absent emits `deleted`
  (children first via subtree forget, then the parent); absent/present emits
  `created` (parent first, then subtree adoption for directories);
  present/present compares inode, size, and millisecond-rounded mtime, emits
  nothing when all three are unchanged, `replaced` when the inode changed,
  else `modified`. `replaced` is defined exactly as inode change on a
  surviving path: this is the atomic-replace detector.
- **B-5 (directory reconcile).** After flushing a path that is currently a
  directory, a shallow readdir reconcile detects vanished and new children
  that FSEvents coalescing hid, skipping any child with its own pending
  debounce timer to avoid double reporting.
- **B-6 (event fields).** Events carry ts (emit time), path, relPath (spec
  001 B-4), action, entryKind, sizeBefore/sizeAfter (files only; directories
  count as 0, absent as null), delta (signed; creation counts +size,
  deletion -size), inode, kind and label from classification (spec 003), and
  the raw note list. Emission is synchronous into the sink; no queue, no
  dedup beyond the debounce window.
- **B-7 (stop).** `stop()` clears pending timers and closes both watchers;
  the shadow table survives for a later restart within the same process.

## 4. Out of scope

Content hashing, event persistence (spec 004), backpressure, and configurable
debounce (the 200 ms default is not exposed on any CLI surface).

## 5. Known defects (recorded, not blessed)

- Sub-millisecond mtime-only changes are invisible (mtime compared after
  rounding); accepted as below the tool's resolution.
- The shadow table grows without bound as new paths appear and is pruned only
  on delete; acceptable for a home-directory universe.
- Home-dir temp siblings of the state file reach the sink with absolute
  paths (spec 001 B-4 passthrough), which defeats classification rule 17's
  temp-sibling branch (spec 003 defect list).
