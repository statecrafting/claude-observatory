import { test, expect } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { sha256Hex } from "../journal";
import { foldOrchestratorState, transition } from "../state";
import type { Daemon } from "../daemon";
import { createApiClient } from "./api-client";
import { EventHub } from "./events";
import { fixtureControls, freshWorld, seedPark, seedRun, type FixtureWorld } from "./fixtures";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  assertLoopbackHost,
  createApiServer,
  journalViewFromHandle,
  type ApiDeps,
  type ApiServer,
  type ControlTarget,
} from "./server";
import {
  API_ROUTES,
  API_VERSION,
  API_VERSION_HEADER,
  CONTROL_SOURCE_HEADER,
  SPEC_CONTROL_VERBS,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type DagView,
  type DecisionsView,
  type EvidenceView,
  type HistoryView,
  type QuotaView,
  type RunView,
  type SpecControlVerb,
} from "./types";

// --- the control seam is the real daemon's own surface (B-5) ----------------
//
// Compile-time proof that spec 021's Daemon satisfies ControlTarget with no
// adapter: if a control method's signature ever diverges, this stops being
// assignable and typecheck fails rather than a runtime wiring bug appearing
// the first time someone POSTs a control.
type DaemonSatisfiesControlTarget = Daemon extends ControlTarget ? true : false;
const _daemonIsAControlTarget: DaemonSatisfiesControlTarget = true;
expect(_daemonIsAControlTarget).toBe(true);

// --- harness ----------------------------------------------------------------

function serverFor(world: FixtureWorld, overrides: Partial<ApiDeps> = {}): ApiServer {
  const deps: ApiDeps = {
    journal: journalViewFromHandle(world.journal),
    decisions: journalViewFromHandle(world.decisions),
    dagReader: world.dagReader,
    repoDir: world.repoDir,
    evidenceDir: world.evidenceDir,
    controls: fixtureControls(world.journal),
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  };
  return createApiServer(deps);
}

async function withServer(
  prefix: string,
  body: (ctx: { world: FixtureWorld; server: ApiServer }) => Promise<void>,
  overrides: Partial<ApiDeps> = {}
): Promise<void> {
  const world = freshWorld(prefix);
  const server = serverFor(world, overrides);
  try {
    await body({ world, server });
  } finally {
    await server.stop();
    world.close();
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

async function curlJson(url: string): Promise<{ exitCode: number; body: string }> {
  // Bun.spawnSync would block this process's own event loop, and the server
  // under test lives in it, so curl would time out against a daemon that
  // cannot answer. The async spawn is the only correct shape here.
  const proc = Bun.spawn(
    ["curl", "--silent", "--show-error", "--fail-with-body", "--max-time", "10", "-H", `${API_VERSION_HEADER}: ${API_VERSION}`, url],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [body, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, body };
}

// --- binding (B-1) ----------------------------------------------------------

test("the server refuses a non-loopback bind and names why", () => {
  expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback only/);
  expect(() => assertLoopbackHost("192.168.1.10")).toThrow(/loopback only/);
  expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  expect(() => assertLoopbackHost("localhost")).not.toThrow();
  expect(() => assertLoopbackHost("::1")).not.toThrow();
});

test("createApiServer refuses a non-loopback host before it ever binds", () => {
  const world = freshWorld("bind");
  try {
    expect(() => serverFor(world, { host: "0.0.0.0" })).toThrow(/refusing to bind/);
  } finally {
    world.close();
  }
});

test("the documented defaults are the ones the daemon binds", () => {
  expect(DEFAULT_API_HOST).toBe("127.0.0.1");
  expect(DEFAULT_API_PORT).toBe(4519);
});

// --- envelope and gating (B-2) ----------------------------------------------

test("/api/meta serves the version, the loopback stance, and the route list", async () => {
  await withServer("meta", async ({ server }) => {
    const { status, body } = await getJson<ApiMeta>(server, API_ROUTES.meta);
    expect(status).toBe(200);
    const meta = expectOk(body);
    expect(meta).toMatchObject({
      apiVersion: API_VERSION,
      service: "claude-observatory-orchestrator",
      loopbackOnly: true,
      controlsAvailable: true,
    });
    expect(meta.routes).toContain(API_ROUTES.dag);
    expect(meta.routes).toContain("/api/spec/<id>/approve");
  });
});

test("an unknown route and a wrong method both answer in the envelope", async () => {
  await withServer("routing", async ({ server }) => {
    const missing = await getJson<never>(server, "/api/nope");
    expect(missing.status).toBe(404);
    expect(expectErr(missing.body).kind).toBe("not-found");

    const wrongMethod = await getJson<never>(server, API_ROUTES.dag, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(expectErr(wrongMethod.body).kind).toBe("method-not-allowed");

    const wrongMethodControl = await getJson<never>(server, API_ROUTES.runPause);
    expect(wrongMethodControl.status).toBe(405);
    expect(expectErr(wrongMethodControl.body).kind).toBe("method-not-allowed");
  });
});

test("a declared apiVersion that does not match is refused with a stable token", async () => {
  await withServer("version", async ({ server }) => {
    const mismatched = await getJson<ApiMeta>(server, API_ROUTES.meta, { headers: { [API_VERSION_HEADER]: "99" } });
    expect(mismatched.status).toBe(400);
    expect(expectErr(mismatched.body).kind).toBe("api-version-mismatch");

    // No declared version is served on the v1 assumption, so plain curl works.
    const undeclared = await getJson<ApiMeta>(server, API_ROUTES.meta);
    expect(undeclared.body.ok).toBe(true);
  });
});

test("the authorize seam can refuse every route without any shape changing", async () => {
  await withServer(
    "authorize",
    async ({ server }) => {
      const { status, body } = await getJson<RunView>(server, API_ROUTES.run);
      expect(status).toBe(503);
      expect(expectErr(body)).toEqual({ kind: "unavailable", message: "no token" });
    },
    { authorize: () => ({ kind: "unavailable", message: "no token" }) }
  );
});

test("an internal failure still leaves through the one envelope", async () => {
  await withServer(
    "internal",
    async ({ server }) => {
      const { status, body } = await getJson<DagView>(server, API_ROUTES.dag);
      expect(status).toBe(500);
      expect(expectErr(body).kind).toBe("internal");
      expect(expectErr(body).message).toContain("registry is unavailable");
    },
    {
      dagReader: {
        registryListJson: () => {
          throw new Error("registry is unavailable");
        },
        registryShowJson: () => "",
        readSpecFile: () => Buffer.alloc(0),
      },
    }
  );
});

// --- reads (B-3, B-6) -------------------------------------------------------

test("every read route serves journal-derived state in the documented envelope", async () => {
  await withServer("reads", async ({ world, server }) => {
    const seeded = seedRun(world);

    const dag = expectOk((await getJson<DagView>(server, API_ROUTES.dag)).body);
    expect(dag.specs.map((s) => s.id)).toEqual(["001-alpha", "002-beta", "003-gamma"]);
    expect(dag.nextReady).toBe("003-gamma");

    const run = expectOk((await getJson<RunView>(server, API_ROUTES.run)).body);
    expect(run.run?.id).toBe(seeded.runId);
    expect(run.spec?.specId).toBe("003-gamma");
    expect(run.stage?.stage).toBe("build");

    const quota = expectOk((await getJson<QuotaView>(server, API_ROUTES.quota)).body);
    expect(quota.parked).toBe(false);
    expect(quota.targetMs).toBeNull();

    const history = expectOk((await getJson<HistoryView>(server, API_ROUTES.history)).body);
    expect(history.entries.map((e) => e.specId)).toEqual(["002-beta", "003-gamma"]);
    expect(history.entries[0]!.evidenceRefs).toEqual([seeded.evidenceHash]);

    const decisions = expectOk((await getJson<DecisionsView>(server, API_ROUTES.decisions)).body);
    expect(decisions.total).toBe(0);
  });
});

test("/api/quota reports the countdown against an injected clock", async () => {
  const world = freshWorld("quota-route");
  const target = 1_700_000_600_000;
  const server = serverFor(world, { clock: { now: () => 1_700_000_000_000 } });
  try {
    seedPark(world, target, 1, true);
    const quota = expectOk((await getJson<QuotaView>(server, API_ROUTES.quota)).body);
    expect(quota).toMatchObject({
      parked: true,
      targetMs: target,
      estimated: true,
      msUntilTarget: 600_000,
      consecutiveQuotaParks: 1,
      warn: false,
      nowMs: 1_700_000_000_000,
    });
  } finally {
    await server.stop();
    world.close();
  }
});

test("/api/decisions passes the query through to the ledger", async () => {
  await withServer("decisions-route", async ({ world, server }) => {
    world.decisions.append("decision.sealed", {
      id: "d-1",
      specId: "002-beta",
      scope: ["002-beta"],
      title: "Ring capacity",
      decision: "Keep 256 events",
      rationale: "Matches the documented replay window",
    });

    const all = expectOk((await getJson<DecisionsView>(server, API_ROUTES.decisions)).body);
    expect(all.total).toBe(1);

    const matched = expectOk((await getJson<DecisionsView>(server, `${API_ROUTES.decisions}?query=replay`)).body);
    expect(matched.decisions.map((d) => d.id)).toEqual(["d-1"]);
    expect(matched.query).toEqual({ query: "replay" });

    const missed = expectOk((await getJson<DecisionsView>(server, `${API_ROUTES.decisions}?specId=999-nope`)).body);
    expect(missed.total).toBe(0);
  });
});

// --- evidence (B-3) ---------------------------------------------------------

test("/api/evidence serves a content-addressed file in the envelope and raw on request", async () => {
  await withServer("evidence-route", async ({ world, server }) => {
    const seeded = seedRun(world);

    const { status, body } = await getJson<EvidenceView>(server, `${API_ROUTES.evidencePrefix}${seeded.evidenceHash}`);
    expect(status).toBe(200);
    const evidence = expectOk(body);
    expect(evidence).toMatchObject({ hash: seeded.evidenceHash, mediaType: "text/plain", base64: null });
    expect(evidence.text).toContain("bun test");
    expect(evidence.bytes).toBe(evidence.text!.length);

    const raw = await fetch(`${server.url}${API_ROUTES.evidencePrefix}${seeded.evidenceHash}?raw=1`);
    expect(raw.headers.get("content-type")).toBe("text/plain");
    expect(await raw.text()).toContain("bun test");
  });
});

test("/api/evidence serves a png as base64 and refuses anything that is not a content hash", async () => {
  await withServer("evidence-png", async ({ world, server }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = sha256Hex(png.toString("binary"));
    // The stored name is whatever the verify stage hashed to; this test only
    // needs a valid 64-hex name that exists on disk.
    const named = "a".repeat(64);
    fs.writeFileSync(join(world.evidenceDir, `${named}.png`), png);
    expect(hash.length).toBe(64);

    const evidence = expectOk((await getJson<EvidenceView>(server, `${API_ROUTES.evidencePrefix}${named}`)).body);
    expect(evidence).toMatchObject({ mediaType: "image/png", text: null, bytes: png.length });
    expect(Buffer.from(evidence.base64!, "base64").equals(png)).toBe(true);

    const traversal = await getJson<EvidenceView>(server, `${API_ROUTES.evidencePrefix}${encodeURIComponent("../../etc/passwd")}`);
    expect(traversal.status).toBe(400);
    expect(expectErr(traversal.body).kind).toBe("bad-request");

    const missing = await getJson<EvidenceView>(server, `${API_ROUTES.evidencePrefix}${"b".repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(expectErr(missing.body).kind).toBe("not-found");
  });
});

// --- controls (B-5) ---------------------------------------------------------

test("a control returns the control record the daemon journaled, with its source", async () => {
  await withServer("control-pause", async ({ world, server }) => {
    seedRun(world);
    const before = world.journal.fold().records.length;

    const { status, body } = await getJson<ControlResult>(server, API_ROUTES.runPause, {
      method: "POST",
      headers: { [CONTROL_SOURCE_HEADER]: "cli:operator" },
    });
    expect(status).toBe(200);
    const result = expectOk(body);
    expect(result.verb).toBe("pause");
    expect(result.applied).toBe(true);
    expect(result.record?.kind).toBe("control.pause");
    expect(result.record?.payload).toMatchObject({ source: "cli:operator" });
    expect(result.runStatus).toBe("running");
    expect(world.journal.fold().records.length).toBe(before + 1);
  });
});

test("a control source can also arrive in the JSON body, defaulting when absent", async () => {
  await withServer("control-source", async ({ world, server }) => {
    seedRun(world);

    const fromBody = expectOk(
      (
        await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}003-gamma/skip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "web-ui" }),
        })
      ).body
    );
    expect(fromBody.record?.payload).toMatchObject({ specId: "003-gamma", source: "web-ui" });

    const defaulted = expectOk((await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}003-gamma/approve`, { method: "POST" })).body);
    expect(defaulted.record?.payload).toMatchObject({ source: "api" });
  });
});

test("every spec control verb reaches its own daemon method", async () => {
  await withServer("control-verbs", async ({ world, server }) => {
    seedRun(world);
    const cases: readonly [SpecControlVerb, string][] = [
      ["skip", "control.skipSpec"],
      ["retry-stage", "control.retryStage"],
      ["reverify", "control.reverify"],
      ["force-human-gate", "control.forceHumanGate"],
      ["approve", "control.approve"],
    ];
    // Every verb the route table declares is covered here, so a new one
    // cannot be added without this list failing to typecheck as exhaustive.
    expect(cases.map(([verb]) => verb)).toEqual([...SPEC_CONTROL_VERBS]);
    for (const [verb, kind] of cases) {
      const result = expectOk((await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}003-gamma/${verb}`, { method: "POST" })).body);
      expect(result.verb).toBe(verb);
      expect(result.specId).toBe("003-gamma");
      expect(result.record?.kind).toBe(kind);
    }
  });
});

test("pause and resume are idempotent, journaling nothing when already satisfied", async () => {
  await withServer("control-idempotent", async ({ world, server }) => {
    seedRun(world);
    const state = foldOrchestratorState(world.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    transition(world.journal, run, "paused");
    const before = world.journal.fold().records.length;

    const pauseAgain = expectOk((await getJson<ControlResult>(server, API_ROUTES.runPause, { method: "POST" })).body);
    expect(pauseAgain.applied).toBe(false);
    expect(pauseAgain.record).toBeNull();
    expect(pauseAgain.runStatus).toBe("paused");
    expect(world.journal.fold().records.length).toBe(before);

    const resume = expectOk((await getJson<ControlResult>(server, API_ROUTES.runResume, { method: "POST" })).body);
    expect(resume.applied).toBe(true);
    expect(resume.record?.kind).toBe("control.resume");
  });
});

test("start resumes a paused run, no-ops a running one, and refuses the rest", async () => {
  await withServer("control-start", async ({ world, server }) => {
    const noRun = await getJson<ControlResult>(server, API_ROUTES.runStart, { method: "POST" });
    expect(noRun.status).toBe(409);
    expect(expectErr(noRun.body).message).toContain("no run exists yet");

    seedRun(world);
    const running = expectOk((await getJson<ControlResult>(server, API_ROUTES.runStart, { method: "POST" })).body);
    expect(running.applied).toBe(false);
    expect(running.runStatus).toBe("running");

    const state = foldOrchestratorState(world.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    const paused = transition(world.journal, run, "paused");
    const started = expectOk((await getJson<ControlResult>(server, API_ROUTES.runStart, { method: "POST" })).body);
    expect(started.verb).toBe("start");
    expect(started.applied).toBe(true);
    expect(started.record?.kind).toBe("control.resume");

    transition(world.journal, transition(world.journal, paused, "running"), "completed");
    const terminal = await getJson<ControlResult>(server, API_ROUTES.runStart, { method: "POST" });
    expect(terminal.status).toBe(409);
    expect(expectErr(terminal.body).message).toContain('"completed" cannot be started');
  });
});

test("a control the daemon refuses is reported as a conflict, not a crash", async () => {
  await withServer("control-conflict", async ({ world, server }) => {
    seedRun(world);
    const state = foldOrchestratorState(world.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    transition(world.journal, run, "completed");

    const { status, body } = await getJson<ControlResult>(server, API_ROUTES.runResume, { method: "POST" });
    expect(status).toBe(409);
    expect(expectErr(body).kind).toBe("conflict");
    expect(expectErr(body).message).toContain('requires the run to be "paused"');
  });
});

test("a read-only server answers controls as unavailable rather than pretending", async () => {
  await withServer(
    "control-unavailable",
    async ({ world, server }) => {
      seedRun(world);
      const { status, body } = await getJson<ControlResult>(server, API_ROUTES.runPause, { method: "POST" });
      expect(status).toBe(503);
      expect(expectErr(body).kind).toBe("unavailable");
      expect(expectOk((await getJson<ApiMeta>(server, API_ROUTES.meta)).body).controlsAvailable).toBe(false);
    },
    { controls: null }
  );
});

test("a malformed spec control path or verb is refused before any control runs", async () => {
  await withServer("control-bad-path", async ({ world, server }) => {
    seedRun(world);
    const before = world.journal.fold().records.length;

    const badVerb = await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}003-gamma/detonate`, { method: "POST" });
    expect(badVerb.status).toBe(404);
    expect(expectErr(badVerb.body).message).toContain("unknown spec control verb");

    const badShape = await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}003-gamma`, { method: "POST" });
    expect(badShape.status).toBe(400);

    const badId = await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}${encodeURIComponent("../etc")}/skip`, { method: "POST" });
    expect(badId.status).toBe(400);
    expect(expectErr(badId.body).kind).toBe("bad-request");

    // A malformed percent-escape is the caller's request being wrong, not
    // this server's internals failing: it belongs in the same bad-request
    // class as every other unusable spec id, never in the 500 an uncaught
    // decodeURIComponent throw would produce.
    const badEscape = await getJson<ControlResult>(server, `${API_ROUTES.specPrefix}%ZZ/skip`, { method: "POST" });
    expect(badEscape.status).toBe(400);
    expect(expectErr(badEscape.body).kind).toBe("bad-request");

    expect(world.journal.fold().records.length).toBe(before);
  });
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

test("/api/events streams journal appends as classified events", async () => {
  await withServer(
    "sse-live",
    async ({ world, server }) => {
      const streamed = readSseFor(`${server.url}${API_ROUTES.events}`, 400);
      // Let the subscription establish before appending, then let the pump
      // notice on its own timer.
      await Bun.sleep(60);
      world.journal.append("control.pause", { runId: "r", source: "api" });
      const text = await streamed;

      expect(text).toContain("event: control");
      const dataLine = text.split("\n").find((l) => l.startsWith("data: ") && l.includes("control.pause"))!;
      expect(JSON.parse(dataLine.slice("data: ".length))).toMatchObject({
        kind: "control.pause",
        data: { source: "api" },
      });
    },
    { heartbeatMs: 10_000, pumpIntervalMs: 20 }
  );
});

test("/api/events replays from Last-Event-ID and reports an unrecoverable gap", async () => {
  await withServer(
    "sse-replay",
    async ({ world, server }) => {
      for (let i = 0; i < 4; i++) {
        world.journal.append("daemon.heartbeat", { runId: "r", runStatus: "running", ts: i });
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
  const world = freshWorld("sse-stop");
  const server = serverFor(world, { heartbeatMs: 20, pumpIntervalMs: 20 });
  try {
    const response = await fetch(`${server.url}${API_ROUTES.events}`);
    const reader = response.body!.getReader();
    await reader.read(); // the retry directive
    expect(server.hub.listenerCount).toBe(1);

    await server.stop();
    expect(server.hub.listenerCount).toBe(0);
    await reader.cancel().catch(() => {});
  } finally {
    world.close();
  }
});

test("the hub is the server's own, so a caller can publish alongside the pump", async () => {
  await withServer("sse-hub", async ({ server }) => {
    expect(server.hub).toBeInstanceOf(EventHub);
  });
});

// --- AC-2: curl every read endpoint, then round-trip through the client -----

test("AC-2: curl of every read endpoint returns the documented envelope", async () => {
  await withServer("ac2-curl", async ({ world, server }) => {
    const seeded = seedRun(world);
    world.decisions.append("decision.sealed", {
      id: "d-1",
      specId: "002-beta",
      scope: ["002-beta"],
      title: "Curl is a client",
      decision: "No declared version header is served on the v1 assumption",
      rationale: "The API must be usable from a terminal with no wrapper",
    });

    const paths = [
      API_ROUTES.meta,
      API_ROUTES.dag,
      API_ROUTES.run,
      API_ROUTES.quota,
      `${API_ROUTES.decisions}?query=curl`,
      API_ROUTES.history,
      `${API_ROUTES.evidencePrefix}${seeded.evidenceHash}`,
    ];

    for (const path of paths) {
      const { exitCode, body } = await curlJson(`${server.url}${path}`);
      expect({ path, exitCode }).toEqual({ path, exitCode: 0 });
      const parsed = JSON.parse(body) as ApiResponse<unknown>;
      expect({ path, ok: parsed.ok }).toEqual({ path, ok: true });
      expect({ path, hasData: "data" in parsed }).toEqual({ path, hasData: true });
    }

    // The same envelope on the failure side, by curl, with a stable token.
    const missing = await curlJson(`${server.url}/api/nope`);
    expect(missing.exitCode).toBe(22);
    expect(JSON.parse(missing.body)).toEqual({ ok: false, error: { kind: "not-found", message: "no route for GET /api/nope" } });
  });
});

test("AC-2: every read shape round-trips through the generated client", async () => {
  await withServer("ac2-client", async ({ world, server }) => {
    const seeded = seedRun(world);
    const client = createApiClient({ baseUrl: server.url, source: "cli:test" });

    const meta = await client.meta();
    expect(meta.ok && meta.data.apiVersion).toBe(API_VERSION);

    const dag = await client.dag();
    expect(dag.ok && dag.data.nextReady).toBe("003-gamma");

    const run = await client.run();
    expect(run.ok && run.data.run?.id).toBe(seeded.runId);

    const quota = await client.quota();
    expect(quota.ok && quota.data.parked).toBe(false);

    const decisions = await client.decisions({ specId: "002-beta" });
    expect(decisions.ok && decisions.data.total).toBe(0);

    const history = await client.history();
    expect(history.ok && history.data.entries.length).toBe(2);

    const evidence = await client.evidence(seeded.evidenceHash);
    expect(evidence.ok && evidence.data.hash).toBe(seeded.evidenceHash);
    expect(client.evidenceUrl(seeded.evidenceHash).endsWith("?raw=1")).toBe(true);
    expect(client.eventsUrl).toBe(`${server.url}${API_ROUTES.events}`);

    // A control through the client journals the client's own source.
    const paused = await client.pauseRun();
    expect(paused.ok && paused.data.record?.payload).toMatchObject({ source: "cli:test" });
  });
});

test("the client reports an unreachable daemon in the envelope, never as a throw", async () => {
  // Port 1 is never a listening orchestrator; the point is that a transport
  // failure arrives as {ok: false, kind: "unreachable"} so spec 023 can map
  // it to its own exit code without a try/catch.
  const client = createApiClient({ baseUrl: "http://127.0.0.1:1" });
  const response = await client.run();
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
  const response = await client.run();
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.kind).toBe("unreachable");
});

test("the client reports a non-envelope response as malformed rather than guessing", async () => {
  const client = createApiClient({
    baseUrl: "http://127.0.0.1:4519",
    fetch: async () => new Response("<html>not this api</html>", { status: 200 }),
  });
  const response = await client.dag();
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.kind).toBe("malformed-response");
});
