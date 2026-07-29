---
id: "011-work-journal"
title: "Durable hash-linked work journal"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
risk: critical
depends_on:
  - "010-orchestrator-thesis"
summary: >
  The crash-consistent memory of the orchestrator: an append-only,
  hash-linked JSONL journal using the attest-ledger record envelope
  (canonical key-sorted JSON, sha256 chain, seq = line index), with the two
  properties the family's existing ledger lacks: real durability (fsync
  before acknowledge) and O(1) appends (in-memory head cache). State is
  recovered by folding the journal, never trusted from memory. Intent is
  journaled before a mutation and outcome after it, so a crash between the
  two is detectable and a resumed run reads exactly what was and was not
  done.
establishes:
  - "src/orchestrator/journal.ts"
  - "src/orchestrator/journal.test.ts"
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 011: Durable hash-linked work journal

## 1. Purpose

Crash-consistency is the load-bearing promise of the daemon: killed mid-build
it must leave a resumable state, never a half-state a new session misreads as
finished. The journal is that mechanism, and it doubles as the evidence trail
the UI and the ledger seal build on.

## 2. Territory

`src/orchestrator/journal.ts` and its colocated tests. Storage lives at
`data/orchestrator/journal.jsonl` with `data/orchestrator/anchor.json` as the
genesis anchor (both gitignored with the rest of `data/`).

## 3. Behavior

- **B-1 (envelope).** Each line is one record: `{seq, ts, kind, payload,
  prevHash, recordHash}` where `recordHash` = sha256 over the canonical
  key-sorted JSON of the record minus `recordHash`, and `prevHash` links to
  the previous record (genesis links to the anchor hash). Hashed payloads
  hold only integers, strings, booleans, nulls, arrays, and objects of the
  same (no floats), matching the attest-ledger portability rule.
- **B-2 (durability).** An append is acknowledged only after the bytes and a
  trailing newline are flushed and fsynced. The file is opened append-only.
  One writer per journal, enforced with an exclusive advisory lock taken at
  daemon start.
- **B-3 (O(1) append).** The chain head (prevHash, seq) is cached in memory
  after open; open validates the tail (last line parses, hash links) without
  re-reading the whole file on the hot path, and a full verify walks the
  chain on demand.
- **B-4 (intent/outcome bracket).** Mutating operations journal
  `<op>.intent` before acting and `<op>.outcome` after. Recovery treats an
  intent without an outcome as "unknown, must reconcile", never as success.
- **B-5 (fold).** `foldState(records)` is a pure function from the journal
  to the orchestrator state (runs, specs, stages, quota). Resume = open,
  verify tail, fold. No state is persisted anywhere else.
- **B-6 (torn tail).** A torn final line (partial write from a crash) is
  detected on open, reported, preserved in a `journal.jsonl.torn` sidecar,
  and truncated; the journal remains usable. Any other corruption refuses to
  open (fail-closed) with a message naming the verify command.
- **B-7 (verification).** `verifyChain()` recomputes the chain and MUST be
  runnable by the CLI offline. The record format stays compatible with the
  attest-ledger verifier's expectations for record chains (independent
  verification is the point of the envelope).

## 4. Functional requirements

- **FR-001.** `openJournal(dir)` creates anchor + empty journal on first
  run; subsequent opens validate and return an appender plus the folded
  state.
- **FR-002.** `append(kind, payload)` returns the sealed record; a
  same-process crash between fsync and return can produce a duplicate-safe
  re-append on recovery (appends carry an idempotency key in payload where
  the operation demands it).
- **FR-003.** `verifyChain(dir)` returns ok or the first broken seq.
- **FR-004.** Tests cover: append/fold round-trip, torn-tail recovery,
  broken-chain refusal, lock exclusion of a second writer, and fsync being
  called before acknowledge (spy).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/journal.test.ts` passes.
- **AC-2.** Kill -9 during a scripted append storm leaves a journal that
  opens with at most one torn record and folds to a consistent state.
- **AC-3.** `verifyChain` detects a single flipped byte anywhere in the file.

## 6. Out of scope

Signing (the ledger seal arrives with the evidence export, after 019),
rotation/compaction, and multi-writer coordination.
