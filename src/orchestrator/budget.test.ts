// Spec 033's colocated tests. The module under test is pure over (records,
// ceiling, now) by construction, so almost everything here is a table of
// journal records and an assertion about what enforcement concludes from
// them; only the journal-integration block touches a real chain.
//
// The cases FR-001 names verbatim are the spine: no ceiling, under, exactly
// at, over per-run, over per-day, unknown-cost sessions counted but excluded
// from the sums, and the UTC day boundary in both directions.
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, type JournalHandle } from "./journal";
import {
  BUDGET_KINDS,
  OVERSHOOT_BOUND_SESSIONS,
  ceilingOf,
  ceilingPayload,
  ceilingRefusal,
  evaluateBudget,
  foldBudgetState,
  journalBudgetPark,
  journalBudgetPause,
  journalBudgetResume,
  nextUtcMidnightMs,
  parseCeiling,
  planBudgetStop,
  projectBudgetView,
  renderBudget,
  renderBudgetStop,
  renderCeiling,
  renderSpendFloor,
  resolveCeilingSource,
  unreadableBudgetView,
  utcDayKey,
  type BudgetRecordLike,
  type CostCeiling,
} from "./budget";

// One dollar, in the journal's own unit. Every limit below is written as a
// multiple of this so an assertion reads as money rather than as a power of
// ten someone has to count the zeros of.
const USD = 1_000_000;

const DAY = "2026-08-05";
const NOON = Date.UTC(2026, 7, 5, 12, 0, 0);

function ts(iso: string): string {
  return iso;
}

function runCreated(id: string, at: string): BudgetRecordLike {
  return { ts: ts(at), kind: "run.created", payload: { id } };
}

function specExecCreated(id: string, runId: string, at: string): BudgetRecordLike {
  return { ts: ts(at), kind: "specexec.created", payload: { id, runId } };
}

// A journaled session result, with its cost or with the honest absence of one.
// Spec 014 journals no `specId` here, which is exactly why attribution runs
// through the most recent specexec (030 D-2).
function sessionResult(costMicroUsd: number | null, at: string): BudgetRecordLike {
  return {
    ts: ts(at),
    kind: "session.result",
    payload: { costMicroUsd, terminationKind: "clean" },
  };
}

// A run of one spec whose sessions all landed today, which is the shape every
// evaluation case below varies from.
function todaysRun(costs: readonly (number | null)[]): BudgetRecordLike[] {
  const records: BudgetRecordLike[] = [
    runCreated("run-1", "2026-08-05T09:00:00.000Z"),
    specExecCreated("exec-1", "run-1", "2026-08-05T09:01:00.000Z"),
  ];
  costs.forEach((cost, i) => {
    records.push(sessionResult(cost, `2026-08-05T10:${String(i).padStart(2, "0")}:00.000Z`));
  });
  return records;
}

function evaluate(records: readonly BudgetRecordLike[], ceiling: CostCeiling | null, nowMs = NOON) {
  return evaluateBudget({ records, ceiling, nowMs });
}

// --- the model and its codec (B-1) ------------------------------------------

test("ceilingOf: a ceiling carrying neither limit is no ceiling at all", () => {
  expect(ceilingOf({})).toBeNull();
  expect(ceilingOf({ perRunMicroUsd: 5 * USD })).toEqual({ perRunMicroUsd: 5 * USD });
  expect(ceilingOf({ perDayMicroUsd: 0 })).toEqual({ perDayMicroUsd: 0 });
});

test("ceilingPayload/parseCeiling: a cleared ceiling round-trips as explicit nulls, not as an absence", () => {
  expect(ceilingPayload(null)).toEqual({ perRunMicroUsd: null, perDayMicroUsd: null });
  expect(parseCeiling(ceilingPayload(null), "test")).toBeNull();

  const both: CostCeiling = { perRunMicroUsd: 5 * USD, perDayMicroUsd: 20 * USD };
  expect(parseCeiling(ceilingPayload(both), "test")).toEqual(both);

  const runOnly: CostCeiling = { perRunMicroUsd: 5 * USD };
  const parsed = parseCeiling(ceilingPayload(runOnly), "test");
  expect(parsed).toEqual(runOnly);
  expect(parsed && "perDayMicroUsd" in parsed).toBe(false);
});

test("parseCeiling: a malformed limit throws rather than degrading to no ceiling", () => {
  expect(() => parseCeiling({ perRunMicroUsd: "5" }, "record")).toThrow(/perRunMicroUsd/);
  expect(() => parseCeiling("nope", "record")).toThrow(/JSON object/);
  expect(() => parseCeiling([1, 2], "record")).toThrow(/JSON object/);
});

test("ceilingRefusal: micro-USD is a whole non-negative count, and a null ceiling is always recordable", () => {
  expect(ceilingRefusal(null)).toBeNull();
  expect(ceilingRefusal({ perRunMicroUsd: 0 })).toBeNull();
  expect(ceilingRefusal({ perRunMicroUsd: 1.5 })).toMatch(/whole number/);
  expect(ceilingRefusal({ perDayMicroUsd: -1 })).toMatch(/cannot be negative/);
});

// --- the UTC calendar day (D-3) ---------------------------------------------

test("utcDayKey/nextUtcMidnightMs: the horizon is the next 00:00 UTC strictly after now", () => {
  expect(utcDayKey(Date.UTC(2026, 7, 5, 23, 59, 59, 999))).toBe("2026-08-05");
  expect(nextUtcMidnightMs(NOON)).toBe(Date.UTC(2026, 7, 6));
  // Exactly at midnight the next horizon is the following one, never zero
  // seconds away: a park that resumed instantly would spawn the session the
  // ceiling just stopped.
  expect(nextUtcMidnightMs(Date.UTC(2026, 7, 5))).toBe(Date.UTC(2026, 7, 6));
  // Month and year rollover come from Date.UTC's own normalization.
  expect(nextUtcMidnightMs(Date.UTC(2026, 11, 31, 18))).toBe(Date.UTC(2027, 0, 1));
});

// --- FR-001: spend evaluation ------------------------------------------------

test("FR-001: no ceiling is over nothing, and the floors are still summed", () => {
  const result = evaluate(todaysRun([3 * USD, 4 * USD]), null);
  expect(result.ceiling).toBeNull();
  expect(result.over).toBeNull();
  expect(result.warnPorousFloor).toBe(false);
  expect(result.spend.run.knownMicroUsd).toBe(7 * USD);
  expect(result.spend.day.knownMicroUsd).toBe(7 * USD);
  expect(result.spend.runId).toBe("run-1");
  expect(result.spend.utcDay).toBe(DAY);
});

test("FR-001: under both limits crosses nothing", () => {
  const result = evaluate(todaysRun([3 * USD]), { perRunMicroUsd: 5 * USD, perDayMicroUsd: 20 * USD });
  expect(result.over).toBeNull();
  expect(planBudgetStop(result, NOON)).toBeNull();
});

test("FR-001: exactly at a limit is not over it; driving stops strictly above", () => {
  const ceiling: CostCeiling = { perRunMicroUsd: 5 * USD, perDayMicroUsd: 5 * USD };
  const at = evaluate(todaysRun([2 * USD, 3 * USD]), ceiling);
  expect(at.spend.run.knownMicroUsd).toBe(5 * USD);
  expect(at.over).toBeNull();

  // One micro-dollar past the line is over it.
  const over = evaluate(todaysRun([2 * USD, 3 * USD, 1]), ceiling);
  expect(over.over).toBe("run");
});

test("FR-001: over the per-run limit names the run scope", () => {
  const result = evaluate(todaysRun([4 * USD, 4 * USD]), { perRunMicroUsd: 5 * USD });
  expect(result.over).toBe("run");
  expect(result.spend.run.knownMicroUsd).toBe(8 * USD);
  expect(result.spend.run.costKnownSessions).toBe(2);
});

test("FR-001: over the per-day limit names the day scope, summing across runs and specs", () => {
  const records: BudgetRecordLike[] = [
    runCreated("run-1", "2026-08-05T08:00:00.000Z"),
    specExecCreated("exec-1", "run-1", "2026-08-05T08:01:00.000Z"),
    sessionResult(6 * USD, "2026-08-05T08:30:00.000Z"),
    // A second run of the same project, on the same UTC day.
    runCreated("run-2", "2026-08-05T09:00:00.000Z"),
    specExecCreated("exec-2", "run-2", "2026-08-05T09:01:00.000Z"),
    sessionResult(6 * USD, "2026-08-05T09:30:00.000Z"),
  ];
  const result = evaluate(records, { perRunMicroUsd: 100 * USD, perDayMicroUsd: 10 * USD });
  // The current run has spent only its own 6; the day has spent both runs' 12.
  expect(result.spend.runId).toBe("run-2");
  expect(result.spend.run.knownMicroUsd).toBe(6 * USD);
  expect(result.spend.day.knownMicroUsd).toBe(12 * USD);
  expect(result.over).toBe("day");
});

test("FR-001: unknown-cost sessions are counted and excluded from the sums (B-5, D-1)", () => {
  const result = evaluate(todaysRun([3 * USD, null, null]), { perRunMicroUsd: 5 * USD });
  expect(result.spend.run.knownMicroUsd).toBe(3 * USD);
  expect(result.spend.run.costKnownSessions).toBe(1);
  expect(result.spend.run.costUnknownSessions).toBe(2);
  // The floor is 3, not an estimate of what the two unknown sessions cost, so
  // a 5 ceiling is not crossed however expensive they really were.
  expect(result.over).toBeNull();
  // But the operator is told the ceiling is enforcing less than it appears to.
  expect(result.warnPorousFloor).toBe(true);
});

test("FR-001: the porous-floor warning tracks only the scopes the ceiling enforces over", () => {
  const records = todaysRun([3 * USD, null]);
  // Unknowns sit in both scopes here, but only a day limit is set, so the
  // warning is about the day floor. A project with no ceiling at all is
  // economics' business, not enforcement's.
  expect(evaluate(records, { perDayMicroUsd: 50 * USD }).warnPorousFloor).toBe(true);
  expect(evaluate(records, null).warnPorousFloor).toBe(false);

  // An unknown outside every enforced scope leaves the floor solid: this
  // session belongs to yesterday and to no run, and only a per-run limit is
  // set.
  const yesterdaysUnknown: BudgetRecordLike[] = [
    sessionResult(null, "2026-08-04T10:00:00.000Z"),
    ...todaysRun([1 * USD]),
  ];
  expect(evaluate(yesterdaysUnknown, { perRunMicroUsd: 5 * USD }).warnPorousFloor).toBe(false);
});

test("FR-001: the UTC day boundary, both directions (D-3)", () => {
  const records: BudgetRecordLike[] = [
    runCreated("run-1", "2026-08-04T23:00:00.000Z"),
    specExecCreated("exec-1", "run-1", "2026-08-04T23:30:00.000Z"),
    // 23:59 belongs to its own day, which is yesterday relative to `now`.
    sessionResult(9 * USD, "2026-08-04T23:59:00.000Z"),
    // 00:01 belongs to the next day, which is today.
    sessionResult(2 * USD, "2026-08-05T00:01:00.000Z"),
  ];
  const result = evaluate(records, { perDayMicroUsd: 5 * USD });
  expect(result.spend.utcDay).toBe(DAY);
  expect(result.spend.day.knownMicroUsd).toBe(2 * USD);
  expect(result.spend.day.costKnownSessions).toBe(1);
  // The run spans both days, so its own floor carries all of it.
  expect(result.spend.run.knownMicroUsd).toBe(11 * USD);
  expect(result.over).toBeNull();

  // Evaluated one day earlier, the same records put the 9 in today's window
  // and cross the same limit.
  const yesterday = evaluate(records, { perDayMicroUsd: 5 * USD }, Date.UTC(2026, 7, 4, 23, 59, 59, 999));
  expect(yesterday.spend.utcDay).toBe("2026-08-04");
  expect(yesterday.spend.day.knownMicroUsd).toBe(9 * USD);
  expect(yesterday.over).toBe("day");
});

test("FR-001: a session journaled with an unparseable timestamp lands in no day at all", () => {
  const records: BudgetRecordLike[] = [
    ...todaysRun([1 * USD]),
    { ts: "not-a-timestamp", kind: "session.result", payload: { costMicroUsd: 50 * USD } },
  ];
  const result = evaluate(records, { perDayMicroUsd: 10 * USD });
  expect(result.spend.day.knownMicroUsd).toBe(1 * USD);
  expect(result.over).toBeNull();
  // It still belongs to the run it was journaled inside.
  expect(result.spend.run.knownMicroUsd).toBe(51 * USD);
});

test("FR-001: a session before any specexec belongs to no run, but still to its day (030 D-2)", () => {
  const records: BudgetRecordLike[] = [
    sessionResult(8 * USD, "2026-08-05T07:00:00.000Z"),
    ...todaysRun([1 * USD]),
  ];
  const result = evaluate(records, { perRunMicroUsd: 5 * USD, perDayMicroUsd: 20 * USD });
  expect(result.spend.run.knownMicroUsd).toBe(1 * USD);
  expect(result.spend.day.knownMicroUsd).toBe(9 * USD);
  expect(result.over).toBeNull();
});

test("FR-001: an explicit runId evaluates that run rather than the newest one", () => {
  const records: BudgetRecordLike[] = [
    runCreated("run-1", "2026-08-05T08:00:00.000Z"),
    specExecCreated("exec-1", "run-1", "2026-08-05T08:01:00.000Z"),
    sessionResult(7 * USD, "2026-08-05T08:30:00.000Z"),
    runCreated("run-2", "2026-08-05T09:00:00.000Z"),
    specExecCreated("exec-2", "run-2", "2026-08-05T09:01:00.000Z"),
    sessionResult(1 * USD, "2026-08-05T09:30:00.000Z"),
  ];
  const scoped = evaluateBudget({ records, ceiling: { perRunMicroUsd: 5 * USD }, nowMs: NOON, runId: "run-1" });
  expect(scoped.spend.runId).toBe("run-1");
  expect(scoped.spend.run.knownMicroUsd).toBe(7 * USD);
  expect(scoped.over).toBe("run");
});

test("FR-001: an empty journal has no run and spends nothing", () => {
  const result = evaluate([], { perRunMicroUsd: 5 * USD, perDayMicroUsd: 5 * USD });
  expect(result.spend.runId).toBeNull();
  expect(result.spend.run.knownMicroUsd).toBe(0);
  expect(result.spend.day.knownMicroUsd).toBe(0);
  expect(result.over).toBeNull();
});

test("FR-001: the per-run limit outranks the per-day one when both are crossed", () => {
  const result = evaluate(todaysRun([50 * USD]), { perRunMicroUsd: 5 * USD, perDayMicroUsd: 10 * USD });
  expect(result.over).toBe("run");
});

// --- FR-002: park and pause planning ----------------------------------------

test("FR-002: a per-day trip plans a park to next UTC midnight, carrying the floor and its unknowns", () => {
  const evaluation = evaluate(todaysRun([12 * USD, null]), { perDayMicroUsd: 10 * USD });
  const plan = planBudgetStop(evaluation, NOON);
  expect(plan).not.toBeNull();
  expect(plan!.reason).toBe("budget-day");
  expect(plan!.scope).toBe("day");
  expect(plan!.targetMs).toBe(Date.UTC(2026, 7, 6));
  expect(plan!.needsHuman).toBe(false);
  expect(plan!.limitMicroUsd).toBe(10 * USD);
  expect(plan!.floorMicroUsd).toBe(12 * USD);
  expect(plan!.costKnownSessions).toBe(1);
  expect(plan!.costUnknownSessions).toBe(1);
  expect(plan!.overshootBoundSessions).toBe(OVERSHOOT_BOUND_SESSIONS);
});

test("FR-002: a per-run trip plans a needsHuman pause with no clock target (B-4)", () => {
  const evaluation = evaluate(todaysRun([9 * USD]), { perRunMicroUsd: 5 * USD });
  const plan = planBudgetStop(evaluation, NOON);
  expect(plan).not.toBeNull();
  expect(plan!.reason).toBe("budget-run");
  expect(plan!.scope).toBe("run");
  // No clock makes a run cheaper, so there is no horizon to state.
  expect(plan!.targetMs).toBeNull();
  expect(plan!.needsHuman).toBe(true);
  expect(plan!.limitMicroUsd).toBe(5 * USD);
  expect(plan!.floorMicroUsd).toBe(9 * USD);
  expect(plan!.overshootBoundSessions).toBe(OVERSHOOT_BOUND_SESSIONS);
});

test("FR-002: nothing crossed plans nothing", () => {
  expect(planBudgetStop(evaluate(todaysRun([1 * USD]), { perRunMicroUsd: 5 * USD }), NOON)).toBeNull();
  expect(planBudgetStop(evaluate(todaysRun([1 * USD]), null), NOON)).toBeNull();
});

// --- journal integration (B-3, B-4, FR-002) ---------------------------------

function freshJournal(prefix: string): JournalHandle {
  return openJournal(mkdtempSync(join(tmpdir(), `budget-test-${prefix}-`)));
}

test("FR-002: the journaled park record carries the whole trip, bound included", () => {
  const journal = freshJournal("park");
  try {
    const evaluation = evaluate(todaysRun([12 * USD, null]), { perDayMicroUsd: 10 * USD });
    const plan = planBudgetStop(evaluation, NOON)!;
    const record = journalBudgetPark(journal, plan);
    expect(record.kind).toBe(BUDGET_KINDS.parked);
    expect(record.payload).toEqual({
      reason: "budget-day",
      scope: "day",
      limitMicroUsd: 10 * USD,
      floorMicroUsd: 12 * USD,
      costKnownSessions: 1,
      costUnknownSessions: 1,
      overshootBoundSessions: 1,
      targetMs: Date.UTC(2026, 7, 6),
    });

    // The fold reads its own record back: a park is the open stop until a
    // resume closes it, and remains the last park either way (FR-003's
    // restart recovery reads the target from here).
    const parked = foldBudgetState(journal.fold().records);
    expect(parked.stop?.reason).toBe("budget-day");
    expect(parked.stop?.targetMs).toBe(Date.UTC(2026, 7, 6));
    expect(parked.lastPark?.targetMs).toBe(Date.UTC(2026, 7, 6));

    journalBudgetResume(journal, NOON + 1000);
    const resumed = foldBudgetState(journal.fold().records);
    expect(resumed.stop).toBeNull();
    expect(resumed.lastPark?.targetMs).toBe(Date.UTC(2026, 7, 6));
  } finally {
    journal.close();
  }
});

test("FR-002: the journaled pause record carries needsHuman and no target", () => {
  const journal = freshJournal("pause");
  try {
    const evaluation = evaluate(todaysRun([9 * USD]), { perRunMicroUsd: 5 * USD });
    const plan = planBudgetStop(evaluation, NOON)!;
    const record = journalBudgetPause(journal, plan);
    expect(record.kind).toBe(BUDGET_KINDS.paused);

    const folded = foldBudgetState(journal.fold().records);
    expect(folded.stop?.reason).toBe("budget-run");
    expect(folded.stop?.needsHuman).toBe(true);
    expect(folded.stop?.targetMs).toBeNull();
    expect(folded.stop?.floorMicroUsd).toBe(9 * USD);
    expect(folded.stop?.costUnknownSessions).toBe(0);
    // A pause is not a park: nothing here gives a restart a countdown to
    // resume, which is exactly B-4's point.
    expect(folded.lastPark).toBeNull();
  } finally {
    journal.close();
  }
});

test("foldBudgetState: a run transitioned back to running closes an open budget stop", () => {
  const records: BudgetRecordLike[] = [
    {
      ts: "2026-08-05T10:00:00.000Z",
      kind: BUDGET_KINDS.paused,
      payload: {
        reason: "budget-run",
        scope: "run",
        limitMicroUsd: 5 * USD,
        floorMicroUsd: 9 * USD,
        costKnownSessions: 1,
        costUnknownSessions: 0,
        overshootBoundSessions: 1,
        targetMs: null,
      },
    },
    {
      ts: "2026-08-05T11:00:00.000Z",
      kind: "state.transition.outcome",
      payload: { entity: "run", to: "running" },
    },
  ];
  expect(foldBudgetState(records).stop).toBeNull();

  // A stage transitioning to running is not the run doing so, and leaves the
  // stop standing.
  const stageOnly: BudgetRecordLike[] = [
    records[0]!,
    { ts: "2026-08-05T11:00:00.000Z", kind: "state.transition.outcome", payload: { entity: "stageExec", to: "running" } },
  ];
  expect(stageOnly.length).toBe(2);
  expect(foldBudgetState(stageOnly).stop?.reason).toBe("budget-run");
});

test("foldBudgetState: a malformed stop record throws rather than folding to no stop", () => {
  const records: BudgetRecordLike[] = [
    { ts: "2026-08-05T10:00:00.000Z", kind: BUDGET_KINDS.parked, payload: { reason: "quota" } },
  ];
  expect(() => foldBudgetState(records)).toThrow(/budget-day/);
});

// --- the ceiling seam (B-2) -------------------------------------------------

test("resolveCeilingSource: a value, a reader, and absence each answer honestly", () => {
  const ceiling: CostCeiling = { perDayMicroUsd: 20 * USD };
  expect(resolveCeilingSource(undefined)).toBeNull();
  expect(resolveCeilingSource(null)).toBeNull();
  expect(resolveCeilingSource(ceiling)).toEqual(ceiling);

  // The reader is called at resolve time, which is what lets an operator's
  // raised ceiling reach the next spawn boundary rather than the next daemon.
  let current: CostCeiling | null = null;
  const source = () => current;
  expect(resolveCeilingSource(source)).toBeNull();
  current = ceiling;
  expect(resolveCeilingSource(source)).toEqual(ceiling);
});

// --- the served view and its renderings (B-5, B-7, FR-004) ------------------

test("projectBudgetView: assembles the ceiling, both floors, and any open stop", () => {
  const records = todaysRun([12 * USD, null]);
  const view = projectBudgetView(records, { perDayMicroUsd: 10 * USD }, NOON);
  expect(view.ceiling).toEqual({ perDayMicroUsd: 10 * USD });
  expect(view.runId).toBe("run-1");
  expect(view.utcDay).toBe(DAY);
  expect(view.day.knownMicroUsd).toBe(12 * USD);
  expect(view.day.costUnknownSessions).toBe(1);
  expect(view.over).toBe("day");
  expect(view.warnPorousFloor).toBe(true);
  expect(view.stop).toBeNull(); // nothing journaled a trip yet
  expect(view.spendError).toBeNull();
});

test("unreadableBudgetView: the ceiling survives an unreadable state root; the spend says unknown", () => {
  const view = unreadableBudgetView({ perRunMicroUsd: 5 * USD }, NOON, "no such directory");
  expect(view.ceiling).toEqual({ perRunMicroUsd: 5 * USD });
  expect(view.spendError).toBe("no such directory");
  expect(view.run.knownMicroUsd).toBe(0);
  expect(view.over).toBeNull();
  expect(view.warnPorousFloor).toBe(false);
  const lines = renderBudget(view);
  expect(lines[0]).toBe("ceiling: run $5.0000");
  expect(lines.join("\n")).toContain("spend unknown: no such directory");
});

test("FR-004: a project without a ceiling renders 'no ceiling', never a blank or a zero", () => {
  expect(renderCeiling(null)).toBe("no ceiling");
  expect(renderCeiling({ perRunMicroUsd: 5 * USD })).toBe("run $5.0000");
  expect(renderCeiling({ perDayMicroUsd: 20 * USD })).toBe("day $20.0000");
  expect(renderCeiling({ perRunMicroUsd: 5 * USD, perDayMicroUsd: 20 * USD })).toBe("run $5.0000, day $20.0000");
});

test("FR-004: a floor with unknowns beside it renders as 'at least X, N sessions unknown' (B-5)", () => {
  expect(renderSpendFloor({ knownMicroUsd: 3 * USD, costKnownSessions: 2, costUnknownSessions: 0 })).toBe("$3.0000");
  expect(renderSpendFloor({ knownMicroUsd: 3 * USD, costKnownSessions: 2, costUnknownSessions: 1 })).toBe(
    "at least $3.0000, 1 session unknown"
  );
  expect(renderSpendFloor({ knownMicroUsd: 0, costKnownSessions: 0, costUnknownSessions: 3 })).toBe(
    "at least $0.0000, 3 sessions unknown"
  );
});

test("FR-004: a tripped ceiling names itself, and says whether a clock or a human releases it", () => {
  expect(renderBudgetStop(null)).toBe("");
  expect(
    renderBudgetStop({
      reason: "budget-day",
      scope: "day",
      limitMicroUsd: 10 * USD,
      floorMicroUsd: 12 * USD,
      costUnknownSessions: 0,
      targetMs: Date.UTC(2026, 7, 6),
      needsHuman: false,
    })
  ).toBe("budget-day: at least $12.0000 over $10.0000, until 2026-08-06T00:00:00.000Z");
  expect(
    renderBudgetStop({
      reason: "budget-run",
      scope: "run",
      limitMicroUsd: 5 * USD,
      floorMicroUsd: 9 * USD,
      costUnknownSessions: 2,
      targetMs: null,
      needsHuman: true,
    })
  ).toBe("budget-run: at least $9.0000 over $5.0000, needs a human");
});

test("FR-004: the whole budget block names both floors, and warns when the floor is porous", () => {
  const withCeiling = renderBudget(projectBudgetView(todaysRun([12 * USD, null]), { perDayMicroUsd: 10 * USD }, NOON));
  expect(withCeiling[0]).toBe("ceiling: day $10.0000");
  const text = withCeiling.join("\n");
  expect(text).toContain("run run-1: at least $12.0000, 1 session unknown");
  expect(text).toContain(`day ${DAY}: at least $12.0000, 1 session unknown`);
  // No trip is journaled yet, so the block says what the next boundary will do
  // rather than claiming the run is already stopped.
  expect(text).toContain("over the day ceiling; the next spawn boundary stops this run");
  expect(text).toContain("enforces less than it appears to");

  // The no-ceiling case still reports spend, and never warns about a floor no
  // limit is standing on.
  const without = renderBudget(projectBudgetView(todaysRun([1 * USD, null]), null, NOON));
  expect(without[0]).toBe("ceiling: no ceiling");
  expect(without.join("\n")).not.toContain("enforces less than it appears to");
  expect(without.join("\n")).toContain("at least $1.0000, 1 session unknown");
});
