// The registry of target repositories the orchestrator may drive (spec 025):
// the honest answer to "what may this daemon touch, and why". Every target is
// registered, qualified, and journaled before a single session is driven
// against it; the self-hosted checkout is not special, it is simply the first
// registered project.
//
// Storage is a third hash-linked chain under the daemon home, opened through
// spec 011's parameterized `openJournal(dir, basename)` seam with the basename
// "projects", exactly as spec 020's decision ledger does (B-2, "same
// implementation, third chain"). Registry state is never a table: register,
// arm, disarm, requalify, and remove each append a record carrying its source,
// and the current set of projects is derived by folding them (foldProjects).
//
// Two roots, never conflated (B-3). The daemon home (this checkout's
// data/orchestrator/) holds the lock, the log, and this chain. A project's
// state root is <repoDir>/data/orchestrator/, the same layout the self-hosted
// run already uses, so spec 011/020 machinery and an offline `journal verify`
// work unchanged when pointed at any project.
//
// Write discipline (B-5): nothing here writes inside a target except through
// the qualification probe's `spec-spine compile`, which refreshes that repo's
// own deterministic .derived/ artifacts and never touches an authored file.
// The registry itself only ever reads a target, and `~/.claude` stays
// read-only for every code path (spec 001 B-7).
import * as fs from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import type { FoldedState, JournalHandle, JournalRecord, JsonValue, VerifyResult } from "./journal";
import { openJournal, verifyChain } from "./journal";
import type { ExecutionProfile, RecordedProfile } from "./profile";
import { DEFAULT_REGISTRATION_PROFILE, LEGACY_BYPASS_PROFILE, parseProfile, profilePayload } from "./profile";
import type { CostCeiling } from "./budget";
import { ceilingPayload, parseCeiling } from "./budget";

// --- model (B-1) ------------------------------------------------------------

// Where a record came from, journaled with every mutation (B-2). The same
// three sources the control surfaces declare (spec 022's X-Control-Source).
export type ProjectSource = "cli" | "api" | "ui";

export type QualificationCheckId =
  | "git-repo"
  | "origin-remote"
  | "default-branch"
  | "compile-green"
  | "specs-present";

export interface QualificationCheck {
  readonly id: QualificationCheckId;
  readonly ok: boolean;
  // The reason, in both directions: why the check passed as well as why it
  // failed. An unqualified project stays visible with these attached (B-4),
  // so a failing detail is the operator's whole diagnosis.
  readonly detail: string;
}

// What qualifyProject() computes and what a register/requalify record stores.
export interface QualificationVerdict {
  readonly qualified: boolean;
  readonly checks: readonly QualificationCheck[];
  // Observations that do not disqualify: recorded, never fixed (B-4).
  readonly warnings: readonly string[];
}

// A verdict as read back out of the chain. `checkedAt` is the recording
// record's own envelope timestamp rather than a field the verdict carries, so
// there is exactly one clock in the chain and it is the journal's.
export interface RecordedQualification extends QualificationVerdict {
  readonly checkedAt: string;
}

export interface Project {
  readonly name: string;
  readonly repoDir: string;
  readonly armed: boolean;
  readonly qualification: RecordedQualification;
  // The posture every session driven against this project runs under (spec
  // 032 B-2), folded from the chain exactly as `armed` is. Never absent: a
  // chain with no profile record folds to bypass flagged legacy, which is
  // today's behavior with today's silence removed.
  readonly profile: RecordedProfile;
  // The spend limits this project is driven under (spec 033 B-1), folded the
  // same way. null is the honest absence: a chain with no ceiling record has
  // no ceiling, and that project is driven exactly as it was before ceilings
  // existed, so no default is invented for it here.
  readonly ceiling: CostCeiling | null;
}

// Keyed by name, in registration order (a project re-registered after removal
// takes the newest position). Spec 026's scheduler services projects in this
// order, so the ordering is load-bearing, not incidental.
export type ProjectsSnapshot = ReadonlyMap<string, Project>;

// --- chain plumbing (B-2, B-3) ---------------------------------------------

export const PROJECTS_CHAIN_BASENAME = "projects";

// The record kinds this chain carries. Exported because the control
// surfaces (027, 028) render the journaled record itself back to the caller.
// `profileSet` is spec 032 B-2's addition: posture is registry state, so it
// arrives here as a sixth appended kind rather than as a field an operator
// edits somewhere. `ceilingSet` is spec 033 B-1's, on the same reasoning: a
// spend limit is operator-owned registry state, journaled with its source and
// folded like `armed`, never a value edited in place.
export const PROJECT_KINDS = {
  registered: "project.registered",
  armed: "project.armed",
  disarmed: "project.disarmed",
  requalified: "project.requalified",
  removed: "project.removed",
  profileSet: "project.profile.set",
  ceilingSet: "project.ceiling.set",
} as const;

// The projects chain lives in the daemon home: projects.jsonl plus its own
// anchor, lock, and torn sidecar, alongside journal.jsonl and decisions.jsonl
// without colliding (spec 011's journalFilenames).
export function openProjectsChain(daemonHomeDir: string): JournalHandle {
  return openJournal(daemonHomeDir, PROJECTS_CHAIN_BASENAME);
}

export function verifyProjectsChain(daemonHomeDir: string): VerifyResult {
  return verifyChain(daemonHomeDir, PROJECTS_CHAIN_BASENAME);
}

// A project's state root: work journal, decision ledger, and evidence for
// that target, inside that target (B-3, 010 D13). Byte-compatible with the
// self-hosted layout (this checkout's own data/orchestrator/), which is what
// lets one `journal verify` implementation serve every project.
export function projectStateRoot(repoDir: string): string {
  return join(repoDir, "data", "orchestrator");
}

// --- names (D-1) ------------------------------------------------------------

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidProjectName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

// Lowercase, runs of anything else folded to a single "-", edges trimmed.
// May return a string that is not a valid name (an input with no alphanumeric
// content at all, or one starting with "-" once trimmed); callers check.
export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The name a registration defaults to: the repo directory's basename,
// slugified (D-1). A path whose basename slugifies to nothing usable is a
// refusal with the fix in the message, never a generated placeholder.
export function defaultProjectName(repoDir: string): string {
  const slug = slugifyProjectName(basename(repoDir));
  if (!isValidProjectName(slug)) {
    throw new Error(`projects: cannot derive a project name from "${repoDir}"; pass an explicit name`);
  }
  return slug;
}

function normalizeRepoDir(repoDir: string): string {
  if (!isAbsolute(repoDir)) {
    throw new Error(`projects: repoDir must be an absolute path, got "${repoDir}"`);
  }
  return resolve(repoDir);
}

// --- payload codec ----------------------------------------------------------

function asObject(payload: JsonValue, kind: string): Record<string, JsonValue> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`projects: ${kind} expected a JSON object payload`);
  }
  return payload as Record<string, JsonValue>;
}

function asString(o: Record<string, JsonValue>, field: string, kind: string): string {
  const v = o[field];
  if (typeof v !== "string") throw new Error(`projects: ${kind} expected string field "${field}"`);
  return v;
}

function asBoolean(o: Record<string, JsonValue>, field: string, kind: string): boolean {
  const v = o[field];
  if (typeof v !== "boolean") throw new Error(`projects: ${kind} expected boolean field "${field}"`);
  return v;
}

// Exported for the API fixtures, whose legacy-chain path (032 B-2 tests)
// appends a pre-032 registration record directly and must encode the verdict
// exactly as registerProject does, or the fold under test reads fiction.
export function qualificationPayload(verdict: QualificationVerdict): Record<string, JsonValue> {
  return {
    qualified: verdict.qualified,
    checks: verdict.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })),
    warnings: [...verdict.warnings],
  };
}

function parseQualification(value: JsonValue | undefined, kind: string, checkedAt: string): RecordedQualification {
  if (value === undefined) throw new Error(`projects: ${kind} expected field "qualification"`);
  const o = asObject(value, `${kind}.qualification`);
  const rawChecks = o.checks;
  if (!Array.isArray(rawChecks)) {
    throw new Error(`projects: ${kind}.qualification expected array field "checks"`);
  }
  const checks = rawChecks.map((raw) => {
    const c = asObject(raw, `${kind}.qualification.checks[]`);
    return {
      // Read back as written, not validated against today's check ids: a
      // verdict recorded by an older (or newer) preflight stays readable
      // rather than making the whole registry unfoldable.
      id: asString(c, "id", kind) as QualificationCheckId,
      ok: asBoolean(c, "ok", kind),
      detail: asString(c, "detail", kind),
    };
  });
  const rawWarnings = o.warnings;
  if (!Array.isArray(rawWarnings) || !rawWarnings.every((w) => typeof w === "string")) {
    throw new Error(`projects: ${kind}.qualification expected string array field "warnings"`);
  }
  return {
    qualified: asBoolean(o, "qualified", kind),
    checks,
    warnings: rawWarnings as string[],
    checkedAt,
  };
}

// --- the fold (B-2) ---------------------------------------------------------

// Derives the current set of projects from the chain's records, in order.
//
// A mutation record naming a project that is not currently live is inert: it
// cannot resurrect a removed one. Removal is a tombstone (D-2), so a stale
// arm/requalify appended before (or racing) a removal must not bring the
// project back; only a fresh registration does, and that resumes the same
// state root inside the target. Kinds this chain does not own are ignored.
export function foldProjects(records: readonly JournalRecord[]): ProjectsSnapshot {
  const projects = new Map<string, Project>();

  for (const record of records) {
    const kind = record.kind;
    switch (kind) {
      case PROJECT_KINDS.registered: {
        const o = asObject(record.payload, kind);
        const name = asString(o, "name", kind);
        projects.set(name, {
          name,
          repoDir: asString(o, "repoDir", kind),
          armed: asBoolean(o, "armed", kind),
          qualification: parseQualification(o.qualification, kind, record.ts),
          // Registration itself never carries the posture: the profile record
          // appended beside it does (032 B-2), so a registration read on its
          // own is legacy bypass and only a profile record moves it off that.
          profile: LEGACY_BYPASS_PROFILE,
          // 033 B-1: likewise for the ceiling, except that its absence needs no
          // legacy flag. No ceiling is a complete, current answer.
          ceiling: null,
        });
        break;
      }
      case PROJECT_KINDS.armed:
      case PROJECT_KINDS.disarmed: {
        const name = asString(asObject(record.payload, kind), "name", kind);
        const current = projects.get(name);
        if (current) projects.set(name, { ...current, armed: kind === PROJECT_KINDS.armed });
        break;
      }
      case PROJECT_KINDS.requalified: {
        const o = asObject(record.payload, kind);
        const name = asString(o, "name", kind);
        const current = projects.get(name);
        if (current) {
          projects.set(name, { ...current, qualification: parseQualification(o.qualification, kind, record.ts) });
        }
        break;
      }
      case PROJECT_KINDS.profileSet: {
        const o = asObject(record.payload, kind);
        const name = asString(o, "name", kind);
        const current = projects.get(name);
        if (current) {
          projects.set(name, { ...current, profile: { ...parseProfile(o.profile, kind), legacy: false } });
        }
        break;
      }
      case PROJECT_KINDS.ceilingSet: {
        const o = asObject(record.payload, kind);
        const name = asString(o, "name", kind);
        const current = projects.get(name);
        if (current) projects.set(name, { ...current, ceiling: parseCeiling(o.ceiling, kind) });
        break;
      }
      case PROJECT_KINDS.removed: {
        projects.delete(asString(asObject(record.payload, kind), "name", kind));
        break;
      }
      default:
        break;
    }
  }

  return projects;
}

// The fold over a chain's folded state. FoldedState.byKind groups by kind and
// so loses the global ordering the fold depends on; `records` keeps it.
export function projectsFromChain(state: FoldedState): ProjectsSnapshot {
  return foldProjects(state.records);
}

// --- mutations (B-2) --------------------------------------------------------

// What every mutation returns: the appended record (spec 022 D-2's control
// pattern: the answer is the journaled record itself) and the project as it
// stands afterwards, null once removed.
export interface ProjectMutation {
  readonly record: JournalRecord;
  readonly project: Project | null;
}

export interface RegisterProjectParams {
  readonly chain: JournalHandle;
  readonly repoDir: string;
  readonly qualification: QualificationVerdict;
  readonly source: ProjectSource;
  readonly name?: string;
  // Registration defaults to armed: pointing the orchestrator at a project is
  // the consent (010 D14).
  readonly armed?: boolean;
  // The posture this registration consents to, defaulting to bypass (032
  // D-1). Recorded as its own record beside the registration, so `legacy`
  // can only ever describe a chain written before spec 032 existed (B-2).
  readonly profile?: ExecutionProfile;
}

export interface SetProjectArmedParams {
  readonly chain: JournalHandle;
  readonly name: string;
  readonly armed: boolean;
  readonly source: ProjectSource;
}

export interface SetProjectProfileParams {
  readonly chain: JournalHandle;
  readonly name: string;
  readonly profile: ExecutionProfile;
  readonly source: ProjectSource;
}

export interface SetProjectCeilingParams {
  readonly chain: JournalHandle;
  readonly name: string;
  // null clears the ceiling. Clearing is a record that says so rather than an
  // absence, so the chain carries who removed a spend limit and when.
  readonly ceiling: CostCeiling | null;
  readonly source: ProjectSource;
}

export interface RequalifyProjectParams {
  readonly chain: JournalHandle;
  readonly name: string;
  readonly qualification: QualificationVerdict;
  readonly source: ProjectSource;
}

export interface RemoveProjectParams {
  readonly chain: JournalHandle;
  readonly name: string;
  readonly source: ProjectSource;
}

function mutationOf(chain: JournalHandle, record: JournalRecord, name: string): ProjectMutation {
  return { record, project: projectsFromChain(chain.fold()).get(name) ?? null };
}

function requireLive(chain: JournalHandle, name: string): Project {
  const project = projectsFromChain(chain.fold()).get(name);
  if (!project) throw new Error(`projects: no registered project named "${name}"`);
  return project;
}

// Appends a registration. An unqualified verdict registers exactly like a
// qualified one (B-4: visible, with reasons, never silently dropped); it is
// the scheduler that refuses to drive it.
export function registerProject(params: RegisterProjectParams): ProjectMutation {
  const repoDir = normalizeRepoDir(params.repoDir);
  const name = params.name ?? defaultProjectName(repoDir);
  if (!isValidProjectName(name)) {
    throw new Error(`projects: "${name}" is not a valid project name (lowercase slug, ${NAME_PATTERN.source})`);
  }

  const live = projectsFromChain(params.chain.fold());
  const clash = live.get(name);
  if (clash) {
    throw new Error(`projects: "${name}" is already registered (${clash.repoDir}); remove it first or choose another name`);
  }
  // Two names for one repoDir would share one state root: two journals under
  // the same writer lock, and spec 026's scheduler driving the same checkout
  // twice. Refused at registration rather than diagnosed later. Compared as
  // normalized paths, not real paths: registering a target that does not
  // exist yet is legal (it qualifies as unqualified), so two symlinked
  // aliases of one repo can still slip past this.
  for (const project of live.values()) {
    if (project.repoDir === repoDir) {
      throw new Error(`projects: ${repoDir} is already registered as "${project.name}"`);
    }
  }

  const record = params.chain.append(PROJECT_KINDS.registered, {
    name,
    repoDir,
    armed: params.armed ?? true,
    qualification: qualificationPayload(params.qualification),
    source: params.source,
  });
  // 032 B-2: the posture is appended beside the registration rather than
  // folded into it, so one kind carries one consent and a profile change
  // later reads exactly like the profile chosen here. Appended second: a
  // mutation record only applies to a project that is already live (D-5).
  params.chain.append(PROJECT_KINDS.profileSet, {
    name,
    profile: profilePayload(params.profile ?? DEFAULT_REGISTRATION_PROFILE),
    source: params.source,
  });
  // The registration record is the mutation's answer; the posture it settled
  // on travels on the returned project, which is what every surface renders.
  return mutationOf(params.chain, record, name);
}

// Sets the posture every session driven against this project runs under
// (032 B-2). Appended even when the profile is unchanged, exactly as arm and
// disarm are: the chain records what was asked and by whom, not only what
// moved.
export function setProjectProfile(params: SetProjectProfileParams): ProjectMutation {
  requireLive(params.chain, params.name);
  const record = params.chain.append(PROJECT_KINDS.profileSet, {
    name: params.name,
    profile: profilePayload(params.profile),
    source: params.source,
  });
  return mutationOf(params.chain, record, params.name);
}

// Sets (or, with a null ceiling, clears) the spend limits every run against
// this project is evaluated at (033 B-1). Appended like arm and disarm, and
// for the same reason: the chain records what was asked and by whom, which is
// the only thing that makes a raised ceiling auditable against the run it
// released.
export function setProjectCeiling(params: SetProjectCeilingParams): ProjectMutation {
  requireLive(params.chain, params.name);
  const record = params.chain.append(PROJECT_KINDS.ceilingSet, {
    name: params.name,
    ceiling: ceilingPayload(params.ceiling),
    source: params.source,
  });
  return mutationOf(params.chain, record, params.name);
}

// Arm or disarm. Appended even when the project already holds that state: the
// chain records what was asked and by whom, not only what changed.
export function setProjectArmed(params: SetProjectArmedParams): ProjectMutation {
  requireLive(params.chain, params.name);
  const kind = params.armed ? PROJECT_KINDS.armed : PROJECT_KINDS.disarmed;
  const record = params.chain.append(kind, { name: params.name, source: params.source });
  return mutationOf(params.chain, record, params.name);
}

export function requalifyProject(params: RequalifyProjectParams): ProjectMutation {
  requireLive(params.chain, params.name);
  const record = params.chain.append(PROJECT_KINDS.requalified, {
    name: params.name,
    qualification: qualificationPayload(params.qualification),
    source: params.source,
  });
  return mutationOf(params.chain, record, params.name);
}

// Removal is a tombstone (D-2): the chain is append-only, so this appends and
// the fold drops the project. Nothing inside the target is touched; that
// project's journals are the target's property, and re-registering the same
// path later resumes them.
export function removeProject(params: RemoveProjectParams): ProjectMutation {
  requireLive(params.chain, params.name);
  const record = params.chain.append(PROJECT_KINDS.removed, { name: params.name, source: params.source });
  return mutationOf(params.chain, record, params.name);
}

// --- qualification probe (B-4) ----------------------------------------------

export interface CompileProbeResult {
  readonly exitCode: number;
  readonly stderrTail: string;
}

// The injected boundary for everything qualification needs to learn about a
// target, mirroring dag.ts's DagReader and the stage modules' Runner: the
// production implementation shells out to git and spec-spine, tests drive
// qualifyProject() against fixture directories (FR-002) with a scripted
// compile so no test needs a governed corpus of its own.
export interface ProjectProbe {
  // `git rev-parse --show-prefix`: "" at a work tree root, "sub/dir/" below
  // one, null when repoDir is not a git work tree at all (or git could not
  // run there, a missing directory included).
  gitPrefix(repoDir: string): string | null;
  originUrl(repoDir: string): string | null;
  // The branch a PR merges into: refs/remotes/origin/HEAD, else origin/main,
  // else origin/master, else null. Anchored on origin deliberately: the local
  // checked-out branch says nothing about where work lands.
  defaultBranch(repoDir: string): string | null;
  compile(repoDir: string): CompileProbeResult;
  // Directories under specs/ that actually hold a spec.md.
  specCount(repoDir: string): number;
  // Whether the target gitignores data/ (its state root's parent).
  dataIgnored(repoDir: string): boolean;
}

const COMPILE_STDERR_TAIL_BYTES = 4 * 1024;

function tailText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// null when the process could not be started at all: a repoDir that does not
// exist makes Bun.spawnSync throw on the cwd, which is a fact about the
// target, not a crash worth propagating.
function runIn(repoDir: string, cmd: readonly string[]): ProcessResult | null {
  try {
    const result = Bun.spawnSync(cmd as string[], { cwd: repoDir });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  } catch {
    return null;
  }
}

function git(repoDir: string, args: readonly string[]): ProcessResult | null {
  return runIn(repoDir, ["git", ...args]);
}

const DEFAULT_BRANCH_CANDIDATES = ["main", "master"] as const;

// The production probe (Bun.spawnSync + fs). Every call is read-only against
// the target except `spec-spine compile`, which rewrites that repo's own
// derived artifacts deterministically and no authored file (B-4, B-5).
export function createProcessProjectProbe(): ProjectProbe {
  return {
    gitPrefix(repoDir: string): string | null {
      const result = git(repoDir, ["rev-parse", "--show-prefix"]);
      if (result === null || result.exitCode !== 0) return null;
      return result.stdout;
    },

    originUrl(repoDir: string): string | null {
      const result = git(repoDir, ["remote", "get-url", "origin"]);
      if (result === null || result.exitCode !== 0 || result.stdout.length === 0) return null;
      return result.stdout;
    },

    defaultBranch(repoDir: string): string | null {
      const head = git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (head !== null && head.exitCode === 0 && head.stdout.startsWith("origin/")) {
        return head.stdout.slice("origin/".length);
      }
      for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
        const ref = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
        if (ref !== null && ref.exitCode === 0) return candidate;
      }
      return null;
    },

    compile(repoDir: string): CompileProbeResult {
      const result = runIn(repoDir, ["spec-spine", "compile"]);
      if (result === null) {
        return { exitCode: -1, stderrTail: `could not run spec-spine compile in ${repoDir}` };
      }
      return { exitCode: result.exitCode, stderrTail: tailText(result.stderr, COMPILE_STDERR_TAIL_BYTES) };
    },

    specCount(repoDir: string): number {
      const specsDir = join(repoDir, "specs");
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(specsDir, { withFileTypes: true });
      } catch {
        return 0;
      }
      return entries.filter((e) => e.isDirectory() && fs.existsSync(join(specsDir, e.name, "spec.md"))).length;
    },

    dataIgnored(repoDir: string): boolean {
      // The trailing slash matters: a "data/" pattern is directory-only, and
      // git cannot tell that "data" names a directory when it does not exist
      // yet (which is exactly the case for a target nothing has driven).
      const result = git(repoDir, ["check-ignore", "-q", "data/"]);
      return result !== null && result.exitCode === 0;
    },
  };
}

// --- qualification (B-4) ----------------------------------------------------

// The read-only preflight: git repository with an origin remote and a
// resolvable default branch, `spec-spine compile` green inside it, specs
// present. Every check contributes its reason in both directions, so an
// unqualified target is registrable and diagnosable rather than dropped.
export function qualifyProject(probe: ProjectProbe, repoDir: string): QualificationVerdict {
  const checks: QualificationCheck[] = [];

  const prefix = probe.gitPrefix(repoDir);
  const isRepoRoot = prefix === "";
  checks.push({
    id: "git-repo",
    ok: isRepoRoot,
    detail:
      prefix === null
        ? `${repoDir} is not a git work tree (or git could not run there)`
        : isRepoRoot
          ? "git work tree root"
          : `${repoDir} is "${prefix}" inside a git work tree, not its root`,
  });

  const origin = probe.originUrl(repoDir);
  checks.push({
    id: "origin-remote",
    ok: origin !== null,
    detail: origin !== null ? `origin is ${origin}` : `no "origin" remote`,
  });

  const branch = probe.defaultBranch(repoDir);
  checks.push({
    id: "default-branch",
    ok: branch !== null,
    detail:
      branch !== null
        ? `default branch is "${branch}"`
        : `no default branch: none of refs/remotes/origin/{HEAD,${DEFAULT_BRANCH_CANDIDATES.join(",")}} resolves`,
  });

  const compile = probe.compile(repoDir);
  checks.push({
    id: "compile-green",
    ok: compile.exitCode === 0,
    detail:
      compile.exitCode === 0
        ? "spec-spine compile exited 0"
        : `spec-spine compile exited ${compile.exitCode}: ${compile.stderrTail}`,
  });

  const specs = probe.specCount(repoDir);
  checks.push({
    id: "specs-present",
    ok: specs > 0,
    detail: specs > 0 ? `${specs} spec(s) under specs/` : "specs/ is missing or holds no spec.md",
  });

  // Warned about, never fixed: the orchestrator does not edit a target's
  // authored files, .gitignore included (B-4). A target that tracks data/
  // still qualifies; its operator decides.
  const warnings: string[] = [];
  if (isRepoRoot && !probe.dataIgnored(repoDir)) {
    warnings.push(
      `${repoDir} does not gitignore data/: this project's state root (${projectStateRoot(repoDir)}) would show up as untracked changes`
    );
  }

  return { qualified: checks.every((c) => c.ok), checks, warnings };
}
