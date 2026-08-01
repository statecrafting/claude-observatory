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
//
// v2 (spec 027 B-4) keeps all of that and adds one field: every event names
// the project whose chain it came off, or null when it is daemon-scoped (a
// registry mutation). One ring, one stream, one replay window, with an
// optional server-side filter, rather than a ring per project.
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
  // The registry chain's own kinds (spec 025 B-2). They are daemon-scoped,
  // not the property of any one project, and a client filtering the stream
  // wants them distinguishable from a project's work records.
  if (kind.startsWith("project.")) return "project";
  return "journal";
}

// The `?project=<name>` filter (B-4). A filtered stream still carries
// daemon-scoped events: a client watching one project has to see that
// project being disarmed or removed, and a filter that dropped the registry
// chain would leave it watching something the daemon no longer has.
export function matchesProjectFilter(event: Pick<ApiEvent, "project">, filter: string | null): boolean {
  if (filter === null) return true;
  return event.project === null || event.project === filter;
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

  // The gap is computed against the whole ring, not the filtered slice: a
  // client that missed events for another project has missed nothing it
  // asked for, so a filter must not turn a complete resume into a reported
  // loss (or the reverse).
  replayFrom(lastEventId: number, projectFilter: string | null = null): ReplayResult {
    const events = this.ring.filter((e) => e.id > lastEventId && matchesProjectFilter(e, projectFilter));
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
  const body = JSON.stringify({
    project: event.project,
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    data: event.data,
  });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${body}\n\n`;
}

// A replay gap carries no `id:` line on purpose: it is a server notice about
// the stream, not a stream position, so it must not overwrite the client's
// own Last-Event-ID cursor.
export function formatReplayGap(requestedAfter: number, oldestBufferedId: number | null): string {
  const body = JSON.stringify({
    project: null,
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

// One chain the pump watches. `project` is null for the daemon's own registry
// chain, which belongs to no project (027 B-4).
export interface PumpSource {
  readonly project: string | null;
  readonly journal: JournalSource;
}

export interface JournalPumpOptions {
  readonly hub: EventHub;
  // Re-read every tick rather than captured once: a project registered while
  // the daemon runs starts streaming without a restart, and a removed one
  // stops. A source seen for the first time starts at its own current tail,
  // for the same reason the pump as a whole does.
  readonly sources: () => readonly PumpSource[];
  readonly clock: { now(): number };
  readonly intervalMs?: number;
  readonly quotaTickMs?: number;
  readonly maxEventChars?: number;
  // Publish records with a seq greater than this, for every source. Defaults
  // to each chain's current tail, so opening the stream does not replay the
  // whole run's history as if it were happening now; `Last-Event-ID` replay
  // (bounded to the ring) is the mechanism for resuming, and the GET routes
  // are the mechanism for history.
  readonly fromSeq?: number;
}

export interface JournalPump {
  // Exposed so tests drive the pump deterministically instead of racing a
  // timer, and so a caller can force a flush before reading the ring.
  pumpOnce(): readonly ApiEvent[];
  stop(): void;
}

// Sources are keyed by project name; the daemon-scoped chain gets a key no
// project name can collide with, because 025 D-1's slug grammar forbids "/".
const DAEMON_SOURCE_KEY = "/daemon";

function sourceKey(project: string | null): string {
  return project ?? DAEMON_SOURCE_KEY;
}

export function startJournalPump(options: JournalPumpOptions): JournalPump {
  const { hub, clock } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  const quotaTickMs = options.quotaTickMs ?? DEFAULT_QUOTA_TICK_MS;
  const maxEventChars = options.maxEventChars ?? MAX_EVENT_DATA_CHARS;

  const lastSeq = new Map<string, number>();
  const lastQuotaTickMs = new Map<string, number>();

  // A chain's starting point is its tail the first time the pump sees it: at
  // construction for the sources that already exist, and at first sight for
  // one that appears later (a project registered while the daemon runs). Both
  // are the same rule, and both are why joining the stream is not a request
  // to relive a run.
  function markTail(source: PumpSource): number {
    const key = sourceKey(source.project);
    const existing = lastSeq.get(key);
    if (existing !== undefined) return existing;
    let seen: number;
    try {
      seen = options.fromSeq ?? (source.journal.records().at(-1)?.seq ?? -1);
    } catch {
      seen = options.fromSeq ?? -1;
    }
    lastSeq.set(key, seen);
    return seen;
  }

  function pumpSource(source: PumpSource, published: ApiEvent[]): void {
    const key = sourceKey(source.project);
    let seen = markTail(source);
    const records = source.journal.records();

    for (const record of records) {
      if (record.seq <= seen) continue;
      seen = record.seq;
      lastSeq.set(key, seen);
      published.push(
        hub.publish({
          project: source.project,
          type: eventTypeForKind(record.kind),
          seq: record.seq,
          ts: record.ts,
          kind: record.kind,
          data: boundEventData(record.payload, record.seq, record.kind, maxEventChars),
        })
      );
    }

    // The quota tick (B-4): while a run is parked there is nothing to append
    // to its journal, but the countdown is still moving, so the stream says
    // so on its own cadence. Derived from the journaled target every time,
    // never from a stored ticking counter (spec 015 B-2). Ticked per project
    // because that is whose journal the target is in; only one project can
    // hold the flight slot, so only one can be parked (010 D15).
    const quota = foldQuotaState(records);
    const now = clock.now();
    if (quota.parked && quota.lastPark) {
      const previous = lastQuotaTickMs.get(key);
      if (previous === undefined || now - previous >= quotaTickMs) {
        lastQuotaTickMs.set(key, now);
        published.push(
          hub.publish({
            project: source.project,
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
      lastQuotaTickMs.delete(key);
    }
  }

  function pumpOnce(): readonly ApiEvent[] {
    const published: ApiEvent[] = [];
    const sources = options.sources();
    const live = new Set<string>();

    for (const source of sources) {
      live.add(sourceKey(source.project));
      // One project whose state root went unreadable must not stop the rest
      // of the daemon's stream; the read routes report that project's own
      // failure, and the pump simply has nothing new from it this tick.
      try {
        pumpSource(source, published);
      } catch {
        // nothing publishable from this chain right now
      }
    }

    // A project removed from the registry (025 D-2) is forgotten here too, so
    // a name re-registered against a different target does not resume from
    // some other chain's sequence.
    for (const key of [...lastSeq.keys()]) {
      if (!live.has(key)) {
        lastSeq.delete(key);
        lastQuotaTickMs.delete(key);
      }
    }

    return published;
  }

  for (const source of options.sources()) markTail(source);

  const timer = setInterval(pumpOnce, intervalMs);
  timer.unref?.();

  return {
    pumpOnce,
    stop(): void {
      clearInterval(timer);
    },
  };
}
