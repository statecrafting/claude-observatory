---
id: "021-orchestrator-daemon"
title: "Orchestrator daemon: the serial run loop"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
risk: critical
depends_on:
  - "012-spec-dag-readiness"
  - "015-quota-scheduler"
  - "016-stage-build"
  - "017-stage-ship"
  - "018-stage-shepherd"
  - "019-stage-verify"
  - "020-decision-ledger"
summary: >
  The long-lived process that composes everything: recover state from the
  journal, reconcile any intent-without-outcome, then loop serially: pick
  the next ready spec (012), walk its stages (016-019) through the state
  machine (013), park and resume on quota (015), stop honestly on
  needsHuman. Identity-checked single instance (pid plus process start
  time), consumes no model quota itself, and hosts the HTTP API (022) in
  the same process.
establishes:
  - "src/orchestrator/daemon.ts"
  - "src/orchestrator/daemon.test.ts"
---

# 021: Orchestrator daemon

## 1. Purpose

One process that can be killed at any moment and trusted after restart.
Everything hard lives in the kernel specs; the daemon is their disciplined
composition, which is exactly why it is specified rather than improvised.

## 2. Territory

`src/orchestrator/daemon.ts` and tests.

## 3. Behavior

- **B-1 (single instance).** Lock: `data/orchestrator/daemon.lock` holding
  pid plus process start time; liveness is verified against both (pid reuse
  is detected, fixing the recorded defect pattern of spec 007). A stale
  lock is reclaimed with a journal note.
- **B-2 (recovery first).** Startup order: acquire lock, open journals
  (011, 020), fold state, resolve every `needsReconcile` (013 B-6) by
  inspecting the world (branch existence, PR state, merge state) and
  journaling the reconciliation, only then start the loop and the API.
- **B-3 (the loop).** While the run is `running`: compute `nextReady`;
  none pending completes the run; none ready but pending exist stops as
  `failed` with per-spec blockers (or waits, if blockers are in-flight
  specs); otherwise execute the spec's stages in order, honoring stage
  outcomes: passed advances, failed retries within the stage's budget then
  fails the spec execution, blocked and needsHuman pause the run with the
  reason surfaced.
- **B-4 (control).** The API (spec 022) can pause, resume, skip a spec,
  retry a stage, re-run verify, and force a human gate on a named spec (the
  spec's next stage transition waits for explicit approval). Every control
  action is journaled with its source.
- **B-5 (no quota).** The daemon's own operation spawns no sessions outside
  stage execution; observability, scheduling, and the API are quota-free.
- **B-6 (shutdown).** SIGTERM finishes the current journal write, kills any
  live session child (which journals its termination), releases the lock,
  and exits; SIGKILL at any byte is covered by 011's recovery guarantees.

## 4. Functional requirements

- **FR-001.** An end-to-end kernel test drives a two-spec fixture DAG with
  fake claude, fake GitHub, and a compressed clock through: build, ship,
  shepherd, verify, quota park/resume injected at shepherd, daemon kill and
  restart injected at build, ending with both specs shipped and a verified
  chain.
- **FR-002.** The loop journals a heartbeat state summary at most once per
  minute (bounded, not chatty) so "what was it doing when it died" is
  always answerable.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/daemon.test.ts` passes, including
  the FR-001 scenario.
- **AC-2.** `verifyChain` passes over the journal produced by AC-1's kills
  and restarts.

## 6. Out of scope

Parallel spec execution, multi-repo runs, and daemonization ergonomics
(launchd plist etc. follow spec 007's print-only stance later).
