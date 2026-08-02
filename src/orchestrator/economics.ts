// Run economics (spec 030): the rollup that turns "what did last night
// cost" and "how much rework did that spec need" into one read instead of a
// hand-fold of JSONL. economicsView() is a pure function over one project's
// journal records (B-1): per spec, sessions consumed with a count per
// termination kind (spec 014's full set), stage attempts beyond the first
// counted as remediation rounds, hook-blocked stage outcomes, summed session
// cost in micro-USD with a separate count of sessions whose cost went
// unreported, and wall-clock from first stage intent to terminal transition;
// per run, the same aggregates plus quota parks entered and total parked
// duration; totals across the journal's whole history ride along.
//
// Two disciplines shape everything below. Honest absence (B-2): a session
// with `costMicroUsd: null` lands in costUnknownSessions and never in the
// sum, an empty journal folds to zero specs and null totals, and nothing
// here estimates: money is summed only from journaled values (011's
// evidence stance, applied to accounting). Journal-derived only (B-5): the
// fold reads records and nothing else, no git archaeology, no registry
// reads, no transcript parsing; yield metrics that would need those sources
// are a future spec's territory, not approximated here.
import type { JsonValue } from "./journal";
import type { TerminationKind } from "./classify-termination";
import { foldOrchestratorState, type RunStatus } from "./state";

// The scoped route suffix this view is served under (B-3):
// `GET /api/projects/<name>/economics`. Owned here rather than in
// api/types.ts's PROJECT_ROUTES because spec 030 extends the server and the
// CLI additively without reshaping 027's own contract files; both sides
// import this one constant, so the path still cannot drift between them
// (027 D-8).
export const ECONOMICS_ROUTE = "economics";

// --- the termination-kind set (spec 014 B-4) --------------------------------

// Spec 014's full kind set as a runtime value. classify-termination.ts only
// exports the union type, so the zero-filled map is declared as an
// exhaustive Record: a kind added to or removed from TerminationKind fails
// typecheck right here instead of silently folding into no bucket.
const ZERO_TERMINATIONS: Readonly<Record<TerminationKind, number>> = {
  completed: 0,
  auth: 0,
  quota: 0,
  "hook-blocked": 0,
  transient: 0,
  timeout: 0,
  killed: 0,
  "max-turns": 0,
  crashed: 0,
};

export const TERMINATION_KINDS = Object.keys(ZERO_TERMINATIONS) as readonly TerminationKind[];

// --- view shapes (B-1) ------------------------------------------------------

// One row per spec id, aggregated across every SpecExec the journal holds
// for it (a retried spec is still one line of "what did this spec need"; see
// this spec's Resolved decisions, D-1).
export interface SpecEconomics {
  readonly specId: string;
  readonly sessions: number;
  // Every kind is present, zero-filled: a zero here is an honest count over
  // a known set, unlike the unreported values below that stay null.
  readonly sessionsByTermination: Readonly<Record<TerminationKind, number>>;
  // Stage attempts beyond the first, counted verbatim per B-1: every
  // StageExec minted at attempt > 1, whatever forced the fresh attempt.
  readonly remediationRounds: number;
  // StageExecs the journal shows transitioned to "blocked", which is the
  // daemon's own hook-blocked/refused outcome edge (D-3); sessions that
  // classified hook-blocked are visible in sessionsByTermination.
  readonly hookBlockedStages: number;
  // null until any session for this spec reported a cost: a spec whose
  // sessions all went unreported is "cost unknown", not free (B-2).
  readonly costMicroUsd: number | null;
  readonly costUnknownSessions: number;
  // First stage-transition intent to the last shipped/failed transition of
  // a SpecExec for this spec; null while either end is missing (D-4).
  readonly wallClockMs: number | null;
}

export interface RunEconomics {
  readonly runId: string;
  readonly status: RunStatus;
  readonly sessions: number;
  readonly sessionsByTermination: Readonly<Record<TerminationKind, number>>;
  readonly remediationRounds: number;
  readonly hookBlockedStages: number;
  readonly costMicroUsd: number | null;
  readonly costUnknownSessions: number;
  readonly quotaParks: number;
  // Sum of the closed park windows (quota.parked to its quota.resumed).
  // A park still open when the journal ends makes the total unknowable, so
  // it is null, never a floor passed off as the whole (D-5); zero parks is
  // an honest zero.
  readonly parkedMs: number | null;
  // First stage intent within this run to the run's own completed/failed
  // transition; null while the run is not terminal.
  readonly wallClockMs: number | null;
}

export interface EconomicsTotals {
  readonly sessions: number;
  readonly sessionsByTermination: Readonly<Record<TerminationKind, number>>;
  readonly remediationRounds: number;
  readonly hookBlockedStages: number;
  readonly costMicroUsd: number | null;
  readonly costUnknownSessions: number;
  readonly quotaParks: number;
  readonly parkedMs: number | null;
}

export interface EconomicsView {
  readonly project: string;
  readonly specs: readonly SpecEconomics[];
  readonly runs: readonly RunEconomics[];
  // null for an empty journal (B-2): there is no history to total, and a
  // fabricated all-zero totals row would claim there was.
  readonly totals: EconomicsTotals | null;
}

// --- record shape ------------------------------------------------------------

// The structural subset this fold reads (same pattern as state.ts's
// JournalRecordLike, plus `ts`: wall-clock and park windows are anchored at
// record timestamps). JournalRecord satisfies it; the hash-chain fields are
// never read here.
export interface EconomicsRecordLike {
  readonly ts: string;
  readonly kind: string;
  readonly payload: JsonValue;
}

// --- small payload readers ---------------------------------------------------

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

// A timestamp that does not parse contributes nothing rather than an NaN
// that would poison every subtraction downstream.
function parseTsMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

// --- accumulators ------------------------------------------------------------

interface Tally {
  sessions: number;
  byTermination: Record<TerminationKind, number>;
  remediationRounds: number;
  hookBlockedStages: number;
  costSumMicroUsd: number;
  costReportedSessions: number;
  costUnknownSessions: number;
}

function freshTally(): Tally {
  return {
    sessions: 0,
    byTermination: { ...ZERO_TERMINATIONS },
    remediationRounds: 0,
    hookBlockedStages: 0,
    costSumMicroUsd: 0,
    costReportedSessions: 0,
    costUnknownSessions: 0,
  };
}

function tallySession(tally: Tally, kind: string | null, costMicroUsd: number | null): void {
  tally.sessions++;
  if (kind !== null && Object.hasOwn(tally.byTermination, kind)) {
    tally.byTermination[kind as TerminationKind]++;
  }
  if (costMicroUsd !== null) {
    tally.costSumMicroUsd += costMicroUsd;
    tally.costReportedSessions++;
  } else {
    tally.costUnknownSessions++;
  }
}

// B-2 at the emission point: the sum exists only once something was actually
// journaled to sum.
function costOf(tally: Tally): number | null {
  return tally.costReportedSessions > 0 ? tally.costSumMicroUsd : null;
}

interface SpecAccumulator extends Tally {
  firstStageIntentMs: number | null;
  terminalMs: number | null;
}

interface RunAccumulator extends Tally {
  quotaParks: number;
  parkedSumMs: number;
  openParks: number;
  firstStageIntentMs: number | null;
  terminalMs: number | null;
}

function parkedMsOf(acc: { quotaParks: number; parkedSumMs: number; openParks: number }): number | null {
  if (acc.openParks > 0) return null;
  return acc.parkedSumMs;
}

function wallClockOf(acc: { firstStageIntentMs: number | null; terminalMs: number | null }): number | null {
  if (acc.firstStageIntentMs === null || acc.terminalMs === null) return null;
  return acc.terminalMs - acc.firstStageIntentMs;
}

// --- the fold (B-1) ----------------------------------------------------------

// Session records carry no specId at all (spec 014 journals them from inside
// the driver), so attribution replays the journal in order and credits each
// `session.result` to whichever SpecExec was most recently created, exactly
// like historyView attributes stage records: exact under the serial loop
// spec 021 B-3 guarantees (one spec walked at a time, a retry minting a
// fresh SpecExec before its stages run). A session with no SpecExec before
// it in the journal belongs to no spec and no run; it still counts in the
// totals, which cover the whole history (D-2).
export function economicsView(records: readonly EconomicsRecordLike[], project: string): EconomicsView {
  if (records.length === 0) return { project, specs: [], runs: [], totals: null };

  const state = foldOrchestratorState(records);

  const specExecMeta = new Map<string, { readonly specId: string; readonly runId: string }>();
  for (const specExec of state.specExecs.values()) {
    specExecMeta.set(specExec.id, { specId: specExec.specId, runId: specExec.runId });
  }
  const stageExecToSpecExec = new Map<string, string>();
  for (const stageExec of state.stageExecs.values()) {
    stageExecToSpecExec.set(stageExec.id, stageExec.specExecId);
  }

  // Insertion order is creation order for every entity map the state fold
  // returns, so seeding rows from them keeps specs and runs in the order the
  // journal first saw them.
  const specAccs = new Map<string, SpecAccumulator>();
  for (const specExec of state.specExecs.values()) {
    if (!specAccs.has(specExec.specId)) {
      specAccs.set(specExec.specId, { ...freshTally(), firstStageIntentMs: null, terminalMs: null });
    }
  }
  const runAccs = new Map<string, RunAccumulator>();
  for (const run of state.runs.values()) {
    runAccs.set(run.id, {
      ...freshTally(),
      quotaParks: 0,
      parkedSumMs: 0,
      openParks: 0,
      firstStageIntentMs: null,
      terminalMs: null,
    });
  }
  const totals: RunAccumulator = {
    ...freshTally(),
    quotaParks: 0,
    parkedSumMs: 0,
    openParks: 0,
    firstStageIntentMs: null,
    terminalMs: null,
  };

  // Remediation rounds and hook blocks are already exact in the folded
  // entities: a retry mints a fresh StageExec at attempt+1 (spec 013 B-4)
  // and "blocked" is a sink the daemon transitions into exactly on a
  // hook-blocked or refused stage outcome, so neither needs the replay.
  const stageTargets = (specExecId: string): { spec: SpecAccumulator | null; run: RunAccumulator | null } => {
    const meta = specExecMeta.get(specExecId);
    if (meta === undefined) return { spec: null, run: null };
    return { spec: specAccs.get(meta.specId) ?? null, run: runAccs.get(meta.runId) ?? null };
  };
  for (const stageExec of state.stageExecs.values()) {
    const { spec, run } = stageTargets(stageExec.specExecId);
    if (stageExec.attempt > 1) {
      if (spec) spec.remediationRounds++;
      if (run) run.remediationRounds++;
      totals.remediationRounds++;
    }
    if (stageExec.status === "blocked") {
      if (spec) spec.hookBlockedStages++;
      if (run) run.hookBlockedStages++;
      totals.hookBlockedStages++;
    }
  }

  // The replay: session attribution, park windows, and the two wall-clock
  // anchors, all of which depend on where in the journal a record sits.
  let currentSpecExec: { readonly specId: string; readonly runId: string } | null = null;
  let currentRunId: string | null = null;
  let openPark: { readonly run: RunAccumulator | null; readonly startMs: number | null } | null = null;

  const abandonOpenPark = (): void => {
    if (openPark === null) return;
    if (openPark.run) openPark.run.openParks++;
    totals.openParks++;
    openPark = null;
  };

  for (const record of records) {
    switch (record.kind) {
      case "run.created": {
        currentRunId = stringField(record.payload, "id");
        break;
      }
      case "specexec.created": {
        const id = stringField(record.payload, "id");
        currentSpecExec = id === null ? null : (specExecMeta.get(id) ?? null);
        break;
      }
      case "session.result": {
        const kind = stringField(record.payload, "classification");
        const cost = numberField(record.payload, "costMicroUsd");
        tallySession(totals, kind, cost);
        if (currentSpecExec !== null) {
          const spec = specAccs.get(currentSpecExec.specId);
          if (spec) tallySession(spec, kind, cost);
          const run = runAccs.get(currentSpecExec.runId);
          if (run) tallySession(run, kind, cost);
        }
        break;
      }
      case "quota.parked": {
        // A second park while one is still open means the first window never
        // closed (a daemon died parked and a later run parked again): the
        // first stays unknowable rather than silently zero-length.
        abandonOpenPark();
        const run = currentRunId === null ? null : (runAccs.get(currentRunId) ?? null);
        if (run) run.quotaParks++;
        totals.quotaParks++;
        openPark = { run, startMs: parseTsMs(record.ts) };
        break;
      }
      case "quota.resumed": {
        if (openPark === null) break;
        const resumedAtMs = numberField(record.payload, "resumedAtMs") ?? parseTsMs(record.ts);
        if (openPark.startMs === null || resumedAtMs === null) {
          // The window happened but its span cannot be computed: unknown,
          // not zero.
          abandonOpenPark();
          break;
        }
        const parkedMs = Math.max(0, resumedAtMs - openPark.startMs);
        if (openPark.run) openPark.run.parkedSumMs += parkedMs;
        totals.parkedSumMs += parkedMs;
        openPark = null;
        break;
      }
      case "state.transition.intent": {
        if (stringField(record.payload, "entity") !== "stageExec") break;
        const stageExecId = stringField(record.payload, "id");
        const specExecId = stageExecId === null ? undefined : stageExecToSpecExec.get(stageExecId);
        if (specExecId === undefined) break;
        const ms = parseTsMs(record.ts);
        if (ms === null) break;
        const { spec, run } = stageTargets(specExecId);
        if (spec && spec.firstStageIntentMs === null) spec.firstStageIntentMs = ms;
        if (run && run.firstStageIntentMs === null) run.firstStageIntentMs = ms;
        break;
      }
      case "state.transition.outcome": {
        const entity = stringField(record.payload, "entity");
        const to = stringField(record.payload, "to");
        const id = stringField(record.payload, "id");
        if (id === null) break;
        if (entity === "specExec" && (to === "shipped" || to === "failed")) {
          const meta = specExecMeta.get(id);
          const spec = meta === undefined ? undefined : specAccs.get(meta.specId);
          // Last wins: a re-verified spec's wall-clock runs to its latest
          // terminal transition, remediation included.
          if (spec) spec.terminalMs = parseTsMs(record.ts);
        } else if (entity === "run" && (to === "completed" || to === "failed")) {
          const run = runAccs.get(id);
          if (run) run.terminalMs = parseTsMs(record.ts);
        }
        break;
      }
      default:
        break;
    }
  }
  abandonOpenPark();

  const specs: SpecEconomics[] = [];
  for (const [specId, acc] of specAccs) {
    specs.push({
      specId,
      sessions: acc.sessions,
      sessionsByTermination: acc.byTermination,
      remediationRounds: acc.remediationRounds,
      hookBlockedStages: acc.hookBlockedStages,
      costMicroUsd: costOf(acc),
      costUnknownSessions: acc.costUnknownSessions,
      wallClockMs: wallClockOf(acc),
    });
  }

  const runs: RunEconomics[] = [];
  for (const [runId, acc] of runAccs) {
    runs.push({
      runId,
      status: state.runs.get(runId)!.status,
      sessions: acc.sessions,
      sessionsByTermination: acc.byTermination,
      remediationRounds: acc.remediationRounds,
      hookBlockedStages: acc.hookBlockedStages,
      costMicroUsd: costOf(acc),
      costUnknownSessions: acc.costUnknownSessions,
      quotaParks: acc.quotaParks,
      parkedMs: parkedMsOf(acc),
      wallClockMs: wallClockOf(acc),
    });
  }

  return {
    project,
    specs,
    runs,
    totals: {
      sessions: totals.sessions,
      sessionsByTermination: totals.byTermination,
      remediationRounds: totals.remediationRounds,
      hookBlockedStages: totals.hookBlockedStages,
      costMicroUsd: costOf(totals),
      costUnknownSessions: totals.costUnknownSessions,
      quotaParks: totals.quotaParks,
      parkedMs: parkedMsOf(totals),
    },
  };
}
