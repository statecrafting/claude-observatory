---
id: "033-cost-ceiling"
title: "Cost ceiling: journaled spend limits that park the run"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "013-run-state-machine"
  - "015-quota-scheduler"
  - "025-project-registry"
  - "030-run-economics"
summary: >
  The quota scheduler protects a subscription window; nothing protects a
  balance. Economics (030) computes what a run cost and nothing reads
  it: an oscillating remediation loop on a genuinely broken spec has no
  financial floor. This spec adds per-project cost ceilings as registry
  state (a per-run limit, a per-UTC-day limit, or both), evaluated at
  session spawn boundaries from the journal's own cost records. A
  crossed per-day ceiling parks the run to the next UTC midnight with
  the same journaled-target, jittered-resume mechanics as a quota park;
  a crossed per-run ceiling pauses the run for an operator, since no
  clock makes a run cheaper. Enforcement sums only journaled costs: the
  known-cost floor, with the unknown-session count carried alongside it
  in every record and rendering, never an estimate.
establishes:
  - "src/orchestrator/budget.ts"
  - "src/orchestrator/budget.test.ts"
extends:
  # New record kind and fold field on the projects chain.
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.ts", nature: additive }
  # The park/pause reason vocabulary gains budget entries.
  - { spec: "013-run-state-machine", unit: "src/orchestrator/state.ts", nature: additive }
  # The daemon checks the ceiling at every session spawn boundary.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  # One write verb, and spend-against-ceiling rendering.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/state.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 033: Cost ceiling

## 1. Purpose

"Leave it running overnight" is a financial statement. The orchestrator
already journals per-session cost (014) and can fold it (030); what is
missing is the enforcement that turns the fold into a floor an operator
can stand on. The design deliberately reuses the parking shape the
operator already knows from quota: a journaled reason, a visible target
or a visible need for a human, and a resume that is either the clock or
an operator record, never a silent retry.

## 2. Territory

`src/orchestrator/budget.ts` and its colocated tests: the ceiling model,
the spend evaluation over journal records, and the park/pause planning.
Extensions as declared in `extends`: the record kind and fold field in
`projects.ts`, the reason vocabulary in `state.ts`, the boundary check in
`daemon.ts`, and the verb plus rendering in the CLI and API surfaces.
The build session is granted authority to record additive D-n notes in
specs 025, 013, 021, 027, and 028 for those mechanical additions, per
the coherence guard's explicit-authority clause; it does not amend their
B-level contracts.

## 3. Behavior

- **B-1 (model).** A ceiling is `{perRunMicroUsd?, perDayMicroUsd?}`,
  either or both; a project without a ceiling record has no ceiling and
  is driven exactly as today. Setting or clearing the ceiling appends a
  registry record (new kind, `project.ceiling.set`) with its source,
  folded like `armed` (025 B-2).
- **B-2 (evaluation, boundaries only).** Before every session spawn the
  daemon evaluates the project's spend from journal records: the current
  run's summed `costMicroUsd` against `perRunMicroUsd`, and the summed
  `costMicroUsd` of sessions whose result was journaled in the current
  UTC calendar day (across runs and specs of that project) against
  `perDayMicroUsd`. Sessions are never killed mid-flight for budget:
  overshoot is bounded by one session, and that bound is stated in the
  journal record when a ceiling trips.
- **B-3 (per-day trip parks).** Crossing `perDayMicroUsd` parks the run
  with reason `budget-day` and target next UTC midnight: a known
  horizon, never an estimate. Resume mechanics are 015 B-3's (jittered,
  journaled target, countdown derived not stored); on resume the
  interrupted stage retries as a fresh attempt. FR-002 recovery applies
  unchanged: a daemon restart while budget-parked resumes the countdown
  from the journaled target.
- **B-4 (per-run trip pauses).** Crossing `perRunMicroUsd` pauses the
  run with reason `budget-run` and `needsHuman`: no clock makes the run
  cheaper, so auto-resume would be a spend loop with extra steps. The
  release is an operator act: raising or clearing the ceiling, or an
  explicit retry/skip verb, each already a journaled record.
- **B-5 (the floor, not an estimate).** Spend sums only journaled
  `costMicroUsd` values (030 B-2's stance): the known-cost floor. Every
  trip record, status line, and API payload carries the floor together
  with that scope's `costUnknownSessions` count, rendered as "at least
  X, N sessions unknown" whenever N is nonzero. A project that has a
  ceiling and a nonzero unknown count in the evaluated scope surfaces a
  health warning: unknowns make the floor porous, and the operator
  should know the ceiling is enforcing less than it appears to.
- **B-6 (budget parks are per-project).** Unlike quota (026 B-5: one
  account pool, global park), a ceiling is a per-project setting: a
  budget-parked or budget-paused project releases the flight slot and
  other projects proceed. Global daemon-wide ceilings are out of scope,
  named below.
- **B-7 (visible everywhere).** The ceiling and current evaluated spend
  appear in the project detail view, the economics CLI rendering, and
  the API project payload; a tripped ceiling names itself on the
  projects list line the same way a quota park does today.

## 4. Functional requirements

- **FR-001.** Spend evaluation is pure over (records, ceiling, now) and
  tested: no ceiling, under, exactly at (at is not over: driving stops
  strictly above), over per-run, over per-day, unknown-cost sessions
  counted and excluded from sums, and the UTC day boundary (a session
  journaled 23:59 counts to its day; 00:01 to the next).
- **FR-002.** Park/pause planning tests: per-day trip plans a park to
  next UTC midnight; per-run trip plans a needsHuman pause; both carry
  floor, unknown count, ceiling, and the one-session overshoot bound in
  the journaled payload.
- **FR-003.** A daemon fixture test drives a project across a ceiling
  (fake sessions with journaled costs) and asserts: the boundary check
  trips before the next spawn, the journal carries the trip record, the
  run state matches B-3/B-4, and a restart while parked recovers the
  countdown from the journaled target.
- **FR-004.** Surface tests: detail and economics renderings show
  ceiling and floor spend with unknowns named; the API payload carries
  them; a project without a ceiling renders "no ceiling", never a blank
  or a zero.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/budget.test.ts` passes.
- **AC-2.** The FR-003 scenario passes inside the existing daemon
  fixture world, including the restart-while-parked recovery.
- **AC-3.** `observatory orchestrator projects` and the economics verb
  render ceiling state for a fixture project with a ceiling set, a
  tripped ceiling, and no ceiling.

## 6. Out of scope

Global (cross-project or daemon-wide) ceilings, cost estimation or
projection, mid-session termination on budget, per-spec or per-stage
budgets, currency handling beyond micro-USD, subscription quota
semantics (015 owns them; a quota park and a budget park may coexist,
and the later horizon simply governs the next spawn), and any change to
030's fold: budget evaluation reads the same journal records economics
does but plans enforcement, which stays outside economics per 030's own
scope line.

## 7. Resolved decisions

D-1. Enforcement sums the known-cost floor only, never an estimate.
Estimating unknown sessions would either fabricate spend to stop runs
early or fabricate headroom to keep them going; both punish or permit on
fiction. The porous-floor health warning (B-5) is the honest complement:
visibility of what enforcement cannot see, instead of a number it made
up.

D-2. Checks run at spawn boundaries only. Killing a session mid-flight
to save money wastes the money the session already spent and yields a
severed stage that retries, spending again; the boundary check plus the
stated one-session overshoot bound is both cheaper and honest about its
own precision.

D-3. The per-day window is the UTC calendar day, matching the corpus
rule that all times are UTC internally and display is the client's
concern (015 FR-001). Midnight UTC as the park target is exact
knowledge, so a budget-day park never renders as an estimate.
