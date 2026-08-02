// The fleet view, against a fixture v2 API (spec 029 FR-002): the switcher,
// the standby view's armed-versus-waiting rendering, and the registry-control
// confirmation flow.
//
// The rendering assertions are deliberately about sentences rather than
// classes. What this view owes an operator is the difference between "there is
// nothing to do" and "there is something to do and I am not doing it", and that
// difference only exists if it is written out.
import { expect, test } from "bun:test";
import { mount, flat, useDom } from "./harness";
import { StandbyPanel } from "../src/views/StandbyPanel";
import { RegistryControlButton } from "../src/components/RegistryControlButton";
import type { DagView } from "../src/api";
import type { Resource } from "../src/store";
import {
  fixtureApiClient,
  fixtureDagFor,
  fixtureProjectView,
  metaWithDaemon,
  registryAnswerFor,
  type FixtureClient,
  FIXTURE_RUN,
  FIXTURE_UNQUALIFIED,
} from "./fixtures";

useDom();

// AC-1's world in miniature: one armed project whose backlog is finished, one
// disarmed project with work waiting.
const ALPHA = fixtureProjectView("alpha", {
  run: FIXTURE_RUN.run,
  spec: FIXTURE_RUN.spec,
  stage: FIXTURE_RUN.stage,
});
const BETA = fixtureProjectView("beta", { armed: false });

function folded(entries: readonly (readonly [string, DagView])[]): ReadonlyMap<string, Resource<DagView>> {
  return new Map(entries.map(([name, dag]) => [name, { data: dag, error: null, loadedAtMs: Date.now() }]));
}

const BACKLOGS = folded([
  ["alpha", fixtureDagFor("alpha", "complete")],
  ["beta", fixtureDagFor("beta", "ready")],
]);

// The overrides keep the fixture client's own type rather than the prop's
// `ApiClient`, so a test can assert on what the panel issued (`calls`) without
// widening away the recorder the fixture exists to provide.
type PanelOverrides = Partial<Omit<Parameters<typeof StandbyPanel>[0], "client">> & { client?: FixtureClient };

function panel(overrides: PanelOverrides = {}) {
  const client = overrides.client ?? fixtureApiClient();
  return {
    client,
    node: (
      <StandbyPanel
        meta={metaWithDaemon("standby", null)}
        projects={{ projects: [ALPHA, BETA] }}
        projectsError={null}
        backlogs={BACKLOGS}
        selected="alpha"
        onSelect={() => undefined}
        onApplied={() => undefined}
        onRefoldBacklogs={() => undefined}
        nowMs={Date.now()}
        {...overrides}
        client={client}
      />
    ),
  };
}

// --- the switcher (B-1) -----------------------------------------------------

test("the switcher lists every registered project with its armed state and current run", async () => {
  const view = await mount(panel().node);
  try {
    const alpha = view.text("project-alpha");
    expect(alpha).toContain("alpha");
    expect(alpha).toContain("armed");
    expect(alpha).toContain("qualified");
    // The current-run summary comes from the registry row, not from a scoped
    // read this view would have to make per project.
    expect(view.text("project-run-alpha")).toContain("run-1");
    expect(view.text("project-run-alpha")).toContain("running");

    const beta = view.text("project-beta");
    expect(beta).toContain("disarmed");
    // 022 B-6: a project with no run says so rather than showing an idle one.
    expect(view.text("project-run-beta")).toContain("no run has ever been created");
  } finally {
    view.unmount();
  }
});

test("selecting another project asks the shell to switch rather than switching locally", async () => {
  const picked: string[] = [];
  const view = await mount(panel({ onSelect: (name: string) => picked.push(name) }).node);
  try {
    // The selected project offers no button to select itself again.
    expect(view.query("select-alpha")).toBeNull();
    await view.click("select-beta");
    expect(picked).toEqual(["beta"]);
  } finally {
    view.unmount();
  }
});

test("qualification reasons are there on demand, not by default", async () => {
  const unqualified = fixtureProjectView("gamma", { armed: false, qualification: FIXTURE_UNQUALIFIED });
  const view = await mount(panel({ projects: { projects: [unqualified] } }).node);
  try {
    expect(view.text("project-gamma")).toContain("unqualified");
    expect(view.query("qualification-detail-gamma")).toBeNull();

    await view.click("qualification-gamma");

    const detail = view.text("qualification-detail-gamma");
    // 025 B-4's own words, in both directions: the failed check and the
    // warning that does not disqualify.
    expect(detail).toContain(`no "origin" remote`);
    expect(detail).toContain("does not gitignore data/");
  } finally {
    view.unmount();
  }
});

// --- standby: armed versus waiting (B-2) ------------------------------------

test("a finished backlog is stated as finished, not rendered as an empty panel", async () => {
  const view = await mount(panel().node);
  try {
    const alpha = view.text("backlog-alpha");
    expect(alpha).toContain("backlog complete: no spec is pending");
    expect(alpha).toContain("armed, with nothing pending");
    expect(alpha).toContain("standby");
  } finally {
    view.unmount();
  }
});

test("ready work on a disarmed project says the work exists and why it is not being taken", async () => {
  const view = await mount(panel().node);
  try {
    const beta = view.text("backlog-beta");
    expect(beta).toContain("1 spec pending, 002-beta ready");
    expect(beta).toContain("disarmed");
    expect(beta).toContain("never driven");
  } finally {
    view.unmount();
  }
});

test("the same ready work on an armed project reads as the scheduler's next pick", async () => {
  const view = await mount(
    panel({
      projects: { projects: [fixtureProjectView("beta")] },
      backlogs: folded([["beta", fixtureDagFor("beta", "ready")]]),
    }).node
  );
  try {
    const beta = view.text("backlog-beta");
    expect(beta).toContain("armed and qualified");
    expect(beta).toContain("when the flight slot frees");
  } finally {
    view.unmount();
  }
});

test("a backlog nobody has folded is marked unfolded rather than shown as complete", async () => {
  const view = await mount(panel({ backlogs: new Map() }).node);
  try {
    const alpha = view.text("backlog-alpha");
    expect(alpha).toContain("not folded");
    expect(alpha).toContain("has not been folded yet");
    expect(alpha).not.toContain("backlog complete");
  } finally {
    view.unmount();
  }
});

test("the daemon's own state and flight slot are on screen whatever the projects say", async () => {
  const view = await mount(panel({ meta: metaWithDaemon("driving", "beta") }).node);
  try {
    const daemon = view.text("standby-daemon");
    expect(daemon).toContain("driving");
    expect(daemon).toContain("beta");
    expect(view.text("backlog-beta")).toContain("holds the daemon's one flight slot");
  } finally {
    view.unmount();
  }
});

test("an empty registry is a stated fact", async () => {
  const view = await mount(panel({ projects: { projects: [] } }).node);
  try {
    const empty = view.text("standby-empty-registry");
    expect(empty).toContain("No project is registered");
    expect(empty).toContain("The daemon is up");
  } finally {
    view.unmount();
  }
});

test("a registry that has not been read is not an empty registry", async () => {
  const view = await mount(panel({ projects: null }).node);
  try {
    expect(view.query("standby-projects")).toBeNull();
    expect(view.query("standby-empty-registry")).toBeNull();
    expect(flat(view.container.textContent ?? "")).toContain("registry has not been read yet");
  } finally {
    view.unmount();
  }
});

// --- registry controls (B-3) ------------------------------------------------

test("arming previews the exact registry record and writes nothing yet", async () => {
  const { client, node } = panel();
  const view = await mount(node);
  try {
    await view.click("registry-arm-beta");

    const preview = view.text("registry-arm-beta-preview");
    expect(preview).toContain('"kind": "project.armed"');
    expect(preview).toContain('"name": "beta"');
    expect(preview).toContain('"source": "ui"');
    expect(client.calls).toEqual([]);
  } finally {
    view.unmount();
  }
});

test("cancelling a registry control leaves the chain untouched", async () => {
  const { client, node } = panel();
  const view = await mount(node);
  try {
    await view.click("registry-arm-beta");
    await view.click("registry-arm-beta-cancel");

    expect(client.calls).toEqual([]);
    expect(view.query("registry-arm-beta-dialog")).toBeNull();
  } finally {
    view.unmount();
  }
});

test("confirming issues exactly one registry call and reports the record the chain carries", async () => {
  let applied = 0;
  const { client, node } = panel({ onApplied: () => (applied += 1) });
  const view = await mount(node);
  try {
    await view.click("registry-arm-beta");
    await view.click("registry-arm-beta-confirm");

    expect(client.calls).toEqual([{ method: "arm", specId: null, project: "beta" }]);

    const answer = view.text("registry-arm-beta-answer");
    expect(answer).toContain("Journaled at seq 12");
    expect(answer).toContain('"kind": "project.armed"');
    // The row as the chain folds it after the call, not a locally toggled flag.
    expect(view.text("registry-arm-beta-snapshot")).toContain("armed");
    expect(applied).toBe(1);
  } finally {
    view.unmount();
  }
});

test("an open dialog keeps naming the verb it was opened with when the row refolds under it", async () => {
  const client = fixtureApiClient();
  const disarmed = fixtureProjectView("beta", { armed: false });
  const view = await mount(<RegistryControlButton verb="arm" client={client} project={disarmed} onApplied={() => undefined} />);
  try {
    await view.click("registry-arm-beta");
    await view.click("registry-arm-beta-confirm");

    // The refold that follows the call is what flips this row to armed, and an
    // armed row is offered disarm. The answer on screen is still the arm's.
    await view.update(
      <RegistryControlButton verb="disarm" client={client} project={fixtureProjectView("beta")} onApplied={() => undefined} />
    );
    expect(view.text("registry-arm-beta-answer")).toContain('"kind": "project.armed"');
    expect(view.query("registry-disarm-beta-answer")).toBeNull();

    // Dismissed, the button goes back to offering whatever the row now needs.
    await view.click("registry-arm-beta-dismiss");
    expect(view.query("registry-disarm-beta")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("an armed project is offered disarm rather than a second arm", async () => {
  const view = await mount(panel().node);
  try {
    expect(view.query("registry-disarm-alpha")).not.toBeNull();
    expect(view.query("registry-arm-alpha")).toBeNull();
    expect(view.query("registry-requalify-alpha")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("a read-only daemon offers no registry controls at all", async () => {
  const view = await mount(panel({ controlsAvailable: false }).node);
  try {
    expect(view.query("registry-disarm-alpha")).toBeNull();
    expect(view.query("registry-arm-beta")).toBeNull();
    expect(view.query("register-path")).toBeNull();
  } finally {
    view.unmount();
  }
});

test("a refused registry control surfaces the API error kind rather than a success", async () => {
  const client = fixtureApiClient({
    registryControl: () => ({
      ok: false,
      error: { kind: "conflict", message: `projects: no registered project named "beta"` },
    }),
  });
  const view = await mount(panel({ client }).node);
  try {
    await view.click("registry-arm-beta");
    await view.click("registry-arm-beta-confirm");

    const answer = view.text("registry-arm-beta-answer");
    expect(answer).toContain("conflict");
    expect(answer).toContain("no registered project named");
  } finally {
    view.unmount();
  }
});

test("registering previews the record the daemon will derive, then sends the typed path", async () => {
  const client = fixtureApiClient({
    registryControl: (verb, name) => ({ ok: true, data: registryAnswerFor(verb, name, 31) }),
  });
  const view = await mount(
    <RegistryControlButton verb="register" client={client} path="/repo/enrahitu" name="" onApplied={() => undefined} />
  );
  try {
    await view.click("registry-register");

    const preview = view.text("registry-register-preview");
    expect(preview).toContain('"kind": "project.registered"');
    expect(preview).toContain('"repoDir": "/repo/enrahitu"');
    expect(preview).toContain("derived from the path");
    expect(client.calls).toEqual([]);

    await view.click("registry-register-confirm");
    expect(client.calls).toEqual([{ method: "register", specId: null, project: null }]);
    expect(view.text("registry-register-answer")).toContain("Journaled at seq 31");
  } finally {
    view.unmount();
  }
});
