---
id: "030-run-economics"
title: "Run economics: cost and autonomy-yield rollups from the journal"
status: approved
created: "2026-08-02"
authors: ["Bartek Kus"]
kind: feature
implementation: in-progress
risk: medium
depends_on:
  - "011-work-journal"
  - "013-run-state-machine"
  - "014-session-driver"
  - "027-api-projects"
  - "028-cli-projects"
summary: >
  Every session's cost, termination class, and attempt number is already
  journaled; nothing aggregates them, so "what did last night cost" and
  "how much rework did that spec need" are answerable only by folding the
  journal by hand. This spec adds the rollup as a pure function over
  journal records, per spec and per run: sessions consumed (by
  termination kind), remediation rounds, hook blocks, quota parks, cost
  in micro-USD, and wall-clock duration; served project-scoped by the
  API and rendered by the CLI. Absent facts stay null, never zero: a
  session whose CLI reported no cost is "cost unknown", not free.
establishes:
  - "src/orchestrator/economics.ts"
  - "src/orchestrator/economics.test.ts"
extends:
  # One additional GET route serving the fold, project-scoped (v2 shape).
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/state.ts", nature: additive }
  # One additional read verb rendering it.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 030: Run economics

## 1. Purpose

The orchestrator's headline claim ("specs of working infrastructure,
built and self-corrected with essentially no human review") is currently
unmeasured: cost is journaled per session and aggregated nowhere, rework
is visible only as raw stage attempts, and the one number an operator
needs before leaving the daemon running overnight ("what will this cost
me") requires hand-folding JSONL. What is not measured cannot be
improved or credibly claimed.

## 2. Territory

`src/orchestrator/economics.ts` and its tests: the pure fold. Additive
extensions as declared in `extends`: one project-scoped GET route in the
API server plus its view assembly in `state.ts`, and one read verb in
the CLI. The build session is granted authority to record additive D-n
notes in specs 027 and 028 for those mechanical surface additions, per
the coherence guard's explicit-authority clause; it does not amend their
B-level contracts.

## 3. Behavior

- **B-1 (the fold).** `economicsView(records, project)` is a pure
  function over one project's journal records. Per spec execution:
  sessions consumed with a count per termination kind (spec 014's full
  kind set), stage attempts beyond the first counted as remediation
  rounds, hook-blocked outcomes, summed `costMicroUsd` across that
  spec's sessions with a separate count of sessions whose cost was
  unreported, and wall-clock from first stage intent to terminal
  transition. Per run: the same aggregates plus quota parks entered and
  total parked duration. Totals across the journal's whole history ride
  along.
- **B-2 (honest absence).** A session with `costMicroUsd: null`
  contributes to `costUnknownSessions`, never to the sum; a fold over an
  empty journal returns zero specs and null totals, not fabricated
  zeros. The view never estimates: money is summed only from journaled
  values (011's evidence stance, applied to accounting).
- **B-3 (API).** `GET /api/projects/<name>/economics` serves the fold,
  recomputed from records on every request exactly like the dag and run
  views (022 B-6: no cached map the journal does not support).
- **B-4 (CLI).** `observatory orchestrator economics [--project <name>]`
  renders per-spec rows (sessions, remediations, hook blocks, cost or
  "cost unknown xN", duration) and run totals; `--json` prints the
  served envelope verbatim; exit codes and client-not-engine discipline
  carry over from 023/028 unchanged.
- **B-5 (journal-derived only).** The fold reads journal records and
  nothing else: no git archaeology, no registry reads, no transcript
  parsing. Yield metrics that need sources beyond the journal
  (post-merge corrective commits touching a spec's territory) are a
  future spec's territory, named in Out of scope rather than
  approximated here.

## 4. Functional requirements

- **FR-001.** The fold is pure over (records, project) and tested
  against fixture journals (the API fixture world), including: a spec
  with one clean session, a spec with a remediation round, a
  hook-blocked stage, a quota park, and sessions with and without
  reported cost.
- **FR-002.** The API route answers with the served envelope shape used
  by every other project-scoped view (data, project, generatedAt from
  the daemon's clock), 404s an unknown project, and appears in the
  route table with GET-only enforcement.
- **FR-003.** CLI tests run against the fixture v2 API server; the
  human rendering names unknown costs as unknown and never prints a
  bare zero for an unreported value.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/economics.test.ts` passes.
- **AC-2.** Against the self-hosted project's real journal,
  `observatory orchestrator economics` renders a row for every spec the
  journal shows shipped, and the summed cost equals the sum of the
  journal's own `session.result` costMicroUsd values (spot-checkable
  with `--json`).

## 6. Out of scope

Dashboard rendering (a later UI spec consumes B-3), cross-project or
global aggregation, cost estimation or projection, git-derived yield
metrics (post-merge corrective commits per spec territory), and any
write path: this spec adds no journal record kinds.

## 7. Resolved decisions

(none yet)
