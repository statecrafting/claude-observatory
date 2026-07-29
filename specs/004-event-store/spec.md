---
id: "004-event-store"
title: "Append-only SQLite event store and snapshots"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: engine
implementation: complete
risk: medium
depends_on:
  - "001-observed-universe"
origin:
  retroactive: true
summary: >
  Persistence for observed events and full-tree snapshots: a WAL-mode
  bun:sqlite database at data/observatory.db with three tables (events,
  snapshots, snapshot_entries), append-only by construction (no code path
  updates or deletes rows), plus the --since parser and the glob-to-LIKE
  translator the query commands share. Metadata only: no file content is
  ever persisted.
establishes:
  - "src/db.ts"
---

# 004: Append-only event store

## 1. Purpose

The event log is the tool's memory and the evidence base for FINDINGS-style
research; snapshots make tree states diffable across time. Both must be
trustworthy: append-only, metadata-only, and cheap to write from the live
watcher path.

## 2. Territory

`src/db.ts`: `openDb()`, `insertEvent()`, `takeSnapshot()`, `parseSince()`,
`globToLike()`, schema DDL.

## 3. Behavior

- **B-1 (location and mode).** The database lives at `DATA_DIR/observatory.db`
  (spec 001 B-2), created on first open with `journal_mode = WAL`. Any
  db-touching command creates it; schema DDL is idempotent
  (`CREATE ... IF NOT EXISTS`), with no migration mechanism in v1.
- **B-2 (events table).** Columns: autoincrement id, ts (epoch ms), path
  (the spec 001 relative key), action, entry_kind, kind, label, size_before,
  size_after, delta, inode, raw (JSON array of raw notes, NULL when the event
  was derived from subtree adoption or reconcile rather than a notification).
  Indexes on ts, path, kind.
- **B-3 (append-only invariant).** No code path in this repository issues
  UPDATE, DELETE, DROP, or VACUUM against the store. Event ids are monotonic.
  There is no retention policy in v1; growth is bounded only by disk.
- **B-4 (metadata only).** Neither events nor snapshot entries carry file
  content, ever. Path strings are still private data, which is why `data/`
  is gitignored (spec 001 B-2).
- **B-5 (snapshots).** `takeSnapshot()` records label, timestamp, and entry
  count in `snapshots`, then every `walkUniverse()` entry (rel path, kind,
  size, rounded mtime, mode masked to permission bits, inode) into
  `snapshot_entries` in a single transaction. Snapshots are append-only and
  duplicates are permitted (re-import is legal).
- **B-6 (--since grammar).** `parseSince()` accepts `<n><s|m|h|d|w>` and
  returns an absolute epoch-ms cutoff; anything else throws with a usage
  message naming valid examples.
- **B-7 (glob translation).** `globToLike()` escapes `%` and `_`, collapses
  runs of `*` to `%`, maps `?` to `_`, and is used with `ESCAPE '\'`. SQLite
  LIKE default case-insensitivity is accepted behavior for `--path` filters.

## 4. Out of scope

Retention/pruning, schema versioning and migrations, content hashing, and
multi-writer coordination (WAL tolerates the accidental second writer; spec
007 records that nothing prevents one). The orchestrator's journal is NOT
this store: run state gets its own durable, hash-linked log (specs 010+);
this store remains observational evidence.

## 5. Known defects (recorded, not blessed)

- `insertEvent()` prepares its statement on every call; harmless at observed
  event rates, wasteful at higher ones.
- `snapshot_entries` has no foreign key to `snapshots`; nothing deletes, so
  orphans cannot occur today, but the schema does not defend the invariant.
- A NaN `--limit` (non-numeric argument) flows into SQL unvalidated (spec
  005 territory, recorded here because the parse helpers live in db.ts).
