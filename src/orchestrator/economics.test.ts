// Spec 030's tests, all three FRs in one file because economics.test.ts is
// the spec's own establishing unit: FR-001 exercises the pure fold against
// fixture journals built with the API fixture world's real chains and state
// machine; FR-002 exercises the served route against an in-process v2
// server; FR-003 drives the CLI verb against that same server. Every
// scenario FR-001 names appears: a spec with one clean session, a spec with
// a remediation round, a hook-blocked stage, a quota park, and sessions with
// and without reported cost.
import { expect, test } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { JournalRecord, JsonValue } from "./journal";
import { createRun, createSpecExec, createStageExec, transition } from "./state";
import { journalPark, journalResume } from "./quota";
import { ECONOMICS_ROUTE, TERMINATION_KINDS, economicsView } from "./economics";
import { createApiServer } from "./api/server";
import { fixtureApiDeps, freshRegistry, freshWorld, type FixtureWorld } from "./api/fixtures";
import { servedEconomicsView } from "./api/state";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  runOrchestratorCli,
} from "../commands/orchestrator";

// --- seeding helpers ---------------------------------------------------------

// The payload shape session.ts journals at session end (its resultPayload),
// with the fields this fold reads varied per call and the rest held at
// honest fixture values.
function sessionResult(world: FixtureWorld, classification: string, costMicroUsd: number | null): void {
  world.journal.append("session.result", {
    classification,
    resetAtMs: null,
    detail: "fixture",
    exitCode: 0,
    durationMs: 1000,
    numTurns: 3,
    costMicroUsd,
    usage: null,
    sessionId: "fixture-session",
    transcriptPath: null,
    overflowLineCount: 0,
    overflowTruncatedCount: 0,
    stderrTail: "",
    resultTextTail: null,
  });
}

interface EconomicsSeed {
  readonly runId: string;
  readonly betaExecId: string;
  readonly gammaExecId: string;
  readonly betaFirstStageId: string;
  readonly parkedMs: number;
}

// The FR-001 world: 002-beta ships after a remediation round (build attempt
// 1 fails with its session cost unreported, attempt 2 passes with cost
// reported), a quota park opens and closes between the two specs, and
// 003-gamma hits a hook-blocked build stage. The run completes so its
// wall-clock has both ends.
function seedEconomics(world: FixtureWorld): EconomicsSeed {
  const { journal } = world;
  let run = transition(journal, createRun(journal, world.repoDir), "running");

  let beta = createSpecExec(journal, run.id, "002-beta", world.dagReader.pin("002-beta"));
  beta = transition(journal, beta, "building");
  const betaStage1 = createStageExec(journal, beta.id, "build", 1);
  const betaStage1Running = transition(journal, betaStage1, "running");
  sessionResult(world, "completed", null);
  transition(journal, betaStage1Running, "failed");
  const betaStage2 = createStageExec(journal, beta.id, "build", 2);
  const betaStage2Running = transition(journal, betaStage2, "running");
  sessionResult(world, "completed", 2_000_000);
  transition(journal, betaStage2Running, "passed");
  beta = transition(journal, beta, "shipping");
  beta = transition(journal, beta, "shepherding");
  beta = transition(journal, beta, "verifying");
  beta = transition(journal, beta, "shipped");

  journalPark(journal, { targetMs: 1_700_000_000_000, estimated: true, consecutiveQuotaParks: 1 });
  const parkStartMs = Date.parse(journal.fold().records.at(-1)!.ts);
  const parkedMs = 60_000;
  journalResume(journal, parkStartMs + parkedMs);

  let gamma = createSpecExec(journal, run.id, "003-gamma", world.dagReader.pin("003-gamma"));
  gamma = transition(journal, gamma, "building");
  const gammaStage = createStageExec(journal, gamma.id, "build", 1);
  const gammaRunning = transition(journal, gammaStage, "running");
  sessionResult(world, "hook-blocked", 50_000);
  transition(journal, gammaRunning, "blocked");

  run = transition(journal, run, "completed");

  return {
    runId: run.id,
    betaExecId: beta.id,
    gammaExecId: gamma.id,
    betaFirstStageId: betaStage1.id,
    parkedMs,
  };
}

function payloadOf(record: JournalRecord): Record<string, JsonValue> {
  return record.payload as Record<string, JsonValue>;
}

function firstStageIntentMs(records: readonly JournalRecord[], stageIds: ReadonlySet<string>): number {
  const record = records.find(
    (r) =>
      r.kind === "state.transition.intent" &&
      payloadOf(r).entity === "stageExec" &&
      stageIds.has(payloadOf(r).id as string)
  );
  if (!record) throw new Error("no stage intent found");
  return Date.parse(record.ts);
}

function lastOutcomeMs(records: readonly JournalRecord[], entity: string, id: string, to: string): number {
  const matches = records.filter(
    (r) =>
      r.kind === "state.transition.outcome" &&
      payloadOf(r).entity === entity &&
      payloadOf(r).id === id &&
      payloadOf(r).to === to
  );
  const record = matches.at(-1);
  if (!record) throw new Error(`no ${entity} outcome to ${to}`);
  return Date.parse(record.ts);
}

// --- FR-001: the pure fold ---------------------------------------------------

test("economicsView folds per-spec sessions, remediation, hook blocks, cost, and wall-clock", () => {
  const world = freshWorld("econ-fold");
  try {
    const seed = seedEconomics(world);
    const records = world.journal.fold().records;
    const view = economicsView(records, "alpha");

    expect(view.project).toBe("alpha");
    expect(view.specs.map((s) => s.specId)).toEqual(["002-beta", "003-gamma"]);

    const beta = view.specs[0]!;
    expect(beta.sessions).toBe(2);
    expect(beta.sessionsByTermination.completed).toBe(2);
    expect(beta.sessionsByTermination.quota).toBe(0);
    // Spec 014's full kind set is always present, zero-filled.
    expect(Object.keys(beta.sessionsByTermination).sort()).toEqual([...TERMINATION_KINDS].sort());
    expect(beta.remediationRounds).toBe(1);
    expect(beta.hookBlockedStages).toBe(0);
    expect(beta.costMicroUsd).toBe(2_000_000);
    expect(beta.costUnknownSessions).toBe(1);
    const betaStart = firstStageIntentMs(records, new Set([seed.betaFirstStageId]));
    const betaEnd = lastOutcomeMs(records, "specExec", seed.betaExecId, "shipped");
    expect(beta.wallClockMs).toBe(betaEnd - betaStart);

    const gamma = view.specs[1]!;
    expect(gamma.sessions).toBe(1);
    expect(gamma.sessionsByTermination["hook-blocked"]).toBe(1);
    expect(gamma.hookBlockedStages).toBe(1);
    expect(gamma.remediationRounds).toBe(0);
    expect(gamma.costMicroUsd).toBe(50_000);
    expect(gamma.costUnknownSessions).toBe(0);
    // No terminal transition yet: wall-clock is unknown, not zero.
    expect(gamma.wallClockMs).toBeNull();
  } finally {
    world.close();
  }
});

test("economicsView folds per-run aggregates with quota parks and the whole-journal totals", () => {
  const world = freshWorld("econ-runs");
  try {
    const seed = seedEconomics(world);
    const records = world.journal.fold().records;
    const view = economicsView(records, "alpha");

    expect(view.runs.length).toBe(1);
    const run = view.runs[0]!;
    expect(run.runId).toBe(seed.runId);
    expect(run.status).toBe("completed");
    expect(run.sessions).toBe(3);
    expect(run.sessionsByTermination.completed).toBe(2);
    expect(run.sessionsByTermination["hook-blocked"]).toBe(1);
    expect(run.remediationRounds).toBe(1);
    expect(run.hookBlockedStages).toBe(1);
    expect(run.costMicroUsd).toBe(2_050_000);
    expect(run.costUnknownSessions).toBe(1);
    expect(run.quotaParks).toBe(1);
    expect(run.parkedMs).toBe(seed.parkedMs);
    const runStart = firstStageIntentMs(records, new Set([seed.betaFirstStageId]));
    const runEnd = lastOutcomeMs(records, "run", seed.runId, "completed");
    expect(run.wallClockMs).toBe(runEnd - runStart);

    const totals = view.totals!;
    expect(totals.sessions).toBe(3);
    expect(totals.costMicroUsd).toBe(2_050_000);
    expect(totals.costUnknownSessions).toBe(1);
    expect(totals.remediationRounds).toBe(1);
    expect(totals.hookBlockedStages).toBe(1);
    expect(totals.quotaParks).toBe(1);
    expect(totals.parkedMs).toBe(seed.parkedMs);
  } finally {
    world.close();
  }
});

test("an empty journal folds to zero specs and null totals, never fabricated zeros (B-2)", () => {
  const view = economicsView([], "alpha");
  expect(view).toEqual({ project: "alpha", specs: [], runs: [], totals: null });
});

test("honest absence: unreported costs stay null, unattributed sessions count only in totals, an open park is unknown", () => {
  const world = freshWorld("econ-absence");
  try {
    const { journal } = world;
    // A session with no SpecExec anywhere before it belongs to no spec and
    // no run; the whole-history totals still count it.
    sessionResult(world, "crashed", null);

    const run = transition(journal, createRun(journal, world.repoDir), "running");
    let beta = createSpecExec(journal, run.id, "002-beta", world.dagReader.pin("002-beta"));
    beta = transition(journal, beta, "building");
    const stage = createStageExec(journal, beta.id, "build", 1);
    transition(journal, stage, "running");
    sessionResult(world, "completed", null);
    journalPark(journal, { targetMs: 1_700_000_000_000, estimated: true, consecutiveQuotaParks: 1 });

    const view = economicsView(journal.fold().records, "alpha");
    const betaRow = view.specs[0]!;
    expect(betaRow.sessions).toBe(1);
    expect(betaRow.costMicroUsd).toBeNull();
    expect(betaRow.costUnknownSessions).toBe(1);

    const runRow = view.runs[0]!;
    expect(runRow.sessions).toBe(1);
    expect(runRow.quotaParks).toBe(1);
    // The park never resumed: its span is unknowable, so the total is null,
    // not a zero-length floor.
    expect(runRow.parkedMs).toBeNull();

    const totals = view.totals!;
    expect(totals.sessions).toBe(2);
    expect(totals.costMicroUsd).toBeNull();
    expect(totals.costUnknownSessions).toBe(2);
    expect(totals.quotaParks).toBe(1);
    expect(totals.parkedMs).toBeNull();
  } finally {
    world.close();
  }
});

// --- FR-002: the served route ------------------------------------------------

const FIXED_NOW = 1_722_000_000_000;

test("GET /api/projects/<name>/economics serves the fold in the envelope with generatedAt from the daemon's clock", async () => {
  const registry = freshRegistry("econ-route");
  const world = registry.add("alpha");
  seedEconomics(world);
  const server = createApiServer(fixtureApiDeps(registry, { pumpIntervalMs: 60_000, clock: { now: () => FIXED_NOW } }));
  try {
    const response = await fetch(`${server.url}/api/projects/alpha/economics`);
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.project).toBe("alpha");
    expect(envelope.data.generatedAt).toBe(FIXED_NOW);
    // The served payload is exactly the pure fold plus the clock stamp.
    const expected = servedEconomicsView(world.journal.fold().records, "alpha", FIXED_NOW);
    expect(envelope.data).toEqual(JSON.parse(JSON.stringify(expected)));
  } finally {
    await server.stop();
    registry.close();
  }
});

test("the economics route 404s an unknown project, enforces GET, and appears in the route table", async () => {
  const registry = freshRegistry("econ-route-guards");
  registry.add("alpha");
  const server = createApiServer(fixtureApiDeps(registry, { pumpIntervalMs: 60_000 }));
  try {
    const missing = await fetch(`${server.url}/api/projects/nope/economics`);
    expect(missing.status).toBe(404);
    const missingEnvelope = (await missing.json()) as { ok: boolean; error: { kind: string } };
    expect(missingEnvelope.ok).toBe(false);
    expect(missingEnvelope.error.kind).toBe("not-found");

    const posted = await fetch(`${server.url}/api/projects/alpha/economics`, { method: "POST" });
    expect(posted.status).toBe(405);
    const postedEnvelope = (await posted.json()) as { ok: boolean; error: { kind: string } };
    expect(postedEnvelope.error.kind).toBe("method-not-allowed");

    const meta = (await (await fetch(`${server.url}/api/meta`)).json()) as { data: { routes: readonly string[] } };
    expect(meta.data.routes).toContain(`/api/projects/<name>/${ECONOMICS_ROUTE}`);
  } finally {
    await server.stop();
    registry.close();
  }
});

// --- FR-003: the CLI verb ----------------------------------------------------

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runCli(argv: readonly string[], url: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "econ-cli-"));
  try {
    const code = await runOrchestratorCli([...argv, "--url", url], {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      dataDir,
      inspector: { isAlive: () => false, procStartMs: () => null },
      spawnDaemon: () => {
        throw new Error("spawnDaemon was not expected in this test");
      },
      kill: () => {
        throw new Error("kill was not expected in this test");
      },
      sleep: () => Promise.resolve(),
      env: {},
      startTimeoutMs: 50,
      stopTimeoutMs: 50,
      pollIntervalMs: 1,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withEconomicsServer(prefix: string, body: (url: string, world: FixtureWorld) => Promise<void>): Promise<void> {
  const registry = freshRegistry(prefix);
  const world = registry.add("alpha");
  seedEconomics(world);
  const server = createApiServer(fixtureApiDeps(registry, { pumpIntervalMs: 60_000 }));
  try {
    await body(server.url, world);
  } finally {
    await server.stop();
    registry.close();
  }
}

test("economics renders per-spec rows and run totals, naming unknown costs as unknown", async () => {
  await withEconomicsServer("econ-cli-human", async (url) => {
    const result = await runCli(["economics", "--project", "alpha"], url);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("002-beta");
    expect(result.out).toContain("003-gamma");
    // The unreported session is named unknown, never a bare zero (FR-003).
    expect(result.out).toContain("cost unknown x1");
    expect(result.out).toContain("$2.0000");
    expect(result.out).toContain("hook blocks 1");
    expect(result.out).toContain("remediations 1");
    expect(result.out).toContain("quota parks 1 (parked 1m 0s)");
    expect(result.out).toContain("totals:");
  });
});

test("economics --json prints the served envelope verbatim", async () => {
  await withEconomicsServer("econ-cli-json", async (url) => {
    const result = await runCli(["economics", "--project", "alpha", "--json"], url);
    expect(result.code).toBe(EXIT_OK);
    const printed = JSON.parse(result.out) as { ok: boolean; data: Record<string, unknown> };
    const served = (await (await fetch(`${url}/api/projects/alpha/economics`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(printed.ok).toBe(true);
    // generatedAt differs between the two requests (each is stamped at its
    // own serve time); everything else is byte-for-byte the served payload.
    const { generatedAt: printedAt, ...printedRest } = printed.data;
    const { generatedAt: servedAt, ...servedRest } = served.data;
    expect(typeof printedAt).toBe("number");
    expect(typeof servedAt).toBe("number");
    expect(printedRest).toEqual(servedRest);
  });
});

test("economics resolves the sole registered project without --project (028 D-4 carried over)", async () => {
  await withEconomicsServer("econ-cli-sole", async (url) => {
    const result = await runCli(["economics"], url);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("002-beta");
  });
});

test("economics maps an unknown project to the daemon's not-found (exit 1)", async () => {
  await withEconomicsServer("econ-cli-missing", async (url) => {
    const result = await runCli(["economics", "--project", "nope"], url);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("not-found");
  });
});

test("economics against no daemon is exit 2, never a crash", async () => {
  const result = await runCli(["economics", "--project", "alpha"], "http://127.0.0.1:1");
  expect(result.code).toBe(EXIT_UNREACHABLE);
});

test("a flag economics cannot use is a usage error (028 D-5 carried over)", async () => {
  const result = await runCli(["economics", "--name", "alpha"], "http://127.0.0.1:1");
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("--name is not a flag");
});
