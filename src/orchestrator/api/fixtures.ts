// Test support for the API territory (spec 022 FR-001: "route tests run
// against an in-process server with a fixture journal"). Nothing here is
// imported by the served code; it exists so state.test.ts, events.test.ts,
// and server.test.ts build the same realistic journal instead of three
// slightly different ones.
//
// The journal is a real one (openJournal, hash-linked, fsynced) driven
// through the real state-machine helpers, so the read models under test fold
// exactly the records a live daemon would have written, not a hand-shaped
// approximation of them.
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, sha256Hex, type JournalHandle, type JsonValue } from "../journal";
import { openDecisionsChain } from "../decisions";
import { createRun, createSpecExec, createStageExec, foldOrchestratorState, transition } from "../state";
import { pinOfBytes, type DagReader } from "../dag";
import { journalPark } from "../quota";
import type { ControlTarget } from "./server";

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
