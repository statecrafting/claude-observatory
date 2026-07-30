---
id: "017-stage-ship"
title: "Ship stage: commit, push, open the PR through the governed discipline"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: complete
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

## 7. Resolved decisions

D-1. The Runner seam is imported from `build.ts` (spec 016) rather than
redeclared: `runShipStage` only needs `currentBranch`, `headSha`, and
`runSession`, all already part of that interface, and `createProcessRunner`
is reused wholesale for the git half of the test fixtures (the same pattern
build.ts's own tests already use for AC-2's real-git flow). GitHubClient
(FR-001) is the one genuinely new seam this spec adds: a typed read-only
wrapper over the `gh` CLI, following the same interface-plus-Bun.spawnSync
production factory shape as `createProcessRunner`, so the two seams read as
one family without one duplicating the other.

D-2. B-4's idempotency pre-check (`gh.prForBranch(branch)`) runs
unconditionally as the stage's first action, before any session is driven.
When it finds a PR that already verifies (B-3's own check, reused), the
stage passes with `sessions: []`, satisfying "retrying a ship...is a pass,
not a duplicate PR" without needing a session at all. When it finds a PR
that does not yet verify (for example new local commits since the PR
opened), the mismatch is journaled but does not fail the stage outright:
only the post-session check is allowed to produce a `failed` outcome. This
keeps "found a stale PR" and "verified after driving a session" as two
distinct failure surfaces, matching B-3's own text ("after the session").

D-3. AC-2's "no PR-existence check attempted" is read as: once a session
classifies `hook-blocked`, the stage never proceeds to the post-session
outside-verification step (B-3) that would otherwise call `commitsForPr`
and `checksTriggered` and produce pass/fail evidence with a diff. The B-4
idempotency pre-check described in D-2 still runs before the session (it
has to, in order to decide whether a session is needed at all), so a
fixture exercising AC-2 legitimately sees exactly one `prForBranch` call
(the pre-check, finding nothing) and zero calls to `commitsForPr` or
`checksTriggered`, ever. `ship.test.ts`'s AC-2 test asserts this call
breakdown explicitly rather than a bare "gh was never called", and the
in-code comment at the block-handling branch cross-references this
decision.

D-4. `GitHubClient.checksTriggered` returns a bare boolean (FR-001's own
literal signature), with no CI run id. FR-002 asks for "CI run id when
visible" in evidence; since this seam version cannot surface one,
`ShipEvidence.ciRunId` is always `null` rather than fabricated from
`checksTriggered`'s boolean. A future seam revision that adds a run id to
the interface can fill this field without changing `ShipEvidence`'s shape.

D-5. Ship's own `ShipSessionEvidence` is a distinct shape from build.ts's
`SessionEvidence`, not a reuse: it additionally carries `detail` (the
termination classifier's own explanation) and `stderrTail` (the process's
captured stderr), because B-2's "refusal text is stage evidence" needs the
actual refusal wording, not just the classification's kind string that
`SessionEvidence` exposes. Duplicating six fields to add two is cheaper than
widening build.ts's own evidence shape for a field only this stage reads.

D-6. `runShipStage` takes `specId` as an explicit option rather than
deriving it from `runner.currentBranch()`, even though build.ts's own
convention makes them equal in practice (branch names are spec ids). This
keeps ship.ts's journal payloads self-describing without assuming the
branch-naming convention holds forever, and matches every other stage's
journal records (`specId` is always an explicit field, never inferred from
the branch string).

D-7. The shepherd stage (spec 018) extends this file's `GitHubClient`
interface additively (`checkRunsForSha`, `jobLogTail`, `mergePr`,
`branchContains`, `deleteRemoteBranch`), rather than declaring a second
seam, since watching checks and merging is still "GitHub reads and one
governed mutation behind a typed client" in the same shape FR-001 already
describes; `ship.ts` and `createProcessGitHubClient` remain this spec's own
territory, and none of its existing methods or behavior change.

D-8. The default ship turn budget is 60, raised from 30 after the first
live run: two real /ship sessions each starved at the 30-turn cap doing
legitimate work (gate, review, hygiene scans) before reaching push and PR
creation. Callers can still override per stage.
