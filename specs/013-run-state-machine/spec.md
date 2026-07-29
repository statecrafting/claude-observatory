---
id: "013-run-state-machine"
title: "Run and stage state machine (transitions as data)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
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
