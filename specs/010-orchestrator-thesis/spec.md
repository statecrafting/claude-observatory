---
id: "010-orchestrator-thesis"
title: "Orchestrator thesis: governed autonomous builds, one spec per session"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: thesis
implementation: n-a
risk: high
summary: >
  claude-observatory grows into an autonomous build orchestrator: given a
  spec-spine DAG, it drives one spec per fresh Claude Code session through
  build, ship, shepherd, and verify, survives quota exhaustion, records every
  choice in an append-only ledger, and exposes one typed HTTP API that the
  CLI and a localhost web UI both consume. This spec fixes the core model,
  the layering, and the sequencing plan; it owns no code.
constrains:
  - kind: sequencing-plan
    target_specs:
      - "011-work-journal"
      - "012-spec-dag-readiness"
      - "013-run-state-machine"
      - "014-session-driver"
      - "015-quota-scheduler"
      - "016-stage-build"
      - "017-stage-ship"
      - "018-stage-shepherd"
      - "019-stage-verify"
      - "020-decision-ledger"
      - "021-orchestrator-daemon"
      - "022-http-api-and-events"
      - "023-orchestrator-cli"
      - "024-web-ui"
    note: >
      Kernel specs 011-015 are hand-built (the bootstrap); 020 joins them as
      kernel once 011 exists. From 016 onward the orchestrator increasingly
      builds its own backlog; the first honest milestone is three specs
      driven unattended with a trustworthy ledger.
  - kind: sequencing-plan
    target_specs:
      - "025-project-registry"
      - "026-standby-daemon"
      - "027-api-projects"
      - "028-cli-projects"
      - "029-ui-projects"
    note: >
      The generalization wave (amendment A-1): project registry, then the
      standby multi-project daemon, then the three surfaces. 028 and 029
      may land in either order once 027 is shipped. The daemon builds this
      wave the same way it built 022-024.
  - kind: sequencing-plan
    target_specs:
      - "034-adoption-preflight"
      - "035-corpus-synthesis"
      - "036-holdback-validation"
      - "037-defect-capture"
    note: >
      The adoption wave (amendment A-2): read-only cartography first. 036
      may land before 035 (its replay validates any candidate corpus, and
      it gates ratification); nothing in the wave writes a target's
      authored files except 035's synthesis sessions, whose specs are
      born draft.
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 010: Orchestrator thesis

## 1. Purpose

The one-spec-per-fresh-session protocol already exists in prose (statecraft's
AGENTS.md backlog discipline, mirrored in this repo's AGENTS.md). This
product is its executor: deterministic scaffolding around nondeterministic
sessions, honest state, and evidence for every claim.

## 2. Core model

- **Work unit:** one spec = one branch = one PR = one fresh Claude Code
  session (plus bounded remediation sessions in shepherd).
- **DAG:** specs form a DAG via `depends_on`. A spec is ready when every
  dependency is shipped and its pinned contract hash still matches (spec
  012). Amending a spec invalidates downstream pins and forces
  re-verification.
- **Shipped:** PR merged with the governed gate green, plus a recorded
  verify pass where the spec declares observable behavior (spec 019).
- **Decision ledger:** append-only record of choices made where a spec was
  silent, written during sessions and injected into future sessions (spec
  020). This is how spec 40 stays coherent with spec 8.
- **Work journal:** every state transition is written before and after
  mutation (spec 011); a resumed run reads state instead of re-deriving it.

## 3. Behavior (the non-negotiables)

- **B-1 (layering).** statecraft primitives stay the substrate; the
  orchestrator is a product on top. It never reimplements hash chains,
  canonical JSON, gates, or trust scoring; it re-derives patterns (stage
  machine as data, SSE ring buffer, auth-vs-transient classification) with
  citations. Product names may churn; substrate names must not.
- **B-2 (read-only observation).** The orchestrator inherits spec 001 B-7:
  `~/.claude` is watched, never written. Orchestrator state lives under
  `data/orchestrator/` in the target repo's operator home, never inside the
  observed universe.
- **B-3 (one interface).** A typed localhost HTTP API plus an event stream
  is the only interface (spec 022). CLI (spec 023) and web UI (spec 024) are
  clients of it. Nothing bypasses it, including tests of the surfaces.
- **B-4 (honesty).** Every status the system displays is derived from the
  journal and evidence records, never asserted. Unknown is displayed as
  unknown. The UI is an observability surface, not a wizard.
- **B-5 (serial v1).** One spec in flight at a time. The API design must not
  preclude parallel execution or hosted deployment, but neither is built.
- **B-6 (quota).** The daemon consumes no model quota itself. Quota
  exhaustion parks the run at a spec boundary and resumes automatically
  (spec 015).

## 4. Out of scope

Parallel execution, hosted or multi-user deployment, and driving
non-Claude agents. Reverse-engineering an existing system into a spec
corpus was originally excluded here as a separate product; amendment A-2
brings staged corpus adoption in scope (specs 034-037) and records the
boundary's retirement.

## 5. Resolved decisions

Carried from `docs/design/00-ecosystem-analysis.md`: D1 (layering), D2
(contract hash = sha256 of the dependency's spec.md), D3 (readiness and
cycle detection are ours), D4 (journal before ledger), D5 (shipped), D6
(session driving), D7 (quota parking), D8 (single API), D9 (ship reuses
/ship; hook exit-2 blocks are stage outcomes), D10 (verify via Claude in
Chrome), D11 (naming stays claude-observatory), D12 (retroactive adoption).

## 6. Amendments received

A-1 (2026-08-01, authored with the operator). The first live run past the
024 milestone exposed the gap: with an empty backlog the daemon exits, and
with it the API and the UI, so "backlog complete" was indistinguishable
from "not running". The mission generalizes: claude-observatory is a
general spec-spine builder, able to drive any governed target repository,
itself included, from one long-lived daemon. Self-hosting becomes the
special case where the target is this checkout. Three decisions extend the
carried set:

- **D13 (projects and state placement).** Targets are registered projects
  (spec 025). Per-project orchestrator state (work journal, decision
  ledger, evidence) lives inside each target at `data/orchestrator/`,
  exactly the self-hosted layout today, so the evidence travels with the
  repo it describes and `journal verify` stays a local, offline check.
  The daemon home (lock, log, project registry) stays in this checkout's
  `data/orchestrator/`.
- **D14 (standby and the arm toggle).** A terminal run drops the daemon to
  standby, still serving the API and UI (spec 026). Each project carries
  an armed flag: armed projects with ready work wake a run automatically;
  disarmed projects are observed, never driven. Registration defaults to
  armed; pointing the orchestrator at a project is the consent.
- **D15 (project-scoped API).** The API becomes apiVersion 2 with
  project-scoped routes under `/api/projects/<name>/` (spec 027).
  Genuinely global facts (daemon meta, account quota, the event stream)
  stay global; forcing them under a project would misstate their scope.
  B-5's serial invariant is restated as one live stage session globally.

A-2 (2026-08-05, authored with the operator). The registry's first
external targets exposed the gap from the other side: the builder can
drive any governed repository, and almost no repository is governed. §4
originally excluded reverse-engineering a system into a corpus as a
separate product; that boundary retires. The mission extends: the
builder can adopt an ungoverned repository into governance through a
staged, evidence-scored path (specs 034-037), with this repo's own
retroactive adoption of 2026-07-29 (spec 000, D12) as the worked
example. Four decisions extend the carried set:

- **D16 (staged adoption).** Adoption is a capability of the builder,
  strictly staged: read-only cartography producing a proposal (034),
  synthesis of draft specs by driven sessions (035), replay scoring
  (036), and defect capture (037). Territory is change-level, never
  whole-system: the corpus covers the subsystems the evidence says are
  alive, and the ungoverned remainder is explicit. Partial coverage
  that holds beats total coverage that does not.
- **D17 (measured partitions).** A candidate corpus's quality is
  computed, not asserted: replaying the target's own merge history
  against the corpus's declared ownership is the acceptance instrument.
  Coverage, orphans, and dispersion are reported with their
  denominators, and the score gates ratification.
- **D18 (ratification).** A synthesized corpus is a proposal about what
  the system is for. Synthesized specs are born `status: draft`, and
  drafts are never schedulable (012 D-3), so no build session can run
  against specs no human read. Ratification is the operator's own
  approval flip in the target plus a journaled ratification record
  citing the replay verdict it was made against.
- **D19 (defects recorded, never blessed).** Reverse-engineered specs
  record behavior as found: known-wrong behavior is a recorded defect,
  never contract (D12's posture, generalized beyond self-adoption).
  Adoption sessions never modify a target's source; a synthesis diff
  reaching beyond the corpus fails mechanically.
