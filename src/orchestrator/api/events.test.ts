import { test, expect } from "bun:test";
import { journalResume } from "../quota";
import {
  EVENT_RING_CAPACITY,
  EventHub,
  MAX_EVENT_DATA_CHARS,
  SSE_HEARTBEAT_LINE,
  SSE_RETRY_LINE,
  boundEventData,
  eventTypeForKind,
  formatReplayGap,
  formatSseEvent,
  parseLastEventId,
  startJournalPump,
} from "./events";
import { freshWorld, seedPark, seedRun } from "./fixtures";
import { journalViewFromHandle } from "./server";

// --- classification ---------------------------------------------------------

test("eventTypeForKind maps journal kinds onto the stream's own taxonomy", () => {
  expect(eventTypeForKind("state.transition.intent")).toBe("transition");
  expect(eventTypeForKind("state.transition.outcome")).toBe("transition");
  expect(eventTypeForKind("session.init")).toBe("session");
  expect(eventTypeForKind("session.result")).toBe("session");
  expect(eventTypeForKind("quota.parked")).toBe("quota");
  expect(eventTypeForKind("control.pause")).toBe("control");
  expect(eventTypeForKind("stage.verify.result")).toBe("stage");
  expect(eventTypeForKind("daemon.heartbeat")).toBe("journal");
});

// --- bounding (B-4) ---------------------------------------------------------

test("boundEventData passes small payloads through and replaces oversized ones with a marker", () => {
  const small = { specId: "002-beta", outcome: "passed" };
  expect(boundEventData(small, 4, "stage.ship.result", MAX_EVENT_DATA_CHARS)).toEqual(small);

  const huge = { stderrTail: "x".repeat(MAX_EVENT_DATA_CHARS + 100) };
  const bounded = boundEventData(huge, 12, "session.result", MAX_EVENT_DATA_CHARS);
  expect(bounded).toMatchObject({ bounded: true, seq: 12, kind: "session.result" });
  // The marker states the real size rather than silently trimming the text.
  expect((bounded as { chars: number }).chars).toBeGreaterThan(MAX_EVENT_DATA_CHARS);
});

// --- the ring (B-4) ---------------------------------------------------------

test("EventHub assigns monotonic ids and keeps only the last N events", () => {
  const hub = new EventHub(4);
  for (let i = 0; i < 10; i++) {
    hub.publish({ type: "journal", seq: i, ts: "2026-07-30T00:00:00.000Z", kind: "test", data: { i } });
  }
  expect(hub.lastEventId).toBe(10);
  expect(hub.buffered.map((e) => e.id)).toEqual([7, 8, 9, 10]);
});

test("EventHub replays everything after Last-Event-ID, and reports a gap when it cannot", () => {
  const hub = new EventHub(4);
  for (let i = 0; i < 6; i++) {
    hub.publish({ type: "journal", seq: i, ts: "2026-07-30T00:00:00.000Z", kind: "test", data: { i } });
  }

  const resumable = hub.replayFrom(4);
  expect(resumable.gap).toBe(false);
  expect(resumable.events.map((e) => e.id)).toEqual([5, 6]);

  // Event 1 has already been evicted, so resuming from 0 cannot be honest
  // about completeness and says so.
  const gapped = hub.replayFrom(0);
  expect(gapped.gap).toBe(true);
  expect(gapped.events.map((e) => e.id)).toEqual([3, 4, 5, 6]);

  expect(hub.replayFrom(hub.lastEventId).events).toEqual([]);
});

test("EventHub fans out to subscribers and survives one that throws", () => {
  const hub = new EventHub();
  const seen: number[] = [];
  hub.subscribe(() => {
    throw new Error("this client is gone");
  });
  const unsubscribe = hub.subscribe((e) => seen.push(e.id));

  hub.publish({ type: "journal", seq: 1, ts: "t", kind: "test", data: null });
  expect(seen).toEqual([1]);
  expect(hub.listenerCount).toBe(2);

  unsubscribe();
  hub.publish({ type: "journal", seq: 2, ts: "t", kind: "test", data: null });
  expect(seen).toEqual([1]);
  expect(hub.listenerCount).toBe(1);
});

test("EventHub defaults to the documented ring capacity", () => {
  const hub = new EventHub();
  for (let i = 0; i < EVENT_RING_CAPACITY + 10; i++) {
    hub.publish({ type: "journal", seq: i, ts: "t", kind: "test", data: null });
  }
  expect(hub.buffered.length).toBe(EVENT_RING_CAPACITY);
});

// --- SSE framing (B-4) ------------------------------------------------------

test("formatSseEvent frames one event with id, type, and a single-line data field", () => {
  const framed = formatSseEvent({
    id: 12,
    type: "stage",
    seq: 40,
    ts: "2026-07-30T00:00:00.000Z",
    kind: "stage.verify.result",
    data: { outcome: "passed", detail: "line one\nline two" },
  });
  expect(framed.startsWith("id: 12\nevent: stage\ndata: ")).toBe(true);
  expect(framed.endsWith("\n\n")).toBe(true);
  // A newline inside the payload must not split the data field.
  expect(framed.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
  const body = JSON.parse(framed.split("data: ")[1]!.trim());
  expect(body).toEqual({
    seq: 40,
    ts: "2026-07-30T00:00:00.000Z",
    kind: "stage.verify.result",
    data: { outcome: "passed", detail: "line one\nline two" },
  });
});

test("the retry directive matches B-4's documented backoff", () => {
  expect(SSE_RETRY_LINE).toBe("retry: 3000\n\n");
  expect(SSE_HEARTBEAT_LINE.startsWith(":")).toBe(true);
});

test("a replay gap notice carries no id, so it cannot move the client's cursor", () => {
  const notice = formatReplayGap(3, 12);
  expect(notice.includes("id: ")).toBe(false);
  expect(notice.startsWith("event: meta\n")).toBe(true);
  expect(JSON.parse(notice.split("data: ")[1]!.trim()).data).toEqual({ requestedAfter: 3, oldestBufferedId: 12 });
});

test("parseLastEventId accepts only a plain integer", () => {
  expect(parseLastEventId(null)).toBeNull();
  expect(parseLastEventId("")).toBeNull();
  expect(parseLastEventId("abc")).toBeNull();
  expect(parseLastEventId("-1")).toBeNull();
  expect(parseLastEventId(" 42 ")).toBe(42);
});

// --- the journal pump (B-4) -------------------------------------------------

test("the pump publishes only records appended after it started", () => {
  const world = freshWorld("pump");
  try {
    seedRun(world);
    const hub = new EventHub();
    const pump = startJournalPump({
      hub,
      journal: journalViewFromHandle(world.journal),
      clock: { now: () => 1_700_000_000_000 },
      intervalMs: 1_000_000,
    });
    try {
      // Everything the seeded run wrote predates the pump: subscribing is
      // not a request to relive the whole run.
      expect(pump.pumpOnce()).toEqual([]);

      world.journal.append("control.pause", { runId: "r", source: "api" });
      world.journal.append("stage.verify.result", { specId: "003-gamma", sha: "abc", outcome: "failed", needsHuman: false });

      const published = pump.pumpOnce();
      expect(published.map((e) => e.type)).toEqual(["control", "stage"]);
      expect(published.map((e) => e.kind)).toEqual(["control.pause", "stage.verify.result"]);
      expect(published[0]!.seq).toBeGreaterThan(0);
      expect(pump.pumpOnce()).toEqual([]);
    } finally {
      pump.stop();
    }
  } finally {
    world.close();
  }
});

test("the pump bounds an oversized journal payload instead of streaming it whole", () => {
  const world = freshWorld("pump-bounded");
  try {
    const hub = new EventHub();
    const pump = startJournalPump({
      hub,
      journal: journalViewFromHandle(world.journal),
      clock: { now: () => 0 },
      intervalMs: 1_000_000,
      maxEventChars: 64,
    });
    try {
      world.journal.append("session.result", { stderrTail: "y".repeat(500), classification: "completed" });
      const [event] = pump.pumpOnce();
      expect(event!.type).toBe("session");
      expect(event!.data).toMatchObject({ bounded: true, kind: "session.result" });
    } finally {
      pump.stop();
    }
  } finally {
    world.close();
  }
});

test("the pump emits quota ticks on its own cadence while parked, and stops on resume", () => {
  const world = freshWorld("pump-quota");
  try {
    const target = 1_700_000_600_000;
    let now = 1_700_000_000_000;
    const hub = new EventHub();
    const pump = startJournalPump({
      hub,
      journal: journalViewFromHandle(world.journal),
      clock: { now: () => now },
      intervalMs: 1_000_000,
      quotaTickMs: 15_000,
    });
    try {
      seedPark(world, target, 2, true);

      const first = pump.pumpOnce();
      // The park record itself, then the first tick.
      expect(first.map((e) => e.kind)).toEqual(["quota.parked", "quota.tick"]);
      expect(first[1]!.data).toMatchObject({ parked: true, targetMs: target, estimated: true, msUntilTarget: 600_000 });

      // Too soon for another tick.
      expect(pump.pumpOnce()).toEqual([]);

      now += 15_000;
      const second = pump.pumpOnce();
      expect(second.map((e) => e.kind)).toEqual(["quota.tick"]);
      expect(second[0]!.data).toMatchObject({ msUntilTarget: 585_000 });
      expect(second[0]!.seq).toBeNull();

      journalResume(world.journal, now);
      const third = pump.pumpOnce();
      expect(third.map((e) => e.kind)).toEqual(["quota.resumed"]);

      now += 60_000;
      expect(pump.pumpOnce()).toEqual([]);
    } finally {
      pump.stop();
    }
  } finally {
    world.close();
  }
});
