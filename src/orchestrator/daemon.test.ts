import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, verifyChain, appendIntent, type JsonValue } from "./journal";
import { createRun, createSpecExec, createStageExec, transition } from "./state";
import type { DagReader } from "./dag";
import type { Runner, RunnerSessionOptions, BuildResult } from "./stages/build";
import type { GitHubClient, ShipResult } from "./stages/ship";
import type { ShepherdResult } from "./stages/shepherd";
import type { VerifyRunner, BrowserVerifier, VerifyResult } from "./stages/verify";
import type { SessionResult } from "./session";
import { runSession as realRunSession } from "./session";
import {
  Daemon,
  createProcessInspector,
  acquireDaemonLock,
  releaseDaemonLock,
  forceReleaseDaemonLock,
  shouldEmitHeartbeat,
  type DaemonDeps,
  type DaemonStageFns,
  type ProcessInspector,
} from "./daemon";

// --- fixtures --------------------------------------------------------------

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `daemon-test-${prefix}-`));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface FixtureSpec {
  readonly dependsOn?: readonly string[];
  readonly implementation?: string;
}

function fixtureDagReader(specs: Record<string, FixtureSpec>): DagReader {
  const listShape = Object.entries(specs).map(([id, s]) => ({
    id,
    implementation: s.implementation ?? "pending",
    dependsOn: s.dependsOn ?? [],
  }));
  return {
    registryListJson: () => JSON.stringify(listShape),
    registryShowJson: (_repoDir: string, specId: string) => {
      const s = specs[specId];
      if (!s) throw new Error(`fixtureDagReader: unknown spec ${specId}`);
      return JSON.stringify({ id: specId, implementation: s.implementation ?? "pending", dependsOn: s.dependsOn ?? [] });
    },
    readSpecFile: (_repoDir: string, specId: string) => Buffer.from(`fixture content for ${specId}\n`, "utf8"),
  };
}

// --- throwing stubs (prove a seam is genuinely unused when faked stage fns
// bypass it entirely) --------------------------------------------------------

function throwingRunner(): Runner {
  const fail =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`daemon test: Runner.${name} must not be called`);
    };
  return {
    statusClean: fail("statusClean"),
    currentBranch: fail("currentBranch"),
    createBranch: fail("createBranch"),
    checkout: fail("checkout"),
    add: fail("add"),
    commit: fail("commit"),
    headSha: fail("headSha"),
    pullFfOnly: fail("pullFfOnly"),
    runGate: fail("runGate"),
    readFile: fail("readFile"),
    writeFile: fail("writeFile"),
    runSession: async (_options: RunnerSessionOptions): Promise<SessionResult> => {
      throw new Error("daemon test: Runner.runSession must not be called");
    },
  };
}

function throwingGh(): GitHubClient {
  const fail =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`daemon test: GitHubClient.${name} must not be called`);
    };
  return {
    prForBranch: fail("prForBranch"),
    commitsForPr: fail("commitsForPr"),
    checksTriggered: fail("checksTriggered"),
    checkRunsForSha: fail("checkRunsForSha"),
    jobLogTail: fail("jobLogTail"),
    mergePr: fail("mergePr"),
    branchContains: fail("branchContains"),
    deleteRemoteBranch: fail("deleteRemoteBranch"),
  };
}

function throwingVerifyRunner(): VerifyRunner {
  const fail =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`daemon test: VerifyRunner.${name} must not be called`);
    };
  return { addWorktree: fail("addWorktree"), removeWorktree: fail("removeWorktree"), runCommand: fail("runCommand"), readFile: fail("readFile") };
}

function throwingBrowserVerifier(): BrowserVerifier {
  return {
    assert: async () => {
      throw new Error("daemon test: BrowserVerifier.assert must not be called");
    },
  };
}

function throwingRunSession(counter?: { calls: number }): typeof realRunSession {
  return (async () => {
    if (counter) counter.calls++;
    throw new Error("daemon test: the runSession seam must not be called directly by the daemon (B-5)");
  }) as unknown as typeof realRunSession;
}

function neverCalledStageFns(): DaemonStageFns {
  const fail =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`daemon test: stage fn "${name}" must not be called`);
    };
  return { build: fail("build"), ship: fail("ship"), shepherd: fail("shepherd"), verify: fail("verify") };
}

// --- canned stage results ---------------------------------------------------

function buildResult(specId: string, outcome: BuildResult["outcome"], opts: { quota?: boolean } = {}): BuildResult {
  return {
    outcome,
    evidence: {
      specId,
      branch: specId,
      headSha: `${specId}-head`,
      promptVersion: 1,
      refusal: null,
      sessions: [
        {
          sessionId: `s-${specId}-build`,
          classification: opts.quota ? "quota" : "completed",
          costMicroUsd: 10,
          numTurns: 1,
          durationMs: 1,
        },
      ],
      gates: [],
      frontmatterComplete: outcome === "passed",
      decisions: null,
    },
  };
}

function shipResult(specId: string, outcome: ShipResult["outcome"]): ShipResult {
  return {
    outcome,
    evidence: {
      specId,
      branch: specId,
      localHeadSha: `${specId}-head`,
      promptVersion: 1,
      sessions: [
        { sessionId: `s-${specId}-ship`, classification: "completed", detail: "ok", stderrTail: "", costMicroUsd: 5, numTurns: 1, durationMs: 1 },
      ],
      pr: { number: 1, url: "https://example.invalid/pr/1", headSha: `${specId}-head` },
      ciTriggered: true,
      ciRunId: null,
      verification: { ok: outcome === "passed", diff: [], ciTriggered: true },
      costMicroUsd: 5,
    },
  };
}

function shepherdResult(specId: string, outcome: ShepherdResult["outcome"], mergeSha: string | null): ShepherdResult {
  return {
    outcome,
    evidence: {
      specId,
      branch: specId,
      prNumber: 1,
      watchAttempts: [],
      remediations: [],
      mergeSha,
      branchContainsConfirmed: outcome === "passed" ? true : null,
      needsHuman: outcome === "failed",
      statuslessAbort: null,
    },
  };
}

function verifyResult(specId: string, sha: string, outcome: VerifyResult["outcome"]): VerifyResult {
  return {
    outcome,
    evidence: {
      specId,
      sha,
      declared: outcome !== "not-declared",
      parseError: null,
      cli: [],
      browser: [],
      firstFailure: null,
      evidenceDir: "/dev/null",
      needsHuman: false,
      quotaResetAtMs: null,
    },
  };
}

// --- deps builder ------------------------------------------------------------

interface MakeDepsParams {
  readonly dataDir: string;
  readonly repoDir: string;
  readonly dagReader: DagReader;
  readonly stageFns: DaemonStageFns;
  readonly clock?: { now(): number };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rng?: () => number;
  readonly processInspector?: ProcessInspector;
  readonly pid?: number;
  readonly runner?: Runner;
  readonly gh?: GitHubClient;
  readonly verifyRunner?: VerifyRunner;
  readonly browserVerifier?: BrowserVerifier;
  readonly sleepChunkMs?: number;
  readonly resumeJitterMinMs?: number;
  readonly resumeJitterMaxMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly stageRetryBudget?: number;
  readonly runSessionCallCounter?: { calls: number };
  readonly readCheckoutBranch?: () => string | null;
  readonly readSpecFileAtSha?: (sha: string, specId: string) => Buffer | null;
  readonly normalizeCheckoutForScheduling?: () => void;
}

// Real clock and real (small-chunk) sleep by default: most tests exercise
// genuine async interleaving (a control command racing a chunked wait), which
// a microtask-only fake sleep can starve real timers out from under (an
// infinite chain of already-resolved awaits never yields to the macrotask
// queue). Tests that need a compressed quota wait (hours of simulated time)
// pass an explicit fake clock/sleep plus a large sleepChunkMs, so the wait
// resolves in one or two real chunks instead of thousands.
function makeDeps(p: MakeDepsParams): DaemonDeps {
  return {
    dataDir: p.dataDir,
    repoDir: p.repoDir,
    dagReader: p.dagReader,
    runner: p.runner ?? throwingRunner(),
    gh: p.gh ?? throwingGh(),
    verifyRunner: p.verifyRunner ?? throwingVerifyRunner(),
    browserVerifier: p.browserVerifier ?? throwingBrowserVerifier(),
    runSession: throwingRunSession(p.runSessionCallCounter),
    processInspector: p.processInspector ?? createProcessInspector(),
    clock: p.clock ?? { now: () => Date.now() },
    sleep: p.sleep ?? ((ms: number) => Bun.sleep(ms)),
    rng: p.rng ?? (() => 0),
    stageFns: p.stageFns,
    pid: p.pid,
    sleepChunkMs: p.sleepChunkMs ?? 5,
    resumeJitterMinMs: p.resumeJitterMinMs ?? 1,
    resumeJitterMaxMs: p.resumeJitterMaxMs ?? 2,
    heartbeatIntervalMs: p.heartbeatIntervalMs ?? 60_000,
    stageRetryBudget: p.stageRetryBudget,
    readCheckoutBranch: p.readCheckoutBranch,
    readSpecFileAtSha: p.readSpecFileAtSha,
    normalizeCheckoutForScheduling: p.normalizeCheckoutForScheduling,
  };
}

function makeFakeTime(startMs = 0): { clock: { now(): number }; sleep: (ms: number) => Promise<void> } {
  let current = startMs;
  return {
    clock: { now: () => current },
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

// --- ProcessInspector (B-1) --------------------------------------------------

test("createProcessInspector: reports the current test process alive, with a resolvable start time", () => {
  const inspector = createProcessInspector();
  expect(inspector.isAlive(process.pid)).toBe(true);
  const start = inspector.procStartMs(process.pid);
  expect(start).not.toBeNull();
  expect(start as number).toBeLessThanOrEqual(Date.now());
});

test("createProcessInspector: a pid that plainly does not exist reports not alive", () => {
  const inspector = createProcessInspector();
  expect(inspector.isAlive(999_999_999)).toBe(false);
});

// --- acquireDaemonLock (B-1) -------------------------------------------------

test("acquireDaemonLock: throws when the recorded pid is alive and its start time still matches", () => {
  const dir = freshDir("lock-live");
  const inspector = createProcessInspector();
  const first = acquireDaemonLock(dir, inspector, process.pid);
  expect(first.reclaimedFrom).toBeNull();
  try {
    expect(() => acquireDaemonLock(dir, inspector, process.pid)).toThrow(/another instance holds the lock/);
  } finally {
    releaseDaemonLock(first.lockPath);
  }
});

test("acquireDaemonLock: a dead pid's lock is reclaimed and overwritten", () => {
  const dir = freshDir("lock-dead");
  const fakeInspector: ProcessInspector = { isAlive: (pid) => pid !== 999_999, procStartMs: () => 1_000 };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: 999_999, procStartMs: 500 }));

  const acquired = acquireDaemonLock(dir, fakeInspector, 42);
  expect(acquired.reclaimedFrom).toEqual({ pid: 999_999, procStartMs: 500 });
  const onDisk = JSON.parse(fs.readFileSync(join(dir, "daemon.lock"), "utf8"));
  expect(onDisk).toEqual({ pid: 42, procStartMs: 1000 });
});

test("acquireDaemonLock: a live pid whose own start time no longer matches (pid reuse) is reclaimed, not trusted", () => {
  const dir = freshDir("lock-reuse");
  const fakeInspector: ProcessInspector = {
    isAlive: () => true, // the pid is alive...
    procStartMs: (pid) => (pid === 7 ? 9_999 : 1_234), // ...but it is a different process than the one recorded
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: 7, procStartMs: 42 }));

  const acquired = acquireDaemonLock(dir, fakeInspector, 8);
  expect(acquired.reclaimedFrom).toEqual({ pid: 7, procStartMs: 42 });
});

// --- Daemon.start() lock wiring (B-1) ----------------------------------------

test("Daemon.start(): refuses when another instance already holds the lock", async () => {
  const dataDir = freshDir("start-live-data");
  const repoDir = freshDir("start-live-repo");
  const dagReader = fixtureDagReader({});
  const daemon1 = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns() }));
  await daemon1.start();

  const daemon2 = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns() }));
  await expect(daemon2.start()).rejects.toThrow(/another instance holds the lock/);

  await daemon1.join();
  await daemon1.shutdown();
});

test("Daemon.start(): a stale identity lock is reclaimed with a journaled note, and journal.ts's own per-chain locks are cleared", async () => {
  const dataDir = freshDir("start-stale-data");
  const repoDir = freshDir("start-stale-repo");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(join(dataDir, "daemon.lock"), JSON.stringify({ pid: 999_998, procStartMs: 1 }));
  fs.writeFileSync(join(dataDir, "journal.lock"), "999998");
  fs.writeFileSync(join(dataDir, "decisions.lock"), "999998");

  const dagReader = fixtureDagReader({});
  const inspector: ProcessInspector = { isAlive: (pid) => pid !== 999_998, procStartMs: () => 5 };
  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns(), processInspector: inspector, pid: 123 });

  const daemon = new Daemon(deps);
  await daemon.start();
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    const reclaimed = journal.fold().byKind["daemon.lock.reclaimed"];
    expect(reclaimed?.length).toBe(1);
    expect(reclaimed![0]!.payload).toMatchObject({ stalePid: 999_998, staleProcStartMs: 1, newPid: 123 });
  } finally {
    journal.close();
  }
});

// --- recovery: needsReconcile sweep (B-2) ------------------------------------

test("recover(): a needsReconcile stageExec (dangling intent, no outcome) is inspected and journaled as reconciled", async () => {
  const dataDir = freshDir("reconcile-data");
  const repoDir = freshDir("reconcile-repo");

  const seedJournal = openJournal(dataDir);
  const run = createRun(seedJournal, repoDir);
  const runningRun = transition(seedJournal, run, "running");
  const specExec = createSpecExec(seedJournal, runningRun.id, "900-fixture", "pin-900");
  const buildingSpecExec = transition(seedJournal, specExec, "building");
  const stageExec = createStageExec(seedJournal, buildingSpecExec.id, "build", 1);
  const runningStageExec = transition(seedJournal, stageExec, "running");
  // The exact crash window state.ts's own needsReconcile flag exists to
  // describe: an intent with no matching outcome.
  appendIntent(seedJournal, "state.transition", {
    entity: "stageExec",
    id: runningStageExec.id,
    from: "running",
    to: "passed",
  });
  seedJournal.close();

  // 900-fixture depends on a spec absent from the registry, so nextReady
  // refuses it as a blocker rather than the daemon ever calling a stage fn;
  // this test is only about the recovery sweep, not the loop's picking.
  const dagReader = fixtureDagReader({ "900-fixture": { dependsOn: ["999-missing"] } });
  let ghCalls = 0;
  const gh: GitHubClient = {
    ...throwingGh(),
    prForBranch: (branch: string) => {
      ghCalls++;
      expect(branch).toBe("900-fixture");
      return null;
    },
  };
  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns(), gh });

  const daemon = new Daemon(deps);
  await daemon.start();
  await daemon.join();
  expect(daemon.runStatus).toBe("failed"); // nothing ready, one pending spec, blocked
  await daemon.shutdown();

  expect(ghCalls).toBe(1);

  const journal = openJournal(dataDir);
  try {
    const reconciled = journal.fold().byKind["daemon.reconciled"];
    expect(reconciled?.length).toBe(1);
    expect(reconciled![0]!.payload).toMatchObject({
      entity: "stageExec",
      id: runningStageExec.id,
      stage: "build",
      observedStatus: "running",
    });
  } finally {
    journal.close();
  }
});

// --- FR-002 heartbeat --------------------------------------------------------

test("shouldEmitHeartbeat: at most once per interval, by clock reading alone", () => {
  expect(shouldEmitHeartbeat(null, 0, 60_000)).toBe(true);
  expect(shouldEmitHeartbeat(1_000, 1_500, 60_000)).toBe(false);
  expect(shouldEmitHeartbeat(1_000, 60_999, 60_000)).toBe(false);
  expect(shouldEmitHeartbeat(1_000, 61_000, 60_000)).toBe(true);
  expect(shouldEmitHeartbeat(1_000, 120_000, 60_000)).toBe(true);
});

// --- control: pause/resume (B-4) ---------------------------------------------

test("pause()/resume(): validate state, journal a control record with source, and take effect only at the next stage checkpoint", async () => {
  const dataDir = freshDir("pause-data");
  const repoDir = freshDir("pause-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  let buildStarted!: () => void;
  const buildStartedPromise = new Promise<void>((resolve) => {
    buildStarted = resolve;
  });
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });

  const stageFns: DaemonStageFns = {
    build: async (options) => {
      buildStarted();
      await buildGate;
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();
  await buildStartedPromise;

  expect(daemon.runStatus).toBe("running");
  daemon.pause("test-source");
  // Queued and journaled, but not yet applied: the build stage is still
  // in flight and pause is only checked at the next stage checkpoint.
  expect(daemon.runStatus).toBe("running");

  releaseBuild();
  await Bun.sleep(50);
  expect(daemon.runStatus).toBe("paused");

  daemon.resume("test-source");
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    const byKind = journal.fold().byKind;
    expect(byKind["control.pause"]?.length).toBe(1);
    expect(byKind["control.pause"]![0]!.payload).toMatchObject({ source: "test-source" });
    expect(byKind["control.resume"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

test("control methods validate preconditions before journaling anything", async () => {
  const dataDir = freshDir("control-validate-data");
  const repoDir = freshDir("control-validate-repo");
  const dagReader = fixtureDagReader({});
  const daemon = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns() }));
  await daemon.start();
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");

  expect(() => daemon.pause("test")).toThrow(/requires the run to be "running"/);
  expect(() => daemon.resume("test")).toThrow(/requires the run to be "paused"/);

  await daemon.shutdown();
});

// --- control: skipSpec (B-4) --------------------------------------------------

test("skipSpec(): excludes a spec from future nextReady consideration", async () => {
  const dataDir = freshDir("skip-data");
  const repoDir = freshDir("skip-repo");
  const dagReader = fixtureDagReader({ "900-fixture-a": {}, "901-fixture-b": {} });

  let buildStartedA!: () => void;
  const buildStartedAPromise = new Promise<void>((resolve) => {
    buildStartedA = resolve;
  });
  let releaseBuildA!: () => void;
  const buildGateA = new Promise<void>((resolve) => {
    releaseBuildA = resolve;
  });

  const stageFns: DaemonStageFns = {
    build: async (options) => {
      if (options.specId === "901-fixture-b") throw new Error("901-fixture-b must be skipped, never built");
      buildStartedA();
      await buildGateA;
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();
  await buildStartedAPromise;

  daemon.skipSpec("901-fixture-b", "test-source");
  releaseBuildA();

  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    expect(journal.fold().byKind["control.skipSpec"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

// --- control: forceHumanGate + approve (B-4) ---------------------------------

test("forceHumanGate()/approve(): the next stage transition for that spec waits for explicit approval", async () => {
  const dataDir = freshDir("gate-data");
  const repoDir = freshDir("gate-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  let buildStarted!: () => void;
  const buildStartedPromise = new Promise<void>((resolve) => {
    buildStarted = resolve;
  });
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  let shipCalled = false;

  const stageFns: DaemonStageFns = {
    build: async (options) => {
      buildStarted();
      await buildGate;
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => {
      shipCalled = true;
      return shipResult(options.specId, "passed");
    },
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();
  await buildStartedPromise;

  daemon.forceHumanGate("900-fixture", "test-source");
  releaseBuild();

  await Bun.sleep(50);
  expect(daemon.runStatus).toBe("paused");
  expect(shipCalled).toBe(false);

  daemon.approve("900-fixture", "test-source");
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  expect(shipCalled).toBe(true);
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    const byKind = journal.fold().byKind;
    expect(byKind["control.forceHumanGate"]?.length).toBe(1);
    expect(byKind["control.approve"]?.length).toBe(1);
    expect(byKind["daemon.gate.waiting"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

// --- control: retryStage after a stage exhausts its budget (B-3, B-4) -------

test("a stage that fails past its retry budget fails the spec exec and pauses the run; retryStage() resumes and retries", async () => {
  const dataDir = freshDir("retry-data");
  const repoDir = freshDir("retry-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  let buildAttempts = 0;
  const stageFns: DaemonStageFns = {
    build: async (options) => {
      buildAttempts++;
      if (buildAttempts <= 2) return buildResult(options.specId, "failed"); // default budget: 1 retry = 2 attempts
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();

  await Bun.sleep(80);
  expect(daemon.runStatus).toBe("paused");
  expect(buildAttempts).toBe(2);

  daemon.retryStage("900-fixture", "test-source");
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  expect(buildAttempts).toBe(3);
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    expect(journal.fold().byKind["control.retryStage"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

// --- control: reverify (spec 012 B-4 re-qualification) -----------------------

test("reverify(): re-runs just the verify stage for an already-shipped spec, within the same run", async () => {
  const dataDir = freshDir("reverify-data");
  const repoDir = freshDir("reverify-repo");
  const dagReader = fixtureDagReader({ "900-fixture-a": {}, "901-fixture-b": { dependsOn: ["900-fixture-a"] } });

  let buildStartedB!: () => void;
  const buildStartedBPromise = new Promise<void>((resolve) => {
    buildStartedB = resolve;
  });
  let releaseBuildB!: () => void;
  const buildGateB = new Promise<void>((resolve) => {
    releaseBuildB = resolve;
  });

  let verifyCallsForA = 0;
  const reVerificationFlags: boolean[] = [];

  const stageFns: DaemonStageFns = {
    build: async (options) => {
      if (options.specId === "901-fixture-b") {
        buildStartedB();
        await buildGateB;
      }
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => {
      if (options.specId === "900-fixture-a") {
        verifyCallsForA++;
        reVerificationFlags.push(options.isReVerification ?? false);
      }
      return verifyResult(options.specId, options.sha, "not-declared");
    },
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();
  await buildStartedBPromise; // 900-fixture-a has already shipped; b is mid-build

  daemon.reverify("900-fixture-a", "test-source");
  releaseBuildB();

  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  expect(verifyCallsForA).toBe(2);
  expect(reVerificationFlags).toEqual([false, true]);
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    expect(journal.fold().byKind["control.reverify"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

// --- B-6: shutdown ------------------------------------------------------------

test("shutdown(): mid-stage shutdown lets the in-flight stage's own outcome finish journaling before releasing the lock", async () => {
  const dataDir = freshDir("shutdown-mid-data");
  const repoDir = freshDir("shutdown-mid-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  let buildStarted!: () => void;
  const buildStartedPromise = new Promise<void>((resolve) => {
    buildStarted = resolve;
  });
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });

  const stageFns: DaemonStageFns = {
    build: async (options) => {
      buildStarted();
      await buildGate;
      return buildResult(options.specId, "passed");
    },
    ship: async () => {
      throw new Error("must not reach ship: shutdown should stop before the next stage starts");
    },
    shepherd: async () => {
      throw new Error("must not reach shepherd");
    },
    verify: async () => {
      throw new Error("must not reach verify");
    },
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();
  await buildStartedPromise;

  const shutdownPromise = daemon.shutdown();
  let shutdownSettled = false;
  shutdownPromise.then(() => {
    shutdownSettled = true;
  });
  await Bun.sleep(30);
  expect(shutdownSettled).toBe(false); // still waiting on the in-flight build

  releaseBuild();
  await shutdownPromise;
  expect(shutdownSettled).toBe(true);
  expect(fs.existsSync(join(dataDir, "daemon.lock"))).toBe(false);

  const journal = openJournal(dataDir);
  try {
    const byKind = journal.fold().byKind;
    const outcomes = byKind["state.transition.outcome"] ?? [];
    const stagePassed = outcomes.some((r) => isRecord(r.payload) && r.payload.entity === "stageExec" && r.payload.to === "passed");
    expect(stagePassed).toBe(true);
    expect(byKind["daemon.shutdown"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

test("shutdown(): interrupts a parked wait before its target instead of running it to completion", async () => {
  const dataDir = freshDir("shutdown-park-data");
  const repoDir = freshDir("shutdown-park-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "failed", { quota: true }),
    ship: async () => {
      throw new Error("must not reach ship");
    },
    shepherd: async () => {
      throw new Error("must not reach shepherd");
    },
    verify: async () => {
      throw new Error("must not reach verify");
    },
  };

  // Real clock/sleep with a small chunk: the estimated park target is hours
  // away, so only an actual interrupt (not simply waiting it out) can make
  // this test finish quickly.
  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns, sleepChunkMs: 5 });
  const daemon = new Daemon(deps);
  await daemon.start();

  await Bun.sleep(40);
  expect(daemon.runStatus).toBe("parked");

  await daemon.shutdown();
  expect(daemon.runStatus).toBe("parked"); // interrupted before the resume ever fired

  const journal = openJournal(dataDir);
  try {
    const byKind = journal.fold().byKind;
    expect(byKind["quota.parked"]?.length).toBe(1);
    expect(byKind["quota.resumed"]).toBeUndefined();
    expect(byKind["daemon.shutdown"]?.length).toBe(1);
  } finally {
    journal.close();
  }
});

// --- FR-001 / AC-1 / AC-2: end-to-end two-spec run, quota park/resume, and a
// daemon kill + restart mid-pipeline ------------------------------------------

test(
  "FR-001: a two-spec run survives a quota park/resume and a daemon kill+restart, ending with both specs shipped and both chains verifying (AC-1, AC-2)",
  async () => {
    const dataDir = freshDir("e2e-data");
    const repoDir = freshDir("e2e-repo");
    const dagReader = fixtureDagReader({
      "900-fixture-a": {},
      "901-fixture-b": { dependsOn: ["900-fixture-a"] },
    });

    const runSessionCounter = { calls: 0 };

    // Simulated abrupt kill: the first shepherd attempt for spec A hangs on
    // a promise that never settles, so daemon1 is wedged mid-stage exactly
    // like a killed process looks to the journal (the stageExec's running
    // transition journaled, nothing after it) and is then abandoned.
    const hang = new Promise<never>(() => {});
    let shepherdShouldHangForA = true;
    let buildCallCountForB = 0;

    const stageFns: DaemonStageFns = {
      build: async (options) => {
        if (options.specId === "901-fixture-b") {
          buildCallCountForB++;
          if (buildCallCountForB === 1) return buildResult(options.specId, "failed", { quota: true });
        }
        return buildResult(options.specId, "passed");
      },
      ship: async (options) => shipResult(options.specId, "passed"),
      shepherd: async (options) => {
        if (options.specId === "900-fixture-a" && shepherdShouldHangForA) {
          shepherdShouldHangForA = false;
          return hang;
        }
        return shepherdResult(options.specId, "passed", `${options.specId}-merge-sha`);
      },
      verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
    };

    // Fake clock/sleep with a large chunk: the quota park for spec B is a
    // multi-hour estimate (build/ship evidence carries no reset hint), which
    // resolves in a single chunk instead of thousands of tiny real waits.
    const time1 = makeFakeTime(Date.UTC(2026, 6, 29, 0, 0, 0));
    const deps1 = makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns,
      clock: time1.clock,
      sleep: time1.sleep,
      sleepChunkMs: 12 * 3_600_000,
      rng: () => 0,
      runSessionCallCounter: runSessionCounter,
    });

    const daemon1 = new Daemon(deps1);
    await daemon1.start();

    // Wait until daemon1 is wedged inside spec A's shepherd stage, then
    // abandon it without shutdown or join (the abrupt-kill simulation); the
    // journal simply stops mid-stage.
    await Bun.sleep(80);
    expect(shepherdShouldHangForA).toBe(false);

    // A supervisor that has confirmed the previous writer dead force-releases
    // the identity lock and journal.ts's own per-chain locks (this same real
    // process never actually died, so the daemon's own pid+procStart
    // auto-reclaim path would not fire here; that path is covered by its own
    // dedicated test above).
    forceReleaseDaemonLock(dataDir);

    const time2 = makeFakeTime(Date.UTC(2026, 6, 29, 0, 0, 0));
    const deps2 = makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns,
      clock: time2.clock,
      sleep: time2.sleep,
      sleepChunkMs: 12 * 3_600_000,
      rng: () => 0,
      runSessionCallCounter: runSessionCounter,
    });

    const daemon2 = new Daemon(deps2);
    await daemon2.start();
    await daemon2.join();
    expect(daemon2.runStatus).toBe("completed");
    await daemon2.shutdown();

    // B-5: the daemon's own code never spawns a session outside stage
    // execution; only the (faked, in this test) stage fns would ever call
    // the injected runSession primitive, and they never did either.
    expect(runSessionCounter.calls).toBe(0);

    // AC-2: verifyChain passes over both chains produced by the kill/restart.
    expect(verifyChain(dataDir)).toEqual(expect.objectContaining({ ok: true }));
    expect(verifyChain(dataDir, "decisions")).toEqual(expect.objectContaining({ ok: true }));

    // End state: both specs shipped.
    const journal = openJournal(dataDir);
    try {
      const byKind = journal.fold().byKind;
      const creates = (byKind["specexec.created"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
      const specIdsSeen = new Set(creates.map((c) => c.specId));
      expect(specIdsSeen).toEqual(new Set(["900-fixture-a", "901-fixture-b"]));

      // The last recorded status transition target for each spec exec's own
      // entity id must be "shipped".
      const transitions = (byKind["state.transition.outcome"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
      for (const create of creates) {
        const id = create.id as string;
        const lastForEntity = [...transitions].reverse().find((t) => t.entity === "specExec" && t.id === id);
        expect(lastForEntity?.to).toBe("shipped");
      }

      expect((byKind["quota.parked"] ?? []).length).toBeGreaterThanOrEqual(1);
      expect((byKind["quota.resumed"] ?? []).length).toBeGreaterThanOrEqual(1);
      expect(buildCallCountForB).toBe(2); // one quota hit, one successful retry
    } finally {
      journal.close();
    }
  },
  10_000
);

// --- regression: the bracket's frontmatter flip must not hide a spec from
// its own resume (found live: ship failed past budget, retryStage was
// issued, and nextReady skipped the spec because the registry honestly
// reported it in-progress) ---------------------------------------------------

test("a failed specExec whose spec reads in-progress in the registry is still scheduled on resume", async () => {
  const dataDir = freshDir("resume-inprogress-data");
  const repoDir = freshDir("resume-inprogress-repo");

  // Dynamic registry: like the real build bracket, the spec flips to
  // in-progress the moment build first runs, and stays that way.
  let implementation = "pending";
  const dagReader: DagReader = {
    registryListJson: () => JSON.stringify([{ id: "900-fixture", implementation, dependsOn: [] }]),
    registryShowJson: () => JSON.stringify({ id: "900-fixture", implementation, dependsOn: [] }),
    readSpecFile: () => Buffer.from("fixture content for 900-fixture\n", "utf8"),
  };

  let shipAttempts = 0;
  const stageFns: DaemonStageFns = {
    build: async (options) => {
      implementation = "in-progress";
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => {
      shipAttempts++;
      if (shipAttempts <= 2) return shipResult(options.specId, "failed");
      return shipResult(options.specId, "passed");
    },
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const deps = makeDeps({ dataDir, repoDir, dagReader, stageFns });
  const daemon = new Daemon(deps);
  await daemon.start();

  await Bun.sleep(80);
  expect(daemon.runStatus).toBe("paused");
  expect(shipAttempts).toBe(2);

  daemon.retryStage("900-fixture", "test-source");
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  expect(shipAttempts).toBe(3);
  await daemon.shutdown();
});

// --- regression: an amended adopted spec re-adopts at its current pin
// (found live: a spec 021 amendment invalidated the adopted entry and
// blocked the whole backlog with no re-qualification path) -------------------

test("an adopted spec whose spec.md was amended refreshes its pin instead of blocking dependents", async () => {
  const dataDir = freshDir("adopted-refresh-data");
  const repoDir = freshDir("adopted-refresh-repo");

  // 800-kernel is bootstrap-adopted (complete). Its content changes between
  // daemon lifetimes, like an amendment landing on main after adoption.
  let kernelContent = "original kernel spec\n";
  let includeFixture = false;
  const dagReader: DagReader = {
    registryListJson: () => {
      const list: unknown[] = [{ id: "800-kernel", implementation: "complete", dependsOn: [] }];
      if (includeFixture) list.push({ id: "900-fixture", implementation: "pending", dependsOn: ["800-kernel"] });
      return JSON.stringify(list);
    },
    registryShowJson: () => {
      throw new Error("not used");
    },
    readSpecFile: (_repo: string, specId: string) =>
      Buffer.from(specId === "800-kernel" ? kernelContent : "fixture spec\n", "utf8"),
  };

  // First lifetime: adopt 800-kernel at its original pin; with nothing
  // pending the run completes immediately.
  const daemon1 = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns: neverCalledStageFns() }));
  await daemon1.start();
  await daemon1.join();
  expect(daemon1.runStatus).toBe("completed");
  await daemon1.shutdown();

  // Amendment lands between lifetimes, and the backlog gains a dependent.
  kernelContent = "amended kernel spec\n";
  includeFixture = true;

  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "passed"),
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };
  const daemon2 = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns }));
  await daemon2.start();
  await daemon2.join();
  expect(daemon2.runStatus).toBe("completed");
  await daemon2.shutdown();

  const journal = openJournal(dataDir);
  try {
    const refreshes = (journal.fold().byKind["dag.adopted.refreshed"] ?? []).map(
      (r) => r.payload as { id: string; oldPin: string | null; newPin: string }
    );
    const kernelRefresh = refreshes.filter((p) => p.id === "800-kernel");
    expect(kernelRefresh.length).toBe(1);
    expect(kernelRefresh[0]!.oldPin).not.toBeNull();
    expect(kernelRefresh[0]!.oldPin).not.toBe(kernelRefresh[0]!.newPin);
  } finally {
    journal.close();
  }
});

// --- regression: a terminal latest run is history; restart continues the
// backlog under a fresh run --------------------------------------------------

test("recovery after a failed run creates a fresh run and continues the backlog", async () => {
  const dataDir = freshDir("fresh-run-data");
  const repoDir = freshDir("fresh-run-repo");

  // First lifetime fails its run: the only pending spec depends on a spec
  // the registry does not know, so the loop journals run.blocked and fails.
  const badReader = fixtureDagReader({ "900-fixture": { dependsOn: ["777-missing"] } });
  const daemon1 = new Daemon(makeDeps({ dataDir, repoDir, dagReader: badReader, stageFns: neverCalledStageFns() }));
  await daemon1.start();
  await daemon1.join();
  expect(daemon1.runStatus).toBe("failed");
  await daemon1.shutdown();

  // Second lifetime: the registry now lists the dependency as complete; it
  // is late-adopted at observation, a fresh run is created, and the backlog
  // completes.
  const goodReader = fixtureDagReader({
    "777-missing": { implementation: "complete" },
    "900-fixture": { dependsOn: ["777-missing"] },
  });
  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "passed"),
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };
  const daemon2 = new Daemon(makeDeps({ dataDir, repoDir, dagReader: goodReader, stageFns }));
  await daemon2.start();
  await daemon2.join();
  expect(daemon2.runStatus).toBe("completed");
  await daemon2.shutdown();

  const journal = openJournal(dataDir);
  try {
    expect(journal.fold().byKind["run.created"]?.length).toBe(2);
    const late = (journal.fold().byKind["dag.adopted.refreshed"] ?? []).map(
      (r) => r.payload as { id: string; oldPin: string | null }
    );
    expect(late.some((p) => p.id === "777-missing" && p.oldPin === null)).toBe(true);
  } finally {
    journal.close();
  }
});

// --- regression: adoption trusts only a default-branch registry read
// (found live: a daemon restart on a failed spec's branch read that spec's
// own frontmatter as complete, adopted the unmerged spec as shipped, and
// dead-ended the run scheduling its dependent) --------------------------------

test("adoption is deferred on a non-default-branch checkout and completes later from the default branch", async () => {
  const dataDir = freshDir("adoption-guard-data");
  const repoDir = freshDir("adoption-guard-repo");

  // The incident shape: the checkout sits on a spec branch where an
  // unmerged spec reads complete, and a pending spec depends on it.
  const dagReader = fixtureDagReader({
    "777-unmerged": { implementation: "complete" },
    "900-fixture": { dependsOn: ["777-unmerged"] },
  });

  const daemon1 = new Daemon(
    makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns: neverCalledStageFns(),
      readCheckoutBranch: () => "777-unmerged",
    })
  );
  await daemon1.start();
  await daemon1.join();
  // 777 must not be adopted from the branch read, so 900 is blocked and the
  // run fails honestly instead of building on an unmerged dependency.
  expect(daemon1.runStatus).toBe("failed");
  await daemon1.shutdown();

  const journalAfterBranch = openJournal(dataDir);
  try {
    const fold = journalAfterBranch.fold();
    expect(fold.byKind["dag.adopted"] ?? []).toHaveLength(0);
    expect(fold.byKind["dag.adopted.refreshed"] ?? []).toHaveLength(0);
    const deferred = (fold.byKind["dag.adoption.deferred"] ?? []).map(
      (r) => r.payload as { branch: string | null; phase: string; candidates?: string[] }
    );
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.some((p) => p.branch === "777-unmerged")).toBe(true);
    expect(deferred.some((p) => (p.candidates ?? []).includes("777-unmerged"))).toBe(true);
  } finally {
    journalAfterBranch.close();
  }

  // Back on the default branch, the same registry read is trusted: 777 is
  // late-adopted (D-11, oldPin null) and the backlog completes.
  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "passed"),
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };
  const daemon2 = new Daemon(
    makeDeps({ dataDir, repoDir, dagReader, stageFns, readCheckoutBranch: () => "main" })
  );
  await daemon2.start();
  await daemon2.join();
  expect(daemon2.runStatus).toBe("completed");
  await daemon2.shutdown();

  const journal = openJournal(dataDir);
  try {
    // The deferred first adoption lands through recovery's own initial
    // dag.adopted record once the read is trusted (no prior record exists),
    // not through a refresh: assert 777 was adopted there.
    const fold = journal.fold();
    const initial = (fold.byKind["dag.adopted"] ?? []).flatMap(
      (r) => (r.payload as { entries: Array<{ id: string }> }).entries
    );
    expect(fold.byKind["dag.adopted"]).toHaveLength(1);
    expect(initial.some((e) => e.id === "777-unmerged")).toBe(true);
  } finally {
    journal.close();
  }
});

// --- regression: a pipeline-shipped spec's pin is resolved from its merged
// content, not its pre-flip creation pin (found live: 027, the first spec to
// depend on a pipeline-shipped spec, was born blocked by 026's own
// frontmatter flip reading as pin drift) --------------------------------------

test("a dependent of a pipeline-shipped spec schedules after the flip merge; a post-merge amendment still invalidates", async () => {
  const dataDir = freshDir("pipeline-pin-data");
  const repoDir = freshDir("pipeline-pin-repo");

  // 800's on-disk content changes when its PR merges (the frontmatter
  // flip); the shepherd stage fn performs that mutation, like the merge.
  let baseContent = "800 content: implementation pending\n";
  const mergedContent = "800 content: implementation complete\n";
  // A third spec appears in the second lifetime so the amendment's
  // invalidation has a pending dependent to block.
  let includeFuture = false;
  const depsOf = (specId: string): string[] =>
    specId === "900-dependent" || specId === "950-future" ? ["800-base"] : [];
  const dagReader: DagReader = {
    registryListJson: () => {
      const rows = [
        { id: "800-base", implementation: "pending", dependsOn: [] },
        { id: "900-dependent", implementation: "pending", dependsOn: ["800-base"] },
      ];
      if (includeFuture) rows.push({ id: "950-future", implementation: "pending", dependsOn: ["800-base"] });
      return JSON.stringify(rows);
    },
    registryShowJson: (_repoDir: string, specId: string) =>
      JSON.stringify({ id: specId, implementation: "pending", dependsOn: depsOf(specId) }),
    readSpecFile: (_repoDir: string, specId: string) =>
      Buffer.from(specId === "800-base" ? baseContent : `content for ${specId}\n`, "utf8"),
  };

  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "passed"),
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => {
      if (options.specId === "800-base") baseContent = mergedContent;
      return shepherdResult(options.specId, "passed", `${options.specId}-merge`);
    },
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const daemon = new Daemon(
    makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns,
      // The merged content is what the journaled merge sha names.
      readSpecFileAtSha: (sha, specId) =>
        sha === "800-base-merge" && specId === "800-base" ? Buffer.from(mergedContent, "utf8") : null,
    })
  );
  await daemon.start();
  await daemon.join();
  // Without merge-sha pin resolution, 800 reads as drifted after its own
  // flip and 900 is born blocked, failing the run.
  expect(daemon.runStatus).toBe("completed");
  await daemon.shutdown();

  // A post-merge amendment is not the flip: it must still invalidate.
  baseContent = "800 content: amended after merge\n";
  includeFuture = true;
  const daemon2 = new Daemon(
    makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns: neverCalledStageFns(),
      readSpecFileAtSha: (sha, specId) =>
        sha === "800-base-merge" && specId === "800-base" ? Buffer.from(mergedContent, "utf8") : null,
    })
  );
  await daemon2.start();
  await daemon2.join();
  await daemon2.shutdown();
  const journal = openJournal(dataDir);
  try {
    const blocked = (journal.fold().byKind["run.blocked"] ?? []).map(
      (r) => r.payload as { blockers: Array<{ specId: string; reasons: string[] }> }
    );
    expect(
      blocked.some((b) =>
        b.blockers.some((s) => s.reasons.some((reason) => reason.includes("invalidated")))
      )
    ).toBe(true);
  } finally {
    journal.close();
  }
});

// --- regression: every scheduling pass offers the checkout back to the
// default branch before reading the registry (D-17) ---------------------------

test("the scheduling pass invokes checkout normalization before reading the registry", async () => {
  const dataDir = freshDir("normalize-data");
  const repoDir = freshDir("normalize-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });
  const stageFns: DaemonStageFns = {
    build: async (options) => buildResult(options.specId, "passed"),
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };
  let normalizeCalls = 0;
  const daemon = new Daemon(
    makeDeps({
      dataDir,
      repoDir,
      dagReader,
      stageFns,
      normalizeCheckoutForScheduling: () => {
        normalizeCalls += 1;
      },
    })
  );
  await daemon.start();
  await daemon.join();
  expect(daemon.runStatus).toBe("completed");
  expect(normalizeCalls).toBeGreaterThan(0);
  await daemon.shutdown();
});

// --- regression: a throwing stage implementation fails the attempt and
// pauses honestly; it never kills the daemon (found live: a bracket error
// crashed the loop with the lock left behind) --------------------------------

test("a stage fn that throws is a failed attempt with journaled evidence, then an honest pause", async () => {
  const dataDir = freshDir("stage-crash-data");
  const repoDir = freshDir("stage-crash-repo");
  const dagReader = fixtureDagReader({ "900-fixture": {} });

  let buildCalls = 0;
  const stageFns: DaemonStageFns = {
    build: async () => {
      buildCalls++;
      throw new Error("bracket exploded");
    },
    ship: async (options) => shipResult(options.specId, "passed"),
    shepherd: async (options) => shepherdResult(options.specId, "passed", `${options.specId}-merge`),
    verify: async (options) => verifyResult(options.specId, options.sha, "not-declared"),
  };

  const daemon = new Daemon(makeDeps({ dataDir, repoDir, dagReader, stageFns }));
  await daemon.start();
  await Bun.sleep(80);
  expect(daemon.runStatus).toBe("paused");
  expect(buildCalls).toBe(2); // default budget: 1 retry = 2 attempts
  await daemon.shutdown();

  const journal = openJournal(dataDir);
  try {
    const crashes = journal.fold().byKind["stage.crashed"] ?? [];
    expect(crashes.length).toBe(2);
    const p = crashes[0]!.payload as { error: string; stage: string };
    expect(p.stage).toBe("build");
    expect(p.error).toContain("bracket exploded");
  } finally {
    journal.close();
  }
});
