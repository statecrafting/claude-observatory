---
id: "016-stage-build"
title: "Build stage: implement one spec in one fresh session"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: pending
risk: high
depends_on:
  - "012-spec-dag-readiness"
  - "014-session-driver"
  - "020-decision-ledger"
summary: >
  The first pipeline stage: assemble the context a fresh session needs (the
  target spec verbatim, the backlog protocol, relevant decision-ledger
  entries, dependency pins), flip the spec to in-progress on a fresh
  feature branch, drive one session to implement exactly that spec's
  territory, and judge completion from evidence (gate commands green, spec
  acceptance criteria addressed, working tree state) rather than the
  session's own claim.
establishes:
  - "src/orchestrator/stages/build.ts"
  - "src/orchestrator/stages/build.test.ts"
---

# 016: Build stage

## 1. Purpose

Turn "the next ready spec" into a branch where the spec's territory exists
and the governed gate is green, using one fresh session, with every choice
the session makes recorded.

## 2. Territory

`src/orchestrator/stages/build.ts` and tests.

## 3. Behavior

- **B-1 (preflight refusals).** Before spawning: target repo tree must be
  clean, on the default branch, gate green at base, spec ready (spec 012).
  Violations are Refusals (the stage does not start), distinct from a
  started-then-failed stage, after the statecraft-cli pattern.
- **B-2 (branch first).** Create `NNN-slug` branch before the session, so a
  failed build leaves an inspectable branch, then flip the spec frontmatter
  to `implementation: in-progress`, recompile, commit. This bracket is
  orchestrator-owned, not session-owned.
- **B-3 (prompt).** The prompt contains: the spec body verbatim, the repo's
  AGENTS.md backlog step for one spec, the decision-ledger entries whose
  scope matches the spec or its dependencies (spec 020 injection), and the
  instruction to record new decisions via the ledger drop-box (spec 020
  B-3). The prompt template is a versioned file, and its version is
  journaled with each use.
- **B-4 (drive).** One session (spec 014) with the build deadline and turn
  cap. Remediation for a red gate at the end is at most one follow-up
  session with the failure evidence in the prompt; a second failure fails
  the stage honestly.
- **B-5 (completion evidence).** The stage passes only when, run by the
  orchestrator itself after the session ends: `spec-spine compile`, `index
  check`, `lint --fail-on-warn`, `couple --base origin/main --head HEAD`,
  and the repo's typecheck/test commands all exit 0 on the branch, and the
  spec's frontmatter is `implementation: complete`. The session saying
  "done" is not evidence.
- **B-6 (decision capture).** Ledger drop-box entries written by the session
  are validated and sealed into the decision ledger at stage end (spec 020),
  journaled with the stage evidence.

## 4. Functional requirements

- **FR-001.** All git effects go through a Runner seam so tests drive the
  stage against a temp repo without a real session (fake claude).
- **FR-002.** Stage evidence journaled: branch, head sha, gate outputs
  (exit codes plus tails), session ids, cost.
- **FR-003.** A crash mid-stage resumes to a reconcile step that inspects
  the branch state and either continues to evidence evaluation or retries
  cleanly (no duplicate branches, idempotent by branch name).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/stages/build.test.ts` passes.
- **AC-2.** Against a fixture repo with a one-file spec, a scripted fake
  session that writes the file yields `passed` with all evidence present;
  the same fixture with a failing lint yields `failed` with the lint tail
  in evidence.

## 6. Out of scope

Committing to the default branch, pushing (ship's job), and multi-spec
batching.
