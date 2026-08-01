// The acceptance criteria, end to end (spec 024 AC-1, AC-2).
//
// Everything else in web/test renders a panel against a fixture client, which
// proves the rendering but not the seam. This file removes the fixture: a real
// Bun.serve daemon over a real hash-linked journal, the real route-table
// client from spec 022, and the real App on top. So a number asserted here
// travelled the whole path the operator's browser travels, and a shape the
// daemon stopped serving fails here rather than in production.
//
// AC-2 is the same run, killed: the server is stopped underneath a mounted
// view and the page must say so, rather than leaving the last good fold on
// screen looking live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { mount, flat, useDom, type Mounted } from "./harness";
import { App } from "../src/App";
import { createApiClient, type ApiClient } from "../../src/orchestrator/api/api-client";
import { createApiServer, type ApiServer } from "../../src/orchestrator/api/server";
import {
  fixtureApiDeps,
  fixtureDaemon,
  freshRegistry,
  seedPark,
  seedRun,
  type FixtureRegistry,
  type FixtureWorld,
} from "../../src/orchestrator/api/fixtures";

// Captured before happy-dom is registered. dom-setup.ts documents why this
// matters: the registrator replaces `fetch`, `Response`, and `Request` with
// its own, and this file needs Bun's, on both ends at once. The DOM half of
// happy-dom is what the component under test wants; its HTTP half would sit
// between a real client and a real Bun.serve and break both.
const NATIVE_FETCH = globalThis.fetch;
const NATIVE_RESPONSE = globalThis.Response;
const NATIVE_REQUEST = globalThis.Request;
const NATIVE_HEADERS = globalThis.Headers;

useDom();

// One registered project, which is what the shell's picker resolves to on its
// own (027 B-3): the page names the project it is showing rather than serving
// "the one repo" implicitly.
const PROJECT = "alpha";

let registry: FixtureRegistry;
let world: FixtureWorld;
let server: ApiServer;
let client: ApiClient;
let betaSpecExecId: string;
let stopped = false;

// The park target is read back off the wire, so the only thing that matters
// is that it is far enough ahead to still be in the future when the countdown
// renders.
const PARK_TARGET_MS = Date.now() + 3_600_000;

// Registered after useDom()'s own beforeAll, so it runs after registration and
// puts Bun's HTTP globals back.
beforeAll(() => {
  globalThis.fetch = NATIVE_FETCH;
  globalThis.Response = NATIVE_RESPONSE;
  globalThis.Request = NATIVE_REQUEST;
  globalThis.Headers = NATIVE_HEADERS;

  registry = freshRegistry("web-e2e");
  world = registry.add(PROJECT);
  ({ betaSpecExecId } = seedRun(world));
  seedPark(world, PARK_TARGET_MS, 3, true);

  // One sealed decision, so the ledger browser has something real to match.
  world.decisions.append("decision.sealed", {
    id: "022-d1-run-start-semantics",
    specId: "022-http-api-and-events",
    scope: ["src/orchestrator/api/"],
    title: "POST /api/run/start means ensure the run is running",
    decision: "The start control never creates a process or a Run.",
    rationale: "Process lifecycle belongs to the daemon command, not to a route.",
  });

  server = createApiServer(
    fixtureApiDeps(registry, {
      daemon: fixtureDaemon({ state: "scheduling", activeProject: PROJECT }),
      staticDir: null,
    })
  );

  client = createApiClient({ baseUrl: server.url, fetch: NATIVE_FETCH, source: "web-ui" });
});

afterAll(async () => {
  if (!stopped) await server.stop();
  registry.close();
});

// The store fetches on mount, so the first paint is genuinely empty; these
// tests wait for the daemon's answer rather than asserting through it. The
// wait is on rendered output, which is the thing AC-1 is about.
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`end-to-end: timed out waiting for ${what}`);
}

async function open(view: string): Promise<Mounted> {
  window.location.hash = `#/${view}`;
  const mounted = await mount(<App client={client} eventsUrl={`${server.url}/api/events`} openStream={null} />);
  return mounted;
}

// --- AC-1 -------------------------------------------------------------------

test("the run view renders the run the journal actually holds", async () => {
  const view = await open("run");
  try {
    await waitFor(() => flat(view.container.textContent ?? "").includes("running"), "the run view to load");

    const body = flat(view.container.textContent ?? "");
    expect(body).toContain(world.repoDir);
    expect(body).toContain("running");
    // The heartbeat seedRun journals, not an invented liveness.
    expect(body).not.toContain("no daemon.heartbeat record has been journaled");
    // B-6: the controls are offered because this daemon serves them.
    expect(view.query("control-pause")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("the dag view names the scheduler's next pick from the same fold the daemon schedules on", async () => {
  const view = await open("dag");
  try {
    await waitFor(() => view.query("dag-next-ready") !== null, "the dag view to load");

    // 001-alpha is adopted and 002-beta shipped in this journal, so the only
    // spec left whose dependency is satisfied is 003-gamma.
    expect(view.text("dag-next-ready")).toBe("003-gamma");
    expect(view.text("dag-ready-003-gamma")).toContain("ready");
    expect(view.query("dag-node-001-alpha")).not.toBeNull();
    expect(view.query("dag-node-002-beta")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("the quota view counts down to the journaled target and flags the estimate", async () => {
  const view = await open("quota");
  try {
    await waitFor(() => view.query("quota-countdown") !== null, "the quota view to load");

    const body = flat(view.container.textContent ?? "");
    expect(body).toContain("parked on quota");
    // B-4: an inferred horizon is never shown as a reported one.
    expect(body).toContain("estimated");
    expect(view.text("quota-countdown").length).toBeGreaterThan(0);
    // Three consecutive parks is the warning threshold spec 015 sets.
    expect(view.query("quota-warning")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("the history view carries the evidence trail for the shipped spec", async () => {
  const view = await open("history");
  try {
    await waitFor(() => view.query(`history-${betaSpecExecId}`) !== null, "the history view to load");

    const entry = flat(view.find(`history-${betaSpecExecId}`).textContent ?? "");
    expect(entry).toContain("002-beta");
    expect(entry).toContain("shipped");
    // The PR and the verify verdict seedRun journaled (B-5).
    expect(entry).toContain("#7");
    expect(entry).toContain("passed");
  } finally {
    view.unmount();
  }
});

test("the decisions view lists the sealed ledger the daemon serves", async () => {
  const view = await open("decisions");
  try {
    // The ledger is only read on demand, so this view starts honest about
    // having run no query yet.
    await waitFor(
      () => flat(view.container.textContent ?? "").includes("No ledger query has been run yet."),
      "the decisions view to render"
    );

    // The ledger belongs to a project (027 B-3), so the form is only live once
    // the registry has resolved one; that is also what the panel's own note
    // says while it has not.
    await waitFor(
      () => flat(view.container.textContent ?? "").includes(`/api/projects/${PROJECT}/decisions`),
      "the decisions view to be scoped to a project"
    );

    await view.click("decisions-search");
    await waitFor(() => view.query("decisions-total") !== null, "the ledger query to answer");

    expect(view.text("decisions-total")).toBe("1 matching decision");
    expect(flat(view.container.textContent ?? "")).toContain("022-d1-run-start-semantics");
  } finally {
    view.unmount();
  }
});

// --- AC-2 -------------------------------------------------------------------

test("killing the daemon mid-view says so rather than leaving a live-looking dashboard", async () => {
  const view = await open("run");
  try {
    await waitFor(() => flat(view.container.textContent ?? "").includes("running"), "the run view to load");
    // Nothing is wrong yet: no banner while the daemon is answering.
    expect(view.query("connection-banner")).toBeNull();

    await server.stop();
    stopped = true;

    // A refetch is what a mid-view kill looks like from the page's side; the
    // store's own probe does the same thing on its interval.
    await view.click("refresh");
    await waitFor(() => view.query("connection-banner") !== null, "the unreachable banner");

    const banner = flat(view.find("connection-banner").textContent ?? "");
    expect(banner).toContain("daemon unreachable");
    expect(banner).toContain(server.url);
    expect(banner).toContain("is not live");

    // AC-2's second half: the last fold is still shown, because it is the last
    // thing known to be true, but it is marked stale rather than passed off as
    // current.
    expect(view.container.querySelector(".panel-stale")).not.toBeNull();
    expect(flat(view.container.textContent ?? "")).toContain(world.repoDir);
  } finally {
    view.unmount();
  }
});

// The recovery direction: an unreachable daemon that answers again refolds
// rather than leaving the banner up over fresh data.
test("a daemon that comes back is reported as reachable again", async () => {
  const revived = createApiServer(
    fixtureApiDeps(registry, { controlsAvailable: false, staticDir: null })
  );
  const revivedClient = createApiClient({ baseUrl: revived.url, fetch: NATIVE_FETCH, source: "web-ui" });

  window.location.hash = "#/run";
  const view = await mount(<App client={revivedClient} eventsUrl={`${revived.url}/api/events`} openStream={null} />);
  try {
    await waitFor(() => view.query("connection-banner") === null, "the revived daemon to answer");
    expect(flat(view.container.textContent ?? "")).toContain("running");
    // A read-only daemon (no controls wired) says so rather than offering
    // buttons that would answer `unavailable`.
    expect(flat(view.container.textContent ?? "")).toContain("this daemon serves no controls");
  } finally {
    view.unmount();
    await revived.stop();
  }
});
