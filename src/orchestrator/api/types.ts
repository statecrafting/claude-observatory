// The versioned wire contract (spec 022 B-2, spec 027 B-1): every response
// shape the daemon serves, the one success/failure envelope they travel in,
// and the stable error-kind tokens clients branch on. Nothing in this file
// performs I/O or reads state; it is the single place the CLI (spec 023), the
// web UI (spec 024), and the server itself agree on shapes, so a change here
// is visible to every client at compile time rather than at runtime.
//
// The envelope follows statecraft-cli's own output pattern: `{ok: true,
// data}` or `{ok: false, error: {kind, message}}`, never a bare payload and
// never an HTTP status alone carrying the meaning.
//
// v2 is the project-scoped contract (spec 027). One daemon answers for many
// projects, so every project-scoped fact lives under `/api/projects/<name>/`
// and carries its project in the payload; the facts that are genuinely global
// (daemon meta, the account's quota pool, the event stream) stay global, with
// every event naming the project it belongs to. There are no v1 aliases.
import type { JsonValue, JournalRecord } from "../journal";
import type { RunStatus, SpecExecStatus, Stage, StageExecStatus } from "../state";
import type { ShippedSource } from "../dag";
import type { DecisionRecord } from "../decisions";
import type { RecordedQualification } from "../projects";
import type { ExecutionProfile, RecordedProfile } from "../profile";
import type { CostCeiling, ProjectBudgetView } from "../budget";

// --- version (B-1) ----------------------------------------------------------

// Bumped whenever a served shape changes incompatibly. Clients send it as
// `X-Api-Version`; a mismatch is refused with the `api-version-mismatch`
// token rather than being served a shape the client cannot parse. Stability
// guarantees beyond this gate are out of scope (section 6).
export const API_VERSION = 2;

export const API_VERSION_HEADER = "X-Api-Version";
export const CONTROL_SOURCE_HEADER = "X-Control-Source";
export const DEFAULT_CONTROL_SOURCE = "api";

// --- envelope (022 B-2) -----------------------------------------------------

// Server-side kinds are what a route can actually answer with; the last two
// are produced only by the typed client (api-client.ts) when the daemon
// could not be reached or answered with something unparseable, so a client
// branching on `kind` never has to special-case transport failure.
export const API_ERROR_KINDS = [
  "bad-request",
  "not-found",
  "method-not-allowed",
  "conflict",
  "unavailable",
  "api-version-mismatch",
  "internal",
  "unreachable",
  "malformed-response",
] as const;

export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

export interface ApiError {
  readonly kind: ApiErrorKind;
  readonly message: string;
}

export type ApiResponse<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ApiError };

// --- routes (B-2, B-3, B-4, B-5) --------------------------------------------

// The global half of the route table: the three facts that belong to the
// daemon rather than to any one project. Consumed by both the server's router
// and the client's fetch wrapper, so a path can never drift between the two
// halves (FR-002).
export const API_ROUTES = {
  meta: "/api/meta",
  quota: "/api/quota",
  events: "/api/events",
  projects: "/api/projects",
  projectPrefix: "/api/projects/",
} as const;

// Everything under `/api/projects/<name>/`, as suffixes rather than whole
// paths: the same table drives the router's segment match and the client's
// URL building, so a scoped route cannot drift either.
export const PROJECT_ROUTES = {
  dag: "dag",
  run: "run",
  decisions: "decisions",
  history: "history",
  evidencePrefix: "evidence/",
  arm: "arm",
  disarm: "disarm",
  requalify: "requalify",
  remove: "remove",
  profile: "profile",
  // 033 B-1: the one write verb a cost ceiling needs. Setting and clearing are
  // the same route; the body says which.
  ceiling: "ceiling",
  runStart: "run/start",
  runPause: "run/pause",
  runResume: "run/resume",
  specPrefix: "spec/",
} as const;

// D-1: spec 025's slug grammar (lowercase alphanumerics and hyphens) has no
// character that needs URL escaping, so a project name goes into the path raw
// and the router matches it as a plain segment. Nothing ambiguous can be
// addressed, and nothing has to be decoded back.
export function projectRoute(project: string, suffix: string): string {
  return `${API_ROUTES.projectPrefix}${project}/${suffix}`;
}

// The optional server-side filter on the one SSE stream (B-4).
export const EVENTS_PROJECT_PARAM = "project";

export const SPEC_CONTROL_VERBS = ["skip", "retry-stage", "reverify", "force-human-gate", "approve"] as const;
export type SpecControlVerb = (typeof SPEC_CONTROL_VERBS)[number];

export type ControlVerbToken = "start" | "pause" | "resume" | SpecControlVerb;

export const PROJECT_CONTROL_VERBS = ["register", "arm", "disarm", "requalify", "remove", "profile", "ceiling"] as const;
export type ProjectControlVerb = (typeof PROJECT_CONTROL_VERBS)[number];

// --- /api/meta (B-4) --------------------------------------------------------

// What the daemon itself is doing, as spec 026 models it. "driving" is a
// project holding the one flight slot; "parked" is that same slot held by a
// run waiting out the quota horizon (spec 015), which is not the same thing
// as idling; "standby" is the scheduler between turns.
export type DaemonState = "starting" | "driving" | "parked" | "standby" | "stopped";

export interface DaemonMetaView {
  readonly state: DaemonState;
  // The flight-slot holder (010 D15: at most one live stage session
  // globally), null while the daemon is in standby.
  readonly activeProject: string | null;
  readonly scanIntervalMs: number | null;
  readonly lastScanMs: number | null;
}

export interface ApiMeta {
  readonly apiVersion: number;
  readonly service: "claude-observatory-orchestrator";
  // 022 B-1: the daemon binds loopback only. Served rather than assumed so a
  // client can tell a loopback daemon from whatever a later, authenticated
  // deployment looks like without guessing from the URL.
  readonly loopbackOnly: boolean;
  readonly controlsAvailable: boolean;
  // null when no scheduler is attached to this server (a read-only inspector
  // over journals on disk): an explicit unknown, never an invented "standby".
  readonly daemon: DaemonMetaView | null;
  readonly projectCount: number;
  readonly routes: readonly string[];
}

// --- shared record projection -----------------------------------------------

// A journal record as served: the sealed envelope's hash fields are dropped
// (chain verification is the CLI's offline job, spec 023 B-4), the four
// fields a client actually renders are kept.
export interface ApiJournalRecord {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly payload: JsonValue;
}

export function toApiJournalRecord(record: JournalRecord): ApiJournalRecord {
  return { seq: record.seq, ts: record.ts, kind: record.kind, payload: record.payload };
}

// --- /api/projects (B-2) ----------------------------------------------------

export interface RunSummary {
  readonly id: string;
  readonly targetRepo: string;
  readonly createdTs: string;
  readonly status: RunStatus;
  readonly needsReconcile: boolean;
}

export interface SpecExecSummary {
  readonly id: string;
  readonly specId: string;
  readonly pin: string;
  readonly attempt: number;
  readonly status: SpecExecStatus;
  readonly needsReconcile: boolean;
}

export interface StageExecSummary {
  readonly id: string;
  readonly stage: Stage;
  readonly attempt: number;
  readonly status: StageExecStatus;
  readonly needsReconcile: boolean;
}

// One row of the folded registry (spec 025), with the current-run summary
// folded from that project's own work journal.
export interface ProjectView {
  readonly name: string;
  readonly repoDir: string;
  readonly armed: boolean;
  // 025 B-4's recorded verdict, reasons included: an unqualified project stays
  // visible with why it was refused, never dropped from the list.
  readonly qualification: RecordedQualification;
  // 032 B-6: the posture every session driven against this project runs
  // under, never omitted. `legacy` distinguishes a bypass derived from a
  // chain that has no profile record from one an operator chose.
  readonly profile: RecordedProfile;
  // 033 B-7: the spend limits this project is driven under and the journaled
  // floor evaluated against them, on the same row the operator already reads.
  // Never omitted: a project with no ceiling says so (FR-004), which is a
  // different fact from a ceiling of zero.
  readonly budget: ProjectBudgetView;
  // null when this project has no run yet, or when `readError` says its state
  // root could not be read. Never a fabricated idle run (022 B-6).
  readonly run: RunSummary | null;
  readonly spec: SpecExecSummary | null;
  readonly stage: StageExecSummary | null;
  // Why the run summary is null when it is: the project's journals could not
  // be opened or folded. Reported, not hidden behind an empty row.
  readonly readError: string | null;
}

export interface ProjectsView {
  readonly projects: readonly ProjectView[];
}

export interface RegisterProjectRequest {
  readonly path: string;
  readonly name?: string;
  // 032 B-2: the posture this registration consents to, recorded beside the
  // registration. Omitted records D-1's default (bypass), which is what the
  // registry did before profiles existed, now said out loud.
  readonly profile?: ExecutionProfile;
}

// The body of the one write verb 032 B-2 puts on the registry (POST
// /api/projects/<name>/profile): the whole profile, never a patch, because a
// posture is one journaled decision rather than a set of fields to nudge.
export interface SetProjectProfileRequest {
  readonly profile: ExecutionProfile;
}

// The body of 033 B-1's write verb (POST /api/projects/<name>/ceiling): the
// whole ceiling, never a patch, for the same reason a profile travels whole. A
// null ceiling clears it, which is a decision the chain records rather than an
// absence it has to infer.
export interface SetProjectCeilingRequest {
  readonly ceiling: CostCeiling | null;
}

// The answer to a registry control (B-2): spec 022 D-2's pattern applied to
// the projects chain, so the record shown is the one the chain actually
// carries rather than one this API composed.
export interface ProjectControlResult {
  readonly verb: ProjectControlVerb;
  // The project the verb addressed; null only when a registration was refused
  // before any name existed.
  readonly project: string | null;
  readonly applied: boolean;
  readonly record: ApiJournalRecord | null;
  // The project as it stands after the call, null once removed.
  readonly snapshot: ProjectView | null;
}

// --- /api/projects/<name>/dag (B-3) -----------------------------------------

export interface DagSpecNode {
  readonly id: string;
  // Explicit unknown (022 B-6): the registry may carry no `implementation`
  // field at all for a spec, which is not the same as "pending".
  readonly implementation: string | null;
  readonly dependsOn: readonly string[];
  readonly shipped: boolean;
  readonly shippedSource: ShippedSource | null;
  // The pin recorded when the spec shipped, and the pin its spec.md hashes
  // to right now. A difference is drift (spec 012 B-4).
  readonly shippedPin: string | null;
  readonly currentPin: string | null;
  // Why currentPin is null, when it is: the spec file could not be read.
  readonly pinError: string | null;
  readonly drifted: boolean;
  readonly invalidated: boolean;
  // Skipped by an operator control (spec 021 B-4); the daemon will not pick
  // it again this run even while the registry still calls it pending.
  readonly skipped: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  // The current run's execution status for this spec, when it has one.
  readonly specExecStatus: SpecExecStatus | null;
}

export interface DagView {
  // B-3: the project name travels in the payload, so a response cannot be
  // read as if it described "the one repo".
  readonly project: string;
  readonly specs: readonly DagSpecNode[];
  readonly nextReady: string | null;
  readonly blockers: readonly SpecBlockerView[];
  // Non-null when depends_on contains a cycle; scheduling refuses while any
  // spec on it is unshipped (spec 012 B-5).
  readonly cycle: readonly string[] | null;
  readonly invalidated: readonly string[];
}

export interface SpecBlockerView {
  readonly specId: string;
  readonly reasons: readonly string[];
}

// --- /api/projects/<name>/run (B-3) -----------------------------------------

export interface RunView {
  readonly project: string;
  // null when no run has ever been created: an explicit unknown, not an
  // invented idle run (022 B-6).
  readonly run: RunSummary | null;
  readonly spec: SpecExecSummary | null;
  readonly stage: StageExecSummary | null;
  readonly pauseReason: string | null;
  readonly blockers: readonly SpecBlockerView[];
  readonly lastHeartbeatMs: number | null;
  // Specs whose next stage transition is held behind an unreleased human
  // gate (spec 021 B-4).
  readonly awaitingApproval: readonly string[];
}

// --- /api/quota (B-4) -------------------------------------------------------

// Global, and deliberately not scoped to a project: the account's quota is
// one pool (026 B-5), so a parked run anywhere is the whole daemon's horizon.
export interface QuotaView {
  readonly parked: boolean;
  // Which project's journal recorded this park. Named because "the account is
  // parked" is only checkable against the run that hit the wall; null when no
  // project has ever journaled one.
  readonly project: string | null;
  // All null until a park has ever been journaled: never a fabricated zero.
  readonly targetMs: number | null;
  readonly estimated: boolean | null;
  readonly msUntilTarget: number | null;
  readonly consecutiveQuotaParks: number;
  readonly warn: boolean;
  readonly nowMs: number;
}

// --- /api/projects/<name>/decisions (B-3, spec 020 B-5) ---------------------

export interface DecisionQueryParams {
  readonly query?: string;
  readonly specId?: string;
  readonly path?: string;
}

export interface DecisionsView {
  readonly project: string;
  readonly query: DecisionQueryParams;
  readonly total: number;
  readonly decisions: readonly DecisionRecord[];
}

// --- /api/projects/<name>/history (B-3) -------------------------------------

export interface HistoryStage {
  readonly id: string;
  readonly stage: Stage;
  readonly attempt: number;
  readonly status: StageExecStatus;
  readonly needsReconcile: boolean;
}

export interface HistoryEntry {
  readonly specExecId: string;
  readonly runId: string;
  readonly specId: string;
  readonly pin: string;
  readonly attempt: number;
  readonly status: SpecExecStatus;
  readonly needsReconcile: boolean;
  readonly stages: readonly HistoryStage[];
  readonly prNumber: number | null;
  readonly mergeSha: string | null;
  // The shepherd stage's own verdict on CI for this execution
  // ("passed" once every required check was green, "failed"/"blocked"/
  // "quota" otherwise), null while shepherd has not reported.
  readonly ciConclusion: string | null;
  readonly verifyVerdict: string | null;
  // Content hashes servable from /api/projects/<name>/evidence/<hash>.
  readonly evidenceRefs: readonly string[];
}

export interface HistoryView {
  readonly project: string;
  readonly entries: readonly HistoryEntry[];
}

// --- /api/projects/<name>/evidence/<hash> (B-3) -----------------------------

export type EvidenceMediaType = "text/plain" | "image/png";

export interface EvidenceView {
  readonly project: string;
  readonly hash: string;
  readonly mediaType: EvidenceMediaType;
  readonly bytes: number;
  // Exactly one of these is non-null, by mediaType.
  readonly text: string | null;
  readonly base64: string | null;
}

// --- scoped controls (B-5) --------------------------------------------------

export interface ControlResult {
  readonly project: string;
  readonly verb: ControlVerbToken;
  readonly specId: string | null;
  // false when the verb was already satisfied and nothing was journaled
  // (the idempotent case 022 B-5 names): a pause on an already-paused run, a
  // resume on an already-running one.
  readonly applied: boolean;
  // The control record the daemon journaled, verbatim; null when nothing
  // was journaled (see `applied`).
  readonly record: ApiJournalRecord | null;
  readonly runStatus: RunStatus | null;
}

// --- events (B-4) -----------------------------------------------------------

export type ApiEventType =
  | "journal"
  | "transition"
  | "session"
  | "quota"
  | "control"
  | "stage"
  | "project"
  | "meta";

export interface ApiEvent {
  // Monotonic per server process; this is the `id:` field SSE clients echo
  // back as `Last-Event-ID` to request replay.
  readonly id: number;
  // Which project's chain this event came off, null for a daemon-scoped one
  // (a registry mutation, a server notice). Every event carries it, so one
  // stream can serve many projects without a client having to guess.
  readonly project: string | null;
  readonly type: ApiEventType;
  // The journal seq this event mirrors, or null for a server-synthesized
  // event (a quota tick, a replay-gap notice).
  readonly seq: number | null;
  readonly ts: string;
  readonly kind: string;
  readonly data: JsonValue;
}
