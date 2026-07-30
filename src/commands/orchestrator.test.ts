// Spec 023 FR-001: the command group is exercised against a fixture API
// server (the real Bun.serve router from spec 022 over the shared fixture
// world, reached over real HTTP through the real typed client), and usage
// errors are checked for exit code 3 with a usage line on stderr.
//
// Nothing here stubs the client: a command test that mocked the transport
// would pass while `--url` was wired to nothing. The only seams overridden
// are the ones that would otherwise touch the operator's machine: the data
// directory, process inspection, spawn, kill, and the clock's patience.
import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "../orchestrator/journal";
import { openDecisionsChain } from "../orchestrator/decisions";
import type { ProcessInspector } from "../orchestrator/daemon";
import { createApiServer, journalViewFromHandle, type ApiServer } from "../orchestrator/api/server";
import { fixtureControls, freshWorld, seedPark, seedRun, type FixtureWorld } from "../orchestrator/api/fixtures";
import type { ApiResponse } from "../orchestrator/api/types";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  ORCHESTRATOR_USAGE,
  journalViewFromDir,
  runOrchestratorCli,
  type OrchestratorCliDeps,
  type SpawnDaemonParams,
} from "./orchestrator";

// --- harness ----------------------------------------------------------------

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

// Every run gets its own data directory: no test may read or write the real
// `data/orchestrator`, and none may see another's lock file.
function freshDataDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cli-${prefix}-`));
}

function inspectorFor(processes: ReadonlyMap<number, number | null>): ProcessInspector {
  return {
    isAlive: (pid: number) => processes.has(pid),
    procStartMs: (pid: number) => processes.get(pid) ?? null,
  };
}

async function run(argv: readonly string[], overrides: Partial<OrchestratorCliDeps> = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOrchestratorCli(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    dataDir: overrides.dataDir ?? freshDataDir("scratch"),
    inspector: inspectorFor(new Map()),
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
    ...overrides,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function serverFor(world: FixtureWorld): ApiServer {
  return createApiServer({
    journal: journalViewFromHandle(world.journal),
    decisions: journalViewFromHandle(world.decisions),
    dagReader: world.dagReader,
    repoDir: world.repoDir,
    evidenceDir: world.evidenceDir,
    controls: fixtureControls(world.journal),
    host: "127.0.0.1",
    port: 0,
    // The SSE pump is irrelevant to the CLI and would otherwise tick for the
    // life of every test in this file.
    pumpIntervalMs: 60_000,
  });
}

async function withFixtureDaemon(
  prefix: string,
  body: (ctx: { world: FixtureWorld; url: string; dataDir: string }) => Promise<void>,
  seed: (world: FixtureWorld) => void = (world) => {
    seedRun(world);
  }
): Promise<void> {
  const world = freshWorld(prefix);
  seed(world);
  const server = serverFor(world);
  const dataDir = freshDataDir(prefix);
  try {
    await body({ world, url: server.url, dataDir });
  } finally {
    await server.stop();
    world.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function parseEnvelope<T>(text: string): ApiResponse<T> {
  return JSON.parse(text) as ApiResponse<T>;
}

function expectData<T>(text: string): T {
  const envelope = parseEnvelope<T>(text);
  if (!envelope.ok) throw new Error(`expected an ok envelope, got ${envelope.error.kind}: ${envelope.error.message}`);
  return envelope.data;
}

// An address nothing listens on: the honest "no daemon" case B-3 maps to
// exit 2.
const DEAD_URL = "http://127.0.0.1:1";

// --- usage (FR-001) ---------------------------------------------------------

test("no command is a usage error on stderr", async () => {
  const result = await run([]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("a command is required");
  expect(result.err).toContain(ORCHESTRATOR_USAGE);
  expect(result.out).toBe("");
});

test("an unknown command is a usage error", async () => {
  const result = await run(["frobnicate"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`unknown command "frobnicate"`);
  expect(result.err).toContain("usage: observatory orchestrator");
});

test("an unknown flag is refused rather than ignored", async () => {
  const result = await run(["status", "--jsonn"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("unknown flag --jsonn");
});

test("a valued flag without a value is a usage error", async () => {
  const result = await run(["status", "--url"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("--url needs a value");
});

test("decisions without a query is a usage error", async () => {
  const result = await run(["decisions"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("decisions needs a query");
});

test("an unknown spec verb is a usage error", async () => {
  const result = await run(["spec", "002-beta", "detonate"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`unknown spec verb "detonate"`);
});

test("spec without a verb is a usage error", async () => {
  const result = await run(["spec", "002-beta"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("needs a verb");
});

test("an unknown daemon subcommand is a usage error", async () => {
  const result = await run(["daemon", "restart"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`unknown daemon subcommand "restart"`);
});

test("journal without verify is a usage error", async () => {
  const result = await run(["journal"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`journal needs the "verify" subcommand`);
});

test("a trailing argument is a usage error rather than being swallowed", async () => {
  const result = await run(["status", "extra"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`unexpected argument "extra" after status`);
});

test("a thrown side effect is reported, never crashed out of", async () => {
  const dataDir = freshDataDir("throwing-spawn");
  try {
    const result = await run(["daemon", "start", "--data-dir", dataDir], {
      dataDir,
      spawnDaemon: () => {
        throw new Error("EACCES: cannot write the daemon log");
      },
    });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: EACCES: cannot write the daemon log");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- reads against a fixture daemon (AC-2, B-1) -----------------------------

test("status --json returns the documented envelope from a fixture daemon", async () => {
  await withFixtureDaemon("status-json", async ({ url, dataDir }) => {
    const result = await run(["status", "--json", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);

    const data = expectData<{ run: { run: { status: string; id: string } | null; spec: { specId: string } | null }; quota: { parked: boolean; nowMs: number } }>(
      result.out
    );
    expect(data.run.run?.status).toBe("running");
    expect(data.run.spec?.specId).toBe("003-gamma");
    expect(data.quota.parked).toBe(false);
    expect(typeof data.quota.nowMs).toBe("number");
  });
});

test("status renders the run, spec, and stage in flight", async () => {
  await withFixtureDaemon("status-human", async ({ url, dataDir }) => {
    const result = await run(["status", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("run:");
    expect(result.out).toContain("running");
    expect(result.out).toContain("003-gamma");
    expect(result.out).toContain("stage:   build");
    expect(result.out).toContain("quota:   not parked");
  });
});

test("status states an estimated quota horizon as an estimate (B-3)", async () => {
  await withFixtureDaemon(
    "status-parked",
    async ({ url, dataDir }) => {
      const result = await run(["status", "--url", url], { dataDir });
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain("parked");
      expect(result.out).toContain("estimate, not a promise");
    },
    (world) => {
      seedRun(world);
      seedPark(world, Date.now() + 90 * 60_000, 2, true);
    }
  );
});

test("status marks a reported quota horizon as reported, not estimated", async () => {
  await withFixtureDaemon(
    "status-reported",
    async ({ url, dataDir }) => {
      const result = await run(["status", "--url", url], { dataDir });
      expect(result.out).toContain("reported reset");
      expect(result.out).not.toContain("estimate, not a promise");
    },
    (world) => {
      seedRun(world);
      seedPark(world, Date.now() + 30 * 60_000, 1, false);
    }
  );
});

test("dag lists every spec with its state and the next ready spec", async () => {
  await withFixtureDaemon("dag", async ({ url, dataDir }) => {
    const result = await run(["dag", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("001-alpha");
    expect(result.out).toContain("shipped(adopted)");
    expect(result.out).toContain("002-beta");
    expect(result.out).toContain("shipped(pipeline)");
    expect(result.out).toContain("next ready: 003-gamma");
  });
});

test("dag --json prints the served envelope verbatim", async () => {
  await withFixtureDaemon("dag-json", async ({ url, dataDir }) => {
    const result = await run(["dag", "--json", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    const data = expectData<{ specs: { id: string }[]; nextReady: string | null }>(result.out);
    expect(data.specs.map((s) => s.id)).toEqual(["001-alpha", "002-beta", "003-gamma"]);
    expect(data.nextReady).toBe("003-gamma");
  });
});

test("next names the next ready spec", async () => {
  await withFixtureDaemon("next", async ({ url, dataDir }) => {
    const result = await run(["next", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toBe("next ready: 003-gamma");
  });
});

test("next reports blockers when nothing is ready", async () => {
  await withFixtureDaemon(
    "next-blocked",
    async ({ url, dataDir }) => {
      const result = await run(["next", "--url", url], { dataDir });
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain("next ready: none");
      expect(result.out).toContain("blocked:");
      expect(result.out).toContain("002-beta");
    },
    () => {
      // No adoption, no run: 002-beta and 003-gamma are both blocked by an
      // unshipped dependency.
    }
  );
});

test("history reports the evidence trail of a shipped spec", async () => {
  await withFixtureDaemon("history", async ({ url, dataDir }) => {
    const result = await run(["history", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("002-beta");
    expect(result.out).toContain("pr:       #7");
    expect(result.out).toContain("verify: passed");
    expect(result.out).toContain("evidence:");
  });
});

test("decisions searches the sealed ledger", async () => {
  await withFixtureDaemon(
    "decisions",
    async ({ url, dataDir }) => {
      const hit = await run(["decisions", "quota", "--url", url], { dataDir });
      expect(hit.code).toBe(EXIT_OK);
      expect(hit.out).toContain("1 decision matching \"quota\"");
      expect(hit.out).toContain("023-d1-example");
      expect(hit.out).toContain("parks on quota");

      const miss = await run(["decisions", "nothing-matches-this", "--url", url], { dataDir });
      expect(miss.code).toBe(EXIT_OK);
      expect(miss.out).toContain("no decisions match");
    },
    (world) => {
      seedRun(world);
      world.decisions.append("decision.sealed", {
        id: "023-d1-example",
        specId: "002-beta",
        scope: ["src/orchestrator/quota.ts"],
        title: "How the loop parks on quota",
        decision: "The loop parks on quota rather than failing the stage.",
        rationale: "A quota wall is not a defect in the spec being built.",
      });
    }
  );
});

// --- controls (B-2) ---------------------------------------------------------

test("pause journals a control record with the cli as its source", async () => {
  await withFixtureDaemon("pause", async ({ world, url, dataDir }) => {
    const result = await run(["pause", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("pause: applied");
    expect(result.out).toContain("journaled: seq");

    const records = world.journal.fold().byKind["control.pause"] ?? [];
    expect(records).toHaveLength(1);
    expect((records[0]!.payload as { source: string }).source).toBe("cli");
  });
});

test("resume on an already running run is a reported no-op", async () => {
  await withFixtureDaemon("resume-noop", async ({ world, url, dataDir }) => {
    const result = await run(["resume", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("no-op, already satisfied");
    expect(world.journal.fold().byKind["control.resume"]).toBeUndefined();
  });
});

test("start against a journal with no run is an operational failure", async () => {
  await withFixtureDaemon(
    "start-conflict",
    async ({ url, dataDir }) => {
      const result = await run(["start", "--url", url], { dataDir });
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.err).toContain("error: conflict:");

      const asJson = await run(["start", "--json", "--url", url], { dataDir });
      expect(asJson.code).toBe(EXIT_FAILURE);
      const envelope = parseEnvelope<never>(asJson.out);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.kind).toBe("conflict");
    },
    () => {
      // An empty journal: no run has ever been created.
    }
  );
});

test("spec verbs reach their API routes, including the cli's own aliases", async () => {
  await withFixtureDaemon("spec-verbs", async ({ world, url, dataDir }) => {
    const skip = await run(["spec", "003-gamma", "skip", "--url", url], { dataDir });
    expect(skip.code).toBe(EXIT_OK);
    expect(skip.out).toContain("skip 003-gamma: applied");

    const retry = await run(["spec", "003-gamma", "retry", "--url", url], { dataDir });
    expect(retry.code).toBe(EXIT_OK);
    expect(retry.out).toContain("retry-stage 003-gamma: applied");

    const gate = await run(["spec", "003-gamma", "force-gate", "--url", url], { dataDir });
    expect(gate.code).toBe(EXIT_OK);
    expect(gate.out).toContain("force-human-gate 003-gamma: applied");

    const kinds = world.journal.fold();
    expect(kinds.byKind["control.skipSpec"]).toHaveLength(1);
    expect(kinds.byKind["control.retryStage"]).toHaveLength(1);
    expect(kinds.byKind["control.forceHumanGate"]).toHaveLength(1);
  });
});

test("a malformed spec id is refused by the API and reported as a failure", async () => {
  await withFixtureDaemon("spec-bad-id", async ({ url, dataDir }) => {
    const result = await run(["spec", "-not-an-id", "skip", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: bad-request:");
  });
});

// --- unreachable daemon (B-3) -----------------------------------------------

test("an unreachable daemon exits 2 with the unreachable envelope", async () => {
  const asJson = await run(["status", "--json", "--url", DEAD_URL]);
  expect(asJson.code).toBe(EXIT_UNREACHABLE);
  const envelope = parseEnvelope<never>(asJson.out);
  expect(envelope.ok).toBe(false);
  if (!envelope.ok) expect(envelope.error.kind).toBe("unreachable");

  const human = await run(["dag", "--url", DEAD_URL]);
  expect(human.code).toBe(EXIT_UNREACHABLE);
  expect(human.err).toContain("error: unreachable:");
});

test("the base url comes from --url, then the environment, then the default", async () => {
  await withFixtureDaemon("url-env", async ({ url, dataDir }) => {
    const fromEnv = await run(["next"], { dataDir, env: { OBSERVATORY_ORCHESTRATOR_URL: url } });
    expect(fromEnv.code).toBe(EXIT_OK);
    expect(fromEnv.out).toBe("next ready: 003-gamma");

    // The flag wins over the environment.
    const flagWins = await run(["next", "--url", DEAD_URL], { dataDir, env: { OBSERVATORY_ORCHESTRATOR_URL: url } });
    expect(flagWins.code).toBe(EXIT_UNREACHABLE);
  });
});

// --- journal verify (B-4) ---------------------------------------------------

test("journal verify walks both chains with no daemon running", async () => {
  const dir = freshDataDir("verify-ok");
  const work = openJournal(dir);
  work.append("daemon.lock.acquired", { pid: 1, procStartMs: 2 });
  work.append("daemon.heartbeat", { runId: "r1" });
  work.close();
  const decisions = openDecisionsChain(dir);
  decisions.append("decision.sealed", { id: "d1", specId: "002-beta", scope: [], title: "t", decision: "d", rationale: "r" });
  decisions.close();

  try {
    const human = await run(["journal", "verify", "--data-dir", dir]);
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain("work      ok, 2 records");
    expect(human.out).toContain("decisions ok, 1 record");

    const asJson = await run(["journal", "verify", "--json", "--data-dir", dir]);
    expect(asJson.code).toBe(EXIT_OK);
    const data = expectData<{ verified: boolean; chains: { chain: string; count: number | null }[] }>(asJson.out);
    expect(data.verified).toBe(true);
    expect(data.chains.map((c) => c.chain)).toEqual(["work", "decisions"]);
    expect(data.chains[0]!.count).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journal verify reports a tampered record and exits 1", async () => {
  const dir = freshDataDir("verify-broken");
  const work = openJournal(dir);
  work.append("daemon.heartbeat", { runId: "r1" });
  work.append("daemon.heartbeat", { runId: "r2" });
  work.close();

  const path = join(dir, "journal.jsonl");
  const lines = fs.readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  lines[1] = lines[1]!.replace('"r2"', '"r3"');
  fs.writeFileSync(path, `${lines.join("\n")}\n`);

  try {
    const human = await run(["journal", "verify", "--data-dir", dir]);
    expect(human.code).toBe(EXIT_FAILURE);
    expect(human.err).toContain("work      BROKEN at seq 1");

    const asJson = await run(["journal", "verify", "--json", "--data-dir", dir]);
    expect(asJson.code).toBe(EXIT_FAILURE);
    const data = expectData<{ verified: boolean; chains: { verified: boolean; brokenSeq: number | null }[] }>(asJson.out);
    expect(data.verified).toBe(false);
    expect(data.chains[0]!.brokenSeq).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journal verify answers rather than throwing when there is no chain at all", async () => {
  const dir = freshDataDir("verify-empty");
  try {
    const result = await run(["journal", "verify", "--data-dir", dir]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("unverifiable");
    expect(result.err).toContain("nothing to verify");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- daemon lifecycle (B-2) -------------------------------------------------

function writeLock(dataDir: string, pid: number, procStartMs: number): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(join(dataDir, "daemon.lock"), JSON.stringify({ pid, procStartMs }));
}

test("daemon status reports a live lock holder", async () => {
  const dataDir = freshDataDir("daemon-live");
  writeLock(dataDir, 4242, 1_700_000_000_000);
  try {
    const result = await run(["daemon", "status", "--data-dir", dataDir], {
      dataDir,
      inspector: inspectorFor(new Map([[4242, 1_700_000_000_000]])),
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("orchestrator daemon running (pid 4242");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon status treats a reused pid as no daemon (spec 021 B-1)", async () => {
  const dataDir = freshDataDir("daemon-reused");
  writeLock(dataDir, 4242, 1_700_000_000_000);
  try {
    const result = await run(["daemon", "status", "--data-dir", dataDir], {
      dataDir,
      // Same pid, different process: alive, but not the one that locked.
      inspector: inspectorFor(new Map([[4242, 1_700_000_999_000]])),
    });
    expect(result.code).toBe(EXIT_UNREACHABLE);
    expect(result.out).toContain("was reused by a process started at");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon status with no lock exits 2", async () => {
  const dataDir = freshDataDir("daemon-none");
  try {
    const result = await run(["daemon", "status", "--data-dir", dataDir], { dataDir });
    expect(result.code).toBe(EXIT_UNREACHABLE);
    expect(result.out).toContain("no orchestrator daemon running");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon status --json reports a corrupt lock without throwing", async () => {
  const dataDir = freshDataDir("daemon-corrupt");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(join(dataDir, "daemon.lock"), "{not json");
  try {
    const result = await run(["daemon", "status", "--json", "--data-dir", dataDir], { dataDir });
    expect(result.code).toBe(EXIT_UNREACHABLE);
    const data = expectData<{ running: boolean; staleLock: boolean; detail: string | null }>(result.out);
    expect(data.running).toBe(false);
    expect(data.staleLock).toBe(true);
    expect(data.detail).toContain("not JSON");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon start waits for the lock and the API before claiming success", async () => {
  await withFixtureDaemon("daemon-start", async ({ url, dataDir }) => {
    const spawned: SpawnDaemonParams[] = [];
    const result = await run(["daemon", "start", "--url", url, "--data-dir", dataDir], {
      dataDir,
      inspector: inspectorFor(new Map([[9001, 1_700_000_000_000]])),
      spawnDaemon: (params) => {
        spawned.push(params);
        // What the real foreground boot does first (spec 021 B-2): acquire
        // the identity lock. The fixture server is already serving the API.
        writeLock(dataDir, 9001, 1_700_000_000_000);
        return 9001;
      },
      startTimeoutMs: 2_000,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("orchestrator daemon started (pid 9001)");
    expect(result.out).toContain(`api:  ${url}`);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.url).toBe(url);
    expect(spawned[0]!.dataDir).toBe(dataDir);
  });
});

test("daemon start fails when the spawned process never takes the lock", async () => {
  const dataDir = freshDataDir("daemon-start-dead");
  try {
    const result = await run(["daemon", "start", "--url", DEAD_URL, "--data-dir", dataDir], {
      dataDir,
      spawnDaemon: () => 9002,
    });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("did not acquire");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon start on a live daemon is an idempotent no-op", async () => {
  const dataDir = freshDataDir("daemon-start-live");
  writeLock(dataDir, 4242, 1_700_000_000_000);
  try {
    const result = await run(["daemon", "start", "--data-dir", dataDir], {
      dataDir,
      inspector: inspectorFor(new Map([[4242, 1_700_000_000_000]])),
      spawnDaemon: () => {
        throw new Error("must not spawn a second daemon");
      },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("already running (pid 4242)");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon stop signals the lock holder and waits for the lock to clear", async () => {
  const dataDir = freshDataDir("daemon-stop");
  writeLock(dataDir, 4242, 1_700_000_000_000);
  const signals: string[] = [];
  try {
    const result = await run(["daemon", "stop", "--data-dir", dataDir], {
      dataDir,
      inspector: inspectorFor(new Map([[4242, 1_700_000_000_000]])),
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        // What spec 021 B-6 makes SIGTERM do: release the lock.
        fs.rmSync(join(dataDir, "daemon.lock"));
      },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("orchestrator daemon stopped (pid 4242)");
    expect(signals).toEqual(["4242:SIGTERM"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon stop fails when SIGTERM is not honored in time", async () => {
  const dataDir = freshDataDir("daemon-stop-stuck");
  writeLock(dataDir, 4242, 1_700_000_000_000);
  try {
    const result = await run(["daemon", "stop", "--data-dir", dataDir], {
      dataDir,
      inspector: inspectorFor(new Map([[4242, 1_700_000_000_000]])),
      kill: () => {
        // A process that ignores SIGTERM: no escalation happens here.
      },
    });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("still holds");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon stop with nothing running is a satisfied no-op", async () => {
  const dataDir = freshDataDir("daemon-stop-none");
  try {
    const result = await run(["daemon", "stop", "--data-dir", dataDir], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("no orchestrator daemon running");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- the read-only chain view the foreground boot serves from ---------------

// The composition `daemon run` performs, minus the Daemon itself (booting a
// real one would drive real stage sessions against a real repo): the writer
// holds both chains open, exactly as the daemon does, while the API serves
// reads through journalViewFromDir and the CLI talks to it over HTTP.
test("the boot path's file-backed chain view serves the same answers to the cli", async () => {
  const world = freshWorld("boot-view");
  seedRun(world);
  const server = createApiServer({
    journal: journalViewFromDir(world.dir),
    decisions: journalViewFromDir(world.dir, "decisions"),
    dagReader: world.dagReader,
    repoDir: world.repoDir,
    evidenceDir: world.evidenceDir,
    controls: fixtureControls(world.journal),
    host: "127.0.0.1",
    port: 0,
    pumpIntervalMs: 60_000,
  });
  const dataDir = freshDataDir("boot-view");

  try {
    const status = await run(["status", "--json", "--url", server.url], { dataDir });
    expect(status.code).toBe(EXIT_OK);
    const data = expectData<{ run: { run: { status: string } | null; spec: { specId: string } | null } }>(status.out);
    expect(data.run.run?.status).toBe("running");
    expect(data.run.spec?.specId).toBe("003-gamma");

    // A control appends through the writer handle; the next read must see it
    // through the file view, or the boot path would serve a stale run.
    const pause = await run(["pause", "--url", server.url], { dataDir });
    expect(pause.code).toBe(EXIT_OK);
    expect(pause.out).toContain("pause: applied");
    expect(pause.out).toContain("journaled: seq");
  } finally {
    await server.stop();
    world.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("journalViewFromDir reads what the writer appended, and sees later appends", () => {
  const dir = freshDataDir("view");
  const handle = openJournal(dir);
  handle.append("a", { n: 1 });
  handle.append("b", { n: 2 });

  try {
    const view = journalViewFromDir(dir);
    const first = view.records();
    expect(first.map((r) => r.kind)).toEqual(["a", "b"]);
    expect(first[1]!.payload).toEqual({ n: 2 });

    handle.append("c", { n: 3 });
    expect(view.records().map((r) => r.kind)).toEqual(["a", "b", "c"]);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journalViewFromDir reads the decisions chain and an absent chain honestly", () => {
  const dir = freshDataDir("view-decisions");
  const decisions = openDecisionsChain(dir);
  decisions.append("decision.sealed", { id: "d1" });
  decisions.close();

  try {
    expect(journalViewFromDir(dir, "decisions").records()).toHaveLength(1);
    expect(journalViewFromDir(join(dir, "nowhere")).records()).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journalViewFromDir drops a torn tail instead of failing the read", () => {
  const dir = freshDataDir("view-torn");
  const handle = openJournal(dir);
  handle.append("a", { n: 1 });
  handle.append("b", { n: 2 });
  handle.close();

  const path = join(dir, "journal.jsonl");
  const text = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, `${text}{"seq":2,"ts":"2026-`);

  try {
    expect(journalViewFromDir(dir).records().map((r) => r.kind)).toEqual(["a", "b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
