---
id: "026-standby-daemon"
title: "Standby daemon and the multi-project scheduler"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: critical
depends_on:
  - "021-orchestrator-daemon"
  - "025-project-registry"
summary: >
  The daemon stops dying of success: a terminal run drops it to standby,
  still serving the API, instead of exiting the process. Above the
  per-run loop sits a scheduler over the project registry (025): armed,
  qualified projects with ready work get a fresh run, serviced serially in
  registration order, with at most one live stage session globally. A
  bounded standby scan refreshes the registry and each armed project's
  spec DAG, so new pending specs wake a run automatically per 010 D14.
  Quota parking is global: the account's quota is one pool, so no project
  starts a session while parked. Runs, journals, and recovery semantics
  from 013, 011, and 021 are unchanged; the daemon simply outlives them.
establishes:
  - "src/orchestrator/standby.ts"
  - "src/orchestrator/standby.test.ts"
extends:
  # The run loop's exit-on-terminal becomes a transition to standby, and
  # spec selection consults the registry instead of assuming one repo.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: superseding }
  # The daemon run composition keeps process and API alive in standby.
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 026: Standby daemon

## 1. Purpose

The first post-milestone live run exposed it (010 A-1): with an empty
backlog the daemon exits within milliseconds, taking the API and UI with
it, so "mission complete" and "not running" were the same observable. A
general builder must idle honestly: alive, observable, and ready to drive
whichever registered project next has work.

## 2. Territory

`src/orchestrator/standby.ts` (the scheduler and standby loop) and its
tests. Supersessions as declared in `extends`: the run loop's terminal
break in `src/orchestrator/daemon.ts` and the `daemon run` composition in
`src/commands/orchestrator.ts`. The build session records an amendment
note in spec 021 §6 (whose "multi-repo runs" out-of-scope line this spec
supersedes) and in spec 023 D-2; that authority is granted here, per the
coherence guard's "agent with explicit authority" clause.

## 3. Behavior

- **B-1 (standby, not exit).** A run reaching completed or failed drops
  the daemon to standby: the process, lock, and API stay up until an
  operator stops the daemon. Standby is a daemon state, not a run state;
  spec 013's transition table is untouched and terminal runs stay history
  (021 D-12, generalized per project).
- **B-2 (scheduler).** The scheduler folds the registry (025) and services
  armed, qualified projects in registration order: a project with ready
  work gets a fresh run driven by the existing per-run loop against its
  own state root and repoDir. Switching projects happens only at a run
  boundary, never mid-spec.
- **B-3 (one flight slot).** The serial invariant (010 B-5, restated by
  D15) is one live stage session globally. A run paused on needsHuman or
  stopped on blockers releases the slot so another project may proceed;
  an approval or retry resumes the paused run with priority over starting
  new runs.
- **B-4 (standby scan).** On a bounded interval (default 60 s) standby
  re-folds the registry, refreshes each armed project's registry read, and
  requalifies cheaply. Newly ready work in an armed project wakes a run
  automatically; disarmed projects are observed and reported, never
  driven. The scan consumes no model quota (021 B-5 inherited).
- **B-5 (quota is global).** Quota exhaustion parks the daemon, not just
  the run that detected it: the account's quota is one pool, so no
  project's session starts before the spec 015 horizon resumes the parked
  run first.
- **B-6 (one daemon per home).** Lock and log stay in the daemon home
  with 021 B-1's identity semantics unchanged; the lock guarantees one
  daemon per daemon home (a second checkout is a second home, its
  operator's responsibility). There are no per-project locks; each
  project's journals still take spec 011's own per-chain writer lock in
  that project's state root.
- **B-7 (shutdown).** SIGTERM in standby exits promptly (nothing to
  sever); SIGTERM mid-run inherits 021 B-6 exactly: the scheduler severs
  the live session child (021 D-19) and awaits the in-flight drive(),
  whose severed stage outcome (classification "killed") journals
  normally before the loop unwinds.

## 4. Functional requirements

- **FR-001.** An end-to-end standby test drives a fixture with two
  registered projects: project A's backlog completes and the daemon stays
  serving in standby; a spec flipping to pending in armed project B wakes
  a run within one scan; a disarmed project with ready work is reported
  and never driven; a daemon kill and restart during standby recovers to
  standby with both project histories intact.
- **FR-002.** A scheduler test proves the flight slot: with A's run
  paused on needsHuman and B ready, B proceeds; A's approval resumes A
  before any further new run starts.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/standby.test.ts` passes, including
  FR-001 and FR-002.
- **AC-2.** `bun test src/orchestrator/daemon.test.ts` still passes
  unchanged in behavior it owns (the 021 FR-001 kernel scenario).

## 6. Out of scope

Parallel stage sessions, cross-project dependency edges, fairness beyond
registration order, remote daemons, and any UI or API surface (027-029).

## 7. Resolved decisions

D-1. Registration order is the whole scheduling policy in v1. A project
earlier in the registry with an inexhaustible backlog can starve later
ones; this is recorded honestly rather than balanced away, and a fairness
policy, if ever needed, is a future spec's territory.

D-2. Waking a run automatically is gated on `armed` alone, deliberately:
registration defaults to armed (010 D14), so pointing the daemon at a
project is the consent to build it, and disarming is the one lever that
makes a project observation-only. There is no second global autopilot
switch to disagree with the per-project flag.

D-3 (recorded post-ship; the build session cited it in code without an
entry). A virgin projects chain bootstraps itself: the first start
registers the `--repo` checkout as the first project at its qualification
verdict, so the self-hosted daemon needs no manual registration step.
Once anything has ever been registered this path never fires again.

D-4 (recorded post-ship; same provenance). A concluded project settles
the registry signature its conclusion was reached on, and the scan only
re-wakes it when the signature changes; without this, a completed or
permanently blocked backlog would be re-driven every scan. The settle map
is in-memory, so a daemon restart re-drives each armed project once.

D-5 (operator, 2026-08-01). Found closing the wave: 021 D-18's
requalification runs from a live daemon's loop, but controls only attach
to live daemons, so a reverify for a project nothing was driving answered
`unavailable` forever: the one control whose whole point is a project at
rest was the one control that could never reach it. The scheduler gains
`openForControl(name)`: start the project's daemon (journals held,
recovery run), park it in the live map, and let B-3's priority half,
extended from `hasQueuedResume` to also cover a queued reverify, drive it
on the next cycle. Every other verb still answers `unavailable` honestly.

D-6 (2026-08-02, operator-directed fix wave). B-7's mid-run SIGTERM
previously cited 021 D-2's run-to-completion wait, which is what left a
mid-build stop hanging on the child's own 30-minute deadline (021 D-19
records the incident). The scheduler's `shutdown()` now severs the live
session child through an injectable `killLiveSession` seam (production:
spec 014's module-global kill, wired in `cmdDaemonRun`; absent in fixture
deps is a no-op), called unconditionally after flagging the slot-holding
daemon: with no live child it reports false and costs nothing. The
supervised daemon's own `requestShutdown()` stays flag-only; the
scheduler performing the kill itself is what closes the gap where a
supervisor that only flags waits out an in-flight stage.

D-7 (2026-08-04, operator). The code-staleness gate. Found live: PR #44
merged a verifier fix while the daemon kept running the code it had
loaded half a day earlier, and its reverify of the very spec that fix
existed for failed against tools the running process did not have. The
scheduler now captures the sha of the checkout its code was loaded from
at start (`readCodeSha` in deps; production reads git HEAD at the code
root, a proxy that knowingly misses dirty-tree edits) and re-reads it
every cycle: a readable, different sha freezes all driving (new runs,
amendment healing, and paused-run resumes alike), announces itself in
the log and on every armed project's detail line, and exposes
`codeStale` on the snapshot. Freshness is re-read rather than latched,
so a checkout moved back resumes driving without a restart; an
unreadable sha is unknown, and unknown is never stale. The remedy is an
operator restart: a process cannot reload its own modules, and driving
with code that no longer matches the corpus is exactly the failure
verification exists to prevent.

D-8 (2026-08-04, operator). The amendment half of the scheduler. A
project whose registry signature moved while nothing is pending is an
amendment cascade, not new build work, and it previously waited for
operator reverify verbs (found live: a day of silence, twice nudged).
The scan signature now carries each spec's content pin alongside its
implementation field, so an amendment wakes the scheduler at all; a
short-lived daemon is then opened to `queueAutoReverifies` (021 D-22).
Zero queued settles the signature without a drive (the open itself
re-adopted any amended adopted specs); a positive queue drives the run
under the normal flight slot, and the run heals roots first, dependents
by evaporation. The new-run half queues the same reverifies before
driving mixed corpora (pending work plus drift), so one run heals then
builds instead of dead-ending on invalidated-dependency blockers. A
driven run that fails settles its signature too: a reverify that needs a
human is reported once, never retried on a loop, and the next authoring
edit earns the next attempt. Arm/disarm stays the consent boundary and
quota parking applies unchanged; a disarmed project's drift is observed
and reported, never healed behind the operator's back.

D-9 (2026-08-04, operator). The probe run concludes. D-8's zero-queued
open necessarily created (or resumed) a run and journaled it into
"running" before `queueAutoReverifies` ever ran, and retiring around
that run closed the journals with it still live: the target's latest run
then read as "running" forever on a project nothing was driving (found
live: tenant-emit, the first fully-adopted corpus the amendment half
scanned; its status line claimed a run in flight with no heartbeat ever
journaled). The scheduler now calls the daemon's `concludeIdle()` (021
D-23) before a zero-queued retire: the probe's run ends "completed"
through the loop's own idle verdict, the same `run.result` record and
journaled transition. A refusal (the resumed run is paused, parked, or
still holds live or retryable spec work) means the run carries something
only the loop can reconcile, so the probe drives it under the normal
flight slot instead of abandoning it. A run stranded by a pre-D-9 probe
heals the same way: the next open resumes it, finds nothing in flight,
and concludes it. Zero-queued settling is otherwise unchanged, and a
healthy probe still costs no session and no quota.

D-10 (2026-08-06, operator). The reverify half of B-3's priority is
gated on the run being able to act on it. Found live: the first restart
onto post-034 code recovered a run paused on a failed build while the
corpus carried both a drifted shipped root and new pending work; the
open queued auto-reverifies (D-8), but the supervised loop yields for a
pause before it ever touches the reverify queue, so the drive consumed
nothing, `hasQueuedReverify` stayed true, and the priority half re-drove
the same daemon every cycle. Standby spun at roughly four cycles a
second, the scan's process spawns starved the API, and the resume that
would have lifted the pause could never be delivered; SIGTERM could not
land either (B-7's prompt exit needs the loop to reach a wait), so the
daemon died by SIGKILL. The daemon's getter now answers false unless
the run is "running": a queued reverify on a paused run, or on a park
that released the slot, is not actionable; its queue entries persist,
and the control that lifts the yield already reports through
`hasQueuedResume`, whose drive drains the queue immediately after. The
scheduler is unchanged except its citation: a cycle with nothing
actionable falls through to the standby wait, which is what keeps the
API serving and the pause liftable.

D-11 (2026-08-06, operator). The scheduler half of 021 D-24: any open of
a project daemon (a new-run wake, an amendment probe, an
openForControl) restores that project's journaled-but-unapplied
controls as part of recovery, and the existing priority half then sees
them through the same `hasQueuedResume`/`hasQueuedReverify` getters it
already reads, so a restored resume or retry earns the next drive with
no new scheduler surface at all. The operator's mental model becomes:
a control accepted by the API is a durable promise of the project's
chain, delivered when the next daemon, whichever process that is,
opens those journals; a daemon death between acceptance and
application costs a restart, never the control.
