// The adoption preflight (spec 034): read-only cartography of an ungoverned
// target. The first stage of corpus adoption (010 A-2, D16) and the only one
// an operator can run with zero commitment: it maps a repository and produces
// a written proposal, never a change.
//
// Three disciplines shape this module.
//
// First, B-1: nothing here writes inside the target. Every git call is a
// read; the proposal document is returned as a string for the caller to
// write wherever the operator chose; the one permitted state-root growth is
// the journal record of the preflight itself (B-6), appended by the caller
// through journalPreflight().
//
// Second, FR-001: extraction and clustering are pure over (commit list, path
// sets). Git sits behind the injected PreflightGitReader, exactly as
// spec-spine sits behind dag.ts's DagReader, so every churn, affinity,
// clustering, and serialization computation below is testable against
// synthetic histories with no subprocess involved.
//
// Third, FR-003 (the constitution's determinism clause): the same inputs
// produce a byte-identical proposal. Nothing in this module reads a clock,
// and every collection is sorted or carried in an order the inputs fix.
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JournalRecord } from "../journal";
import { sha256Hex } from "../journal";
import type { DagReader } from "../dag";
import type { Project } from "../projects";

// --- history extraction (B-3, D-1) ------------------------------------------

// How far back the preflight reads by default, bounded by what the clone
// holds (the shortfall is named in the proposal, never silently absorbed).
export const DEFAULT_HISTORY_WINDOW = 200;

// D-1: the unit of evidence is the reviewed change. "merges" reads
// first-parent merge commits diffed against their first parent (the PR as
// merged); a default branch with no merge commits at all falls back to
// "commits", plain first-parent history; "empty" is a target with no
// readable history, and the proposal says so and proposes nothing.
export type HistoryMode = "merges" | "commits" | "empty";

export interface CommitChange {
  readonly sha: string;
  readonly subject: string;
  readonly paths: readonly string[];
}

export interface ExtractedHistory {
  readonly mode: HistoryMode;
  readonly requested: number;
  // Newest first, exactly as git reports them.
  readonly commits: readonly CommitChange[];
  // Named when the clone holds less than the window asked for (B-3).
  readonly shortfall: string | null;
}

// The injected boundary for everything the preflight learns from git,
// mirroring projects.ts's ProjectProbe: production shells out, tests hand in
// fixture histories. Both methods answer null when git itself cannot answer
// (not a repository, or a repository with no commits), which extractHistory
// reads as an empty history rather than a crash.
export interface PreflightGitReader {
  headSha(repoDir: string): string | null;
  // First-parent history, newest first, at most `limit` entries; merges-only
  // when `mergesOnly`, with every merge diffed against its first parent.
  firstParentLog(repoDir: string, limit: number, mergesOnly: boolean): readonly CommitChange[] | null;
}

function shortfallOf(unit: string, used: number, requested: number): string | null {
  if (used >= requested) return null;
  return `the clone holds only ${used} ${unit}(s) of the ${requested} requested`;
}

// D-1's mode decision, pure over the reader's answers: merges when the
// first-parent line has any, plain first-parent commits otherwise, empty
// when there is nothing to read either way.
export function extractHistory(
  reader: PreflightGitReader,
  repoDir: string,
  requested: number = DEFAULT_HISTORY_WINDOW
): ExtractedHistory {
  const merges = reader.firstParentLog(repoDir, requested, true) ?? [];
  if (merges.length > 0) {
    return { mode: "merges", requested, commits: merges, shortfall: shortfallOf("first-parent merge", merges.length, requested) };
  }
  const commits = reader.firstParentLog(repoDir, requested, false) ?? [];
  if (commits.length === 0) return { mode: "empty", requested, commits: [], shortfall: null };
  return { mode: "commits", requested, commits, shortfall: shortfallOf("first-parent commit", commits.length, requested) };
}

// One record per commit: \x1e opens it, \x1f splits sha from subject, the
// following non-empty lines are --name-only paths. Chosen so a subject line
// containing anything printable still parses.
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

function parseGitLog(stdout: string): CommitChange[] {
  const out: CommitChange[] = [];
  for (const chunk of stdout.split(RECORD_SEP)) {
    if (chunk.trim().length === 0) continue;
    const lines = chunk.split("\n");
    const header = lines[0]!;
    const sep = header.indexOf(FIELD_SEP);
    if (sep < 0) continue;
    out.push({
      sha: header.slice(0, sep),
      subject: header.slice(sep + 1),
      paths: lines.slice(1).filter((line) => line.length > 0),
    });
  }
  return out;
}

function runGit(repoDir: string, args: readonly string[]): string | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    // quotePath off so non-ASCII paths arrive literal rather than C-quoted.
    result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd: repoDir });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout);
}

// The production reader. Read-only by construction: rev-parse and log are
// the only git verbs it knows.
export function createProcessPreflightGitReader(): PreflightGitReader {
  return {
    headSha(repoDir: string): string | null {
      const out = runGit(repoDir, ["rev-parse", "HEAD"]);
      if (out === null) return null;
      const sha = out.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },

    firstParentLog(repoDir: string, limit: number, mergesOnly: boolean): readonly CommitChange[] | null {
      const out = runGit(repoDir, [
        "log",
        "--first-parent",
        ...(mergesOnly ? ["--merges"] : []),
        // Merge commits diff against their first parent (D-1: the evidence is
        // the reviewed change as it landed), in both modes.
        "--diff-merges=first-parent",
        "-n",
        String(limit),
        `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%s`,
        "--name-only",
      ]);
      if (out === null) return null;
      return parseGitLog(out);
    },
  };
}

// --- exclusions (B-3, D-2) --------------------------------------------------

export type ExclusionWhy = "vendored" | "generated" | "lockfile" | "operator";

// A rule ending in "/" excludes every path under a directory of that name
// (any depth, multi-segment rules included); any other rule excludes an
// exact basename at any depth.
export interface ExclusionRule {
  readonly rule: string;
  readonly why: ExclusionWhy;
}

// D-2: policy as reviewable, tested data (031 FR-002's precedent, exactly as
// profile.ts's guarded baseline), because a wrong exclusion silently deletes
// evidence. Callers may add rules per run; nothing can remove one of these,
// so this list is the audited floor.
export const DEFAULT_EXCLUSIONS: readonly ExclusionRule[] = [
  { rule: "node_modules/", why: "vendored" },
  { rule: "vendor/", why: "vendored" },
  { rule: "third_party/", why: "vendored" },
  { rule: "dist/", why: "generated" },
  { rule: "build/", why: "generated" },
  { rule: "out/", why: "generated" },
  { rule: "target/", why: "generated" },
  { rule: "coverage/", why: "generated" },
  { rule: ".derived/", why: "generated" },
  { rule: "package-lock.json", why: "lockfile" },
  { rule: "bun.lock", why: "lockfile" },
  { rule: "bun.lockb", why: "lockfile" },
  { rule: "yarn.lock", why: "lockfile" },
  { rule: "pnpm-lock.yaml", why: "lockfile" },
  { rule: "Cargo.lock", why: "lockfile" },
  { rule: "poetry.lock", why: "lockfile" },
  { rule: "uv.lock", why: "lockfile" },
  { rule: "Pipfile.lock", why: "lockfile" },
  { rule: "Gemfile.lock", why: "lockfile" },
  { rule: "composer.lock", why: "lockfile" },
  { rule: "go.sum", why: "lockfile" },
];

export function ruleExcludes(rule: ExclusionRule, path: string): boolean {
  if (rule.rule.endsWith("/")) {
    // "/a/node_modules/b.js" contains "/node_modules/"; a file merely named
    // like the directory does not.
    return `/${path}`.includes(`/${rule.rule.slice(0, -1)}/`);
  }
  return path.split("/").at(-1) === rule.rule;
}

// The CLI's additions flag, parsed here so the rule grammar has one owner:
// comma-separated rules, each becoming an operator addition. Returns the
// refusal reason instead when the flag holds nothing usable. Additions only,
// per D-2: there is no grammar for removing a default.
export function exclusionAdditionsFromFlag(flag: string | null): readonly ExclusionRule[] | string {
  if (flag === null) return [];
  const rules = flag
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (rules.length === 0) return `--exclude needs at least one rule (a "dir/" segment or an exact basename)`;
  return rules.map((rule) => ({ rule, why: "operator" as const }));
}

export interface AppliedExclusionRule extends ExclusionRule {
  // Distinct paths this rule removed from the evidence. Zero is reported
  // too: a rule in force is visible whether or not it fired (B-3).
  readonly matched: number;
}

export interface AppliedExclusions {
  readonly rules: readonly AppliedExclusionRule[];
  readonly commits: readonly CommitChange[];
}

// Removes excluded paths from every commit's path set. A path matched by
// several rules is counted at the first match, in list order, so the counts
// sum to the number of distinct excluded paths.
export function applyExclusions(commits: readonly CommitChange[], rules: readonly ExclusionRule[]): AppliedExclusions {
  const matchedPaths = rules.map(() => new Set<string>());
  const kept = commits.map((commit) => ({
    ...commit,
    paths: commit.paths.filter((path) => {
      const index = rules.findIndex((rule) => ruleExcludes(rule, path));
      if (index < 0) return true;
      matchedPaths[index]!.add(path);
      return false;
    }),
  }));
  return {
    rules: rules.map((rule, index) => ({ ...rule, matched: matchedPaths[index]!.size })),
    commits: kept,
  };
}

// --- change-coupling (B-3, B-4, D-3) ----------------------------------------

// D-3: deterministic greedy agglomeration, single linkage over co-change
// affinity. Two paths bind when their Jaccard affinity (commits together
// over commits touching either) reaches this exported threshold: they ship
// together at least as often as apart. The proposal's job is a defensible
// starting point, and 036's replay, not this constant, arbitrates the
// boundaries; a fancier partitioner may replace all of this.
export const DEFAULT_AFFINITY_THRESHOLD = 0.5;

// A commit touching more paths than this contributes churn but no coupling
// evidence: a repo-wide sweep (format everything, mass rename) claims every
// pair of files ships together and would weld the whole tree into one
// territory. Never silent: the proposal names how many commits this dropped
// from the affinity computation.
export const WIDE_COMMIT_PATH_LIMIT = 100;

// Candidate floors (B-4's "high internal co-change and a live churn
// signal"): a territory proposes at least two files, seen shipping together
// in at least two distinct commits.
export const MIN_TERRITORY_PATHS = 2;
export const MIN_TERRITORY_COMMITS = 2;
export const SAMPLE_COMMITS_PER_TERRITORY = 3;

export function churnByPath(commits: readonly CommitChange[]): ReadonlyMap<string, number> {
  const churn = new Map<string, number>();
  for (const commit of commits) {
    for (const path of commit.paths) churn.set(path, (churn.get(path) ?? 0) + 1);
  }
  return churn;
}

interface AffinityEdge {
  readonly a: string;
  readonly b: string;
  readonly affinity: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function affinityEdges(commits: readonly CommitChange[], churn: ReadonlyMap<string, number>): AffinityEdge[] {
  const together = new Map<string, number>();
  for (const commit of commits) {
    if (commit.paths.length > WIDE_COMMIT_PATH_LIMIT) continue;
    const paths = [...new Set(commit.paths)].sort();
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = pairKey(paths[i]!, paths[j]!);
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  const edges: AffinityEdge[] = [];
  for (const [key, count] of together) {
    const [a, b] = key.split("\0") as [string, string];
    const union = (churn.get(a) ?? 0) + (churn.get(b) ?? 0) - count;
    edges.push({ a, b, affinity: union === 0 ? 0 : count / union });
  }
  return edges;
}

// Greedy agglomeration (D-3): every path starts alone; edges at or above the
// threshold merge their clusters, strongest first, ties broken
// lexicographically so the outcome is a pure function of the inputs.
export function clusterPaths(
  commits: readonly CommitChange[],
  threshold: number = DEFAULT_AFFINITY_THRESHOLD
): readonly (readonly string[])[] {
  const churn = churnByPath(commits);
  const parent = new Map<string, string>();
  const find = (path: string): string => {
    let root = path;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };

  const edges = affinityEdges(commits, churn)
    .filter((edge) => edge.affinity >= threshold)
    .sort((x, y) => y.affinity - x.affinity || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  for (const edge of edges) {
    const ra = find(edge.a);
    const rb = find(edge.b);
    if (ra === rb) continue;
    // The lexicographically smaller root wins, so union order cannot leak
    // into the result.
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
  }

  const clusters = new Map<string, string[]>();
  for (const path of [...churn.keys()].sort()) {
    const root = find(path);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(path);
  }
  return [...clusters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, members]) => members);
}

// --- candidate territories (B-4) --------------------------------------------

export interface SampleCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface CandidateTerritory {
  readonly paths: readonly string[];
  // Distinct commits in the window touching any of these paths.
  readonly commitCount: number;
  // Sum of per-path churn, and its share of the whole window's churn: the
  // evidence that this cluster is where the work actually happens.
  readonly churn: number;
  readonly churnShare: number;
  // Newest first, straight from the window: the operator's spot check.
  readonly sampleCommits: readonly SampleCommit[];
}

export interface RemainderPath {
  readonly path: string;
  readonly churn: number;
}

export interface TerritoryProposal {
  readonly candidates: readonly CandidateTerritory[];
  // Every observed path in no candidate, explicit (B-4), with its churn so a
  // hot loner is distinguishable from a file touched once.
  readonly remainder: readonly RemainderPath[];
  // Commits wider than WIDE_COMMIT_PATH_LIMIT: churn counted, coupling not.
  readonly wideCommits: number;
}

export function proposeTerritories(
  commits: readonly CommitChange[],
  threshold: number = DEFAULT_AFFINITY_THRESHOLD
): TerritoryProposal {
  const churn = churnByPath(commits);
  const totalChurn = [...churn.values()].reduce((sum, count) => sum + count, 0);
  const wideCommits = commits.filter((commit) => commit.paths.length > WIDE_COMMIT_PATH_LIMIT).length;

  const candidates: CandidateTerritory[] = [];
  const claimed = new Set<string>();
  for (const cluster of clusterPaths(commits, threshold)) {
    const members = new Set(cluster);
    const touching = commits.filter((commit) => commit.paths.some((path) => members.has(path)));
    const clusterChurn = cluster.reduce((sum, path) => sum + (churn.get(path) ?? 0), 0);
    if (cluster.length < MIN_TERRITORY_PATHS || touching.length < MIN_TERRITORY_COMMITS) continue;
    for (const path of cluster) claimed.add(path);
    candidates.push({
      paths: cluster,
      commitCount: touching.length,
      churn: clusterChurn,
      churnShare: totalChurn === 0 ? 0 : clusterChurn / totalChurn,
      sampleCommits: touching.slice(0, SAMPLE_COMMITS_PER_TERRITORY).map((c) => ({ sha: c.sha, subject: c.subject })),
    });
  }
  candidates.sort((a, b) => b.churn - a.churn || a.paths[0]!.localeCompare(b.paths[0]!));

  const remainder = [...churn.entries()]
    .filter(([path]) => !claimed.has(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => ({ path, churn: count }));

  return { candidates, remainder, wideCommits };
}

// --- surface detection (B-2) ------------------------------------------------

export type SurfaceKind = "language" | "build" | "test";

export interface SurfaceCandidate {
  readonly value: string;
  readonly evidence: string;
  // Why this candidate is not the answer; null on the one that is. The
  // preflight never silently guesses (010 B-4 extended to cartography): a
  // surface with no confirmed single candidate stays unknown, and every
  // candidate says why.
  readonly unconfirmed: string | null;
}

export interface SurfaceReading {
  readonly value: string | null;
  readonly candidates: readonly SurfaceCandidate[];
}

export interface SurfaceReport {
  readonly language: SurfaceReading;
  readonly build: SurfaceReading;
  readonly test: SurfaceReading;
}

interface DetectedCandidate {
  readonly kind: SurfaceKind;
  readonly value: string;
  readonly evidence: string;
  // This candidate's own reason it cannot be confirmed, independent of what
  // else was found; null means the manifest evidence determines it.
  readonly blocker: string | null;
}

const PACKAGE_RUNNERS: readonly { readonly lockfile: string; readonly runner: string }[] = [
  { lockfile: "bun.lock", runner: "bun" },
  { lockfile: "bun.lockb", runner: "bun" },
  { lockfile: "pnpm-lock.yaml", runner: "pnpm" },
  { lockfile: "yarn.lock", runner: "yarn" },
  { lockfile: "package-lock.json", runner: "npm" },
];

function readTextIfPresent(repoDir: string, name: string): string | null {
  try {
    return fs.readFileSync(join(repoDir, name), "utf8");
  } catch {
    return null;
  }
}

function detectPackageFamily(repoDir: string, found: DetectedCandidate[]): void {
  const raw = readTextIfPresent(repoDir, "package.json");
  if (raw === null) return;

  let scripts: Record<string, unknown> = {};
  let parseBlocker: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const rawScripts = (parsed as Record<string, unknown> | null)?.scripts;
    if (typeof rawScripts === "object" && rawScripts !== null) scripts = rawScripts as Record<string, unknown>;
  } catch {
    parseBlocker = "package.json exists but is not parseable JSON";
  }

  const hasTsconfig = readTextIfPresent(repoDir, "tsconfig.json") !== null;
  found.push({
    kind: "language",
    value: hasTsconfig ? "typescript" : "javascript",
    evidence: hasTsconfig ? "package.json, tsconfig.json" : "package.json",
    blocker: parseBlocker,
  });

  const locks = PACKAGE_RUNNERS.filter((entry) => readTextIfPresent(repoDir, entry.lockfile) !== null);
  const runners = [...new Set(locks.map((entry) => entry.runner))];
  const runnerBlocker =
    runners.length === 0
      ? `no lockfile names the package runner (${PACKAGE_RUNNERS.map((e) => e.lockfile).join(", ")})`
      : runners.length > 1
        ? `${locks.map((e) => e.lockfile).join(" and ")} disagree about the package runner`
        : null;

  for (const kind of ["build", "test"] as const) {
    if (typeof scripts[kind] !== "string") continue;
    const blocker = parseBlocker ?? runnerBlocker;
    found.push({
      kind,
      value: blocker === null ? `${runners[0]} run ${kind}` : `the "${kind}" script in package.json`,
      evidence:
        blocker === null ? `package.json "${kind}" script, ${locks[0]!.lockfile}` : `package.json "${kind}" script`,
      blocker,
    });
  }
}

function detectCargoFamily(repoDir: string, found: DetectedCandidate[]): void {
  if (readTextIfPresent(repoDir, "Cargo.toml") === null) return;
  found.push({ kind: "language", value: "rust", evidence: "Cargo.toml", blocker: null });
  found.push({ kind: "build", value: "cargo build", evidence: "Cargo.toml", blocker: null });
  found.push({ kind: "test", value: "cargo test", evidence: "Cargo.toml", blocker: null });
}

function detectPythonFamily(repoDir: string, found: DetectedCandidate[]): void {
  const raw = readTextIfPresent(repoDir, "pyproject.toml");
  if (raw === null) return;
  found.push({ kind: "language", value: "python", evidence: "pyproject.toml", blocker: null });
  found.push({
    kind: "test",
    value: "pytest",
    evidence: "pyproject.toml",
    blocker: raw.includes("[tool.pytest") ? null : "pyproject.toml has no [tool.pytest] section to confirm it",
  });
}

function detectMakeFamily(repoDir: string, found: DetectedCandidate[]): void {
  const raw = readTextIfPresent(repoDir, "Makefile");
  if (raw === null) return;
  found.push({
    kind: "build",
    value: /^build:/m.test(raw) ? "make build" : "make",
    evidence: "Makefile",
    blocker: /^build:/m.test(raw) ? null : "a Makefile is present but names no build target",
  });
  if (/^test:/m.test(raw)) {
    found.push({ kind: "test", value: "make test", evidence: "Makefile test target", blocker: null });
  }
}

function readSurface(kind: SurfaceKind, found: readonly DetectedCandidate[]): SurfaceReading {
  const mine = found.filter((candidate) => candidate.kind === kind);
  const confident = mine.filter((candidate) => candidate.blocker === null);
  // FR-002's tie clause: two manifests that each determine the surface leave
  // it unknown with both reported, neither chosen.
  const tie =
    confident.length > 1
      ? `${confident.map((c) => c.evidence).join(" and ")} each determine a ${kind}; the evidence does not choose`
      : null;
  return {
    value: confident.length === 1 ? confident[0]!.value : null,
    candidates: mine.map((candidate) => ({
      value: candidate.value,
      evidence: candidate.evidence,
      unconfirmed: candidate.blocker ?? tie,
    })),
  };
}

// Manifest evidence only (B-2): package.json and peers, read from the target
// root. Detection order is fixed, so the candidate lists are deterministic.
export function detectSurfaces(repoDir: string): SurfaceReport {
  const found: DetectedCandidate[] = [];
  detectPackageFamily(repoDir, found);
  detectCargoFamily(repoDir, found);
  detectPythonFamily(repoDir, found);
  detectMakeFamily(repoDir, found);
  return {
    language: readSurface("language", found),
    build: readSurface("build", found),
    test: readSurface("test", found),
  };
}

export function unknownSurfaces(report: SurfaceReport): readonly SurfaceKind[] {
  return (["language", "build", "test"] as const).filter((kind) => report[kind].value === null);
}

// --- the proposal (B-1, B-4, FR-003) ----------------------------------------

export interface AdoptionProposal {
  readonly target: string;
  readonly headSha: string | null;
  readonly surfaces: SurfaceReport;
  readonly history: {
    readonly mode: HistoryMode;
    readonly requested: number;
    readonly used: number;
    readonly shortfall: string | null;
  };
  readonly exclusions: readonly AppliedExclusionRule[];
  readonly territories: TerritoryProposal;
}

export interface BuildProposalParams {
  readonly repoDir: string;
  readonly headSha: string | null;
  readonly surfaces: SurfaceReport;
  readonly history: ExtractedHistory;
  // Defaults plus any per-run additions, in force order. The default list is
  // always the floor (D-2); callers append, never filter.
  readonly exclusions?: readonly ExclusionRule[];
  readonly threshold?: number;
}

export function buildProposal(params: BuildProposalParams): AdoptionProposal {
  const applied = applyExclusions(params.history.commits, params.exclusions ?? DEFAULT_EXCLUSIONS);
  return {
    target: params.repoDir,
    headSha: params.headSha,
    surfaces: params.surfaces,
    history: {
      mode: params.history.mode,
      requested: params.history.requested,
      used: params.history.commits.length,
      shortfall: params.history.shortfall,
    },
    exclusions: applied.rules,
    territories: proposeTerritories(applied.commits, params.threshold ?? DEFAULT_AFFINITY_THRESHOLD),
  };
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

// The longest directory prefix a cluster shares, as its human label; the
// file set below it is the actual claim.
function commonDirLabel(paths: readonly string[]): string {
  const segmented = paths.map((path) => path.split("/").slice(0, -1));
  const first = segmented[0] ?? [];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i]!;
    if (segmented.every((dirs) => dirs[i] === segment)) common.push(segment);
    else break;
  }
  return common.length > 0 ? `${common.join("/")}/` : "(no shared directory)";
}

function surfaceLines(kind: SurfaceKind, reading: SurfaceReading): string[] {
  const lines: string[] = [];
  if (reading.value !== null) {
    lines.push(`- ${kind}: ${reading.value}`);
  } else if (reading.candidates.length === 0) {
    lines.push(`- ${kind}: unknown (no manifest evidence found)`);
  } else {
    lines.push(`- ${kind}: unknown`);
  }
  for (const candidate of reading.candidates) {
    lines.push(`  - ${candidate.value} (evidence: ${candidate.evidence})`);
    if (candidate.unconfirmed !== null) lines.push(`    unconfirmed: ${candidate.unconfirmed}`);
  }
  return lines;
}

function historyLines(proposal: AdoptionProposal): string[] {
  const history = proposal.history;
  if (history.mode === "empty") {
    return ["The target has no readable commit history. There is no coupling evidence, and this proposal proposes nothing."];
  }
  const lines: string[] = [];
  if (history.mode === "merges") {
    lines.push(`Read ${history.used} first-parent merge(s), newest first (window requested: ${history.requested}).`);
  } else {
    lines.push(
      `Read ${history.used} first-parent commit(s), newest first (window requested: ${history.requested}).`,
      "The first-parent line holds no merge commits, so the evidence is plain commits rather than reviewed merges (D-1 fallback)."
    );
  }
  if (history.shortfall !== null) lines.push(`Shortfall: ${history.shortfall}.`);
  if (proposal.territories.wideCommits > 0) {
    lines.push(
      `Coupling evidence skipped ${proposal.territories.wideCommits} commit(s) wider than ${WIDE_COMMIT_PATH_LIMIT} paths ` +
        `(a repo-wide sweep pairs everything with everything); their churn still counts.`
    );
  }
  return lines;
}

// The proposal document: deterministic markdown (FR-003), every claim next
// to its evidence, wording that proposes rather than concludes (B-4).
export function renderProposal(proposal: AdoptionProposal): string {
  const lines: string[] = [];
  const territories = proposal.territories;

  lines.push(`# Adoption preflight: ${proposal.target}`);
  lines.push("");
  lines.push(
    "A read-only proposal (spec 034). It maps the target from its own merge history and manifest evidence; " +
      "it changes nothing, and it does not claim this partition is correct. Candidate boundaries are a starting " +
      "point for corpus synthesis (spec 035), and spec 036's holdback replay is what scores whether they hold."
  );
  lines.push("");
  lines.push(`- target: ${proposal.target}`);
  lines.push(`- head: ${proposal.headSha ?? "(no commits)"}`);
  lines.push("");

  lines.push("## Surfaces");
  lines.push("");
  lines.push(...surfaceLines("language", proposal.surfaces.language));
  lines.push(...surfaceLines("build", proposal.surfaces.build));
  lines.push(...surfaceLines("test", proposal.surfaces.test));
  lines.push("");

  lines.push("## History");
  lines.push("");
  lines.push(...historyLines(proposal));
  lines.push("");

  lines.push("## Exclusions");
  lines.push("");
  lines.push("Rules in force (defaults are the audited floor, D-2; per-run additions are marked operator):");
  lines.push("");
  for (const rule of proposal.exclusions) {
    lines.push(`- ${rule.rule} (${rule.why}): ${rule.matched} path(s) excluded`);
  }
  lines.push("");

  lines.push("## Candidate territories");
  lines.push("");
  if (territories.candidates.length === 0) {
    lines.push("None: the history read holds no cluster with enough internal co-change and live churn to propose.");
  } else {
    lines.push(
      `${territories.candidates.length} candidate(s), ranked by churn. Each proposes one spec territory at change ` +
        "level (010 D16): files that ship together in this window."
    );
    territories.candidates.forEach((candidate, index) => {
      lines.push("");
      lines.push(
        `### ${index + 1}. ${commonDirLabel(candidate.paths)} ` +
          `(${candidate.paths.length} files, ${pct(candidate.churnShare)} of churn, ${candidate.commitCount} commits)`
      );
      lines.push("");
      lines.push("files:");
      for (const path of candidate.paths) lines.push(`- ${path}`);
      lines.push("");
      lines.push("sample commits:");
      for (const commit of candidate.sampleCommits) lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
    });
  }
  lines.push("");

  lines.push("## Ungoverned remainder");
  lines.push("");
  if (territories.remainder.length === 0) {
    lines.push(
      proposal.history.mode === "empty"
        ? "Nothing was observed, so nothing remains."
        : "Every path observed in the window landed in a candidate territory."
    );
  } else {
    lines.push(`${territories.remainder.length} path(s) in no candidate territory:`);
    lines.push("");
    for (const entry of territories.remainder) lines.push(`- ${entry.path} (touched ${entry.churn}x)`);
  }
  lines.push("");

  return lines.join("\n");
}

export function proposalHash(document: string): string {
  return sha256Hex(document);
}

// --- running a preflight ----------------------------------------------------

export interface PreflightRunParams {
  readonly repoDir: string;
  readonly reader?: PreflightGitReader;
  readonly window?: number;
  // D-2: additions only. The defaults are prepended here unconditionally, so
  // no caller can hand in a list with the floor filtered out.
  readonly extraExclusions?: readonly ExclusionRule[];
}

export interface PreflightRun {
  readonly proposal: AdoptionProposal;
  readonly document: string;
  readonly contentHash: string;
}

// The whole preflight, reads only (B-1): the caller owns writing `document`
// to the operator's chosen path and journaling the run.
export function runPreflight(params: PreflightRunParams): PreflightRun {
  const reader = params.reader ?? createProcessPreflightGitReader();
  const history = extractHistory(reader, params.repoDir, params.window ?? DEFAULT_HISTORY_WINDOW);
  const proposal = buildProposal({
    repoDir: params.repoDir,
    headSha: reader.headSha(params.repoDir),
    surfaces: detectSurfaces(params.repoDir),
    history,
    exclusions: [...DEFAULT_EXCLUSIONS, ...(params.extraExclusions ?? [])],
  });
  const document = renderProposal(proposal);
  return { proposal, document, contentHash: proposalHash(document) };
}

// --- the journal record (B-6) -----------------------------------------------

export const PREFLIGHT_RECORD_KIND = "adopt.preflight";

export interface JournalPreflightParams {
  readonly handle: JournalHandle;
  readonly project: string;
  readonly source: string;
  readonly run: PreflightRun;
  readonly out: string;
}

// What a later ratification (036) cites: which HEAD the cartography read,
// the window it actually used, and the content hash of the exact document it
// trusted. Appended to the project's own work journal, the one permitted
// state-root growth (B-1).
export function journalPreflight(params: JournalPreflightParams): JournalRecord {
  const proposal = params.run.proposal;
  return params.handle.append(PREFLIGHT_RECORD_KIND, {
    project: params.project,
    source: params.source,
    headSha: proposal.headSha,
    historyMode: proposal.history.mode,
    window: { requested: proposal.history.requested, used: proposal.history.used },
    contentHash: params.run.contentHash,
    out: params.out,
  });
}

// --- the adoptable refusal (B-5) --------------------------------------------

// The DagReader an adoptable project serves instead of the real one: every
// structural read refuses by name. `dag` and `next` against such a project
// answer with why there is nothing to schedule, never an empty corpus that
// reads as "all done" (AC-3), and never a raw spec-spine failure that reads
// as breakage. A governed project (adoptable absent or false) gets null:
// this spec's vocabulary does not touch it.
export function adoptableDagReader(project: Project): DagReader | null {
  const qualification = project.qualification;
  if (qualification.qualified || qualification.adoptable !== true) return null;
  const failed = qualification.checks
    .filter((check) => !check.ok)
    .map((check) => check.detail)
    .join("; ");
  const refuse = (): never => {
    throw new Error(
      `project "${project.name}" is adoptable, not governed: it has no spec corpus to schedule (${failed}); ` +
        `run "orchestrator adopt preflight ${project.repoDir}" to map it`
    );
  };
  return { registryListJson: refuse, registryShowJson: refuse, readSpecFile: refuse };
}
