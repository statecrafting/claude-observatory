// Specs 023 and 028 FR-001: the command group is exercised against a fixture
// v2 API server (the real Bun.serve router from spec 027 over the shared
// fixture registry, reached over real HTTP through the real typed client), and
// usage errors are checked for exit code 3 with a usage line on stderr. The
// projects group, the `--project` scoping flag, and the composite status are
// covered here; 028 FR-002's offline verify cases are the last section.
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
import { openProjectsChain, projectStateRoot, registerProject } from "../orchestrator/projects";
import { createApiServer, type ApiServer, type ProjectsTarget } from "../orchestrator/api/server";
import {
  fixtureApiDeps,
  fixtureQualification,
  freshRegistry,
  seedPark,
  seedRun,
  type FixtureRegistry,
  type FixtureWorld,
} from "../orchestrator/api/fixtures";
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

// One project named "alpha" is registered before the body runs; a test that
// needs a second one registers it through `registry` (the server folds the
// chain per request, so a project added mid-test is visible immediately) or
// through the `projects add` verb itself.
interface FixtureCtx {
  readonly registry: FixtureRegistry;
  readonly world: FixtureWorld;
  readonly url: string;
  readonly dataDir: string;
}

async function withFixtureDaemon(
  prefix: string,
  body: (ctx: FixtureCtx) => Promise<void>,
  seed: (world: FixtureWorld) => void = (world) => {
    seedRun(world);
  }
): Promise<void> {
  const registry = freshRegistry(prefix);
  const world = registry.add("alpha");
  seed(world);
  const server = createApiServer(
    // The SSE pump is irrelevant to the CLI and would otherwise tick for the
    // life of every test in this file.
    fixtureApiDeps(registry, { pumpIntervalMs: 60_000 })
  );
  const dataDir = freshDataDir(prefix);
  try {
    await body({ registry, world, url: server.url, dataDir });
  } finally {
    await server.stop();
    registry.close();
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

test("journal without a subcommand is a usage error", async () => {
  const result = await run(["journal"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`journal needs the "verify" or "export" subcommand`);
});

test("a trailing argument is a usage error rather than being swallowed", async () => {
  const result = await run(["status", "extra"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`unexpected argument "extra" after status`);
});

// A plain object literal inherits Object.prototype, so every string-keyed
// lookup table in the command group is read through Object.hasOwn. Without
// that, "toString" reads as a valued flag and swallows the word after it, and
// "constructor" reads as a projects subcommand: the silent flag-swallowing
// 023 D-6 refuses, reached through the prototype chain.
test("a word that collides with Object.prototype is an unknown command, not a swallowed flag", async () => {
  const swallowed = await run(["toString", "frobnicate"]);
  expect(swallowed.code).toBe(EXIT_USAGE);
  expect(swallowed.err).toContain(`unknown command "toString"`);

  const sub = await run(["projects", "constructor", "alpha"]);
  expect(sub.code).toBe(EXIT_USAGE);
  expect(sub.err).toContain(`unknown projects subcommand "constructor"`);

  const verb = await run(["spec", "003-gamma", "valueOf"]);
  expect(verb.code).toBe(EXIT_USAGE);
  expect(verb.err).toContain(`unknown spec verb "valueOf"`);
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

// --- the composite status (028 B-2, AC-2) -----------------------------------

test("status --json returns the documented v2 composite envelope (AC-2)", async () => {
  await withFixtureDaemon("status-json", async ({ url, dataDir }) => {
    const result = await run(["status", "--json", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);

    const data = expectData<{
      meta: { apiVersion: number; projectCount: number; daemon: { state: string; activeProject: string | null } | null };
      quota: { parked: boolean; nowMs: number };
      projects: { projects: { name: string; armed: boolean; run: { status: string } | null; spec: { specId: string } | null }[] };
    }>(result.out);

    expect(data.meta.apiVersion).toBe(2);
    expect(data.meta.projectCount).toBe(1);
    expect(data.meta.daemon?.state).toBe("standby");
    expect(data.quota.parked).toBe(false);
    expect(typeof data.quota.nowMs).toBe("number");
    expect(data.projects.projects.map((project) => project.name)).toEqual(["alpha"]);
    expect(data.projects.projects[0]!.run?.status).toBe("running");
    expect(data.projects.projects[0]!.spec?.specId).toBe("003-gamma");
  });
});

test("status renders the daemon state, the global quota, and one row per project", async () => {
  await withFixtureDaemon("status-human", async ({ registry, url, dataDir }) => {
    registry.add("beta", { armed: false, qualified: false, controls: false });

    const result = await run(["status", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("daemon:  standby");
    expect(result.out).toContain("quota:   not parked");
    expect(result.out).toContain("projects: 2");
    // The armed, qualified project mid-build, and the disarmed one that has
    // never run, each on its own row with its qualification named.
    expect(result.out).toContain("alpha  armed");
    expect(result.out).toContain("qualified");
    expect(result.out).toContain("running  003-gamma/build");
    expect(result.out).toContain("beta   disarmed");
    expect(result.out).toContain("unqualified (origin-remote)");
    expect(result.out).toContain("no run yet");
  });
});

test("status names the project whose run is holding the flight slot", async () => {
  await withFixtureDaemon("status-driving", async ({ registry, dataDir }) => {
    const server = createApiServer(
      fixtureApiDeps(registry, {
        pumpIntervalMs: 60_000,
        daemon: { status: () => ({ state: "scheduling", activeProject: "alpha", scanIntervalMs: 60_000, lastScanMs: null }) },
      })
    );
    try {
      const result = await run(["status", "--url", server.url], { dataDir });
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain("daemon:  driving  alpha");
    } finally {
      await server.stop();
    }
  });
});

test("status --project scopes to that project's run and the global quota", async () => {
  await withFixtureDaemon("status-scoped", async ({ registry, url, dataDir }) => {
    registry.add("beta", { controls: false });

    const human = await run(["status", "--project", "alpha", "--url", url], { dataDir });
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain("run:");
    expect(human.out).toContain("running");
    expect(human.out).toContain("003-gamma");
    expect(human.out).toContain("stage:   build");
    expect(human.out).toContain("quota:   not parked");

    const asJson = await run(["status", "--project", "alpha", "--json", "--url", url], { dataDir });
    const data = expectData<{ run: { project: string; spec: { specId: string } | null }; quota: { parked: boolean } }>(asJson.out);
    expect(data.run.project).toBe("alpha");
    expect(data.run.spec?.specId).toBe("003-gamma");
    expect(data.quota.parked).toBe(false);

    // The project with no run of its own answers about itself, not about alpha.
    const other = await run(["status", "--project", "beta", "--json", "--url", url], { dataDir });
    const otherData = expectData<{ run: { project: string; run: unknown } }>(other.out);
    expect(otherData.run.project).toBe("beta");
    expect(otherData.run.run).toBeNull();
  });
});

test("an unknown project name is an operational failure, not a usage error (B-4)", async () => {
  await withFixtureDaemon("status-unknown-project", async ({ url, dataDir }) => {
    const result = await run(["status", "--project", "nowhere", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: not-found:");
    expect(result.err).toContain("nowhere");
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
      // The pool is the account's, the park was journaled by one project's run.
      expect(result.out).toContain("park journaled by project alpha");
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
      const result = await run(["status", "--project", "alpha", "--url", url], { dataDir });
      expect(result.out).toContain("reported reset");
      expect(result.out).not.toContain("estimate, not a promise");
    },
    (world) => {
      seedRun(world);
      seedPark(world, Date.now() + 30 * 60_000, 1, false);
    }
  );
});

// --- the scoping flag (028 B-2) ---------------------------------------------

test("--project scopes dag, next, history, and decisions to the named project", async () => {
  await withFixtureDaemon("scoped-reads", async ({ registry, url, dataDir }) => {
    // A second project whose corpus is a different one: an answer that came
    // back for alpha would be recognisable as the wrong project's.
    registry.add("beta", { controls: false, specs: { "101-solo": { implementation: "pending" } } });

    const dag = await run(["dag", "--project", "beta", "--json", "--url", url], { dataDir });
    expect(dag.code).toBe(EXIT_OK);
    const dagData = expectData<{ project: string; specs: { id: string }[] }>(dag.out);
    expect(dagData.project).toBe("beta");
    expect(dagData.specs.map((spec) => spec.id)).toEqual(["101-solo"]);

    const next = await run(["next", "--project", "beta", "--url", url], { dataDir });
    expect(next.code).toBe(EXIT_OK);
    expect(next.out).toBe("next ready: 101-solo");

    const history = await run(["history", "--project", "beta", "--url", url], { dataDir });
    expect(history.code).toBe(EXIT_OK);
    expect(history.out).toContain("no spec executions journaled yet");

    const decisions = await run(["decisions", "quota", "--project", "beta", "--json", "--url", url], { dataDir });
    expect(decisions.code).toBe(EXIT_OK);
    const decisionsData = expectData<{ project: string; total: number }>(decisions.out);
    expect(decisionsData.project).toBe("beta");
    expect(decisionsData.total).toBe(0);
  });
});

test("--project scopes the run and spec controls, journaling into that project", async () => {
  await withFixtureDaemon("scoped-controls", async ({ registry, url, dataDir }) => {
    const beta = registry.add("beta");
    seedRun(beta);

    const pause = await run(["pause", "--project", "beta", "--url", url], { dataDir });
    expect(pause.code).toBe(EXIT_OK);
    expect(pause.out).toContain("pause: applied");

    const skip = await run(["spec", "003-gamma", "skip", "--project", "beta", "--url", url], { dataDir });
    expect(skip.code).toBe(EXIT_OK);
    expect(skip.out).toContain("skip 003-gamma: applied");

    // beta's chain carries both; alpha's carries neither.
    expect(beta.journal.fold().byKind["control.pause"]).toHaveLength(1);
    expect(beta.journal.fold().byKind["control.skipSpec"]).toHaveLength(1);
    const alpha = registry.worldFor("alpha");
    expect(alpha.journal.fold().byKind["control.pause"]).toBeUndefined();
    expect(alpha.journal.fold().byKind["control.skipSpec"]).toBeUndefined();
  });
});

test("without --project several registered projects are refused by name, never guessed at", async () => {
  await withFixtureDaemon("scoped-ambiguous", async ({ registry, url, dataDir }) => {
    registry.add("beta", { controls: false });

    const result = await run(["dag", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: conflict:");
    expect(result.err).toContain("alpha, beta");
    expect(result.err).toContain("--project");
  });
});

test("--project is refused on a command that has no project to address", async () => {
  const result = await run(["daemon", "status", "--project", "alpha"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain(`--project is not a flag of "daemon"`);
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

// --- the projects group (028 B-1) -------------------------------------------

test("projects lists the registry, one row per project", async () => {
  await withFixtureDaemon("projects-list", async ({ registry, url, dataDir }) => {
    registry.add("beta", { armed: false, qualified: false, controls: false });

    const human = await run(["projects", "--url", url], { dataDir });
    expect(human.code).toBe(EXIT_OK);
    // 032 B-6: the posture sits between the arm state and the qualification,
    // on every row, because the two consents are read together or not at all.
    expect(human.out).toContain("alpha  armed     bypass  qualified    running  003-gamma/build");
    // 025 B-4: an unqualified project stays listed, with what failed named.
    expect(human.out).toContain("beta   disarmed  bypass  unqualified (origin-remote)  no run yet");

    const asJson = await run(["projects", "--json", "--url", url], { dataDir });
    expect(asJson.code).toBe(EXIT_OK);
    const data = expectData<{ projects: { name: string; armed: boolean; qualification: { qualified: boolean } }[] }>(asJson.out);
    expect(data.projects.map((project) => project.name)).toEqual(["alpha", "beta"]);
    expect(data.projects[1]!.armed).toBe(false);
    expect(data.projects[1]!.qualification.qualified).toBe(false);
  });
});

test("projects on a daemon with an empty registry says so rather than printing nothing", async () => {
  const registry = freshRegistry("projects-empty");
  const server = createApiServer(fixtureApiDeps(registry, { pumpIntervalMs: 60_000 }));
  const dataDir = freshDataDir("projects-empty");
  try {
    const result = await run(["projects", "--url", server.url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("no projects are registered with this daemon");
  } finally {
    await server.stop();
    registry.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("projects add registers a path and prints the journaled record", async () => {
  await withFixtureDaemon("projects-add", async ({ registry, url, dataDir }) => {
    const newcomer = registry.world("newcomer");

    const result = await run(["projects", "add", newcomer.repoDir, "--name", "gamma", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("register gamma: applied");
    expect(result.out).toContain("journaled: seq");
    expect(result.out).toContain("project.registered");
    expect(result.out).toContain("gamma  armed");

    expect([...registry.projects().keys()]).toEqual(["alpha", "gamma"]);
    expect(registry.projects().get("gamma")!.repoDir).toBe(newcomer.repoDir);
  });
});

test("projects add --disarmed registers and then holds the project back", async () => {
  await withFixtureDaemon("projects-add-disarmed", async ({ registry, url, dataDir }) => {
    const newcomer = registry.world("newcomer");

    const human = await run(["projects", "add", newcomer.repoDir, "--name", "gamma", "--disarmed", "--url", url], { dataDir });
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain("register gamma: applied");
    expect(human.out).toContain("disarm gamma: applied");
    expect(registry.projects().get("gamma")!.armed).toBe(false);

    // D-1: two controls, so `--json` carries both served payloads.
    const other = registry.world("second");
    const asJson = await run(
      ["projects", "add", other.repoDir, "--name", "delta", "--disarmed", "--json", "--url", url],
      { dataDir }
    );
    expect(asJson.code).toBe(EXIT_OK);
    const data = expectData<{
      registered: { verb: string; project: string };
      disarmed: { verb: string; snapshot: { armed: boolean } | null };
    }>(asJson.out);
    expect(data.registered.verb).toBe("register");
    expect(data.registered.project).toBe("delta");
    expect(data.disarmed.verb).toBe("disarm");
    expect(data.disarmed.snapshot?.armed).toBe(false);
  });
});

test("projects add refuses a path the registry already holds, as an operational failure", async () => {
  await withFixtureDaemon("projects-add-clash", async ({ registry, url, dataDir }) => {
    const alpha = registry.worldFor("alpha");
    const result = await run(["projects", "add", alpha.repoDir, "--name", "duplicate", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: conflict:");
    expect(result.err).toContain("already registered");
  });
});

test("the projects controls journal their records with the cli as the source", async () => {
  await withFixtureDaemon("projects-controls", async ({ registry, url, dataDir }) => {
    const disarm = await run(["projects", "disarm", "alpha", "--url", url], { dataDir });
    expect(disarm.code).toBe(EXIT_OK);
    expect(disarm.out).toContain("disarm alpha: applied");
    expect(disarm.out).toContain("project.disarmed");
    expect(disarm.out).toContain("alpha  disarmed");
    expect(registry.projects().get("alpha")!.armed).toBe(false);

    const arm = await run(["projects", "arm", "alpha", "--url", url], { dataDir });
    expect(arm.code).toBe(EXIT_OK);
    expect(registry.projects().get("alpha")!.armed).toBe(true);

    const requalify = await run(["projects", "requalify", "alpha", "--url", url], { dataDir });
    expect(requalify.code).toBe(EXIT_OK);
    expect(requalify.out).toContain("project.requalified");

    // B-4: every control the CLI issues carries X-Control-Source: cli, so the
    // registry chain names the terminal rather than defaulting to the API.
    for (const record of registry.chain.fold().records.slice(1)) {
      expect((record.payload as { source: string }).source).toBe("cli");
    }

    const remove = await run(["projects", "remove", "alpha", "--url", url], { dataDir });
    expect(remove.code).toBe(EXIT_OK);
    expect(remove.out).toContain("remove alpha: applied");
    expect([...registry.projects().keys()]).toEqual([]);
  });
});

test("a projects control against an unknown name is an operational failure (B-4)", async () => {
  await withFixtureDaemon("projects-unknown", async ({ url, dataDir }) => {
    const result = await run(["projects", "arm", "nowhere", "--url", url], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("error: not-found:");
    expect(result.err).toContain("nowhere");
  });
});

test("the projects group's usage errors exit 3 with a usage line on stderr", async () => {
  const unknown = await run(["projects", "frobnicate"]);
  expect(unknown.code).toBe(EXIT_USAGE);
  expect(unknown.err).toContain(`unknown projects subcommand "frobnicate"`);
  expect(unknown.err).toContain(ORCHESTRATOR_USAGE);

  const nameless = await run(["projects", "arm"]);
  expect(nameless.code).toBe(EXIT_USAGE);
  expect(nameless.err).toContain("projects arm needs a project name");

  const pathless = await run(["projects", "add"]);
  expect(pathless.code).toBe(EXIT_USAGE);
  expect(pathless.err).toContain("projects add needs a repository path");

  // `resolve("")` is the working directory, so an empty path (an unset shell
  // variable) must not register whatever repo the operator is standing in.
  const empty = await run(["projects", "add", ""]);
  expect(empty.code).toBe(EXIT_USAGE);
  expect(empty.err).toContain("projects add needs a repository path");

  const trailing = await run(["projects", "remove", "alpha", "extra"]);
  expect(trailing.code).toBe(EXIT_USAGE);
  expect(trailing.err).toContain(`unexpected argument "extra" after projects remove`);
});

test("--name and --disarmed are refused outside projects add", async () => {
  const onList = await run(["projects", "--name", "gamma"]);
  expect(onList.code).toBe(EXIT_USAGE);
  expect(onList.err).toContain(`--name is not a flag of "projects"`);

  const onArm = await run(["projects", "arm", "alpha", "--disarmed"]);
  expect(onArm.code).toBe(EXIT_USAGE);
  expect(onArm.err).toContain(`--disarmed is not a flag of "projects"`);
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

// --- journal verify (023 B-4, 028 B-3, FR-002) ------------------------------

// Two real chains under a state root, the shape every verify case walks.
function seedChains(stateRoot: string, heartbeats: number): void {
  const work = openJournal(stateRoot);
  work.append("daemon.lock.acquired", { pid: 1, procStartMs: 2 });
  for (let i = 0; i < heartbeats; i++) work.append("daemon.heartbeat", { runId: `r${i}` });
  work.close();
  const decisions = openDecisionsChain(stateRoot);
  decisions.append("decision.sealed", { id: "d1", specId: "002-beta", scope: [], title: "t", decision: "d", rationale: "r" });
  decisions.close();
}

// A daemon home holding a projects chain, plus the named project's own state
// root inside its target (010 D13). No daemon and no API anywhere: resolving
// the root is a file read of the registry, which is what makes the operator's
// check independent of the thing it checks (028 B-3).
function seedRegisteredProject(homeDir: string, name: string): string {
  const repoDir = freshDataDir(`repo-${name}`);
  const chain = openProjectsChain(homeDir);
  registerProject({ chain, repoDir, name, qualification: fixtureQualification(true), source: "cli" });
  chain.close();
  seedChains(projectStateRoot(repoDir), 1);
  return repoDir;
}

test("journal verify walks both chains of the self-hosted root with no daemon running", async () => {
  const dir = freshDataDir("verify-ok");
  seedChains(dir, 1);

  try {
    const human = await run(["journal", "verify", "--data-dir", dir]);
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain(`chains under ${dir}`);
    expect(human.out).toContain("work      ok, 2 records");
    expect(human.out).toContain("decisions ok, 1 record");

    const asJson = await run(["journal", "verify", "--json", "--data-dir", dir]);
    expect(asJson.code).toBe(EXIT_OK);
    const data = expectData<{ dir: string; project: string | null; verified: boolean; chains: { chain: string; count: number | null }[] }>(
      asJson.out
    );
    expect(data.verified).toBe(true);
    // Neither flag: this checkout's own root, addressed as no project.
    expect(data.dir).toBe(dir);
    expect(data.project).toBeNull();
    expect(data.chains.map((c) => c.chain)).toEqual(["work", "decisions"]);
    expect(data.chains[0]!.count).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journal verify --project resolves the state root through the registry chain", async () => {
  const home = freshDataDir("verify-registry");
  const repoDir = seedRegisteredProject(home, "gamma");
  const stateRoot = projectStateRoot(repoDir);

  try {
    const human = await run(["journal", "verify", "--project", "gamma", "--data-dir", home]);
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain(`chains under ${stateRoot} (project gamma)`);
    expect(human.out).toContain("work      ok, 2 records");
    expect(human.out).toContain("decisions ok, 1 record");

    const asJson = await run(["journal", "verify", "--project", "gamma", "--json", "--data-dir", home]);
    expect(asJson.code).toBe(EXIT_OK);
    const data = expectData<{ dir: string; project: string | null; resolveError: string | null; verified: boolean }>(asJson.out);
    expect(data.dir).toBe(stateRoot);
    expect(data.project).toBe("gamma");
    expect(data.resolveError).toBeNull();
    expect(data.verified).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("journal verify --dir walks a bare state root without consulting the registry", async () => {
  const home = freshDataDir("verify-dir-home");
  const bare = freshDataDir("verify-dir-root");
  seedChains(bare, 2);

  try {
    // The daemon home's registry is empty, so a --dir that still verifies
    // proves the flag bypasses it.
    const human = await run(["journal", "verify", "--dir", bare, "--data-dir", home]);
    expect(human.code).toBe(EXIT_OK);
    expect(human.out).toContain(`chains under ${bare}`);
    expect(human.out).toContain("work      ok, 3 records");

    const asJson = await run(["journal", "verify", "--dir", bare, "--json", "--data-dir", home]);
    const data = expectData<{ dir: string; project: string | null; verified: boolean }>(asJson.out);
    expect(data.dir).toBe(bare);
    expect(data.project).toBeNull();
    expect(data.verified).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("journal verify --project names an unregistered project rather than verifying nothing", async () => {
  const home = freshDataDir("verify-unregistered");
  const repoDir = seedRegisteredProject(home, "gamma");

  try {
    const human = await run(["journal", "verify", "--project", "nowhere", "--data-dir", home]);
    expect(human.code).toBe(EXIT_FAILURE);
    expect(human.err).toContain(`no registered project named "nowhere"`);
    expect(human.err).toContain("registered: gamma");

    // 023 D-5: an offline command still answers in the envelope, with the
    // verdict inside `data` and the outcome in the exit code.
    const asJson = await run(["journal", "verify", "--project", "nowhere", "--json", "--data-dir", home]);
    expect(asJson.code).toBe(EXIT_FAILURE);
    const data = expectData<{ verified: boolean; resolveError: string | null; chains: unknown[] }>(asJson.out);
    expect(data.verified).toBe(false);
    expect(data.resolveError).toContain(`no registered project named "nowhere"`);
    expect(data.chains).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("journal verify --project against a home with no registry at all says so", async () => {
  const home = freshDataDir("verify-no-registry");
  try {
    const result = await run(["journal", "verify", "--project", "gamma", "--data-dir", home]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("holds none");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("journal verify takes --project or --dir, never both", async () => {
  const result = await run(["journal", "verify", "--project", "gamma", "--dir", "/tmp"]);
  expect(result.code).toBe(EXIT_USAGE);
  expect(result.err).toContain("takes --project or --dir, not both");
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
  const registry = freshRegistry("boot-view");
  const world = registry.add("alpha");
  seedRun(world);
  // The one thing this test is about: the project's chains are read from disk
  // through journalViewFromDir, exactly as the foreground boot serves them,
  // rather than through the writer handle the fixture registry hands out.
  const fileBacked: ProjectsTarget = {
    ...registry.target,
    resourcesFor: (project) => ({
      ...registry.target.resourcesFor(project),
      journal: journalViewFromDir(world.dir),
      decisions: journalViewFromDir(world.dir, "decisions"),
    }),
  };
  const server = createApiServer(fixtureApiDeps(registry, { projects: fileBacked, pumpIntervalMs: 60_000 }));
  const dataDir = freshDataDir("boot-view");

  try {
    const status = await run(["status", "--project", "alpha", "--json", "--url", server.url], { dataDir });
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
    registry.close();
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
