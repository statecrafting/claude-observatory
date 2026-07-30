// The read models behind every GET route (spec 022 B-3, B-6). Each function
// here is pure over journal records plus, where the DAG needs it, a registry
// snapshot and a pin lookup: there is no cached status anywhere in this
// module that could disagree with a fold, because there is no cache at all.
// Unknowns are serialized as explicit nulls (B-6), never as a plausible
// default: a spec with no `implementation` field is `null`, not "pending";
// a quota state with no park ever journaled has `targetMs: null`, not 0.
import type { JournalRecord, JsonValue } from "../journal";
import { foldState } from "../journal";
import type { OrchestratorState, FoldedStageExec } from "../state";
import { foldOrchestratorState } from "../state";
import type { DagReader, PinLookup, RegistrySnapshot, RegistrySpecEntry, ShippedEntry, ShippedMap } from "../dag";
import { findCycle, invalidatedSet, nextReady, pinOf } from "../dag";
import { foldQuotaState, shouldWarn } from "../quota";
import type { DecisionQuery, DecisionRecord } from "../decisions";
import { decisionRecordsFromChain, queryDecisions } from "../decisions";
import type {
  DagSpecNode,
  DagView,
  DecisionQueryParams,
  DecisionsView,
  HistoryEntry,
  HistoryStage,
  HistoryView,
  QuotaView,
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

// The same three sources the daemon's own computeShippedMap composes: the
// one-time `dag.adopted` record (bootstrap-era specs, pinned at first
// observation), every `dag.adopted.refreshed` re-adoption replayed over it,
// plus every SpecExec this journal shows reaching `shipped`. Recomputed from
// records on every request rather than read from a cached map, so the API
// can never report a shipped-set the journal does not support (B-6).
export function shippedMapFromJournal(records: readonly JournalRecord[]): ShippedMap {
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

  const state = foldOrchestratorState(records);
  for (const specExec of state.specExecs.values()) {
    if (specExec.status === "shipped") out.set(specExec.specId, { pin: specExec.pin, source: "pipeline" });
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
  dependsOn: readonly string[],
  snapshot: RegistrySnapshot,
  shipped: ShippedMap,
  invalid: ReadonlySet<string>
): string[] {
  const reasons: string[] = [];
  for (const dep of dependsOn) {
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
  readonly records: readonly JournalRecord[];
  readonly snapshot: RegistrySnapshot;
  readonly reader: DagReader;
  readonly repoDir: string;
}

export function dagView(input: DagViewInput): DagView {
  const { records, snapshot, reader, repoDir } = input;
  const shipped = shippedMapFromJournal(records);
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
    const reasons = blockerReasons(entry.dependsOn, snapshot, shipped, invalid);
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

export function runView(records: readonly JournalRecord[]): RunView {
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

  return {
    run:
      run === null
        ? null
        : {
            id: run.id,
            targetRepo: run.targetRepo,
            createdTs: run.createdTs,
            status: run.status,
            needsReconcile: run.needsReconcile,
          },
    spec,
    stage,
    pauseReason,
    blockers,
    lastHeartbeatMs,
    awaitingApproval: awaitingApprovalFrom(records),
  };
}

// --- quota view (B-3) -------------------------------------------------------

export function quotaView(records: readonly JournalRecord[], nowMs: number): QuotaView {
  const folded = foldQuotaState(records);
  const lastPark = folded.lastPark;
  return {
    parked: folded.parked,
    targetMs: lastPark?.targetMs ?? null,
    estimated: lastPark?.estimated ?? null,
    msUntilTarget: lastPark ? lastPark.targetMs - nowMs : null,
    consecutiveQuotaParks: lastPark?.consecutiveQuotaParks ?? 0,
    warn: shouldWarn(lastPark?.consecutiveQuotaParks ?? 0),
    nowMs,
  };
}

// --- decisions view (B-3, spec 020 B-5) -------------------------------------

export function decisionsView(records: readonly JournalRecord[], params: DecisionQueryParams): DecisionsView {
  const chain: DecisionRecord[] = decisionRecordsFromChain(foldState(records));
  const query: DecisionQuery = {
    ...(params.specId !== undefined ? { specId: params.specId } : {}),
    ...(params.path !== undefined ? { path: params.path } : {}),
    ...(params.query !== undefined ? { text: params.query } : {}),
  };
  const matched = queryDecisions(chain, query);
  return { query: params, total: matched.length, decisions: matched };
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
export function historyView(records: readonly JournalRecord[]): HistoryView {
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

  return { entries };
}
