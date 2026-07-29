---
id: "017-stage-ship"
title: "Ship stage: commit, push, open the PR through the governed discipline"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: pending
risk: medium
depends_on:
  - "016-stage-build"
summary: >
  Turn a green build branch into an open PR. The stage drives the target
  repo's own /ship discipline in a session rather than reimplementing the
  gate, treats PreToolUse hook exit-2 refusals as the first-class
  hook-blocked outcome, and verifies the result from the outside: PR exists,
  head sha matches the built branch, body carries no waiver unless a human
  approved one, and no session link or AI attribution appears anywhere.
establishes:
  - "src/orchestrator/stages/ship.ts"
  - "src/orchestrator/stages/ship.test.ts"
---

# 017: Ship stage

## 1. Purpose

Shipping is where governance bites (the coupling gate, the waiver protocol,
commit hygiene). The repo already encodes that discipline in `/ship` and its
hooks; the stage's job is to invoke it, classify its refusals, and verify
outcomes independently.

## 2. Territory

`src/orchestrator/stages/ship.ts` and tests.

## 3. Behavior

- **B-1 (drive /ship).** The stage prompt instructs the session to run the
  `/ship` skill for the current branch. The orchestrator never constructs
  its own `gh pr create` bypassing the hooks.
- **B-2 (hook refusals).** A session ending with a blocking-hook refusal
  (spec 014 classification `hook-blocked`) marks the stage `blocked`, not
  `failed`; the refusal text is stage evidence. Blocked ships require either
  a coupling fix (loop back to build with the evidence) or a human-approved
  waiver; the orchestrator never self-approves a Spec-Drift-Waiver. This is
  the adversarial-prompt-refusal rule applied to the pipeline: the coherence
  guard's contradiction goes to a human, not around them.
- **B-3 (outside verification).** After the session: the PR must exist for
  the branch (gh api), its head sha must equal the local branch head, CI
  must be triggered, and the PR body/title/commits must contain no
  session-link URLs and no AI attribution. Any mismatch fails the stage with
  the diff as evidence.
- **B-4 (idempotency).** Retrying a ship where the PR already exists and
  matches is a pass, not a duplicate PR.

## 4. Functional requirements

- **FR-001.** GitHub reads go through a typed client seam with tests
  against fixtures; no live gh in unit tests.
- **FR-002.** Evidence journaled: PR number and URL, head sha, CI run id
  when already visible, session cost.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/stages/ship.test.ts` passes.
- **AC-2.** In the fixture flow, a simulated hook exit-2 session yields
  `blocked` with the refusal tail in evidence and no PR-existence check
  attempted.

## 6. Out of scope

Merging (shepherd's job), release tagging, and multi-remote setups.
