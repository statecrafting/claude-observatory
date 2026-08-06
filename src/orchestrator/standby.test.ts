import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, verifyChain, type JsonValue } from "./journal";
import type { DagReader } from "./dag";
import type { Runner, RunnerSessionOptions, BuildResult } from "./stages/build";
import type { GitHubClient, ShipResult } from "./stages/ship";
import type { ShepherdResult } from "./stages/shepherd";
import type { VerifyRunner, BrowserVerifier, VerifyResult } from "./stages/verify";
import type { SessionResult } from "./session";
import { runSession as realRunSession } from "./session";
import { createProcessInspector, type DaemonDeps, type DaemonStageFns } from "./daemon";
import { createRun, transition } from "./state";
import {
  openProjectsChain,
  projectStateRoot,
  registerProject,
  setProjectArmed,
  type Project,
  type QualificationVerdict,
} from "./projects";
import { DEFAULT_SCAN_INTERVAL_MS, StandbyDaemon, forceReleaseStandbyLocks } from "./standby";

// --- fixtures ---------------------------------------------------------------

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `standby-test-${prefix}-`));
}

interface FixtureSpec {
  readonly dependsOn?: readonly string[];
  readonly implementation?: string;
  // D-8: amending a fixture spec's content is what drifts its pin.
  readonly content?: string;
}

// One fixture target: a temp directory standing in for a governed repo, its
// own mutable spec registry (flipping a spec to pending here is exactly what
// B-4's scan is supposed to notice), and the stage calls driven against it.
class FixtureRepo {
  readonly repoDir: string;
  readonly stateRoot: string;
  readonly stageCalls: string[] = [];
  specs: Record<string, FixtureSpec>;

  constructor(prefix: string, specs: Record<string, FixtureSpec>) {
    this.repoDir = freshDir(prefix);
    this.stateRoot = projectStateRoot(this.repoDir);
    this.specs = specs;
  }

  get dagReader(): DagReader {
    return {
      registryListJson: () =>
        JSON.stringify(
          Object.entries(this.specs).map(([id, s]) => ({
            id,
            implementation: s.implementation ?? "pending",
            dependsOn: s.dependsOn ?? [],
          }))
        ),
      registryShowJson: (_repoDir: string, specId: string) => {
        const spec = this.specs[specId];
        if (!spec) throw new Error(`fixture: unknown spec ${specId}`);
        return JSON.stringify({ id: specId, implementation: spec.implementation ?? "pending", dependsOn: spec.dependsOn ?? [] });
      },
      readSpecFile: (_repoDir: string, specId: string) =>
        Buffer.from(this.specs[specId]?.content ?? `fixture content for ${specId}\n`, "utf8"),
    };
  }
}

// --- throwing stubs (the seams faked stage fns bypass entirely) -------------

function throwingRunner(): Runner {
  const fail =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`standby test: Runner.${name} must not be called`);
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
      throw new Error("standby test: Runner.runSession must not be called");
    },
  };
}

function throwingGh(): GitHubClient {
  const fail =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`standby test: GitHubClient.${name} must not be called`);
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
      throw new Error(`standby test: VerifyRunner.${name} must not be called`);
    };
  return {
    addWorktree: fail("addWorktree"),
    removeWorktree: fail("removeWorktree"),
    runCommand: fail("runCommand"),
    readFile: fail("readFile"),
  };
}

function throwingBrowserVerifier(): BrowserVerifier {
  return {
    assert: async () => {
      throw new Error("standby test: BrowserVerifier.assert must not be called");
    },
  };
}

function throwingRunSession(counter: { calls: number }): typeof realRunSession {
  return (async () => {
    counter.calls++;
    throw new Error("standby test: the runSession seam must not be called directly (021 B-5)");
  }) as unknown as typeof realRunSession;
}

// --- canned stage results ----------------------------------------------------

function buildResult(specId: string, outcome: BuildResult["outcome"]): BuildResult {
  return {
    outcome,
    evidence: {
      specId,
      branch: specId,
      headSha: `${specId}-head`,
      promptVersion: 1,
      refusal: null,
      sessions: [{ sessionId: `s-${specId}-build`, classification: "completed", costMicroUsd: 10, numTurns: 1, durationMs: 1 }],
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
        {
          sessionId: `s-${specId}-ship`,
          classification: "completed",
          detail: "ok",
          stderrTail: "",
          costMicroUsd: 5,
          numTurns: 1,
          durationMs: 1,
        },
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
      needsHuman: outcome !== "passed",
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

// Every stage passes, and every call is recorded as "<project>:<stage>" in
// both the repo's own log and a shared, ordered one (which is what proves the
// scheduler's ordering, not just its outcomes).
function passingStageFns(name: string, repo: FixtureRepo, order: string[], overrides: Partial<DaemonStageFns> = {}): DaemonStageFns {
  const note = (stage: string): void => {
    repo.stageCalls.push(stage);
    order.push(`${name}:${stage}`);
  };
  return {
    build: async (options) => {
      note("build");
      return buildResult(options.specId, "passed");
    },
    ship: async (options) => {
      note("ship");
      return shipResult(options.specId, "passed");
    },
    shepherd: async (options) => {
      note("shepherd");
      return shepherdResult(options.specId, "passed", `${options.specId}-merge`);
    },
    verify: async (options) => {
      note("verify");
      return verifyResult(options.specId, options.sha, "not-declared");
    },
    ...overrides,
  };
}

// --- world -------------------------------------------------------------------

function qualifiedVerdict(): QualificationVerdict {
  return {
    qualified: true,
    checks: [{ id: "git-repo", ok: true, detail: "fixture work tree root" }],
    warnings: [],
  };
}

interface WorldOptions {
  readonly scanIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function makeProjectDepsFactory(
  repos: Record<string, FixtureRepo>,
  stageFnsFor: (name: string, repo: FixtureRepo) => DaemonStageFns,
  runSessionCounter: { calls: number }
): (project: Project) => DaemonDeps {
  return (project: Project): DaemonDeps => {
    const repo = repos[project.name];
    if (!repo) throw new Error(`standby test: no fixture repo for project ${project.name}`);
    return {
      dataDir: repo.stateRoot,
      repoDir: repo.repoDir,
      supervised: true,
      dagReader: repo.dagReader,
      // 021 D-18's prior-shipped requalification refuses without a readable
      // head sha; fixtures name one so D-8's healing can reach the verify fn.
      readHeadSha: () => "fixture-head-sha",
      runner: throwingRunner(),
      gh: throwingGh(),
      verifyRunner: throwingVerifyRunner(),
      browserVerifier: throwingBrowserVerifier(),
      runSession: throwingRunSession(runSessionCounter),
      processInspector: createProcessInspector(),
      clock: { now: () => Date.now() },
      sleep: (ms: number) => Bun.sleep(ms),
      rng: () => 0,
      stageFns: stageFnsFor(project.name, repo),
      sleepChunkMs: 5,
      resumeJitterMinMs: 1,
      resumeJitterMaxMs: 2,
    };
  };
}

// Registers the fixture repos into a fresh daemon home, in the order given.
function seedRegistry(homeDir: string, repos: readonly (readonly [string, FixtureRepo])[], disarmed: readonly string[] = []): void {
  const chain = openProjectsChain(homeDir);
  try {
    for (const [name, repo] of repos) {
      registerProject({ chain, repoDir: repo.repoDir, qualification: qualifiedVerdict(), source: "cli", name });
    }
    for (const name of disarmed) setProjectArmed({ chain, name, armed: false, source: "cli" });
  } finally {
    chain.close();
  }
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`standby test: timed out waiting for ${label}`);
}

function shippedSpecIds(stateRoot: string): string[] {
  const journal = openJournal(stateRoot);
  try {
    const byKind = journal.fold().byKind;
    const creates = (byKind["specexec.created"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
    const transitions = (byKind["state.transition.outcome"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
    const shipped: string[] = [];
    for (const create of creates) {
      const last = [...transitions].reverse().find((t) => t.entity === "specExec" && t.id === create.id);
      if (last?.to === "shipped") shipped.push(create.specId as string);
    }
    return [...new Set(shipped)].sort();
  } finally {
    journal.close();
  }
}

// --- the scan interval default ----------------------------------------------

test("the standby scan interval defaults to the bounded 60 s B-4 names", () => {
  expect(DEFAULT_SCAN_INTERVAL_MS).toBe(60_000);
});

// --- B-6: a project's run deps must be supervised ---------------------------

test("a project whose deps take an identity lock of their own is refused (B-6)", async () => {
  const home = freshDir("unsupervised-home");
  const repo = new FixtureRepo("unsupervised", { "900-a": { implementation: "pending" } });
  seedRegistry(home, [["a", repo]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const factory = makeProjectDepsFactory({ a: repo }, (name, r) => passingStageFns(name, r, order), counter);

  const logs: string[] = [];
  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: (project) => ({ ...factory(project), supervised: false }),
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: (line) => logs.push(line),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });

  await standby.start();
  // The refusal surfaces as a reported project failure, never as a second
  // identity lock appearing inside the target.
  await waitFor("the refusal to be reported", () => logs.some((l) => l.includes("must set supervised: true")));
  await standby.shutdown();

  expect(repo.stageCalls).toEqual([]);
  expect(fs.existsSync(join(repo.stateRoot, "daemon.lock"))).toBe(false);
});

// --- B-7: shutdown severs the live session child (021 B-6, D-19) -------------

test("shutdown(): the scheduler severs the live session child through the killLiveSession seam", async () => {
  const home = freshDir("shutdown-kill-home");
  seedRegistry(home, []);

  let killCalls = 0;
  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: () => {
      throw new Error("no projects registered; must not be called");
    },
    killLiveSession: () => {
      killCalls++;
      return false;
    },
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });

  await standby.start();
  await standby.shutdown();
  // Called unconditionally: with no live child it reports false and costs
  // nothing; with one it is the only thing standing between a SIGTERM and
  // a stop that waits out the child's own 30-minute deadline.
  expect(killCalls).toBe(1);
});

// --- FR-001 / AC-1 -----------------------------------------------------------

test(
  "FR-001: a completed backlog leaves the daemon in standby, a newly pending spec wakes a run, a disarmed project is only observed, and a kill+restart recovers to standby",
  async () => {
    const home = freshDir("fr001-home");
    const alpha = new FixtureRepo("fr001-alpha", { "900-alpha": { implementation: "pending" } });
    const beta = new FixtureRepo("fr001-beta", { "800-beta-base": { implementation: "complete" } });
    const gamma = new FixtureRepo("fr001-gamma", { "900-gamma": { implementation: "pending" } });

    seedRegistry(
      home,
      [
        ["alpha", alpha],
        ["beta", beta],
        ["gamma", gamma],
      ],
      ["gamma"]
    );

    const repos = { alpha, beta, gamma };
    const order: string[] = [];
    const counter = { calls: 0 };
    const factory = makeProjectDepsFactory(repos, (name, repo) => passingStageFns(name, repo, order), counter);

    // The kill simulation: once wedged, the scheduler's own standby wait
    // never resolves, so the first daemon holds every lock and journals
    // nothing further, exactly as an abruptly killed process looks on disk.
    let wedged = false;
    const wedgeableSleep = (ms: number): Promise<void> => (wedged ? new Promise<void>(() => {}) : Bun.sleep(ms));

    const logs: string[] = [];
    const first = new StandbyDaemon({
      daemonHomeDir: home,
      makeProjectDeps: factory,
      processInspector: createProcessInspector(),
      clock: { now: () => Date.now() },
      sleep: wedgeableSleep,
      log: (line) => logs.push(line),
      scanIntervalMs: 20,
      sleepChunkMs: 5,
    });

    await first.start();

    // B-1: alpha's backlog completes and the daemon does not die of success.
    await waitFor("alpha to ship and the daemon to reach standby", () => first.state === "standby" && alpha.stageCalls.length === 4);
    expect(alpha.stageCalls).toEqual(["build", "ship", "shepherd", "verify"]);
    expect(beta.stageCalls).toEqual([]);

    // D-2: a disarmed project with ready work is reported, never driven.
    const gammaView = first.snapshot.projects.find((p) => p.name === "gamma");
    expect(gammaView?.disposition).toBe("disarmed");
    expect(gammaView?.pendingSpecIds).toEqual(["900-gamma"]);
    expect(gammaView?.detail).toContain("not driven");

    // B-4: a spec flipping to pending in an armed project wakes a run.
    beta.specs = { ...beta.specs, "901-beta": { implementation: "pending" } };
    await waitFor("beta's newly pending spec to wake a run", () => beta.stageCalls.length === 4);
    await waitFor("the daemon to settle back into standby", () => first.state === "standby");
    expect(order.slice(0, 8)).toEqual([
      "alpha:build",
      "alpha:ship",
      "alpha:shepherd",
      "alpha:verify",
      "beta:build",
      "beta:ship",
      "beta:shepherd",
      "beta:verify",
    ]);
    expect(gamma.stageCalls).toEqual([]);
    // B-5's inherited clause: the scan itself never drives a session.
    expect(counter.calls).toBe(0);

    // The kill, during standby, followed by the supervisor's own force
    // release (this same live process never actually died, so the identity
    // check would honestly refuse a second daemon otherwise).
    wedged = true;
    await Bun.sleep(60);
    forceReleaseStandbyLocks(home, [alpha.stateRoot, beta.stateRoot, gamma.stateRoot]);

    const second = new StandbyDaemon({
      daemonHomeDir: home,
      makeProjectDeps: factory,
      processInspector: createProcessInspector(),
      clock: { now: () => Date.now() },
      sleep: (ms: number) => Bun.sleep(ms),
      log: (line) => logs.push(line),
      scanIntervalMs: 20,
      sleepChunkMs: 5,
    });

    await second.start();
    await waitFor("the restarted daemon to reach standby", () => second.state === "standby");
    // Both projects are back under observation, with nothing left to build:
    // their shipped specs are read out of their own journals, not from the
    // registry fixtures (which still honestly report the specs as pending,
    // since a fake build stage flips no frontmatter).
    expect(second.snapshot.projects.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    await second.shutdown();
    expect(second.state).toBe("stopped");

    expect(shippedSpecIds(alpha.stateRoot)).toEqual(["900-alpha"]);
    expect(shippedSpecIds(beta.stateRoot)).toEqual(["901-beta"]);
    expect(verifyChain(alpha.stateRoot)).toEqual(expect.objectContaining({ ok: true }));
    expect(verifyChain(beta.stateRoot)).toEqual(expect.objectContaining({ ok: true }));
    // Nothing was ever journaled inside the disarmed target.
    expect(fs.existsSync(join(gamma.stateRoot, "journal.jsonl"))).toBe(false);
  },
  20_000
);

// --- FR-002 / AC-1 -----------------------------------------------------------

test(
  "FR-002: a run paused on needsHuman releases the flight slot, and its retry resumes it before any new run starts",
  async () => {
    const home = freshDir("fr002-home");
    // Registration order is the whole scheduling policy (D-1), so the project
    // that gains new work sits first: only B-3's priority half can explain
    // the paused run being resumed ahead of it.
    const one = new FixtureRepo("fr002-one", { "800-one-base": { implementation: "complete" } });
    const two = new FixtureRepo("fr002-two", { "900-two": { implementation: "pending" } });
    const three = new FixtureRepo("fr002-three", { "900-three": { implementation: "pending" } });

    seedRegistry(home, [
      ["one", one],
      ["two", two],
      ["three", three],
    ]);

    const order: string[] = [];
    const counter = { calls: 0 };
    let shepherdBlocksForTwo = true;

    const factory = makeProjectDepsFactory(
      { one, two, three },
      (name, repo) =>
        passingStageFns(name, repo, order, {
          shepherd: async (options) => {
            repo.stageCalls.push("shepherd");
            order.push(`${name}:shepherd`);
            if (name === "two" && shepherdBlocksForTwo) {
              shepherdBlocksForTwo = false;
              return shepherdResult(options.specId, "blocked", null);
            }
            return shepherdResult(options.specId, "passed", `${options.specId}-merge`);
          },
        }),
      counter
    );

    const standby = new StandbyDaemon({
      daemonHomeDir: home,
      makeProjectDeps: factory,
      processInspector: createProcessInspector(),
      clock: { now: () => Date.now() },
      sleep: (ms: number) => Bun.sleep(ms),
      log: () => {},
      scanIntervalMs: 20,
      sleepChunkMs: 5,
    });

    await standby.start();

    // B-3: two pauses on the blocked shepherd, gives the slot back, and three
    // proceeds while two waits on a human.
    await waitFor("three to run while two sits paused", () => three.stageCalls.length === 4);
    await waitFor("the daemon to reach standby", () => standby.state === "standby");

    const pausedDaemon = standby.daemonFor("two");
    expect(pausedDaemon).not.toBeNull();
    expect(pausedDaemon!.runStatus).toBe("paused");
    expect(standby.snapshot.projects.find((p) => p.name === "two")?.disposition).toBe("paused");
    expect(order).toEqual([
      "two:build",
      "two:ship",
      "two:shepherd",
      "three:build",
      "three:ship",
      "three:shepherd",
      "three:verify",
    ]);
    expect(one.stageCalls).toEqual([]);

    // The retry and a brand new backlog for the first-registered project land
    // together; only the priority half of B-3 can make two go first.
    one.specs = { ...one.specs, "901-one": { implementation: "pending" } };
    pausedDaemon!.retryStage("900-two", "test-source");

    await waitFor("one's new backlog to be built", () => one.stageCalls.length === 4);
    await waitFor("the daemon to settle back into standby", () => standby.state === "standby");

    const resumedShepherd = order.indexOf("two:shepherd", order.indexOf("two:shepherd") + 1);
    expect(resumedShepherd).toBeGreaterThan(-1);
    expect(resumedShepherd).toBeLessThan(order.indexOf("one:build"));
    expect(order.slice(resumedShepherd)).toEqual([
      "two:shepherd",
      "two:verify",
      "one:build",
      "one:ship",
      "one:shepherd",
      "one:verify",
    ]);

    await standby.shutdown();

    expect(shippedSpecIds(two.stateRoot)).toEqual(["900-two"]);
    expect(shippedSpecIds(three.stateRoot)).toEqual(["900-three"]);
    expect(shippedSpecIds(one.stateRoot)).toEqual(["901-one"]);
    expect(counter.calls).toBe(0);
  },
  20_000
);

// --- B-5: quota parking is global -------------------------------------------

test("a parked run keeps the flight slot, so no other project starts a session while parked (B-5)", async () => {
  const home = freshDir("park-home");
  const parker = new FixtureRepo("park-parker", { "900-parker": { implementation: "pending" } });
  const other = new FixtureRepo("park-other", { "900-other": { implementation: "pending" } });

  seedRegistry(home, [
    ["parker", parker],
    ["other", other],
  ]);

  const order: string[] = [];
  const counter = { calls: 0 };
  let parkerBuilds = 0;

  const factory = makeProjectDepsFactory(
    { parker, other },
    (name, repo) =>
      passingStageFns(name, repo, order, {
        build: async (options) => {
          repo.stageCalls.push("build");
          order.push(`${name}:build`);
          if (name !== "parker") return buildResult(options.specId, "passed");
          parkerBuilds++;
          if (parkerBuilds > 1) return buildResult(options.specId, "passed");
          const quota = buildResult(options.specId, "failed");
          return {
            ...quota,
            evidence: { ...quota.evidence, sessions: [{ ...quota.evidence.sessions[0]!, classification: "quota" as const }] },
          };
        },
      }),
    counter
  );

  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: factory,
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: () => {},
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });

  await standby.start();
  await waitFor("the parker's quota park", () => standby.activeDaemon?.runStatus === "parked");

  // The park horizon is hours away, so the only thing that could put another
  // project's stage on the wire here is the scheduler moving on. It must not.
  await Bun.sleep(120);
  expect(other.stageCalls).toEqual([]);
  expect(standby.activeDaemon?.runStatus).toBe("parked");

  // B-7: SIGTERM mid-run inherits 021 B-6 exactly, park included.
  await standby.shutdown();
  expect(other.stageCalls).toEqual([]);
  expect(standby.state).toBe("stopped");
});

// --- D-5: reverify wakes a daemon for a project nothing is driving ----------

test("openForControl wakes a project daemon and the next cycle drives its queued reverify (D-5)", async () => {
  const home = freshDir("wake-home");
  const alpha = new FixtureRepo("wake-alpha", { "800-done": { implementation: "complete" } });
  seedRegistry(home, [["alpha", alpha]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const factory = makeProjectDepsFactory({ alpha }, (name, repo) => passingStageFns(name, repo, order), counter);

  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: factory,
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: () => {},
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });

  await standby.start();
  // The backlog is already complete, so the scan settles without driving.
  await waitFor("the idle settle", () => standby.state === "standby");

  const daemon = await standby.openForControl("alpha");
  expect(daemon).not.toBeNull();
  daemon!.reverify("800-done", "test");

  // The priority half drives the woken daemon for its queued control on the
  // next cycle; the drive concludes and retires the daemon, releasing its
  // journals. With no shipped exec anywhere the reverify is refused
  // honestly, which exercises the wake machinery end to end.
  await waitFor("the drive to conclude", () => standby.daemonFor("alpha") === null, 10_000);

  const journal = openJournal(alpha.stateRoot);
  try {
    const fold = journal.fold();
    expect((fold.byKind["control.reverify"] ?? []).length).toBeGreaterThan(0);
    expect((fold.byKind["control.reverify.refused"] ?? []).length).toBeGreaterThan(0);
  } finally {
    journal.close();
  }
  await standby.shutdown();
  expect(standby.state).toBe("stopped");
});

// --- D-3: the virgin-registry bootstrap -------------------------------------

test("a virgin registry chain adopts the checkout the daemon was pointed at as its first project (D-3)", async () => {
  const home = freshDir("bootstrap-home");
  const repo = new FixtureRepo("bootstrap-target", { "900-boot": { implementation: "complete" } });

  const logs: string[] = [];
  const counter = { calls: 0 };
  const order: string[] = [];
  const repos: Record<string, FixtureRepo> = {};

  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: (project) => {
      repos[project.name] = repo;
      return makeProjectDepsFactory(repos, (name, r) => passingStageFns(name, r, order), counter)(project);
    },
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: (line) => logs.push(line),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
    bootstrap: {
      repoDir: repo.repoDir,
      probe: {
        gitPrefix: () => "",
        originUrl: () => "git@example.invalid:fixture/target.git",
        defaultBranch: () => "main",
        compile: () => ({ exitCode: 0, stderrTail: "" }),
        specCount: () => 1,
        dataIgnored: () => true,
      },
    },
  });

  await standby.start();
  await waitFor("the bootstrapped daemon to reach standby", () => standby.state === "standby");

  const name = [...standby.projects.keys()][0];
  expect(name).toBeDefined();
  expect(standby.projects.get(name!)?.repoDir).toBe(repo.repoDir);
  expect(standby.projects.get(name!)?.armed).toBe(true);
  expect(standby.projects.get(name!)?.qualification.qualified).toBe(true);
  expect(logs.some((l) => l.includes("as the first project"))).toBe(true);

  await standby.shutdown();

  // A registry that has ever held a record is the operator's: a second boot
  // registers nothing, even though this one project could be removed later.
  const chain = openProjectsChain(home);
  const registeredCount = (chain.fold().byKind["project.registered"] ?? []).length;
  chain.close();
  expect(registeredCount).toBe(1);
});

// --- D-7: the code-staleness gate --------------------------------------------

test("a moved code checkout freezes driving until it matches again (D-7)", async () => {
  const home = freshDir("code-stale-home");
  const repo = new FixtureRepo("code-stale", { "900-a": { implementation: "pending" } });
  seedRegistry(home, [["a", repo]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const factory = makeProjectDepsFactory({ a: repo }, (name, r) => passingStageFns(name, r, order), counter);
  const codeSha = { value: "sha-started-from" };

  const logs: string[] = [];
  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: factory,
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: (line) => logs.push(line),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
    readCodeSha: () => codeSha.value,
  });

  await standby.start();
  await waitFor("the first backlog to ship while the code is fresh", () => repo.stageCalls.length === 4);

  // The checkout moves under the running process; new pending work appears.
  codeSha.value = "sha-moved-away00";
  repo.specs = { ...repo.specs, "901-a": { implementation: "pending" } };
  await waitFor("the staleness announcement", () => logs.some((l) => l.includes("code-stale")));
  await Bun.sleep(100);
  expect(repo.stageCalls.length).toBe(4);
  expect(standby.snapshot.codeStale).toEqual({ startedSha: "sha-started-from", currentSha: "sha-moved-away00" });
  const view = standby.snapshot.projects.find((p) => p.name === "a");
  expect(view?.detail).toContain("code-stale");
  expect(view?.detail).toContain("restart to drive");

  // Freshness is re-read, not latched: the checkout moved back resumes
  // driving without a restart.
  codeSha.value = "sha-started-from";
  await waitFor("driving to resume once the code matches again", () => repo.stageCalls.length === 8);
  expect(logs.some((l) => l.includes("matches its checkout again"))).toBe(true);
  expect(standby.snapshot.codeStale).toBeNull();

  await standby.shutdown();
});

// --- D-8: amendment cascades heal without an operator verb -------------------

test("an amended pipeline-shipped spec is reverified automatically and re-pinned (D-8, 021 D-22)", async () => {
  const home = freshDir("auto-reverify-home");
  const repo = new FixtureRepo("auto-reverify", { "900-a": { implementation: "pending" } });
  seedRegistry(home, [["a", repo]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const factory = makeProjectDepsFactory({ a: repo }, (name, r) => passingStageFns(name, r, order), counter);

  const logs: string[] = [];
  const standby = new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: factory,
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: (line) => logs.push(line),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });

  await standby.start();
  await waitFor("the spec to ship through the pipeline", () => repo.stageCalls.length === 4);
  await waitFor("the daemon to settle into standby", () => standby.state === "standby");

  // The amendment: implementation flips complete (nothing pending) and the
  // content drifts the pin. No operator verb follows.
  repo.specs = { "900-a": { implementation: "complete", content: "amended spec content\n" } };
  await waitFor(
    "the amendment to be reverified without an operator verb",
    () => repo.stageCalls.filter((s) => s === "verify").length === 2
  );
  await waitFor("the healing run to conclude", () => standby.state === "standby");

  // Heal only: no second build or ship, and the journal carries the
  // automatic control plus the re-pin at the amended content.
  expect(repo.stageCalls).toEqual(["build", "ship", "shepherd", "verify", "verify"]);
  const journal = openJournal(repo.stateRoot);
  try {
    const byKind = journal.fold().byKind;
    const controls = (byKind["control.reverify"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
    expect(controls.some((p) => p.specId === "900-a" && p.source === "standby-auto")).toBe(true);
    const requalified = (byKind["spec.requalified"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
    expect(requalified.length).toBe(1);
    expect(requalified[0]?.specId).toBe("900-a");
    expect(typeof requalified[0]?.pin).toBe("string");
  } finally {
    journal.close();
  }
  expect(logs.some((l) => l.includes('"a" corpus amended; 1 reverify(ies) queued'))).toBe(true);

  await standby.shutdown();
});

// --- D-9: the amendment probe's run concludes instead of stranding -----------

function makeQuietStandby(home: string, repos: Record<string, FixtureRepo>, order: string[], counter: { calls: number }, logs: string[]): StandbyDaemon {
  return new StandbyDaemon({
    daemonHomeDir: home,
    makeProjectDeps: makeProjectDepsFactory(repos, (name, r) => passingStageFns(name, r, order), counter),
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    log: (line) => logs.push(line),
    scanIntervalMs: 20,
    sleepChunkMs: 5,
  });
}

test("a zero-queued probe of a fully complete corpus concludes its run as completed (D-9, 021 D-23)", async () => {
  const home = freshDir("probe-conclude-home");
  const repo = new FixtureRepo("probe-conclude", { "910-a": { implementation: "complete" } });
  seedRegistry(home, [["a", repo]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const logs: string[] = [];
  const standby = makeQuietStandby(home, { a: repo }, order, counter, logs);

  await standby.start();
  await waitFor("the probe cycle to settle into standby", () => standby.state === "standby");
  await standby.shutdown();

  // The probe cost no session and drove nothing.
  expect(repo.stageCalls).toEqual([]);
  expect(counter.calls).toBe(0);
  expect(logs.some((l) => l.includes('driving "a"'))).toBe(false);

  // The run its open journaled is terminal, not stranded reading as live.
  const journal = openJournal(repo.stateRoot);
  try {
    const byKind = journal.fold().byKind;
    expect((byKind["run.created"] ?? []).length).toBe(1);
    const results = (byKind["run.result"] ?? []).map((r) => r.payload as Record<string, JsonValue>);
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("completed");
    const runOutcomes = (byKind["state.transition.outcome"] ?? [])
      .map((r) => r.payload as Record<string, JsonValue>)
      .filter((p) => p.entity === "run");
    expect(runOutcomes.at(-1)?.to).toBe("completed");
    expect(verifyChain(repo.stateRoot).ok).toBe(true);
  } finally {
    journal.close();
  }
});

test("a run stranded in running by a pre-D-9 probe heals at the next open (D-9)", async () => {
  const home = freshDir("probe-heal-home");
  const repo = new FixtureRepo("probe-heal", { "911-a": { implementation: "complete" } });
  seedRegistry(home, [["a", repo]]);

  // The pre-fix wound: a run journaled into "running" whose journals were
  // closed around it, exactly what the zero-queued retire used to leave.
  const seeded = openJournal(repo.stateRoot);
  try {
    const run = createRun(seeded, repo.repoDir);
    transition(seeded, run, "running");
  } finally {
    seeded.close();
  }

  const order: string[] = [];
  const counter = { calls: 0 };
  const logs: string[] = [];
  const standby = makeQuietStandby(home, { a: repo }, order, counter, logs);

  await standby.start();
  await waitFor("the stranded run to heal", () => standby.state === "standby");
  await standby.shutdown();

  const journal = openJournal(repo.stateRoot);
  try {
    const byKind = journal.fold().byKind;
    // Resumed, not replaced: recovery adopted the stranded run and the
    // probe concluded it, so no second run was ever created.
    expect((byKind["run.created"] ?? []).length).toBe(1);
    const runOutcomes = (byKind["state.transition.outcome"] ?? [])
      .map((r) => r.payload as Record<string, JsonValue>)
      .filter((p) => p.entity === "run");
    expect(runOutcomes.at(-1)?.to).toBe("completed");
  } finally {
    journal.close();
  }
  expect(counter.calls).toBe(0);
  expect(repo.stageCalls).toEqual([]);
});

test("a probe that resumed a paused run drives it back to a live pause instead of abandoning it (D-9)", async () => {
  const home = freshDir("probe-paused-home");
  const repo = new FixtureRepo("probe-paused", { "912-a": { implementation: "complete" } });
  seedRegistry(home, [["a", repo]]);

  // A run paused on a human decision when its daemon died: non-terminal, so
  // the probe's recovery resumes it, and concludeIdle() must refuse it.
  const seeded = openJournal(repo.stateRoot);
  try {
    const run = createRun(seeded, repo.repoDir);
    const running = transition(seeded, run, "running");
    transition(seeded, running, "paused");
  } finally {
    seeded.close();
  }

  const order: string[] = [];
  const counter = { calls: 0 };
  const logs: string[] = [];
  const standby = makeQuietStandby(home, { a: repo }, order, counter, logs);

  await standby.start();
  await waitFor(
    "the paused run to come back live under the scheduler",
    () => logs.some((l) => l.includes("paused; flight slot released"))
  );
  await waitFor(
    "the view to report the pause",
    () => standby.snapshot.projects.find((p) => p.name === "a")?.disposition === "paused"
  );

  // Driven to its honest resting state, not concluded and not abandoned:
  // the pause waits for a human, and no session was ever spawned for it.
  expect(counter.calls).toBe(0);
  expect(repo.stageCalls).toEqual([]);
  expect(logs.some((l) => l.includes('driving "a"'))).toBe(true);

  await standby.shutdown();
});

// --- D-11: a journaled control outlives the daemon that received it ----------

test("a retry journaled before a daemon death lifts the recovered pause at the next open (D-11, 021 D-24)", async () => {
  const home = freshDir("control-survives-home");
  const repo = new FixtureRepo("control-survives", { "915-a": { implementation: "pending" } });
  seedRegistry(home, [["a", repo]]);

  // The tenant-tail wound: a run paused on a human decision, the operator's
  // retry journaled, and the process dead before any drive applied it.
  const seeded = openJournal(repo.stateRoot);
  try {
    const run = createRun(seeded, repo.repoDir);
    const running = transition(seeded, run, "running");
    transition(seeded, running, "paused");
    seeded.append("control.retryStage", { specId: "915-a", source: "cli", restorable: true });
  } finally {
    seeded.close();
  }

  const order: string[] = [];
  const counter = { calls: 0 };
  const logs: string[] = [];
  const standby = makeQuietStandby(home, { a: repo }, order, counter, logs);
  await standby.start();

  // Pre-D-24 this idled paused forever (the retry evaporated with its
  // process); now the open restores it, the drive applies it, and the
  // pending spec ships in the same resumed run.
  await waitFor("the restored retry to lift the pause and build", () => repo.stageCalls.length === 4, 10_000);
  await waitFor("the run to conclude", () => standby.state === "standby");
  expect(repo.stageCalls).toEqual(["build", "ship", "shepherd", "verify"]);
  expect(counter.calls).toBe(0);

  const journal = openJournal(repo.stateRoot);
  try {
    const byKind = journal.fold().byKind;
    expect((byKind["daemon.controls.restored"] ?? []).length).toBe(1);
    expect((byKind["control.applied"] ?? []).length).toBeGreaterThanOrEqual(1);
  } finally {
    journal.close();
  }

  await standby.shutdown();
});

// --- D-10: a paused run with queued reverifies idles instead of hot-looping --

test("a recovered pause over a drifted corpus idles in standby, then heals and builds on resume (D-10)", async () => {
  const home = freshDir("paused-drift-home");
  const repo = new FixtureRepo("paused-drift", { "913-a": { implementation: "pending" } });
  seedRegistry(home, [["a", repo]]);

  const order: string[] = [];
  const counter = { calls: 0 };
  const logs: string[] = [];
  const first = makeQuietStandby(home, { a: repo }, order, counter, logs);

  // Phase 1: ship 913-a through the pipeline so the journal pins it.
  await first.start();
  await waitFor("the spec to ship through the pipeline", () => repo.stageCalls.length === 4);
  await waitFor("the first daemon to settle into standby", () => first.state === "standby");
  await first.shutdown();

  // The incident shape (2026-08-06): the daemon died leaving a paused run,
  // and by the next restart the corpus had both a drifted shipped root and
  // new pending work, so the open queues an auto-reverify the paused loop
  // cannot drain.
  const seeded = openJournal(repo.stateRoot);
  try {
    const run = createRun(seeded, repo.repoDir);
    const running = transition(seeded, run, "running");
    transition(seeded, running, "paused");
  } finally {
    seeded.close();
  }
  repo.specs = {
    "913-a": { implementation: "complete", content: "amended spec content\n" },
    "914-b": { implementation: "pending" },
  };

  const logs2: string[] = [];
  const standby = makeQuietStandby(home, { a: repo }, order, counter, logs2);
  await standby.start();

  // The restart's one futile drive yields "paused"; the scheduler must then
  // fall through to the standby wait. Pre-D-10 it re-drove every cycle, so
  // it never idled, the starved API could not deliver the resume below, and
  // the deadlock held until SIGKILL.
  await waitFor(
    "the recovered pause to release the flight slot",
    () => logs2.some((l) => l.includes("paused; flight slot released"))
  );
  await waitFor("the scheduler to idle with the pause standing", () => standby.state === "standby");
  expect(logs2.filter((l) => l.includes('driving "a"')).length).toBe(1);
  expect(repo.stageCalls.length).toBe(4);
  expect(standby.snapshot.projects.find((p) => p.name === "a")?.disposition).toBe("paused");

  // The resume is the human decision the pause waited for; its drive drains
  // the queued reverify first, then builds the pending spec in the same run.
  standby.daemonFor("a")!.resume("test-operator");
  await waitFor("the heal-then-build run to conclude", () => repo.stageCalls.length === 9, 10_000);
  await waitFor("the daemon to settle after healing", () => standby.state === "standby");
  expect(repo.stageCalls).toEqual([
    "build",
    "ship",
    "shepherd",
    "verify",
    "verify",
    "build",
    "ship",
    "shepherd",
    "verify",
  ]);
  expect(counter.calls).toBe(0);

  await standby.shutdown();
});
