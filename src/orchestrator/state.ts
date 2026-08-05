// The run/spec/stage state machine, kept as data (transition tables) after
// the statecraft factory pattern: every legal edge is an entry in an
// exported constant, every illegal edge is whatever the table does not say,
// and the only way to move an entity is through transition(), which brackets
// the move in the journal's intent/outcome pair (spec 011 B-4) before ever
// mutating anything in memory. Nothing here is trusted from a live process:
// foldOrchestratorState() rebuilds the same three entity sets from the
// journal alone, so a resumed daemon and the process that crashed mid-move
// agree on what happened.
import type { JournalHandle, JsonValue } from "./journal";
import { appendIntent, appendOutcome, canonicalizeValue } from "./journal";
import { randomBytes } from "crypto";

// --- ids ------------------------------------------------------------------

// A small monotonic id, sortable as a plain string, with no dependency
// beyond node's crypto (already used by journal.ts for hashing). Three
// fixed-width fields concatenated in order: epoch-ms in base36 (9 chars,
// good until year ~5138), a per-process counter (4 base36 chars, so up to
// 36^4 ids minted within the same millisecond by this process still sort in
// creation order), and a 4-hex-char random suffix (guards against two
// processes minting the same ms+counter pair at once). This is "ULID-like"
// per B-1 without pulling in a ULID library.
let idCounter = 0;

export function newId(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  idCounter = (idCounter + 1) % 36 ** 4;
  const counter = idCounter.toString(36).padStart(4, "0");
  const rand = randomBytes(2).toString("hex");
  return `${ts}${counter}${rand}`;
}

// --- entities (B-1) --------------------------------------------------------

export type RunStatus = "idle" | "running" | "parked" | "paused" | "completed" | "failed";

export interface Run {
  readonly id: string;
  readonly targetRepo: string;
  readonly createdTs: string;
  readonly status: RunStatus;
}

export type SpecExecStatus =
  | "pending"
  | "building"
  | "shipping"
  | "shepherding"
  | "verifying"
  | "shipped"
  | "failed"
  | "invalidated";

export interface SpecExec {
  readonly id: string;
  readonly runId: string;
  readonly specId: string;
  readonly pin: string;
  readonly attempt: number;
  readonly status: SpecExecStatus;
}

export type Stage = "build" | "ship" | "shepherd" | "verify";
export type StageExecStatus = "queued" | "running" | "passed" | "failed" | "blocked";

export interface StageExec {
  readonly id: string;
  readonly specExecId: string;
  readonly stage: Stage;
  readonly attempt: number;
  readonly status: StageExecStatus;
  readonly evidenceRefs: readonly string[];
}

export type EntityKind = "run" | "specExec" | "stageExec";

// --- transition tables (B-2, B-3, B-4, B-5) --------------------------------

// idle -> running -> (parked | paused | completed | failed); parked and
// paused both resume to running (quota resume and human resume,
// respectively; which caused which is spec 015/022's business, not this
// module's).
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  idle: ["running"],
  running: ["parked", "paused", "completed", "failed"],
  parked: ["running"],
  paused: ["running"],
  completed: [],
  failed: [],
};

// pending -> building -> shipping -> shepherding -> verifying -> shipped;
// any of the five pre-shipped ("live", B-3's own word) states can fail;
// failed retries as a fresh attempt into building; shipped can be
// invalidated by an upstream pin drift (spec 012 B-4) and re-verified.
export const SPEC_EXEC_TRANSITIONS: Readonly<Record<SpecExecStatus, readonly SpecExecStatus[]>> = {
  pending: ["building", "failed"],
  building: ["shipping", "failed"],
  shipping: ["shepherding", "failed"],
  shepherding: ["verifying", "failed"],
  verifying: ["shipped", "failed"],
  shipped: ["invalidated"],
  failed: ["building"],
  invalidated: ["verifying"],
};

// queued -> running -> (passed | failed | blocked). Retrying a stage mints a
// fresh StageExec at attempt+1 (see createStageExec) rather than transitioning
// back to queued in place: B-4 names no such edge, and passed/failed/blocked
// are each a sink here (no outgoing edge in this table).
export const STAGE_EXEC_TRANSITIONS: Readonly<Record<StageExecStatus, readonly StageExecStatus[]>> = {
  queued: ["running"],
  running: ["passed", "failed", "blocked"],
  passed: [],
  failed: [],
  blocked: [],
};

// --- park and pause reasons (spec 033 B-3, B-4) ----------------------------

// Why a run left "running" without being terminal, as a closed vocabulary
// rather than as free text. The table above says a run may park and may pause;
// it never said what for, because until spec 033 there was exactly one park
// reason (quota, spec 015) and every pause carried an operator-facing sentence
// and nothing machine-readable. A budget stop needs both to be checkable: a
// surface has to tell a quota park from a budget park, and a resume policy has
// to tell a stop a clock can lift from one only a human can.
//
// These are tokens journaled alongside the transition, not statuses: the state
// machine's own tables (B-2) are untouched, and "parked" still means exactly
// what it meant.
export const RUN_PARK_REASONS = ["quota", "budget-day"] as const;
export type RunParkReason = (typeof RUN_PARK_REASONS)[number];

// "stage" is every pause the daemon took before this vocabulary existed: a
// crashed, failed, or blocked stage, and a gate awaiting approval. It is named
// here so the vocabulary is total rather than a set of exceptions.
export const RUN_PAUSE_REASONS = ["stage", "budget-run"] as const;
export type RunPauseReason = (typeof RUN_PAUSE_REASONS)[number];

// --- invalid transition (B-5) ----------------------------------------------

export class InvalidTransitionError extends Error {
  readonly entity: EntityKind;
  readonly from: string;
  readonly to: string;

  constructor(entity: EntityKind, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

// --- entity-kind dispatch ---------------------------------------------------

function isStageExec(x: Run | SpecExec | StageExec): x is StageExec {
  return "specExecId" in x;
}

function isSpecExec(x: Run | SpecExec | StageExec): x is SpecExec {
  return "specId" in x;
}

function entityKindOf(x: Run | SpecExec | StageExec): EntityKind {
  if (isStageExec(x)) return "stageExec";
  if (isSpecExec(x)) return "specExec";
  return "run";
}

function allowedNext(kind: EntityKind, from: string): readonly string[] {
  if (kind === "run") return RUN_TRANSITIONS[from as RunStatus] ?? [];
  if (kind === "specExec") return SPEC_EXEC_TRANSITIONS[from as SpecExecStatus] ?? [];
  return STAGE_EXEC_TRANSITIONS[from as StageExecStatus] ?? [];
}

// The one place attempt-bumping lives: SpecExec's failed -> building retry
// (B-3) increments attempt as a deterministic function of the (kind, from,
// to) triple, not as a separate field in the transition payload. That keeps
// the journaled payload at the fixed {entity, id, from, to} shape while
// still letting foldOrchestratorState() below recompute the same attempt
// value transition() computed live, by replaying this same function.
function applyTransition(
  kind: EntityKind,
  current: Run | SpecExec | StageExec,
  to: string
): Run | SpecExec | StageExec {
  if (kind === "specExec") {
    const specExec = current as SpecExec;
    const attempt = specExec.status === "failed" && to === "building" ? specExec.attempt + 1 : specExec.attempt;
    return { ...specExec, status: to as SpecExecStatus, attempt };
  }
  if (kind === "run") return { ...(current as Run), status: to as RunStatus };
  return { ...(current as StageExec), status: to as StageExecStatus };
}

// --- transition (B-5) -------------------------------------------------------

export function transition(handle: JournalHandle, current: Run, to: RunStatus): Run;
export function transition(handle: JournalHandle, current: SpecExec, to: SpecExecStatus): SpecExec;
export function transition(handle: JournalHandle, current: StageExec, to: StageExecStatus): StageExec;
export function transition(
  handle: JournalHandle,
  current: Run | SpecExec | StageExec,
  to: string
): Run | SpecExec | StageExec {
  const kind = entityKindOf(current);
  const from = current.status;
  // Validation happens before any journal write: an illegal edge never
  // leaves a trace.
  if (!allowedNext(kind, from).includes(to)) {
    throw new InvalidTransitionError(kind, from, to);
  }
  const payload: JsonValue = { entity: kind, id: current.id, from, to };
  appendIntent(handle, "state.transition", payload);
  const updated = applyTransition(kind, current, to);
  appendOutcome(handle, "state.transition", payload);
  return updated;
}

// --- creation (B-1, B-6) ----------------------------------------------------

export function createRun(handle: JournalHandle, targetRepo: string): Run {
  const run: Run = { id: newId(), targetRepo, createdTs: new Date().toISOString(), status: "idle" };
  handle.append("run.created", canonicalizeValue(run));
  return run;
}

export function createSpecExec(handle: JournalHandle, runId: string, specId: string, pin: string): SpecExec {
  const specExec: SpecExec = { id: newId(), runId, specId, pin, attempt: 1, status: "pending" };
  handle.append("specexec.created", canonicalizeValue(specExec));
  return specExec;
}

// attempt defaults to 1 (a fresh StageExec); a retry mints a new StageExec
// at attempt+1 by calling this again with the previous StageExec's attempt
// incremented (B-4: "every stage can be retried, incrementing attempt").
export function createStageExec(
  handle: JournalHandle,
  specExecId: string,
  stage: Stage,
  attempt: number = 1
): StageExec {
  const stageExec: StageExec = { id: newId(), specExecId, stage, attempt, status: "queued", evidenceRefs: [] };
  handle.append("stageexec.created", canonicalizeValue(stageExec));
  return stageExec;
}

// --- fold (B-6) --------------------------------------------------------------

export interface FoldedRun extends Run {
  readonly needsReconcile: boolean;
}

export interface FoldedSpecExec extends SpecExec {
  readonly needsReconcile: boolean;
}

export interface FoldedStageExec extends StageExec {
  readonly needsReconcile: boolean;
}

export interface OrchestratorState {
  readonly runs: ReadonlyMap<string, FoldedRun>;
  readonly specExecs: ReadonlyMap<string, FoldedSpecExec>;
  readonly stageExecs: ReadonlyMap<string, FoldedStageExec>;
}

function asRecord(v: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`state: ${label} expected a JSON object payload`);
  }
  return v as Record<string, JsonValue>;
}

function asString(o: Record<string, JsonValue>, field: string): string {
  const v = o[field];
  if (typeof v !== "string") throw new Error(`state: expected string field "${field}"`);
  return v;
}

function asNumber(o: Record<string, JsonValue>, field: string): number {
  const v = o[field];
  if (typeof v !== "number") throw new Error(`state: expected number field "${field}"`);
  return v;
}

function asStringArray(o: Record<string, JsonValue>, field: string): string[] {
  const v = o[field];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`state: expected string array field "${field}"`);
  }
  return v as string[];
}

function parseRun(payload: JsonValue): Run {
  const o = asRecord(payload, "run.created");
  return {
    id: asString(o, "id"),
    targetRepo: asString(o, "targetRepo"),
    createdTs: asString(o, "createdTs"),
    status: asString(o, "status") as RunStatus,
  };
}

function parseSpecExec(payload: JsonValue): SpecExec {
  const o = asRecord(payload, "specexec.created");
  return {
    id: asString(o, "id"),
    runId: asString(o, "runId"),
    specId: asString(o, "specId"),
    pin: asString(o, "pin"),
    attempt: asNumber(o, "attempt"),
    status: asString(o, "status") as SpecExecStatus,
  };
}

function parseStageExec(payload: JsonValue): StageExec {
  const o = asRecord(payload, "stageexec.created");
  return {
    id: asString(o, "id"),
    specExecId: asString(o, "specExecId"),
    stage: asString(o, "stage") as Stage,
    attempt: asNumber(o, "attempt"),
    status: asString(o, "status") as StageExecStatus,
    evidenceRefs: asStringArray(o, "evidenceRefs"),
  };
}

interface TransitionPayload {
  readonly entity: EntityKind;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

function parseTransitionPayload(payload: JsonValue): TransitionPayload {
  const o = asRecord(payload, "state.transition");
  const entity = asString(o, "entity");
  if (entity !== "run" && entity !== "specExec" && entity !== "stageExec") {
    throw new Error(`state: unknown entity kind "${entity}" in transition payload`);
  }
  return { entity, id: asString(o, "id"), from: asString(o, "from"), to: asString(o, "to") };
}

// A structural subset of JournalRecord (kind, payload): foldOrchestratorState
// only ever reads these two fields, so it takes this narrower shape rather
// than importing JournalRecord's full envelope, keeping the fold decoupled
// from journal.ts's hash-chain fields.
export interface JournalRecordLike {
  readonly kind: string;
  readonly payload: JsonValue;
}

// Pure: reconstructs all three entity sets from creation and transition
// records alone. An intent with no matching outcome leaves its entity at
// the pre-transition ("from") state, flagged needsReconcile: true, since the
// outcome (and therefore whether the move actually completed) is unknown
// (B-6). Pairing is per entity id, which is stronger than journal.ts's own
// per-op unresolvedIntents pairing: every transition record carries its
// entity's id in the payload, so an intent is resolved by the next outcome
// naming that same id, not merely the next outcome of the op.
export function foldOrchestratorState(records: readonly JournalRecordLike[]): OrchestratorState {
  const runs = new Map<string, FoldedRun>();
  const specExecs = new Map<string, FoldedSpecExec>();
  const stageExecs = new Map<string, FoldedStageExec>();
  const pendingIntents = new Map<string, TransitionPayload>();

  for (const r of records) {
    if (r.kind === "run.created") {
      const run = parseRun(r.payload);
      runs.set(run.id, { ...run, needsReconcile: false });
    } else if (r.kind === "specexec.created") {
      const specExec = parseSpecExec(r.payload);
      specExecs.set(specExec.id, { ...specExec, needsReconcile: false });
    } else if (r.kind === "stageexec.created") {
      const stageExec = parseStageExec(r.payload);
      stageExecs.set(stageExec.id, { ...stageExec, needsReconcile: false });
    } else if (r.kind === "state.transition.intent") {
      const parsed = parseTransitionPayload(r.payload);
      pendingIntents.set(parsed.id, parsed);
    } else if (r.kind === "state.transition.outcome") {
      const parsed = parseTransitionPayload(r.payload);
      pendingIntents.delete(parsed.id);
      applyOutcome(parsed, runs, specExecs, stageExecs);
    }
  }

  for (const [id, intent] of pendingIntents) {
    flagNeedsReconcile(intent.entity, id, runs, specExecs, stageExecs);
  }

  return { runs, specExecs, stageExecs };
}

function applyOutcome(
  parsed: TransitionPayload,
  runs: Map<string, FoldedRun>,
  specExecs: Map<string, FoldedSpecExec>,
  stageExecs: Map<string, FoldedStageExec>
): void {
  if (parsed.entity === "run") {
    const run = runs.get(parsed.id);
    if (!run) return;
    runs.set(parsed.id, { ...(applyTransition("run", run, parsed.to) as Run), needsReconcile: false });
  } else if (parsed.entity === "specExec") {
    const specExec = specExecs.get(parsed.id);
    if (!specExec) return;
    specExecs.set(parsed.id, { ...(applyTransition("specExec", specExec, parsed.to) as SpecExec), needsReconcile: false });
  } else {
    const stageExec = stageExecs.get(parsed.id);
    if (!stageExec) return;
    stageExecs.set(parsed.id, {
      ...(applyTransition("stageExec", stageExec, parsed.to) as StageExec),
      needsReconcile: false,
    });
  }
}

function flagNeedsReconcile(
  entity: EntityKind,
  id: string,
  runs: Map<string, FoldedRun>,
  specExecs: Map<string, FoldedSpecExec>,
  stageExecs: Map<string, FoldedStageExec>
): void {
  if (entity === "run") {
    const run = runs.get(id);
    if (run) runs.set(id, { ...run, needsReconcile: true });
  } else if (entity === "specExec") {
    const specExec = specExecs.get(id);
    if (specExec) specExecs.set(id, { ...specExec, needsReconcile: true });
  } else {
    const stageExec = stageExecs.get(id);
    if (stageExec) stageExecs.set(id, { ...stageExec, needsReconcile: true });
  }
}

// --- predicates (FR-003) ----------------------------------------------------

// isLive: the entity is actively being driven forward by the orchestrator's
// own pipeline, without waiting on an external trigger (quota resume, human
// resume, or an upstream drift's re-verification). For SpecExec this is
// exactly the set B-3's own prose names "any live state" (pending through
// verifying); Run and StageExec extend the same reading to their own
// actively-progressing states.
const RUN_LIVE: ReadonlySet<RunStatus> = new Set(["idle", "running"]);
const SPEC_EXEC_LIVE: ReadonlySet<SpecExecStatus> = new Set([
  "pending",
  "building",
  "shipping",
  "shepherding",
  "verifying",
]);
const STAGE_EXEC_LIVE: ReadonlySet<StageExecStatus> = new Set(["queued", "running"]);

// isTerminal: a state with no outgoing edge anywhere in that entity kind's
// own transition table (a graph sink). Run and StageExec each have such
// sinks; SpecExec does not (shipped can invalidate, failed can retry,
// invalidated re-verifies), so isTerminal is false for every SpecExec
// status. isLive and isTerminal are not required to partition every status:
// Run's parked and paused are neither (waiting on an external resume, not
// self-progressing, not done). See spec 013 Resolved decisions, D-2.
const RUN_TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed"]);
const SPEC_EXEC_TERMINAL: ReadonlySet<SpecExecStatus> = new Set();
const STAGE_EXEC_TERMINAL: ReadonlySet<StageExecStatus> = new Set(["passed", "failed", "blocked"]);

export function isTerminal(run: Run): boolean;
export function isTerminal(specExec: SpecExec): boolean;
export function isTerminal(stageExec: StageExec): boolean;
export function isTerminal(x: Run | SpecExec | StageExec): boolean {
  if (isStageExec(x)) return STAGE_EXEC_TERMINAL.has(x.status);
  if (isSpecExec(x)) return SPEC_EXEC_TERMINAL.has(x.status);
  return RUN_TERMINAL.has(x.status);
}

export function isLive(run: Run): boolean;
export function isLive(specExec: SpecExec): boolean;
export function isLive(stageExec: StageExec): boolean;
export function isLive(x: Run | SpecExec | StageExec): boolean {
  if (isStageExec(x)) return STAGE_EXEC_LIVE.has(x.status);
  if (isSpecExec(x)) return SPEC_EXEC_LIVE.has(x.status);
  return RUN_LIVE.has(x.status);
}

// needsHuman is purely state-derived, per entity kind, with no
// retry-budget or scheduling-policy accounting (that is this spec's
// declared Out of scope): a paused Run, a blocked StageExec, and a failed
// SpecExec always qualify, full stop. See Resolved decisions, D-1.
export function needsHuman(run: Run): boolean;
export function needsHuman(specExec: SpecExec): boolean;
export function needsHuman(stageExec: StageExec): boolean;
export function needsHuman(x: Run | SpecExec | StageExec): boolean {
  if (isStageExec(x)) return x.status === "blocked";
  if (isSpecExec(x)) return x.status === "failed";
  return x.status === "paused";
}
