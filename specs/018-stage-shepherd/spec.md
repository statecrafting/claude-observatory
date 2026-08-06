---
id: "018-stage-shepherd"
title: "Shepherd stage: watch CI, remediate, merge when green"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: complete
risk: medium
depends_on:
  - "017-stage-ship"
summary: >
  From open PR to merged. Polls the PR's checks by head sha with the
  watch-loop discipline (backoff, change-only journaling, statusless
  abort, deadline), remediates a red run with at most N fresh sessions fed
  the failing log tail, re-enters the loop after each push, and merges when
  green with the repo's default merge method. Every remediation is a new
  attempt with evidence; flapping CI and exhausted attempts fail honestly
  to needsHuman.
establishes:
  - "src/orchestrator/stages/shepherd.ts"
  - "src/orchestrator/stages/shepherd.test.ts"
---

# 018: Shepherd stage

## 1. Purpose

CI is where reality pushes back. The shepherd keeps a PR moving without a
human staring at it, while never hiding what it did to get to green.

## 2. Territory

`src/orchestrator/stages/shepherd.ts` and tests.

## 3. Behavior

- **B-1 (watch loop).** Poll check runs for the PR head sha: interval with
  multiplicative backoff (base 15 s, factor 1.5, cap 120 s), journal only on
  state change, abort as a typed error if the API response loses required
  fields (never poll a shape that cannot terminate), overall deadline 45
  minutes per attempt, configurable.
- **B-2 (remediation).** On a failed required check: fetch the failing job
  log tail (bounded), spawn one fresh remediation session on the branch with
  the spec, the failure evidence, and the instruction to fix and push
  through the governed gate. Maximum 2 remediation sessions per spec
  execution; exhaustion fails the stage `needsHuman` with all evidence.
- **B-3 (head-sha discipline).** Every push restarts the watch on the new
  head sha; checks from stale shas are ignored, never mixed.
- **B-4 (merge).** All required checks green merges the PR (squash by
  default, configurable), deletes the remote branch, journals the merge sha,
  and confirms the default branch actually contains it before passing.
- **B-5 (quota inside shepherd).** A remediation session classified `quota`
  parks the run per spec 015 with the stage resumable at the same PR.

## 4. Functional requirements

- **FR-001.** GitHub polling and mutation behind the same typed client seam
  as spec 017; unit tests run on recorded fixtures including a
  green-first-try, a fail-fix-green, and a flap-then-exhaust scenario.
- **FR-002.** Evidence journaled per attempt: run ids, conclusions, log
  tail hashes, remediation session ids and cost, merge sha.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/stages/shepherd.test.ts` passes.
- **AC-2.** The fixture flap scenario ends `needsHuman` with 2 remediation
  attempts recorded and no merge.

## 6. Out of scope

Auto-rebasing on base-branch movement (v1 fails to needsHuman on conflicts),
required-review satisfaction (single-operator repos), and non-GitHub CI.

## 7. Resolved decisions

D-1. `checkRunsForSha`'s `required` flag is optional because this seam
version cannot always resolve branch-protection membership from a plain
check-runs read. A run counts toward the merge gate unless `required` is
explicitly `false`; absent or `true` both mean "required". This keeps a
single-operator repo (no branch protection configured, every `required`
field absent) honest to B-4's "all required checks green" without a second
gh call to read protection rules, matching the "required-review
satisfaction... out of scope" note above.

D-2. The GitHubClient extension (`checkRunsForSha`, `jobLogTail`, `mergePr`,
`branchContains`, `deleteRemoteBranch`) is declared additively on the
interface already established by spec 017 (`src/orchestrator/stages/ship.ts`),
not as a second seam in this spec's own territory. `ship.ts` and
`createProcessGitHubClient` remain spec 017's territory; this spec's
`establishes` list only ever claimed `shepherd.ts` and its test. Spec 017's
own body carries one sentence (D-7 there) noting the extension, so the
coupling gate reads the two specs as one coherent story rather than as a
silent drift.

D-3. B-5's literal text ("parks the run per spec 015 with the stage
resumable at the same PR") is read conservatively: this stage does not own
the run and cannot itself schedule a park (spec 015's park/resume state
lives in the daemon, spec 021, not in any one stage). A remediation session
classified `quota` therefore reports outcome `"quota"` upward, keeping the
stage's own outcome vocabulary the same shape build.ts and ship.ts already
use (`"passed" | "failed" | "blocked" | "quota"`), with all evidence
collected so far retained. The daemon maps `"quota"` to the park flow
described in spec 015, resuming this same stage at the same PR once the
quota window clears.

D-4. A remediation session classified `hook-blocked` yields stage outcome
`"blocked"`, the same adversarial-prompt-refusal reasoning ship.ts's B-2
already applies (spec 017, this spec's `.claude/rules/
adversarial-prompt-refusal.md`): a governed-gate refusal during remediation
is not this stage's contradiction to resolve, so it is surfaced rather than
retried or self-approved. `needsHuman` stays `false` on a blocked outcome
(the outcome value itself is the signal, mirroring build.ts's D-2 "outcome
value rather than a different evidence shape" reasoning); `needsHuman: true`
is reserved for `"failed"` outcomes where the stage genuinely could not
proceed on its own (remediation exhaustion, a watch deadline, a statusless
abort, or a merge whose containment could not be confirmed).

D-5. The per-attempt watch deadline (B-1, 45 minutes, configurable) is a
budget for a single call to the watch loop, not a total for the whole
shepherd run: a fresh 45-minute budget starts each time B-3 restarts the
watch on a new head sha after a remediation push. This matches the spec's
own summary ("every remediation is a new attempt with evidence").

D-6. A watch loop that reaches its own deadline without every required
check completing, and a merge whose `branchContains` confirmation comes back
`false`, both fail the stage with `needsHuman: true`, the same flag B-2
names for remediation exhaustion. Neither text explicitly says so, but both
are states the stage cannot resolve on its own (CI never finished; the
platform reported a merge that the default branch does not yet show), so the
conservative reading extends the same honest-failure flag rather than
inventing a third evidence shape for "stuck, but not exhausted".

D-7. Shepherding a branch with no open PR for it (for example, called before
spec 017's ship stage ever ran) fails immediately with `needsHuman: true` and
zero watch attempts, rather than waiting on a PR that does not exist. The
spec is silent on this input; treating "no PR" as a needsHuman failure
matches every other unresolvable state above rather than inventing a
`"refused"` outcome the stage's own vocabulary does not carry.

D-8 (2026-08-06, operator). The remediation prompt lists the target's
own gate program (016 D-10's `gateCommandsFor`), not the six-command
constant: a remediation session on a non-TypeScript target is not told
to run bun commands its repository does not define. The prompt builder
stays pure; the computed list arrives as a parameter defaulting to the
full constant.
