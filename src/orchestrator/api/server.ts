// The daemon's only interface (spec 022): a loopback-bound Bun.serve router
// over the read models in state.ts, the control verbs spec 021 B-4 exposes,
// and the SSE stream in events.ts.
//
// Two disciplines shape everything below. First, every JSON answer travels
// in one envelope (B-2), so a client branches on `ok` and a stable `kind`
// token, never on an HTTP status alone. Second, every read is a fold of the
// journal performed during the request (B-6): this module holds no state
// that could disagree with the journal, because it holds no state at all
// beyond the event ring, which is itself a projection of appended records.
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JournalRecord } from "../journal";
import type { DagReader } from "../dag";
import { loadRegistrySnapshot } from "../dag";
import type { RunStatus } from "../state";
import {
  EventHub,
  SSE_HEADERS,
  SSE_HEARTBEAT_LINE,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_LINE,
  formatReplayGap,
  formatSseEvent,
  parseLastEventId,
  startJournalPump,
  type JournalPump,
  type JournalSource,
} from "./events";
import { dagView, decisionsView, historyView, quotaView, runView } from "./state";
import {
  API_ROUTES,
  API_VERSION,
  API_VERSION_HEADER,
  CONTROL_SOURCE_HEADER,
  DEFAULT_CONTROL_SOURCE,
  SPEC_CONTROL_VERBS,
  toApiJournalRecord,
  type ApiError,
  type ApiErrorKind,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type ControlVerbToken,
  type DecisionQueryParams,
  type EvidenceView,
  type SpecControlVerb,
} from "./types";

// --- binding (B-1) ----------------------------------------------------------

export const DEFAULT_API_PORT = 4519;
export const DEFAULT_API_HOST = "127.0.0.1";

// v1 refuses to bind anything but the loopback interface. There is no auth
// layer yet, so the trust boundary is the interface itself; a non-loopback
// bind would silently publish an unauthenticated control API to the network.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `api: refusing to bind "${host}": v1 serves loopback only (${[...LOOPBACK_HOSTS].join(", ")}), and there is no auth layer yet`
    );
  }
}

// --- seams ------------------------------------------------------------------

// The read-only view of a chain. The daemon holds the single writer handle
// for both chains (spec 011 B-2), so the API is handed a view over that same
// live handle rather than opening a second one.
export type JournalView = JournalSource;

export function journalViewFromHandle(handle: JournalHandle): JournalView {
  return { records: () => handle.fold().records };
}

// Exactly spec 021 B-4's control methods, which the Daemon class already
// implements: the API calls them directly rather than reimplementing any
// part of the run loop's own guards. There is deliberately no `start` member
// here; see the note on the /api/run/start handler below.
export interface ControlTarget {
  pause(source: string): void;
  resume(source: string): void;
  skipSpec(specId: string, source: string): void;
  retryStage(specId: string, source: string): void;
  reverify(specId: string, source: string): void;
  forceHumanGate(specId: string, source: string): void;
  approve(specId: string, source: string): void;
}

export interface ApiDeps {
  readonly journal: JournalView;
  readonly decisions: JournalView;
  readonly dagReader: DagReader;
  readonly repoDir: string;
  readonly evidenceDir: string;
  // Absent (or null) makes this a read-only server: control routes answer
  // `unavailable` rather than pretending to have journaled something.
  readonly controls?: ControlTarget | null;
  readonly host?: string;
  readonly port?: number;
  readonly clock?: { now(): number };
  readonly heartbeatMs?: number;
  readonly pumpIntervalMs?: number;
  readonly quotaTickMs?: number;
  readonly eventRingCapacity?: number;
  // The seam B-1 promises: an auth layer slots in front of every route by
  // returning an ApiError, without any response shape changing. v1 wires
  // nothing here (loopback trust).
  readonly authorize?: (request: Request) => ApiError | null;
}

export interface ApiServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  readonly hub: EventHub;
  readonly pump: JournalPump;
  stop(): Promise<void>;
}

// --- envelope helpers (B-2) -------------------------------------------------

const STATUS_FOR_KIND: Readonly<Record<ApiErrorKind, number>> = {
  "bad-request": 400,
  "api-version-mismatch": 400,
  "not-found": 404,
  "method-not-allowed": 405,
  conflict: 409,
  internal: 500,
  unavailable: 503,
  // Client-side only (api-client.ts never reaches the server to produce
  // these); mapped here so the table is total.
  unreachable: 503,
  "malformed-response": 502,
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function ok<T>(data: T): Response {
  const body: ApiResponse<T> = { ok: true, data };
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

function fail(kind: ApiErrorKind, message: string): Response {
  const body: ApiResponse<never> = { ok: false, error: { kind, message } };
  return new Response(JSON.stringify(body), { status: STATUS_FOR_KIND[kind], headers: JSON_HEADERS });
}

// --- request validation -----------------------------------------------------

// apiVersion gating (B-2): a client that declares a version is held to it;
// one that declares nothing is served on the v1 assumption, which is how
// `curl` stays a first-class client of this API.
function versionMismatch(request: Request): Response | null {
  const declared = request.headers.get(API_VERSION_HEADER);
  if (declared === null) return null;
  if (declared.trim() === String(API_VERSION)) return null;
  return fail(
    "api-version-mismatch",
    `client declared ${API_VERSION_HEADER}: ${declared.trim()}, this daemon serves apiVersion ${API_VERSION}`
  );
}

const SPEC_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EVIDENCE_HASH_SHAPE = /^[0-9a-f]{64}$/;

// decodeURIComponent throws on a malformed escape, which belongs to the
// caller's request, not to this server's internals: null here becomes a
// bad-request rather than an internal error.
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// --- controls (B-5) ---------------------------------------------------------

interface ControlOutcome {
  readonly result: ControlResult;
}

function statusOf(records: readonly JournalRecord[]): RunStatus | null {
  return runView(records).run?.status ?? null;
}

// The control record B-5 promises to return is not invented here: the verb
// is executed, the records it appended are diffed out of the journal, and
// the `control.*` record among them is returned verbatim. Nothing is
// journaled by this module itself.
function runControl(
  deps: ApiDeps,
  verb: ControlVerbToken,
  specId: string | null,
  apply: (controls: ControlTarget) => void
): ControlOutcome | ApiError {
  const controls = deps.controls;
  if (!controls) {
    return { kind: "unavailable", message: "no daemon controls are attached to this server (read-only)" };
  }

  const before = deps.journal.records().length;
  try {
    apply(controls);
  } catch (err) {
    return { kind: "conflict", message: (err as Error).message };
  }

  const after = deps.journal.records();
  const appended = after.slice(before);
  const controlRecord = appended.find((r) => r.kind.startsWith("control.")) ?? appended[0] ?? null;

  return {
    result: {
      verb,
      specId,
      applied: true,
      record: controlRecord === null ? null : toApiJournalRecord(controlRecord),
      runStatus: statusOf(after),
    },
  };
}

function noop(verb: ControlVerbToken, specId: string | null, runStatus: RunStatus | null): ControlResult {
  return { verb, specId, applied: false, record: null, runStatus };
}

function controlResponse(outcome: ControlOutcome | ApiError): Response {
  if ("kind" in outcome) return fail(outcome.kind, outcome.message);
  return ok(outcome.result);
}

async function controlSource(request: Request): Promise<string> {
  const header = request.headers.get(CONTROL_SOURCE_HEADER);
  if (header !== null && header.trim().length > 0) return header.trim();
  try {
    const text = await request.text();
    if (text.trim().length === 0) return DEFAULT_CONTROL_SOURCE;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { source?: unknown }).source === "string") {
      const source = (parsed as { source: string }).source.trim();
      if (source.length > 0) return source;
    }
  } catch {
    // A body that is absent or not JSON is not an error: the source is
    // optional metadata, and defaulting it is more useful than refusing.
  }
  return DEFAULT_CONTROL_SOURCE;
}

// /api/run/start. Booting a daemon process is not an HTTP concern: spec 021
// B-2 fixes the boot order (lock, journals, recovery, then the loop and this
// API), so by the time a request can arrive the process is already up, and
// process lifecycle belongs to the CLI (spec 023 B-2's `daemon start`).
// Within a hosted daemon, "start" means "ensure the run is running": a
// paused run resumes, an already-running run is an idempotent no-op (B-5),
// and parked/completed/failed are refused, because those are the quota
// scheduler's and the state machine's to leave, not a control verb's.
function handleRunStart(deps: ApiDeps, source: string): Response {
  const status = statusOf(deps.journal.records());
  if (status === null) {
    return fail("conflict", "no run exists yet; start the daemon process before starting a run");
  }
  if (status === "running") return ok(noop("start", null, status));
  if (status === "paused") {
    return controlResponse(runControl(deps, "start", null, (c) => c.resume(source)));
  }
  return fail("conflict", `a run in status "${status}" cannot be started`);
}

function handleRunPause(deps: ApiDeps, source: string): Response {
  const status = statusOf(deps.journal.records());
  if (status === "paused") return ok(noop("pause", null, status));
  return controlResponse(runControl(deps, "pause", null, (c) => c.pause(source)));
}

function handleRunResume(deps: ApiDeps, source: string): Response {
  const status = statusOf(deps.journal.records());
  if (status === "running") return ok(noop("resume", null, status));
  return controlResponse(runControl(deps, "resume", null, (c) => c.resume(source)));
}

function handleSpecControl(deps: ApiDeps, verb: SpecControlVerb, specId: string, source: string): Response {
  switch (verb) {
    case "skip":
      return controlResponse(runControl(deps, verb, specId, (c) => c.skipSpec(specId, source)));
    case "retry-stage":
      return controlResponse(runControl(deps, verb, specId, (c) => c.retryStage(specId, source)));
    case "reverify":
      return controlResponse(runControl(deps, verb, specId, (c) => c.reverify(specId, source)));
    case "force-human-gate":
      return controlResponse(runControl(deps, verb, specId, (c) => c.forceHumanGate(specId, source)));
    case "approve":
      return controlResponse(runControl(deps, verb, specId, (c) => c.approve(specId, source)));
  }
}

// --- evidence (B-3) ---------------------------------------------------------

interface EvidenceFile {
  readonly path: string;
  readonly mediaType: EvidenceView["mediaType"];
}

function findEvidenceFile(evidenceDir: string, hash: string): EvidenceFile | null {
  const candidates: readonly EvidenceFile[] = [
    { path: join(evidenceDir, `${hash}.txt`), mediaType: "text/plain" },
    { path: join(evidenceDir, `${hash}.png`), mediaType: "image/png" },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) return candidate;
  }
  return null;
}

// Evidence is served in the same envelope as every other read route, so the
// typed client covers it and AC-2's "every read endpoint returns the
// documented envelope" holds without an exception. `?raw=1` additionally
// serves the bytes themselves, which is what an <img src> in the web UI
// (spec 024 B-5) needs; both forms are read-only and content-addressed, so
// neither can serve anything the journal did not name by hash.
function handleEvidence(deps: ApiDeps, hash: string, raw: boolean): Response {
  if (!EVIDENCE_HASH_SHAPE.test(hash)) {
    return fail("bad-request", `"${hash}" is not a content hash (expected 64 lowercase hex characters)`);
  }
  const found = findEvidenceFile(deps.evidenceDir, hash);
  if (found === null) return fail("not-found", `no evidence file for ${hash}`);

  const bytes = fs.readFileSync(found.path);
  if (raw) {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": found.mediaType, "Cache-Control": "no-store" },
    });
  }

  const view: EvidenceView = {
    hash,
    mediaType: found.mediaType,
    bytes: bytes.length,
    text: found.mediaType === "text/plain" ? bytes.toString("utf8") : null,
    base64: found.mediaType === "image/png" ? bytes.toString("base64") : null,
  };
  return ok(view);
}

// --- SSE (B-4) --------------------------------------------------------------

function sseResponse(hub: EventHub, request: Request, heartbeatMs: number, closers: Set<() => void>): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let close: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };

      close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (timer !== null) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      closers.add(close);

      send(SSE_RETRY_LINE);

      const lastEventId = parseLastEventId(request.headers.get("Last-Event-ID"));
      if (lastEventId !== null) {
        const replay = hub.replayFrom(lastEventId);
        if (replay.gap) send(formatReplayGap(lastEventId, replay.events[0]?.id ?? null));
        for (const event of replay.events) send(formatSseEvent(event));
      }

      unsubscribe = hub.subscribe((event) => send(formatSseEvent(event)));
      timer = setInterval(() => send(SSE_HEARTBEAT_LINE), heartbeatMs);
      timer.unref?.();
    },
    cancel() {
      closers.delete(close);
      close();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// --- routing ----------------------------------------------------------------

function decisionQueryFrom(url: URL): DecisionQueryParams {
  const query = url.searchParams.get("query");
  const specId = url.searchParams.get("specId");
  const path = url.searchParams.get("path");
  return {
    ...(query !== null && query.length > 0 ? { query } : {}),
    ...(specId !== null && specId.length > 0 ? { specId } : {}),
    ...(path !== null && path.length > 0 ? { path } : {}),
  };
}

function metaView(deps: ApiDeps): ApiMeta {
  return {
    apiVersion: API_VERSION,
    service: "claude-observatory-orchestrator",
    loopbackOnly: true,
    controlsAvailable: Boolean(deps.controls),
    routes: [
      API_ROUTES.meta,
      API_ROUTES.dag,
      API_ROUTES.run,
      API_ROUTES.quota,
      API_ROUTES.decisions,
      API_ROUTES.history,
      API_ROUTES.events,
      `${API_ROUTES.evidencePrefix}<hash>`,
      API_ROUTES.runStart,
      API_ROUTES.runPause,
      API_ROUTES.runResume,
      ...SPEC_CONTROL_VERBS.map((verb) => `${API_ROUTES.specPrefix}<id>/${verb}`),
    ],
  };
}

async function route(deps: ApiDeps, request: Request, hub: EventHub, closers: Set<() => void>): Promise<Response> {
  const mismatch = versionMismatch(request);
  if (mismatch) return mismatch;

  const denial = deps.authorize?.(request) ?? null;
  if (denial) return fail(denial.kind, denial.message);

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const clock = deps.clock ?? { now: () => Date.now() };

  const requireGet = (): Response | null =>
    method === "GET" || method === "HEAD" ? null : fail("method-not-allowed", `${method} ${path} (expected GET)`);
  const requirePost = (): Response | null =>
    method === "POST" ? null : fail("method-not-allowed", `${method} ${path} (expected POST)`);

  switch (path) {
    case API_ROUTES.meta:
      return requireGet() ?? ok(metaView(deps));
    case API_ROUTES.dag:
      return (
        requireGet() ??
        ok(
          dagView({
            records: deps.journal.records(),
            snapshot: loadRegistrySnapshot(deps.dagReader, deps.repoDir),
            reader: deps.dagReader,
            repoDir: deps.repoDir,
          })
        )
      );
    case API_ROUTES.run:
      return requireGet() ?? ok(runView(deps.journal.records()));
    case API_ROUTES.quota:
      return requireGet() ?? ok(quotaView(deps.journal.records(), clock.now()));
    case API_ROUTES.decisions:
      return requireGet() ?? ok(decisionsView(deps.decisions.records(), decisionQueryFrom(url)));
    case API_ROUTES.history:
      return requireGet() ?? ok(historyView(deps.journal.records()));
    case API_ROUTES.events:
      return requireGet() ?? sseResponse(hub, request, deps.heartbeatMs ?? SSE_HEARTBEAT_MS, closers);
    case API_ROUTES.runStart:
      return requirePost() ?? handleRunStart(deps, await controlSource(request));
    case API_ROUTES.runPause:
      return requirePost() ?? handleRunPause(deps, await controlSource(request));
    case API_ROUTES.runResume:
      return requirePost() ?? handleRunResume(deps, await controlSource(request));
    default:
      break;
  }

  if (path.startsWith(API_ROUTES.evidencePrefix)) {
    const guard = requireGet();
    if (guard) return guard;
    const hash = safeDecode(path.slice(API_ROUTES.evidencePrefix.length));
    if (hash === null) return fail("bad-request", `${path} is not a decodable evidence path`);
    return handleEvidence(deps, hash, url.searchParams.get("raw") === "1");
  }

  if (path.startsWith(API_ROUTES.specPrefix)) {
    const guard = requirePost();
    if (guard) return guard;
    const parts = path
      .slice(API_ROUTES.specPrefix.length)
      .split("/")
      .filter((p) => p.length > 0);
    if (parts.length !== 2) {
      return fail("bad-request", `expected ${API_ROUTES.specPrefix}<id>/<verb>, got ${path}`);
    }
    const specId = safeDecode(parts[0]!);
    const verb = parts[1]!;
    if (specId === null) return fail("bad-request", `${path} is not a decodable spec control path`);
    if (!SPEC_ID_SHAPE.test(specId)) return fail("bad-request", `"${specId}" is not a valid spec id`);
    if (!(SPEC_CONTROL_VERBS as readonly string[]).includes(verb)) {
      return fail("not-found", `unknown spec control verb "${verb}" (expected one of ${SPEC_CONTROL_VERBS.join(", ")})`);
    }
    return handleSpecControl(deps, verb as SpecControlVerb, specId, await controlSource(request));
  }

  return fail("not-found", `no route for ${method} ${path}`);
}

// --- the server -------------------------------------------------------------

// An IPv6 literal needs brackets in an authority component; "127.0.0.1" and
// "localhost" pass through untouched.
function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function createApiServer(deps: ApiDeps): ApiServer {
  const host = deps.host ?? DEFAULT_API_HOST;
  assertLoopbackHost(host);

  const hub = new EventHub(deps.eventRingCapacity);
  const clock = deps.clock ?? { now: () => Date.now() };
  const pump = startJournalPump({
    hub,
    journal: deps.journal,
    clock,
    ...(deps.pumpIntervalMs !== undefined ? { intervalMs: deps.pumpIntervalMs } : {}),
    ...(deps.quotaTickMs !== undefined ? { quotaTickMs: deps.quotaTickMs } : {}),
  });

  const closers = new Set<() => void>();

  const server = Bun.serve({
    hostname: host,
    port: deps.port ?? DEFAULT_API_PORT,
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(deps, request, hub, closers);
      } catch (err) {
        // Every unexpected throw still leaves through the one envelope, so a
        // client never has to parse an HTML error page or a bare stack.
        return fail("internal", (err as Error).message);
      }
    },
  });

  // Bun reports these as optional (a unix-socket server has neither); a TCP
  // bind always fills them in, and the requested values are the honest
  // fallback rather than a fabricated default.
  const hostname = server.hostname ?? host;
  const port = server.port ?? deps.port ?? DEFAULT_API_PORT;

  return {
    hostname,
    port,
    url: `http://${formatHostForUrl(hostname)}:${port}`,
    hub,
    pump,
    async stop(): Promise<void> {
      pump.stop();
      for (const close of [...closers]) close();
      closers.clear();
      await server.stop(true);
    },
  };
}
