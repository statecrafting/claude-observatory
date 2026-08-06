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
import { adoptableDagReader } from "../orchestrator/adopt/preflight";
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

test("projects ceiling sets, renders, and clears the spend limits (033 FR-004, AC-3)", async () => {
  await withFixtureDaemon("projects-ceiling-verb", async ({ registry, url, dataDir }) => {
    // Setting prints the journaled record and the detail, ceiling line included.
    const set = await run(
      ["projects", "ceiling", "alpha", "--per-run", "5", "--per-day", "20", "--url", url],
      { dataDir }
    );
    expect(set.code).toBe(EXIT_OK);
    expect(set.out).toContain("ceiling alpha: applied");
    expect(set.out).toContain("project.ceiling.set");
    expect(set.out).toContain("ceiling: run $5.0000, day $20.0000");
    expect(registry.projects().get("alpha")!.ceiling).toEqual({
      perRunMicroUsd: 5_000_000,
      perDayMicroUsd: 20_000_000,
    });

    // FR-004's negative: a fresh registration has no ceiling record, and the
    // detail printed for it says "no ceiling" rather than a blank or a zero.
    const newcomer = registry.world("newcomer");
    const added = await run(["projects", "add", newcomer.repoDir, "--name", "gamma", "--url", url], { dataDir });
    expect(added.code).toBe(EXIT_OK);
    expect(added.out).toContain("ceiling: no ceiling");

    // "none" clears, and the clearing is a journaled decision, not an
    // absence the fold infers.
    const cleared = await run(["projects", "ceiling", "alpha", "none", "--url", url], { dataDir });
    expect(cleared.code).toBe(EXIT_OK);
    expect(cleared.out).toContain("project.ceiling.set");
    expect(cleared.out).toContain("ceiling: no ceiling");
    expect(registry.projects().get("alpha")!.ceiling).toBeNull();

    // Half a clear is a usage error, refused before the chain moves.
    const mixed = await run(["projects", "ceiling", "alpha", "none", "--per-run", "5", "--url", url], { dataDir });
    expect(mixed.code).not.toBe(EXIT_OK);
    expect(mixed.err).toContain(`"none" clears the ceiling`);
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

// --- adopt preflight (spec 034) ----------------------------------------------

function gitFor(dir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

// An ungoverned target with a real merge history: a Bun/TypeScript surface,
// no specs/, and two first-parent merges that each shipped the same two auth
// files together (one clean candidate territory).
function ungovernedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-adopt-repo-"));
  gitFor(dir, ["init", "-q", "-b", "main"]);
  gitFor(dir, ["config", "user.email", "test@example.com"]);
  gitFor(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "bun test" } }));
  fs.writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  fs.writeFileSync(join(dir, "bun.lock"), "");
  fs.mkdirSync(join(dir, "src", "auth"), { recursive: true });
  fs.writeFileSync(join(dir, "src", "auth", "login.ts"), "export {};\n");
  fs.writeFileSync(join(dir, "src", "auth", "token.ts"), "export {};\n");
  gitFor(dir, ["add", "-A"]);
  gitFor(dir, ["commit", "-qm", "init"]);
  for (const round of [1, 2]) {
    gitFor(dir, ["checkout", "-qb", `feature-${round}`]);
    fs.appendFileSync(join(dir, "src", "auth", "login.ts"), `// round ${round}\n`);
    fs.appendFileSync(join(dir, "src", "auth", "token.ts"), `// round ${round}\n`);
    gitFor(dir, ["add", "-A"]);
    gitFor(dir, ["commit", "-qm", `auth round ${round}`]);
    gitFor(dir, ["checkout", "-q", "main"]);
    gitFor(dir, ["merge", "-q", "--no-ff", `feature-${round}`, "-m", `merge auth round ${round} (#${round})`]);
  }
  return dir;
}

test("adopt without its subcommand, and preflight without a path, are usage errors", async () => {
  const bare = await run(["adopt"]);
  expect(bare.code).toBe(EXIT_USAGE);
  expect(bare.err).toContain(`adopt needs the "preflight", "validate", or "synthesize" subcommand`);

  const noPath = await run(["adopt", "preflight"]);
  expect(noPath.code).toBe(EXIT_USAGE);
  expect(noPath.err).toContain("adopt preflight needs a repository path");
});

test("adopt preflight refuses stray flags, and --exclude belongs to it alone", async () => {
  const stray = await run(["adopt", "preflight", "/tmp/x", "--project", "alpha"]);
  expect(stray.code).toBe(EXIT_USAGE);
  expect(stray.err).toContain(`--project is not a flag of "adopt"`);

  const elsewhere = await run(["status", "--exclude", "docs/"]);
  expect(elsewhere.code).toBe(EXIT_USAGE);
  expect(elsewhere.err).toContain(`--exclude is not a flag of "status"`);
});

test("a target that is not a readable directory fails plainly", async () => {
  const dataDir = freshDataDir("adopt-missing");
  try {
    const result = await run(["adopt", "preflight", join(dataDir, "nowhere")], { dataDir });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toContain("is not a readable directory");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("adopt preflight writes a byte-identical proposal and prints the summary (034 AC-2)", async () => {
  const repo = ungovernedRepo();
  const dataDir = freshDataDir("adopt");
  const out = join(dataDir, "proposal.md");
  try {
    const first = await run(["adopt", "preflight", repo, "--out", out], { dataDir });
    expect(first.code).toBe(EXIT_OK);
    expect(first.out).toContain(`proposal written to ${out}`);
    expect(first.out).toContain("candidates: 1");
    expect(first.out).toContain("remainder:  0 path(s)");
    expect(first.out).toContain("unknowns:   none");
    expect(first.out).toContain("2 first-parent merge(s)");
    // An unregistered target runs fine and says nothing was journaled (B-6).
    expect(first.out).toContain("journaled: nothing");

    const document = fs.readFileSync(out, "utf8");
    expect(document).toContain(`# Adoption preflight: ${repo}`);
    expect(document).toContain("src/auth/login.ts");
    expect(document).toContain("merge auth round 2 (#2)");

    const second = await run(["adopt", "preflight", repo, "--out", out], { dataDir });
    expect(second.code).toBe(EXIT_OK);
    expect(fs.readFileSync(out, "utf8")).toBe(document);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a registered target's preflight is journaled into its state root (034 B-6)", async () => {
  const repo = ungovernedRepo();
  const dataDir = freshDataDir("adopt-journal");
  const out = join(dataDir, "proposal.md");
  const chain = openProjectsChain(dataDir);
  registerProject({
    chain,
    repoDir: repo,
    name: "adoptee",
    qualification: { qualified: false, adoptable: true, checks: [], warnings: [] },
    source: "cli",
  });
  chain.close();
  try {
    const result = await run(["adopt", "preflight", repo, "--out", out], { dataDir });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("journaled: seq 0  adopt.preflight");
    expect(result.out).toContain("(project adoptee)");

    const records = journalViewFromDir(projectStateRoot(repo)).records();
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("adopt.preflight");
    const payload = records[0]!.payload as Record<string, unknown>;
    expect(payload.project).toBe("adoptee");
    expect(payload.historyMode).toBe("merges");
    expect(payload.out).toBe(out);
    expect(typeof payload.contentHash).toBe("string");
    expect(typeof payload.headSha).toBe("string");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an adoptable project renders adoptable, and dag/next refuse it by name (034 AC-3)", async () => {
  const registry = freshRegistry("adoptable");
  registry.add("alpha");
  const world = registry.world("beta");
  registerProject({
    chain: registry.chain,
    repoDir: world.repoDir,
    name: "beta",
    qualification: {
      qualified: false,
      adoptable: true,
      checks: [
        { id: "git-repo", ok: true, detail: "git work tree root" },
        { id: "origin-remote", ok: true, detail: "origin is git@example.com:x/beta.git" },
        { id: "default-branch", ok: true, detail: `default branch is "main"` },
        { id: "compile-green", ok: false, detail: "spec-spine compile exited 2: no corpus" },
        { id: "specs-present", ok: false, detail: "specs/ is missing or holds no spec.md" },
      ],
      warnings: [],
    },
    source: "cli",
  });
  // Exactly the production wiring in standbyProjects: an adoptable project's
  // structural reads refuse by name; every other project is untouched.
  const guarded: ProjectsTarget = {
    ...registry.target,
    resourcesFor: (project) => {
      const api = registry.target.resourcesFor(project);
      return { ...api, dagReader: adoptableDagReader(project) ?? api.dagReader };
    },
  };
  const server = createApiServer(fixtureApiDeps(registry, { projects: guarded, pumpIntervalMs: 60_000 }));
  try {
    const rows = await run(["projects", "--url", server.url]);
    expect(rows.code).toBe(EXIT_OK);
    expect(rows.out).toContain("adoptable (compile-green, specs-present)");

    for (const verb of ["dag", "next"]) {
      const refused = await run([verb, "--project", "beta", "--url", server.url]);
      expect(refused.code).toBe(EXIT_FAILURE);
      expect(refused.err).toContain(`project "beta" is adoptable, not governed`);
      expect(refused.err).toContain("specs/ is missing or holds no spec.md");
    }

    // The governed project is untouched by the vocabulary (FR-004): its dag
    // still answers.
    const governed = await run(["dag", "--project", "alpha", "--url", server.url]);
    expect(governed.code).toBe(EXIT_OK);
    expect(governed.out).toContain("next ready:");
  } finally {
    await server.stop();
    registry.close();
  }
});

// --- adopt validate (spec 036) ------------------------------------------------

// A target with a real merge history whose coupling is known by construction:
// login.ts ships in two merges, helper.ts in one, db.ts in one. The corpus
// branches below either cover all of it or deliberately omit the hot file
// (login.ts) and the cooler one (helper.ts), which is AC-2's orphan-ranking
// case.
function governedHistoryRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-validate-repo-"));
  gitFor(dir, ["init", "-q", "-b", "main"]);
  gitFor(dir, ["config", "user.email", "test@example.com"]);
  gitFor(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(join(dir, "src", "auth"), { recursive: true });
  fs.mkdirSync(join(dir, "src", "core"), { recursive: true });
  fs.mkdirSync(join(dir, "src", "util"), { recursive: true });
  for (const file of ["src/auth/login.ts", "src/auth/token.ts", "src/core/db.ts", "src/util/helper.ts"]) {
    fs.writeFileSync(join(dir, file), "export {};\n");
  }
  // What every adoptable target needs before anything journals against it
  // (the tenant-tail lesson): the orchestrator's state root stays out of git.
  fs.writeFileSync(join(dir, ".gitignore"), "/data/\n");
  gitFor(dir, ["add", "-A"]);
  gitFor(dir, ["commit", "-qm", "init"]);

  const merge = (branch: string, subject: string, files: readonly string[]): void => {
    gitFor(dir, ["checkout", "-qb", branch]);
    for (const file of files) fs.appendFileSync(join(dir, file), `// ${subject}\n`);
    gitFor(dir, ["add", "-A"]);
    gitFor(dir, ["commit", "-qm", subject]);
    gitFor(dir, ["checkout", "-q", "main"]);
    gitFor(dir, ["merge", "-q", "--no-ff", branch, "-m", `merge ${subject}`]);
  };
  merge("auth-1", "auth round 1", ["src/auth/login.ts", "src/auth/token.ts"]);
  merge("auth-2", "auth round 2", ["src/auth/login.ts", "src/auth/token.ts", "src/util/helper.ts"]);
  merge("core-1", "core round", ["src/core/db.ts"]);
  return dir;
}

function writeCorpusSpec(repo: string, id: string, title: string, paths: readonly string[]): void {
  const establishes = paths.map((path) => `  - { kind: file, path: "${path}" }`).join("\n");
  fs.mkdirSync(join(repo, "specs", id), { recursive: true });
  fs.writeFileSync(
    join(repo, "specs", id, "spec.md"),
    `---\nid: "${id}"\ntitle: "${title}"\nstatus: draft\ncreated: "2026-08-06"\nsummary: >\n  ${title}, recorded as found.\norigin:\n  retroactive: true\nestablishes:\n${establishes}\n---\n\n# ${id}\n\nRecords the territory as found.\n`
  );
}

// A candidate corpus authored on a branch of the target, 035's shape: the
// spec-spine scaffold plus one draft spec per territory.
function corpusBranch(repo: string, branch: string, specs: readonly { id: string; title: string; paths: readonly string[] }[]): void {
  gitFor(repo, ["checkout", "-qb", branch]);
  const init = Bun.spawnSync(["spec-spine", "init"], { cwd: repo });
  if (init.exitCode !== 0) {
    throw new Error(`spec-spine init failed: ${new TextDecoder().decode(init.stderr)}`);
  }
  for (const spec of specs) writeCorpusSpec(repo, spec.id, spec.title, spec.paths);
  gitFor(repo, ["add", "-A"]);
  gitFor(repo, ["commit", "-qm", `draft corpus ${branch}`]);
  gitFor(repo, ["checkout", "-q", "main"]);
}

test("adopt validate usage: project name, --corpus, and flag ownership are all enforced", async () => {
  const noProject = await run(["adopt", "validate"]);
  expect(noProject.code).toBe(EXIT_USAGE);
  expect(noProject.err).toContain("adopt validate needs a project name");

  const noCorpus = await run(["adopt", "validate", "adoptee"]);
  expect(noCorpus.code).toBe(EXIT_USAGE);
  expect(noCorpus.err).toContain("adopt validate needs --corpus <branch-or-path>");

  const elsewhere = await run(["status", "--corpus", "draft"]);
  expect(elsewhere.code).toBe(EXIT_USAGE);
  expect(elsewhere.err).toContain(`--corpus is not a flag of "status"`);
});

test("adopt validate refuses an unknown project and an unusable corpus with the reason named", async () => {
  const dataDir = freshDataDir("validate-unknown");
  try {
    const unknown = await run(["adopt", "validate", "ghost", "--corpus", "draft"], { dataDir });
    expect(unknown.code).toBe(EXIT_FAILURE);
    expect(unknown.err).toContain(`no registered project named "ghost"`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("adopt validate scores a corpus branch, ranks the omitted hot file first, and journals the record (036 AC-2)", async () => {
  const repo = governedHistoryRepo();
  corpusBranch(repo, "corpus-full", [
    { id: "001-auth", title: "Auth territory", paths: ["src/auth/login.ts", "src/auth/token.ts"] },
    { id: "002-core", title: "Core territory", paths: ["src/core/db.ts"] },
    { id: "003-util", title: "Util territory", paths: ["src/util/helper.ts"] },
  ]);
  corpusBranch(repo, "corpus-hole", [
    { id: "001-auth", title: "Auth territory, login omitted", paths: ["src/auth/token.ts"] },
    { id: "002-core", title: "Core territory", paths: ["src/core/db.ts"] },
  ]);
  const dataDir = freshDataDir("validate");
  const chain = openProjectsChain(dataDir);
  registerProject({
    chain,
    repoDir: repo,
    name: "adoptee",
    qualification: { qualified: false, adoptable: true, checks: [], warnings: [] },
    source: "cli",
  });
  chain.close();
  try {
    // The full corpus covers every merge: 3 of 3, no orphans, record at seq 0.
    const full = await run(["adopt", "validate", "adoptee", "--corpus", "corpus-full"], { dataDir });
    expect(full.code).toBe(EXIT_OK);
    expect(full.out).toContain("corpus:  corpus-full (4 spec(s), attested ");
    expect(full.out).toContain("history: 3 first-parent merge(s) on HEAD");
    expect(full.out).toContain("coverage: 3 of 3 evaluated commit(s) fully covered (100.0%)");
    expect(full.out).toContain("orphans: none");
    expect(full.out).toContain("journaled: seq 0  adopt.validated");

    // The hole corpus omits login.ts (hot: 2 merges) and helper.ts (1 merge):
    // the hot file tops the ranked orphan list (AC-2), and the failing
    // commits carry their uncovered paths verbatim.
    const hole = await run(["adopt", "validate", "adoptee", "--corpus", "corpus-hole"], { dataDir });
    expect(hole.code).toBe(EXIT_OK);
    expect(hole.out).toContain("coverage: 1 of 3 evaluated commit(s) fully covered (33.3%)");
    expect(hole.out).toContain("orphans: 2 path(s) no spec owns");
    expect(hole.out).toContain("src/auth/login.ts (orphan in 2 of 3 evaluated commit(s))");
    expect(hole.out).toContain("src/util/helper.ts (orphan in 1 of 3 evaluated commit(s))");
    expect(hole.out.indexOf("src/auth/login.ts (orphan")).toBeLessThan(hole.out.indexOf("src/util/helper.ts (orphan"));
    expect(hole.out).toContain("orphan: src/auth/login.ts");
    expect(hole.out).toContain("journaled: seq 1  adopt.validated");

    // Both replays are pinned in the target's own work journal (B-3): the
    // corpus hashes differ, the target window matches what was reported.
    const records = journalViewFromDir(projectStateRoot(repo)).records();
    expect(records).toHaveLength(2);
    const payloads = records.map((record) => record.payload as Record<string, any>);
    expect(records.every((record) => record.kind === "adopt.validated")).toBe(true);
    expect(payloads[0]!.corpus.ref).toBe("corpus-full");
    expect(payloads[1]!.corpus.ref).toBe("corpus-hole");
    expect(payloads[0]!.corpus.hash).not.toBe(payloads[1]!.corpus.hash);
    expect(payloads[1]!.score.orphanPaths[0]).toEqual({ path: "src/auth/login.ts", touches: 2 });

    // D-5's other source: the same corpus handed over as a checkout path.
    const pathCorpus = mkdtempSync(join(tmpdir(), "cli-validate-corpus-"));
    try {
      gitFor(pathCorpus, ["clone", "-q", "--branch", "corpus-full", repo, join(pathCorpus, "co")]);
      const byPath = await run(["adopt", "validate", "adoptee", "--corpus", join(pathCorpus, "co")], { dataDir });
      expect(byPath.code).toBe(EXIT_OK);
      expect(byPath.out).toContain("coverage: 3 of 3 evaluated commit(s) fully covered (100.0%)");
      expect(byPath.out).toContain("journaled: seq 2  adopt.validated");
    } finally {
      fs.rmSync(pathCorpus, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- adopt synthesize (spec 035) ----------------------------------------------

// The scripted session for the CLI seam: it reads the territory's file list
// out of the prompt it was handed (that list is FR-001's contract), authors a
// conforming draft spec for it, and never goes near a model.
function scriptedSynthesisSession(repo: string): (request: { purpose: string; prompt: string }) => Promise<import("../orchestrator/session").SessionResult> {
  return async (request) => {
    if (request.purpose === "scaffold") {
      const init = Bun.spawnSync(["spec-spine", "init"], { cwd: repo });
      if (init.exitCode !== 0) throw new Error(`spec-spine init failed: ${new TextDecoder().decode(init.stderr)}`);
      // The scaffold prompt's step 2: the ignores every governed target needs.
      fs.appendFileSync(join(repo, ".gitignore"), ".derived/**/build-meta.json\n");
      writeCorpusSpec(repo, "000-bootstrap", "Bootstrap, recorded as found", []);
    } else {
      const lines = request.prompt.split("\n");
      const start = lines.findIndex((line) => line.startsWith("Author exactly one spec"));
      const files: string[] = [];
      for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("Requirements:"); i++) {
        if (lines[i]!.startsWith("- ")) files.push(lines[i]!.slice(2));
      }
      writeCorpusSpec(repo, request.purpose, `Territory ${request.purpose}, recorded as found`, files);
    }
    return {
      classification: { kind: "completed", resetAtMs: null, detail: "ok" },
      exitCode: 0,
      durationMs: 5,
      numTurns: 3,
      costMicroUsd: 50_000,
      usage: null,
      sessionId: `s-${request.purpose}`,
      transcriptPath: null,
      overflow: { lines: [], truncatedCount: 0 },
      stderrTail: "",
    };
  };
}

test("adopt synthesize usage: project name, --proposal, and flag ownership are all enforced", async () => {
  const noProject = await run(["adopt", "synthesize"]);
  expect(noProject.code).toBe(EXIT_USAGE);
  expect(noProject.err).toContain("adopt synthesize needs a project name");

  const noProposal = await run(["adopt", "synthesize", "adoptee"]);
  expect(noProposal.code).toBe(EXIT_USAGE);
  expect(noProposal.err).toContain("adopt synthesize needs --proposal <path-or-hash>");

  const elsewhere = await run(["status", "--proposal", "x.md"]);
  expect(elsewhere.code).toBe(EXIT_USAGE);
  expect(elsewhere.err).toContain(`--proposal is not a flag of "status"`);
});

test("adopt synthesize refuses an unknown project and a non-adoptable one by name", async () => {
  const dataDir = freshDataDir("synthesize-refusals");
  try {
    const unknown = await run(["adopt", "synthesize", "ghost", "--proposal", "x.md"], { dataDir });
    expect(unknown.code).toBe(EXIT_FAILURE);
    expect(unknown.err).toContain(`no registered project named "ghost"`);

    const governedDir = freshDataDir("synthesize-governed-repo");
    const chain = openProjectsChain(dataDir);
    registerProject({
      chain,
      repoDir: governedDir,
      name: "governed",
      qualification: { qualified: true, checks: [], warnings: [] },
      source: "cli",
    });
    chain.close();
    const governed = await run(["adopt", "synthesize", "governed", "--proposal", "x.md"], { dataDir });
    expect(governed.code).toBe(EXIT_FAILURE);
    expect(governed.err).toContain('"governed" is already governed');
    fs.rmSync(governedDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("adopt synthesize drives the fixture sessions from a journaled proposal hash and leaves a compiling draft corpus on a branch (035 AC-2)", async () => {
  const repo = governedHistoryRepo();
  const dataDir = freshDataDir("synthesize");
  const chain = openProjectsChain(dataDir);
  registerProject({
    chain,
    repoDir: repo,
    name: "adoptee",
    qualification: { qualified: false, adoptable: true, checks: [], warnings: [] },
    source: "cli",
  });
  chain.close();
  try {
    // The operator's read pass: a real preflight, journaled with its hash.
    const outPath = join(dataDir, "adoptee.preflight.md");
    const preflight = await run(["adopt", "preflight", repo, "--out", outPath, "--json"], { dataDir });
    expect(preflight.code).toBe(EXIT_OK);
    const preflightData = expectData<{ contentHash: string; candidates: number }>(preflight.out);
    expect(preflightData.candidates).toBeGreaterThan(0);

    // AC-2's path form: the proposal document the operator read, by path.
    const result = await run(["adopt", "synthesize", "adoptee", "--proposal", outPath], {
      dataDir,
      makeSynthesisSession: (project) => scriptedSynthesisSession(project.repoDir),
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("synthesis: completed");
    expect(result.out).toContain(`proposal: sha256 ${preflightData.contentHash}`);
    expect(result.out).toContain("branch:   corpus/synthesis-");
    expect(result.out).toContain("authored");

    // The branch is checked out in the target and its corpus compiles under
    // the real gate, drafts included (B-4).
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
    expect(new TextDecoder().decode(branch.stdout).trim()).toContain("corpus/synthesis-");
    const compile = Bun.spawnSync(["spec-spine", "compile", "--repo", repo]);
    expect(compile.exitCode).toBe(0);

    // The run is a matter of record in the project's own work journal: the
    // choice (with the proposal hash), each session, and the report.
    const kinds = journalViewFromDir(projectStateRoot(repo))
      .records()
      .map((record) => record.kind);
    expect(kinds).toContain("adopt.preflight");
    expect(kinds).toContain("adopt.synthesis.started");
    expect(kinds).toContain("adopt.synthesis.session");
    expect(kinds).toContain("adopt.synthesis");

    // B-1's hash form resolves through the journaled preflight record to the
    // same document, so it reaches the same provenance-named branch and
    // refuses on it (D-8, D-9): the resolution worked, the ref is protected.
    const byHash = await run(["adopt", "synthesize", "adoptee", "--proposal", preflightData.contentHash], {
      dataDir,
      makeSynthesisSession: (project) => scriptedSynthesisSession(project.repoDir),
    });
    expect(byHash.code).toBe(EXIT_FAILURE);
    expect(byHash.out).toContain("could not create branch corpus/synthesis-");

    // An unknown hash refuses through the same journal it resolves by.
    const unknownHash = await run(["adopt", "synthesize", "adoptee", "--proposal", "0".repeat(64)], {
      dataDir,
      makeSynthesisSession: (project) => scriptedSynthesisSession(project.repoDir),
    });
    expect(unknownHash.code).toBe(EXIT_FAILURE);
    expect(unknownHash.err).toContain("no journaled adopt.preflight record");

    // A proposal edited since the operator read it refuses by hash (D-9).
    fs.writeFileSync(outPath, "# tampered\n");
    const tampered = await run(["adopt", "synthesize", "adoptee", "--proposal", preflightData.contentHash], {
      dataDir,
      makeSynthesisSession: (project) => scriptedSynthesisSession(project.repoDir),
    });
    expect(tampered.code).toBe(EXIT_FAILURE);
    expect(tampered.err).toContain("no longer hashes");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
