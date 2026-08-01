// The store's own scoping rules (spec 027 B-3), at the seam the panel tests
// cannot reach.
//
// `resolveProject` is pure and tested directly. The overlapping-refresh test
// below needs the hook itself, because the fact under test is about two
// refreshes in flight at once, which no pure function can express: the store
// keeps the selected project in a ref, and a refresh that started before the
// operator picked a project must not write the project it started with back
// over the one they chose. That ref is what every later refresh reads its
// scope from, so a lost write there is not one stale render, it is the wrong
// project's DAG from then on.
import { expect, test } from "bun:test";
import { act } from "react";
import { useDom, mount } from "./harness";
import type { ReactNode } from "react";
import { resolveProject, useObservatory } from "../src/store";
import type { ObservatoryActions, ObservatoryState } from "../src/store";
import type {
  ApiClient,
  ApiMeta,
  ApiResponse,
  DagView,
  HistoryView,
  ProjectsView,
  ProjectView,
  QuotaView,
  RunView,
} from "../src/api";
import { FIXTURE_QUOTA } from "./fixtures";

useDom();

const ALPHA = "alpha";
const BETA = "beta";

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function projectRow(name: string): ProjectView {
  return {
    name,
    repoDir: `/repo/${name}`,
    armed: true,
    qualification: { qualified: true, checks: [], warnings: [], checkedAt: "2026-08-01T00:00:00.000Z" },
    run: null,
    spec: null,
    stage: null,
    readError: null,
  };
}

const PROJECTS: ProjectsView = { projects: [projectRow(ALPHA), projectRow(BETA)] };

function meta(activeProject: string | null): ApiMeta {
  return {
    apiVersion: 2,
    service: "claude-observatory-orchestrator",
    loopbackOnly: true,
    controlsAvailable: true,
    daemon: { state: "driving", activeProject, scanIntervalMs: 60_000, lastScanMs: null },
    projectCount: PROJECTS.projects.length,
    routes: ["/api/meta"],
  };
}

// --- resolveProject ---------------------------------------------------------

test("resolveProject keeps a selection the registry still carries", () => {
  expect(resolveProject(ok(PROJECTS), ok(meta(ALPHA)), BETA)).toBe(BETA);
});

test("resolveProject falls back to the daemon's active project, then to the first row", () => {
  expect(resolveProject(ok(PROJECTS), ok(meta(BETA)), null)).toBe(BETA);
  expect(resolveProject(ok(PROJECTS), ok(meta(null)), "gone")).toBe(ALPHA);
});

test("a registry read that failed changes nothing about which project is right", () => {
  const failed: ApiResponse<ProjectsView> = { ok: false, error: { kind: "unreachable", message: "down" } };
  expect(resolveProject(failed, ok(meta(ALPHA)), BETA)).toBe(BETA);
  expect(resolveProject(ok({ projects: [] }), ok(meta(null)), null)).toBe(null);
});

// --- overlapping refreshes --------------------------------------------------

// A client whose scoped reads only answer when the test says so, one gate per
// project, so two refreshes can be held in flight and completed out of order.
function gatedClient(): { client: ApiClient; release(name: string): void } {
  const gates = new Map<string, Array<() => void>>();
  const gate = (name: string): Promise<void> =>
    new Promise((resolve) => {
      const waiting = gates.get(name) ?? [];
      waiting.push(resolve);
      gates.set(name, waiting);
    });

  const scoped = (name: string) =>
    ({
      name,
      dag: async () => {
        await gate(name);
        return ok({ project: name, specs: [], nextReady: null, blockers: [], cycle: null, invalidated: [] } as DagView);
      },
      run: async () =>
        ok({
          project: name,
          run: null,
          spec: null,
          stage: null,
          pauseReason: null,
          blockers: [],
          lastHeartbeatMs: null,
          awaitingApproval: [],
        } as RunView),
      history: async () => ok({ project: name, entries: [] } as HistoryView),
      decisions: async () => ok({ project: name, query: {}, total: 0, decisions: [] }),
      evidence: async () => ok({ project: name, hash: "", mediaType: "text/plain" as const, bytes: 0, text: "", base64: null }),
      evidenceUrl: (hash: string) => `/api/projects/${name}/evidence/${hash}?raw=1`,
      startRun: async () => ok({ project: name, verb: "start" as const, specId: null, applied: false, record: null, runStatus: null }),
      pauseRun: async () => ok({ project: name, verb: "pause" as const, specId: null, applied: false, record: null, runStatus: null }),
      resumeRun: async () => ok({ project: name, verb: "resume" as const, specId: null, applied: false, record: null, runStatus: null }),
      skipSpec: async () => ok({ project: name, verb: "skip" as const, specId: null, applied: false, record: null, runStatus: null }),
      retryStage: async () => ok({ project: name, verb: "retry-stage" as const, specId: null, applied: false, record: null, runStatus: null }),
      reverify: async () => ok({ project: name, verb: "reverify" as const, specId: null, applied: false, record: null, runStatus: null }),
      forceHumanGate: async () =>
        ok({ project: name, verb: "force-human-gate" as const, specId: null, applied: false, record: null, runStatus: null }),
      approve: async () => ok({ project: name, verb: "approve" as const, specId: null, applied: false, record: null, runStatus: null }),
    }) as ReturnType<ApiClient["project"]>;

  const registryAnswer = async () =>
    ok({ verb: "arm" as const, project: null, applied: false, record: null, snapshot: null });

  const client: ApiClient = {
    baseUrl: "http://127.0.0.1:4519",
    eventsUrl: () => "http://127.0.0.1:4519/api/events",
    meta: async () => ok(meta(ALPHA)),
    quota: async () => ok(FIXTURE_QUOTA satisfies QuotaView),
    projects: async () => ok(PROJECTS),
    registerProject: registryAnswer,
    armProject: registryAnswer,
    disarmProject: registryAnswer,
    requalifyProject: registryAnswer,
    removeProject: registryAnswer,
    project: scoped,
  };

  return {
    client,
    release(name: string): void {
      const waiting = gates.get(name) ?? [];
      gates.set(name, []);
      for (const resolve of waiting) resolve();
    },
  };
}

test("a refresh that started before the operator picked a project cannot revert the pick", async () => {
  const { client, release } = gatedClient();

  let seen: { state: ObservatoryState; actions: ObservatoryActions } | null = null;
  function Probe(): ReactNode {
    // The liveness probe is pushed out of the way: this test is about two
    // refreshes racing, and a third one on a timer would only add noise.
    seen = useObservatory({
      client,
      eventsUrl: "http://127.0.0.1:4519/api/events",
      openStream: null,
      probeIntervalMs: 3_600_000,
    });
    return <span data-testid="project">{seen.state.project ?? "none"}</span>;
  }

  const view = await mount(<Probe />);
  try {
    const hook = (): { state: ObservatoryState; actions: ObservatoryActions } => {
      if (seen === null) throw new Error("the probe never rendered");
      return seen;
    };

    // The mount refresh resolved "alpha" from the daemon's active project and
    // is now held on that project's scoped reads, having shown nothing yet.
    expect(view.text("project")).toBe("none");

    // The operator picks the other one while that first refresh is still in
    // flight. Beta's reads answer first, so beta is what the page shows.
    await act(async () => {
      const picked = hook().actions.selectProject(BETA);
      release(BETA);
      await picked;
    });
    expect(view.text("project")).toBe(BETA);

    // Only now does the older refresh's alpha read come back. It carries the
    // project that was current when it started, and must land nowhere: not in
    // the rendered selection, and not in the ref the next refresh reads.
    await act(async () => {
      release(ALPHA);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.text("project")).toBe(BETA);
    expect(hook().state.dag.data?.project ?? null).toBe(BETA);

    // The ref, checked through the one action that reads it back.
    await act(async () => {
      const again = hook().actions.refresh();
      release(BETA);
      await again;
    });
    expect(view.text("project")).toBe(BETA);
  } finally {
    view.unmount();
  }
});
