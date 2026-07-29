---
id: "020-decision-ledger"
title: "Decision ledger: append-only choices, injected forward"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
risk: high
depends_on:
  - "011-work-journal"
summary: >
  The coherence mechanism across sessions: an append-only, hash-linked
  ledger of decisions made where a spec was silent, written during sessions
  through a validated drop-box, sealed by the orchestrator at stage end,
  and injected into future sessions whose spec or dependencies match the
  decision's scope. Decisions are never edited; they are superseded by
  later decisions that name them.
establishes:
  - "src/orchestrator/decisions.ts"
  - "src/orchestrator/decisions.test.ts"
---

# 020: Decision ledger

## 1. Purpose

Spec 40 stays coherent with spec 8 only if the choices spec 8's builder made
are visible to spec 40's builder. The ledger is that memory, with the same
integrity guarantees as the work journal.

## 2. Territory

`src/orchestrator/decisions.ts` and tests. Storage:
`data/orchestrator/decisions.jsonl` (chain, spec 011 envelope) and
`data/orchestrator/decision-dropbox/` (session-writable staging).

## 3. Behavior

- **B-1 (record shape).** `{id, specId, scope, title, decision, rationale,
  alternatives?, supersedes?}` where scope is a list of spec ids and/or
  path prefixes the decision touches. Payloads follow the journal's
  no-float rule.
- **B-2 (chain).** Same envelope, durability, and verification as spec 011
  (shared implementation, second chain). Append-only; supersession is a new
  record naming the old id.
- **B-3 (drop-box).** Sessions cannot append to the chain directly (the
  daemon holds the writer lock). The build/ship/shepherd prompts instruct
  sessions to write one JSON file per decision into the drop-box; at stage
  end the orchestrator validates each against the schema, seals valid ones
  into the chain (journaling the sealing), and surfaces invalid ones as
  stage warnings with the file preserved.
- **B-4 (injection).** `decisionsFor(specId)` selects records whose scope
  intersects the spec, its `depends_on` closure, or its territory paths,
  newest-first, superseded records resolved away, bounded to a prompt
  budget with the overflow count stated in the prompt (never silent
  truncation).
- **B-5 (browsing).** The ledger is queryable (by spec, by path, full-text)
  through the HTTP API (spec 022) for the UI's searchable browser.

## 4. Functional requirements

- **FR-001.** Schema validation rejects: missing fields, unknown fields,
  floats, scope entries that are neither known spec ids nor plausible repo
  paths.
- **FR-002.** Injection tests cover scope intersection via dependency
  closure and supersession shadowing.
- **FR-003.** The drop-box is emptied only after successful sealing;
  a crash between validate and seal re-validates idempotently (dedup by
  content hash).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/decisions.test.ts` passes.
- **AC-2.** A fixture flow (session writes two decisions, one malformed)
  seals one, warns on one, and a later `decisionsFor` on a downstream spec
  returns the sealed decision.

## 6. Out of scope

Editing or deleting decisions, human decision authoring UI (the API accepts
operator-authored decisions through the same validated path), and
cross-repo ledgers.
