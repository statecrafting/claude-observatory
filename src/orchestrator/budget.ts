// Cost ceilings (spec 033): the enforcement that turns spec 030's fold into a
// financial floor an operator can stand on. The quota scheduler protects a
// subscription window; nothing protected a balance, so an oscillating
// remediation loop on a genuinely broken spec could spend all night without
// anything stopping it.
//
// Three disciplines shape everything below.
//
//   B-5 / D-1, the floor and not an estimate: spend sums only journaled
//   `costMicroUsd` values, exactly the stance 030 B-2 takes. Sessions whose
//   cost went unreported are counted, never guessed at: an estimate would
//   either fabricate spend to stop a run early or fabricate headroom to keep
//   it going, and both punish or permit on fiction. Every record and every
//   rendering carries the floor together with that scope's unknown count.
//
//   B-2 / D-2, boundaries only: evaluation happens before a session is
//   spawned, never mid-flight. Killing a live session to save money wastes
//   what it already spent and leaves a severed stage to retry (spending
//   again), so overshoot is bounded by one session and that bound is stated
//   in the trip record rather than implied.
//
//   D-3, the UTC calendar day: the corpus keeps all times UTC internally and
//   leaves display to the client (015 FR-001). Midnight UTC is exact
//   knowledge, so a budget-day park's horizon is never an estimate the way an
//   unhinted quota park's is.
//
// Every function here that needs a clock takes `now` explicitly; nothing in
// this module reads Date.now() itself.
import type { JournalHandle, JournalRecord, JsonValue } from "./journal";
import { canonicalizeValue } from "./journal";

// --- the model (B-1) --------------------------------------------------------

// Either limit, both, or (as a null ceiling) neither. A project whose chain
// holds no ceiling record has no ceiling and is driven exactly as it was
// before this spec existed.
export interface CostCeiling {
  readonly perRunMicroUsd?: number;
  readonly perDayMicroUsd?: number;
}

// Which limit an evaluation is talking about. The run scope is this run's own
// sessions; the day scope is every session of this project journaled in the
// current UTC calendar day, across runs and specs (B-2).
export type CeilingScope = "run" | "day";

// B-2's stated bound, journaled with every trip: the check runs at spawn
// boundaries, so real spend can exceed the ceiling by at most the one session
// that was already in flight when it crossed.
export const OVERSHOOT_BOUND_SESSIONS = 1;

// --- payload codec ----------------------------------------------------------

// Explicit nulls rather than absent keys, the same shape discipline spec 032's
// profilePayload uses: a reader never has to tell "omitted" from "cleared",
// and clearing the ceiling is a record that says so rather than an absence.
export function ceilingPayload(ceiling: CostCeiling | null): Record<string, JsonValue> {
  return {
    perRunMicroUsd: ceiling?.perRunMicroUsd ?? null,
    perDayMicroUsd: ceiling?.perDayMicroUsd ?? null,
  };
}

function limitField(o: Record<string, JsonValue>, field: string, label: string): number | undefined {
  const value = o[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new Error(`budget: ${label} expected a number or null for "${field}"`);
  }
  return value;
}

// Reads a ceiling back out of a payload. A malformed one throws rather than
// degrading to "no ceiling": a limit that cannot be read is not a limit
// anything should be driven under, and silently dropping it would remove the
// protection while every surface still claimed it was there.
export function parseCeiling(value: JsonValue | undefined, label: string): CostCeiling | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`budget: ${label} expected a JSON object`);
  }
  const o = value as Record<string, JsonValue>;
  const perRunMicroUsd = limitField(o, "perRunMicroUsd", label);
  const perDayMicroUsd = limitField(o, "perDayMicroUsd", label);
  return ceilingOf({
    ...(perRunMicroUsd === undefined ? {} : { perRunMicroUsd }),
    ...(perDayMicroUsd === undefined ? {} : { perDayMicroUsd }),
  });
}

// A ceiling carrying neither limit is no ceiling at all, and saying so once
// here keeps every caller from having to decide what an empty one means.
export function ceilingOf(ceiling: CostCeiling): CostCeiling | null {
  if (ceiling.perRunMicroUsd === undefined && ceiling.perDayMicroUsd === undefined) return null;
  return ceiling;
}

// What a write verb refuses before appending. Micro-USD is an exact integer
// unit and the journal's canonicalizer rejects fractional numbers outright, so
// a fractional limit is caught here with an operator-facing reason rather than
// as a codec error three frames down. Returns null when the ceiling is
// recordable, the reason when it is not.
export function ceilingRefusal(ceiling: CostCeiling | null): string | null {
  if (ceiling === null) return null;
  for (const [field, value] of [
    ["perRunMicroUsd", ceiling.perRunMicroUsd],
    ["perDayMicroUsd", ceiling.perDayMicroUsd],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value)) return `${field} must be a whole number of micro-USD, got ${value}`;
    if (value < 0) return `${field} cannot be negative, got ${value}`;
  }
  return null;
}

// --- the UTC calendar day (D-3) ---------------------------------------------

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The park horizon for a crossed per-day ceiling: the next 00:00:00.000 UTC
// strictly after `ms`. Exact knowledge, so a budget-day park never renders as
// an estimate (B-3).
export function nextUtcMidnightMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// --- spend evaluation (B-2, B-5, FR-001) ------------------------------------

// One scope's known-cost floor, with what the floor cannot see beside it. The
// two are never collapsed into one number: that is the whole of D-1.
export interface SpendFloor {
  readonly knownMicroUsd: number;
  readonly costKnownSessions: number;
  readonly costUnknownSessions: number;
}

export interface BudgetSpend {
  // The run the per-run floor was summed for, null when the journal holds no
  // run at all.
  readonly runId: string | null;
  readonly utcDay: string;
  readonly run: SpendFloor;
  readonly day: SpendFloor;
}

export interface BudgetEvaluation {
  readonly ceiling: CostCeiling | null;
  readonly spend: BudgetSpend;
  // Which limit the floor has crossed, null when none has. Strictly above:
  // spend exactly at the ceiling is not over it (FR-001).
  readonly over: CeilingScope | null;
  // B-5: this project has a ceiling and the scope it enforces over holds
  // sessions whose cost was never reported, so the ceiling is enforcing less
  // than it appears to. Visibility of what enforcement cannot see.
  readonly warnPorousFloor: boolean;
}

// The structural subset this module reads (the same pattern as state.ts's
// JournalRecordLike, plus `ts`: the UTC day a session belongs to is its
// record's own envelope timestamp). JournalRecord satisfies it.
export interface BudgetRecordLike {
  readonly ts: string;
  readonly kind: string;
  readonly payload: JsonValue;
}

export interface EvaluateBudgetInput {
  readonly records: readonly BudgetRecordLike[];
  readonly ceiling: CostCeiling | null;
  readonly nowMs: number;
  // Which run the per-run floor is for; the journal's most recently created
  // run when omitted, which is the one a daemon at a spawn boundary is driving.
  readonly runId?: string;
}

function isJsonRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(payload: JsonValue, field: string): string | null {
  if (!isJsonRecord(payload)) return null;
  const v = payload[field];
  return typeof v === "string" ? v : null;
}

function numberField(payload: JsonValue, field: string): number | null {
  if (!isJsonRecord(payload)) return null;
  const v = payload[field];
  return typeof v === "number" ? v : null;
}

// A timestamp that does not parse places its record in no day at all, rather
// than in whatever day NaN would collapse to.
function parseTsMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

interface FloorAccumulator {
  knownMicroUsd: number;
  costKnownSessions: number;
  costUnknownSessions: number;
}

function freshFloor(): FloorAccumulator {
  return { knownMicroUsd: 0, costKnownSessions: 0, costUnknownSessions: 0 };
}

function addSession(floor: FloorAccumulator, costMicroUsd: number | null): void {
  if (costMicroUsd === null) {
    floor.costUnknownSessions++;
    return;
  }
  floor.knownMicroUsd += costMicroUsd;
  floor.costKnownSessions++;
}

// Pure over (records, ceiling, now): no clock read, no registry read, no
// transcript parsing. Sessions are attributed to a run exactly as spec 030's
// fold attributes them (030 D-2): `session.result` records carry no specId, so
// the journal replays in order and each one credits to the run of the most
// recently created SpecExec. The day floor needs no attribution at all: it is
// every session of this project journaled in the current UTC day, whichever
// run or spec produced it (B-2).
export function evaluateBudget(input: EvaluateBudgetInput): BudgetEvaluation {
  const { records, ceiling, nowMs } = input;
  const today = utcDayKey(nowMs);

  const targetRunId = input.runId ?? lastRunId(records);
  const runFloor = freshFloor();
  const dayFloor = freshFloor();

  const runOfSpecExec = new Map<string, string>();
  let currentRunId: string | null = null;

  for (const record of records) {
    switch (record.kind) {
      case "specexec.created": {
        const id = stringField(record.payload, "id");
        const runId = stringField(record.payload, "runId");
        if (id !== null && runId !== null) runOfSpecExec.set(id, runId);
        currentRunId = runId;
        break;
      }
      case "session.result": {
        const cost = numberField(record.payload, "costMicroUsd");
        if (targetRunId !== null && currentRunId === targetRunId) addSession(runFloor, cost);
        const ms = parseTsMs(record.ts);
        if (ms !== null && utcDayKey(ms) === today) addSession(dayFloor, cost);
        break;
      }
      default:
        break;
    }
  }

  const spend: BudgetSpend = { runId: targetRunId, utcDay: today, run: runFloor, day: dayFloor };
  return {
    ceiling,
    spend,
    over: crossedScope(ceiling, spend),
    warnPorousFloor: porousFloor(ceiling, spend),
  };
}

function lastRunId(records: readonly BudgetRecordLike[]): string | null {
  let id: string | null = null;
  for (const record of records) {
    if (record.kind === "run.created") id = stringField(record.payload, "id") ?? id;
  }
  return id;
}

// FR-001: at is not over. Driving stops strictly above a limit, so a ceiling
// set to exactly what a run has spent still lets that run take its next
// session; the very next one over the line is what stops it.
function isOver(floorMicroUsd: number, limitMicroUsd: number | undefined): boolean {
  return limitMicroUsd !== undefined && floorMicroUsd > limitMicroUsd;
}

// The per-run limit outranks the per-day one when both are crossed: parking a
// run to midnight that is already over its own ceiling would spend the whole
// horizon to arrive at the same pause. See this spec's Resolved decisions.
function crossedScope(ceiling: CostCeiling | null, spend: BudgetSpend): CeilingScope | null {
  if (ceiling === null) return null;
  if (isOver(spend.run.knownMicroUsd, ceiling.perRunMicroUsd)) return "run";
  if (isOver(spend.day.knownMicroUsd, ceiling.perDayMicroUsd)) return "day";
  return null;
}

// B-5's health warning: only the scopes this ceiling actually enforces over
// can make its floor porous. An unknown-cost session under no limit at all is
// economics' business (030), not a warning about enforcement.
function porousFloor(ceiling: CostCeiling | null, spend: BudgetSpend): boolean {
  if (ceiling === null) return false;
  if (ceiling.perRunMicroUsd !== undefined && spend.run.costUnknownSessions > 0) return true;
  return ceiling.perDayMicroUsd !== undefined && spend.day.costUnknownSessions > 0;
}

// --- park/pause planning (B-3, B-4, FR-002) ---------------------------------

// The two reasons this spec adds to the run's park/pause vocabulary. Held here
// as well as in state.ts's own vocabulary so a planner never spells one by
// hand.
export type BudgetStopReason = "budget-day" | "budget-run";

export interface BudgetStopPlan {
  readonly reason: BudgetStopReason;
  readonly scope: CeilingScope;
  readonly limitMicroUsd: number;
  // The known-cost floor that crossed the limit, and what that floor could not
  // see: both travel into the journal, never the floor alone (B-5).
  readonly floorMicroUsd: number;
  readonly costKnownSessions: number;
  readonly costUnknownSessions: number;
  // B-2's bound, stated rather than implied.
  readonly overshootBoundSessions: number;
  // Next UTC midnight for a per-day park; null for a per-run pause, because no
  // clock makes a run cheaper (B-4).
  readonly targetMs: number | null;
  readonly needsHuman: boolean;
}

// What the daemon does about a crossed ceiling, or null when nothing is
// crossed. A per-day trip parks to a known horizon; a per-run trip pauses for
// an operator, since auto-resuming a run that is already over its own ceiling
// is a spend loop with extra steps.
export function planBudgetStop(evaluation: BudgetEvaluation, nowMs: number): BudgetStopPlan | null {
  const scope = evaluation.over;
  if (scope === null || evaluation.ceiling === null) return null;

  const floor = scope === "run" ? evaluation.spend.run : evaluation.spend.day;
  const limitMicroUsd =
    scope === "run" ? evaluation.ceiling.perRunMicroUsd : evaluation.ceiling.perDayMicroUsd;
  // crossedScope only names a scope whose limit is set, so this is unreachable
  // in practice; typed rather than asserted so the compiler agrees.
  if (limitMicroUsd === undefined) return null;

  return {
    reason: scope === "run" ? "budget-run" : "budget-day",
    scope,
    limitMicroUsd,
    floorMicroUsd: floor.knownMicroUsd,
    costKnownSessions: floor.costKnownSessions,
    costUnknownSessions: floor.costUnknownSessions,
    overshootBoundSessions: OVERSHOOT_BOUND_SESSIONS,
    targetMs: scope === "day" ? nextUtcMidnightMs(nowMs) : null,
    needsHuman: scope === "run",
  };
}

// --- journal integration (B-3, B-4, FR-002) ---------------------------------

export const BUDGET_KINDS = {
  parked: "budget.parked",
  resumed: "budget.resumed",
  paused: "budget.paused",
} as const;

function stopPayload(plan: BudgetStopPlan): JsonValue {
  return canonicalizeValue({
    reason: plan.reason,
    scope: plan.scope,
    limitMicroUsd: plan.limitMicroUsd,
    floorMicroUsd: plan.floorMicroUsd,
    costKnownSessions: plan.costKnownSessions,
    costUnknownSessions: plan.costUnknownSessions,
    overshootBoundSessions: plan.overshootBoundSessions,
    targetMs: plan.targetMs,
  });
}

// Journals the park and its target (015 B-2's discipline, applied to money):
// the countdown is derived from the journaled target, never stored as ticking
// state, so a daemon restarted mid-park resumes the same horizon it would have
// resumed before the restart.
export function journalBudgetPark(journal: JournalHandle, plan: BudgetStopPlan): JournalRecord {
  return journal.append(BUDGET_KINDS.parked, stopPayload(plan));
}

export function journalBudgetResume(journal: JournalHandle, resumedAtMs: number): JournalRecord {
  return journal.append(BUDGET_KINDS.resumed, canonicalizeValue({ resumedAtMs }));
}

// A per-run trip has no target and no resume of its own: the release is an
// operator act (raising or clearing the ceiling, or a retry/skip verb), each
// already a journaled record of its own.
export function journalBudgetPause(journal: JournalHandle, plan: BudgetStopPlan): JournalRecord {
  return journal.append(BUDGET_KINDS.paused, stopPayload(plan));
}

// The park or pause a project's journal currently carries, as every surface
// renders it: what makes a tripped ceiling name itself rather than showing up
// as a bare "parked".
export interface BudgetStopState {
  readonly reason: BudgetStopReason;
  readonly scope: CeilingScope;
  readonly limitMicroUsd: number;
  readonly floorMicroUsd: number;
  readonly costUnknownSessions: number;
  readonly targetMs: number | null;
  readonly needsHuman: boolean;
}

export interface BudgetFoldState {
  // The open stop, null when this project is not currently stopped on budget.
  readonly stop: BudgetStopState | null;
  // The most recent park's data whether or not it was resumed, which is what
  // FR-002's restart recovery reads the countdown target from.
  readonly lastPark: BudgetStopState | null;
}

function parseStopPayload(payload: JsonValue, kind: string): BudgetStopState {
  const reason = stringField(payload, "reason");
  if (reason !== "budget-day" && reason !== "budget-run") {
    throw new Error(`budget: ${kind} expected reason "budget-day" or "budget-run", got ${JSON.stringify(reason)}`);
  }
  const scope = stringField(payload, "scope");
  if (scope !== "run" && scope !== "day") {
    throw new Error(`budget: ${kind} expected scope "run" or "day", got ${JSON.stringify(scope)}`);
  }
  const limitMicroUsd = numberField(payload, "limitMicroUsd");
  const floorMicroUsd = numberField(payload, "floorMicroUsd");
  if (limitMicroUsd === null || floorMicroUsd === null) {
    throw new Error(`budget: ${kind} expected number fields "limitMicroUsd" and "floorMicroUsd"`);
  }
  return {
    reason,
    scope,
    limitMicroUsd,
    floorMicroUsd,
    costUnknownSessions: numberField(payload, "costUnknownSessions") ?? 0,
    targetMs: numberField(payload, "targetMs"),
    needsHuman: reason === "budget-run",
  };
}

// Pure fold over the budget records alone. A run transitioned back to
// "running" closes whatever budget stop was open: the operator lifted a pause
// (or a resume this fold did not see landed), and a stop that outlived the
// state it described would be a stale claim on every surface.
export function foldBudgetState(records: readonly BudgetRecordLike[]): BudgetFoldState {
  let stop: BudgetStopState | null = null;
  let lastPark: BudgetStopState | null = null;

  for (const record of records) {
    if (record.kind === BUDGET_KINDS.parked) {
      lastPark = parseStopPayload(record.payload, BUDGET_KINDS.parked);
      stop = lastPark;
    } else if (record.kind === BUDGET_KINDS.paused) {
      stop = parseStopPayload(record.payload, BUDGET_KINDS.paused);
    } else if (record.kind === BUDGET_KINDS.resumed) {
      stop = null;
    } else if (record.kind === "state.transition.outcome") {
      if (stringField(record.payload, "entity") === "run" && stringField(record.payload, "to") === "running") {
        stop = null;
      }
    }
  }

  return { stop, lastPark };
}

// --- threading a ceiling to the daemon (B-2) --------------------------------

// What a daemon is handed: the owning project's ceiling, or a late-bound read
// of it. A reader rather than a value for the same reason spec 032's
// ProfileSource is one: the scheduler builds a project's seams once and reuses
// them for the process's life, and a ceiling an operator raised to release a
// budget-paused run has to reach the next spawn boundary, not the next daemon.
export type CeilingSource = CostCeiling | null | (() => CostCeiling | null);

export function resolveCeilingSource(source: CeilingSource | undefined): CostCeiling | null {
  if (source === undefined || source === null) return null;
  return typeof source === "function" ? source() : source;
}

// --- the served view (B-7) --------------------------------------------------

// The ceiling and the spend evaluated against it, as every surface reads them:
// the project detail view, the economics rendering, and the API project
// payload all render this one shape rather than each folding the journal their
// own way.
export interface ProjectBudgetView {
  readonly ceiling: CostCeiling | null;
  readonly runId: string | null;
  readonly utcDay: string;
  readonly run: SpendFloor;
  readonly day: SpendFloor;
  readonly over: CeilingScope | null;
  readonly warnPorousFloor: boolean;
  readonly stop: BudgetStopState | null;
  // Why the floors above are empty, when they are: this project's journal
  // could not be read. The ceiling is registry state and stays knowable, so
  // the two facts are reported separately rather than collapsed into a zero
  // that would read as "nothing spent".
  readonly spendError: string | null;
}

export function projectBudgetView(
  records: readonly BudgetRecordLike[],
  ceiling: CostCeiling | null,
  nowMs: number
): ProjectBudgetView {
  const evaluation = evaluateBudget({ records, ceiling, nowMs });
  return {
    ceiling: evaluation.ceiling,
    runId: evaluation.spend.runId,
    utcDay: evaluation.spend.utcDay,
    run: evaluation.spend.run,
    day: evaluation.spend.day,
    over: evaluation.over,
    warnPorousFloor: evaluation.warnPorousFloor,
    stop: foldBudgetState(records).stop,
    spendError: null,
  };
}

// The same view for a project whose state root could not be read: the ceiling
// an operator set, and an explicit unknown everywhere the journal would have
// answered. Nothing here is inferred from the failure.
export function unreadableBudgetView(
  ceiling: CostCeiling | null,
  nowMs: number,
  reason: string
): ProjectBudgetView {
  const empty: SpendFloor = { knownMicroUsd: 0, costKnownSessions: 0, costUnknownSessions: 0 };
  return {
    ceiling,
    runId: null,
    utcDay: utcDayKey(nowMs),
    run: empty,
    day: empty,
    over: null,
    warnPorousFloor: false,
    stop: null,
    spendError: reason,
  };
}

// --- rendering (B-5, B-7, FR-004) -------------------------------------------

// Micro-USD to dollars at four decimals, matching what spec 030's CLI
// rendering already prints: the journal's unit is exact integers, and $0.0001
// resolution keeps a cheap session from reading as a bare $0.00.
function fmtMicroUsd(micro: number): string {
  return `$${(micro / 1e6).toFixed(4)}`;
}

// FR-004: a project without a ceiling says so. Never a blank, and never a zero,
// which would read as "no spend allowed" rather than "no limit set".
export function renderCeiling(ceiling: CostCeiling | null): string {
  if (ceiling === null) return "no ceiling";
  const parts: string[] = [];
  if (ceiling.perRunMicroUsd !== undefined) parts.push(`run ${fmtMicroUsd(ceiling.perRunMicroUsd)}`);
  if (ceiling.perDayMicroUsd !== undefined) parts.push(`day ${fmtMicroUsd(ceiling.perDayMicroUsd)}`);
  return parts.join(", ");
}

// B-5's rendering, verbatim: the floor with its unknown count beside it
// whenever that count is nonzero, so nobody reads a floor as a total.
export function renderSpendFloor(floor: SpendFloor): string {
  const amount = fmtMicroUsd(floor.knownMicroUsd);
  if (floor.costUnknownSessions === 0) return amount;
  const plural = floor.costUnknownSessions === 1 ? "session" : "sessions";
  return `at least ${amount}, ${floor.costUnknownSessions} ${plural} unknown`;
}

// The tripped ceiling as one short cell, for the list line a run's status
// shares with it: "parked" alone cannot be told from a quota park.
export function renderBudgetStop(stop: BudgetStopState | null): string {
  if (stop === null) return "";
  if (stop.reason === "budget-run") {
    return `budget-run: at least ${fmtMicroUsd(stop.floorMicroUsd)} over ${fmtMicroUsd(stop.limitMicroUsd)}, needs a human`;
  }
  const target = stop.targetMs === null ? "next UTC midnight" : new Date(stop.targetMs).toISOString();
  return `budget-day: at least ${fmtMicroUsd(stop.floorMicroUsd)} over ${fmtMicroUsd(stop.limitMicroUsd)}, until ${target}`;
}

// The whole budget picture as an operator reads it under a project, spend
// lines included. Every scope names its floor and its unknowns; a porous floor
// says out loud that the ceiling is enforcing less than it appears to (B-5).
export function renderBudget(view: ProjectBudgetView, indent: string = "         "): string[] {
  const lines = [`ceiling: ${renderCeiling(view.ceiling)}`];
  if (view.spendError !== null) {
    lines.push(`${indent}spend unknown: ${view.spendError}`);
    return lines;
  }
  lines.push(`${indent}run ${view.runId ?? "none"}: ${renderSpendFloor(view.run)}`);
  lines.push(`${indent}day ${view.utcDay}: ${renderSpendFloor(view.day)}`);
  if (view.stop !== null) lines.push(`${indent}${renderBudgetStop(view.stop)}`);
  else if (view.over !== null) lines.push(`${indent}over the ${view.over} ceiling; the next spawn boundary stops this run`);
  if (view.warnPorousFloor) {
    lines.push(
      `${indent}warning: sessions of unknown cost sit inside an enforced scope, so this ceiling enforces less than it appears to`
    );
  }
  return lines;
}
