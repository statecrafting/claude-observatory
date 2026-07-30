// The quota scheduler (spec 015): what happens after a session classifies
// `quota` (spec 014 B-4). Parks the run with an honest countdown target (the
// classifier's own parsed reset time when it found one, an anchored cadence
// estimate when it did not), survives a daemon restart by deriving the
// countdown from the journaled target rather than restart time (FR-002),
// and never spawns a probe session to test quota state (B-4). Auth never
// parks (FR-003): a parked auth failure would spin forever waiting for a
// reset that is never coming.
//
// Every decision function here takes `now` (or an injected clock/rng)
// explicitly; nothing in this module reads Date.now() or Math.random()
// itself (FR-001). All times are UTC epoch ms internally; converting a
// target to a display string in some timezone is the client's concern, not
// this module's (see the DST test in quota.test.ts).
import type { JournalHandle, JournalRecord, JsonValue } from "./journal";
import { canonicalizeValue } from "./journal";
import type { Classification } from "./classify-termination";

// --- constants (B-1, B-3) ---------------------------------------------------

// The last known reset cadence for subscription quotas (B-1's own words: "5
// hour windows observed"). Anchored at the failure time when the classifier
// found no reset hint at all.
export const QUOTA_CADENCE_MS = 5 * 3_600_000;

// A conservative starting point for the doubling sequence B-3 describes for
// consecutive re-quotas after a resume (see D-1 in this spec's Resolved
// decisions for why this is a separate constant from the cadence rather
// than the cadence itself).
export const QUOTA_BASE_ESTIMATE_MS = 30 * 60_000;

// B-3: "surfaced as a health warning at 3".
export const QUOTA_HEALTH_WARNING_THRESHOLD = 3;

// B-3: "resumes... at target time plus jitter (30-120 s)".
export const RESUME_JITTER_MIN_MS = 30_000;
export const RESUME_JITTER_MAX_MS = 120_000;

// --- park planning (B-1, B-3) -----------------------------------------------

export interface LastParkInfo {
  readonly estimated: boolean;
  readonly consecutiveQuotaParks: number;
}

export interface PlanParkInput {
  readonly classification: Classification;
  readonly now: number;
  // The immediately preceding park in this same streak, when the caller
  // knows the retry that just failed quota again is the one B-3 calls
  // "immediate": omitted (or undefined) resets the streak, giving the first
  // estimated park its full anchored cadence per B-1.
  readonly lastPark?: LastParkInfo;
}

export interface ParkPlan {
  readonly targetMs: number;
  readonly estimated: boolean;
  readonly consecutiveQuotaParks: number;
}

// D-1: the horizon for an estimated park (no reset hint). The very first
// park in a streak (no lastPark) anchors the full cadence, per B-1's literal
// "estimate is the last known reset cadence... anchored at the failure
// time". Every consecutive estimated park after that doubles from a
// conservative starting point (QUOTA_BASE_ESTIMATE_MS), capped at the
// cadence, per B-3's "doubles the estimate horizon (capped at the
// cadence)". See the spec's Resolved decisions for the full reasoning: B-1
// and B-3 read literally would collide (doubling from the first park's own
// cadence-sized horizon can never grow, since it is already at the cap), so
// the doubling sequence restarts from its own conservative base once a
// streak is underway rather than doubling the previous park's horizon.
function estimateHorizonMs(priorConsecutiveParks: number): number {
  if (priorConsecutiveParks === 0) {
    return QUOTA_CADENCE_MS;
  }
  return Math.min(QUOTA_CADENCE_MS, QUOTA_BASE_ESTIMATE_MS * 2 ** (priorConsecutiveParks - 1));
}

// B-1: a quota-classified session is the authoritative trigger. When the
// classifier extracted a reset time, that is the countdown target, full
// stop (estimated: false), regardless of park history. When it did not,
// estimateHorizonMs decides the anchored/doubled horizon (estimated: true).
// consecutiveQuotaParks counts every park in the streak, hinted or
// estimated: B-3's health warning is about repeatedly hitting quota, not
// specifically about repeated guessing.
export function planPark(input: PlanParkInput): ParkPlan {
  const { classification, now, lastPark } = input;
  if (classification.kind !== "quota") {
    throw new Error(`quota: planPark called with a non-quota classification ("${classification.kind}")`);
  }

  const priorConsecutiveParks = lastPark?.consecutiveQuotaParks ?? 0;
  const consecutiveQuotaParks = priorConsecutiveParks + 1;

  if (classification.resetAtMs !== null) {
    return { targetMs: classification.resetAtMs, estimated: false, consecutiveQuotaParks };
  }

  const targetMs = now + estimateHorizonMs(priorConsecutiveParks);
  return { targetMs, estimated: true, consecutiveQuotaParks };
}

// --- resume timing (B-3) ----------------------------------------------------

// rng is injectable (deterministic tests); minMs/maxMs default to the 30-120
// s window B-3 names but are overridable so an integration test can compress
// the wait without faking global time (see quota.test.ts's AC-2 test).
export function resumeJitterMs(
  rng: () => number = Math.random,
  minMs: number = RESUME_JITTER_MIN_MS,
  maxMs: number = RESUME_JITTER_MAX_MS
): number {
  const span = maxMs - minMs;
  return minMs + Math.floor(rng() * span);
}

export function resumeAtMs(targetMs: number, jitterMs: number): number {
  return targetMs + jitterMs;
}

// Pure: whether the parked -> running resume (B-3) should fire yet, given
// the caller's own clock reading. Never called with an implicit "now".
export function isResumeDue(nowMs: number, targetMs: number, jitterMs: number): boolean {
  return nowMs >= resumeAtMs(targetMs, jitterMs);
}

// --- health (B-3) ------------------------------------------------------------

export function shouldWarn(consecutiveQuotaParks: number): boolean {
  return consecutiveQuotaParks >= QUOTA_HEALTH_WARNING_THRESHOLD;
}

// --- park decision (FR-003) --------------------------------------------------

export type ParkDecision = "park" | "stop-needs-human" | "not-quota";

// quota parks; auth stops the run needing a human (a parked auth failure
// would spin forever); anything else is not this module's business (stage
// retry/backoff policy for transient, hook-blocked, timeout, crashed
// classifications lives elsewhere).
export function parkDecision(classification: Classification): ParkDecision {
  if (classification.kind === "quota") return "park";
  if (classification.kind === "auth") return "stop-needs-human";
  return "not-quota";
}

// --- journal integration (B-2, FR-002) ---------------------------------------

export interface FoldedQuotaPark {
  readonly targetMs: number;
  readonly estimated: boolean;
  readonly consecutiveQuotaParks: number;
}

export interface QuotaFoldState {
  readonly parked: boolean;
  // The most recent quota.parked record's data, present once any park has
  // ever been journaled, regardless of whether a later quota.resumed
  // cleared `parked`. This is both the FR-002 recovery target (when parked)
  // and the B-3 streak input for the next planPark call (when the caller
  // knows the next quota hit is the "immediate" retry B-3 describes).
  readonly lastPark: FoldedQuotaPark | null;
}

// A structural subset of JournalRecord: foldQuotaState only ever reads
// these two fields (same pattern as state.ts's JournalRecordLike), so it
// works against a live JournalHandle.fold().records or a freshly reopened
// journal after a simulated restart without depending on the hash-chain
// fields.
export interface QuotaJournalRecordLike {
  readonly kind: string;
  readonly payload: JsonValue;
}

function asRecord(v: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`quota: ${label} expected a JSON object payload`);
  }
  return v as Record<string, JsonValue>;
}

function asNumber(o: Record<string, JsonValue>, field: string, label: string): number {
  const v = o[field];
  if (typeof v !== "number") throw new Error(`quota: ${label} expected number field "${field}"`);
  return v;
}

function asBoolean(o: Record<string, JsonValue>, field: string, label: string): boolean {
  const v = o[field];
  if (typeof v !== "boolean") throw new Error(`quota: ${label} expected boolean field "${field}"`);
  return v;
}

function parseParkPayload(payload: JsonValue): FoldedQuotaPark {
  const o = asRecord(payload, "quota.parked");
  return {
    targetMs: asNumber(o, "targetMs", "quota.parked"),
    estimated: asBoolean(o, "estimated", "quota.parked"),
    consecutiveQuotaParks: asNumber(o, "consecutiveQuotaParks", "quota.parked"),
  };
}

// Journals the park (B-2: "parking and its target are journaled; the
// countdown is derived, not stored ticking state"). Payload is
// integers/booleans only, canonicalized like every other journaled entity
// in this codebase (journal.ts's canonicalizeValue rejects non-integer
// numbers, so a fractional epoch ms would fail loudly here rather than
// drifting silently).
export function journalPark(journal: JournalHandle, plan: ParkPlan): JournalRecord {
  const payload = canonicalizeValue({
    targetMs: plan.targetMs,
    estimated: plan.estimated,
    consecutiveQuotaParks: plan.consecutiveQuotaParks,
  });
  return journal.append("quota.parked", payload);
}

export function journalResume(journal: JournalHandle, resumedAtMs: number): JournalRecord {
  const payload = canonicalizeValue({ resumedAtMs });
  return journal.append("quota.resumed", payload);
}

// Pure fold: the current park state (FR-002) plus the last park's data for
// B-3 streak chaining, reconstructed from quota.parked/quota.resumed
// records alone. A daemon that reopens the journal after a restart recovers
// the same target this function would have reported before the restart:
// the countdown continues from the journaled target, never from restart
// time.
export function foldQuotaState(records: readonly QuotaJournalRecordLike[]): QuotaFoldState {
  let parked = false;
  let lastPark: FoldedQuotaPark | null = null;
  for (const r of records) {
    if (r.kind === "quota.parked") {
      lastPark = parseParkPayload(r.payload);
      parked = true;
    } else if (r.kind === "quota.resumed") {
      parked = false;
    }
  }
  return { parked, lastPark };
}

// --- corroboration (B-5, optional, observational only) -----------------------

export interface CorroborationEvent {
  readonly ts: number;
  readonly kind: string;
}

export interface CorroborationResult {
  readonly windowHadActivity: boolean;
  readonly matchingEventCount: number;
}

// B-5: "absence of any ~/.claude transcript activity during a parked window
// is recorded as corroborating evidence; it never overrides B-1/B-3". This
// function only reports what it saw; nothing in planPark, parkDecision, or
// the resume-timing functions above ever calls it or reads its result.
export function corroborateParkWindow(
  events: readonly CorroborationEvent[],
  parkStart: number,
  parkEnd: number
): CorroborationResult {
  const inWindow = events.filter((e) => e.ts >= parkStart && e.ts <= parkEnd);
  return { windowHadActivity: inWindow.length > 0, matchingEventCount: inWindow.length };
}
