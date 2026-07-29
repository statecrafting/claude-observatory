---
id: "019-stage-verify"
title: "Verify stage: assert observable behavior, record evidence"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: pending
risk: high
depends_on:
  - "018-stage-shepherd"
summary: >
  The stage that makes shipped mean something: after merge, drive a
  verification pass against the running artifact and assert the spec's
  declared observable behavior, recording pass/fail with evidence. Specs
  declare verifiability in a Verification section (CLI assertions the
  orchestrator runs directly; browser assertions driven through Claude in
  Chrome for UI territory); a spec with no such section records
  verify: not-declared, visibly, instead of a hollow pass. Verify is also
  the re-qualification path for invalidated specs (012 B-4).
establishes:
  - "src/orchestrator/stages/verify.ts"
  - "src/orchestrator/stages/verify.test.ts"
---

# 019: Verify stage

## 1. Purpose

Build proves the gate; shepherd proves CI; verify proves behavior. Making it
a first-class stage (previously manual) closes the loop the thesis promises:
evidence, not claims.

## 2. Territory

`src/orchestrator/stages/verify.ts` and tests. The Verification section
convention below becomes part of this corpus's authoring conventions.

## 3. Behavior

- **B-1 (declaration).** A spec MAY carry a `## Verification` section with
  fenced assertion blocks: `verify:cli` blocks (commands run in the target
  repo whose exit 0 asserts the behavior) and `verify:browser` blocks
  (natural-language assertions against a URL, driven through Claude in
  Chrome). Specs without the section verify as `not-declared`.
- **B-2 (cli assertions).** Run serially with a per-block timeout in a clean
  checkout of the merged sha; each block journals command, exit code, and
  bounded output. Any nonzero exit fails the stage.
- **B-3 (browser assertions).** Driven through a Claude in Chrome session
  scoped to the declared URL, one assertion per instruction, answering
  pass/fail with a screenshot per assertion stored under
  `data/orchestrator/runs/<specExec>/evidence/`. Browser verification
  consumes quota and therefore obeys the quota scheduler.
- **B-4 (verdict).** `passed` only when every declared assertion passed;
  `failed` carries the first failing assertion and its evidence;
  `not-declared` is terminal-pass for shipping purposes but is displayed
  distinctly and counted in run reporting (honesty over green).
- **B-5 (re-verification).** Invalidated specs (spec 012 B-4) re-run only
  this stage; a pass restores `shipped`, a fail routes to `needsHuman`
  (the upstream amendment broke a downstream contract; that is a human
  decision, not a rebuild loop).

## 4. Functional requirements

- **FR-001.** The Verification section parser is pure and tested (absent,
  malformed, both block kinds; malformed blocks fail the stage with the
  parse error, never skip silently).
- **FR-002.** Browser driving sits behind a seam so unit tests use a fake;
  one live browser smoke test exists but is excluded from CI.
- **FR-003.** Evidence files are content-addressed (sha256 names) and
  referenced from the journal, never inlined.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/stages/verify.test.ts` passes.
- **AC-2.** A fixture spec with one passing and one failing cli assertion
  yields `failed` naming the failing block, with both outputs recorded.

## 6. Out of scope

Deployment itself (the artifact is assumed reachable; deploy orchestration
is a future spec), performance assertions, and cross-browser matrices.
