// The control confirmation flow (spec 024 FR-002, B-6, B-7).
//
// Three properties are worth more than the rest: nothing is written before
// the confirmation is accepted, the record shown before the click is the one
// the daemon writes after it, and an outcome that journals nothing says so
// instead of showing a record that will not exist.
import { expect, test } from "bun:test";
import { mount, flat, useDom } from "./harness";
import { controlAnswer, fixtureClient, runViewWithStatus, FIXTURE_RUN } from "./fixtures";
import { ControlButton } from "../src/components/ControlButton";

useDom();

test("opening a spec control previews the exact record and writes nothing yet", async () => {
  const client = fixtureClient();
  const view = await mount(<ControlButton verb="skip" client={client} run={FIXTURE_RUN} specId="003-gamma" />);
  try {
    await view.click("control-skip-003-gamma");

    const preview = view.text("control-skip-003-gamma-preview");
    expect(preview).toContain('"kind": "control.skipSpec"');
    expect(preview).toContain('"specId": "003-gamma"');
    expect(preview).toContain('"source": "web-ui"');
    expect(flat(view.find("control-skip-003-gamma-dialog").textContent ?? "")).toContain("writes one record");

    // B-6: the confirmation precedes the write.
    expect(client.calls).toEqual([]);
  } finally {
    view.unmount();
  }
});

test("cancelling leaves the journal untouched", async () => {
  const client = fixtureClient();
  const view = await mount(<ControlButton verb="skip" client={client} run={FIXTURE_RUN} specId="003-gamma" />);
  try {
    await view.click("control-skip-003-gamma");
    await view.click("control-skip-003-gamma-cancel");

    expect(client.calls).toEqual([]);
    expect(view.query("control-skip-003-gamma-dialog")).toBeNull();
    expect(view.query("control-skip-003-gamma")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

test("confirming issues exactly one control and reports the record the daemon journaled", async () => {
  let applied = 0;
  const client = fixtureClient({
    control: (verb, specId) => ({
      ok: true,
      data: controlAnswer(verb, specId, "control.skipSpec", { specId: specId ?? "", source: "web-ui" }, 128),
    }),
  });
  const view = await mount(
    <ControlButton verb="skip" client={client} run={FIXTURE_RUN} specId="003-gamma" onApplied={() => (applied += 1)} />
  );
  try {
    await view.click("control-skip-003-gamma");
    await view.click("control-skip-003-gamma-confirm");

    expect(client.calls).toEqual([{ method: "skipSpec", specId: "003-gamma" }]);

    const answer = view.text("control-skip-003-gamma-answer");
    expect(answer).toContain("Journaled at seq 128");
    expect(answer).toContain('"kind": "control.skipSpec"');

    // B-7: the surrounding views refold from the read routes rather than
    // being patched here.
    expect(applied).toBe(1);
  } finally {
    view.unmount();
  }
});

test("an idempotent verb says nothing will be journaled rather than showing a record", async () => {
  const client = fixtureClient();
  const view = await mount(<ControlButton verb="pause" client={client} run={runViewWithStatus("paused")} />);
  try {
    await view.click("control-pause");

    expect(view.text("control-pause-preview")).toBe("No record will be journaled.");
    expect(flat(view.find("control-pause-dialog").textContent ?? "")).toContain("no-op, writes nothing");
  } finally {
    view.unmount();
  }
});

test("start on a paused run previews the control.resume it actually writes", async () => {
  const client = fixtureClient();
  const view = await mount(<ControlButton verb="start" client={client} run={runViewWithStatus("paused")} />);
  try {
    await view.click("control-start");

    const preview = view.text("control-start-preview");
    expect(preview).toContain('"kind": "control.resume"');
    expect(preview).toContain('"runId": "run-1"');
    expect(flat(view.find("control-start-dialog").textContent ?? "")).toContain("Start delegates to resume");
  } finally {
    view.unmount();
  }
});

test("a verb the daemon will refuse is labelled as such and still sendable", async () => {
  const client = fixtureClient();
  const view = await mount(<ControlButton verb="start" client={client} run={runViewWithStatus("parked")} />);
  try {
    await view.click("control-start");

    const dialog = flat(view.find("control-start-dialog").textContent ?? "");
    expect(dialog).toContain("the daemon will refuse this");
    expect(dialog).toContain('A run in status "parked" cannot be started');
    // The plan is a prediction from the last fetched state; the daemon still
    // decides, so the button is offered rather than disabled.
    expect(view.find("control-start-confirm").textContent).toBe("Send anyway");
  } finally {
    view.unmount();
  }
});

test("a refused control surfaces the API error kind", async () => {
  const client = fixtureClient({
    control: () => ({ ok: false, error: { kind: "conflict", message: 'a run in status "parked" cannot be started' } }),
  });
  const view = await mount(<ControlButton verb="start" client={client} run={runViewWithStatus("parked")} />);
  try {
    await view.click("control-start");
    await view.click("control-start-confirm");

    const answer = view.text("control-start-answer");
    expect(answer).toContain("conflict");
    expect(answer).toContain("cannot be started");
  } finally {
    view.unmount();
  }
});
