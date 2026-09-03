// The daemon's only interface (specs 022 and 027): a loopback-bound
// Bun.serve router over the read models in state.ts, the control verbs spec
// 021 B-4 exposes, the project registry spec 025 journals, and the SSE stream
// in events.ts.
//
// Three disciplines shape everything below. First, every JSON answer travels
// in one envelope (022 B-2), so a client branches on `ok` and a stable `kind`
// token, never on an HTTP status alone. Second, every read is a fold of a
// journal performed during the request (022 B-6): this module holds no state
// that could disagree with a journal, because it holds no state at all beyond
// the event ring, which is itself a projection of appended records. Third,
// scope is explicit (027 B-1): one daemon answers for many projects, so every
// project-scoped fact lives under `/api/projects/<name>/` and says which
// project it is about, and the facts that are global stay global.
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JournalRecord, JsonValue } from "../journal";
import type { DagReader } from "../dag";
import { createProcessSpecFileAtShaReader, loadRegistrySnapshot } from "../dag";
import type { RunStatus } from "../state";
import type { Project, ProjectSource, ProjectsSnapshot } from "../projects";
import { isValidProjectName } from "../projects";
import type { ExecutionProfile } from "../profile";
import { parseProfile, profileRefusal } from "../profile";
import type { GateContract } from "../gate-contract";
import { gateRefusal } from "../gate-contract";
import type { CostCeiling } from "../budget";
import { ceilingRefusal, parseCeiling } from "../budget";
import {
  EventHub,
  SSE_HEADERS,
  SSE_HEARTBEAT_LINE,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_LINE,
  formatReplayGap,
  formatSseEvent,
  matchesProjectFilter,
  parseLastEventId,
  startJournalPump,
  type JournalPump,
  type JournalSource,
  type PumpSource,
} from "./events";
import {
  dagView,
  decisionsView,
  historyView,
  projectsView,
  quotaView,
  runView,
  servedEconomicsView,
  type ProjectQuotaInput,
  type ProjectRowInput,
} from "./state";
import { ECONOMICS_ROUTE } from "../economics";
import { createStaticHandler, defaultWebDistDir, type StaticHandler } from "./static";
import {
  API_ROUTES,
  API_VERSION,
  API_VERSION_HEADER,
  CONTROL_SOURCE_HEADER,
  DEFAULT_CONTROL_SOURCE,
  EVENTS_PROJECT_PARAM,
  PROJECT_CONTROL_VERBS,
  PROJECT_ROUTES,
  SPEC_CONTROL_VERBS,
  projectRoute,
  toApiJournalRecord,
  type ApiError,
  type ApiErrorKind,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type ControlVerbToken,
  type DaemonMetaView,
  type DaemonState,
  type DecisionQueryParams,
  type EvidenceView,
  type ProjectControlResult,
  type ProjectControlVerb,
  type ProjectView,
  type SpecControlVerb,
} from "./types";

// --- binding (022 B-1) ------------------------------------------------------

export const DEFAULT_API_PORT = 4519;
export const DEFAULT_API_HOST = "127.0.0.1";

// The daemon refuses to bind anything but the loopback interface. There is no
// auth layer yet, so the trust boundary is the interface itself; a
// non-loopback bind would silently publish an unauthenticated control API to
// the network. 027 section 6 leaves that unchanged.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `api: refusing to bind "${host}": this daemon serves loopback only (${[...LOOPBACK_HOSTS].join(", ")}), and there is no auth layer yet`
    );
  }
}

// --- seams ------------------------------------------------------------------

// The read-only view of a chain. The daemon holds the single writer handle
// for every chain (spec 011 B-2), so the API is handed a view over that same
// live handle rather than opening a second one.
export type JournalView = JournalSource;

export function journalViewFromHandle(handle: JournalHandle): JournalView {
  return { records: () => handle.fold().records };
}

// Exactly spec 021 B-4's control methods, which the Daemon class already
// implements: the API calls them directly rather than reimplementing any
// part of the run loop's own guards. There is deliberately no `start` member
// here; see the note on the run/start handler below.
export interface ControlTarget {
  pause(source: string): void;
  resume(source: string): void;
  skipSpec(specId: string, source: string): void;
  retryStage(specId: string, source: string): void;
  reverify(specId: string, source: string): void;
  forceHumanGate(specId: string, source: string): void;
  approve(specId: string, source: string): void;
}

// Everything the API reads or drives for one registered project. Its journals
// live inside the target (010 D13), so these are all resolved from the
// registry's `repoDir` rather than from anything this server knows by itself.
export interface ProjectApi {
  readonly journal: JournalView;
  readonly decisions: JournalView;
  readonly dagReader: DagReader;
  readonly repoDir: string;
  readonly evidenceDir: string;
  // Absent (or null) makes this project read-only: its control routes answer
  // `unavailable` rather than pretending to have journaled something. That is
  // the honest answer for a project with no live run to control.
  readonly controls?: ControlTarget | null;
  // 027 D-3: the reverify route's escape hatch when `controls` is null: wake
  // a daemon for this project (composition: the scheduler's openForControl)
  // so the requalification control has a loop to land in. Absent or a null
  // answer keeps the honest `unavailable`.
  readonly wakeControls?: () => Promise<ControlTarget | null>;
}

// The project registry (spec 025) as this API sees it: a fold per request
// (B-6), a read-only view of the chain for the D-2 record diff, per-project
// resources, and the five mutations 027 B-2 exposes. The daemon holds the
// chain's one writer handle, so every mutation here goes through it.
export interface ProjectsTarget {
  readonly chain: JournalView;
  projects(): ProjectsSnapshot;
  // Throws when the project's state root cannot be resolved; the route
  // reports that rather than serving an empty success.
  resourcesFor(project: Project): ProjectApi;
  register(path: string, name: string | undefined, profile: ExecutionProfile | undefined, source: ProjectSource): void;
  setArmed(name: string, armed: boolean, source: ProjectSource): void;
  // 032 B-2: the second consent, as its own journaled mutation. Arming says
  // this project may be driven; this says what a drive is allowed to do.
  setProfile(name: string, profile: ExecutionProfile, source: ProjectSource): void;
  // 033 B-1: the spend limits this project is driven under. null clears them,
  // which is a journaled decision rather than an absence.
  setCeiling(name: string, ceiling: CostCeiling | null, source: ProjectSource): void;
  // 041 B-7: the command list this project's stages are judged by after the
  // universal governance floor. An empty list is the explicit governance-only
  // contract, not an absent request.
  setGate(name: string, gate: GateContract, source: ProjectSource): void;
  requalify(name: string, source: ProjectSource): void;
  remove(name: string, source: ProjectSource): void;
}

// Spec 025 models a registry record's `source` as one of three control
// surfaces, while spec 022's `X-Control-Source` is a free-form string an
// operator can put anything in. The registry chain gets the surface, which is
// what 025 B-2 asked it to record; the free-form value keeps its detail on
// the work-journal control records, where 022 D-2 put it.
export function projectSourceOf(controlSource: string): ProjectSource {
  const value = controlSource.trim().toLowerCase();
  if (value === "cli" || value.startsWith("cli:")) return "cli";
  if (value === "ui" || value.startsWith("ui:") || value.startsWith("web")) return "ui";
  return "api";
}

// Spec 026's own state, for `/api/meta` (027 B-4). Structurally satisfied by
// `StandbyDaemon.snapshot`, so the daemon hands its scheduler over without an
// adapter.
export interface DaemonStatus {
  readonly state: "starting" | "scheduling" | "standby" | "stopped";
  readonly activeProject: string | null;
  readonly scanIntervalMs: number;
  readonly lastScanMs: number | null;
}

export interface DaemonStatusSource {
  status(): DaemonStatus;
}

export interface ApiDeps {
  readonly projects: ProjectsTarget;
  // Absent (or null) means no scheduler is attached: `/api/meta` reports a
  // null daemon rather than inventing a state for one that is not there.
  readonly daemon?: DaemonStatusSource | null;
  // Whether this server accepts control requests at all (022 B-2's read-only
  // stance). `false` makes every control route, registry and scoped alike,
  // answer `unavailable` rather than pretending to have journaled something;
  // it is a property of the server, not of any one project. A project with no
  // live run to drive is refused separately, by `runControl`, because that is
  // a different fact.
  readonly controlsAvailable?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly clock?: { now(): number };
  readonly heartbeatMs?: number;
  readonly pumpIntervalMs?: number;
  readonly quotaTickMs?: number;
  readonly eventRingCapacity?: number;
  // The built web UI (spec 024 B-1), served same-origin by this same server:
  // no second port, no CORS, one thing to trust. Omitted resolves the
  // checkout's own `web/dist`; `null` disables static serving entirely,
  // leaving a pure-API daemon. Nothing under `/api` is ever served from disk.
  readonly staticDir?: string | null;
  // The seam 022 B-1 promises: an auth layer slots in front of every route by
  // returning an ApiError, without any response shape changing. Nothing is
  // wired here (loopback trust).
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

// --- envelope helpers (022 B-2) ---------------------------------------------

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

// apiVersion gating (027 B-1): a client that declares a version is held to
// it, so a v1 client fails loudly instead of receiving shapes it cannot
// parse; one that declares nothing is served on the v2 assumption, which is
// how `curl` stays a first-class client of this API.
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

// The request body, read once. A control's `source` and a registration's
// `path`/`name` both live here, so a handler that needs both cannot consume
// the stream twice. A body that is absent or not JSON is not an error: the
// fields it would carry are all optional or checked by their own handler.
type JsonBody = Readonly<Record<string, JsonValue>>;

async function readJsonBody(request: Request): Promise<JsonBody | null> {
  try {
    const text = await request.text();
    if (text.trim().length === 0) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as JsonBody;
  } catch {
    // not JSON, or no body at all
  }
  return null;
}

function controlSourceFrom(request: Request, body: JsonBody | null): string {
  const header = request.headers.get(CONTROL_SOURCE_HEADER);
  if (header !== null && header.trim().length > 0) return header.trim();
  const fromBody = body?.source;
  if (typeof fromBody === "string" && fromBody.trim().length > 0) return fromBody.trim();
  return DEFAULT_CONTROL_SOURCE;
}

function stringFromBody(body: JsonBody | null, field: string): string | null {
  const value = body?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// --- the registry (B-2) -----------------------------------------------------

// A registered project plus the resources its scoped routes read. Resolved
// once per request, so every route below folds the same registry the request
// was answered against.
interface Scoped {
  readonly name: string;
  readonly project: Project;
  readonly api: ProjectApi;
}

function projectRows(deps: ApiDeps): ProjectRowInput[] {
  const rows: ProjectRowInput[] = [];
  for (const project of deps.projects.projects().values()) {
    rows.push({
      project,
      records: () => deps.projects.resourcesFor(project).journal.records(),
    });
  }
  return rows;
}

function projectViewOf(deps: ApiDeps, name: string, nowMs: number): ProjectView | null {
  return projectsView(projectRows(deps), nowMs).projects.find((p) => p.name === name) ?? null;
}

// Every project's work journal, for the global quota fold. A project whose
// state root cannot be read contributes nothing rather than failing the
// account-wide answer; its own row in `/api/projects` reports the failure.
function quotaInputs(deps: ApiDeps): ProjectQuotaInput[] {
  const inputs: ProjectQuotaInput[] = [];
  for (const project of deps.projects.projects().values()) {
    try {
      inputs.push({ project: project.name, records: deps.projects.resourcesFor(project).journal.records() });
    } catch {
      // reported by /api/projects as that project's readError
    }
  }
  return inputs;
}

// --- controls (022 B-5, 027 B-5) --------------------------------------------

interface ControlOutcome {
  readonly result: ControlResult;
}

function statusOf(records: readonly JournalRecord[], project: string): RunStatus | null {
  return runView(records, project).run?.status ?? null;
}

// The control record 022 B-5 promises to return is not invented here: the
// verb is executed, the records it appended are diffed out of that project's
// journal, and the `control.*` record among them is returned verbatim.
// Nothing is journaled by this module itself.
function runControl(
  scoped: Scoped,
  verb: ControlVerbToken,
  specId: string | null,
  apply: (controls: ControlTarget) => void
): ControlOutcome | ApiError {
  const controls = scoped.api.controls;
  if (!controls) {
    return {
      kind: "unavailable",
      message: `no daemon controls are attached to project "${scoped.name}" (read-only)`,
    };
  }
  return applyControl(scoped, controls, verb, specId, apply);
}

// 027 D-3: reverify alone may wake a daemon to receive it. Requalification
// (021 D-18) is the one control whose whole point is a project nothing is
// driving, so refusing it there would leave an invalidated prior-run spec
// permanently unrecoverable over the API. Every other verb still answers
// `unavailable` honestly: there is no live run for it to act on.
async function runControlWaking(
  scoped: Scoped,
  verb: ControlVerbToken,
  specId: string | null,
  apply: (controls: ControlTarget) => void
): Promise<ControlOutcome | ApiError> {
  let controls = scoped.api.controls ?? null;
  if (!controls && scoped.api.wakeControls) {
    controls = await scoped.api.wakeControls();
  }
  if (!controls) {
    return {
      kind: "unavailable",
      message: `no daemon controls are attached to project "${scoped.name}" and none could be woken (read-only)`,
    };
  }
  return applyControl(scoped, controls, verb, specId, apply);
}

function applyControl(
  scoped: Scoped,
  controls: ControlTarget,
  verb: ControlVerbToken,
  specId: string | null,
  apply: (controls: ControlTarget) => void
): ControlOutcome | ApiError {
  const journal = scoped.api.journal;
  const before = journal.records().length;
  try {
    apply(controls);
  } catch (err) {
    return { kind: "conflict", message: (err as Error).message };
  }

  const after = journal.records();
  const appended = after.slice(before);
  const controlRecord = appended.find((r) => r.kind.startsWith("control.")) ?? appended[0] ?? null;

  return {
    result: {
      project: scoped.name,
      verb,
      specId,
      applied: true,
      record: controlRecord === null ? null : toApiJournalRecord(controlRecord),
      runStatus: statusOf(after, scoped.name),
    },
  };
}

function noop(project: string, verb: ControlVerbToken, specId: string | null, runStatus: RunStatus | null): ControlResult {
  return { project, verb, specId, applied: false, record: null, runStatus };
}

function controlResponse(outcome: ControlOutcome | ApiError): Response {
  if ("kind" in outcome) return fail(outcome.kind, outcome.message);
  return ok(outcome.result);
}

// run/start. Booting a daemon process is not an HTTP concern (022 D-1): spec
// 021 B-2 fixes the boot order (lock, journals, recovery, then the loop and
// this API), so by the time a request can arrive the process is already up,
// and process lifecycle belongs to the CLI (spec 023 B-2's `daemon start`).
// Within a hosted daemon, "start" means "ensure this project's run is
// running": a paused run resumes, an already-running run is an idempotent
// no-op, and parked/completed/failed are refused, because those are the quota
// scheduler's and the state machine's to leave, not a control verb's.
function handleRunStart(scoped: Scoped, source: string): Response {
  const status = statusOf(scoped.api.journal.records(), scoped.name);
  if (status === null) {
    return fail("conflict", `project "${scoped.name}" has no run yet; the scheduler creates one when it takes the flight slot`);
  }
  if (status === "running") return ok(noop(scoped.name, "start", null, status));
  if (status === "paused") {
    return controlResponse(runControl(scoped, "start", null, (c) => c.resume(source)));
  }
  return fail("conflict", `a run in status "${status}" cannot be started`);
}

function handleRunPause(scoped: Scoped, source: string): Response {
  const status = statusOf(scoped.api.journal.records(), scoped.name);
  if (status === "paused") return ok(noop(scoped.name, "pause", null, status));
  return controlResponse(runControl(scoped, "pause", null, (c) => c.pause(source)));
}

function handleRunResume(scoped: Scoped, source: string): Response {
  const status = statusOf(scoped.api.journal.records(), scoped.name);
  if (status === "running") return ok(noop(scoped.name, "resume", null, status));
  return controlResponse(runControl(scoped, "resume", null, (c) => c.resume(source)));
}

async function handleSpecControl(scoped: Scoped, verb: SpecControlVerb, specId: string, source: string): Promise<Response> {
  switch (verb) {
    case "skip":
      return controlResponse(runControl(scoped, verb, specId, (c) => c.skipSpec(specId, source)));
    case "retry-stage":
      return controlResponse(runControl(scoped, verb, specId, (c) => c.retryStage(specId, source)));
    case "reverify":
      return controlResponse(await runControlWaking(scoped, verb, specId, (c) => c.reverify(specId, source)));
    case "force-human-gate":
      return controlResponse(runControl(scoped, verb, specId, (c) => c.forceHumanGate(specId, source)));
    case "approve":
      return controlResponse(runControl(scoped, verb, specId, (c) => c.approve(specId, source)));
  }
}

// --- registry controls (B-2) ------------------------------------------------

// 022 D-2's pattern, applied to the projects chain: snapshot the chain, run
// the mutation spec 025 defines, and return the record it appended verbatim.
// The API appends nothing to any chain itself, and a mutation the registry
// refuses (an unknown name, a duplicate repoDir, an underivable name) is a
// conflict carrying that refusal's own words.
function runRegistryControl(
  deps: ApiDeps,
  verb: ProjectControlVerb,
  name: string | null,
  nowMs: number,
  apply: () => void
): Response {
  const chain = deps.projects.chain;
  const before = chain.records().length;
  try {
    apply();
  } catch (err) {
    return fail("conflict", (err as Error).message);
  }

  const appended = chain.records().slice(before);
  const record = appended.find((r) => r.kind.startsWith("project.")) ?? appended[0] ?? null;

  // A registration derives its own name when the caller did not pass one
  // (025 D-1), so the answer reads it back off the record rather than
  // guessing what the chain decided.
  const payload = record?.payload;
  const journaledName =
    typeof payload === "object" && payload !== null && !Array.isArray(payload) && typeof payload.name === "string"
      ? payload.name
      : null;
  const project = journaledName ?? name;

  const result: ProjectControlResult = {
    verb,
    project,
    applied: record !== null,
    record: record === null ? null : toApiJournalRecord(record),
    snapshot: project === null ? null : projectViewOf(deps, project, nowMs),
  };
  return ok(result);
}

// A profile from a request body: absent is absent (the caller said nothing
// about posture), malformed or unrecordable is a refusal with the reason,
// never a quietly substituted default. 032 B-2 makes posture a chosen,
// journaled fact; guessing one here would put a guess in the chain.
function profileFromBody(body: JsonBody | null, field: string): ExecutionProfile | Response | null {
  const value = body?.[field];
  if (value === undefined || value === null) return null;
  let profile: ExecutionProfile;
  try {
    profile = parseProfile(value, `"${field}"`);
  } catch (err) {
    return fail("bad-request", (err as Error).message);
  }
  const refusal = profileRefusal(profile);
  return refusal === null ? profile : fail("bad-request", refusal);
}

// A ceiling from a request body, on the same discipline profileFromBody
// applies (033 B-1): an explicit null clears, a malformed or unrecordable one
// is a refusal carrying the reason, and nothing is ever quietly substituted.
// `undefined` (the field absent entirely) is distinguished from `null` by the
// caller, since "say nothing" and "clear it" are different requests.
function ceilingFromBody(body: JsonBody | null, field: string): CostCeiling | null | Response {
  const value = body?.[field];
  if (value === null) return null;
  let ceiling: CostCeiling | null;
  try {
    ceiling = parseCeiling(value, `"${field}"`);
  } catch (err) {
    return fail("bad-request", (err as Error).message);
  }
  const refusal = ceilingRefusal(ceiling);
  return refusal === null ? ceiling : fail("bad-request", refusal);
}

// A gate contract's command list from a request body, on the same discipline
// profileFromBody uses: absent is absent, malformed is a refusal naming what
// was wrong, and an unrunnable command is refused before anything is
// appended. An empty array is a legal contract and is not treated as absent.
function gateCommandsFromBody(
  body: JsonBody | null,
  field: string
): readonly (readonly string[])[] | Response | null {
  const value = body === null ? undefined : body[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return fail("bad-request", `"${field}" expected an array of argv arrays`);
  const commands: string[][] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === "string")) {
      return fail("bad-request", `"${field}" expected an array of argv arrays of strings`);
    }
    commands.push(raw as string[]);
  }
  const refusal = gateRefusal({ commands, source: "api", rule: null });
  return refusal === null ? commands : fail("bad-request", refusal);
}

function handleRegister(deps: ApiDeps, body: JsonBody | null, source: string, nowMs: number): Response {
  const path = stringFromBody(body, "path");
  if (path === null) {
    return fail("bad-request", `POST ${API_ROUTES.projects} expects a JSON body with a "path" string`);
  }
  const name = stringFromBody(body, "name");
  if (name !== null && !isValidProjectName(name)) {
    return fail("bad-request", `"${name}" is not a valid project name (lowercase slug, [a-z0-9][a-z0-9-]*)`);
  }
  const profile = profileFromBody(body, "profile");
  if (isResponse(profile)) return profile;
  return runRegistryControl(deps, "register", name, nowMs, () =>
    deps.projects.register(path, name ?? undefined, profile ?? undefined, projectSourceOf(source))
  );
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
// neither can serve anything the journal did not name by hash, and both are
// resolved inside the named project's own evidence directory.
function handleEvidence(scoped: Scoped, hash: string, raw: boolean): Response {
  if (!EVIDENCE_HASH_SHAPE.test(hash)) {
    return fail("bad-request", `"${hash}" is not a content hash (expected 64 lowercase hex characters)`);
  }
  const found = findEvidenceFile(scoped.api.evidenceDir, hash);
  if (found === null) return fail("not-found", `no evidence file for ${hash} in project "${scoped.name}"`);

  const bytes = fs.readFileSync(found.path);
  if (raw) {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": found.mediaType, "Cache-Control": "no-store" },
    });
  }

  const view: EvidenceView = {
    project: scoped.name,
    hash,
    mediaType: found.mediaType,
    bytes: bytes.length,
    text: found.mediaType === "text/plain" ? bytes.toString("utf8") : null,
    base64: found.mediaType === "image/png" ? bytes.toString("base64") : null,
  };
  return ok(view);
}

// --- SSE (B-4) --------------------------------------------------------------

function sseResponse(
  hub: EventHub,
  request: Request,
  projectFilter: string | null,
  heartbeatMs: number,
  closers: Set<() => void>
): Response {
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
        const replay = hub.replayFrom(lastEventId, projectFilter);
        if (replay.gap) send(formatReplayGap(lastEventId, replay.events[0]?.id ?? null));
        for (const event of replay.events) send(formatSseEvent(event));
      }

      unsubscribe = hub.subscribe((event) => {
        if (!matchesProjectFilter(event, projectFilter)) return;
        send(formatSseEvent(event));
      });
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

// Every registry control route, by its path suffix. One table so a verb
// cannot be routed without also being named in the meta route list.
const REGISTRY_VERB_FOR_ROUTE: Readonly<Record<string, ProjectControlVerb | undefined>> = {
  [PROJECT_ROUTES.arm]: "arm",
  [PROJECT_ROUTES.disarm]: "disarm",
  [PROJECT_ROUTES.requalify]: "requalify",
  [PROJECT_ROUTES.remove]: "remove",
  [PROJECT_ROUTES.profile]: "profile",
  [PROJECT_ROUTES.ceiling]: "ceiling",
  [PROJECT_ROUTES.gate]: "gate",
};

// A fresh Response every time: a body can only be consumed once, so a shared
// constant would serve an empty envelope to the second caller.
function readOnlyRefusal(): Response {
  return fail("unavailable", "this server is read-only; no daemon controls are attached");
}

// 026's four scheduler states, plus the one fact the scheduler does not carry
// itself: whether the flight-slot holder is parked on quota. "driving" and
// "parked" are both a held slot, and an operator who cannot tell them apart
// cannot tell progress from a countdown.
function daemonStateOf(status: DaemonStatus, parked: boolean): DaemonState {
  if (status.state === "starting") return "starting";
  if (status.state === "stopped") return "stopped";
  if (status.activeProject === null) return "standby";
  return parked ? "parked" : "driving";
}

function daemonMeta(deps: ApiDeps, parked: boolean): DaemonMetaView | null {
  const source = deps.daemon;
  if (!source) return null;
  const status = source.status();
  return {
    state: daemonStateOf(status, parked),
    activeProject: status.activeProject,
    scanIntervalMs: status.scanIntervalMs,
    lastScanMs: status.lastScanMs,
  };
}

const NAMED = "<name>";

function controlsAllowed(deps: ApiDeps): boolean {
  return deps.controlsAvailable ?? true;
}

function metaView(deps: ApiDeps, nowMs: number): ApiMeta {
  const registry = deps.projects.projects();
  // Only folded when there is a daemon to describe: `parked` exists here to
  // tell a held flight slot apart from a countdown, and nothing else on this
  // route needs every project's journal read.
  const parked = deps.daemon ? quotaView(quotaInputs(deps), nowMs).parked : false;

  return {
    apiVersion: API_VERSION,
    service: "claude-observatory-orchestrator",
    loopbackOnly: true,
    controlsAvailable: controlsAllowed(deps),
    daemon: daemonMeta(deps, parked),
    projectCount: registry.size,
    routes: [
      API_ROUTES.meta,
      API_ROUTES.quota,
      API_ROUTES.events,
      API_ROUTES.projects,
      projectRoute(NAMED, PROJECT_ROUTES.dag),
      projectRoute(NAMED, PROJECT_ROUTES.run),
      projectRoute(NAMED, PROJECT_ROUTES.decisions),
      projectRoute(NAMED, PROJECT_ROUTES.history),
      projectRoute(NAMED, ECONOMICS_ROUTE),
      projectRoute(NAMED, `${PROJECT_ROUTES.evidencePrefix}<hash>`),
      ...PROJECT_CONTROL_VERBS.filter((verb) => verb !== "register").map((verb) => projectRoute(NAMED, verb)),
      projectRoute(NAMED, PROJECT_ROUTES.runStart),
      projectRoute(NAMED, PROJECT_ROUTES.runPause),
      projectRoute(NAMED, PROJECT_ROUTES.runResume),
      ...SPEC_CONTROL_VERBS.map((verb) => projectRoute(NAMED, `${PROJECT_ROUTES.specPrefix}<id>/${verb}`)),
    ],
  };
}

// Resolves `<name>` against the folded registry. B-5: an unknown project name
// answers not-found, never an empty success, because "no such project" and
// "that project has nothing" are different facts.
function scopeTo(deps: ApiDeps, name: string): Scoped | Response {
  if (!isValidProjectName(name)) {
    return fail("bad-request", `"${name}" is not a valid project name (lowercase slug, [a-z0-9][a-z0-9-]*)`);
  }
  const project = deps.projects.projects().get(name);
  if (project === undefined) return fail("not-found", `no registered project named "${name}"`);
  let api: ProjectApi;
  try {
    api = deps.projects.resourcesFor(project);
  } catch (err) {
    return fail("unavailable", `project "${name}" is registered but its state root cannot be served: ${(err as Error).message}`);
  }
  return { name, project, api };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function routeProject(
  deps: ApiDeps,
  request: Request,
  url: URL,
  method: string,
  segments: readonly string[],
  clock: { now(): number }
): Promise<Response> {
  const path = url.pathname;
  const name = segments[0];
  if (name === undefined) {
    return fail("not-found", `no route for ${method} ${path} (the collection is ${API_ROUTES.projects})`);
  }

  const suffix = segments.slice(1).join("/");
  if (suffix.length === 0) {
    return fail("not-found", `no route for ${method} ${path} (expected ${projectRoute(NAMED, "<route>")})`);
  }

  const requireGet = (): Response | null =>
    method === "GET" || method === "HEAD" ? null : fail("method-not-allowed", `${method} ${path} (expected GET)`);
  const requirePost = (): Response | null =>
    method === "POST" ? null : fail("method-not-allowed", `${method} ${path} (expected POST)`);
  const requireControls = (): Response | null => (controlsAllowed(deps) ? null : readOnlyRefusal());

  // Registry controls address the chain, not the project's own journals, so
  // they are dispatched before the state root is resolved: disarming or
  // removing a project whose checkout has gone missing must still work.
  const registryVerb = REGISTRY_VERB_FOR_ROUTE[suffix];
  if (registryVerb !== undefined) {
    const guard = requirePost() ?? requireControls();
    if (guard) return guard;
    if (!isValidProjectName(name)) return fail("bad-request", `"${name}" is not a valid project name`);
    if (!deps.projects.projects().has(name)) return fail("not-found", `no registered project named "${name}"`);
    const body = await readJsonBody(request);
    const source = projectSourceOf(controlSourceFrom(request, body));
    // The one registry verb that carries state of its own (032 B-2): the
    // whole profile, refused before anything is appended when it is not a
    // posture this daemon can honor.
    if (registryVerb === "profile") {
      const profile = profileFromBody(body, "profile");
      if (isResponse(profile)) return profile;
      if (profile === null) {
        return fail(
          "bad-request",
          `POST ${path} expects a JSON body with a "profile" object ({mode, allowedTools?, disallowedTools?})`
        );
      }
      return runRegistryControl(deps, registryVerb, name, clock.now(), () =>
        deps.projects.setProfile(name, profile, source)
      );
    }
    // 033 B-1: the second registry verb that carries state of its own. An
    // explicit `"ceiling": null` clears the limits; omitting the field
    // entirely is a request that says nothing, which is refused rather than
    // read as either one.
    if (registryVerb === "ceiling") {
      if (body === null || !Object.hasOwn(body, "ceiling")) {
        return fail(
          "bad-request",
          `POST ${path} expects a JSON body with a "ceiling" object ({perRunMicroUsd?, perDayMicroUsd?}) or null to clear it`
        );
      }
      const ceiling = ceilingFromBody(body, "ceiling");
      if (isResponse(ceiling)) return ceiling;
      return runRegistryControl(deps, registryVerb, name, clock.now(), () =>
        deps.projects.setCeiling(name, ceiling, source)
      );
    }
    // 041 B-7: the third registry verb that carries state of its own. An
    // explicit empty list is the governance-only contract; omitting the field
    // entirely is a request that says nothing, which is refused rather than
    // read as either one.
    if (registryVerb === "gate") {
      if (body === null || !Object.hasOwn(body, "commands")) {
        return fail(
          "bad-request",
          `POST ${path} expects a JSON body with a "commands" array of argv arrays ([] for governance-only)`
        );
      }
      const commands = gateCommandsFromBody(body, "commands");
      if (isResponse(commands)) return commands;
      // Never null: the Object.hasOwn check above already refused an absent
      // field, and an explicit null is not a list.
      if (commands === null) return fail("bad-request", `POST ${path} expects "commands" to be an array, not null`);
      // An operator-set contract answers to no probe rule, so its rule is
      // null: the record says who asked, and nothing pretends a table did.
      const gate: GateContract = { commands, source, rule: null };
      return runRegistryControl(deps, registryVerb, name, clock.now(), () => deps.projects.setGate(name, gate, source));
    }
    return runRegistryControl(deps, registryVerb, name, clock.now(), () => {
      switch (registryVerb) {
        case "arm":
          return deps.projects.setArmed(name, true, source);
        case "disarm":
          return deps.projects.setArmed(name, false, source);
        case "requalify":
          return deps.projects.requalify(name, source);
        default:
          return deps.projects.remove(name, source);
      }
    });
  }

  const scoped = scopeTo(deps, name);
  if (isResponse(scoped)) return scoped;

  switch (suffix) {
    case PROJECT_ROUTES.dag:
      return (
        requireGet() ??
        ok(
          dagView({
            project: scoped.name,
            records: scoped.api.journal.records(),
            snapshot: loadRegistrySnapshot(scoped.api.dagReader, scoped.api.repoDir),
            reader: scoped.api.dagReader,
            repoDir: scoped.api.repoDir,
            // 021 D-16: without this read the view pins pipeline-shipped
            // specs at their pre-flip exec pins and renders a drift the
            // scheduler has already resolved.
            readSpecFileAtSha: createProcessSpecFileAtShaReader(scoped.api.repoDir),
          })
        )
      );
    case PROJECT_ROUTES.run:
      return requireGet() ?? ok(runView(scoped.api.journal.records(), scoped.name));
    case PROJECT_ROUTES.decisions:
      return requireGet() ?? ok(decisionsView(scoped.api.decisions.records(), decisionQueryFrom(url), scoped.name));
    case PROJECT_ROUTES.history:
      return requireGet() ?? ok(historyView(scoped.api.journal.records(), scoped.name));
    case ECONOMICS_ROUTE:
      // Spec 030 B-3: the economics rollup, recomputed from records on every
      // request exactly like the views above; generatedAt is this daemon's
      // clock at response time (030 FR-002).
      return requireGet() ?? ok(servedEconomicsView(scoped.api.journal.records(), scoped.name, clock.now()));
    case PROJECT_ROUTES.runStart:
      return (
        requirePost() ?? requireControls() ?? handleRunStart(scoped, controlSourceFrom(request, await readJsonBody(request)))
      );
    case PROJECT_ROUTES.runPause:
      return (
        requirePost() ?? requireControls() ?? handleRunPause(scoped, controlSourceFrom(request, await readJsonBody(request)))
      );
    case PROJECT_ROUTES.runResume:
      return (
        requirePost() ?? requireControls() ?? handleRunResume(scoped, controlSourceFrom(request, await readJsonBody(request)))
      );
    default:
      break;
  }

  if (suffix.startsWith(PROJECT_ROUTES.evidencePrefix)) {
    const guard = requireGet();
    if (guard) return guard;
    const hash = safeDecode(suffix.slice(PROJECT_ROUTES.evidencePrefix.length));
    if (hash === null) return fail("bad-request", `${path} is not a decodable evidence path`);
    return handleEvidence(scoped, hash, url.searchParams.get("raw") === "1");
  }

  if (suffix.startsWith(PROJECT_ROUTES.specPrefix)) {
    const guard = requirePost() ?? requireControls();
    if (guard) return guard;
    const parts = suffix
      .slice(PROJECT_ROUTES.specPrefix.length)
      .split("/")
      .filter((p) => p.length > 0);
    if (parts.length !== 2) {
      return fail("bad-request", `expected ${projectRoute(NAMED, `${PROJECT_ROUTES.specPrefix}<id>/<verb>`)}, got ${path}`);
    }
    const specId = safeDecode(parts[0]!);
    const verb = parts[1]!;
    if (specId === null) return fail("bad-request", `${path} is not a decodable spec control path`);
    if (!SPEC_ID_SHAPE.test(specId)) return fail("bad-request", `"${specId}" is not a valid spec id`);
    if (!(SPEC_CONTROL_VERBS as readonly string[]).includes(verb)) {
      return fail("not-found", `unknown spec control verb "${verb}" (expected one of ${SPEC_CONTROL_VERBS.join(", ")})`);
    }
    return handleSpecControl(scoped, verb as SpecControlVerb, specId, controlSourceFrom(request, await readJsonBody(request)));
  }

  return fail("not-found", `no route for ${method} ${path}`);
}

async function route(
  deps: ApiDeps,
  request: Request,
  hub: EventHub,
  closers: Set<() => void>,
  staticHandler: StaticHandler | null
): Promise<Response> {
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

  switch (path) {
    case API_ROUTES.meta:
      return requireGet() ?? ok(metaView(deps, clock.now()));
    case API_ROUTES.quota:
      return requireGet() ?? ok(quotaView(quotaInputs(deps), clock.now()));
    case API_ROUTES.events: {
      const guard = requireGet();
      if (guard) return guard;
      const requested = url.searchParams.get(EVENTS_PROJECT_PARAM);
      if (requested !== null) {
        if (!isValidProjectName(requested)) return fail("bad-request", `"${requested}" is not a valid project name`);
        // A filter on a project this daemon does not have would answer with a
        // stream that is silently empty forever, which is the "empty success"
        // B-5 forbids in its own words.
        if (!deps.projects.projects().has(requested)) return fail("not-found", `no registered project named "${requested}"`);
      }
      return sseResponse(hub, request, requested, deps.heartbeatMs ?? SSE_HEARTBEAT_MS, closers);
    }
    case API_ROUTES.projects: {
      if (method === "POST") {
        if (!controlsAllowed(deps)) return readOnlyRefusal();
        const body = await readJsonBody(request);
        return handleRegister(deps, body, controlSourceFrom(request, body), clock.now());
      }
      return requireGet() ?? ok(projectsView(projectRows(deps), clock.now()));
    }
    default:
      break;
  }

  if (path.startsWith(API_ROUTES.projectPrefix)) {
    const segments = path
      .slice(API_ROUTES.projectPrefix.length)
      .split("/")
      .filter((s) => s.length > 0);
    return await routeProject(deps, request, url, method, segments, clock);
  }

  // Last, and never for `/api`: the built SPA (spec 024 B-1). static.ts
  // refuses the API namespace itself, so every unknown API path still leaves
  // through the envelope below rather than as an HTML shell.
  const asset = staticHandler?.(request, path) ?? null;
  if (asset !== null) return asset;

  return fail("not-found", `no route for ${method} ${path}`);
}

// --- the server -------------------------------------------------------------

// An IPv6 literal needs brackets in an authority component; "127.0.0.1" and
// "localhost" pass through untouched.
function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

// Every chain the event pump watches: the daemon's registry chain, which
// belongs to no project, plus one per registered project. Re-derived on every
// tick, so a project registered through `POST /api/projects` starts streaming
// without a restart.
function pumpSources(deps: ApiDeps): readonly PumpSource[] {
  const sources: PumpSource[] = [{ project: null, journal: deps.projects.chain }];
  for (const project of deps.projects.projects().values()) {
    try {
      sources.push({ project: project.name, journal: deps.projects.resourcesFor(project).journal });
    } catch {
      // a project whose state root cannot be opened has nothing to stream
    }
  }
  return sources;
}

export function createApiServer(deps: ApiDeps): ApiServer {
  const host = deps.host ?? DEFAULT_API_HOST;
  assertLoopbackHost(host);

  const hub = new EventHub(deps.eventRingCapacity);
  const clock = deps.clock ?? { now: () => Date.now() };
  const pump = startJournalPump({
    hub,
    sources: () => pumpSources(deps),
    clock,
    ...(deps.pumpIntervalMs !== undefined ? { intervalMs: deps.pumpIntervalMs } : {}),
    ...(deps.quotaTickMs !== undefined ? { quotaTickMs: deps.quotaTickMs } : {}),
  });

  const closers = new Set<() => void>();
  const staticHandler =
    deps.staticDir === null ? null : createStaticHandler({ distDir: deps.staticDir ?? defaultWebDistDir() });

  const server = Bun.serve({
    hostname: host,
    port: deps.port ?? DEFAULT_API_PORT,
    // D-9: Bun's default 10 s idle timeout severed every quiet SSE stream
    // (B-4 holds connections open between journal appends, which can be
    // minutes apart in standby) and logged "[Bun.serve]: request timed out"
    // noise on each kill. 0 disables the timeout deliberately: the listener
    // is loopback-only, every JSON route answers in one fold, and the one
    // long-lived route is exactly the one this timeout kept breaking.
    idleTimeout: 0,
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(deps, request, hub, closers, staticHandler);
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
      // D-10: closing two or more stream controllers and calling stop(true)
      // in the same event-loop turn leaves its promise forever pending on
      // Bun 1.3.11 (the sockets still tear down; only the promise leaks).
      // One yielded tick lets the closes settle first. Without it the
      // daemon's SIGTERM path awaits this forever with every later TERM
      // swallowed, which is how 026 B-7 died by SIGKILL whenever two SSE
      // clients (a dashboard tab plus anything else) were connected.
      await Bun.sleep(0);
      await server.stop(true);
    },
  };
}
