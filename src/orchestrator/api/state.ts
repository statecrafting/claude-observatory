// The read models behind every GET route (spec 022 B-3, B-6; spec 027 B-3,
// B-4). Each function here is pure over journal records plus, where the DAG
// needs it, a registry snapshot and a pin lookup: there is no cached status
// anywhere in this module that could disagree with a fold, because there is
// no cache at all. Unknowns are serialized as explicit nulls (B-6), never as
// a plausible default: a spec with no `implementation` field is `null`, not
// "pending"; a quota state with no park ever journaled has `targetMs: null`,
// not 0.
//
// v2 scoping (027 B-3) shows up here as one extra argument: the project name
// each view is folded for, carried into the payload so a response can never
// be read as if it described "the one repo". The folds themselves are
// unchanged; a project's journal is still just a journal.
import type { JournalRecord, JsonValue } from "../journal";
import { foldState } from "../journal";
import type { OrchestratorState, FoldedStageExec } from "../state";
import { foldOrchestratorState } from "../state";
import type { DagReader, PinLookup, RegistrySnapshot, RegistrySpecEntry, ShippedEntry, ShippedMap } from "../dag";
import { findCycle, invalidatedSet, nextReady, pinOf, pinOfBytes, statusSchedulable } from "../dag";
import { foldQuotaState, shouldWarn } from "../quota";
import { economicsView, type EconomicsView } from "../economics";
import type { DecisionQuery, DecisionRecord } from "../decisions";
import { decisionRecordsFromChain, queryDecisions } from "../decisions";
import type { Project } from "../projects";
import type {
  DagSpecNode,
  DagView,
  DecisionQueryParams,
  DecisionsView,
  HistoryEntry,
  HistoryStage,
  HistoryView,
  ProjectView,
  ProjectsView,
  QuotaView,
  RunSummary,
  RunView,
  SpecBlockerView,
  SpecExecSummary,
  StageExecSummary,
} from "./types";

// --- small payload readers --------------------------------------------------

function isJsonRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(payload: JsonValue, field: string): string | null {
  if (!isJsonRecord(payload)) return null;
  const v = payload[field];
  return typeof v === "string" ? v : null;
}

function numberField(payload: JsonValue, field: string): number | null {
  if (!isJsonRecord(payload)) return null;
  const v = payload[field];
  return typeof v === "number" ? v : null;
}

// --- shipped-set (spec 012 D-1) ---------------------------------------------

// The latest journaled merge sha per spec (spec 021 D-16): a pipeline-
// shipped spec's contract is the content its own merge landed, so the pin
// is derived from the file at that sha, not from the pre-flip content the
// exec was pinned at when scheduled.
function mergeShaBySpec(records: readonly JournalRecord[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "daemon.merge-sha") continue;
    const specId = stringField(record.payload, "specId");
    const mergeSha = stringField(record.payload, "mergeSha");
    if (specId !== null && mergeSha !== null) out.set(specId, mergeSha);
  }
  return out;
}

// The same sources the daemon's own computeShippedMap composes: the
// one-time `dag.adopted` record (bootstrap-era specs, pinned at first
// observation), every `dag.adopted.refreshed` re-adoption replayed over it,
// every SpecExec this journal shows reaching `shipped` (pinned per 021 D-16
// at the file the journaled merge sha landed, when the reader can see it),
// and every `spec.requalified` re-pin replayed last (021 D-18, latest
// wins). Recomputed from records on every request rather than read from a
// cached map, so the API can never report a shipped-set the journal does
// not support (B-6); a fold missing D-16 or D-18 reports pin drift the
// scheduler has already resolved, which is exactly the cached-status
// disagreement B-6 forbids (found live: after 023/026 requalified, status
// still rendered their old blocker list while the daemon built 028).
export function shippedMapFromJournal(
  records: readonly JournalRecord[],
  readSpecFileAtSha?: (sha: string, specId: string) => Buffer | null
): ShippedMap {
  const out = new Map<string, ShippedEntry>();
  let adoptionSeen = false;

  for (const record of records) {
    // Spec 021 D-4: the adoption record is written once and immutable, so
    // only the first one counts; a later one cannot rewrite the bootstrap.
    if (record.kind === "dag.adopted" && !adoptionSeen) {
      if (!isJsonRecord(record.payload) || !Array.isArray(record.payload.entries)) continue;
      adoptionSeen = true;
      for (const raw of record.payload.entries) {
        const id = stringField(raw, "id");
        const pin = stringField(raw, "pin");
        const source = stringField(raw, "source");
        if (id === null || pin === null) continue;
        out.set(id, { pin, source: source === "pipeline" ? "pipeline" : "adopted" });
      }
      continue;
    }

    // Spec 021 D-11: an amended bootstrap-era spec is re-adopted at its new
    // pin rather than invalidating the backlog, and the daemon journals that
    // as its own record instead of rewriting the immutable one above.
    // Replaying it here is what keeps this fold equal to the daemon's; a fold
    // that stopped at `dag.adopted` would report the superseded pin and
    // cascade an invalidation the daemon does not believe in.
    if (record.kind === "dag.adopted.refreshed") {
      const id = stringField(record.payload, "id");
      const newPin = stringField(record.payload, "newPin");
      if (id !== null && newPin !== null) out.set(id, { pin: newPin, source: "adopted" });
    }
  }

  const mergeShas = mergeShaBySpec(records);
  const state = foldOrchestratorState(records);
  for (const specExec of state.specExecs.values()) {
    if (specExec.status !== "shipped") continue;
    let pin = specExec.pin;
    const sha = mergeShas.get(specExec.specId);
    if (sha !== undefined && readSpecFileAtSha) {
      const bytes = readSpecFileAtSha(sha, specExec.specId);
      // An unreadable file falls back to the exec pin, which can only
      // over-invalidate, never under-invalidate (021 D-16).
      if (bytes) pin = pinOfBytes(bytes);
    }
    out.set(specExec.specId, { pin, source: "pipeline" });
  }

  // 021 D-18: a successful requalification re-pins the shipped entry at the
  // amended content it verified; records replay in order, latest wins.
  for (const record of records) {
    if (record.kind !== "spec.requalified") continue;
    const specId = stringField(record.payload, "specId");
    const pin = stringField(record.payload, "pin");
    if (specId !== null && pin !== null && out.get(specId)?.source === "pipeline") {
      out.set(specId, { pin, source: "pipeline" });
    }
  }
  return out;
}

// --- pins -------------------------------------------------------------------

export interface SafePins {
  // A PinLookup that never throws, for handing to dag.ts's pure functions.
  readonly lookup: PinLookup;
  // The pin actually read, or null when the spec file could not be read.
  readonly pins: ReadonlyMap<string, string | null>;
  readonly errors: ReadonlyMap<string, string>;
}

// dag.ts's `pinOf` throws when a spec file cannot be read, which would turn
// one missing file into a 500 for the whole DAG view. Reads are attempted
// once per id and memoized; a failure surfaces as `currentPin: null` plus a
// `pinError` on that node. The lookup handed to invalidatedSet/nextReady
// falls back to the pin recorded when the spec shipped, so a failed read is
// reported as a read failure and never as pin drift (which would cascade an
// invalidation across every dependent on the strength of an I/O error).
export function makeSafePins(
  reader: DagReader,
  repoDir: string,
  ids: Iterable<string>,
  shipped: ShippedMap
): SafePins {
  const pins = new Map<string, string | null>();
  const errors = new Map<string, string>();

  const read = (id: string): void => {
    if (pins.has(id)) return;
    try {
      pins.set(id, pinOf(reader, repoDir, id));
    } catch (err) {
      pins.set(id, null);
      errors.set(id, (err as Error).message);
    }
  };

  for (const id of ids) read(id);
  for (const id of shipped.keys()) read(id);

  const lookup: PinLookup = (id: string): string => {
    read(id);
    const pin = pins.get(id) ?? null;
    if (pin !== null) return pin;
    return shipped.get(id)?.pin ?? "";
  };

  return { lookup, pins, errors };
}

// --- DAG view (B-3) ---------------------------------------------------------

// The per-node blocker wording is this API's own surface text, deliberately
// phrased like dag.ts's nextReady blockers so the two read alike, but
// computed here for every spec rather than only for the pending ones
// nextReady reports on.
function blockerReasons(
  entry: RegistrySpecEntry,
  snapshot: RegistrySnapshot,
  shipped: ShippedMap,
  invalid: ReadonlySet<string>
): string[] {
  const reasons: string[] = [];
  // 012 D-3: an unapproved spec is reported here exactly like nextReady
  // reports it, so the UI never renders a draft as merely dependency-blocked.
  if (!statusSchedulable(entry)) reasons.push(`status ${entry.status} is not approved`);
  for (const dep of entry.dependsOn) {
    if (shipped.has(dep) && !invalid.has(dep)) continue;
    if (!snapshot.has(dep)) reasons.push(`dependency ${dep} is not in the registry`);
    else if (invalid.has(dep)) reasons.push(`dependency ${dep} is invalidated (pin drift)`);
    else if (!shipped.has(dep)) reasons.push(`dependency ${dep} is not shipped`);
    else reasons.push(`dependency ${dep} is not ready`);
  }
  return reasons;
}

// Every spec an operator has skipped through a control (spec 021 B-4).
export function skippedFromJournal(records: readonly JournalRecord[]): ReadonlySet<string> {
  const skipped = new Set<string>();
  for (const record of records) {
    if (record.kind !== "control.skipSpec") continue;
    const specId = stringField(record.payload, "specId");
    if (specId !== null) skipped.add(specId);
  }
  return skipped;
}

// The same override spec 021 D-5 applies before every `nextReady` call: the
// target repo's registry only flips a spec's `implementation` once the build
// session's frontmatter edit is merged and re-read, so a spec this journal
// already shows shipped (or an operator has skipped) is masked here rather
// than being offered again as the next thing to run. Without this the API
// would answer "next: 002-beta" while the daemon is demonstrably past it,
// which is exactly the cached-status disagreement B-6 forbids.
export function workingSnapshot(
  snapshot: RegistrySnapshot,
  shipped: ShippedMap,
  skipped: ReadonlySet<string>
): RegistrySnapshot {
  if (shipped.size === 0 && skipped.size === 0) return snapshot;
  const out = new Map<string, RegistrySpecEntry>(snapshot);
  for (const [id, entry] of snapshot) {
    if (shipped.has(id)) out.set(id, { ...entry, implementation: "orchestrator-shipped" });
    else if (skipped.has(id)) out.set(id, { ...entry, implementation: "orchestrator-skipped" });
  }
  return out;
}

export interface DagViewInput {
  // The project this fold is for (027 B-3); it names the answer, and every
  // other field below belongs to that project alone.
  readonly project: string;
  readonly records: readonly JournalRecord[];
  readonly snapshot: RegistrySnapshot;
  readonly reader: DagReader;
  readonly repoDir: string;
  // 021 D-16's read, so this view resolves pipeline pins exactly like the
  // scheduler does. Absent (fixtures) falls back to exec creation pins.
  readonly readSpecFileAtSha?: (sha: string, specId: string) => Buffer | null;
}

export function dagView(input: DagViewInput): DagView {
  const { records, snapshot, reader, repoDir } = input;
  const shipped = shippedMapFromJournal(records, input.readSpecFileAtSha);
  const skipped = skippedFromJournal(records);
  const pins = makeSafePins(reader, repoDir, snapshot.keys(), shipped);
  const invalid = invalidatedSet(snapshot, shipped, pins.lookup);
  const working = workingSnapshot(snapshot, shipped, skipped);

  const state = foldOrchestratorState(records);
  const currentRunId = latestRunId(state);
  const specExecStatusBySpecId = new Map<string, string>();
  for (const specExec of state.specExecs.values()) {
    if (currentRunId !== null && specExec.runId !== currentRunId) continue;
    specExecStatusBySpecId.set(specExec.specId, specExec.status);
  }

  // A cycle among unshipped specs makes nextReady refuse outright (spec 012
  // B-5). The cycle is reported as its own field either way, so a client can
  // render the refusal instead of an empty, unexplained schedule.
  const cycle = findCycle(snapshot);
  let nextReadyId: string | null = null;
  let blockers: SpecBlockerView[] = [];
  try {
    const result = nextReady(working, shipped, pins.lookup);
    if (typeof result === "string") nextReadyId = result;
    else blockers = result.blockers.map((b) => ({ specId: b.specId, reasons: [...b.reasons] }));
  } catch {
    // Refused by the cycle already reported above; no schedule to offer.
  }

  const specs: DagSpecNode[] = [];
  for (const [id, entry] of snapshot) {
    const shippedEntry = shipped.get(id) ?? null;
    const currentPin = pins.pins.get(id) ?? null;
    const reasons = blockerReasons(entry, snapshot, shipped, invalid);
    specs.push({
      id,
      implementation: entry.implementation ?? null,
      dependsOn: [...entry.dependsOn],
      shipped: shippedEntry !== null,
      shippedSource: shippedEntry?.source ?? null,
      shippedPin: shippedEntry?.pin ?? null,
      currentPin,
      pinError: pins.errors.get(id) ?? null,
      drifted: shippedEntry !== null && currentPin !== null && shippedEntry.pin !== currentPin,
      invalidated: invalid.has(id),
      skipped: skipped.has(id),
      ready: reasons.length === 0,
      blockers: reasons,
      specExecStatus: (specExecStatusBySpecId.get(id) as DagSpecNode["specExecStatus"]) ?? null,
    });
  }

  return {
    project: input.project,
    specs,
    nextReady: nextReadyId,
    blockers,
    cycle: cycle ? [...cycle] : null,
    invalidated: [...invalid].sort(),
  };
}

// --- run view (B-3) ---------------------------------------------------------

function latestRunId(state: OrchestratorState): string | null {
  const runs = [...state.runs.values()].sort((a, b) => a.createdTs.localeCompare(b.createdTs));
  return runs.at(-1)?.id ?? null;
}

function specBlockersFromPayload(payload: JsonValue): SpecBlockerView[] {
  if (!isJsonRecord(payload) || !Array.isArray(payload.blockers)) return [];
  const out: SpecBlockerView[] = [];
  for (const raw of payload.blockers) {
    const specId = stringField(raw, "specId");
    if (specId === null) continue;
    const reasons =
      isJsonRecord(raw) && Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === "string") : [];
    out.push({ specId, reasons });
  }
  return out;
}

// Which specs are currently held behind an unreleased human gate: the daemon
// journals `daemon.gate.waiting` before it starts waiting and
// `control.approve` when the gate is released, so replaying both in order
// gives the still-waiting set without any live daemon state.
function awaitingApprovalFrom(records: readonly JournalRecord[]): string[] {
  const waiting = new Set<string>();
  for (const record of records) {
    if (record.kind === "daemon.gate.waiting") {
      const specId = stringField(record.payload, "specId");
      if (specId !== null) waiting.add(specId);
    } else if (record.kind === "control.approve") {
      const specId = stringField(record.payload, "specId");
      if (specId !== null) waiting.delete(specId);
    }
  }
  return [...waiting];
}

export function runView(records: readonly JournalRecord[], project: string): RunView {
  const state = foldOrchestratorState(records);
  const runId = latestRunId(state);
  const run = runId === null ? null : (state.runs.get(runId) ?? null);

  let spec: SpecExecSummary | null = null;
  if (run !== null) {
    // Insertion order is creation order, so the last match is the newest.
    let newest: SpecExecSummary | null = null;
    let newestLive: SpecExecSummary | null = null;
    for (const se of state.specExecs.values()) {
      if (se.runId !== run.id) continue;
      const summary: SpecExecSummary = {
        id: se.id,
        specId: se.specId,
        pin: se.pin,
        attempt: se.attempt,
        status: se.status,
        needsReconcile: se.needsReconcile,
      };
      newest = summary;
      if (se.status !== "shipped" && se.status !== "failed") newestLive = summary;
    }
    spec = newestLive ?? newest;
  }

  let stage: StageExecSummary | null = null;
  if (spec !== null) {
    let newest: FoldedStageExec | null = null;
    for (const se of state.stageExecs.values()) {
      if (se.specExecId === spec.id) newest = se;
    }
    if (newest !== null) {
      stage = {
        id: newest.id,
        stage: newest.stage,
        attempt: newest.attempt,
        status: newest.status,
        needsReconcile: newest.needsReconcile,
      };
    }
  }

  let pauseReason: string | null = null;
  let blockers: SpecBlockerView[] = [];
  let lastHeartbeatMs: number | null = null;
  for (const record of records) {
    if (record.kind === "run.pause-reason") pauseReason = stringField(record.payload, "reason");
    else if (record.kind === "run.blocked") blockers = specBlockersFromPayload(record.payload);
    else if (record.kind === "daemon.heartbeat") lastHeartbeatMs = numberField(record.payload, "ts");
  }
  // A pause reason only describes the pause it belongs to; once the run is
  // moving again it is history, not current state.
  if (run === null || run.status !== "paused") pauseReason = null;

  const summary: RunSummary | null =
    run === null
      ? null
      : {
          id: run.id,
          targetRepo: run.targetRepo,
          createdTs: run.createdTs,
          status: run.status,
          needsReconcile: run.needsReconcile,
        };

  return {
    project,
    run: summary,
    spec,
    stage,
    pauseReason,
    blockers,
    lastHeartbeatMs,
    awaitingApproval: awaitingApprovalFrom(records),
  };
}

// --- the project collection (027 B-2) ---------------------------------------

export interface ProjectRowInput {
  // The registry's own record of this project (spec 025), verdict included.
  readonly project: Project;
  // That project's work journal. Deferred rather than passed as an array so a
  // state root that cannot be read fails per row, with the reason attached,
  // instead of taking the whole collection down.
  readonly records: () => readonly JournalRecord[];
}

// The folded registry with a current-run summary per project (B-2). Every
// project the registry carries appears, armed or not, qualified or not: 025
// B-4 keeps a refused target visible with its reasons, and hiding it here
// would undo that.
export function projectsView(rows: readonly ProjectRowInput[]): ProjectsView {
  const projects: ProjectView[] = [];
  for (const row of rows) {
    const { project } = row;
    const base = {
      name: project.name,
      repoDir: project.repoDir,
      armed: project.armed,
      qualification: project.qualification,
      // 032 B-6: the posture travels with every row, on the read path that
      // cannot fail, so no client ever renders a project without one.
      profile: project.profile,
    };
    try {
      const view = runView(row.records(), project.name);
      projects.push({ ...base, run: view.run, spec: view.spec, stage: view.stage, readError: null });
    } catch (err) {
      projects.push({ ...base, run: null, spec: null, stage: null, readError: (err as Error).message });
    }
  }
  return { projects };
}

// --- quota view (027 B-4) ---------------------------------------------------

export interface ProjectQuotaInput {
  readonly project: string;
  readonly records: readonly JournalRecord[];
}

// The last quota record in a chain, whichever kind: the moment this project
// last said anything about the pool, which is how the pool's current holder
// is chosen below.
function lastQuotaTs(records: readonly JournalRecord[]): string | null {
  let ts: string | null = null;
  for (const record of records) {
    if (record.kind === "quota.parked" || record.kind === "quota.resumed") ts = record.ts;
  }
  return ts;
}

// Quota stays global (B-4): the account's quota is one pool (026 B-5), so
// this is a fold across every registered project's journal rather than one
// project's. At most one run holds the flight slot (010 D15), so at most one
// project can be parked right now; that project's park is the pool's state.
// With nothing parked, the most recently journaled park is what the streak
// counter is read from, and the project it came from is named rather than
// implied.
export function quotaView(projects: readonly ProjectQuotaInput[], nowMs: number): QuotaView {
  let holder: { project: string; parked: boolean; ts: string; targetMs: number; estimated: boolean; streak: number } | null = null;

  for (const entry of projects) {
    const folded = foldQuotaState(entry.records);
    if (folded.lastPark === null) continue;
    const ts = lastQuotaTs(entry.records) ?? "";
    const candidate = {
      project: entry.project,
      parked: folded.parked,
      ts,
      targetMs: folded.lastPark.targetMs,
      estimated: folded.lastPark.estimated,
      streak: folded.lastPark.consecutiveQuotaParks,
    };
    // A parked project outranks an unparked one whatever the timestamps say:
    // the pool is held now, and a later `quota.resumed` elsewhere does not
    // release it.
    if (holder === null) holder = candidate;
    else if (candidate.parked && !holder.parked) holder = candidate;
    else if (candidate.parked === holder.parked && candidate.ts > holder.ts) holder = candidate;
  }

  return {
    parked: holder?.parked ?? false,
    project: holder?.project ?? null,
    targetMs: holder?.targetMs ?? null,
    estimated: holder?.estimated ?? null,
    msUntilTarget: holder === null ? null : holder.targetMs - nowMs,
    consecutiveQuotaParks: holder?.streak ?? 0,
    warn: shouldWarn(holder?.streak ?? 0),
    nowMs,
  };
}

// --- economics view (spec 030 B-3) ------------------------------------------

// The fold as served: spec 030's pure economicsView plus the one field only
// the serving side can add honestly, the daemon's own clock reading at
// response time (030 FR-002). Recomputed from records on every request like
// the dag and run views (022 B-6): there is no cached rollup the journal
// could disagree with.
export interface ServedEconomicsView extends EconomicsView {
  readonly generatedAt: number;
}

export function servedEconomicsView(
  records: readonly JournalRecord[],
  project: string,
  nowMs: number
): ServedEconomicsView {
  return { ...economicsView(records, project), generatedAt: nowMs };
}

// --- decisions view (B-3, spec 020 B-5) -------------------------------------

export function decisionsView(
  records: readonly JournalRecord[],
  params: DecisionQueryParams,
  project: string
): DecisionsView {
  const chain: DecisionRecord[] = decisionRecordsFromChain(foldState(records));
  const query: DecisionQuery = {
    ...(params.specId !== undefined ? { specId: params.specId } : {}),
    ...(params.path !== undefined ? { path: params.path } : {}),
    ...(params.query !== undefined ? { text: params.query } : {}),
  };
  const matched = queryDecisions(chain, query);
  return { project, query: params, total: matched.length, decisions: matched };
}

// --- history view (B-3) -----------------------------------------------------

interface EvidenceAccumulator {
  prNumber: number | null;
  mergeSha: string | null;
  ciConclusion: string | null;
  verifyVerdict: string | null;
  evidenceRefs: string[];
}

function emptyAccumulator(): EvidenceAccumulator {
  return { prNumber: null, mergeSha: null, ciConclusion: null, verifyVerdict: null, evidenceRefs: [] };
}

// Stage result records carry a specId, not a specExecId, so attribution is
// done by replaying the journal in order and crediting each stage record to
// whichever SpecExec for that spec was most recently created. That is exact
// under the serial loop spec 021 B-3 guarantees (one spec walked at a time,
// a retry minting a fresh SpecExec before its stages run).
//
// evidenceRefs lists only hashes of files the verify stage actually wrote
// into the evidence directory, which are the hashes /api/evidence/<hash> can
// serve. Shepherd's `logTailHash` is a hash of a CI log that was never
// written to disk, so it is deliberately not offered here as if it were
// fetchable.
export function historyView(records: readonly JournalRecord[], project: string): HistoryView {
  const state = foldOrchestratorState(records);

  const stagesBySpecExec = new Map<string, HistoryStage[]>();
  for (const stageExec of state.stageExecs.values()) {
    const list = stagesBySpecExec.get(stageExec.specExecId) ?? [];
    list.push({
      id: stageExec.id,
      stage: stageExec.stage,
      attempt: stageExec.attempt,
      status: stageExec.status,
      needsReconcile: stageExec.needsReconcile,
    });
    stagesBySpecExec.set(stageExec.specExecId, list);
  }

  const evidenceBySpecExec = new Map<string, EvidenceAccumulator>();
  const currentBySpecId = new Map<string, string>();

  const accumulatorFor = (specId: string | null): EvidenceAccumulator | null => {
    if (specId === null) return null;
    const specExecId = currentBySpecId.get(specId);
    if (specExecId === undefined) return null;
    const existing = evidenceBySpecExec.get(specExecId);
    if (existing) return existing;
    const fresh = emptyAccumulator();
    evidenceBySpecExec.set(specExecId, fresh);
    return fresh;
  };

  for (const record of records) {
    if (record.kind === "specexec.created") {
      const id = stringField(record.payload, "id");
      const specId = stringField(record.payload, "specId");
      if (id !== null && specId !== null) currentBySpecId.set(specId, id);
      continue;
    }

    const specId = stringField(record.payload, "specId");
    const acc = accumulatorFor(specId);
    if (acc === null) continue;

    switch (record.kind) {
      case "stage.ship.result": {
        const prNumber = numberField(record.payload, "prNumber");
        if (prNumber !== null) acc.prNumber = prNumber;
        break;
      }
      case "stage.shepherd.result": {
        acc.ciConclusion = stringField(record.payload, "outcome");
        const prNumber = numberField(record.payload, "prNumber");
        if (prNumber !== null) acc.prNumber = prNumber;
        const mergeSha = stringField(record.payload, "mergeSha");
        if (mergeSha !== null) acc.mergeSha = mergeSha;
        break;
      }
      case "daemon.merge-sha": {
        const mergeSha = stringField(record.payload, "mergeSha");
        if (mergeSha !== null) acc.mergeSha = mergeSha;
        break;
      }
      case "stage.verify.result": {
        acc.verifyVerdict = stringField(record.payload, "outcome");
        break;
      }
      case "stage.verify.cli": {
        const hash = stringField(record.payload, "evidenceHash");
        if (hash !== null) acc.evidenceRefs.push(hash);
        break;
      }
      case "stage.verify.browser": {
        const detailHash = stringField(record.payload, "detailHash");
        if (detailHash !== null) acc.evidenceRefs.push(detailHash);
        const screenshotHash = stringField(record.payload, "screenshotHash");
        if (screenshotHash !== null) acc.evidenceRefs.push(screenshotHash);
        break;
      }
      default:
        break;
    }
  }

  const entries: HistoryEntry[] = [];
  for (const specExec of state.specExecs.values()) {
    const acc = evidenceBySpecExec.get(specExec.id) ?? emptyAccumulator();
    entries.push({
      specExecId: specExec.id,
      runId: specExec.runId,
      specId: specExec.specId,
      pin: specExec.pin,
      attempt: specExec.attempt,
      status: specExec.status,
      needsReconcile: specExec.needsReconcile,
      stages: stagesBySpecExec.get(specExec.id) ?? [],
      prNumber: acc.prNumber,
      mergeSha: acc.mergeSha,
      ciConclusion: acc.ciConclusion,
      verifyVerdict: acc.verifyVerdict,
      evidenceRefs: acc.evidenceRefs,
    });
  }

  return { project, entries };
}
