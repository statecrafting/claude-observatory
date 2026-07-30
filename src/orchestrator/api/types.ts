// The versioned wire contract (spec 022 B-2): every response shape the
// daemon serves, the one success/failure envelope they travel in, and the
// stable error-kind tokens clients branch on. Nothing in this file performs
// I/O or reads state; it is the single place the CLI (spec 023), the web UI
// (spec 024), and the server itself agree on shapes, so a change here is
// visible to every client at compile time rather than at runtime.
//
// The envelope follows statecraft-cli's own output pattern: `{ok: true,
// data}` or `{ok: false, error: {kind, message}}`, never a bare payload and
// never an HTTP status alone carrying the meaning.
import type { JsonValue, JournalRecord } from "../journal";
import type { RunStatus, SpecExecStatus, Stage, StageExecStatus } from "../state";
import type { ShippedSource } from "../dag";
import type { DecisionRecord } from "../decisions";

// --- version (B-2) ----------------------------------------------------------

// Bumped whenever a served shape changes incompatibly. Clients send it as
// `X-Api-Version`; a mismatch is refused with the `api-version-mismatch`
// token rather than being served a shape the client cannot parse. Stability
// guarantees beyond this gate are out of scope (section 6).
export const API_VERSION = 1;

export const API_VERSION_HEADER = "X-Api-Version";
export const CONTROL_SOURCE_HEADER = "X-Control-Source";
export const DEFAULT_CONTROL_SOURCE = "api";

// --- envelope (B-2) ---------------------------------------------------------

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

// --- routes -----------------------------------------------------------------

// One table, consumed by both the server's router and the client's fetch
// wrapper, so a path can never drift between the two halves (FR-002).
export const API_ROUTES = {
  meta: "/api/meta",
  dag: "/api/dag",
  run: "/api/run",
  quota: "/api/quota",
  decisions: "/api/decisions",
  history: "/api/history",
  events: "/api/events",
  evidencePrefix: "/api/evidence/",
  runStart: "/api/run/start",
  runPause: "/api/run/pause",
  runResume: "/api/run/resume",
  specPrefix: "/api/spec/",
} as const;

export const SPEC_CONTROL_VERBS = ["skip", "retry-stage", "reverify", "force-human-gate", "approve"] as const;
export type SpecControlVerb = (typeof SPEC_CONTROL_VERBS)[number];

export type ControlVerbToken = "start" | "pause" | "resume" | SpecControlVerb;

// --- /api/meta --------------------------------------------------------------

export interface ApiMeta {
  readonly apiVersion: number;
  readonly service: "claude-observatory-orchestrator";
  // B-1: v1 binds loopback only. Served rather than assumed so a client can
  // tell a loopback daemon from whatever a later, authenticated deployment
  // looks like without guessing from the URL.
  readonly loopbackOnly: boolean;
  readonly controlsAvailable: boolean;
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

// --- /api/dag (B-3) ---------------------------------------------------------

export interface DagSpecNode {
  readonly id: string;
  // Explicit unknown (B-6): the registry may carry no `implementation` field
  // at all for a spec, which is not the same as "pending".
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

// --- /api/run (B-3) ---------------------------------------------------------

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

export interface RunView {
  // null when no run has ever been created: an explicit unknown, not an
  // invented idle run (B-6).
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

// --- /api/quota (B-3) -------------------------------------------------------

export interface QuotaView {
  readonly parked: boolean;
  // All null until a park has ever been journaled: never a fabricated zero.
  readonly targetMs: number | null;
  readonly estimated: boolean | null;
  readonly msUntilTarget: number | null;
  readonly consecutiveQuotaParks: number;
  readonly warn: boolean;
  readonly nowMs: number;
}

// --- /api/decisions (B-3, spec 020 B-5) -------------------------------------

export interface DecisionQueryParams {
  readonly query?: string;
  readonly specId?: string;
  readonly path?: string;
}

export interface DecisionsView {
  readonly query: DecisionQueryParams;
  readonly total: number;
  readonly decisions: readonly DecisionRecord[];
}

// --- /api/history (B-3) -----------------------------------------------------

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
  // Content hashes servable from /api/evidence/<hash>.
  readonly evidenceRefs: readonly string[];
}

export interface HistoryView {
  readonly entries: readonly HistoryEntry[];
}

// --- /api/evidence/<hash> (B-3) ---------------------------------------------

export type EvidenceMediaType = "text/plain" | "image/png";

export interface EvidenceView {
  readonly hash: string;
  readonly mediaType: EvidenceMediaType;
  readonly bytes: number;
  // Exactly one of these is non-null, by mediaType.
  readonly text: string | null;
  readonly base64: string | null;
}

// --- controls (B-5) ---------------------------------------------------------

export interface ControlResult {
  readonly verb: ControlVerbToken;
  readonly specId: string | null;
  // false when the verb was already satisfied and nothing was journaled
  // (the idempotent case B-5 names): a pause on an already-paused run, a
  // resume on an already-running one.
  readonly applied: boolean;
  // The control record the daemon journaled, verbatim; null when nothing
  // was journaled (see `applied`).
  readonly record: ApiJournalRecord | null;
  readonly runStatus: RunStatus | null;
}

// --- events (B-4) -----------------------------------------------------------

export type ApiEventType = "journal" | "transition" | "session" | "quota" | "control" | "stage" | "meta";

export interface ApiEvent {
  // Monotonic per server process; this is the `id:` field SSE clients echo
  // back as `Last-Event-ID` to request replay.
  readonly id: number;
  readonly type: ApiEventType;
  // The journal seq this event mirrors, or null for a server-synthesized
  // event (a quota tick, a replay-gap notice).
  readonly seq: number | null;
  readonly ts: string;
  readonly kind: string;
  readonly data: JsonValue;
}
