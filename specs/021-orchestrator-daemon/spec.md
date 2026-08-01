---
id: "021-orchestrator-daemon"
title: "Orchestrator daemon: the serial run loop"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
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

## 7. Resolved decisions

D-1. Process start time (the second half of B-1's identity check) is read
through an injected `ProcessInspector` seam; the production implementation
shells out to `ps -o lstart= -p <pid>` and parses the result with
`Date.parse`, matching the local wall-clock format `ps` itself emits on the
same host. `isAlive` is `process.kill(pid, 0)`, caught. Liveness is "pid
alive AND the process currently holding that pid reports the same start
time as recorded"; a live pid with a *different* start time is pid reuse,
reclaimed exactly like a dead pid, fixing spec 007's own recorded defect.
The daemon's own pid is also seam-injectable (`DaemonDeps.pid`, defaults to
`process.pid`) so identity logic is testable without a second real OS
process.

D-2. Mid-stage shutdown (B-6) does not attempt to cancel an in-flight stage
call. `shutdown()` sets a flag and awaits the loop's own promise; every
wait point in the loop (the per-stage retry loop's top, every chunk of a
parked or gated wait) checks the flag and unwinds honestly, but a call
already inside `await stageFns.<stage>(...)` runs to completion first, and
its outcome is journaled normally before the loop notices the flag and
exits. This is deliberate for v1 (a real stage session should not be
severed mid-write); a future spec may add cooperative cancellation.

D-3. The in-memory control queue (B-4) is drained on every chunk of every
chunked wait, not only at the top of the main loop. Without this, a
`resume()`/`approve()` issued while the loop is inside a long parked or
human-gated wait would sit unread until the wait's own condition happened
to become true on its own, which for a park could be hours away. Every
`chunkedSleepUntil` call therefore applies pending controls before its
first condition check and after every subsequent chunk.

D-4. `dag.adopted` (the bootstrap-era shipped-set from `dag.adoptedShipped`,
spec 012 D-1) is computed once, on the first recovery that finds no prior
`dag.adopted` record in the work journal, and is treated as immutable
afterward: subsequent restarts read the existing record rather than
recomputing it. Recomputing on every restart would let a spec's adoption
silently track drift in its own file after the fact, which is exactly the
pin-drift cascade spec 012 B-4 is supposed to catch deliberately, not
absorb quietly into a "first observation" pin that keeps moving.

D-5. `nextReady`'s own readiness filter trusts the target repo's registry
`implementation: pending` field, which in production only flips once a
build session's frontmatter edit has been merged to the default branch and
a fresh registry read reflects it; nothing in this spec's territory
refreshes the daemon's local checkout of the default branch between specs.
To avoid ever re-selecting a spec this run has already shipped (or a human
has skipped) because of a lagging registry read, the daemon computes a
working snapshot for each `nextReady` call that overrides the
`implementation` field of any spec already shipped-this-run or
control-skipped to a non-"pending" sentinel, independent of what the
registry currently reports. `ready()`/`invalidatedSet()` calls (build
stage's own preflight) are unaffected: they are keyed off the shipped-map,
not this sentinel.

D-6. Only shepherd's and verify's own `StageOutcome` enums carry a
first-class `"quota"` value; build's and ship's evidence shapes
(`SessionEvidence`, `ShipSessionEvidence`) preserve the session
classification kind but not its parsed reset time. The daemon's own quota
detector therefore treats a build/ship stage whose session evidence
classifies `"quota"` as a park trigger with `resetAtMs: null` (always an
estimate, honestly reflecting what that evidence actually carries), and
trusts shepherd's/verify's own explicit `"quota"` outcome directly (verify
alone also carries `quotaResetAtMs`, since its own evidence preserves it).

D-7. A quota-triggered park/resume inside the per-stage retry loop does not
consume the stage's ordinary retry budget (default 1 retry, B-3): the
attempt counter used for the journaled `StageExec.attempt` field still
increments (so every attempt is distinguishable in the journal), but the
separate budget counter that decides "has this stage failed too many times"
only increments on a genuine `"failed"` outcome. A run can therefore be
parked and resumed by quota indefinitely without ever exhausting a stage's
failure budget, matching B-3's "resumes the same stage as a fresh attempt"
literally.

D-8. `reverify(specId)` (B-4) only has a run to act on while that run's own
loop is still cycling (a completed `Run` is a terminal state per spec 013's
own transition table, with no way back). It is therefore scoped to
re-verifying a spec that is currently `shipped` under the *current* run,
skipping straight to the verify stage (`invalidated -> verifying`, spec 012
B-4's own re-qualification edge) rather than walking build/ship/shepherd
again; a reverify request for a spec with no such shipped `SpecExec` is
refused and journaled (`control.reverify.refused`) rather than silently
dropped or misapplied to the wrong entity.

D-9. Recovery's needsReconcile sweep (B-2) journals what it observed
(`daemon.reconciled`, including a best-effort `gh.prForBranch` read for a
stageExec's owning spec) but does not itself force a transition to close
out the dangling intent. Every stage entry point (build/ship/shepherd/
verify) was independently designed to be safely re-driven for the same
spec (branch reuse, ship's own PR idempotency precheck, shepherd's fresh
head-sha re-derivation, verify's fresh worktree checkout each time), so the
loop's normal per-spec resume (which always re-derives "what stage to run
next" from the live `SpecExec.status`, never an in-memory cursor) already
completes the reconciliation honestly; a stageExec's own dangling attempt
is superseded by the fresh attempt the resumed walk creates, never resumed
in place.

D-10. Found by the first live run: the build bracket flips the target spec
to in-progress, which made nextReady skip that same spec after a
retryStage, dead-ending the resume (the registry honestly said
in-progress, so the spec was neither pending nor shipped). The working
snapshot now reads any spec with a live or failed SpecExec in the current
run as schedulable, regardless of the registry's implementation field; the
regression test drives the registry flip the way the real bracket does.

D-11. Found by the second live relaunch: an amendment to spec 021 itself
drifted the adopted pin, and the invalidation cascade blocked the entire
backlog with no re-qualification path (reverify is scoped to
pipeline-shipped specs, and re-verification of an adopted spec is vacuous
anyway). Resolution: adoption tracks the registry continuously rather than
being computed once. On every scheduling pass, a registry spec reading
complete or n-a that is not pipeline-shipped is (re)adopted at its current
pin, journaled as dag.adopted.refreshed with the old pin (null for a late
first adoption). Pipeline-shipped specs never take this path; their
invalidation and re-verification stay strict per spec 012 B-4.

D-12. A terminal (completed or failed) latest run is history, not a verdict
on the mission: recovery creates a fresh run and continues the backlog,
with the whole journal retained. Only idle, running, paused, or parked runs
are resumed as-is.

D-13. Same relaunch: that bracket throw propagated out of the loop and
killed the daemon with the identity lock left behind. A stage
implementation throwing is now a contained failed attempt: journaled as
stage.crashed with the error, retried within the stage budget, then an
honest pause. The loop must outlive any single stage's bug.

D-14. The daemon's test fixtures implement the Runner seam owned by spec
016, so interface ripples there (such as pullFfOnly, 016 D-7) touch the
fixture fakes here without changing any daemon behavior.

D-15. Found by the first live run of the 025 wave: a daemon restarted
while the checkout sat on a failed spec's own branch, where that spec's
frontmatter reads complete, and D-11's continuous adoption adopted the
unmerged spec as shipped from that branch read. Adoption is monotone, so
the poisoned entry then outranked the D-10 resumable path (shipped wins
over resumable in the working snapshot) and the scheduler dead-ended
driving the spec's dependent, which build preflight honestly refused.
Resolution: the durable adoption appends (recovery's first `dag.adopted`
and every `dag.adopted.refreshed`) trust a registry read only when the
checkout is on the default branch, observed through an injectable
`readCheckoutBranch` seam (absent means trusted, for fixtures; a null
answer from a real checkout is not trusted). Withheld candidates journal
one `dag.adoption.deferred` per pass; readiness keeps using the
previously adopted set, and a deferred first adoption arrives later as
D-11's own late first adoption once the checkout is back on the default
branch.
