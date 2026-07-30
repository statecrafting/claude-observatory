---
id: "015-quota-scheduler"
title: "Quota scheduler: detect exhaustion, park, resume at the spec boundary"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: high
depends_on:
  - "014-session-driver"
summary: >
  Long-running autonomy against a metered resource. Quota exhaustion is
  detected from the session driver's classification (primary) and observed
  ~/.claude activity (corroborating); the run parks with a countdown to the
  parsed or estimated reset, resumes automatically at the next spec
  boundary, and never probes by burning a session. The daemon itself
  consumes no model quota.
establishes:
  - "src/orchestrator/quota.ts"
  - "src/orchestrator/quota.test.ts"
---

# 015: Quota scheduler

## 1. Purpose

The difference between "autonomous overnight" and "dead by 21:40" is what
happens when the limit hits. Parking must be honest (known reset vs
estimate), cheap (no probe sessions), and resume must respect the work unit
(finish nothing mid-spec; park between stages only when the stage itself
died of quota).

## 2. Territory

`src/orchestrator/quota.ts` and tests.

## 3. Behavior

- **B-1 (detection).** A session classified `quota` (spec 014 B-4) is the
  authoritative trigger. The extracted reset time, when present, is the
  countdown target. When absent, the estimate is the last known reset cadence
  (5-hour windows observed for subscription quotas) anchored at the failure
  time, marked `estimated: true` and displayed as an estimate everywhere.
- **B-2 (parking).** On trigger: the in-flight stage journals `failed
  (quota)`, the spec execution stays live, the run transitions to `parked`
  with the target time, and no further sessions spawn. Parking and its
  target are journaled; the countdown is derived, not stored ticking state.
- **B-3 (resume).** At target time plus jitter (30-120 s), the run
  transitions `parked -> running` and the interrupted stage retries as a
  fresh attempt and fresh session. If the retry immediately classifies
  `quota` again, the next park doubles the estimate horizon (capped at the
  cadence) and increments a `consecutiveQuotaParks` counter surfaced as a
  health warning at 3.
- **B-4 (no probing).** The scheduler never spawns a session to test quota
  state. Wall clock plus the journaled target is the only resume signal.
- **B-5 (corroboration, optional).** When the observatory watcher is
  running, absence of any `~/.claude` transcript activity during a parked
  window is recorded as corroborating evidence; it never overrides B-1/B-3.

## 4. Functional requirements

- **FR-001.** Countdown math is pure and tested across DST boundaries (all
  times UTC internally; display is the client's concern).
- **FR-002.** A daemon restart while parked resumes the countdown from the
  journaled target, not from restart time.
- **FR-003.** Auth-classified failures never park; they stop the run as
  `failed` with `needsHuman` (a parked auth failure would spin forever).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/quota.test.ts` passes.
- **AC-2.** A simulated quota session (fake claude emitting a usage-limit
  result with a reset hint) drives park -> countdown -> resume -> retry in
  an integration test with a compressed clock.

## 6. Out of scope

Multi-account rotation, API-key fallback, and cost budgeting (cost is
recorded per session since 014; enforcement is a later spec).

## 7. Resolved decisions

D-1. B-1 and B-3 read literally collide on the estimated-park horizon: B-1
says the first estimate anchors "the last known reset cadence" (5 hours)
at the failure time, while B-3 says each consecutive re-quota "doubles the
estimate horizon (capped at the cadence)". Doubling from a horizon that is
already cadence-sized can never grow (it is already at its own cap), so a
literal chain would flatline at the cadence forever after the first park,
which makes the doubling language vacuous. Resolution, implemented
exactly: the very first estimated park in a streak (no `lastPark`) anchors
the full cadence per B-1; every consecutive estimated park after that
restarts a doubling sequence from a conservative starting point
(`QUOTA_BASE_ESTIMATE_MS`, 30 minutes, exported so the choice is visible
and testable) and doubles from there, capped at the cadence, per B-3. This
is the conservative reading available without either constant swallowing
the other: cadence still governs the honest "we know nothing" case, and
the doubling sequence still visibly grows on repeated failures until it
saturates at the cadence.

D-2. `consecutiveQuotaParks` counts every park in a streak, hinted or
estimated, not only estimated parks. B-3's health warning ("surfaced as a
health warning at 3") is about a run repeatedly hitting quota, which is
true whether or not the classifier happened to find a reset hint on any
given failure; gating the counter on "estimated only" would silently
under-report the health signal on a run whose provider keeps supplying
reset hints but keeps hitting the limit anyway.

D-3. `resumeJitterMs(rng, minMs?, maxMs?)` accepts optional bounds
defaulting to `RESUME_JITTER_MIN_MS`/`RESUME_JITTER_MAX_MS` (30 s / 120 s,
B-3's own numbers). Production callers rely on the defaults; AC-2's
integration test passes tiny bounds so the resume wait is compressed to
milliseconds without faking global time or the exported constants
themselves, keeping the test's own clock real and its runtime under 3 s.

D-4. `planPark` throws when given a non-`quota` classification rather than
silently returning a plan. B-1 names a quota classification as the
"authoritative trigger"; a caller reaching `planPark` with anything else
is a wiring bug upstream (the caller should have checked `parkDecision`
first), and failing loudly here matches this codebase's existing pattern
of validating before acting (state.ts's `InvalidTransitionError`) rather
than producing a plausible-looking plan for a park that was never
authorized.

D-5. `foldQuotaState`'s `lastPark` is retained across a `quota.resumed`
record rather than cleared back to `null`: FR-002 recovery only needs
`lastPark` while `parked` is true, but B-3's doubling needs the same data
after a resume, for the caller to pass as `planPark`'s `lastPark` input if
the very next session immediately re-quotas. Whether that next quota hit
still counts as "immediate" (versus a much later, unrelated quota event
that should reset the streak) is a judgment this module cannot make from
journal records alone; it is left to the caller (the daemon, spec 021),
consistent with this spec's own Out of scope boundary around scheduling
policy.
