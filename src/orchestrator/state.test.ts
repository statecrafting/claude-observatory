import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, appendIntent, foldState } from "./journal";
import type { JournalHandle, JournalRecord, JsonValue, FoldedState } from "./journal";
import {
  RUN_TRANSITIONS,
  SPEC_EXEC_TRANSITIONS,
  STAGE_EXEC_TRANSITIONS,
  transition,
  createRun,
  createSpecExec,
  createStageExec,
  foldOrchestratorState,
  InvalidTransitionError,
  isTerminal,
  isLive,
  needsHuman,
  type Run,
  type RunStatus,
  type SpecExec,
  type SpecExecStatus,
  type StageExec,
  type StageExecStatus,
} from "./state";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "state-test-"));
}

// --- generic graph walk (FR-001) -------------------------------------------

// Shortest path from `start` to every other state reachable in `table`,
// computed from the graph alone (no journal involved): used below to drive
// one real transition() call per edge on the path, so "every state is
// reachable" is asserted against actual transition() behavior, not just the
// table's own shape.
function shortestPaths<S extends string>(table: Readonly<Record<S, readonly S[]>>, start: S): Map<S, S[]> {
  const paths = new Map<S, S[]>();
  paths.set(start, [start]);
  const queue: S[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of table[cur]) {
      if (!paths.has(next)) {
        paths.set(next, [...paths.get(cur)!, next]);
        queue.push(next);
      }
    }
  }
  return paths;
}

// --- FR-001: every named state is reachable via legal transitions ---------

test("FR-001: every Run state is reachable via legal transitions", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const paths = shortestPaths(RUN_TRANSITIONS, "idle" as RunStatus);
  const allStates = (Object.keys(RUN_TRANSITIONS) as RunStatus[]).sort();
  expect([...paths.keys()].sort()).toEqual(allStates);

  for (const target of allStates) {
    const path = paths.get(target)!;
    let run = createRun(handle, "acme/repo");
    for (const to of path.slice(1)) run = transition(handle, run, to);
    expect(run.status).toBe(target);
  }
  handle.close();
});

test("FR-001: every SpecExec state is reachable via legal transitions", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const paths = shortestPaths(SPEC_EXEC_TRANSITIONS, "pending" as SpecExecStatus);
  const allStates = (Object.keys(SPEC_EXEC_TRANSITIONS) as SpecExecStatus[]).sort();
  expect([...paths.keys()].sort()).toEqual(allStates);

  for (const target of allStates) {
    const path = paths.get(target)!;
    let specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
    for (const to of path.slice(1)) specExec = transition(handle, specExec, to);
    expect(specExec.status).toBe(target);
  }
  handle.close();
});

test("FR-001: every StageExec state is reachable via legal transitions", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  const paths = shortestPaths(STAGE_EXEC_TRANSITIONS, "queued" as StageExecStatus);
  const allStates = (Object.keys(STAGE_EXEC_TRANSITIONS) as StageExecStatus[]).sort();
  expect([...paths.keys()].sort()).toEqual(allStates);

  for (const target of allStates) {
    const path = paths.get(target)!;
    let stageExec = createStageExec(handle, specExec.id, "build");
    for (const to of path.slice(1)) stageExec = transition(handle, stageExec, to);
    expect(stageExec.status).toBe(target);
  }
  handle.close();
});

// --- FR-001: every illegal edge (the tables' complement) throws -----------

test("FR-001: every illegal Run edge throws InvalidTransitionError", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const states = Object.keys(RUN_TRANSITIONS) as RunStatus[];
  for (const from of states) {
    for (const to of states) {
      if ((RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to)) continue;
      const fixture: Run = { ...run, status: from };
      expect(() => transition(handle, fixture, to)).toThrow(InvalidTransitionError);
    }
  }
  handle.close();
});

test("FR-001: every illegal SpecExec edge throws InvalidTransitionError", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  const states = Object.keys(SPEC_EXEC_TRANSITIONS) as SpecExecStatus[];
  for (const from of states) {
    for (const to of states) {
      if ((SPEC_EXEC_TRANSITIONS[from] as readonly SpecExecStatus[]).includes(to)) continue;
      const fixture: SpecExec = { ...specExec, status: from };
      expect(() => transition(handle, fixture, to)).toThrow(InvalidTransitionError);
    }
  }
  handle.close();
});

test("FR-001: every illegal StageExec edge throws InvalidTransitionError", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  const stageExec = createStageExec(handle, specExec.id, "build");
  const states = Object.keys(STAGE_EXEC_TRANSITIONS) as StageExecStatus[];
  for (const from of states) {
    for (const to of states) {
      if ((STAGE_EXEC_TRANSITIONS[from] as readonly StageExecStatus[]).includes(to)) continue;
      const fixture: StageExec = { ...stageExec, status: from };
      expect(() => transition(handle, fixture, to)).toThrow(InvalidTransitionError);
    }
  }
  handle.close();
});

test("InvalidTransitionError names entity, from, and to", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  try {
    transition(handle, run, "completed");
    throw new Error("expected transition to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidTransitionError);
    const e = err as InvalidTransitionError;
    expect(e.entity).toBe("run");
    expect(e.from).toBe("idle");
    expect(e.to).toBe("completed");
  }
  handle.close();
});

test("an illegal transition throws before any journal write (validation first)", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const before = handle.fold().records.length;
  expect(() => transition(handle, run, "completed")).toThrow(InvalidTransitionError);
  expect(handle.fold().records.length).toBe(before);
  handle.close();
});

// --- B-1 / creation ----------------------------------------------------

test("creation events are journaled records with the full entity payload", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const records = handle.fold().records;
  expect(records.length).toBe(1);
  expect(records[0]?.kind).toBe("run.created");
  expect(records[0]?.payload).toEqual({ ...run });
  handle.close();
});

test("ids are sortable strings and monotonic within a process", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run1 = createRun(handle, "acme/repo");
  const run2 = createRun(handle, "acme/repo");
  expect(run1.id < run2.id).toBe(true);
  handle.close();
});

// --- B-3 / B-4: attempt bumps on retry --------------------------------

test("B-3: failed -> building retries in place as a fresh attempt, and fold recovers the same attempt", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  let specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  specExec = transition(handle, specExec, "building");
  specExec = transition(handle, specExec, "failed");
  expect(specExec.attempt).toBe(1);
  specExec = transition(handle, specExec, "building");
  expect(specExec.attempt).toBe(2);
  expect(specExec.status).toBe("building");

  const folded = foldOrchestratorState(handle.fold().records);
  expect(folded.specExecs.get(specExec.id)).toEqual({ ...specExec, needsReconcile: false });
  handle.close();
});

test("B-4: a stage retry mints a fresh StageExec at attempt+1, not an in-place transition", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  const first = createStageExec(handle, specExec.id, "build");
  expect(first.attempt).toBe(1);
  const failed = transition(handle, transition(handle, first, "running"), "failed");

  const retry = createStageExec(handle, specExec.id, "build", failed.attempt + 1);
  expect(retry.attempt).toBe(2);
  expect(retry.id).not.toBe(first.id);
  expect(retry.status).toBe("queued");
  handle.close();
});

// --- B-6: fold reconstructs entities from creation + transition records ---

test("foldOrchestratorState reconstructs Run, SpecExec, and StageExec from creation + transition records", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  let run = createRun(handle, "acme/repo");
  run = transition(handle, run, "running");
  let specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
  specExec = transition(handle, specExec, "building");
  let stageExec = createStageExec(handle, specExec.id, "build");
  stageExec = transition(handle, stageExec, "running");
  stageExec = transition(handle, stageExec, "passed");

  const folded = foldOrchestratorState(handle.fold().records);
  expect(folded.runs.get(run.id)).toEqual({ ...run, needsReconcile: false });
  expect(folded.specExecs.get(specExec.id)).toEqual({ ...specExec, needsReconcile: false });
  expect(folded.stageExecs.get(stageExec.id)).toEqual({ ...stageExec, needsReconcile: false });
  handle.close();
});

test("B-6: an intent with no matching outcome folds to the pre-transition state, flagged needsReconcile", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  const running = transition(handle, run, "running");
  // Simulates a crash between intent and outcome: only the intent half of
  // the running -> paused move is journaled.
  appendIntent(handle, "state.transition", { entity: "run", id: running.id, from: "running", to: "paused" });

  const folded = foldOrchestratorState(handle.fold().records);
  const foldedRun = folded.runs.get(run.id);
  expect(foldedRun?.status).toBe("running");
  expect(foldedRun?.needsReconcile).toBe(true);
  handle.close();
});

test("B-6: a resolved intent (matching outcome) does not flag needsReconcile", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  const run = createRun(handle, "acme/repo");
  transition(handle, run, "running");

  const folded = foldOrchestratorState(handle.fold().records);
  expect(folded.runs.get(run.id)?.needsReconcile).toBe(false);
  handle.close();
});

// --- FR-003: isTerminal, isLive, needsHuman are total ----------------------

function runWithStatus(status: RunStatus): Run {
  return { id: "r1", targetRepo: "acme/repo", createdTs: "2026-07-29T00:00:00.000Z", status };
}

function specExecWithStatus(status: SpecExecStatus): SpecExec {
  return { id: "s1", runId: "r1", specId: "013-run-state-machine", pin: "pin-fixture", attempt: 1, status };
}

function stageExecWithStatus(status: StageExecStatus): StageExec {
  return { id: "g1", specExecId: "s1", stage: "build", attempt: 1, status, evidenceRefs: [] };
}

test("FR-003: isLive/isTerminal/needsHuman are total and match the documented sets for Run", () => {
  const expected: Record<RunStatus, { live: boolean; terminal: boolean; human: boolean }> = {
    idle: { live: true, terminal: false, human: false },
    running: { live: true, terminal: false, human: false },
    parked: { live: false, terminal: false, human: false },
    paused: { live: false, terminal: false, human: true },
    completed: { live: false, terminal: true, human: false },
    failed: { live: false, terminal: true, human: false },
  };
  for (const status of Object.keys(RUN_TRANSITIONS) as RunStatus[]) {
    const run = runWithStatus(status);
    expect(isLive(run)).toBe(expected[status]!.live);
    expect(isTerminal(run)).toBe(expected[status]!.terminal);
    expect(needsHuman(run)).toBe(expected[status]!.human);
  }
});

test("FR-003: isLive/isTerminal/needsHuman are total and match the documented sets for SpecExec", () => {
  const expected: Record<SpecExecStatus, { live: boolean; terminal: boolean; human: boolean }> = {
    pending: { live: true, terminal: false, human: false },
    building: { live: true, terminal: false, human: false },
    shipping: { live: true, terminal: false, human: false },
    shepherding: { live: true, terminal: false, human: false },
    verifying: { live: true, terminal: false, human: false },
    shipped: { live: false, terminal: false, human: false },
    failed: { live: false, terminal: false, human: true },
    invalidated: { live: false, terminal: false, human: false },
  };
  for (const status of Object.keys(SPEC_EXEC_TRANSITIONS) as SpecExecStatus[]) {
    const specExec = specExecWithStatus(status);
    expect(isLive(specExec)).toBe(expected[status]!.live);
    expect(isTerminal(specExec)).toBe(expected[status]!.terminal);
    expect(needsHuman(specExec)).toBe(expected[status]!.human);
  }
});

test("FR-003: isLive/isTerminal/needsHuman are total and match the documented sets for StageExec", () => {
  const expected: Record<StageExecStatus, { live: boolean; terminal: boolean; human: boolean }> = {
    queued: { live: true, terminal: false, human: false },
    running: { live: true, terminal: false, human: false },
    passed: { live: false, terminal: true, human: false },
    failed: { live: false, terminal: true, human: false },
    blocked: { live: false, terminal: true, human: true },
  };
  for (const status of Object.keys(STAGE_EXEC_TRANSITIONS) as StageExecStatus[]) {
    const stageExec = stageExecWithStatus(status);
    expect(isLive(stageExec)).toBe(expected[status]!.live);
    expect(isTerminal(stageExec)).toBe(expected[status]!.terminal);
    expect(needsHuman(stageExec)).toBe(expected[status]!.human);
  }
});

// --- FR-002: fold-after-crash at every byte boundary -----------------------

test(
  "FR-002: a journal cut at every byte boundary of one transition always folds to a legal state",
  () => {
    const baseDir = freshDir();
    const handle = openJournal(baseDir);
    const run = createRun(handle, "acme/repo");
    const specExec = createSpecExec(handle, run.id, "013-run-state-machine", "pin-fixture");
    transition(handle, specExec, "building");
    handle.close();

    const journalPath = join(baseDir, "journal.jsonl");
    const anchorPath = join(baseDir, "anchor.json");
    const fullBytes = readFileSync(journalPath);
    const anchorBytes = readFileSync(anchorPath);

    const runStates = new Set<string>(Object.keys(RUN_TRANSITIONS));
    const specExecStates = new Set<string>(Object.keys(SPEC_EXEC_TRANSITIONS));
    const stageExecStates = new Set<string>(Object.keys(STAGE_EXEC_TRANSITIONS));

    for (let len = 0; len <= fullBytes.length; len++) {
      const cutDir = freshDir();
      try {
        writeFileSync(join(cutDir, "anchor.json"), anchorBytes);
        writeFileSync(join(cutDir, "journal.jsonl"), fullBytes.subarray(0, len));

        const cutHandle = openJournal(cutDir);
        const folded = foldOrchestratorState(cutHandle.fold().records);
        for (const r of folded.runs.values()) {
          expect(runStates.has(r.status)).toBe(true);
          expect(typeof r.needsReconcile).toBe("boolean");
        }
        for (const s of folded.specExecs.values()) {
          expect(specExecStates.has(s.status)).toBe(true);
          expect(typeof s.needsReconcile).toBe("boolean");
        }
        for (const s of folded.stageExecs.values()) {
          expect(stageExecStates.has(s.status)).toBe(true);
          expect(typeof s.needsReconcile).toBe("boolean");
        }
        cutHandle.close();
      } catch (err) {
        throw new Error(`FR-002 failed at prefix len=${len} of ${fullBytes.length}: ${(err as Error).message}`);
      } finally {
        rmSync(cutDir, { recursive: true, force: true });
      }
    }
  },
  60000
);

// --- AC-2: 1000 random legal walks, fold agrees with the in-memory walk ---

// A tiny deterministic PRNG (mulberry32): reproducible from a plain number
// seed, no dependency, good enough for a property test that only needs
// "different enough" sequences per trial, not cryptographic quality.
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// An in-memory JournalHandle: exercises the exact same transition()/createX()
// paths as the real journal without disk I/O, so 1000 trials stay fast. Fold
// correctness does not depend on the hash chain (foldOrchestratorState only
// reads kind/payload), which the byte-boundary test above already covers
// against the real, durable journal module.
function makeMemoryJournal(): JournalHandle {
  const records: JournalRecord[] = [];
  return {
    dir: "<memory>",
    get headSeq(): number {
      return records.length - 1;
    },
    get state(): FoldedState {
      return foldState(records);
    },
    tornRecovered: false,
    append(kind: string, payload: JsonValue): JournalRecord {
      const record: JournalRecord = {
        seq: records.length,
        ts: new Date().toISOString(),
        kind,
        payload,
        prevHash: "memory",
        recordHash: "memory",
      };
      records.push(record);
      return record;
    },
    fold(): FoldedState {
      return foldState(records);
    },
    close(): void {
      // in-memory only: nothing to release
    },
  };
}

function randomRunWalk(rng: () => number, handle: JournalHandle, maxSteps: number): Run {
  let run = createRun(handle, "acme/repo");
  for (let i = 0; i < maxSteps; i++) {
    if (rng() < 0.3) break;
    const options = RUN_TRANSITIONS[run.status];
    if (options.length === 0) break;
    run = transition(handle, run, pick(rng, options));
  }
  return run;
}

function randomSpecExecWalk(rng: () => number, handle: JournalHandle, runId: string, maxSteps: number): SpecExec {
  let specExec = createSpecExec(handle, runId, "013-run-state-machine", `pin-${Math.floor(rng() * 1e9)}`);
  for (let i = 0; i < maxSteps; i++) {
    if (rng() < 0.3) break;
    const options = SPEC_EXEC_TRANSITIONS[specExec.status];
    if (options.length === 0) break;
    specExec = transition(handle, specExec, pick(rng, options));
  }
  return specExec;
}

function randomStageExecWalk(
  rng: () => number,
  handle: JournalHandle,
  specExecId: string,
  maxSteps: number
): StageExec {
  const stage = pick(rng, ["build", "ship", "shepherd", "verify"] as const);
  let stageExec = createStageExec(handle, specExecId, stage);
  for (let i = 0; i < maxSteps; i++) {
    if (rng() < 0.3) break;
    const options = STAGE_EXEC_TRANSITIONS[stageExec.status];
    if (options.length === 0) break;
    stageExec = transition(handle, stageExec, pick(rng, options));
  }
  return stageExec;
}

function runAc2Trial(seed: number): void {
  const rng = mulberry32(seed);
  const handle = makeMemoryJournal();
  const run = randomRunWalk(rng, handle, 8);
  const specExec = randomSpecExecWalk(rng, handle, run.id, 8);
  const stageExec = randomStageExecWalk(rng, handle, specExec.id, 8);

  const folded = foldOrchestratorState(handle.fold().records);
  expect(folded.runs.get(run.id)).toEqual({ ...run, needsReconcile: false });
  expect(folded.specExecs.get(specExec.id)).toEqual({ ...specExec, needsReconcile: false });
  expect(folded.stageExecs.get(stageExec.id)).toEqual({ ...stageExec, needsReconcile: false });
}

test("AC-2: 1000 random legal walks over the three tables fold to the same state the walk computed in memory", () => {
  const baseSeed = 20260729;
  for (let i = 0; i < 1000; i++) {
    const seed = baseSeed + i;
    try {
      runAc2Trial(seed);
    } catch (err) {
      throw new Error(`AC-2 property test failed at trial ${i} (seed=${seed}): ${(err as Error).message}`);
    }
  }
});
