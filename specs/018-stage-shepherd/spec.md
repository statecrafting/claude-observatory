---
id: "018-stage-shepherd"
title: "Shepherd stage: watch CI, remediate, merge when green"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: pending
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
