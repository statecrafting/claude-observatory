---
id: "026-standby-daemon"
title: "Standby daemon and the multi-project scheduler"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: critical
depends_on:
  - "021-orchestrator-daemon"
  - "025-project-registry"
summary: >
  The daemon stops dying of success: a terminal run drops it to standby,
  still serving the API, instead of exiting the process. Above the
  per-run loop sits a scheduler over the project registry (025): armed,
  qualified projects with ready work get a fresh run, serviced serially in
  registration order, with at most one live stage session globally. A
  bounded standby scan refreshes the registry and each armed project's
  spec DAG, so new pending specs wake a run automatically per 010 D14.
  Quota parking is global: the account's quota is one pool, so no project
  starts a session while parked. Runs, journals, and recovery semantics
  from 013, 011, and 021 are unchanged; the daemon simply outlives them.
establishes:
  - "src/orchestrator/standby.ts"
  - "src/orchestrator/standby.test.ts"
extends:
  # The run loop's exit-on-terminal becomes a transition to standby, and
  # spec selection consults the registry instead of assuming one repo.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: superseding }
  # The daemon run composition keeps process and API alive in standby.
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 026: Standby daemon

## 1. Purpose

The first post-milestone live run exposed it (010 A-1): with an empty
backlog the daemon exits within milliseconds, taking the API and UI with
it, so "mission complete" and "not running" were the same observable. A
general builder must idle honestly: alive, observable, and ready to drive
whichever registered project next has work.

## 2. Territory

`src/orchestrator/standby.ts` (the scheduler and standby loop) and its
tests. Supersessions as declared in `extends`: the run loop's terminal
break in `src/orchestrator/daemon.ts` and the `daemon run` composition in
`src/commands/orchestrator.ts`. The build session records an amendment
note in spec 021 §6 (whose "multi-repo runs" out-of-scope line this spec
supersedes) and in spec 023 D-2; that authority is granted here, per the
coherence guard's "agent with explicit authority" clause.

## 3. Behavior

- **B-1 (standby, not exit).** A run reaching completed or failed drops
  the daemon to standby: the process, lock, and API stay up until an
  operator stops the daemon. Standby is a daemon state, not a run state;
  spec 013's transition table is untouched and terminal runs stay history
  (021 D-12, generalized per project).
- **B-2 (scheduler).** The scheduler folds the registry (025) and services
  armed, qualified projects in registration order: a project with ready
  work gets a fresh run driven by the existing per-run loop against its
  own state root and repoDir. Switching projects happens only at a run
  boundary, never mid-spec.
- **B-3 (one flight slot).** The serial invariant (010 B-5, restated by
  D15) is one live stage session globally. A run paused on needsHuman or
  stopped on blockers releases the slot so another project may proceed;
  an approval or retry resumes the paused run with priority over starting
  new runs.
- **B-4 (standby scan).** On a bounded interval (default 60 s) standby
  re-folds the registry, refreshes each armed project's registry read, and
  requalifies cheaply. Newly ready work in an armed project wakes a run
  automatically; disarmed projects are observed and reported, never
  driven. The scan consumes no model quota (021 B-5 inherited).
- **B-5 (quota is global).** Quota exhaustion parks the daemon, not just
  the run that detected it: the account's quota is one pool, so no
  project's session starts before the spec 015 horizon resumes the parked
  run first.
- **B-6 (one daemon per home).** Lock and log stay in the daemon home
  with 021 B-1's identity semantics unchanged; the lock guarantees one
  daemon per daemon home (a second checkout is a second home, its
  operator's responsibility). There are no per-project locks; each
  project's journals still take spec 011's own per-chain writer lock in
  that project's state root.
- **B-7 (shutdown).** SIGTERM in standby exits promptly (nothing to
  sever); SIGTERM mid-run inherits 021 B-6 and D-2 exactly.

## 4. Functional requirements

- **FR-001.** An end-to-end standby test drives a fixture with two
  registered projects: project A's backlog completes and the daemon stays
  serving in standby; a spec flipping to pending in armed project B wakes
  a run within one scan; a disarmed project with ready work is reported
  and never driven; a daemon kill and restart during standby recovers to
  standby with both project histories intact.
- **FR-002.** A scheduler test proves the flight slot: with A's run
  paused on needsHuman and B ready, B proceeds; A's approval resumes A
  before any further new run starts.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/standby.test.ts` passes, including
  FR-001 and FR-002.
- **AC-2.** `bun test src/orchestrator/daemon.test.ts` still passes
  unchanged in behavior it owns (the 021 FR-001 kernel scenario).

## 6. Out of scope

Parallel stage sessions, cross-project dependency edges, fairness beyond
registration order, remote daemons, and any UI or API surface (027-029).

## 7. Resolved decisions

D-1. Registration order is the whole scheduling policy in v1. A project
earlier in the registry with an inexhaustible backlog can starve later
ones; this is recorded honestly rather than balanced away, and a fairness
policy, if ever needed, is a future spec's territory.

D-2. Waking a run automatically is gated on `armed` alone, deliberately:
registration defaults to armed (010 D14), so pointing the daemon at a
project is the consent to build it, and disarming is the one lever that
makes a project observation-only. There is no second global autopilot
switch to disagree with the per-project flag.
