---
id: "001-observed-universe"
title: "The observed universe: paths, layout separation, and the walker"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: foundation
implementation: complete
risk: medium
origin:
  retroactive: true
summary: >
  Defines what claude-observatory observes and where its own artifacts live.
  The observed universe is ~/.claude (recursive) plus the sibling state file
  ~/.claude.json, nothing else. Path resolution, the canonical relative-path
  key, the ignore list, the lstat-based tree walker, and the layout assertion
  that refuses to run when the project directory sits inside the watch root.
  Carries the repository's first invariant: the tool is read-only toward the
  observed universe.
establishes:
  - "src/paths.ts"
  - "src/walker.ts"
---

# 001: The observed universe

## 1. Purpose

Everything the tool does is scoped by two hardcoded roots and one relative-path
convention. This spec pins them, together with the walker that enumerates the
universe and the invariants every other spec builds on.

## 2. Territory

`src/paths.ts` (constants, `rel()`, `isIgnored()`, `assertLayout()`) and
`src/walker.ts` (`statEntry()`, `walkTree()`, `walkUniverse()`).

## 3. Behavior

- **B-1 (roots).** `WATCH_ROOT` MUST be `~/.claude` (via `homedir()`) and
  `STATE_FILE` MUST be `~/.claude.json`. There is no env or CLI override in
  v1; introducing one is a change to this spec.
- **B-2 (artifact home).** `PROJECT_DIR` derives from the source location
  (parent of `src/`), never from cwd. All produced artifacts (db, WAL/SHM,
  daemon log, pidfile, baselines) live under `DATA_DIR = PROJECT_DIR/data`,
  which is gitignored.
- **B-3 (layout separation).** `assertLayout()` MUST refuse to run (throw)
  when `PROJECT_DIR` equals or sits beneath `WATCH_ROOT`, so the tool can
  never observe its own output.
- **B-4 (canonical key).** `rel()` maps: exact `STATE_FILE` to the literal
  string `~/.claude.json`; descendants of `WATCH_ROOT` to tree-relative paths
  with no leading slash; `WATCH_ROOT` itself to `.`; anything else passes
  through as an absolute path. This is the storage and display key everywhere.
- **B-5 (ignore list).** Ignored entries: basename `.DS_Store`; suffixes
  `.swp`, `.swo`, `~`. Applied in the tree walker, the recursive watcher
  callback, and directory reconcile. Deliberately NOT applied to the home-dir
  watcher (spec 002) or to a walk root.
- **B-6 (walker).** `statEntry()` MUST use `lstat` (symlinks are never
  followed); kind precedence dir > file > symlink > other; directory size is
  forced to 0; any stat error yields null. `walkTree()` records the root
  first, silently skips unreadable directories, and recurses only into real
  directories. `walkUniverse()` is `walkTree(WATCH_ROOT)` plus `STATE_FILE`
  when present, and is the single definition of "the observed universe" used
  by the watcher seed, snapshots, and baselines.
- **B-7 (read-only invariant).** No code path in this repository may issue a
  mutating syscall against the observed universe. Permitted operations are
  stat/lstat, readdir, watch, and read-only open/read/close (spec 006).
  This invariant binds every current and future spec in this corpus,
  including the orchestrator specs.

## 4. Out of scope

Configurable watch roots, multiple universes, and following symlinks. The
orchestrator (specs 010+) observes `~/.claude` through this same surface and
inherits B-7; any write surface it needs (its own state) lives outside the
observed universe.

## 5. Known defects (recorded, not blessed)

- `explain`'s `~/` expansion reads `process.env.HOME` instead of `homedir()`
  (one inconsistency, spec 006 territory).
- Unreadable directories degrade silently (B-6), so snapshot entry counts can
  differ without any real filesystem change; acceptable, but undocumented in
  user-facing output.
