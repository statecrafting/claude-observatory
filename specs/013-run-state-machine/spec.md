---
id: "013-run-state-machine"
title: "Run and stage state machine (transitions as data)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: high
depends_on:
  - "011-work-journal"
summary: >
  The typed state machine for runs, spec executions, and stages, kept as
  data (an allowed-transitions table) after the statecraft factory pattern:
  unit-testable, resumable by fold, with invalid transitions as typed
  errors. A run holds spec executions; a spec execution walks build, ship,
  shepherd, verify; every stage is independently retryable; terminal and
  live states are explicit predicates. All transitions go through the
  journal's intent/outcome bracket.
establishes:
  - "src/orchestrator/state.ts"
  - "src/orchestrator/state.test.ts"
---

# 013: Run and stage state machine

## 1. Purpose

Stage progress must be a status-driven machine a resumed process can trust,
not control flow scattered across the pipeline. Transitions-as-data makes the
machine reviewable against this spec line by line.

## 2. Territory

`src/orchestrator/state.ts` and tests.

## 3. Behavior

- **B-1 (entities).** `Run` (target repo, created, status), `SpecExec` (run,
  specId, pin snapshot, attempt counter, status), `StageExec` (specExec,
  stage, attempt, status, evidence refs). Ids are ULID-like sortable strings.
- **B-2 (run states).** `idle -> running -> (parked | paused | completed |
  failed)`; `parked -> running` (quota resume), `paused -> running` (human
  resume). Parked is quota-caused (spec 015); paused is human-caused (spec
  022 controls).
- **B-3 (spec states).** `pending -> building -> shipping -> shepherding ->
  verifying -> shipped`, with `-> failed` from any live state, `failed ->
  building` (retry as a fresh attempt and a fresh session), and `shipped ->
  invalidated -> verifying` (re-verification after upstream amendment, spec
  012 B-4).
- **B-4 (stage states).** `queued -> running -> (passed | failed |
  blocked)`; `blocked` is the hook-refusal outcome (a PreToolUse gate exit
  2, spec 017), distinct from `failed` because remediation differs; every
  stage can be retried, incrementing attempt.
- **B-5 (table).** The allowed-transition tables are exported constants;
  `transition(entity, to)` validates against them, journals
  `state.transition.intent`, applies, then journals the outcome. An illegal
  transition throws `InvalidTransitionError` naming from, to, and entity.
- **B-6 (fold).** The journal fold (spec 011 B-5) reconstructs all three
  entity sets; an intent without an outcome folds to the pre-transition
  state plus a `needsReconcile` flag the daemon must resolve before
  proceeding.

## 4. Functional requirements

- **FR-001.** Every state named above is reachable in tests via legal
  transitions, and every illegal edge in the tables' complement throws.
- **FR-002.** Fold-after-crash tests replay a journal cut at each byte
  boundary of one transition and always recover a legal state.
- **FR-003.** Predicates `isTerminal`, `isLive`, `needsHuman` are exported
  and total.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/state.test.ts` passes.
- **AC-2.** A property test drives 1000 random legal walks and folds to the
  same state the walk computed in memory.

## 6. Out of scope

Scheduling policy (spec 012 decides what runs; this spec only records what
is happening) and stage semantics (specs 016-019).

## 7. Resolved decisions

D-1. `needsHuman` is purely state-derived, with no retry-budget or
scheduling-policy accounting (that is this spec's own Out of scope):
`needsHuman(run)` is true only for `paused`, `needsHuman(stageExec)` only
for `blocked`, `needsHuman(specExec)` only for `failed`. A failed
`SpecExec` always qualifies, full stop; whether it is later auto-retried or
escalated to a human is spec 012's business, not this module's.

D-2. `isTerminal`/`isLive` are defined per entity kind rather than as a
single mechanical sink check, because a literal "no outgoing edge" reading
gives SpecExec zero terminal states (`shipped` can invalidate, `failed` can
retry, `invalidated` re-verifies) while still needing a meaningful
predicate. `isLive` is the set B-3's own prose names "any live state" for
SpecExec (`pending`, `building`, `shipping`, `shepherding`, `verifying`),
extended by the same "actively self-progressing, not waiting on an
external trigger" reading to `Run` (`idle`, `running`) and `StageExec`
(`queued`, `running`). `isTerminal` is a true graph sink (no outgoing edge
in that entity kind's own table): `Run` {`completed`, `failed`},
`StageExec` {`passed`, `failed`, `blocked`}, `SpecExec` {} (none: every
SpecExec status has a legal way forward while the pipeline is live). The
two predicates are not required to partition every status: `Run`'s
`parked` and `paused` are neither live nor terminal (waiting on an
external quota/human resume, not self-progressing, not done).

D-3. Ids are minted by a small monotonic helper: epoch-ms in base36 (fixed
9 chars), a per-process counter (fixed 4 base36 chars, so many ids minted
within one millisecond by one process still sort in creation order), and a
4-hex-char random suffix (guards against two processes minting the same
ms+counter pair at once). Lexicographic string sort therefore agrees with
creation order to millisecond resolution, satisfying B-1's "ULID-like
sortable strings" without a dependency.

D-4. `SpecExec`'s attempt counter increments as a deterministic function of
the specific transition (`failed -> building`) rather than being carried
in the transition payload, so the journaled `state.transition.intent`/
`.outcome` payload stays at the fixed `{entity, id, from, to}` shape B-5
calls for while `foldOrchestratorState` still recovers the exact attempt
`transition()` computed live, by replaying the same pure rule from the
same `(entity kind, from, to)` triple.

D-5. `StageExec` retries mint a fresh `StageExec` entity
(`createStageExec(handle, specExecId, stage, attempt)`) rather than
transitioning the same entity back to `queued`: B-4 names no such edge
(unlike SpecExec's explicit `failed -> building`), and every StageExec
status other than `queued`/`running` is a sink in this module's own
table, consistent with "every stage can be retried" meaning a new attempt
is a new entity.
