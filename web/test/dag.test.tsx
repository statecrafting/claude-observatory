// DAG readiness rendering (spec 024 FR-002, B-2).
//
// The assertions are deliberately about the daemon's own words: a blocker is
// asserted verbatim, because the whole point of B-2 is that the reason the
// scheduler will refuse a spec is the reason the operator reads, not a
// paraphrase this UI invented.
import { expect, test } from "bun:test";
import { mount, flat, useDom } from "./harness";
import { fixtureClient, FIXTURE_DAG, FIXTURE_RUN } from "./fixtures";
import { DagPanel } from "../src/views/DagPanel";

useDom();

function panel(overrides: Partial<Parameters<typeof DagPanel>[0]> = {}) {
  const client = fixtureClient();
  return (
    <DagPanel dag={FIXTURE_DAG} error={null} client={client} run={FIXTURE_RUN} controlsAvailable={false} {...overrides} />
  );
}

test("a ready spec renders as ready and the scheduler's next pick is named", async () => {
  const view = await mount(panel());
  try {
    expect(view.text("dag-next-ready")).toBe("002-beta");
    expect(view.text("dag-ready-002-beta")).toBe("ready");
    expect(view.text("dag-ready-001-alpha")).toBe("ready");
  } finally {
    view.unmount();
  }
});

test("a blocked spec renders every blocker verbatim, not a summary", async () => {
  const view = await mount(panel());
  try {
    const readiness = view.text("dag-ready-003-gamma");
    expect(readiness).toContain("blocked");
    expect(readiness).toContain("dependency 002-beta is not shipped");
    expect(readiness).toContain("dependency 004-delta is invalidated (pin drift)");
  } finally {
    view.unmount();
  }
});

test("pin drift is rendered on the node and summarized above the graph", async () => {
  const view = await mount(panel());
  try {
    const node = view.find("dag-node-004-delta");
    expect(node.className).toContain("dag-node-invalidated");
    expect(flat(node.textContent ?? "")).toContain("pin drift");

    // Both pins are shown: drift is only legible as a difference.
    const pins = view.text("dag-pin-004-delta");
    expect(pins).toContain("dddddddddddd");
    expect(pins).toContain("eeeeeeeeeeee");

    expect(view.text("dag-invalidated")).toContain("004-delta");
  } finally {
    view.unmount();
  }
});

test("a spec with no implementation field renders as unknown, not as pending", async () => {
  const dag = {
    ...FIXTURE_DAG,
    specs: FIXTURE_DAG.specs.map((spec) => (spec.id === "002-beta" ? { ...spec, implementation: null } : spec)),
  };
  const view = await mount(panel({ dag }));
  try {
    const node = flat(view.find("dag-node-002-beta").textContent ?? "");
    expect(node).toContain("unknown");
    expect(node).not.toContain("pending");
  } finally {
    view.unmount();
  }
});

// AC-2's shape at the panel level: a daemon that stopped answering leaves an
// error kind on screen and no invented graph.
test("an unreachable daemon renders the error kind and no graph", async () => {
  const view = await mount(panel({ dag: null, error: { kind: "unreachable", message: "connection refused" } }));
  try {
    expect(flat(view.container.textContent ?? "")).toContain("unreachable");
    expect(flat(view.container.textContent ?? "")).toContain("No DAG has been served yet.");
    expect(view.query("dag-node-002-beta")).toBeNull();
  } finally {
    view.unmount();
  }
});

test("a spec whose pin could not be read reports a read failure, not drift", async () => {
  const dag = {
    ...FIXTURE_DAG,
    specs: FIXTURE_DAG.specs.map((spec) =>
      spec.id === "002-beta" ? { ...spec, currentPin: null, pinError: "dag: cannot read spec file for 002-beta" } : spec
    ),
  };
  const view = await mount(panel({ dag }));
  try {
    const pins = view.text("dag-pin-002-beta");
    expect(pins).toContain("pin unreadable");
    expect(pins).toContain("cannot read spec file");
    expect(pins).not.toContain("pin drift");
  } finally {
    view.unmount();
  }
});
