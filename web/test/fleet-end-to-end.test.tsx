// Spec 029's acceptance criteria, end to end (AC-1, AC-2).
//
// end-to-end.test.tsx proves the five scoped views against a daemon holding one
// project. This file is the fleet's half: a real Bun.serve daemon over a real
// registry chain holding two projects, one armed with a finished backlog and
// one disarmed with ready work, which is the exact pair AC-1 names. That pair is
// the whole point of the standby view, because it is where the two things an
// operator must never confuse live next to each other: nothing to do, and
// something to do that nobody is doing.
//
// Everything asserted here travelled the wire: the registry rows come off
// `GET /api/projects`, each backlog off that project's own scoped DAG route, and
// the arm control appends to the real projects chain. AC-2 is the same run,
// killed underneath the fleet view.
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
  seedAdoption,
  type FixtureRegistry,
  type FixtureSpec,
} from "../../src/orchestrator/api/fixtures";

// Captured before happy-dom is registered, for the reason end-to-end.test.tsx
// documents: a real client and a real Bun.serve need Bun's HTTP globals on both
// ends, while the component under test needs happy-dom's DOM.
const NATIVE_FETCH = globalThis.fetch;
const NATIVE_RESPONSE = globalThis.Response;
const NATIVE_REQUEST = globalThis.Request;
const NATIVE_HEADERS = globalThis.Headers;

useDom();

// The armed project's corpus: every spec is complete, so its backlog is
// finished. Adoption is journaled below, which is what makes "shipped" a
// journal-derived fact here rather than a registry claim.
const FINISHED: Record<string, FixtureSpec> = {
  "001-alpha": { implementation: "complete" },
  "002-beta": { implementation: "complete", dependsOn: ["001-alpha"] },
};

// The disarmed project's: one pending spec whose only dependency is shipped, so
// the scheduler would have something to take if it were allowed to.
const WAITING: Record<string, FixtureSpec> = {
  "001-alpha": { implementation: "complete" },
  "002-beta": { implementation: "pending", dependsOn: ["001-alpha"] },
};

let registry: FixtureRegistry;
let server: ApiServer;
let client: ApiClient;
let stopped = false;

beforeAll(() => {
  globalThis.fetch = NATIVE_FETCH;
  globalThis.Response = NATIVE_RESPONSE;
  globalThis.Request = NATIVE_REQUEST;
  globalThis.Headers = NATIVE_HEADERS;

  registry = freshRegistry("web-fleet");

  const done = registry.add("alpha", { armed: true, specs: FINISHED });
  seedAdoption(done, ["001-alpha", "002-beta"]);

  const waiting = registry.add("beta", { armed: false, specs: WAITING });
  seedAdoption(waiting, ["001-alpha"]);

  // No project holds the flight slot: a daemon that is up, correct, and taking
  // nothing is precisely the state 026 made possible and 029 has to render.
  server = createApiServer(
    fixtureApiDeps(registry, { daemon: fixtureDaemon({ state: "scheduling", activeProject: null }), staticDir: null })
  );

  client = createApiClient({ baseUrl: server.url, fetch: NATIVE_FETCH, source: "web-ui" });
});

afterAll(async () => {
  if (!stopped) await server.stop();
  registry.close();
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`fleet-end-to-end: timed out waiting for ${what}`);
}

async function open(view: string): Promise<Mounted> {
  window.location.hash = `#/${view}`;
  return mount(<App client={client} eventsUrl={`${server.url}/api/events`} openStream={null} />);
}

// The shell routes on the hash; the event is dispatched here rather than left
// to the DOM implementation, so what this file proves is the view switching
// and not happy-dom's navigation fidelity.
async function go(view: string): Promise<void> {
  await act(async () => {
    window.location.hash = `#/${view}`;
    window.dispatchEvent(new Event("hashchange"));
  });
}

// Both rows plus both backlog folds have landed. The backlogs are read on
// demand (029 D-1), so they arrive after the registry that names them.
async function fleetLoaded(view: Mounted): Promise<void> {
  await waitFor(() => view.query("project-beta") !== null, "the registry to load");
  await waitFor(() => !view.text("backlog-beta").includes("not folded"), "every backlog to be folded");
}

// --- AC-1 -------------------------------------------------------------------

test("the switcher lists both registered projects as the registry chain holds them", async () => {
  const view = await open("standby");
  try {
    await fleetLoaded(view);

    const alpha = view.text("project-alpha");
    expect(alpha).toContain("alpha");
    expect(alpha).toContain("armed");
    expect(alpha).toContain("qualified");

    const beta = view.text("project-beta");
    expect(beta).toContain("beta");
    expect(beta).toContain("disarmed");

    // Neither project has ever been driven, and that is said rather than drawn
    // as an idle run (022 B-6).
    expect(view.text("project-run-alpha")).toContain("no run has ever been created");
    expect(view.text("project-run-beta")).toContain("no run has ever been created");
  } finally {
    view.unmount();
  }
});

test("standby tells a finished backlog apart from ready work nobody is taking", async () => {
  const view = await open("standby");
  try {
    await fleetLoaded(view);

    // The armed project: done, and stated as done. This is the state 010 A-1 is
    // about, and an empty-looking panel here would be the bug.
    const alpha = view.text("backlog-alpha");
    expect(alpha).toContain("backlog complete: no spec is pending");
    expect(alpha).toContain("armed, with nothing pending");
    expect(alpha).toContain("standby");

    // The disarmed one: the work exists, and the reason it is not being taken
    // is the registry's armed flag, not the backlog.
    const beta = view.text("backlog-beta");
    expect(beta).toContain("1 spec pending, 002-beta ready");
    expect(beta).toContain("disarmed");
    expect(beta).toContain("never driven");
  } finally {
    view.unmount();
  }
});

test("the daemon's state and the flight slot are rendered once, globally", async () => {
  const view = await open("standby");
  try {
    await waitFor(() => flat(view.find("global-banner").textContent ?? "").includes("standby"), "the meta fold");

    // B-4: the two account-wide facts, above everything scoped, and labelled as
    // belonging to the account rather than to the project on screen.
    const banner = view.text("global-banner");
    expect(banner).toContain("standby");
    expect(banner).toContain("flight slot free");
    expect(banner).toContain("account-wide, not this project's");
  } finally {
    view.unmount();
  }
});

test("the scoped views follow the switcher to the project it names", async () => {
  const view = await open("standby");
  try {
    await fleetLoaded(view);

    // With no project driving, the shell resolves to the registry's first row.
    await go("dag");
    await waitFor(() => view.query("dag-next-ready") !== null, "alpha's dag");
    expect(view.text("dag-next-ready")).toBe("unknown");
    expect(view.query("dag-node-002-beta")).not.toBeNull();

    // Switching projects re-reads the scoped routes: the same panel now shows
    // the other project's fold, with its own next pick.
    await go("standby");
    await view.click("select-beta");
    await go("dag");
    await waitFor(() => view.text("dag-next-ready") === "002-beta", "beta's dag");
    expect(view.text("dag-ready-002-beta")).toContain("ready");
    expect(view.text("project-picker")).toContain("beta");
  } finally {
    view.unmount();
  }
});

test("arming a project from the fleet view appends to the registry chain and the row refolds", async () => {
  const view = await open("standby");
  try {
    await fleetLoaded(view);

    await view.click("registry-arm-beta");

    // 024 B-6 over the registry chain (B-3): the record first, and nothing sent
    // until it is accepted.
    const preview = view.text("registry-arm-beta-preview");
    expect(preview).toContain('"kind": "project.armed"');
    expect(preview).toContain('"name": "beta"');
    expect(preview).toContain('"source": "ui"');
    expect(registry.projects().get("beta")?.armed).toBe(false);

    await view.click("registry-arm-beta-confirm");
    await waitFor(() => view.query("registry-arm-beta-answer") !== null, "the daemon's answer");

    // What is shown afterwards is the record the chain carries, which is also
    // what the chain itself now holds.
    const answer = view.text("registry-arm-beta-answer");
    expect(answer).toContain("Journaled at seq");
    expect(answer).toContain('"kind": "project.armed"');
    expect(answer).toContain('"source": "ui"');
    expect(view.text("registry-arm-beta-snapshot")).toContain("armed");
    expect(registry.projects().get("beta")?.armed).toBe(true);

    // No optimistic UI (024 B-7): the row reads as armed because the registry
    // was refolded after the call, and the same backlog now reads as work the
    // scheduler will take.
    await view.click("registry-arm-beta-dismiss");
    await waitFor(() => view.text("backlog-beta").includes("armed and qualified"), "beta's row to refold");
    expect(view.text("backlog-beta")).toContain("when the flight slot frees");
  } finally {
    view.unmount();
  }
});

// --- AC-2 -------------------------------------------------------------------

test("killing the daemon under the fleet view says so rather than leaving two live-looking projects", async () => {
  const view = await open("standby");
  try {
    await fleetLoaded(view);
    expect(view.query("connection-banner")).toBeNull();

    await server.stop();
    stopped = true;

    await view.click("refresh");
    await waitFor(() => view.query("connection-banner") !== null, "the unreachable banner");

    const banner = view.text("connection-banner");
    expect(banner).toContain("daemon unreachable");
    expect(banner).toContain(server.url);
    expect(banner).toContain("is not live");

    // The last fold stays on screen, because it is the last thing known to be
    // true, and it is marked stale rather than passed off as current.
    expect(view.container.querySelector(".panel-stale")).not.toBeNull();
    expect(view.text("project-alpha")).toContain("alpha");
  } finally {
    view.unmount();
  }
});
