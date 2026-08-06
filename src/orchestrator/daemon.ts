// The orchestrator daemon (spec 021): the long-lived process that composes
// every other kernel module into one serial run loop. Everything hard lives
// elsewhere (the journal's crash consistency, the state machine's legal
// transitions, the DAG's readiness, the quota scheduler's park/resume, the
// four stages' own driving); this module is their disciplined composition,
// trusted to be killed at any moment and resumed honestly from the journal
// alone (the same "state is never trusted from memory" discipline journal.ts
// itself establishes).
//
// Every side effect sits behind DaemonDeps (FR-002-style injection, mirroring
// every stage module's own seam convention): the DAG reader, the four stage
// seams (Runner, GitHubClient, VerifyRunner, BrowserVerifier), the session
// driver, a process inspector for identity-checked locking, a clock, a
// chunked sleep, an rng, and the four stage entry points themselves
// (defaulting to the real runBuildStage/runShipStage/runShepherdStage/
// runVerifyStage, overridable wholesale in tests). Production wiring lives in
// createProductionDaemonDeps(); tests drive the Daemon class against fixture
// deps, never a real `claude`, `gh`, or `spec-spine` subprocess.
//
// Spec 026 supersedes two things here and nothing else. First, the run loop
// no longer owns the process's fate: it reports why it stopped (a LoopYield)
// so a supervisor can outlive a terminal run. Second, a `supervised` instance
// is one project's run inside spec 026's standby daemon: it takes no identity
// lock of its own (the supervisor holds the one lock for the daemon home,
// 026 B-6) and yields the flight slot when its run pauses on a human
// decision, instead of waiting that pause out. A quota park is deliberately
// not a yield: the account's quota is one pool, so that wait belongs where
// nothing else can start (026 B-5).
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JournalRecord, JsonValue } from "./journal";
import { openJournal } from "./journal";
import { openDecisionsChain } from "./decisions";
import type {
  Run,
  FoldedRun,
  FoldedSpecExec,
  RunPauseReason,
  RunStatus,
  SpecExecStatus,
  Stage,
} from "./state";
import { createRun, createSpecExec, createStageExec, foldOrchestratorState, isLive, transition } from "./state";
import type { Classification } from "./classify-termination";
import type { LastParkInfo, ParkPlan } from "./quota";
import { foldQuotaState, isResumeDue, journalPark, journalResume, planPark, resumeJitterMs } from "./quota";
import type { BudgetStopPlan, CeilingSource } from "./budget";
import {
  evaluateBudget,
  foldBudgetState,
  journalBudgetPark,
  journalBudgetPause,
  journalBudgetResume,
  planBudgetStop,
  renderBudgetStop,
  resolveCeilingSource,
} from "./budget";
import type { DagReader, PinLookup, RegistrySnapshot, RegistrySpecEntry, ShippedEntry, ShippedMap, ShippedSource } from "./dag";
import {
  adoptedShipped,
  createProcessDagReader,
  createProcessSpecFileAtShaReader,
  invalidatedSet,
  loadRegistrySnapshot,
  makePinLookup,
  nextReady,
  pinOfBytes,
  ready,
  statusSchedulable,
} from "./dag";
import { killLiveSession, runSession } from "./session";
import type { ProfileSource } from "./profile";
import type {
  BuildResult,
  ReadinessCheck,
  Runner,
  RunBuildStageOptions,
} from "./stages/build";
import { createProcessRunner, DEFAULT_BASE_BRANCH, runBuildStage } from "./stages/build";
import type { GitHubClient, RunShipStageOptions, ShipResult } from "./stages/ship";
import { createProcessGitHubClient, runShipStage } from "./stages/ship";
import type { RunShepherdStageOptions, ShepherdResult } from "./stages/shepherd";
import { runShepherdStage } from "./stages/shepherd";
import type { BrowserVerifier, RunVerifyStageOptions, VerifyResult, VerifyRunner } from "./stages/verify";
import { createBrowserMcpVerifier, createProcessVerifyRunner, runVerifyStage } from "./stages/verify";

// --- process inspector (B-1) -----------------------------------------------
//
// The seam that fixes spec 007's own recorded defect ("pid reuse is
// undetected"): liveness is checked against pid AND the process's own start
// time, never pid alone.

export interface ProcessInspector {
  isAlive(pid: number): boolean;
  // Epoch ms the process identified by pid started, or null when it cannot
  // be determined (the process is gone, or the inspection itself failed).
  procStartMs(pid: number): number | null;
}

export function createProcessInspector(): ProcessInspector {
  return {
    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    procStartMs(pid: number): number | null {
      const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
      if (result.exitCode !== 0) return null;
      const text = new TextDecoder().decode(result.stdout).trim();
      if (text.length === 0) return null;
      const parsedMs = Date.parse(text);
      return Number.isNaN(parsedMs) ? null : parsedMs;
    },
  };
}

// --- identity lock (B-1) ----------------------------------------------------

export interface DaemonLockInfo {
  readonly pid: number;
  readonly procStartMs: number;
}

export interface LockAcquisition {
  readonly lockPath: string;
  readonly self: DaemonLockInfo;
  // The lock info found on disk when it was stale (pid dead, or pid alive
  // under a different process per procStartMs): null when no lock file was
  // present at all. Set only when reclaim actually happened.
  readonly reclaimedFrom: DaemonLockInfo | null;
}

function readDaemonLock(lockPath: string): DaemonLockInfo | null {
  if (!fs.existsSync(lockPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (err) {
    throw new Error(`daemon: lock file at ${lockPath} is corrupted: ${(err as Error).message}`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o?.pid !== "number" || typeof o?.procStartMs !== "number") {
    throw new Error(`daemon: lock file at ${lockPath} is corrupted (expected {pid, procStartMs})`);
  }
  return { pid: o.pid, procStartMs: o.procStartMs };
}

function writeDaemonLock(lockPath: string, info: DaemonLockInfo): void {
  fs.writeFileSync(lockPath, JSON.stringify(info));
}

// Liveness = pid alive AND the process currently holding that pid started at
// the recorded time (B-1). A dead pid, or a live pid whose own start time no
// longer matches (the recorded pid was reused by an unrelated process), both
// count as stale and are reclaimed.
export function acquireDaemonLock(
  dataDir: string,
  inspector: ProcessInspector,
  pid: number = process.pid
): LockAcquisition {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, "daemon.lock");
  const existing = readDaemonLock(lockPath);
  let reclaimedFrom: DaemonLockInfo | null = null;

  if (existing) {
    const alive = inspector.isAlive(existing.pid);
    const currentStart = alive ? inspector.procStartMs(existing.pid) : null;
    const stillSameProcess = alive && currentStart !== null && currentStart === existing.procStartMs;
    if (stillSameProcess) {
      throw new Error(
        `daemon: another instance holds the lock (pid ${existing.pid}, started ${new Date(existing.procStartMs).toISOString()})`
      );
    }
    reclaimedFrom = existing;
  }

  const myProcStartMs = inspector.procStartMs(pid);
  if (myProcStartMs === null) {
    throw new Error(`daemon: cannot determine this process's own start time (pid ${pid}); refusing to acquire the lock`);
  }
  const self: DaemonLockInfo = { pid, procStartMs: myProcStartMs };
  writeDaemonLock(lockPath, self);
  return { lockPath, self, reclaimedFrom };
}

export function releaseDaemonLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

// What a supervisor does once it has confirmed (by whatever means, e.g. the
// OS reporting the pid is simply gone) that the previous daemon is dead: the
// identity lock plus both of journal.ts's own per-chain lock files, so the
// next start() neither trips journal.ts's "another writer holds it" refusal
// nor daemon.lock's own liveness check unnecessarily. Never called by the
// daemon itself (journal.ts's own convention deliberately leaves
// multi-writer coordination to an outside supervisor, spec 011 section 6).
export function forceReleaseDaemonLock(dataDir: string): void {
  for (const name of ["daemon.lock", "journal.lock", "decisions.lock"]) {
    try {
      fs.unlinkSync(join(dataDir, name));
    } catch {
      // already gone
    }
  }
}

// --- stage seams and deps (FR every stage's own seam convention) -----------

export interface DaemonStageFns {
  build: (options: RunBuildStageOptions) => Promise<BuildResult>;
  ship: (options: RunShipStageOptions) => Promise<ShipResult>;
  shepherd: (options: RunShepherdStageOptions) => Promise<ShepherdResult>;
  verify: (options: RunVerifyStageOptions) => Promise<VerifyResult>;
}

export interface DaemonDeps {
  readonly dataDir: string;
  readonly repoDir: string;
  readonly dagReader: DagReader;
  readonly runner: Runner;
  readonly gh: GitHubClient;
  readonly verifyRunner: VerifyRunner;
  readonly browserVerifier: BrowserVerifier;
  // Structural seam only (B-5): the daemon itself never calls this. It is
  // wired here so the production factory can hand the same primitive to
  // every stage-adjacent seam that needs it, and so a test can inject a
  // throwing stub to prove the daemon's own code path never reaches it.
  readonly runSession: typeof runSession;
  // B-6, D-19: shutdown severs the live session child through this seam
  // (production: session.ts killLiveSession, process-wide because of the
  // serial invariant). Absent is a no-op, which keeps fixture deps that
  // never spawn a real child working unchanged.
  readonly killLiveSession?: (graceMs?: number) => boolean;
  readonly processInspector: ProcessInspector;
  readonly clock: { now(): number };
  readonly sleep: (ms: number) => Promise<void>;
  readonly rng: () => number;
  readonly stageFns: DaemonStageFns;
  // Defaults to process.pid; injectable so a test can exercise identity
  // logic without needing a second real OS process.
  readonly pid?: number;
  readonly dropboxDir?: string;
  readonly evidenceDir?: string;
  readonly heartbeatIntervalMs?: number;
  readonly sleepChunkMs?: number;
  readonly stageRetryBudget?: number;
  readonly resumeJitterMinMs?: number;
  readonly resumeJitterMaxMs?: number;
  readonly defaultBranch?: string;
  // Which branch the target checkout is on right now, or null when that is
  // unknowable. Adoption (D-15) trusts a registry read only when this
  // reports the default branch; absent means trusted, which is what keeps
  // fixture deps that never touch a real checkout working unchanged.
  readonly readCheckoutBranch?: () => string | null;
  // The spec file's bytes at a specific commit, or null when unreadable.
  // D-16 derives a pipeline-shipped spec's pin from the journaled merge
  // sha through this seam; absent falls back to the exec's creation pin.
  readonly readSpecFileAtSha?: (sha: string, specId: string) => Buffer | null;
  // Best-effort: put a clean checkout back on the default branch before a
  // scheduling pass reads the registry (D-17). Absent is a no-op.
  readonly normalizeCheckoutForScheduling?: () => void;
  // The current checkout's head sha, or null when unreadable. D-18's
  // requalification verifies an amended prior-run spec at this sha.
  readonly readHeadSha?: () => string | null;
  // 033 B-2: this project's cost ceiling, read at every session spawn
  // boundary. A function rather than a value for the same reason the profile
  // is one (032 B-4): the scheduler builds a project's seams once and reuses
  // them, and a ceiling an operator raised to release a budget-paused run has
  // to reach the next boundary rather than the next daemon. Absent means no
  // ceiling, which is exactly how every project was driven before 033.
  readonly ceiling?: CeilingSource;
  // 026 B-6: this instance is one project's run inside a standby daemon that
  // already holds the daemon home's identity lock, so it acquires none of its
  // own; spec 011's per-chain writer locks in this project's own state root
  // still keep two writers apart. A supervised daemon is driven one drive()
  // at a time by that supervisor rather than looping on its own from start().
  readonly supervised?: boolean;
}

// Why the run loop stopped (026 B-1). "completed" and "failed" are the run's
// own terminal statuses, which drop the supervisor to standby rather than
// ending the process; "paused" is a supervised yield of the flight slot to
// a human decision; "shutdown" is B-6's honest unwind.
export type LoopYield = "completed" | "failed" | "paused" | "shutdown";

export const DEFAULT_STAGE_RETRY_BUDGET = 1;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_SLEEP_CHUNK_MS = 250;

// --- production wiring -------------------------------------------------

export interface CreateProductionDaemonDepsParams {
  readonly dataDir: string;
  readonly repoDir: string;
  readonly claudeBin?: string;
  readonly ghBin?: string;
  // Set by spec 026's scheduler for a project's run; see DaemonDeps.supervised.
  readonly supervised?: boolean;
  // 032 B-4: this project's execution posture, threaded into every seam that
  // spawns a session (the Runner build, ship, and shepherd drive through,
  // and the verify stage's browser verifier). Passed as a function by the
  // scheduler's wiring so a profile set mid-flight reaches the next spawn
  // rather than the next daemon; absent derives 032 D-1's default, which is
  // the posture every session had before profiles existed.
  readonly profile?: ProfileSource;
  // 033 B-2: this project's spend limits, late-bound for the same reason the
  // profile is (see DaemonDeps.ceiling).
  readonly ceiling?: CeilingSource;
}

export function createProductionDaemonDeps(params: CreateProductionDaemonDepsParams): DaemonDeps {
  const { dataDir, repoDir, claudeBin, ghBin, profile } = params;
  const runner = createProcessRunner({ repoDir, claudeBin, profile });
  return {
    dataDir,
    repoDir,
    supervised: params.supervised,
    ceiling: params.ceiling,
    dagReader: createProcessDagReader(),
    runner,
    readCheckoutBranch: () => {
      try {
        return runner.currentBranch();
      } catch {
        return null;
      }
    },
    readSpecFileAtSha: createProcessSpecFileAtShaReader(repoDir),
    readHeadSha: () => {
      try {
        return runner.headSha();
      } catch {
        return null;
      }
    },
    normalizeCheckoutForScheduling: () => {
      try {
        if (!runner.statusClean()) return;
        if (runner.currentBranch() === DEFAULT_BASE_BRANCH) return;
        runner.checkout(DEFAULT_BASE_BRANCH);
        try {
          runner.pullFfOnly();
        } catch {
          // A failed fast-forward leaves the checkout on the default branch
          // with older content, which the adoption guard treats honestly.
        }
      } catch {
        // Normalization is best-effort; the D-15 guard defers adoption when
        // the checkout stays on a non-default branch.
      }
    },
    gh: createProcessGitHubClient({ repoDir, ghBin }),
    verifyRunner: createProcessVerifyRunner({ repoDir }),
    browserVerifier: createBrowserMcpVerifier({ repo: repoDir, claudeBin, profile }),
    runSession,
    killLiveSession,
    processInspector: createProcessInspector(),
    clock: { now: () => Date.now() },
    sleep: (ms: number) => Bun.sleep(ms),
    rng: Math.random,
    stageFns: { build: runBuildStage, ship: runShipStage, shepherd: runShepherdStage, verify: runVerifyStage },
  };
}

// SIGTERM finishes the current journal write, kills any live session child,
// releases the lock, and exits (B-6; the kill itself lives in shutdown(),
// D-19). Never registered by tests; a fresh process is expected to call this
// exactly once.
export function installShutdownSignalHandler(daemon: Daemon): void {
  process.on("SIGTERM", () => {
    daemon
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

// --- heartbeat (FR-002) ------------------------------------------------

// Pure and directly testable: at most once per intervalMs, by clock reading
// alone.
export function shouldEmitHeartbeat(lastHeartbeatMs: number | null, nowMs: number, intervalMs: number): boolean {
  return lastHeartbeatMs === null || nowMs - lastHeartbeatMs >= intervalMs;
}

// --- control queue (B-4) ------------------------------------------------

export type ControlVerb = "pause" | "resume" | "skipSpec" | "retryStage" | "reverify" | "forceHumanGate" | "approve";

export interface ControlCommand {
  readonly verb: ControlVerb;
  readonly specId?: string;
  readonly source: string;
  // The journal seq of the control.<verb> record this command came from
  // (D-24): applying it journals control.applied against this seq, which is
  // what lets a restart tell a consumed control from one that died queued.
  readonly seq?: number;
}

// --- small JSON helpers -------------------------------------------------

function isJsonRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseAdoptedPayload(payload: JsonValue): ShippedMap {
  if (!isJsonRecord(payload) || !Array.isArray(payload.entries)) {
    throw new Error("daemon: dag.adopted payload malformed (expected {entries: [...]})");
  }
  const out = new Map<string, ShippedEntry>();
  for (const raw of payload.entries) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as Record<string, JsonValue>).id !== "string" ||
      typeof (raw as Record<string, JsonValue>).pin !== "string" ||
      ((raw as Record<string, JsonValue>).source !== "pipeline" && (raw as Record<string, JsonValue>).source !== "adopted")
    ) {
      throw new Error("daemon: dag.adopted entry malformed");
    }
    const r = raw as { id: string; pin: string; source: ShippedSource };
    out.set(r.id, { pin: r.pin, source: r.source });
  }
  return out;
}

// --- stage plumbing -----------------------------------------------------

const STAGE_ORDER: readonly Stage[] = ["build", "ship", "shepherd", "verify"];

const STATUS_FOR_STAGE: Readonly<Record<Stage, SpecExecStatus>> = {
  build: "building",
  ship: "shipping",
  shepherd: "shepherding",
  verify: "verifying",
};

const NEXT_STATUS_AFTER_STAGE: Readonly<Record<Stage, SpecExecStatus>> = {
  build: "shipping",
  ship: "shepherding",
  shepherd: "verifying",
  verify: "shipped",
};

type TaggedStageResult =
  | { readonly stage: "build"; readonly result: BuildResult }
  | { readonly stage: "ship"; readonly result: ShipResult }
  | { readonly stage: "shepherd"; readonly result: ShepherdResult }
  | { readonly stage: "verify"; readonly result: VerifyResult };

// Only shepherd's and verify's own StageOutcome enums carry a first-class
// "quota" value; build's and ship's own evidence still carries the
// underlying session classification (SessionEvidence.classification /
// ShipSessionEvidence.classification), just not surfaced as a distinct
// top-level outcome. This is the one place that unifies quota detection
// across all four stages from whatever each one's own evidence shape
// actually preserves. Build and ship evidence do not preserve the
// classifier's parsed reset time (SessionEvidence has no resetAtMs field),
// so a quota detected there always parks as an estimate; verify alone
// preserves it (VerifyEvidence.quotaResetAtMs), since its own outcome
// already carries it explicitly. See Resolved decisions, D-6.
function detectQuotaClassification(tagged: TaggedStageResult): Classification | null {
  switch (tagged.stage) {
    case "build":
      if (tagged.result.evidence.sessions.some((s) => s.classification === "quota")) {
        return { kind: "quota", resetAtMs: null, detail: "quota classified during a build-stage session" };
      }
      return null;
    case "ship":
      if (tagged.result.evidence.sessions.some((s) => s.classification === "quota")) {
        return { kind: "quota", resetAtMs: null, detail: "quota classified during a ship-stage session" };
      }
      return null;
    case "shepherd":
      if (tagged.result.outcome === "quota") {
        return { kind: "quota", resetAtMs: null, detail: "quota classified during a shepherd remediation session" };
      }
      return null;
    case "verify":
      if (tagged.result.outcome === "quota") {
        return {
          kind: "quota",
          resetAtMs: tagged.result.evidence.quotaResetAtMs,
          detail: "quota classified during a verify browser-assertion session",
        };
      }
      return null;
  }
}

function isPassOutcome(tagged: TaggedStageResult): boolean {
  if (tagged.stage === "verify") return tagged.result.outcome === "passed" || tagged.result.outcome === "not-declared";
  return tagged.result.outcome === "passed";
}

function isBlockedOutcome(tagged: TaggedStageResult): boolean {
  if (tagged.stage === "build") return tagged.result.outcome === "blocked" || tagged.result.outcome === "refused";
  if (tagged.stage === "ship") return tagged.result.outcome === "blocked";
  if (tagged.stage === "shepherd") return tagged.result.outcome === "blocked";
  return false; // verify has no "blocked" outcome
}

type StageWalkOutcome =
  | { readonly kind: "passed"; readonly result: TaggedStageResult }
  | { readonly kind: "paused" }
  | { readonly kind: "shutdown" };

// --- the daemon ----------------------------------------------------------

export class Daemon {
  private readonly deps: DaemonDeps;
  private readonly dropboxDir: string;
  private readonly evidenceDir: string;

  private started = false;
  private closed = false;
  private shutdownRequested = false;

  private lockPath: string | null = null;
  private workJournal!: JournalHandle;
  private decisionsChain!: JournalHandle;
  private run!: FoldedRun;

  private loopPromise: Promise<void> | null = null;
  private loopError: unknown = null;
  private driving = false;

  private lastHeartbeatMs: number | null = null;

  private readonly pendingControls: ControlCommand[] = [];
  private readonly skippedSpecIds = new Set<string>();
  private readonly forcedGateSpecIds = new Set<string>();
  private readonly approvedGateSpecIds = new Set<string>();
  private readonly reverifyQueue: string[] = [];

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.dropboxDir = deps.dropboxDir ?? join(deps.dataDir, "decisions-dropbox");
    this.evidenceDir = deps.evidenceDir ?? join(deps.dataDir, "verify-evidence");
  }

  // --- introspection (convenience only; durable truth is the journal) ---

  get runId(): string {
    return this.run.id;
  }

  get runStatus(): RunStatus {
    return this.run.status;
  }

  // --- lifecycle (B-1, B-2, B-6) ------------------------------------------

  async start(): Promise<void> {
    if (this.started) throw new Error("daemon: start() called twice");
    this.started = true;

    // 026 B-6: one identity lock per daemon home. A supervised instance runs
    // inside a standby daemon that already holds it, so it takes none of its
    // own and leaves both the lock and any stale-lock reclaim to that
    // supervisor, which is the only party that can know which project state
    // roots the dead daemon could have been writing.
    const lock = this.deps.supervised
      ? null
      : acquireDaemonLock(this.deps.dataDir, this.deps.processInspector, this.deps.pid ?? process.pid);
    this.lockPath = lock?.lockPath ?? null;

    // Reclaim proved the previous writer dead by a stronger test (pid plus
    // process start time) than journal.ts's own file-existence lock; its
    // per-chain lock files are cleared here so opening does not trip that
    // weaker check unnecessarily.
    if (lock?.reclaimedFrom) {
      for (const name of ["journal.lock", "decisions.lock"]) {
        try {
          fs.unlinkSync(join(this.deps.dataDir, name));
        } catch {
          // not present
        }
      }
    }

    this.workJournal = openJournal(this.deps.dataDir);
    this.decisionsChain = openDecisionsChain(this.deps.dataDir);

    if (lock?.reclaimedFrom) {
      const payload: Record<string, JsonValue> = {
        stalePid: lock.reclaimedFrom.pid,
        staleProcStartMs: lock.reclaimedFrom.procStartMs,
        newPid: lock.self.pid,
        newProcStartMs: lock.self.procStartMs,
      };
      this.workJournal.append("daemon.lock.reclaimed", payload);
    }
    if (lock) {
      this.workJournal.append("daemon.lock.acquired", { pid: lock.self.pid, procStartMs: lock.self.procStartMs });
    }

    this.recover();

    // 026 B-2: a supervised run is driven one drive() at a time by the
    // scheduler, which is what keeps exactly one stage session live across
    // every project; only an unsupervised daemon loops on its own from here.
    if (this.deps.supervised) return;

    this.loopPromise = this.runLoop().then(
      () => undefined,
      (err) => {
        this.loopError = err;
      }
    );
  }

  // 026 B-2/B-3: the supervised entry point. Runs the loop until it gives the
  // flight slot back, and says why: a terminal run, a pause only a human can
  // lift, or shutdown. Re-entrant across calls, one at a time: a paused run
  // resumes by being driven again once a control that can lift the pause is
  // queued (hasQueuedResume).
  async drive(): Promise<LoopYield> {
    if (!this.started) throw new Error("daemon: drive() called before start()");
    if (!this.deps.supervised) {
      throw new Error("daemon: drive() is for supervised deps; an unsupervised daemon loops from start()");
    }
    if (this.driving) throw new Error("daemon: drive() is already in flight");
    this.driving = true;
    try {
      return await this.runLoop();
    } finally {
      this.driving = false;
    }
  }

  // The supervisor's cheap "would driving this paused run do anything" check
  // (026 B-3). A yielded run sits with its journals open and its loop stopped,
  // so only a queued control that can lift the pause is worth re-entering for.
  //
  // 033 B-6 adds the one thing that lifts a yield without any control at all:
  // a budget-day park released the flight slot (unlike a quota park, which
  // holds it), so nothing but this getter can tell the supervisor that the
  // horizon has passed and this run is drivable again. The journal fold is the
  // same one concludeIdle already does, and it runs once per scan per live
  // project, not per stage.
  get hasQueuedResume(): boolean {
    if (
      this.pendingControls.some(
        (cmd) => cmd.verb === "resume" || cmd.verb === "retryStage" || cmd.verb === "approve"
      )
    ) {
      return true;
    }
    return this.budgetParkDue();
  }

  // Whether this run is parked on a released slot (a budget park with no quota
  // park open beside it) whose journaled horizon the clock has now passed.
  // Never throws: a supervisor polling a daemon whose journals have closed
  // gets "nothing to drive", not an exception through a getter.
  private budgetParkDue(): boolean {
    if (this.run.status !== "parked") return false;
    try {
      const horizon = this.parkHorizon();
      return horizon !== null && horizon.releasesSlot && this.deps.clock.now() >= horizon.targetMs;
    } catch {
      return false;
    }
  }

  // 026 D-5: a queued reverify is also worth driving for: D-18's
  // requalification runs from the loop's reverify queue, so a daemon opened
  // solely to receive the control must be driven for it to act.
  //
  // 026 D-10: only answered while the run can reach the drain. The loop
  // yields for a pause (and for a slot-releasing park) before it touches the
  // reverify queue, so on a yielded run this getter saying "drive me" sent
  // the scheduler into a drive that consumed nothing, every cycle, starving
  // the API of the very resume that would have lifted the pause (found live
  // 2026-08-06). The queue keeps its entries; the control that lifts the
  // yield is hasQueuedResume's to report, and the drive it earns drains the
  // queue right after.
  get hasQueuedReverify(): boolean {
    if (this.run.status !== "running") return false;
    return this.reverifyQueue.length > 0 || this.pendingControls.some((cmd) => cmd.verb === "reverify");
  }

  // D-23: start() always leaves a run in "running", and a supervisor that
  // opened this daemon only to probe (026 D-8's zero-queued path) closes the
  // journals without ever driving, which would strand that run reading as
  // live forever. Concluding here is the loop's own idle verdict, the same
  // record and transition its nothing-ready branch writes. Refusal means the
  // resumed run holds something only the loop can reconcile: a pause, a
  // park, or live/retryable spec work; the supervisor drives it instead.
  concludeIdle(): boolean {
    if (this.run.status !== "running") return false;
    // D-24: a run with queued controls is not idle. Concluding around them
    // would close the journals with the controls unapplied and unconsumed,
    // re-restoring them at every later open; refusing makes the probe drive
    // this daemon, which applies and journals them exactly once.
    if (this.pendingControls.length > 0) return false;
    const folded = foldOrchestratorState(this.workJournal.fold().records);
    const unfinished = [...folded.specExecs.values()].some(
      (se) => se.runId === this.run.id && (isLive(se) || se.status === "failed")
    );
    if (unfinished) return false;
    this.workJournal.append("run.result", { runId: this.run.id, status: "completed" });
    this.run = { ...transition(this.workJournal, this.run, "completed"), needsReconcile: false };
    return true;
  }

  // Resolves once the loop actually exits (run completed/failed, or shutdown
  // honored); rethrows whatever the loop itself threw (an unhandled error
  // inside a stage call, simulating a crash).
  async join(): Promise<void> {
    if (!this.loopPromise) throw new Error("daemon: join() called before start()");
    await this.loopPromise;
    if (this.loopError) throw this.loopError;
  }

  // B-6 without the wait: the flag alone, so a supervisor can set it on the
  // daemon it is currently driving and then await that drive() itself (026
  // B-7). Every wait point in the loop checks it on its next chunk.
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  // B-6: interrupts the sleep, severs any live session child (D-19; the
  // severed stage call returns promptly and its outcome, classification
  // "killed", is journaled normally before the loop notices the flag), lets
  // the current journal write finish, releases the lock, resolves. A
  // supervised daemon has no loop of its own to await here; its supervisor
  // awaits the in-flight drive() before calling this, so closing is all
  // that is left.
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.deps.killLiveSession?.();
    if (this.loopPromise) await this.loopPromise;
    this.closeResources();
  }

  private closeResources(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.workJournal?.close();
    } catch {
      // already closed
    }
    try {
      this.decisionsChain?.close();
    } catch {
      // already closed
    }
    if (this.lockPath) releaseDaemonLock(this.lockPath);
  }

  // --- recovery (B-2) ------------------------------------------------------

  private recover(): void {
    const records = this.workJournal.fold().records;
    const state = foldOrchestratorState(records);

    const alreadyAdopted = this.workJournal.fold().byKind["dag.adopted"];
    if (!alreadyAdopted || alreadyAdopted.length === 0) {
      // D-15: adoption is a durable, monotone append, so it only trusts a
      // registry read taken from the default branch. A deferred first
      // adoption is picked up by the refresh loop as a late first adoption
      // (D-11, oldPin null) once the checkout is back on the default branch.
      const trust = this.adoptionTrust();
      if (trust.trusted) {
        const snapshot = loadRegistrySnapshot(this.deps.dagReader, this.deps.repoDir);
        const pinOf = makePinLookup(this.deps.dagReader, this.deps.repoDir);
        const adopted = adoptedShipped(snapshot, pinOf);
        const entries = [...adopted.entries()].map(([id, e]) => ({ id, pin: e.pin, source: e.source }));
        this.workJournal.append("dag.adopted", { entries: entries as unknown as JsonValue });
      } else {
        this.workJournal.append("dag.adoption.deferred", { branch: trust.branch, phase: "recovery" });
      }
    }

    for (const run of state.runs.values()) {
      if (run.needsReconcile) {
        this.workJournal.append("daemon.reconciled", { entity: "run", id: run.id, observedStatus: run.status });
      }
    }
    for (const specExec of state.specExecs.values()) {
      if (specExec.needsReconcile) {
        this.workJournal.append("daemon.reconciled", {
          entity: "specExec",
          id: specExec.id,
          specId: specExec.specId,
          observedStatus: specExec.status,
        });
      }
    }
    for (const stageExec of state.stageExecs.values()) {
      if (stageExec.needsReconcile) {
        const owner = state.specExecs.get(stageExec.specExecId);
        let observedPr: JsonValue = null;
        if (owner) {
          try {
            const pr = this.deps.gh.prForBranch(owner.specId);
            observedPr = pr ? { number: pr.number, headSha: pr.headSha } : null;
          } catch {
            observedPr = null;
          }
        }
        this.workJournal.append("daemon.reconciled", {
          entity: "stageExec",
          id: stageExec.id,
          stage: stageExec.stage,
          observedStatus: stageExec.status,
          observedPr,
        });
      }
    }

    const existingRun = [...state.runs.values()].sort((a, b) => a.createdTs.localeCompare(b.createdTs)).at(-1);
    // A terminal latest run is history, not a verdict on the mission: a
    // restart continues the backlog under a fresh run (D-12) with the full
    // journal retained. Only a live (or idle/paused/parked) run is resumed.
    if (existingRun && existingRun.status !== "completed" && existingRun.status !== "failed") {
      this.run = existingRun;
      if (this.run.status === "idle") this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
    } else {
      const created = createRun(this.workJournal, this.deps.repoDir);
      this.run = { ...transition(this.workJournal, created, "running"), needsReconcile: false };
    }

    this.restorePendingControls(records);
  }

  // D-24: a journaled control the dying process never applied is a promise
  // the operator was given, and it survives the process. Restoration replays
  // every `restorable: true` control record with no `control.applied` keyed
  // to its seq, in journal order; pre-D-24 records lack the marker and stay
  // history (a consumed-but-unmarked control must never re-fire). The one
  // exclusion: standby-auto reverifies, which 026 D-8's next scan re-derives
  // from drift, so restoring them would double-queue the same healing.
  private restorePendingControls(records: readonly JournalRecord[]): void {
    const applied = new Set<number>();
    for (const record of records) {
      if (record.kind !== "control.applied") continue;
      const seq = isJsonRecord(record.payload) ? record.payload.controlSeq : null;
      if (typeof seq === "number") applied.add(seq);
    }
    const restored: ControlCommand[] = [];
    for (const record of records) {
      if (!record.kind.startsWith("control.") || record.kind === "control.applied" || record.kind === "control.reverify.refused") {
        continue;
      }
      if (!isJsonRecord(record.payload) || record.payload.restorable !== true) continue;
      if (applied.has(record.seq)) continue;
      const verb = record.kind.slice("control.".length) as ControlVerb;
      const source = typeof record.payload.source === "string" ? record.payload.source : "unknown";
      if (verb === "reverify" && source === "standby-auto") continue;
      const specId = typeof record.payload.specId === "string" ? record.payload.specId : undefined;
      restored.push({ verb, specId, source, seq: record.seq });
    }
    if (restored.length === 0) return;
    this.pendingControls.push(...restored);
    this.workJournal.append("daemon.controls.restored", {
      count: restored.length,
      seqs: restored.map((cmd) => cmd.seq ?? null) as unknown as JsonValue,
    });
  }

  // --- control API (B-4) --------------------------------------------------
  //
  // Each method validates minimal state, journals a control.<verb> record
  // with its source, and queues an in-memory command applied at the next
  // loop checkpoint (between stages, or at the top of the loop). Minimal but
  // real: spec 022's HTTP surface calls these directly.

  // D-24: every issue journals `restorable: true` and queues the record's
  // own seq, so recovery can tell a consumed control from one whose process
  // died with it queued. Records without the marker (every pre-D-24 journal)
  // are history, never restored.

  pause(source: string): void {
    if (this.run.status !== "running") {
      throw new Error(`daemon: pause() requires the run to be "running" (current: "${this.run.status}")`);
    }
    const record = this.workJournal.append("control.pause", { runId: this.run.id, source, restorable: true });
    this.pendingControls.push({ verb: "pause", source, seq: record.seq });
  }

  resume(source: string): void {
    if (this.run.status !== "paused") {
      throw new Error(`daemon: resume() requires the run to be "paused" (current: "${this.run.status}")`);
    }
    const record = this.workJournal.append("control.resume", { runId: this.run.id, source, restorable: true });
    this.pendingControls.push({ verb: "resume", source, seq: record.seq });
  }

  skipSpec(specId: string, source: string): void {
    if (specId.length === 0) throw new Error("daemon: skipSpec() requires a non-empty specId");
    const record = this.workJournal.append("control.skipSpec", { specId, source, restorable: true });
    this.pendingControls.push({ verb: "skipSpec", specId, source, seq: record.seq });
  }

  retryStage(specId: string, source: string): void {
    if (specId.length === 0) throw new Error("daemon: retryStage() requires a non-empty specId");
    const record = this.workJournal.append("control.retryStage", { specId, source, restorable: true });
    this.pendingControls.push({ verb: "retryStage", specId, source, seq: record.seq });
  }

  reverify(specId: string, source: string): void {
    if (specId.length === 0) throw new Error("daemon: reverify() requires a non-empty specId");
    const record = this.workJournal.append("control.reverify", { specId, source, restorable: true });
    this.pendingControls.push({ verb: "reverify", specId, source, seq: record.seq });
  }

  // 026's amendment-cascade healing (D-22): queue a reverify for every
  // invalidated spec whose own pipeline pin has drifted, dependencies before
  // dependents. Adopted drift needs no queue entry: computeShippedMap's own
  // refresh re-adopts amended bootstrap-era specs on a trusted checkout
  // (D-11), and transitive invalidation evaporates once the drifted roots
  // requalify. The journaled control.reverify records carry the caller's
  // source, so an automatic queue stays auditable against an operator's.
  queueAutoReverifies(source: string): number {
    this.deps.normalizeCheckoutForScheduling?.();
    const snapshot = loadRegistrySnapshot(this.deps.dagReader, this.deps.repoDir);
    const pinOf = makePinLookup(this.deps.dagReader, this.deps.repoDir);
    const shipped = this.computeShippedMap(snapshot, pinOf);
    const invalid = invalidatedSet(snapshot, shipped, pinOf);
    const rootSet = new Set(
      [...invalid].filter((id) => {
        const entry = shipped.get(id);
        return entry !== undefined && entry.source === "pipeline" && entry.pin !== pinOf(id);
      })
    );
    if (rootSet.size === 0) return 0;

    // A root re-verifies against its dependencies, so a root reachable from
    // another root through depends_on must requalify after it.
    const depsOf = (id: string): readonly string[] => snapshot.get(id)?.dependsOn ?? [];
    const rootDepsOf = (id: string): Set<string> => {
      const found = new Set<string>();
      const visited = new Set<string>();
      const stack = [...depsOf(id)];
      while (stack.length > 0) {
        const dep = stack.pop()!;
        if (visited.has(dep)) continue;
        visited.add(dep);
        if (rootSet.has(dep)) found.add(dep);
        stack.push(...depsOf(dep));
      }
      return found;
    };
    const remaining = new Map([...rootSet].map((id) => [id, rootDepsOf(id)] as const));
    const ordered: string[] = [];
    while (remaining.size > 0) {
      const emittable = [...remaining.entries()]
        .filter(([, deps]) => [...deps].every((d) => ordered.includes(d)))
        .map(([id]) => id)
        .sort();
      if (emittable.length === 0) {
        // A depends_on cycle among roots; emit the rest in name order rather
        // than spin (findCycle reports the cycle itself elsewhere).
        ordered.push(...[...remaining.keys()].sort());
        break;
      }
      for (const id of emittable) {
        ordered.push(id);
        remaining.delete(id);
      }
    }
    for (const id of ordered) this.reverify(id, source);
    return ordered.length;
  }

  forceHumanGate(specId: string, source: string): void {
    if (specId.length === 0) throw new Error("daemon: forceHumanGate() requires a non-empty specId");
    const record = this.workJournal.append("control.forceHumanGate", { specId, source, restorable: true });
    this.pendingControls.push({ verb: "forceHumanGate", specId, source, seq: record.seq });
  }

  approve(specId: string, source: string): void {
    if (specId.length === 0) throw new Error("daemon: approve() requires a non-empty specId");
    const record = this.workJournal.append("control.approve", { specId, source, restorable: true });
    this.pendingControls.push({ verb: "approve", specId, source, seq: record.seq });
  }

  private applyPendingControls(): void {
    while (this.pendingControls.length > 0) {
      const cmd = this.pendingControls.shift()!;
      // D-24: consumption is a journaled fact, keyed to the control record's
      // own seq; a state-conditional no-op below is still consumption.
      if (cmd.seq !== undefined) {
        this.workJournal.append("control.applied", { controlSeq: cmd.seq, verb: cmd.verb });
      }
      switch (cmd.verb) {
        case "pause":
          if (this.run.status === "running") this.run = { ...transition(this.workJournal, this.run, "paused"), needsReconcile: false };
          break;
        case "resume":
          if (this.run.status === "paused") this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
          break;
        case "skipSpec":
          if (cmd.specId) this.skippedSpecIds.add(cmd.specId);
          break;
        case "retryStage":
          if (cmd.specId && this.run.status === "paused") {
            this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
          }
          break;
        case "reverify":
          if (cmd.specId) this.reverifyQueue.push(cmd.specId);
          break;
        case "forceHumanGate":
          if (cmd.specId) {
            // A fresh gate is a fresh question: any approval standing from an
            // earlier gate on this spec is cleared, or the new gate would be
            // satisfied before the operator ever saw it.
            this.approvedGateSpecIds.delete(cmd.specId);
            this.forcedGateSpecIds.add(cmd.specId);
          }
          break;
        case "approve":
          if (cmd.specId) {
            this.forcedGateSpecIds.delete(cmd.specId);
            this.approvedGateSpecIds.add(cmd.specId);
            // 026 B-3: an approval is also a resume. The unsupervised gate
            // wait below lifts the pause itself once this flag flips, but a
            // supervised run has already yielded the flight slot, so the
            // approval is the only thing left that can lift it.
            if (this.run.status === "paused") {
              this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
            }
          }
          break;
      }
    }
  }

  // --- chunked waiting (B-6: shutdown-interruptible) ----------------------

  // Applies the pending-control queue on every check (not only on entry): a
  // resume()/approve()/skipSpec() issued while this wait is in progress must
  // still be observed before the next chunk, not only once the wait already
  // happens to end (B-4's own "checked between stages" checkpoint, extended
  // to every chunk of a wait so a control is never stuck behind a long park
  // or a paused run).
  private async chunkedSleepUntil(conditionFn: () => boolean): Promise<void> {
    const chunkMs = this.deps.sleepChunkMs ?? DEFAULT_SLEEP_CHUNK_MS;
    this.applyPendingControls();
    while (!conditionFn() && !this.shutdownRequested) {
      await this.deps.sleep(chunkMs);
      this.applyPendingControls();
    }
  }

  // --- heartbeat (FR-002) --------------------------------------------------

  private maybeHeartbeat(): void {
    const interval = this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const now = this.deps.clock.now();
    if (!shouldEmitHeartbeat(this.lastHeartbeatMs, now, interval)) return;
    this.lastHeartbeatMs = now;
    this.workJournal.append("daemon.heartbeat", { runId: this.run.id, runStatus: this.run.status, ts: now });
  }

  // --- shipped-map + working snapshot (D-1/D-5) ----------------------------

  // D-15: adoption trust. An absent seam means the deps cannot observe a
  // checkout at all (fixtures), which is trusted; a seam that answers null
  // (a real checkout whose branch could not be read) is not.
  private adoptionTrust(): { trusted: boolean; branch: string | null } {
    const read = this.deps.readCheckoutBranch;
    if (!read) return { trusted: true, branch: null };
    const branch = read();
    return { trusted: branch === (this.deps.defaultBranch ?? DEFAULT_BASE_BRANCH), branch };
  }

  private computeShippedMap(snapshot: RegistrySnapshot, pinOf: PinLookup): ShippedMap {
    const fold = this.workJournal.fold();
    const adoptedRecord = fold.byKind["dag.adopted"]?.[0];
    const adopted = new Map(adoptedRecord ? parseAdoptedPayload(adoptedRecord.payload) : new Map());

    // Refreshes are re-adoptions of amended bootstrap-era specs (D-11): an
    // adopted spec's amendment gets the same trust at next observation that
    // its original content got at first observation, provided the registry
    // still reports it complete or n-a. Pipeline-shipped specs never take
    // this path; their invalidation stays strict (spec 012 B-4).
    for (const rec of fold.byKind["dag.adopted.refreshed"] ?? []) {
      const p = rec.payload as { id?: string; newPin?: string };
      if (typeof p?.id === "string" && typeof p?.newPin === "string") {
        adopted.set(p.id, { pin: p.newPin, source: "adopted" });
      }
    }

    const state = foldOrchestratorState(fold.records);
    const pipelineShipped = new Set(
      [...state.specExecs.values()].filter((se) => se.status === "shipped").map((se) => se.specId)
    );

    // D-15: the refresh below appends durable adoption facts, so it only
    // trusts a registry read taken from the default branch. On a spec-branch
    // checkout an unmerged spec reads complete and would be adopted as
    // shipped (found live: a daemon restart on a failed spec's branch
    // adopted that spec and dead-ended the run on its dependent). Deferral
    // is journaled once per pass when it withheld at least one candidate;
    // readiness still uses the previously adopted set unchanged.
    const trust = this.adoptionTrust();
    const deferred: string[] = [];
    for (const [id, registryEntry] of snapshot) {
      // 012 D-3: an unapproved spec is never adoptable, no matter what its
      // implementation field claims; adoption is trust a draft has not
      // earned.
      const adoptable =
        statusSchedulable(registryEntry) &&
        (registryEntry.implementation === "complete" || registryEntry.implementation === "n-a");
      if (!adoptable || pipelineShipped.has(id)) continue;
      const currentPin = pinOf(id);
      const existing = adopted.get(id);
      if (!existing || existing.pin !== currentPin) {
        if (!trust.trusted) {
          deferred.push(id);
          continue;
        }
        this.workJournal.append("dag.adopted.refreshed", {
          id,
          oldPin: existing?.pin ?? null,
          newPin: currentPin,
        });
        adopted.set(id, { pin: currentPin, source: "adopted" });
      }
    }
    if (deferred.length > 0) {
      this.workJournal.append("dag.adoption.deferred", {
        branch: trust.branch,
        phase: "scheduling",
        candidates: deferred as unknown as JsonValue,
      });
    }

    const merged: Map<string, ShippedEntry> = new Map(adopted);
    for (const specExec of state.specExecs.values()) {
      if (specExec.status === "shipped") {
        merged.set(specExec.specId, { pin: this.pipelinePin(specExec.specId, specExec.pin), source: "pipeline" });
      }
    }
    // D-18: a successful requalification re-pins the shipped entry at the
    // amended content it verified; records replay in order, latest wins. A
    // further amendment drifts against the requalified pin and invalidates
    // again, so strictness is preserved.
    for (const rec of fold.byKind["spec.requalified"] ?? []) {
      const p = rec.payload as { specId?: string; pin?: string };
      if (typeof p?.specId === "string" && typeof p?.pin === "string" && merged.get(p.specId)?.source === "pipeline") {
        merged.set(p.specId, { pin: p.pin, source: "pipeline" });
      }
    }
    return merged;
  }

  // D-16: a pipeline-shipped spec's contract is the content its own merge
  // landed, not the pre-flip content the exec was pinned at when scheduled.
  // The build session's frontmatter flip is part of the ship, so the
  // creation-time pin drifts against the spec's own merge and every future
  // dependent is born blocked (found live: 027, the first spec to depend on
  // a pipeline-shipped spec, was blocked by 026's own flip). The merged
  // content is evidence-anchored by the journaled merge sha, so the pin is
  // derived from the file at that sha. Any post-merge amendment still
  // drifts against it, which is exactly spec 012 B-4's cascade. A missing
  // sha or unreadable file falls back to the exec pin, which can only
  // over-invalidate, never under-invalidate.
  private readonly pipelinePinCache = new Map<string, string>();

  private pipelinePin(specId: string, execPin: string): string {
    const sha = this.findMergeShaForSpec(specId);
    if (!sha) return execPin;
    const read = this.deps.readSpecFileAtSha;
    if (!read) return execPin;
    const cacheKey = `${specId}@${sha}`;
    const cached = this.pipelinePinCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const bytes = read(sha, specId);
    if (!bytes) return execPin;
    const pin = pinOfBytes(bytes);
    this.pipelinePinCache.set(cacheKey, pin);
    return pin;
  }

  // nextReady's own readiness filter trusts the target repo's registry
  // `implementation: pending` field, which in production only flips once the
  // build session's frontmatter edit has been merged back to the default
  // branch and the registry re-read reflects it; a spec this run has already
  // shipped (or a human has skipped) is excluded here regardless of what the
  // registry currently reports, so a lagging registry read never causes the
  // same spec to be picked twice (Resolved decisions, D-5).
  private buildWorkingSnapshot(
    snapshot: RegistrySnapshot,
    shippedSpecIds: ReadonlySet<string>,
    resumableSpecIds: ReadonlySet<string>
  ): RegistrySnapshot {
    if (this.skippedSpecIds.size === 0 && shippedSpecIds.size === 0 && resumableSpecIds.size === 0) return snapshot;
    const out = new Map<string, RegistrySpecEntry>(snapshot);
    for (const [id, entry] of snapshot) {
      if (shippedSpecIds.has(id)) out.set(id, { ...entry, implementation: "orchestrator-shipped" });
      else if (this.skippedSpecIds.has(id)) out.set(id, { ...entry, implementation: "orchestrator-skipped" });
      // A spec whose SpecExec in this run is live or failed reads as
      // schedulable regardless of the registry's implementation field: the
      // build bracket flips the spec to in-progress on its branch, and that
      // flip must not hide the spec from its own resume (the live run hit
      // exactly this: ship failed, retryStage issued, and nextReady skipped
      // the spec because its frontmatter honestly said in-progress).
      else if (resumableSpecIds.has(id)) out.set(id, { ...entry, implementation: "pending" });
    }
    return out;
  }

  // --- the loop (B-3) -----------------------------------------------------

  private async runLoop(): Promise<LoopYield> {
    let yielded: LoopYield | null = null;

    while (!this.shutdownRequested) {
      this.applyPendingControls();

      if (this.run.status === "paused") {
        // 026 B-3: a supervised run paused on a human decision gives the one
        // flight slot back, so another project may proceed while this one
        // waits; the run itself stays paused and live, resumed by a later
        // drive() once a control has queued.
        if (this.deps.supervised) {
          yielded = "paused";
          break;
        }
        await this.chunkedSleepUntil(() => (this.run.status as RunStatus) !== "paused");
        continue;
      }

      // 026 B-5: quota is one account-wide pool, so a quota park is not a
      // yield. Holding the slot through the wait is exactly what stops another
      // project from starting a session before the horizon resumes this one.
      //
      // 033 B-6 is the deliberate opposite for a cost ceiling: a ceiling is one
      // project's setting, so a budget park hands the slot back and other
      // projects proceed. A horizon that has already passed is not a wait at
      // all, so it resumes here rather than yielding into an immediate
      // re-drive.
      if (this.run.status === "parked") {
        const horizon = this.parkHorizon();
        if (
          this.deps.supervised &&
          horizon !== null &&
          horizon.releasesSlot &&
          this.deps.clock.now() < horizon.targetMs
        ) {
          yielded = "paused";
          break;
        }
        await this.resumeFromPark();
        continue;
      }

      if (this.run.status === "completed" || this.run.status === "failed") {
        break;
      }

      this.maybeHeartbeat();

      if (this.reverifyQueue.length > 0) {
        const specId = this.reverifyQueue.shift()!;
        await this.runReverify(specId);
        continue;
      }

      // D-17: a scheduling pass reads the registry, and the last stage may
      // have left the checkout on a spec branch (ship works there; shepherd
      // never moves it back). Registry truth lives on the default branch, so
      // a clean checkout is put back on it before the read; when this cannot
      // happen the D-15 guard already defers adoption rather than trusting
      // the branch.
      this.deps.normalizeCheckoutForScheduling?.();

      const snapshot = loadRegistrySnapshot(this.deps.dagReader, this.deps.repoDir);
      const pinOf = makePinLookup(this.deps.dagReader, this.deps.repoDir);
      const shipped = this.computeShippedMap(snapshot, pinOf);
      const folded = foldOrchestratorState(this.workJournal.fold().records);
      const resumable = new Set(
        [...folded.specExecs.values()]
          .filter((se) => se.runId === this.run.id && (isLive(se) || se.status === "failed"))
          .map((se) => se.specId)
      );
      const workingSnapshot = this.buildWorkingSnapshot(snapshot, new Set(shipped.keys()), resumable);
      const next = nextReady(workingSnapshot, shipped, pinOf);

      if (typeof next === "string") {
        await this.runSpec(next, snapshot, shipped, pinOf);
        continue;
      }

      if (next.blockers.length === 0) {
        this.workJournal.append("run.result", { runId: this.run.id, status: "completed" });
        this.run = { ...transition(this.workJournal, this.run, "completed"), needsReconcile: false };
        break;
      }

      const blockersPayload = next.blockers.map((b) => ({ specId: b.specId, reasons: [...b.reasons] }));
      this.workJournal.append("run.blocked", { runId: this.run.id, blockers: blockersPayload });
      this.run = { ...transition(this.workJournal, this.run, "failed"), needsReconcile: false };
      break;
    }

    if (this.shutdownRequested) {
      this.workJournal.append("daemon.shutdown", { runId: this.run.id, runStatus: this.run.status });
      return "shutdown";
    }
    if (yielded !== null) return yielded;
    return this.run.status === "failed" ? "failed" : "completed";
  }

  // What governs the next spawn while this run is parked. A quota park and a
  // budget park may coexist (033 section 6), and the later horizon simply
  // wins: resuming at the earlier one would spawn a session the other park
  // exists to prevent. `releasesSlot` is true only when nothing but a budget
  // park is open, since the account-wide pool a quota park is waiting on is
  // not this project's to hand back (026 B-5, 033 B-6).
  private parkHorizon(): { readonly targetMs: number; readonly releasesSlot: boolean } | null {
    const records = this.workJournal.fold().records;
    const quota = foldQuotaState(records);
    const quotaTargetMs = quota.parked && quota.lastPark ? quota.lastPark.targetMs : null;
    const budgetStop = foldBudgetState(records).stop;
    const budgetTargetMs =
      budgetStop !== null && budgetStop.reason === "budget-day" ? budgetStop.targetMs : null;

    if (quotaTargetMs === null && budgetTargetMs === null) return null;
    return {
      targetMs: Math.max(quotaTargetMs ?? Number.NEGATIVE_INFINITY, budgetTargetMs ?? Number.NEGATIVE_INFINITY),
      releasesSlot: quotaTargetMs === null,
    };
  }

  // FR-002 for both park kinds: the countdown is derived from the journaled
  // target, never from restart time, so a daemon killed mid-park resumes the
  // horizon it was already waiting on. Answers false when shutdown interrupted
  // the wait, in which case nothing was journaled and the run stays parked.
  private async resumeFromPark(): Promise<boolean> {
    const horizon = this.parkHorizon();
    if (horizon === null) {
      // Structurally should not happen (a "parked" run always has a park
      // record); resolve defensively rather than spin forever.
      this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
      return true;
    }
    const jitterMs = resumeJitterMs(this.deps.rng, this.deps.resumeJitterMinMs, this.deps.resumeJitterMaxMs);
    await this.chunkedSleepUntil(() => isResumeDue(this.deps.clock.now(), horizon.targetMs, jitterMs));
    if (this.shutdownRequested) return false;
    // One resume record per park actually open: a stray resume for a park that
    // never happened would leave spec 030's parked-duration fold pairing
    // windows that do not exist.
    const records = this.workJournal.fold().records;
    if (foldQuotaState(records).parked) journalResume(this.workJournal, this.deps.clock.now());
    if (foldBudgetState(records).stop !== null) journalBudgetResume(this.workJournal, this.deps.clock.now());
    this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
    return true;
  }

  // --- per-spec walk (B-3) -------------------------------------------------

  private async runSpec(specId: string, snapshot: RegistrySnapshot, shipped: ShippedMap, pinOf: PinLookup): Promise<void> {
    const state = foldOrchestratorState(this.workJournal.fold().records);
    let specExec = [...state.specExecs.values()].find(
      (se) => se.runId === this.run.id && se.specId === specId && (isLive(se) || se.status === "failed")
    );

    if (!specExec) {
      const pin = pinOf(specId);
      const created = createSpecExec(this.workJournal, this.run.id, specId, pin);
      specExec = { ...created, needsReconcile: false };
    }

    if (specExec.status === "failed" || specExec.status === "pending") {
      specExec = { ...transition(this.workJournal, specExec, "building"), needsReconcile: false };
    }

    const startIndex = STAGE_ORDER.findIndex((s) => STATUS_FOR_STAGE[s] === specExec!.status);
    if (startIndex === -1) return; // defensive: not a live "walking a stage" status

    for (let i = startIndex; i < STAGE_ORDER.length; i++) {
      if (this.shutdownRequested) return;
      const stage = STAGE_ORDER[i]!;
      const outcome = await this.runStageWithRetries(stage, specExec, snapshot, shipped, pinOf, false);
      if (outcome.kind !== "passed") return;

      if (outcome.result.stage === "shepherd" && outcome.result.result.evidence.mergeSha) {
        this.workJournal.append("daemon.merge-sha", {
          specId: specExec.specId,
          mergeSha: outcome.result.result.evidence.mergeSha,
        });
      }

      specExec = { ...transition(this.workJournal, specExec, NEXT_STATUS_AFTER_STAGE[stage]), needsReconcile: false };
    }
  }

  // B-4 (spec 022's forceHumanGate): re-verifies an already-shipped spec
  // (spec 012 B-4's own re-qualification path), skipping straight to the
  // verify stage rather than walking build/ship/shepherd again.
  private async runReverify(specId: string): Promise<void> {
    const state = foldOrchestratorState(this.workJournal.fold().records);
    const specExec = [...state.specExecs.values()].find(
      (se) => se.runId === this.run.id && se.specId === specId && se.status === "shipped"
    );
    if (!specExec) {
      // D-18: a spec pipeline-shipped under a PRIOR run has no exec to
      // transition in this one, but an amendment after its merge is exactly
      // spec 012 B-4's re-qualification case, and without this path the
      // invalidation blocks every dependent forever (found live: 026's
      // session amended 023, and 028 was unbuildable).
      const priorShipped = [...state.specExecs.values()].find(
        (se) => se.specId === specId && se.status === "shipped"
      );
      if (priorShipped) {
        await this.requalifyPriorShipped(specId);
        return;
      }
      this.workJournal.append("control.reverify.refused", {
        specId,
        reason: "no shipped specExec found for this spec under the current run",
      });
      return;
    }

    let current: FoldedSpecExec = { ...transition(this.workJournal, specExec, "invalidated"), needsReconcile: false };
    current = { ...transition(this.workJournal, current, "verifying"), needsReconcile: false };

    const snapshot = loadRegistrySnapshot(this.deps.dagReader, this.deps.repoDir);
    const pinOf = makePinLookup(this.deps.dagReader, this.deps.repoDir);
    const shipped = this.computeShippedMap(snapshot, pinOf);

    const outcome = await this.runStageWithRetries("verify", current, snapshot, shipped, pinOf, true);
    if (outcome.kind === "passed") {
      transition(this.workJournal, current, "shipped");
    }
  }

  // --- per-stage retry loop (B-3, B-4 gate, spec 015 park/resume) ---------

  private async runStageWithRetries(
    stage: Stage,
    specExec: FoldedSpecExec,
    snapshot: RegistrySnapshot,
    shipped: ShippedMap,
    pinOf: PinLookup,
    isReVerification: boolean
  ): Promise<StageWalkOutcome> {
    let attempt = 1;
    let budgetUsed = 0;
    const maxBudget = this.deps.stageRetryBudget ?? DEFAULT_STAGE_RETRY_BUDGET;

    while (true) {
      if (this.shutdownRequested) return { kind: "shutdown" };
      this.applyPendingControls();

      // A pause() applied just now (this loop is the only checkpoint between
      // one stage finishing and the next one starting, B-4) must stop a new
      // stage attempt from starting, not merely be recorded for later.
      if (this.run.status !== "running") return { kind: "paused" };

      if (this.forcedGateSpecIds.has(specExec.specId) && !this.approvedGateSpecIds.has(specExec.specId)) {
        this.workJournal.append("daemon.gate.waiting", { specId: specExec.specId, stage });
        this.pauseRun(`${specExec.specId}: awaiting human approval before ${stage}`);
        // 026 B-3: waiting on an approval is waiting on a human, so a
        // supervised run hands the slot back rather than holding it. The walk
        // resumes from this same spec's live status on the next drive().
        if (this.deps.supervised) return { kind: "paused" };
        await this.chunkedSleepUntil(() => this.approvedGateSpecIds.has(specExec.specId));
        if (this.shutdownRequested) return { kind: "shutdown" };
        this.approvedGateSpecIds.delete(specExec.specId);
        this.forcedGateSpecIds.delete(specExec.specId);
        // The approval may already have lifted the pause (applyPendingControls
        // above), so this only closes the gap when the wait ended some other
        // way; transitioning a running run to running is not a legal edge.
        if (this.run.status !== "running") {
          this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };
        }
      }

      // 033 B-2: the session spawn boundary. Every stage attempt below spawns
      // at least one session, and this is the last point at which not spawning
      // one is still free, so the ceiling is evaluated here and nothing is
      // minted when it has been crossed. Nothing is ever killed mid-flight for
      // budget (D-2): overshoot is bounded by the one session already in
      // flight, and the trip record says so.
      const stop = this.budgetStopAtBoundary();
      if (stop !== null) {
        if (stop.reason === "budget-run") {
          // B-4: no clock makes a run cheaper, so this waits for an operator
          // (a raised or cleared ceiling, or a retry/skip verb) rather than
          // for a horizon that would only bring the same trip back.
          journalBudgetPause(this.workJournal, stop);
          this.pauseRun(`${specExec.specId}: ${renderBudgetStop(stop)}`, "budget-run");
          return { kind: "paused" };
        }
        journalBudgetPark(this.workJournal, stop);
        this.run = { ...transition(this.workJournal, this.run, "parked"), needsReconcile: false };
        // B-6: a ceiling is per-project, so a supervised run gives the flight
        // slot back instead of holding it through the horizon the way a quota
        // park does. The loop's parked branch yields on the next pass.
        if (this.deps.supervised) return { kind: "paused" };
        if (!(await this.resumeFromPark())) return { kind: "shutdown" };
        attempt++;
        continue; // resumes the same stage as a fresh attempt, no budget spent
      }

      let stageExec = { ...createStageExec(this.workJournal, specExec.id, stage, attempt), needsReconcile: false };
      stageExec = { ...transition(this.workJournal, stageExec, "running"), needsReconcile: false };

      // A stage implementation throwing is a failed attempt with the error
      // as evidence, never a dead daemon: the loop must outlive any single
      // stage's bug (the live run died to a bracket error that should have
      // been an honest stage failure).
      let tagged: TaggedStageResult;
      try {
        tagged = await this.callStage(stage, specExec, snapshot, shipped, pinOf, isReVerification);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        this.workJournal.append("stage.crashed", { specId: specExec.specId, stage, attempt, error: message });
        transition(this.workJournal, stageExec, "failed");
        budgetUsed++;
        if (budgetUsed > maxBudget) {
          transition(this.workJournal, specExec, "failed");
          this.pauseRun(`${specExec.specId}: ${stage} crashed after ${budgetUsed} attempt(s): ${message}`);
          return { kind: "paused" };
        }
        attempt++;
        continue;
      }
      this.maybeHeartbeat();

      const quota = detectQuotaClassification(tagged);
      if (quota) {
        transition(this.workJournal, stageExec, "failed");
        const lastPark: LastParkInfo | undefined = foldQuotaState(this.workJournal.fold().records).lastPark ?? undefined;
        const plan: ParkPlan = planPark({ classification: quota, now: this.deps.clock.now(), lastPark });
        journalPark(this.workJournal, plan);
        this.run = { ...transition(this.workJournal, this.run, "parked"), needsReconcile: false };

        const jitterMs = resumeJitterMs(this.deps.rng, this.deps.resumeJitterMinMs, this.deps.resumeJitterMaxMs);
        const targetMs = plan.targetMs;
        await this.chunkedSleepUntil(() => isResumeDue(this.deps.clock.now(), targetMs, jitterMs));
        if (this.shutdownRequested) return { kind: "shutdown" };
        journalResume(this.workJournal, this.deps.clock.now());
        this.run = { ...transition(this.workJournal, this.run, "running"), needsReconcile: false };

        attempt++;
        continue; // resumes the same stage as a fresh attempt, no budget spent
      }

      if (isPassOutcome(tagged)) {
        transition(this.workJournal, stageExec, "passed");
        return { kind: "passed", result: tagged };
      }

      if (isBlockedOutcome(tagged)) {
        transition(this.workJournal, stageExec, "blocked");
        // D-25: a refusal's pause reason carries the refusal itself, bounded,
        // so the status surface answers "why is it paused right now" without
        // an operator spelunking the journal (found live: a gate-red-at-base
        // pause that read only as `build outcome "refused"`).
        const refusal = tagged.stage === "build" ? tagged.result.evidence.refusal : null;
        const detail = refusal === null ? "" : ` (${refusal.kind}: ${refusal.message.trim().slice(0, 400)})`;
        this.pauseRun(`${specExec.specId}: ${stage} outcome "${tagged.result.outcome}"${detail}`);
        return { kind: "paused" };
      }

      // failed
      transition(this.workJournal, stageExec, "failed");
      budgetUsed++;
      if (budgetUsed > maxBudget) {
        transition(this.workJournal, specExec, "failed");
        this.pauseRun(`${specExec.specId}: ${stage} failed after ${budgetUsed} attempt(s)`);
        return { kind: "paused" };
      }
      attempt++;
      // retries the same stage with a fresh StageExec attempt
    }
  }

  // 033 B-2: the ceiling read at a spawn boundary, and the stop it plans, or
  // null when this project has no ceiling or is still under it. The ceiling is
  // resolved through the seam on every call, so one raised through a control
  // surface applies at the very next boundary.
  private budgetStopAtBoundary(): BudgetStopPlan | null {
    const ceiling = resolveCeilingSource(this.deps.ceiling);
    if (ceiling === null) return null;
    const nowMs = this.deps.clock.now();
    const evaluation = evaluateBudget({
      records: this.workJournal.fold().records,
      ceiling,
      nowMs,
      runId: this.run.id,
    });
    return planBudgetStop(evaluation, nowMs);
  }

  // `reasonKind` is spec 033 B-4's machine-readable half (state.ts's
  // RunPauseReason); the sentence stays exactly what it was, because it is
  // what an operator reads. Every pre-033 pause is a stage pause, which is
  // what the default says.
  private pauseRun(reason: string, reasonKind: RunPauseReason = "stage"): void {
    if (this.run.status !== "running") return;
    this.workJournal.append("run.pause-reason", { runId: this.run.id, reason, reasonKind });
    this.run = { ...transition(this.workJournal, this.run, "paused"), needsReconcile: false };
  }

  private async callStage(
    stage: Stage,
    specExec: FoldedSpecExec,
    snapshot: RegistrySnapshot,
    shipped: ShippedMap,
    pinOf: PinLookup,
    isReVerification: boolean
  ): Promise<TaggedStageResult> {
    switch (stage) {
      case "build": {
        const options: RunBuildStageOptions = {
          runner: this.deps.runner,
          specId: specExec.specId,
          journal: this.workJournal,
          decisionsChain: this.decisionsChain,
          dropboxDir: this.dropboxDir,
          knownSpecIds: new Set(snapshot.keys()),
          isSpecReady: this.makeReadinessCheck(snapshot, shipped, pinOf),
          defaultBranch: this.deps.defaultBranch,
        };
        const result = await this.deps.stageFns.build(options);
        return { stage, result };
      }
      case "ship": {
        const options: RunShipStageOptions = {
          runner: this.deps.runner,
          gh: this.deps.gh,
          specId: specExec.specId,
          journal: this.workJournal,
        };
        const result = await this.deps.stageFns.ship(options);
        return { stage, result };
      }
      case "shepherd": {
        const options: RunShepherdStageOptions = {
          runner: this.deps.runner,
          gh: this.deps.gh,
          specId: specExec.specId,
          journal: this.workJournal,
          clock: { now: () => this.deps.clock.now(), sleep: (ms: number) => this.deps.sleep(ms) },
          defaultBranch: this.deps.defaultBranch,
        };
        const result = await this.deps.stageFns.shepherd(options);
        return { stage, result };
      }
      case "verify": {
        const sha = this.findMergeShaForSpec(specExec.specId);
        if (sha === null) {
          throw new Error(`daemon: no merge sha recorded for ${specExec.specId}; cannot run the verify stage`);
        }
        const options: RunVerifyStageOptions = {
          runner: this.deps.verifyRunner,
          browserVerifier: this.deps.browserVerifier,
          specId: specExec.specId,
          sha,
          journal: this.workJournal,
          evidenceDir: this.evidenceDir,
          isReVerification,
        };
        const result = await this.deps.stageFns.verify(options);
        return { stage, result };
      }
    }
  }

  // D-18: verify an amended, prior-run pipeline-shipped spec at the current
  // default-branch head; a pass re-pins its shipped entry at the amended
  // content. No SpecExec is created: the run bookkeeping (spec 013) stays
  // untouched, and the journal carries intent and outcome directly.
  private async requalifyPriorShipped(specId: string): Promise<void> {
    this.deps.normalizeCheckoutForScheduling?.();
    const sha = this.deps.readHeadSha?.() ?? null;
    if (sha === null) {
      this.workJournal.append("spec.requalify.refused", {
        specId,
        reason: "the current checkout's head sha is not readable",
      });
      return;
    }
    const pin = makePinLookup(this.deps.dagReader, this.deps.repoDir)(specId);
    this.workJournal.append("spec.requalify.intent", { specId, sha, pin });
    const options: RunVerifyStageOptions = {
      runner: this.deps.verifyRunner,
      browserVerifier: this.deps.browserVerifier,
      specId,
      sha,
      journal: this.workJournal,
      evidenceDir: this.evidenceDir,
      isReVerification: true,
    };
    try {
      const result = await this.deps.stageFns.verify(options);
      if (result.outcome === "passed" || result.outcome === "not-declared") {
        this.workJournal.append("spec.requalified", { specId, sha, pin, outcome: result.outcome });
      } else {
        this.workJournal.append("spec.requalify.failed", { specId, sha, outcome: result.outcome });
      }
    } catch (err) {
      this.workJournal.append("spec.requalify.failed", {
        specId,
        sha,
        outcome: "crashed",
        detail: (err as Error).message,
      });
    }
  }

  private makeReadinessCheck(snapshot: RegistrySnapshot, shipped: ShippedMap, pinOf: PinLookup): ReadinessCheck {
    return (id: string) => ready(snapshot, shipped, pinOf, id);
  }

  private findMergeShaForSpec(specId: string): string | null {
    const records = this.workJournal.fold().byKind["daemon.merge-sha"] ?? [];
    for (let i = records.length - 1; i >= 0; i--) {
      const payload = records[i]!.payload;
      if (!isJsonRecord(payload)) continue;
      if (payload.specId === specId && typeof payload.mergeSha === "string") return payload.mergeSha;
    }
    return null;
  }
}
