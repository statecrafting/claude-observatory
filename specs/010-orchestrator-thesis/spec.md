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

Reverse-engineering an existing system into a spec corpus (separate
product), parallel execution, hosted or multi-user deployment, and driving
non-Claude agents.

## 5. Resolved decisions

Carried from `docs/design/00-ecosystem-analysis.md`: D1 (layering), D2
(contract hash = sha256 of the dependency's spec.md), D3 (readiness and
cycle detection are ours), D4 (journal before ledger), D5 (shipped), D6
(session driving), D7 (quota parking), D8 (single API), D9 (ship reuses
/ship; hook exit-2 blocks are stage outcomes), D10 (verify via Claude in
Chrome), D11 (naming stays claude-observatory), D12 (retroactive adoption).
