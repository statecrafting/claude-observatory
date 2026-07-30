---
id: "019-stage-verify"
title: "Verify stage: assert observable behavior, record evidence"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: complete
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

## 7. Resolved decisions

D-1. `VerifyRunner` is a new seam declared in `verify.ts`, not an extension
of build.ts's own `Runner` (spec 016): worktree lifecycle (`addWorktree`,
`removeWorktree`) and a per-command timeout (`runCommand`) are operations
that interface has no analogue for, since its `runGate` always runs in one
fixed repoDir with no per-call timeout. The production factory
(`createProcessVerifyRunner`) follows the same interface-plus-Bun.spawnSync
shape the family already uses (build.ts's `createProcessRunner`,
ship.ts's `createProcessGitHubClient`); `runSession` never appears on this
interface at all, since B-3's browser driving lives entirely behind its own
BrowserVerifier seam instead.

D-2. Each line inside a `verify:cli` fenced block is its own CLI assertion,
run and journaled individually (`stage.verify.cli`, one record per command);
the fenced block itself is only a grouping unit for parsing and for
"empty block" detection. This reconciles B-1's "fenced assertion blocks"
language with B-2's "journal command, exit code, bounded output per block"
(singular command per record) and with FR-001's "malformed blocks... never
skipped" (an empty fenced block, zero commands left after stripping comments
and blank lines, is what FR-001 calls malformed, not an empty individual
command).

D-3. CLI assertions, and separately browser assertions, each run to
completion within their own kind rather than stopping at the first failure:
this is what lets AC-2's "both outputs recorded" hold regardless of which
assertion in a block fails first, and keeps the evidence "everything that
ran," not just "the first bad thing." Once the CLI phase has any failing
assertion, the stage returns immediately without ever starting the browser
phase: there is no reason to spend a browser session, and therefore quota,
verifying a spec whose CLI half already failed.

D-4. `BrowserVerifier.assert()`'s signature is taken literally
(`{pass, detail, screenshotPngBase64?}`), with no fourth field for quota. A
driven session classified `quota` (spec 014) is instead surfaced as a typed
throw, `BrowserVerifierQuotaError`, caught by `runVerifyStage` and mapped to
the stage-level outcome `"quota"`; this mirrors shepherd's own
`StatuslessAbortError` pattern (spec 018) of a typed error a seam throws
rather than widening its return type for one abnormal path.

D-5. Any browser-driving session classification other than `completed` or
`quota` (`hook-blocked`, `auth`, `transient`, `crashed`, `timeout`) is read
as an assertion failure (`pass: false`, `detail` naming the classification),
not a fourth `VerifyOutcome` variant. A browser-verification session never
touches git or the governed gate, so a hook-blocked-shaped refusal has no
realistic path here; folding every other classification into an honest
failed assertion is the conservative reading, since only quota is named as
a distinct outcome to carve out.

D-6. `runVerifyStage` takes `sha` as an explicit required option rather than
deriving it from a `Runner.currentBranch()`/`headSha()` read, the same
"explicit, never inferred" convention ship.ts's own D-6 established: verify
runs after merge, against a merged sha the shepherd stage's evidence names,
so there is no "current branch" of its own to infer one from.

D-7. `needsHuman` on evidence is `true` only when the outcome is `"failed"`
**and** the caller marked the call `isReVerification: true`; a first-time
verify inside the normal build/ship/shepherd/verify pipeline that fails
carries `needsHuman: false`. This reads B-5's literal text ("a fail on
re-verification carries needsHuman: true") as scoped specifically to the
re-verification path, mirroring shepherd's own needsHuman convention
(spec 018 D-4) of reserving the flag for states the stage genuinely cannot
resolve on its own, rather than applying it to every failure unconditionally.

D-8. Evidence for one cli assertion is a single file: the command text, its
bounded stdout, and its bounded stderr, concatenated into one text blob and
hashed as a whole, rather than three separate files. FR-003's own shape
(`{assertion, evidenceHash}`) names one hash per assertion, not one per
stream.
