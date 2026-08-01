// Test support for the API territory (spec 027 FR-001: "route tests run
// against an in-process v2 server with a fixture registry and two fixture
// project journals"). Nothing here is imported by the served code; it exists
// so state.test.ts, events.test.ts, and server.test.ts build the same
// realistic world instead of three slightly different ones.
//
// Every chain is a real one (openJournal, hash-linked, fsynced) driven
// through the real state-machine and registry helpers, so the read models
// under test fold exactly the records a live daemon would have written, not a
// hand-shaped approximation of them. The registry is spec 025's own chain,
// folded by spec 025's own fold.
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, sha256Hex, type JournalHandle, type JsonValue } from "../journal";
import { openDecisionsChain } from "../decisions";
import { createRun, createSpecExec, createStageExec, foldOrchestratorState, transition } from "../state";
import { pinOfBytes, type DagReader } from "../dag";
import { journalPark } from "../quota";
import {
  foldProjects,
  openProjectsChain,
  registerProject,
  removeProject,
  requalifyProject,
  setProjectArmed,
  type Project,
  type ProjectSource,
  type ProjectsSnapshot,
  type QualificationVerdict,
} from "../projects";
import { journalViewFromHandle, type ApiDeps, type ControlTarget, type DaemonStatus, type ProjectApi, type ProjectsTarget } from "./server";

export interface FixtureSpec {
  readonly dependsOn?: readonly string[];
  readonly implementation?: string;
  readonly body?: string;
}

export interface FixtureDagReader extends DagReader {
  // Rewrites a spec's body, which changes its pin: the drift that spec 012
  // B-4's invalidation cascade keys off.
  amend(specId: string, body: string): void;
  pin(specId: string): string;
}

export function fixtureDagReader(specs: Record<string, FixtureSpec>): FixtureDagReader {
  const bodies = new Map<string, string>();
  for (const [id, spec] of Object.entries(specs)) {
    bodies.set(id, spec.body ?? `# ${id}\n\nfixture body\n`);
  }

  const entryFor = (id: string): JsonValue => {
    const spec = specs[id];
    if (!spec) throw new Error(`fixtureDagReader: unknown spec ${id}`);
    return { id, implementation: spec.implementation ?? "pending", dependsOn: [...(spec.dependsOn ?? [])] };
  };

  return {
    registryListJson: () => JSON.stringify(Object.keys(specs).map(entryFor)),
    registryShowJson: (_repoDir: string, specId: string) => JSON.stringify(entryFor(specId)),
    readSpecFile: (_repoDir: string, specId: string) => {
      const body = bodies.get(specId);
      if (body === undefined) throw new Error(`dag: cannot read spec file for ${specId}`);
      return Buffer.from(body, "utf8");
    },
    amend(specId: string, body: string): void {
      bodies.set(specId, body);
    },
    pin(specId: string): string {
      const body = bodies.get(specId);
      if (body === undefined) throw new Error(`fixtureDagReader: unknown spec ${specId}`);
      return pinOfBytes(Buffer.from(body, "utf8"));
    },
  };
}

// The three-spec fixture corpus every test in this territory shares:
// 001-alpha predates the orchestrator (adopted), 002-beta depends on it,
// 003-gamma depends on 002-beta.
export const FIXTURE_SPECS: Record<string, FixtureSpec> = {
  "001-alpha": { implementation: "complete" },
  "002-beta": { implementation: "pending", dependsOn: ["001-alpha"] },
  "003-gamma": { implementation: "pending", dependsOn: ["002-beta"] },
};

export interface FixtureWorld {
  readonly dir: string;
  readonly repoDir: string;
  readonly evidenceDir: string;
  readonly journal: JournalHandle;
  readonly decisions: JournalHandle;
  readonly dagReader: FixtureDagReader;
  close(): void;
}

export function freshWorld(prefix: string, specs: Record<string, FixtureSpec> = FIXTURE_SPECS): FixtureWorld {
  const dir = mkdtempSync(join(tmpdir(), `api-test-${prefix}-`));
  const evidenceDir = join(dir, "verify-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const journal = openJournal(dir);
  const decisions = openDecisionsChain(dir);
  const dagReader = fixtureDagReader(specs);
  return {
    dir,
    repoDir: dir,
    evidenceDir,
    journal,
    decisions,
    dagReader,
    close(): void {
      try {
        journal.close();
      } catch {
        // already closed
      }
      try {
        decisions.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Records the bootstrap-era adoption (spec 012 D-1, journaled once by the
// daemon per spec 021 D-4).
export function seedAdoption(world: FixtureWorld, specIds: readonly string[]): void {
  const entries = specIds.map((id) => ({ id, pin: world.dagReader.pin(id), source: "adopted" }));
  world.journal.append("dag.adopted", { entries: entries as unknown as JsonValue });
}

export interface SeededRun {
  readonly runId: string;
  readonly betaSpecExecId: string;
  readonly gammaSpecExecId: string;
  readonly evidenceHash: string;
  readonly mergeSha: string;
}

// One completed spec execution (002-beta walks build, ship, shepherd, verify
// to shipped, with real evidence on disk) followed by a live one (003-gamma
// mid-build), which is the state every read route has something to say about.
export function seedRun(world: FixtureWorld): SeededRun {
  const { journal } = world;
  seedAdoption(world, ["001-alpha"]);

  const run = transition(journal, createRun(journal, world.repoDir), "running");

  let beta = createSpecExec(journal, run.id, "002-beta", world.dagReader.pin("002-beta"));
  beta = transition(journal, beta, "building");

  const walk = (stage: "build" | "ship" | "shepherd" | "verify"): void => {
    const created = createStageExec(journal, beta.id, stage, 1);
    const running = transition(journal, created, "running");
    transition(journal, running, "passed");
  };

  walk("build");
  beta = transition(journal, beta, "shipping");
  walk("ship");
  journal.append("stage.ship.result", { specId: "002-beta", branch: "002-beta", outcome: "passed", prNumber: 7, sessionIds: [] });

  beta = transition(journal, beta, "shepherding");
  walk("shepherd");
  const mergeSha = "0".repeat(40);
  journal.append("stage.shepherd.result", {
    specId: "002-beta",
    branch: "002-beta",
    outcome: "passed",
    prNumber: 7,
    mergeSha,
    watchAttempts: 1,
    remediationsUsed: 0,
    needsHuman: false,
    statuslessAbort: null,
  });
  journal.append("daemon.merge-sha", { specId: "002-beta", mergeSha });

  beta = transition(journal, beta, "verifying");
  walk("verify");
  const evidenceText = "$ bun test\n\n--- stdout ---\nok\n--- stderr ---\n";
  const evidenceHash = sha256Hex(evidenceText);
  fs.writeFileSync(join(world.evidenceDir, `${evidenceHash}.txt`), evidenceText);
  journal.append("stage.verify.cli", {
    specId: "002-beta",
    sha: mergeSha,
    blockIndex: 0,
    commandIndex: 0,
    command: "bun test",
    exitCode: 0,
    timedOut: false,
    evidenceHash,
  });
  journal.append("stage.verify.result", { specId: "002-beta", sha: mergeSha, outcome: "passed", needsHuman: false });
  beta = transition(journal, beta, "shipped");

  let gamma = createSpecExec(journal, run.id, "003-gamma", world.dagReader.pin("003-gamma"));
  gamma = transition(journal, gamma, "building");
  const gammaBuild = createStageExec(journal, gamma.id, "build", 1);
  transition(journal, gammaBuild, "running");

  journal.append("daemon.heartbeat", { runId: run.id, runStatus: "running", ts: 1_700_000_000_000 });

  return { runId: run.id, betaSpecExecId: beta.id, gammaSpecExecId: gamma.id, evidenceHash, mergeSha };
}

// Parks the run on quota with a fixed target, the shape spec 015 B-2
// journals.
export function seedPark(world: FixtureWorld, targetMs: number, consecutiveQuotaParks = 1, estimated = true): void {
  journalPark(world.journal, { targetMs, estimated, consecutiveQuotaParks });
}

// A control target that journals exactly the kinds spec 021 B-4's Daemon
// journals, under the same state guards (pause requires a running run,
// resume a paused one) and, like the Daemon, without transitioning anything
// itself: the real loop applies a queued control at its next checkpoint, so
// the run's own status lags the control record by design. Route tests
// therefore exercise the real "diff the journal to find the control record"
// path without booting a daemon and its four stage seams; server.test.ts
// additionally proves at compile time that the real Daemon satisfies the
// ControlTarget interface these mirror.
export function fixtureControls(journal: JournalHandle): ControlTarget {
  const currentRun = () => {
    const state = foldOrchestratorState(journal.fold().records);
    return [...state.runs.values()].sort((a, b) => a.createdTs.localeCompare(b.createdTs)).at(-1) ?? null;
  };

  return {
    pause(source: string): void {
      const run = currentRun();
      if (run?.status !== "running") {
        throw new Error(`daemon: pause() requires the run to be "running" (current: "${run?.status ?? "none"}")`);
      }
      journal.append("control.pause", { runId: run.id, source });
    },
    resume(source: string): void {
      const run = currentRun();
      if (run?.status !== "paused") {
        throw new Error(`daemon: resume() requires the run to be "paused" (current: "${run?.status ?? "none"}")`);
      }
      journal.append("control.resume", { runId: run.id, source });
    },
    skipSpec(specId: string, source: string): void {
      journal.append("control.skipSpec", { specId, source });
    },
    retryStage(specId: string, source: string): void {
      journal.append("control.retryStage", { specId, source });
    },
    reverify(specId: string, source: string): void {
      journal.append("control.reverify", { specId, source });
    },
    forceHumanGate(specId: string, source: string): void {
      journal.append("control.forceHumanGate", { specId, source });
    },
    approve(specId: string, source: string): void {
      journal.append("control.approve", { specId, source });
    },
  };
}

// --- the fixture registry (spec 027 FR-001) ---------------------------------

// A qualification verdict shaped like spec 025's own probe would produce,
// without shelling out to git and spec-spine: the API only ever reads a
// recorded verdict back, so the checks below are the shape it reads, and the
// unqualified variant carries its reason exactly as 025 B-4 requires.
export function fixtureQualification(qualified = true): QualificationVerdict {
  if (qualified) {
    return {
      qualified: true,
      checks: [
        { id: "git-repo", ok: true, detail: "git work tree root" },
        { id: "specs-present", ok: true, detail: "3 spec(s) under specs/" },
      ],
      warnings: [],
    };
  }
  return {
    qualified: false,
    checks: [
      { id: "git-repo", ok: true, detail: "git work tree root" },
      { id: "origin-remote", ok: false, detail: `no "origin" remote` },
    ],
    warnings: ["this target does not gitignore data/"],
  };
}

export interface FixtureProjectOptions {
  readonly armed?: boolean;
  readonly qualified?: boolean;
  // A project with no live run has no controls attached, which is what the
  // daemon reports for one sitting in the registry untouched.
  readonly controls?: boolean;
  readonly specs?: Record<string, FixtureSpec>;
}

export interface FixtureRegistry {
  // The daemon home (010 D13): the registry chain lives here, and no
  // project's state root does.
  readonly dir: string;
  readonly chain: JournalHandle;
  readonly target: ProjectsTarget;
  // A state root the registry can be pointed at, created but not registered:
  // what a `POST /api/projects` test needs to have somewhere to register.
  world(prefix: string, specs?: Record<string, FixtureSpec>): FixtureWorld;
  // Create and register in one step, the ordinary case.
  add(name: string, options?: FixtureProjectOptions): FixtureWorld;
  worldFor(name: string): FixtureWorld;
  projects(): ProjectsSnapshot;
  close(): void;
}

// The registry every route test runs against. `resourcesFor` keys on repoDir
// rather than name, so a project registered through the API itself (whose
// name the chain derives) still resolves to the world its path belongs to.
export function freshRegistry(prefix: string): FixtureRegistry {
  const dir = mkdtempSync(join(tmpdir(), `api-home-${prefix}-`));
  const chain = openProjectsChain(dir);
  const worlds = new Map<string, { world: FixtureWorld; controls: ControlTarget | null }>();

  const projects = (): ProjectsSnapshot => foldProjects(chain.fold().records);

  const target: ProjectsTarget = {
    chain: journalViewFromHandle(chain),
    projects,
    resourcesFor(project: Project): ProjectApi {
      const entry = worlds.get(project.repoDir);
      if (entry === undefined) throw new Error(`fixtures: no world for ${project.repoDir}`);
      return {
        journal: journalViewFromHandle(entry.world.journal),
        decisions: journalViewFromHandle(entry.world.decisions),
        dagReader: entry.world.dagReader,
        repoDir: entry.world.repoDir,
        evidenceDir: entry.world.evidenceDir,
        controls: entry.controls,
      };
    },
    register(path: string, name: string | undefined, source: ProjectSource): void {
      registerProject({
        chain,
        repoDir: path,
        qualification: fixtureQualification(true),
        source,
        ...(name === undefined ? {} : { name }),
      });
    },
    setArmed(name: string, armed: boolean, source: ProjectSource): void {
      setProjectArmed({ chain, name, armed, source });
    },
    requalify(name: string, source: ProjectSource): void {
      requalifyProject({ chain, name, qualification: fixtureQualification(true), source });
    },
    remove(name: string, source: ProjectSource): void {
      removeProject({ chain, name, source });
    },
  };

  const registry: FixtureRegistry = {
    dir,
    chain,
    target,
    world(worldPrefix: string, specs: Record<string, FixtureSpec> = FIXTURE_SPECS): FixtureWorld {
      const world = freshWorld(worldPrefix, specs);
      worlds.set(world.repoDir, { world, controls: fixtureControls(world.journal) });
      return world;
    },
    add(name: string, options: FixtureProjectOptions = {}): FixtureWorld {
      const world = registry.world(name, options.specs ?? FIXTURE_SPECS);
      if (options.controls === false) worlds.set(world.repoDir, { world, controls: null });
      registerProject({
        chain,
        repoDir: world.repoDir,
        name,
        armed: options.armed ?? true,
        qualification: fixtureQualification(options.qualified ?? true),
        source: "cli",
      });
      return world;
    },
    worldFor(name: string): FixtureWorld {
      const project = projects().get(name);
      const entry = project === undefined ? undefined : worlds.get(project.repoDir);
      if (entry === undefined) throw new Error(`fixtures: no registered world named "${name}"`);
      return entry.world;
    },
    projects,
    close(): void {
      try {
        chain.close();
      } catch {
        // already closed
      }
      for (const entry of worlds.values()) entry.world.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  return registry;
}

// A scheduler status source shaped like spec 026's own snapshot, so
// `/api/meta` has a daemon to describe without one being booted.
export function fixtureDaemon(status: Partial<DaemonStatus> = {}): { status(): DaemonStatus } {
  const resolved: DaemonStatus = {
    state: "standby",
    activeProject: null,
    scanIntervalMs: 60_000,
    lastScanMs: null,
    ...status,
  };
  return { status: () => resolved };
}

// The deps a route test hands `createApiServer`: a registry, a daemon to
// report, and a pump that does not tick on its own unless the test asks.
export function fixtureApiDeps(registry: FixtureRegistry, overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    projects: registry.target,
    daemon: fixtureDaemon(),
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  };
}
