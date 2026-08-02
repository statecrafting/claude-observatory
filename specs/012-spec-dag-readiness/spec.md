---
id: "012-spec-dag-readiness"
title: "Spec DAG readiness: pinning, invalidation, cycle refusal"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: high
depends_on:
  - "010-orchestrator-thesis"
summary: >
  The DAG resolver the orchestrator schedules from. spec-spine deliberately
  attaches no mechanics to depends_on (no readiness, no cycle detection, no
  invalidation), so this spec adds them as product behavior: registry reads
  through spec-spine subcommands only, contract pinning as sha256 over the
  dependency's spec.md bytes (the same normalization spec-spine hashes use),
  readiness = all dependencies shipped with matching pins, amendment
  invalidates downstream pins, and any dependency cycle among pending specs
  refuses the run rather than guessing an order.
establishes:
  - "src/orchestrator/dag.ts"
  - "src/orchestrator/dag.test.ts"
---

# 012: Spec DAG readiness

## 1. Purpose

Scheduling needs three answers spec-spine does not give: what is ready, what
became invalid, and whether the graph is even executable. This spec is those
answers, computed honestly from the target repo's corpus.

## 2. Territory

`src/orchestrator/dag.ts` and tests. Pins live in the work journal (spec
011), not in files of the target repo.

## 3. Behavior

- **B-1 (governed reads).** Structural data comes from `spec-spine registry
  list/show/status-report --json` subprocess calls against the target repo.
  The orchestrator never parses `.derived/**` JSON directly.
- **B-2 (contract hash).** `pinOf(specId)` = sha256 over the bytes of
  `specs/<id>/spec.md` after BOM strip and CRLF/CR to LF normalization
  (identical rules to spec-spine's input hashing, so the pin equals the
  registry shard's notion of the spec's content).
- **B-3 (readiness).** `ready(specId)` iff the spec's own registry status
  is schedulable (approved, or absent from a reader that does not emit it;
  D-3) AND every `depends_on` target is shipped (spec 010 definition,
  tracked in the journal) AND the pin recorded at that dependency's ship
  time equals `pinOf(dep)` now. A spec with no dependencies and a
  schedulable status is ready.
- **B-4 (invalidation).** When `pinOf(dep)` drifts from the recorded pin,
  every transitive dependent that was shipped drops to `invalidated` and
  requires re-verification (spec 019) before counting as shipped again; the
  transition is journaled with both hashes.
- **B-5 (cycles).** Cycle detection runs over the full `depends_on` graph
  before every scheduling decision. A cycle among specs that are not all
  shipped refuses scheduling with the cycle path named. spec-spine compiles
  cycles clean, so this is the only guard.
- **B-6 (next).** `nextReady()` returns the lowest-numbered ready spec with
  `implementation: pending` and a schedulable status (D-3), mirroring the
  AGENTS.md backlog protocol, or null with the blocking reasons per pending
  spec (honest blockers for the UI). An unapproved pending spec is reported
  as a blocker naming its status, never offered and never silently hidden.

## 4. Functional requirements

- **FR-001.** Registry subprocess failures surface as typed errors
  (spec-spine absent, compile failing, non-zero exits) and never as empty
  DAGs.
- **FR-002.** All functions are pure given (registry snapshot, journal
  state, pin function); subprocess and file reads sit behind an injected
  reader so tests run against fixtures.
- **FR-003.** Tests cover: readiness with and without pins, invalidation
  cascade depth >= 2, cycle refusal naming the path, nextReady tie-break by
  number, and blocker reporting.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/dag.test.ts` passes.
- **AC-2.** Against this repo's own corpus, `nextReady()` returns
  011-work-journal when nothing is shipped (the bootstrap order is itself
  the fixture).

## 6. Out of scope

Cross-repo DAGs, parallel wavefront computation, and writing anything into
the target repo's specs.

## 7. Resolved decisions

D-1. The spec is silent on how specs completed before the orchestrator
existed count as shipped. This module does not decide provenance: it takes
the shipped-set as an input map from spec id to `{pin, source}`, where
source is either "pipeline" (a spec shipped through the orchestrator's own
ship stage, journaled by spec 021) or "adopted" (a bootstrap-era spec whose
implementation is complete or n-a, pinned at first observation).
`adoptedShipped(registrySnapshot, pinOf)` computes the adopted half of that
map so the daemon can journal the adoption itself.

D-2 (2026-08-02, operator-directed fix wave). dag.ts gains the process
seam `createProcessSpecFileAtShaReader` (021 D-16's `git show` read,
memoized per repoDir/sha/specId; only successful reads cached) beside
`createProcessDagReader`, so every consumer of merge-sha pin resolution
(the daemon factory, the API server) shares one implementation. The pure
readiness functions are untouched; this module simply becomes the home of
both governed process reads.

D-3 (2026-08-02, operator-directed; the structural precondition for any
machine-authored spec wave). `RegistrySpecEntry` previously carried only
`id`, `implementation`, and `dependsOn`: a spec with `status: draft` and
`implementation: pending` was schedulable, and one with `status: draft`
plus `implementation: complete` was adoptable into the shipped set. Both
paths now gate on `statusSchedulable`: status must be `approved`, or
absent when a reader does not emit it (the fixture-trust convention the
daemon's other seams follow; production spec-spine always emits status).
This is enforced in the resolver, not in convention, because the failure
mode it guards against is an agent authoring a plausible spec,
implementing it, gating it green, and scheduling it with no human in the
loop: approval is the one edge a machine cannot traverse. Consumers
updated in the same change: `ready`, `nextReady` (blocker: "status <s> is
not approved"), `adoptedShipped`, the daemon's adoption refresh (021
D-21), and the API dag view's per-node blockers (027 D-7). Also in this
change: the D-2 cache key's separators became the two-character `\0`
escape they were always meant to be; the first landing embedded literal
NUL bytes, which made git classify dag.ts as binary.
