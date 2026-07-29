---
id: "015-quota-scheduler"
title: "Quota scheduler: detect exhaustion, park, resume at the spec boundary"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
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
