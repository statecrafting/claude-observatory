// The live tail's scope, and what it says when it has nothing to show
// (spec 029 B-5).
//
// One stream carries every project, so the tail has to filter, and a filtered
// view that renders empty has to say which filter emptied it. There are three
// distinct facts here and they are not interchangeable: nothing streamed at
// all, nothing streamed for this project, and nothing of the selected type
// streamed for this project. Collapsing the third into the second tells an
// operator their project is silent while its records sit in the buffer, which
// is the class of confident-but-wrong statement 024 B-7 exists to forbid.
import { expect, test } from "bun:test";
import { mount, useDom } from "./harness";
import { RunPanel } from "../src/views/RunPanel";
import type { ApiEventType } from "../src/api";
import type { StreamEvent } from "../src/store";
import { FIXTURE_RUN } from "./fixtures";

useDom();

let nextKey = 0;

function event(project: string | null, type: ApiEventType): StreamEvent {
  const key = nextKey++;
  return { key, id: key + 1, project, type, seq: key + 1, ts: "2026-08-01T12:00:00.000Z", kind: `${type}.fixture`, data: {} };
}

function panel(events: readonly StreamEvent[]) {
  return (
    <RunPanel
      run={FIXTURE_RUN}
      error={null}
      events={events}
      stream="open"
      nowMs={Date.parse("2026-08-01T12:00:10.000Z")}
      project="alpha"
      client={null}
      controlsAvailable={false}
    />
  );
}

test("an empty stream says so, without claiming anything about this project", async () => {
  const view = await mount(panel([]));
  try {
    expect(view.text("tail-empty")).toContain("Nothing has streamed yet");
  } finally {
    view.unmount();
  }
});

test("a buffer holding only other projects' records says the records came off other chains", async () => {
  const view = await mount(panel([event("beta", "journal"), event("beta", "session")]));
  try {
    const text = view.text("tail-empty");
    expect(text).toContain("Nothing on the stream belongs to");
    expect(text).toContain("alpha");
    expect(text).toContain("2 buffered records came off other chains");
    // The count line reports the scoped buffer against the whole one, so the
    // two records that were filtered out are still visible as a number.
    expect(view.text("tail-counts")).toContain("0 of 2 buffered");
  } finally {
    view.unmount();
  }
});

test("the type filter emptying the tail is not reported as this project having no records", async () => {
  const view = await mount(panel([event("alpha", "journal"), event("alpha", "transition")]));
  try {
    // Both records are alpha's, so the tail renders them until the type filter
    // is on; once it is, the empty state must name the type filter as the cause.
    expect(view.query("tail-empty")).toBeNull();

    await view.click("tail-session-only");

    const text = view.text("tail-empty");
    expect(text).toContain("No session event has streamed yet");
    expect(text).toContain("2 buffered records in scope are of other types");
    expect(text).not.toContain("came off other chains");
  } finally {
    view.unmount();
  }
});

test("the every-project box widens the tail back to the whole buffer", async () => {
  const view = await mount(panel([event("beta", "journal")]));
  try {
    expect(view.text("tail-empty")).toContain("came off other chains");

    await view.click("tail-every-project");

    expect(view.query("tail-empty")).toBeNull();
    expect(view.text("tail-counts")).toContain("1 of 1 buffered");
  } finally {
    view.unmount();
  }
});

// A daemon-scoped record belongs to no project and is carried into every
// project's tail, exactly as the server's own filtered stream carries it.
test("a daemon-scoped record shows in the selected project's tail", async () => {
  const view = await mount(panel([event(null, "project")]));
  try {
    expect(view.query("tail-empty")).toBeNull();
    expect(view.text("tail-counts")).toContain("1 of 1 buffered");
  } finally {
    view.unmount();
  }
});
