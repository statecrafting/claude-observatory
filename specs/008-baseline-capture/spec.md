---
id: "008-baseline-capture"
title: "Baseline capture and import scripts"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: tooling
implementation: complete
risk: low
depends_on:
  - "001-observed-universe"
  - "004-event-store"
origin:
  retroactive: true
summary: >
  Phase-1 research tooling kept as part of the product surface: baseline.ts
  writes a one-shot JSONL metadata snapshot of the observed universe (path,
  kind, size, rounded mtime, octal permission bits, inode; never content) to
  data/baseline-<epoch-ms>.jsonl, and import-baseline.ts loads such a file
  into the snapshot tables as label "baseline", recovering the capture time
  from the filename.
establishes:
  - "scripts/baseline.ts"
  - "scripts/import-baseline.ts"
---

# 008: Baseline capture and import

## 1. Purpose

A baseline is the "before" picture that makes first-fill detection and
long-horizon diffs meaningful. JSONL (not the db) is the capture format so a
baseline can be taken before any schema exists and archived independently.

## 2. Territory

`scripts/baseline.ts`, `scripts/import-baseline.ts`.

## 3. Behavior

- **B-1 (capture).** `baseline.ts` runs the layout assertion, walks the
  universe, and writes one JSON object per line with metadata only, then
  prints the output path and an entry/byte summary. No content is read.
- **B-2 (import).** `import-baseline.ts` requires the JSONL path argument,
  parses the capture timestamp from the `baseline-<ts>.jsonl` filename
  (falling back to now), inserts a `snapshots` row labeled `baseline`, and
  loads all entries in one transaction (octal mode string parsed back to an
  integer). Re-importing the same file creates a new snapshot; dedup is the
  operator's concern.

## 4. Out of scope

Scheduled baselines and baseline comparison logic (`diff` in spec 005 covers
comparisons once imported).

## 5. Known defects (recorded, not blessed)

- `import-baseline.ts` does not call the layout assertion (spec 001 B-3);
  harmless today because it only reads its argument and writes to the db,
  but inconsistent with every other entry point.
