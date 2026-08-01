// The standby daemon and its multi-project scheduler (spec 026): the layer
// that stops the daemon dying of success. A run reaching completed or failed
// used to end the process, taking the API and the UI with it, so "mission
// complete" and "not running" were the same observable (010 A-1). Here a
// terminal run is simply the end of that project's turn: the process, the
// identity lock, and the API stay up, and the scheduler looks for the next
// project with work.
//
// The whole policy is registration order (D-1). Above spec 021's per-run loop
// sits one cycle:
//
//   1. re-fold the project registry (025) and observe every project once,
//   2. resume any paused run whose human decision has arrived (B-3's
//      priority half), else
//   3. give the flight slot to the first armed, qualified project whose
//      registry read shows work its last conclusion did not already see,
//   4. and when nothing at all is schedulable, wait out a bounded scan
//      interval and start over (B-4).
//
// Three invariants shape the code below. There is exactly one flight slot:
// the scheduler awaits one project's drive() at a time, which is what makes
// "at most one live stage session globally" (010 B-5, D15) structural rather
// than checked. Quota is global (B-5): a parked run keeps the slot while it
// waits, so no other project can start a session before the spec 015 horizon
// resumes it. And there is one identity lock per daemon home (B-6): the
// scheduler holds it and every project's run is a `supervised` Daemon that
// takes none of its own, while each project's journals still take spec 011's
// per-chain writer lock inside that project's own state root.
//
// Nothing here journals a chain of its own. Runs, journals, and recovery
// semantics from 013, 011, and 021 are untouched; each project's evidence
// goes on living inside that project (010 D13). What standby knows that no
// journal records is transient by nature (what was observed on the last
// scan), so it is exposed as a snapshot and logged, and specs 027-029 render
// it.
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle } from "./journal";
import type { DaemonDeps, LoopYield, ProcessInspector } from "./daemon";
import {
  DEFAULT_SLEEP_CHUNK_MS,
  Daemon,
  acquireDaemonLock,
  forceReleaseDaemonLock,
  releaseDaemonLock,
} from "./daemon";
import { loadRegistrySnapshot } from "./dag";
import type { Project, ProjectProbe, ProjectsSnapshot } from "./projects";
import { foldProjects, openProjectsChain, qualifyProject, registerProject } from "./projects";
import type { RunStatus } from "./state";

// --- scan interval (B-4) ----------------------------------------------------

export const DEFAULT_SCAN_INTERVAL_MS = 60_000;

// --- lock hygiene (B-6) -----------------------------------------------------

// The per-chain writer locks that live beside a chain in the daemon home or
// in a project's state root. Deliberately not `daemon.lock`: that one is the
// identity lock, and a running standby daemon owns it.
const CHAIN_LOCK_FILES = ["journal.lock", "decisions.lock", "projects.lock"] as const;

export function clearChainLocks(dir: string): void {
  for (const name of CHAIN_LOCK_FILES) {
    try {
      fs.unlinkSync(join(dir, name));
    } catch {
      // not present
    }
  }
}

// What a supervisor does once it has confirmed the previous standby daemon
// dead by some means of its own (021's forceReleaseDaemonLock, generalized
// across the registry chain in the daemon home and every project state root
// that daemon could have been writing). Never called by the scheduler on
// itself; its own stale-lock reclaim runs off acquireDaemonLock's identity
// check, which is the stronger test.
export function forceReleaseStandbyLocks(daemonHomeDir: string, stateRoots: readonly string[]): void {
  forceReleaseDaemonLock(daemonHomeDir);
  clearChainLocks(daemonHomeDir);
  for (const root of stateRoots) clearChainLocks(root);
}

// --- observation (B-4) ------------------------------------------------------

// What standby currently sees of one project. "driving" is the flight-slot
// holder; "paused" is a live run that gave the slot back to a human decision;
// "idle" is armed and qualified with nothing to pick up right now; "disarmed"
// is observed and reported but never driven (D-2); "unqualified" is 025's own
// recorded verdict refusing it; "errored" is a target whose registry could not
// be read, whose run would not start, or whose loop died, reported with the
// reason rather than retried blindly.
export type ProjectDisposition =
  | "driving"
  | "paused"
  | "idle"
  | "disarmed"
  | "unqualified"
  | "errored";

export interface ProjectStandbyView {
  readonly name: string;
  readonly repoDir: string;
  readonly armed: boolean;
  readonly qualified: boolean;
  readonly disposition: ProjectDisposition;
  readonly detail: string;
  readonly pendingSpecIds: readonly string[];
  readonly runId: string | null;
  readonly runStatus: RunStatus | null;
}

export type StandbyState = "starting" | "scheduling" | "standby" | "stopped";

export interface StandbySnapshot {
  readonly state: StandbyState;
  readonly daemonHomeDir: string;
  readonly activeProject: string | null;
  readonly scanIntervalMs: number;
  readonly lastScanMs: number | null;
  readonly projects: readonly ProjectStandbyView[];
}

// --- deps -------------------------------------------------------------------

// Registers the checkout the daemon was pointed at as the first project when
// the registry chain has never held a record (D-3). Absent leaves an empty
// registry empty.
export interface StandbyBootstrap {
  readonly repoDir: string;
  readonly probe: ProjectProbe;
}

export interface StandbyDeps {
  // Where the identity lock, the log, and the project registry live (010
  // D13). Not a project state root of its own, though the self-hosted project
  // registers the checkout whose data/orchestrator/ this is.
  readonly daemonHomeDir: string;
  // One project's run deps. `dataDir` must be that project's own state root
  // (projectStateRoot(project.repoDir), 010 D13) and `supervised` must be
  // true (B-6); the scheduler refuses deps that say otherwise rather than
  // letting a second identity lock appear inside a target.
  readonly makeProjectDeps: (project: Project) => DaemonDeps;
  readonly processInspector: ProcessInspector;
  // `clock.now()` must advance as `sleep()` resolves: the standby wait is a
  // deadline read off this clock, chunked so shutdown is honored promptly.
  readonly clock: { now(): number };
  readonly sleep: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly pid?: number;
  readonly scanIntervalMs?: number;
  readonly sleepChunkMs?: number;
  readonly bootstrap?: StandbyBootstrap | null;
}

// --- internals --------------------------------------------------------------

interface ProjectScan {
  readonly ok: boolean;
  readonly pendingSpecIds: readonly string[];
  // Every spec's id and implementation field, sorted and joined: the cheap
  // "has anything changed here" key a conclusion is remembered against.
  readonly signature: string;
  readonly reason: string | null;
}

const UNREADABLE_SCAN: ProjectScan = { ok: false, pendingSpecIds: [], signature: "", reason: null };

export class StandbyDaemon {
  private readonly deps: StandbyDeps;
  private readonly logLine: (line: string) => void;
  private readonly scanIntervalMs: number;

  private started = false;
  private closed = false;
  private shutdownRequested = false;

  private lockPath: string | null = null;
  private chain!: JournalHandle;
  private registry: ProjectsSnapshot = new Map();

  // Projects whose run is live but not in flight: a run paused on a human
  // decision, holding its own journals open, waiting to be driven again.
  private readonly live = new Map<string, Daemon>();
  // The registry signature each project's last conclusion settled on (D-4):
  // a project is not re-driven until its own corpus says something new.
  private readonly settled = new Map<string, string>();
  private readonly views = new Map<string, ProjectStandbyView>();
  private readonly depsCache = new Map<string, { readonly repoDir: string; readonly deps: DaemonDeps }>();
  // The last failure reported for a project, so a target that stays broken
  // does not repeat itself in the log on every scan.
  private readonly failures = new Map<string, string>();

  private stateValue: StandbyState = "starting";
  private activeName: string | null = null;
  private activeDaemonValue: Daemon | null = null;
  private lastScanMs: number | null = null;

  private loopPromise: Promise<void> | null = null;
  private loopError: unknown = null;

  constructor(deps: StandbyDeps) {
    this.deps = deps;
    this.logLine = deps.log ?? ((line: string) => console.log(line));
    this.scanIntervalMs = deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  }

  // --- introspection (transient by nature; the durable truth is each
  // project's own journal) --------------------------------------------------

  get state(): StandbyState {
    return this.stateValue;
  }

  get projects(): ProjectsSnapshot {
    return this.registry;
  }

  // The registry chain's writer handle. The scheduler holds it for its whole
  // lifetime (one writer per chain, spec 011 B-2), so a control surface that
  // wants to register, arm, or remove a project mutates through this rather
  // than opening a second handle.
  get projectsChain(): JournalHandle {
    return this.chain;
  }

  // The daemon holding the flight slot, or null while in standby.
  get activeDaemon(): Daemon | null {
    return this.activeDaemonValue;
  }

  // Every project with a live run right now: the flight-slot holder while one
  // is driving, plus every run paused waiting on a human.
  get liveDaemons(): readonly (readonly [string, Daemon])[] {
    const out: (readonly [string, Daemon])[] = [];
    if (this.activeName !== null && this.activeDaemonValue !== null) {
      out.push([this.activeName, this.activeDaemonValue] as const);
    }
    for (const [name, daemon] of this.live) {
      if (name !== this.activeName) out.push([name, daemon] as const);
    }
    return out;
  }

  daemonFor(name: string): Daemon | null {
    if (name === this.activeName && this.activeDaemonValue) return this.activeDaemonValue;
    return this.live.get(name) ?? null;
  }

  get snapshot(): StandbySnapshot {
    return {
      state: this.stateValue,
      daemonHomeDir: this.deps.daemonHomeDir,
      activeProject: this.activeName,
      scanIntervalMs: this.scanIntervalMs,
      lastScanMs: this.lastScanMs,
      projects: [...this.registry.keys()].map((name) => this.views.get(name)).filter((v): v is ProjectStandbyView => Boolean(v)),
    };
  }

  // --- lifecycle (B-1, B-6, B-7) --------------------------------------------

  async start(): Promise<void> {
    if (this.started) throw new Error("standby: start() called twice");
    this.started = true;

    const lock = acquireDaemonLock(this.deps.daemonHomeDir, this.deps.processInspector, this.deps.pid ?? process.pid);
    this.lockPath = lock.lockPath;

    // Reclaim proved the previous standby daemon dead by pid plus process
    // start time, a stronger test than any per-chain lock file's existence.
    // The registry chain's own lock is cleared first (nothing else can tell
    // us which projects existed), then every project's, once the fold has
    // named the state roots that daemon could have been writing.
    if (lock.reclaimedFrom) clearChainLocks(this.deps.daemonHomeDir);

    this.chain = openProjectsChain(this.deps.daemonHomeDir);
    this.bootstrapIfVirgin();
    this.registry = foldProjects(this.chain.fold().records);

    if (lock.reclaimedFrom) {
      let cleared = 0;
      for (const project of this.registry.values()) {
        try {
          clearChainLocks(this.stateRootOf(project));
          cleared++;
        } catch (err) {
          // A project whose deps cannot even be built keeps its own locks;
          // the scan reports it, and one such target does not stop the boot.
          this.logLine(`standby: could not clear "${project.name}" chain locks: ${(err as Error).message}`);
        }
      }
      this.logLine(`standby: reclaimed a stale lock from pid ${lock.reclaimedFrom.pid}, cleared ${cleared} project chain lock(s)`);
    }

    this.logLine(`standby: ${this.registry.size} project(s) registered in ${this.deps.daemonHomeDir}`);
    this.loopPromise = this.schedulerLoop().then(
      () => undefined,
      (err) => {
        this.loopError = err;
      }
    );
  }

  // Resolves only when the scheduler loop exits, which in standby means an
  // operator stopped the daemon (B-1): a terminal run no longer ends it.
  async join(): Promise<void> {
    if (!this.loopPromise) throw new Error("standby: join() called before start()");
    await this.loopPromise;
    if (this.loopError) throw this.loopError;
  }

  // B-7: in standby there is nothing to sever, so the current wait chunk is
  // the whole latency. Mid-run this sets 021 B-6's own flag on the daemon
  // holding the slot and awaits that drive(), so D-2's "an in-flight stage
  // runs to completion first" is inherited exactly.
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.activeDaemonValue?.requestShutdown();
    if (this.loopPromise) await this.loopPromise;
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const daemon of this.live.values()) {
      try {
        await daemon.shutdown();
      } catch {
        // a project whose journals are already closed
      }
    }
    this.live.clear();
    try {
      this.chain?.close();
    } catch {
      // already closed
    }
    if (this.lockPath) releaseDaemonLock(this.lockPath);
    this.stateValue = "stopped";
  }

  // --- bootstrap (D-3) -------------------------------------------------------

  // A virgin registry chain means nothing has ever been registered, so the
  // checkout the daemon was pointed at becomes the first project (025: "the
  // self-hosted checkout is not special, it is simply the first registered
  // project"). Once anything has been registered this never fires again, even
  // if every project was later removed: an emptied registry is the operator's
  // decision, not an absence to fill.
  private bootstrapIfVirgin(): void {
    const boot = this.deps.bootstrap;
    if (!boot) return;
    if (this.chain.fold().records.length > 0) return;
    try {
      const qualification = qualifyProject(boot.probe, boot.repoDir);
      const { project } = registerProject({
        chain: this.chain,
        repoDir: boot.repoDir,
        qualification,
        source: "cli",
      });
      const verdict = qualification.qualified
        ? "qualified"
        : `unqualified: ${qualification.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`;
      this.logLine(`standby: registered "${project?.name}" (${boot.repoDir}) as the first project, ${verdict}`);
    } catch (err) {
      // A daemon that cannot name its own checkout still runs: it idles in
      // standby with an empty registry and says why, rather than refusing to
      // boot over a target an operator can fix or replace.
      this.logLine(`standby: could not register ${boot.repoDir} as the first project: ${(err as Error).message}`);
    }
  }

  // --- the scheduler loop (B-2, B-3, B-4) ------------------------------------

  private async schedulerLoop(): Promise<void> {
    while (!this.shutdownRequested) {
      let serviced: boolean;
      try {
        serviced = await this.runCycle();
      } catch (err) {
        // The scheduler must outlive any single cycle's failure, which is 021
        // D-13's discipline one level up: a registry fold or a project scan
        // that throws is reported and slept off, never a dead daemon.
        this.logLine(`standby: scan failed: ${(err as Error).message}`);
        serviced = false;
      }
      if (this.shutdownRequested) break;
      if (serviced) continue;
      await this.standbyWait();
    }
    this.stateValue = "stopped";
  }

  private async runCycle(): Promise<boolean> {
    await this.refreshRegistry();
    const scans = this.observeProjects();

    // B-3, priority half: an approval or retry resumes a paused run before
    // any new run starts, wherever that project sits in registration order.
    for (const project of this.schedulable()) {
      const daemon = this.live.get(project.name);
      if (daemon?.hasQueuedResume) {
        await this.driveProject(project, daemon);
        return true;
      }
    }

    // B-2, new-run half: registration order, first armed and qualified
    // project whose registry read shows work its last conclusion did not
    // already see, driven by the existing per-run loop against its own state
    // root and repoDir.
    for (const project of this.schedulable()) {
      if (this.live.has(project.name)) continue;
      const scan = scans.get(project.name) ?? UNREADABLE_SCAN;
      if (!this.shouldWake(project, scan)) continue;
      const daemon = await this.openProjectDaemon(project);
      if (daemon === null) continue;
      await this.driveProject(project, daemon);
      return true;
    }

    return false;
  }

  private schedulable(): Project[] {
    return [...this.registry.values()].filter((p) => p.armed && p.qualification.qualified);
  }

  private shouldWake(project: Project, scan: ProjectScan): boolean {
    if (!scan.ok || scan.pendingSpecIds.length === 0) return false;
    return this.settled.get(project.name) !== scan.signature;
  }

  private async refreshRegistry(): Promise<void> {
    this.registry = foldProjects(this.chain.fold().records);

    for (const [name, daemon] of [...this.live]) {
      if (this.registry.has(name)) continue;
      // Removed from the registry while its run sat paused (025 D-2's
      // tombstone). Nothing inside the target is touched; its journals are
      // simply released, and re-registering the same path later resumes them.
      this.live.delete(name);
      this.logLine(`standby: "${name}" was removed from the registry; its paused run is released`);
      try {
        await daemon.shutdown();
      } catch {
        // already closed
      }
    }

    // Everything else standby remembers is keyed by project name, and a name
    // the registry no longer carries is a name a fresh registration may reuse
    // for a different target.
    for (const remembered of [this.settled, this.failures, this.views, this.depsCache]) {
      for (const name of [...remembered.keys()]) {
        if (!this.registry.has(name)) remembered.delete(name);
      }
    }
  }

  // One registry read per qualified project per scan (B-4), which is what
  // makes newly pending work wake a run automatically and lets a disarmed
  // project's ready work be reported without ever being driven. Every read
  // here is spec-spine and the filesystem; no session, so no model quota.
  private observeProjects(): Map<string, ProjectScan> {
    const scans = new Map<string, ProjectScan>();
    this.lastScanMs = this.deps.clock.now();

    for (const [name, project] of this.registry) {
      if (!project.qualification.qualified) {
        const failed = project.qualification.checks.filter((c) => !c.ok).map((c) => c.detail);
        this.views.set(name, this.viewOf(project, "unqualified", failed.join("; ") || "qualification refused", UNREADABLE_SCAN));
        scans.set(name, UNREADABLE_SCAN);
        continue;
      }

      const scan = this.scanProject(project);
      scans.set(name, scan);

      const daemon = this.live.get(name);
      if (daemon) {
        const detail = `run ${daemon.runId} paused, waiting on a human decision`;
        this.views.set(name, this.viewOf(project, "paused", detail, scan, daemon));
        continue;
      }

      if (!scan.ok) {
        this.views.set(name, this.viewOf(project, "errored", scan.reason ?? "registry unreadable", scan));
        continue;
      }

      // A run that would not start, or whose loop died, outranks whatever the
      // registry read says is waiting: reporting "ready to wake a run" for a
      // project that has failed to wake every scan would be a lie of omission.
      const failure = this.failures.get(name);
      if (failure !== undefined) {
        this.views.set(name, this.viewOf(project, "errored", failure, scan));
        continue;
      }

      if (!project.armed) {
        // D-2: disarming is the one lever that makes a project
        // observation-only, so its ready work is reported and left alone.
        const detail =
          scan.pendingSpecIds.length > 0
            ? `disarmed: ${scan.pendingSpecIds.length} pending spec(s) observed, not driven`
            : "disarmed: nothing pending";
        this.views.set(name, this.viewOf(project, "disarmed", detail, scan));
        continue;
      }

      const detail =
        scan.pendingSpecIds.length === 0
          ? "nothing pending"
          : this.shouldWake(project, scan)
            ? `${scan.pendingSpecIds.length} pending spec(s) ready to wake a run`
            : `${scan.pendingSpecIds.length} pending spec(s), unchanged since the last run concluded`;
      this.views.set(name, this.viewOf(project, "idle", detail, scan));
    }

    for (const name of [...this.views.keys()]) {
      if (!this.registry.has(name)) this.views.delete(name);
    }
    return scans;
  }

  private viewOf(
    project: Project,
    disposition: ProjectDisposition,
    detail: string,
    scan: ProjectScan,
    daemon?: Daemon
  ): ProjectStandbyView {
    return {
      name: project.name,
      repoDir: project.repoDir,
      armed: project.armed,
      qualified: project.qualification.qualified,
      disposition,
      detail,
      pendingSpecIds: scan.pendingSpecIds,
      runId: daemon?.runId ?? null,
      runStatus: daemon?.runStatus ?? null,
    };
  }

  private scanProject(project: Project): ProjectScan {
    // Deliberately outside the catch: deps that do not honor the contract are
    // a wiring bug in the composition, not a fact about this target, and must
    // not be reported as an unreadable registry.
    const reader = this.depsFor(project).dagReader;
    try {
      const snapshot = loadRegistrySnapshot(reader, project.repoDir);
      const entries = [...snapshot.entries()];
      return {
        ok: true,
        pendingSpecIds: entries.filter(([, e]) => e.implementation === "pending").map(([id]) => id).sort(),
        signature: entries
          .map(([id, e]) => `${id}=${e.implementation ?? "?"}`)
          .sort()
          .join(","),
        reason: null,
      };
    } catch (err) {
      return { ok: false, pendingSpecIds: [], signature: "", reason: (err as Error).message };
    }
  }

  // --- driving one project (B-2, B-3, B-5) ----------------------------------

  // Cached per project so a scan does not rebuild a whole seam set every
  // interval, and re-derived when a name comes back pointing somewhere else.
  private depsFor(project: Project): DaemonDeps {
    const cached = this.depsCache.get(project.name);
    if (cached && cached.repoDir === project.repoDir) return cached.deps;
    const deps = this.deps.makeProjectDeps(project);
    if (!deps.supervised) {
      throw new Error(`standby: makeProjectDeps("${project.name}") must set supervised: true (026 B-6)`);
    }
    this.depsCache.set(project.name, { repoDir: project.repoDir, deps });
    return deps;
  }

  private stateRootOf(project: Project): string {
    return this.depsFor(project).dataDir;
  }

  // A fresh Daemon per run (021 D-12: a terminal run is history, and a
  // restart continues the backlog under a new one), booted through spec 021
  // B-2's own order: journals, recovery sweep, then the loop the scheduler
  // drives. A target whose journals are held by another writer fails here;
  // spec 011 leaves clearing a stale writer lock to a supervisor that knows
  // the writer is dead, so this is reported and retried on the next scan
  // rather than forced.
  private async openProjectDaemon(project: Project): Promise<Daemon | null> {
    try {
      const daemon = new Daemon(this.depsFor(project));
      await daemon.start();
      return daemon;
    } catch (err) {
      this.reportFailure(project, `could not start a run: ${(err as Error).message}`);
      return null;
    }
  }

  private async driveProject(project: Project, daemon: Daemon): Promise<void> {
    this.stateValue = "scheduling";
    this.activeName = project.name;
    this.activeDaemonValue = daemon;
    // Set together with the slot, in one synchronous block: a shutdown that
    // landed before this drive started must not be missed by it.
    if (this.shutdownRequested) daemon.requestShutdown();
    // The scan that would otherwise write this view runs between drives, so
    // the one moment an operator most wants reported (a run in flight, right
    // now) is marked here rather than left reading as whatever it was before.
    const observed = this.views.get(project.name);
    this.views.set(
      project.name,
      this.viewOf(
        project,
        "driving",
        `run ${daemon.runId} holds the flight slot`,
        { ok: true, pendingSpecIds: observed?.pendingSpecIds ?? [], signature: "", reason: null },
        daemon
      )
    );
    this.logLine(`standby: driving "${project.name}" (${project.repoDir})`);

    let yielded: LoopYield;
    try {
      yielded = await daemon.drive();
    } catch (err) {
      this.activeName = null;
      this.activeDaemonValue = null;
      this.reportFailure(project, `run loop died: ${(err as Error).message}`);
      await this.retire(project, daemon, true);
      return;
    }
    this.activeName = null;
    this.activeDaemonValue = null;
    this.failures.delete(project.name);

    if (yielded === "paused") {
      // B-3: the slot is released so another project may proceed. This run
      // stays live and paused, its journals open, until an approval or retry
      // brings it back with priority over any new run.
      this.live.set(project.name, daemon);
      this.logLine(`standby: "${project.name}" run ${daemon.runId} paused; flight slot released`);
      return;
    }

    // B-1: a terminal run is history, not the end of the mission. The project
    // hands back its journals and the daemon carries on to the next one.
    this.logLine(`standby: "${project.name}" run ${daemon.runId} ${daemon.runStatus}`);
    await this.retire(project, daemon, yielded !== "shutdown");
  }

  // D-4: remember the registry this conclusion was reached on, so a project
  // whose backlog is done (or permanently blocked) is not re-driven every
  // scan; the next flip of any spec's implementation field changes the
  // signature and wakes it again.
  private async retire(project: Project, daemon: Daemon, settle: boolean): Promise<void> {
    this.live.delete(project.name);
    // The journals come back first, unconditionally: a settle that somehow
    // threw must not be what leaves a project's chains locked.
    try {
      await daemon.shutdown();
    } catch {
      // already closed
    }
    if (!settle) return;
    const scan = this.scanProject(project);
    if (scan.ok) this.settled.set(project.name, scan.signature);
  }

  private reportFailure(project: Project, message: string): void {
    if (this.failures.get(project.name) === message) return;
    this.failures.set(project.name, message);
    this.logLine(`standby: "${project.name}" ${message}`);
  }

  // --- standby (B-4, B-7) ----------------------------------------------------

  private async standbyWait(): Promise<void> {
    if (this.stateValue !== "standby") {
      this.stateValue = "standby";
      this.logLine(`standby: idle, rescanning ${this.registry.size} project(s) every ${this.scanIntervalMs} ms`);
    }
    const chunkMs = Math.max(1, Math.min(this.deps.sleepChunkMs ?? DEFAULT_SLEEP_CHUNK_MS, this.scanIntervalMs));
    const deadlineMs = this.deps.clock.now() + this.scanIntervalMs;
    while (!this.shutdownRequested && this.deps.clock.now() < deadlineMs) {
      await this.deps.sleep(chunkMs);
    }
  }
}
