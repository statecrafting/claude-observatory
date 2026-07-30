// The event stream (spec 022 B-4), after statecraft's admin-stream pattern:
// a bounded in-memory ring of the most recent events, a fan-out to every
// connected SSE client, a comment heartbeat so an idle connection is still
// observably alive, and `Last-Event-ID` replay so a reconnect resumes rather
// than restarts.
//
// The daemon owns the journal's writer handle and this module never touches
// it: the pump polls the same read-only view the GET routes fold and
// publishes one event per newly appended record. That keeps the stream a
// strict projection of what is durably on disk (B-6): nothing can be
// announced over SSE that a later fold would deny.
import type { JournalRecord, JsonValue } from "../journal";
import { foldQuotaState } from "../quota";
import type { ApiEvent, ApiEventType } from "./types";

// --- constants (B-4) --------------------------------------------------------

export const EVENT_RING_CAPACITY = 256;
export const SSE_RETRY_MS = 3000;
export const SSE_HEARTBEAT_MS = 15_000;
export const DEFAULT_PUMP_INTERVAL_MS = 250;
export const DEFAULT_QUOTA_TICK_MS = 15_000;

// B-4's "bounded". A journal payload larger than this is not streamed
// verbatim; the event carries its seq and size instead, and the client
// refetches the derived state from the read routes, where the full truth
// lives. Silently truncating a payload's own strings would produce an event
// that looks complete and is not.
export const MAX_EVENT_DATA_CHARS = 4096;

// --- classification ---------------------------------------------------------

export function eventTypeForKind(kind: string): ApiEventType {
  if (kind.startsWith("state.transition.")) return "transition";
  if (kind.startsWith("session.")) return "session";
  if (kind.startsWith("quota.")) return "quota";
  if (kind.startsWith("control.")) return "control";
  if (kind.startsWith("stage.")) return "stage";
  return "journal";
}

export function boundEventData(payload: JsonValue, seq: number, kind: string, maxChars: number): JsonValue {
  const encoded = JSON.stringify(payload) ?? "null";
  if (encoded.length <= maxChars) return payload;
  return { bounded: true, seq, kind, chars: encoded.length };
}

// --- the hub ----------------------------------------------------------------

export type EventListener = (event: ApiEvent) => void;

export interface ReplayResult {
  readonly events: readonly ApiEvent[];
  // True when the requested Last-Event-ID is older than anything still in
  // the ring: some events are gone for good and the client is told so
  // instead of being handed a silently incomplete resume.
  readonly gap: boolean;
}

export class EventHub {
  private readonly capacity: number;
  private readonly ring: ApiEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private nextId = 1;

  constructor(capacity: number = EVENT_RING_CAPACITY) {
    if (capacity < 1) throw new Error("api: EventHub capacity must be at least 1");
    this.capacity = capacity;
  }

  get lastEventId(): number {
    return this.nextId - 1;
  }

  get buffered(): readonly ApiEvent[] {
    return this.ring;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(event: Omit<ApiEvent, "id">): ApiEvent {
    const published: ApiEvent = { ...event, id: this.nextId++ };
    this.ring.push(published);
    while (this.ring.length > this.capacity) this.ring.shift();
    for (const listener of this.listeners) {
      try {
        listener(published);
      } catch {
        // A dead or closed client must never break the fan-out for the rest.
      }
    }
    return published;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  replayFrom(lastEventId: number): ReplayResult {
    const events = this.ring.filter((e) => e.id > lastEventId);
    const oldest = this.ring[0];
    const gap = oldest !== undefined && oldest.id > lastEventId + 1;
    return { events, gap };
  }
}

// --- SSE framing (B-4) ------------------------------------------------------

export const SSE_RETRY_LINE = `retry: ${SSE_RETRY_MS}\n\n`;
export const SSE_HEARTBEAT_LINE = ": heartbeat\n\n";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Nothing proxies a loopback daemon in v1, but a buffering proxy in front
  // of one later would defeat the stream entirely; saying so costs nothing.
  "X-Accel-Buffering": "no",
};

// JSON.stringify escapes every newline, so the single `data:` line below can
// never be split by payload content.
export function formatSseEvent(event: ApiEvent): string {
  const body = JSON.stringify({ seq: event.seq, ts: event.ts, kind: event.kind, data: event.data });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${body}\n\n`;
}

// A replay gap carries no `id:` line on purpose: it is a server notice about
// the stream, not a stream position, so it must not overwrite the client's
// own Last-Event-ID cursor.
export function formatReplayGap(requestedAfter: number, oldestBufferedId: number | null): string {
  const body = JSON.stringify({
    seq: null,
    ts: null,
    kind: "api.replay-gap",
    data: { requestedAfter, oldestBufferedId },
  });
  return `event: meta\ndata: ${body}\n\n`;
}

export function parseLastEventId(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// --- the journal pump (B-4) -------------------------------------------------

export interface JournalSource {
  records(): readonly JournalRecord[];
}

export interface JournalPumpOptions {
  readonly hub: EventHub;
  readonly journal: JournalSource;
  readonly clock: { now(): number };
  readonly intervalMs?: number;
  readonly quotaTickMs?: number;
  readonly maxEventChars?: number;
  // Publish records with a seq greater than this. Defaults to the journal's
  // current tail, so opening the stream does not replay the whole run's
  // history as if it were happening now; `Last-Event-ID` replay (bounded to
  // the ring) is the mechanism for resuming, and the GET routes are the
  // mechanism for history.
  readonly fromSeq?: number;
}

export interface JournalPump {
  // Exposed so tests drive the pump deterministically instead of racing a
  // timer, and so a caller can force a flush before reading the ring.
  pumpOnce(): readonly ApiEvent[];
  stop(): void;
}

export function startJournalPump(options: JournalPumpOptions): JournalPump {
  const { hub, journal, clock } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  const quotaTickMs = options.quotaTickMs ?? DEFAULT_QUOTA_TICK_MS;
  const maxEventChars = options.maxEventChars ?? MAX_EVENT_DATA_CHARS;

  const initial = journal.records();
  let lastSeq = options.fromSeq ?? (initial.at(-1)?.seq ?? -1);
  let lastQuotaTickMs: number | null = null;

  function pumpOnce(): readonly ApiEvent[] {
    const published: ApiEvent[] = [];
    const records = journal.records();

    for (const record of records) {
      if (record.seq <= lastSeq) continue;
      lastSeq = record.seq;
      published.push(
        hub.publish({
          type: eventTypeForKind(record.kind),
          seq: record.seq,
          ts: record.ts,
          kind: record.kind,
          data: boundEventData(record.payload, record.seq, record.kind, maxEventChars),
        })
      );
    }

    // The quota tick (B-4): while the run is parked there is nothing to
    // append to the journal, but the countdown is still moving, so the
    // stream says so on its own cadence. Derived from the journaled target
    // every time, never from a stored ticking counter (spec 015 B-2).
    const quota = foldQuotaState(records);
    const now = clock.now();
    if (quota.parked && quota.lastPark) {
      if (lastQuotaTickMs === null || now - lastQuotaTickMs >= quotaTickMs) {
        lastQuotaTickMs = now;
        published.push(
          hub.publish({
            type: "quota",
            seq: null,
            ts: new Date(now).toISOString(),
            kind: "quota.tick",
            data: {
              parked: true,
              targetMs: quota.lastPark.targetMs,
              estimated: quota.lastPark.estimated,
              consecutiveQuotaParks: quota.lastPark.consecutiveQuotaParks,
              msUntilTarget: quota.lastPark.targetMs - now,
              nowMs: now,
            },
          })
        );
      }
    } else {
      lastQuotaTickMs = null;
    }

    return published;
  }

  const timer = setInterval(pumpOnce, intervalMs);
  timer.unref?.();

  return {
    pumpOnce,
    stop(): void {
      clearInterval(timer);
    },
  };
}
