// Spec 027 FR-001: the routes are exercised against an in-process v2 server
// with a fixture registry and two fixture project journals, over real HTTP,
// through the real typed client. Nothing is stubbed at the transport.
import { test, expect } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { sha256Hex } from "../journal";
import { foldOrchestratorState, transition } from "../state";
import type { Daemon } from "../daemon";
import { createApiClient } from "./api-client";
import { EventHub } from "./events";
import {
  fixtureApiDeps,
  fixtureDaemon,
  freshRegistry,
  seedPark,
  seedRun,
  type FixtureRegistry,
  type FixtureWorld,
} from "./fixtures";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  assertLoopbackHost,
  createApiServer,
  projectSourceOf,
  type ApiDeps,
  type ApiServer,
  type ControlTarget,
} from "./server";
import {
  API_ROUTES,
  API_VERSION,
  API_VERSION_HEADER,
  CONTROL_SOURCE_HEADER,
  EVENTS_PROJECT_PARAM,
  PROJECT_ROUTES,
  SPEC_CONTROL_VERBS,
  projectRoute,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type DagView,
  type DecisionsView,
  type EvidenceView,
  type HistoryView,
  type ProjectControlResult,
  type ProjectsView,
  type QuotaView,
  type RunView,
  type SpecControlVerb,
} from "./types";

// --- the control seam is the real daemon's own surface (022 B-5) ------------
//
// Compile-time proof that spec 021's Daemon satisfies ControlTarget with no
// adapter: if a control method's signature ever diverges, this stops being
// assignable and typecheck fails rather than a runtime wiring bug appearing
// the first time someone POSTs a control.
type DaemonSatisfiesControlTarget = Daemon extends ControlTarget ? true : false;
const _daemonIsAControlTarget: DaemonSatisfiesControlTarget = true;
expect(_daemonIsAControlTarget).toBe(true);

// --- harness ----------------------------------------------------------------

interface World {
  readonly registry: FixtureRegistry;
  readonly server: ApiServer;
  // "alpha" is armed, qualified, and controllable; "beta" is disarmed,
  // unqualified, and has no live run, which is the pair 025 B-4 and 026 D-2
  // both want visible at once.
  readonly alpha: FixtureWorld;
  readonly beta: FixtureWorld;
}

function alphaRoute(suffix: string): string {
  return projectRoute("alpha", suffix);
}

async function withServer(
  prefix: string,
  body: (world: World) => Promise<void>,
  overrides: Partial<ApiDeps> = {}
): Promise<void> {
  const registry = freshRegistry(prefix);
  const alpha = registry.add("alpha");
  const beta = registry.add("beta", { armed: false, qualified: false, controls: false });
  const server = createApiServer(fixtureApiDeps(registry, overrides));
  try {
    await body({ registry, server, alpha, beta });
  } finally {
    await server.stop();
    registry.close();
  }
}

async function getJson<T>(server: ApiServer, path: string, init?: RequestInit): Promise<{ status: number; body: ApiResponse<T> }> {
  const response = await fetch(`${server.url}${path}`, init);
  return { status: response.status, body: (await response.json()) as ApiResponse<T> };
}

function expectOk<T>(body: ApiResponse<T>): T {
  if (!body.ok) throw new Error(`expected ok envelope, got ${body.error.kind}: ${body.error.message}`);
  return body.data;
}

function expectErr<T>(body: ApiResponse<T>): { kind: string; message: string } {
  if (body.ok) throw new Error("expected an error envelope, got ok");
  return body.error;
}

// Reads an SSE response for a bounded wall-clock window, then hangs up.
// Never waits on the stream ending: an SSE stream is meant not to end. The
// request is aborted as well as cancelled, so the socket is genuinely
// released rather than parked in the fetch client's keep-alive pool, which
// would leave the server with a connection it is still waiting on at stop().
async function readSseFor(url: string, ms: number, headers: Record<string, string> = {}): Promise<string> {
  const abort = new AbortController();
  const response = await fetch(url, { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let text = "";
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the server may already have closed it
    }
    abort.abort();
  }
  return text;
}

function sseData(text: string): { project: string | null; seq: number | null; kind: string; data: unknown }[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { project: string | null; seq: number | null; kind: string; data: unknown });
}

async function curlJson(url: string, extraHeaders: readonly string[] = []): Promise<{ exitCode: number; body: string }> {
  // Bun.spawnSync would block this process's own event loop, and the server
  // under test lives in it, so curl would time out against a daemon that
  // cannot answer. The async spawn is the only correct shape here.
  const headers = extraHeaders.flatMap((h) => ["-H", h]);
  const proc = Bun.spawn(["curl", "--silent", "--show-error", "--fail-with-body", "--max-time", "10", ...headers, url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [body, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, body };
}

// --- binding (022 B-1, unchanged by 027) ------------------------------------

test("the server refuses a non-loopback bind and names why", () => {
  expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback only/);
  expect(() => assertLoopbackHost("192.168.1.10")).toThrow(/loopback only/);
  expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  expect(() => assertLoopbackHost("localhost")).not.toThrow();
  expect(() => assertLoopbackHost("::1")).not.toThrow();
});

test("createApiServer refuses a non-loopback host before it ever binds", () => {
  const registry = freshRegistry("bind");
  try {
    expect(() => createApiServer(fixtureApiDeps(registry, { host: "0.0.0.0" }))).toThrow(/refusing to bind/);
  } finally {
    registry.close();
  }
});

test("the documented defaults are the ones the daemon binds", () => {
  expect(DEFAULT_API_HOST).toBe("127.0.0.1");
  expect(DEFAULT_API_PORT).toBe(4519);
});

// --- version and envelope (B-1) ---------------------------------------------

test("/api/meta serves apiVersion 2, the daemon state, and the v2 route list", async () => {
  await withServer("meta", async ({ server }) => {
    const { status, body } = await getJson<ApiMeta>(server, API_ROUTES.meta);
    expect(status).toBe(200);
    const meta = expectOk(body);
    expect(meta).toMatchObject({
      apiVersion: 2,
      service: "claude-observatory-orchestrator",
      loopbackOnly: true,
      controlsAvailable: true,
      projectCount: 2,
    });
    expect(meta.daemon).toEqual({ state: "standby", activeProject: null, scanIntervalMs: 60_000, lastScanMs: null });

    // The table is the v2 one, and carries no v1 path at all.
    expect(meta.routes).toContain(API_ROUTES.projects);
    expect(meta.routes).toContain("/api/projects/<name>/dag");
    expect(meta.routes).toContain("/api/projects/<name>/spec/<id>/approve");
    expect(meta.routes).toContain("/api/projects/<name>/arm");
    expect(meta.routes).not.toContain("/api/dag");
    expect(meta.routes).not.toContain("/api/run");
  });
});

test("AC-2: a client declaring X-Api-Version: 1 is refused with the version-mismatch envelope", async () => {
  await withServer("version", async ({ server }) => {
    const v1 = await getJson<ApiMeta>(server, API_ROUTES.meta, { headers: { [API_VERSION_HEADER]: "1" } });
    expect(v1.status).toBe(400);
    expect(expectErr(v1.body).kind).toBe("api-version-mismatch");
    expect(expectErr(v1.body).message).toContain("apiVersion 2");

    const v2 = await getJson<ApiMeta>(server, API_ROUTES.meta, { headers: { [API_VERSION_HEADER]: "2" } });
    expect(v2.body.ok).toBe(true);

    // No declared version is served on the v2 assumption, so plain curl works.
    const undeclared = await getJson<ApiMeta>(server, API_ROUTES.meta);
    expect(undeclared.body.ok).toBe(true);
  });
});

test("the daemon state tells a held flight slot from a parked one", async () => {
  const registry = freshRegistry("daemon-state");
  const alpha = registry.add("alpha");
  const driving = createApiServer(
    fixtureApiDeps(registry, {
      daemon: fixtureDaemon({ state: "scheduling", activeProject: "alpha", lastScanMs: 1_700_000_000_000 }),
      clock: { now: () => 1_700_000_000_000 },
    })
  );
  try {
    expect(expectOk((await getJson<ApiMeta>(driving, API_ROUTES.meta)).body).daemon?.state).toBe("driving");
    seedPark(alpha, 1_700_000_600_000);
    expect(expectOk((await getJson<ApiMeta>(driving, API_ROUTES.meta)).body).daemon?.state).toBe("parked");
  } finally {
    await driving.stop();
    registry.close();
  }
});

test("a server with no scheduler attached reports a null daemon rather than inventing one", async () => {
  await withServer(
    "no-daemon",
    async ({ server }) => {
      expect(expectOk((await getJson<ApiMeta>(server, API_ROUTES.meta)).body).daemon).toBeNull();
    },
    { daemon: null }
  );
});

test("an unknown route and a wrong method both answer in the envelope", async () => {
  await withServer("routing", async ({ server }) => {
    const missing = await getJson<never>(server, "/api/nope");
    expect(missing.status).toBe(404);
    expect(expectErr(missing.body).kind).toBe("not-found");

    const wrongMethod = await getJson<never>(server, alphaRoute(PROJECT_ROUTES.dag), { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(expectErr(wrongMethod.body).kind).toBe("method-not-allowed");

    const wrongMethodControl = await getJson<never>(server, alphaRoute(PROJECT_ROUTES.runPause));
    expect(wrongMethodControl.status).toBe(405);
    expect(expectErr(wrongMethodControl.body).kind).toBe("method-not-allowed");

    // A v1 path is gone, not aliased: it is simply not a route.
    const retired = await getJson<never>(server, "/api/dag");
    expect(retired.status).toBe(404);
  });
});

test("the authorize seam can refuse every route without any shape changing", async () => {
  await withServer(
    "authorize",
    async ({ server }) => {
      const { status, body } = await getJson<RunView>(server, alphaRoute(PROJECT_ROUTES.run));
      expect(status).toBe(503);
      expect(expectErr(body)).toEqual({ kind: "unavailable", message: "no token" });
    },
    { authorize: () => ({ kind: "unavailable", message: "no token" }) }
  );
});

test("an internal failure still leaves through the one envelope", async () => {
  await withServer("internal", async ({ server, alpha }) => {
    alpha.dagReader.registryListJson = () => {
      throw new Error("registry is unavailable");
    };
    const { status, body } = await getJson<DagView>(server, alphaRoute(PROJECT_ROUTES.dag));
    expect(status).toBe(500);
    expect(expectErr(body).kind).toBe("internal");
    expect(expectErr(body).message).toContain("registry is unavailable");
  });
});

// --- the project collection (B-2) -------------------------------------------

test("/api/projects lists the folded registry with reasons and a run summary", async () => {
  await withServer("projects-list", async ({ server, alpha }) => {
    const seeded = seedRun(alpha);

    const view = expectOk((await getJson<ProjectsView>(server, API_ROUTES.projects)).body);
    expect(view.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);

    const [first, second] = view.projects;
    expect(first).toMatchObject({ name: "alpha", repoDir: alpha.repoDir, armed: true, readError: null });
    expect(first!.qualification.qualified).toBe(true);
    expect(first!.run?.id).toBe(seeded.runId);
    expect(first!.spec?.specId).toBe("003-gamma");
    expect(first!.stage?.stage).toBe("build");

    // 025 B-4: a refused target stays visible with the reason attached.
    expect(second).toMatchObject({ name: "beta", armed: false, run: null, spec: null });
    expect(second!.qualification.qualified).toBe(false);
    expect(second!.qualification.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([`no "origin" remote`]);
  });
});

test("POST /api/projects registers a target and answers with the chain's own record", async () => {
  await withServer("projects-register", async ({ server, registry }) => {
    const fresh = registry.world("gamma");
    const before = registry.chain.fold().records.length;

    const { status, body } = await getJson<ProjectControlResult>(server, API_ROUTES.projects, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CONTROL_SOURCE_HEADER]: "cli:operator" },
      body: JSON.stringify({ path: fresh.repoDir, name: "gamma" }),
    });
    expect(status).toBe(200);
    const result = expectOk(body);
    expect(result).toMatchObject({ verb: "register", project: "gamma", applied: true });
    expect(result.record?.kind).toBe("project.registered");
    expect(result.record?.payload).toMatchObject({ name: "gamma", repoDir: fresh.repoDir, armed: true, source: "cli" });
    expect(result.snapshot).toMatchObject({ name: "gamma", armed: true });

    // The API appended nothing itself: exactly the one record the registry
    // helper wrote is in the chain (022 D-2).
    expect(registry.chain.fold().records.length).toBe(before + 1);
    expect(registry.projects().has("gamma")).toBe(true);
  });
});

test("a registration without a usable body, or onto a taken name, is refused before the chain moves", async () => {
  await withServer("projects-register-refused", async ({ server, registry, alpha }) => {
    const before = registry.chain.fold().records.length;

    const noPath = await getJson<ProjectControlResult>(server, API_ROUTES.projects, { method: "POST" });
    expect(noPath.status).toBe(400);
    expect(expectErr(noPath.body).message).toContain(`"path"`);

    const badName = await getJson<ProjectControlResult>(server, API_ROUTES.projects, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: alpha.repoDir, name: "Not A Slug" }),
    });
    expect(badName.status).toBe(400);

    const taken = await getJson<ProjectControlResult>(server, API_ROUTES.projects, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: alpha.repoDir, name: "alpha" }),
    });
    expect(taken.status).toBe(409);
    expect(expectErr(taken.body).kind).toBe("conflict");
    expect(expectErr(taken.body).message).toContain("already registered");

    expect(registry.chain.fold().records.length).toBe(before);
  });
});

test("arm, disarm, requalify, and remove each answer with the record the chain carries", async () => {
  await withServer("projects-controls", async ({ server, registry }) => {
    const armed = expectOk(
      (await getJson<ProjectControlResult>(server, projectRoute("beta", PROJECT_ROUTES.arm), { method: "POST" })).body
    );
    expect(armed).toMatchObject({ verb: "arm", project: "beta", applied: true });
    expect(armed.record?.kind).toBe("project.armed");
    expect(armed.snapshot?.armed).toBe(true);

    const disarmed = expectOk(
      (await getJson<ProjectControlResult>(server, projectRoute("beta", PROJECT_ROUTES.disarm), { method: "POST" })).body
    );
    expect(disarmed.record?.kind).toBe("project.disarmed");
    expect(disarmed.snapshot?.armed).toBe(false);

    const requalified = expectOk(
      (await getJson<ProjectControlResult>(server, projectRoute("beta", PROJECT_ROUTES.requalify), { method: "POST" })).body
    );
    expect(requalified.record?.kind).toBe("project.requalified");
    expect(requalified.snapshot?.qualification.qualified).toBe(true);

    const removed = expectOk(
      (await getJson<ProjectControlResult>(server, projectRoute("beta", PROJECT_ROUTES.remove), { method: "POST" })).body
    );
    expect(removed.record?.kind).toBe("project.removed");
    // Removal is a tombstone (025 D-2): there is no project left to snapshot.
    expect(removed.snapshot).toBeNull();
    expect(registry.projects().has("beta")).toBe(false);
  });
});

test("an unknown project name answers not-found on every scoped route, never an empty success", async () => {
  await withServer("unknown-project", async ({ server }) => {
    const reads = [PROJECT_ROUTES.dag, PROJECT_ROUTES.run, PROJECT_ROUTES.decisions, PROJECT_ROUTES.history];
    for (const suffix of reads) {
      const { status, body } = await getJson<never>(server, projectRoute("nope", suffix));
      expect({ suffix, status }).toEqual({ suffix, status: 404 });
      expect(expectErr(body).message).toContain(`no registered project named "nope"`);
    }

    const control = await getJson<never>(server, projectRoute("nope", PROJECT_ROUTES.runPause), { method: "POST" });
    expect(control.status).toBe(404);

    const registryControl = await getJson<never>(server, projectRoute("nope", PROJECT_ROUTES.arm), { method: "POST" });
    expect(registryControl.status).toBe(404);

    // A name that cannot be a project name at all is a malformed request,
    // which is a different fact from a name this daemon does not have.
    const malformed = await getJson<never>(server, projectRoute("Not-A-Slug", PROJECT_ROUTES.run));
    expect(malformed.status).toBe(400);
    expect(expectErr(malformed.body).kind).toBe("bad-request");
  });
});

// --- scoped reads (B-3) -----------------------------------------------------

test("every scoped read serves that project's journals, named in the payload", async () => {
  await withServer("reads", async ({ server, alpha, beta }) => {
    const seeded = seedRun(alpha);
    beta.decisions.append("decision.sealed", {
      id: "b-1",
      specId: "002-beta",
      scope: ["002-beta"],
      title: "Beta only",
      decision: "This decision belongs to beta",
      rationale: "Scoping is the whole point",
    });

    const dag = expectOk((await getJson<DagView>(server, alphaRoute(PROJECT_ROUTES.dag))).body);
    expect(dag.project).toBe("alpha");
    expect(dag.specs.map((s) => s.id)).toEqual(["001-alpha", "002-beta", "003-gamma"]);
    expect(dag.nextReady).toBe("003-gamma");

    const run = expectOk((await getJson<RunView>(server, alphaRoute(PROJECT_ROUTES.run))).body);
    expect(run.project).toBe("alpha");
    expect(run.run?.id).toBe(seeded.runId);
    expect(run.spec?.specId).toBe("003-gamma");
    expect(run.stage?.stage).toBe("build");

    const history = expectOk((await getJson<HistoryView>(server, alphaRoute(PROJECT_ROUTES.history))).body);
    expect(history.project).toBe("alpha");
    expect(history.entries.map((e) => e.specId)).toEqual(["002-beta", "003-gamma"]);
    expect(history.entries[0]!.evidenceRefs).toEqual([seeded.evidenceHash]);

    // beta's journals are its own: its dag is untouched by alpha's run, and
    // its ledger holds the decision alpha's does not.
    const betaRun = expectOk((await getJson<RunView>(server, projectRoute("beta", PROJECT_ROUTES.run))).body);
    expect(betaRun).toMatchObject({ project: "beta", run: null, spec: null, stage: null });

    const betaDecisions = expectOk(
      (await getJson<DecisionsView>(server, projectRoute("beta", PROJECT_ROUTES.decisions))).body
    );
    expect(betaDecisions.project).toBe("beta");
    expect(betaDecisions.decisions.map((d) => d.id)).toEqual(["b-1"]);

    const alphaDecisions = expectOk((await getJson<DecisionsView>(server, alphaRoute(PROJECT_ROUTES.decisions))).body);
    expect(alphaDecisions.total).toBe(0);
  });
});

test("a scoped decisions query passes through to that project's ledger", async () => {
  await withServer("decisions-route", async ({ server, alpha }) => {
    alpha.decisions.append("decision.sealed", {
      id: "d-1",
      specId: "002-beta",
      scope: ["002-beta"],
      title: "Ring capacity",
      decision: "Keep 256 events",
      rationale: "Matches the documented replay window",
    });

    const matched = expectOk(
      (await getJson<DecisionsView>(server, `${alphaRoute(PROJECT_ROUTES.decisions)}?query=replay`)).body
    );
    expect(matched.decisions.map((d) => d.id)).toEqual(["d-1"]);
    expect(matched.query).toEqual({ query: "replay" });

    const missed = expectOk(
      (await getJson<DecisionsView>(server, `${alphaRoute(PROJECT_ROUTES.decisions)}?specId=999-nope`)).body
    );
    expect(missed.total).toBe(0);
  });
});

test("scoped evidence serves a content-addressed file, and raw bytes on request", async () => {
  await withServer("evidence-route", async ({ server, alpha }) => {
    const seeded = seedRun(alpha);
    const path = alphaRoute(`${PROJECT_ROUTES.evidencePrefix}${seeded.evidenceHash}`);

    const { status, body } = await getJson<EvidenceView>(server, path);
    expect(status).toBe(200);
    const evidence = expectOk(body);
    expect(evidence).toMatchObject({ project: "alpha", hash: seeded.evidenceHash, mediaType: "text/plain", base64: null });
    expect(evidence.text).toContain("bun test");
    expect(evidence.bytes).toBe(evidence.text!.length);

    const raw = await fetch(`${server.url}${path}?raw=1`);
    expect(raw.headers.get("content-type")).toBe("text/plain");
    expect(await raw.text()).toContain("bun test");

    // The same hash under a project that does not hold it is not found: the
    // evidence directory is resolved inside the named project (010 D13).
    const elsewhere = await getJson<EvidenceView>(server, projectRoute("beta", `${PROJECT_ROUTES.evidencePrefix}${seeded.evidenceHash}`));
    expect(elsewhere.status).toBe(404);
  });
});

test("scoped evidence serves a png as base64 and refuses anything that is not a content hash", async () => {
  await withServer("evidence-png", async ({ server, alpha }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sha256Hex(png.toString("binary")).length).toBe(64);
    // The stored name is whatever the verify stage hashed to; this test only
    // needs a valid 64-hex name that exists on disk.
    const named = "a".repeat(64);
    fs.writeFileSync(join(alpha.evidenceDir, `${named}.png`), png);

    const evidence = expectOk(
      (await getJson<EvidenceView>(server, alphaRoute(`${PROJECT_ROUTES.evidencePrefix}${named}`))).body
    );
    expect(evidence).toMatchObject({ mediaType: "image/png", text: null, bytes: png.length });
    expect(Buffer.from(evidence.base64!, "base64").equals(png)).toBe(true);

    const traversal = await getJson<EvidenceView>(
      server,
      alphaRoute(`${PROJECT_ROUTES.evidencePrefix}${encodeURIComponent("../../etc/passwd")}`)
    );
    expect(traversal.status).toBe(400);
    expect(expectErr(traversal.body).kind).toBe("bad-request");

    const missing = await getJson<EvidenceView>(server, alphaRoute(`${PROJECT_ROUTES.evidencePrefix}${"b".repeat(64)}`));
    expect(missing.status).toBe(404);
    expect(expectErr(missing.body).kind).toBe("not-found");
  });
});

// --- the global quota pool (B-4) --------------------------------------------

test("/api/quota is one pool across every project, naming whose journal parked it", async () => {
  const registry = freshRegistry("quota-route");
  const alpha = registry.add("alpha");
  registry.add("beta");
  const target = 1_700_000_600_000;
  const server = createApiServer(fixtureApiDeps(registry, { clock: { now: () => 1_700_000_000_000 } }));
  try {
    const idle = expectOk((await getJson<QuotaView>(server, API_ROUTES.quota)).body);
    expect(idle).toMatchObject({ parked: false, project: null, targetMs: null, consecutiveQuotaParks: 0 });

    seedPark(alpha, target, 1, true);
    const parked = expectOk((await getJson<QuotaView>(server, API_ROUTES.quota)).body);
    expect(parked).toMatchObject({
      parked: true,
      project: "alpha",
      targetMs: target,
      estimated: true,
      msUntilTarget: 600_000,
      consecutiveQuotaParks: 1,
      warn: false,
      nowMs: 1_700_000_000_000,
    });
  } finally {
    await server.stop();
    registry.close();
  }
});

// --- scoped controls (B-5) --------------------------------------------------

test("a scoped control returns the record that project's daemon journaled", async () => {
  await withServer("control-pause", async ({ server, alpha, beta }) => {
    seedRun(alpha);
    const before = alpha.journal.fold().records.length;
    const betaBefore = beta.journal.fold().records.length;

    const { status, body } = await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runPause), {
      method: "POST",
      headers: { [CONTROL_SOURCE_HEADER]: "cli:operator" },
    });
    expect(status).toBe(200);
    const result = expectOk(body);
    expect(result).toMatchObject({ project: "alpha", verb: "pause", applied: true, runStatus: "running" });
    expect(result.record?.kind).toBe("control.pause");
    expect(result.record?.payload).toMatchObject({ source: "cli:operator" });

    // The record landed in alpha's journal and nowhere else.
    expect(alpha.journal.fold().records.length).toBe(before + 1);
    expect(beta.journal.fold().records.length).toBe(betaBefore);
  });
});

test("a control source can also arrive in the JSON body, defaulting when absent", async () => {
  await withServer("control-source", async ({ server, alpha }) => {
    seedRun(alpha);

    const fromBody = expectOk(
      (
        await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}003-gamma/skip`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "web-ui" }),
        })
      ).body
    );
    expect(fromBody.record?.payload).toMatchObject({ specId: "003-gamma", source: "web-ui" });

    const defaulted = expectOk(
      (await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}003-gamma/approve`), { method: "POST" })).body
    );
    expect(defaulted.record?.payload).toMatchObject({ source: "api" });
  });
});

test("every spec control verb reaches its own daemon method, inside the named project", async () => {
  await withServer("control-verbs", async ({ server, alpha }) => {
    seedRun(alpha);
    const cases: readonly [SpecControlVerb, string][] = [
      ["skip", "control.skipSpec"],
      ["retry-stage", "control.retryStage"],
      ["reverify", "control.reverify"],
      ["force-human-gate", "control.forceHumanGate"],
      ["approve", "control.approve"],
    ];
    // Every verb the route table declares is covered here, so a new one
    // cannot be added without this list failing to match.
    expect(cases.map(([verb]) => verb)).toEqual([...SPEC_CONTROL_VERBS]);
    for (const [verb, kind] of cases) {
      const result = expectOk(
        (await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}003-gamma/${verb}`), { method: "POST" })).body
      );
      expect(result).toMatchObject({ project: "alpha", verb, specId: "003-gamma" });
      expect(result.record?.kind).toBe(kind);
    }
  });
});

test("pause and resume are idempotent, journaling nothing when already satisfied", async () => {
  await withServer("control-idempotent", async ({ server, alpha }) => {
    seedRun(alpha);
    const state = foldOrchestratorState(alpha.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    transition(alpha.journal, run, "paused");
    const before = alpha.journal.fold().records.length;

    const pauseAgain = expectOk((await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runPause), { method: "POST" })).body);
    expect(pauseAgain.applied).toBe(false);
    expect(pauseAgain.record).toBeNull();
    expect(pauseAgain.runStatus).toBe("paused");
    expect(alpha.journal.fold().records.length).toBe(before);

    const resume = expectOk((await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runResume), { method: "POST" })).body);
    expect(resume.applied).toBe(true);
    expect(resume.record?.kind).toBe("control.resume");
  });
});

test("start resumes a paused run, no-ops a running one, and refuses the rest", async () => {
  await withServer("control-start", async ({ server, alpha }) => {
    const noRun = await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runStart), { method: "POST" });
    expect(noRun.status).toBe(409);
    expect(expectErr(noRun.body).message).toContain("has no run yet");

    seedRun(alpha);
    const running = expectOk((await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runStart), { method: "POST" })).body);
    expect(running.applied).toBe(false);
    expect(running.runStatus).toBe("running");

    const state = foldOrchestratorState(alpha.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    const paused = transition(alpha.journal, run, "paused");
    const started = expectOk((await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runStart), { method: "POST" })).body);
    expect(started.verb).toBe("start");
    expect(started.applied).toBe(true);
    expect(started.record?.kind).toBe("control.resume");

    transition(alpha.journal, transition(alpha.journal, paused, "running"), "completed");
    const terminal = await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runStart), { method: "POST" });
    expect(terminal.status).toBe(409);
    expect(expectErr(terminal.body).message).toContain('"completed" cannot be started');
  });
});

test("a control the daemon refuses is reported as a conflict, not a crash", async () => {
  await withServer("control-conflict", async ({ server, alpha }) => {
    seedRun(alpha);
    const state = foldOrchestratorState(alpha.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    transition(alpha.journal, run, "completed");

    const { status, body } = await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runResume), { method: "POST" });
    expect(status).toBe(409);
    expect(expectErr(body).kind).toBe("conflict");
    expect(expectErr(body).message).toContain('requires the run to be "paused"');
  });
});

test("a project with no live run answers controls as unavailable rather than pretending", async () => {
  await withServer("control-no-run", async ({ server }) => {
    const { status, body } = await getJson<ControlResult>(server, projectRoute("beta", PROJECT_ROUTES.runPause), { method: "POST" });
    expect(status).toBe(503);
    expect(expectErr(body).kind).toBe("unavailable");
    expect(expectErr(body).message).toContain(`project "beta"`);
  });
});

test("a read-only server refuses every control, registry controls included", async () => {
  await withServer(
    "control-unavailable",
    async ({ server, alpha, registry }) => {
      seedRun(alpha);
      const before = registry.chain.fold().records.length;

      const scoped = await getJson<ControlResult>(server, alphaRoute(PROJECT_ROUTES.runPause), { method: "POST" });
      expect(scoped.status).toBe(503);
      expect(expectErr(scoped.body).kind).toBe("unavailable");

      const arm = await getJson<ProjectControlResult>(server, projectRoute("beta", PROJECT_ROUTES.arm), { method: "POST" });
      expect(arm.status).toBe(503);

      const register = await getJson<ProjectControlResult>(server, API_ROUTES.projects, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/tmp/nope" }),
      });
      expect(register.status).toBe(503);

      expect(registry.chain.fold().records.length).toBe(before);
      expect(expectOk((await getJson<ApiMeta>(server, API_ROUTES.meta)).body).controlsAvailable).toBe(false);
    },
    { controlsAvailable: false }
  );
});

test("a malformed spec control path or verb is refused before any control runs", async () => {
  await withServer("control-bad-path", async ({ server, alpha }) => {
    seedRun(alpha);
    const before = alpha.journal.fold().records.length;

    const badVerb = await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}003-gamma/detonate`), { method: "POST" });
    expect(badVerb.status).toBe(404);
    expect(expectErr(badVerb.body).message).toContain("unknown spec control verb");

    const badShape = await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}003-gamma`), { method: "POST" });
    expect(badShape.status).toBe(400);

    const badId = await getJson<ControlResult>(
      server,
      alphaRoute(`${PROJECT_ROUTES.specPrefix}${encodeURIComponent("../etc")}/skip`),
      { method: "POST" }
    );
    expect(badId.status).toBe(400);
    expect(expectErr(badId.body).kind).toBe("bad-request");

    // A malformed percent-escape is the caller's request being wrong, not
    // this server's internals failing: it belongs in the same bad-request
    // class as every other unusable spec id, never in the 500 an uncaught
    // decodeURIComponent throw would produce.
    const badEscape = await getJson<ControlResult>(server, alphaRoute(`${PROJECT_ROUTES.specPrefix}%ZZ/skip`), { method: "POST" });
    expect(badEscape.status).toBe(400);
    expect(expectErr(badEscape.body).kind).toBe("bad-request");

    expect(alpha.journal.fold().records.length).toBe(before);
  });
});

test("a free-form control source is narrowed to one of 025's three surfaces on the registry chain", () => {
  expect(projectSourceOf("cli")).toBe("cli");
  expect(projectSourceOf("cli:operator")).toBe("cli");
  expect(projectSourceOf("web-ui")).toBe("ui");
  expect(projectSourceOf("ui")).toBe("ui");
  expect(projectSourceOf("api")).toBe("api");
  expect(projectSourceOf("something-else")).toBe("api");
});

// --- events (B-4, FR-001) ---------------------------------------------------

test("/api/events opens with the retry directive and heartbeats on its own cadence", async () => {
  await withServer(
    "sse-heartbeat",
    async ({ server }) => {
      const text = await readSseFor(`${server.url}${API_ROUTES.events}`, 200);
      expect(text.startsWith("retry: 3000\n\n")).toBe(true);
      const heartbeats = text.split(": heartbeat\n\n").length - 1;
      expect(heartbeats).toBeGreaterThanOrEqual(2);
    },
    { heartbeatMs: 30 }
  );
});

test("every event names its project, and a registry record names none", async () => {
  await withServer(
    "sse-project",
    async ({ server, registry, alpha, beta }) => {
      const streamed = readSseFor(`${server.url}${API_ROUTES.events}`, 500);
      // Let the subscription establish before appending, then let the pump
      // notice on its own timer.
      await Bun.sleep(60);
      alpha.journal.append("control.pause", { runId: "r", source: "api" });
      beta.journal.append("daemon.heartbeat", { runId: "r", runStatus: "running", ts: 1 });
      registry.target.setArmed("beta", true, "api");
      const text = await streamed;

      const events = sseData(text);
      expect(events.find((e) => e.kind === "control.pause")).toMatchObject({ project: "alpha" });
      expect(events.find((e) => e.kind === "daemon.heartbeat")).toMatchObject({ project: "beta" });
      // The registry chain belongs to the daemon, not to any project.
      expect(events.find((e) => e.kind === "project.armed")).toMatchObject({ project: null });
      expect(text).toContain("event: project");
    },
    { heartbeatMs: 10_000, pumpIntervalMs: 20 }
  );
});

test("?project filters the stream to one project, daemon-scoped events included", async () => {
  await withServer(
    "sse-filter",
    async ({ server, registry, alpha, beta }) => {
      const streamed = readSseFor(`${server.url}${API_ROUTES.events}?${EVENTS_PROJECT_PARAM}=alpha`, 500);
      await Bun.sleep(60);
      alpha.journal.append("control.pause", { runId: "r", source: "api" });
      beta.journal.append("control.resume", { runId: "r", source: "api" });
      registry.target.setArmed("beta", true, "api");
      const text = await streamed;

      const projects = sseData(text).map((e) => e.project);
      expect(projects).toContain("alpha");
      expect(projects).toContain(null);
      expect(projects).not.toContain("beta");
    },
    { heartbeatMs: 10_000, pumpIntervalMs: 20 }
  );
});

test("an unknown or malformed ?project filter is refused rather than served as an empty stream", async () => {
  await withServer("sse-filter-refused", async ({ server }) => {
    const unknown = await getJson<never>(server, `${API_ROUTES.events}?${EVENTS_PROJECT_PARAM}=nope`);
    expect(unknown.status).toBe(404);

    const malformed = await getJson<never>(server, `${API_ROUTES.events}?${EVENTS_PROJECT_PARAM}=Not-A-Slug`);
    expect(malformed.status).toBe(400);
  });
});

test("/api/events replays from Last-Event-ID and reports an unrecoverable gap", async () => {
  await withServer(
    "sse-replay",
    async ({ server, alpha }) => {
      for (let i = 0; i < 4; i++) {
        alpha.journal.append("daemon.heartbeat", { runId: "r", runStatus: "running", ts: i });
      }
      server.pump.pumpOnce();
      expect(server.hub.lastEventId).toBe(4);

      const replayed = await readSseFor(`${server.url}${API_ROUTES.events}`, 150, { "Last-Event-ID": "2" });
      expect(replayed).toContain("id: 3\n");
      expect(replayed).toContain("id: 4\n");
      expect(replayed).not.toContain("id: 1\n");
      expect(replayed).not.toContain("api.replay-gap");

      // The ring holds 3 here, so resuming from 0 cannot be complete.
      const gapped = await readSseFor(`${server.url}${API_ROUTES.events}`, 150, { "Last-Event-ID": "0" });
      expect(gapped).toContain("api.replay-gap");
    },
    { heartbeatMs: 10_000, pumpIntervalMs: 1_000_000, eventRingCapacity: 3 }
  );
});

test("stopping the server tears down the pump and every open stream", async () => {
  const registry = freshRegistry("sse-stop");
  registry.add("alpha");
  const server = createApiServer(fixtureApiDeps(registry, { heartbeatMs: 20, pumpIntervalMs: 20 }));
  try {
    const response = await fetch(`${server.url}${API_ROUTES.events}`);
    const reader = response.body!.getReader();
    await reader.read(); // the retry directive
    expect(server.hub.listenerCount).toBe(1);

    await server.stop();
    expect(server.hub.listenerCount).toBe(0);
    await reader.cancel().catch(() => {});
  } finally {
    registry.close();
  }
});

test("the hub is the server's own, so a caller can publish alongside the pump", async () => {
  await withServer("sse-hub", async ({ server }) => {
    expect(server.hub).toBeInstanceOf(EventHub);
  });
});

// --- AC-2: curl every v2 read route, then round-trip through the client -----

test("AC-2: curl of every v2 read route returns the documented envelope", async () => {
  await withServer("ac2-curl", async ({ server, alpha }) => {
    const seeded = seedRun(alpha);
    alpha.decisions.append("decision.sealed", {
      id: "d-1",
      specId: "002-beta",
      scope: ["002-beta"],
      title: "Curl is a client",
      decision: "No declared version header is served on the v2 assumption",
      rationale: "The API must be usable from a terminal with no wrapper",
    });

    const paths = [
      API_ROUTES.meta,
      API_ROUTES.quota,
      API_ROUTES.projects,
      alphaRoute(PROJECT_ROUTES.dag),
      alphaRoute(PROJECT_ROUTES.run),
      `${alphaRoute(PROJECT_ROUTES.decisions)}?query=curl`,
      alphaRoute(PROJECT_ROUTES.history),
      alphaRoute(`${PROJECT_ROUTES.evidencePrefix}${seeded.evidenceHash}`),
    ];

    for (const path of paths) {
      const { exitCode, body } = await curlJson(`${server.url}${path}`, [`${API_VERSION_HEADER}: ${API_VERSION}`]);
      expect({ path, exitCode }).toEqual({ path, exitCode: 0 });
      const parsed = JSON.parse(body) as ApiResponse<unknown>;
      expect({ path, ok: parsed.ok }).toEqual({ path, ok: true });
      expect({ path, hasData: "data" in parsed }).toEqual({ path, hasData: true });
    }

    // The same envelope on the failure side, by curl, with a stable token.
    const missing = await curlJson(`${server.url}/api/nope`);
    expect(missing.exitCode).toBe(22);
    expect(JSON.parse(missing.body)).toEqual({ ok: false, error: { kind: "not-found", message: "no route for GET /api/nope" } });

    // AC-2's other half, by curl: a declared v1 gets the version-mismatch
    // envelope rather than a shape it cannot parse.
    const v1 = await curlJson(`${server.url}${API_ROUTES.meta}`, [`${API_VERSION_HEADER}: 1`]);
    expect(v1.exitCode).toBe(22);
    const refused = JSON.parse(v1.body) as ApiResponse<unknown>;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("api-version-mismatch");
  });
});

test("AC-2: every v2 shape round-trips through the generated client", async () => {
  await withServer("ac2-client", async ({ server, alpha }) => {
    const seeded = seedRun(alpha);
    const client = createApiClient({ baseUrl: server.url, source: "cli:test" });

    const meta = await client.meta();
    expect(meta.ok && meta.data.apiVersion).toBe(API_VERSION);

    const quota = await client.quota();
    expect(quota.ok && quota.data.parked).toBe(false);

    const projects = await client.projects();
    expect(projects.ok && projects.data.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);

    const scoped = client.project("alpha");
    const dag = await scoped.dag();
    expect(dag.ok && dag.data.nextReady).toBe("003-gamma");
    expect(dag.ok && dag.data.project).toBe("alpha");

    const run = await scoped.run();
    expect(run.ok && run.data.run?.id).toBe(seeded.runId);

    const decisions = await scoped.decisions({ specId: "002-beta" });
    expect(decisions.ok && decisions.data.total).toBe(0);

    const history = await scoped.history();
    expect(history.ok && history.data.entries.length).toBe(2);

    const evidence = await scoped.evidence(seeded.evidenceHash);
    expect(evidence.ok && evidence.data.hash).toBe(seeded.evidenceHash);
    expect(scoped.evidenceUrl(seeded.evidenceHash)).toBe(
      `${server.url}/api/projects/alpha/evidence/${seeded.evidenceHash}?raw=1`
    );
    expect(client.eventsUrl()).toBe(`${server.url}${API_ROUTES.events}`);
    expect(client.eventsUrl("alpha")).toBe(`${server.url}${API_ROUTES.events}?${EVENTS_PROJECT_PARAM}=alpha`);

    // A control through the client journals the client's own source.
    const paused = await scoped.pauseRun();
    expect(paused.ok && paused.data.record?.payload).toMatchObject({ source: "cli:test" });

    // And the registry controls, through the same client.
    const disarmed = await client.disarmProject("alpha");
    expect(disarmed.ok && disarmed.data.record?.kind).toBe("project.disarmed");
  });
});

test("the client reports an unreachable daemon in the envelope, never as a throw", async () => {
  // Port 1 is never a listening orchestrator; the point is that a transport
  // failure arrives as {ok: false, kind: "unreachable"} so spec 023 can map
  // it to its own exit code without a try/catch.
  const client = createApiClient({ baseUrl: "http://127.0.0.1:1" });
  const response = await client.project("alpha").run();
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.kind).toBe("unreachable");
});

test("the client reports a body that dies mid-read as unreachable, never as a throw", async () => {
  // The headers arrived and then the connection dropped, so the failure
  // surfaces at the body read rather than at connect. It is the same
  // transport class as a daemon that was never there, and must arrive in the
  // envelope for the same reason.
  const client = createApiClient({
    baseUrl: "http://127.0.0.1:4519",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("the socket connection was closed unexpectedly"));
          },
        }),
        { status: 200 }
      ),
  });
  const response = await client.project("alpha").run();
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.kind).toBe("unreachable");
});

test("the client reports a non-envelope response as malformed rather than guessing", async () => {
  const client = createApiClient({
    baseUrl: "http://127.0.0.1:4519",
    fetch: async () => new Response("<html>not this api</html>", { status: 200 }),
  });
  const response = await client.project("alpha").dag();
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.kind).toBe("malformed-response");
});
