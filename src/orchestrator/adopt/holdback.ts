// Holdback validation (spec 036): score a candidate corpus against the
// target's own merge history. The acceptance instrument of adoption (010
// A-2, D17): for each of the last N first-parent changes on the target's
// default branch, would the corpus's declared ownership have covered the
// paths that actually shipped together?
//
// Three disciplines shape this module, inherited from the preflight (034).
//
// First, purity (FR-001): the replay and the scoring are pure over (commit
// path sets, ownership snapshot). Git sits behind HoldbackGitReader and
// spec-spine behind HoldbackCorpusReader, so every classification,
// rename-following, cover, and rollup computation is testable against
// synthetic histories and hand-built corpora with no subprocess involved.
//
// Second, governed reads (FR-002, 012 B-1's discipline): ownership comes
// only from `spec-spine registry list --json` run against the corpus, and
// the corpus pin only from `spec-spine attest`; a subprocess failure is a
// typed error, never an empty ownership map that would score everything
// orphan and look like a finding.
//
// Third, honesty (B-2, B-5): every number carries its denominator, no
// single scalar stands in for the report, and the one thing the replay
// cannot know is said out loud: history measures where boundaries held,
// not whether the specs' prose is true.
import * as fs from "fs";
import { join } from "path";
import {
  DEFAULT_EXCLUSIONS,
  DEFAULT_HISTORY_WINDOW,
  ruleExcludes,
  type AppliedExclusionRule,
  type ExclusionRule,
  type HistoryMode,
} from "./preflight";

// --- history extraction (B-1) -----------------------------------------------

// One changed path as one commit reported it. `renamedFrom` is non-null on a
// rename entry: the commit's own change landed at `path`, and `renamedFrom`
// is the name older history knew it by (D-1's rename following).
export interface ReplayChange {
  readonly path: string;
  readonly renamedFrom: string | null;
}

export interface ReplayCommit {
  readonly sha: string;
  readonly subject: string;
  readonly changes: readonly ReplayChange[];
  // B-5: a commit whose record could not be parsed is carried and reported
  // per commit, never silently skipped.
  readonly parseError: string | null;
}

// The injected boundary for everything the replay learns from the target's
// git, mirroring preflight's PreflightGitReader. Both list methods answer
// null when git itself cannot answer.
export interface HoldbackGitReader {
  headSha(repoDir: string): string | null;
  // The remote-anchored default branch ref ("origin/main" style), or null
  // when none resolves; the local checked-out branch says nothing about
  // where work lands (025's probe reasoning), and a synthesis checkout may
  // be sitting on the corpus branch itself.
  defaultBranchRef(repoDir: string): string | null;
  // First-parent history of `ref`, newest first, at most `limit` entries,
  // with per-path status and rename detection; merges-only when asked, every
  // merge diffed against its first parent.
  firstParentChanges(repoDir: string, ref: string, limit: number, mergesOnly: boolean): readonly ReplayCommit[] | null;
}

export interface ReplayHistory {
  readonly mode: HistoryMode;
  // The ref actually walked, and the named fallback when HEAD stood in for
  // an unresolvable default branch (B-5: the report says what was measured).
  readonly ref: string;
  readonly refFallback: string | null;
  readonly requested: number;
  readonly commits: readonly ReplayCommit[];
  readonly shortfall: string | null;
}

function shortfallOf(unit: string, used: number, requested: number): string | null {
  if (used >= requested) return null;
  return `the clone holds only ${used} ${unit}(s) of the ${requested} requested`;
}

// 034 B-3's window discipline and D-1 mode decision, re-applied here: merges
// when the first-parent line has any, plain first-parent commits otherwise
// (a squash-merge history has no merge commits and is still reviewed
// history), empty when there is nothing to read either way.
export function extractReplayHistory(
  reader: HoldbackGitReader,
  repoDir: string,
  requested: number = DEFAULT_HISTORY_WINDOW
): ReplayHistory {
  const resolved = reader.defaultBranchRef(repoDir);
  const ref = resolved ?? "HEAD";
  const refFallback =
    resolved === null ? "no origin default branch resolves; HEAD stood in (fixture or offline clone)" : null;

  const merges = reader.firstParentChanges(repoDir, ref, requested, true) ?? [];
  if (merges.length > 0) {
    return {
      mode: "merges",
      ref,
      refFallback,
      requested,
      commits: merges,
      shortfall: shortfallOf("first-parent merge", merges.length, requested),
    };
  }
  const commits = reader.firstParentChanges(repoDir, ref, requested, false) ?? [];
  if (commits.length === 0) return { mode: "empty", ref, refFallback, requested, commits: [], shortfall: null };
  return {
    mode: "commits",
    ref,
    refFallback,
    requested,
    commits,
    shortfall: shortfallOf("first-parent commit", commits.length, requested),
  };
}

// Same record framing as the preflight's log parse: \x1e opens a commit,
// \x1f splits sha from subject; here the body lines are --name-status
// entries (tab-separated status, path[, path]).
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

function parseNameStatusLog(stdout: string): ReplayCommit[] {
  const out: ReplayCommit[] = [];
  for (const chunk of stdout.split(RECORD_SEP)) {
    if (chunk.trim().length === 0) continue;
    const lines = chunk.split("\n");
    const header = lines[0]!;
    const sep = header.indexOf(FIELD_SEP);
    if (sep < 0) {
      // B-5: carried as an errored commit, reported per commit downstream.
      out.push({ sha: "(unparsed)", subject: header.trim(), changes: [], parseError: "log record has no sha/subject header" });
      continue;
    }
    const changes: ReplayChange[] = [];
    let parseError: string | null = null;
    for (const line of lines.slice(1)) {
      if (line.length === 0) continue;
      const cells = line.split("\t");
      const status = cells[0] ?? "";
      // R (rename) and C (copy) carry two paths; the change landed at the
      // second. Only a rename retires the old name for older history: a
      // copy's source lives on.
      if (status.startsWith("R") || status.startsWith("C")) {
        if (cells.length < 3) {
          parseError = `name-status line "${line}" has fewer fields than its status promises`;
          continue;
        }
        changes.push({ path: cells[2]!, renamedFrom: status.startsWith("R") ? cells[1]! : null });
      } else if (cells.length >= 2) {
        changes.push({ path: cells[1]!, renamedFrom: null });
      } else {
        parseError = `name-status line "${line}" has no path`;
      }
    }
    out.push({ sha: header.slice(0, sep), subject: header.slice(sep + 1), changes, parseError });
  }
  return out;
}

function runGit(repoDir: string, args: readonly string[]): string | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd: repoDir });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout);
}

// The production reader. Read-only by construction: rev-parse, symbolic-ref,
// and log are the only git verbs it knows.
export function createProcessHoldbackGitReader(): HoldbackGitReader {
  return {
    headSha(repoDir: string): string | null {
      const out = runGit(repoDir, ["rev-parse", "HEAD"]);
      if (out === null) return null;
      const sha = out.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },

    defaultBranchRef(repoDir: string): string | null {
      const head = runGit(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (head !== null && head.trim().startsWith("origin/")) return head.trim();
      for (const candidate of ["origin/main", "origin/master"]) {
        const ref = runGit(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`]);
        if (ref !== null) return candidate;
      }
      return null;
    },

    firstParentChanges(repoDir: string, ref: string, limit: number, mergesOnly: boolean): readonly ReplayCommit[] | null {
      const out = runGit(repoDir, [
        "log",
        "--first-parent",
        ...(mergesOnly ? ["--merges"] : []),
        // The evidence is the reviewed change as it landed (034 D-1), with
        // renames detected so D-1's following has something to follow.
        "--diff-merges=first-parent",
        "-M",
        "-n",
        String(limit),
        `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%s`,
        "--name-status",
        ref,
      ]);
      if (out === null) return null;
      return parseNameStatusLog(out);
    },
  };
}

// --- present-name resolution (D-1) ------------------------------------------

// D-1: the corpus is the constant and history is the variable, so a path a
// historical commit touched is evaluated under the name the corpus's present
// can know it by. Walking newest to oldest, each rename observed in a newer
// commit forwards the old name; a commit's own paths resolve through the
// renames that happened after it, and its own renames are registered only
// afterwards (they retire the old name for older commits, not for itself).
// Returns one deduplicated, sorted path list per commit, same order as the
// input.
export function resolvePresentNames(commits: readonly ReplayCommit[]): readonly (readonly string[])[] {
  const forward = new Map<string, string>();
  const follow = (path: string): string => {
    const seen = new Set<string>([path]);
    let current = path;
    while (forward.has(current)) {
      const next = forward.get(current)!;
      // A rename cycle within the window (a->b then b->a) settles on the
      // first repeat rather than spinning; the corpus's present name wins.
      if (seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current;
  };

  const resolved: (readonly string[])[] = [];
  for (const commit of commits) {
    resolved.push([...new Set(commit.changes.map((change) => follow(change.path)))].sort());
    for (const change of commit.changes) {
      if (change.renamedFrom !== null && change.renamedFrom !== change.path) {
        forward.set(change.renamedFrom, follow(change.path));
      }
    }
  }
  return resolved;
}

// --- corpus ownership (B-1, FR-002) -----------------------------------------

// A spec's territory claim, collapsed to what path coverage needs: a file
// unit owns its exact path, a directory unit owns every path under it, and a
// section unit owns the file it anchors into (owning a section of
// package.json is owning package.json for coverage purposes).
export interface OwnershipUnit {
  readonly kind: "file" | "directory";
  readonly path: string;
}

export interface SpecOwnership {
  readonly id: string;
  readonly units: readonly OwnershipUnit[];
}

export interface CorpusOwnership {
  readonly specs: readonly SpecOwnership[];
  // D-3: the corpus's explicit ungoverned remainder is its own coupling
  // bypass list (spec-spine.toml [coupling] bypass_prefixes), the same
  // prefixes the gate itself exempts from ownership.
  readonly remainderPrefixes: readonly string[];
  // B-3: the compiled registry's own content hashing, via `spec-spine
  // attest` (D-6).
  readonly corpusHash: string;
  readonly corpusHead: string | null;
}

// The injected boundary for everything the replay learns from the corpus.
// Production shells out to spec-spine inside the corpus checkout; each
// method throws with the failure named (FR-002), never returns emptiness.
export interface HoldbackCorpusReader {
  compile(corpusDir: string): void;
  attestationHash(corpusDir: string): string;
  registryListJson(corpusDir: string): string;
  headSha(corpusDir: string): string | null;
  // The corpus's spec-spine.toml text, null when the file is absent (an
  // absent config is a corpus with no declared remainder, not a failure).
  configToml(corpusDir: string): string | null;
}

function runSpecSpine(corpusDir: string, args: readonly string[]): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["spec-spine", ...args, "--repo", corpusDir]);
  } catch (err) {
    throw new Error(`holdback: spec-spine not found on PATH (needed for "${args.join(" ")}"): ${(err as Error).message}`);
  }
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`holdback: spec-spine ${args.join(" ")} failed against ${corpusDir} (exit ${result.exitCode}): ${stderr.trim()}`);
  }
  return new TextDecoder().decode(result.stdout);
}

// The production reader. compile and attest refresh the corpus checkout's
// own deterministic .derived/ artifacts and never an authored file, the same
// write discipline 025's qualification probe already runs under.
export function createProcessHoldbackCorpusReader(): HoldbackCorpusReader {
  return {
    compile(corpusDir: string): void {
      runSpecSpine(corpusDir, ["compile"]);
    },

    attestationHash(corpusDir: string): string {
      const out = runSpecSpine(corpusDir, ["attest"]);
      const match = /attestationHash:\s*([0-9a-f]{64})/.exec(out);
      if (match === null) {
        throw new Error(`holdback: spec-spine attest against ${corpusDir} printed no attestationHash`);
      }
      return match[1]!;
    },

    registryListJson(corpusDir: string): string {
      return runSpecSpine(corpusDir, ["registry", "list", "--json"]);
    },

    headSha(corpusDir: string): string | null {
      const out = runGit(corpusDir, ["rev-parse", "HEAD"]);
      if (out === null) return null;
      const sha = out.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },

    configToml(corpusDir: string): string | null {
      try {
        return fs.readFileSync(join(corpusDir, "spec-spine.toml"), "utf8");
      } catch {
        return null;
      }
    },
  };
}

function parseUnit(raw: unknown): OwnershipUnit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const unit = raw as Record<string, unknown>;
  if (unit.kind === "file" && typeof unit.path === "string") return { kind: "file", path: unit.path };
  if (unit.kind === "directory" && typeof unit.path === "string") {
    return { kind: "directory", path: unit.path.endsWith("/") ? unit.path : `${unit.path}/` };
  }
  // A section unit's claim collapses to its file; every other unit kind is
  // the corpus lint's business, not coverage's, and contributes nothing.
  if (unit.kind === "section" && typeof unit.file === "string") return { kind: "file", path: unit.file };
  return null;
}

// D-3: bypass prefixes read from the corpus's own config. Only the explicit
// declaration counts as the corpus's remainder; spec-spine's built-in
// generic floor is not mirrored here, because the replay's exclusion floor
// (034's audited rules) already keeps the same mechanical classes out of
// the evidence on the history side.
export function remainderPrefixesFromToml(toml: string | null, corpusDir: string): readonly string[] {
  if (toml === null) return [];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(toml);
  } catch (err) {
    throw new Error(`holdback: the corpus's spec-spine.toml at ${corpusDir} is not parseable TOML: ${(err as Error).message}`);
  }
  const coupling = (parsed as Record<string, unknown> | null)?.coupling;
  if (typeof coupling !== "object" || coupling === null) return [];
  const prefixes = (coupling as Record<string, unknown>).bypass_prefixes;
  if (!Array.isArray(prefixes)) return [];
  return prefixes.filter((entry): entry is string => typeof entry === "string");
}

// Loads the ownership snapshot through the injected reader (FR-002). The
// only place the corpus's `registry list --json` output is parsed;
// unparseable output is a typed error, never an empty snapshot.
export function loadCorpusOwnership(reader: HoldbackCorpusReader, corpusDir: string): CorpusOwnership {
  reader.compile(corpusDir);

  const label = "spec-spine registry list --json";
  const raw = reader.registryListJson(corpusDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`holdback: ${label} against ${corpusDir} produced unparseable output: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`holdback: ${label} against ${corpusDir} produced unparseable output (expected a JSON array)`);
  }

  const specs: SpecOwnership[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).id !== "string") {
      throw new Error(`holdback: ${label} against ${corpusDir} produced unparseable output (entry missing string id)`);
    }
    const entry = item as Record<string, unknown>;
    // A retired or superseded spec's territory is history, not a live claim;
    // draft counts, because scoring an unratified draft corpus is the whole
    // point (B-4, 035).
    if (entry.status === "retired" || entry.status === "superseded") continue;
    const units: OwnershipUnit[] = [];
    const establishes = Array.isArray(entry.establishes) ? entry.establishes : [];
    for (const rawUnit of establishes) {
      const unit = parseUnit(rawUnit);
      if (unit !== null) units.push(unit);
    }
    const extendsEdges = Array.isArray(entry.extends) ? entry.extends : [];
    for (const edge of extendsEdges) {
      const unit = parseUnit((edge as Record<string, unknown> | null)?.unit);
      if (unit !== null) units.push(unit);
    }
    specs.push({ id: entry.id as string, units });
  }

  return {
    specs,
    remainderPrefixes: remainderPrefixesFromToml(reader.configToml(corpusDir), corpusDir),
    corpusHash: reader.attestationHash(corpusDir),
    corpusHead: reader.headSha(corpusDir),
  };
}

export function unitOwns(unit: OwnershipUnit, path: string): boolean {
  return unit.kind === "file" ? unit.path === path : path.startsWith(unit.path);
}

// --- the replay (B-1, B-2, D-2, FR-001) -------------------------------------

export type CommitOutcome = "covered" | "orphaned" | "ungoverned-only" | "error";

export interface CommitVerdict {
  readonly sha: string;
  readonly subject: string;
  readonly outcome: CommitOutcome;
  // Covered commits only: the size of a minimal owning-spec cover and the
  // specs in it (D-6: deterministic greedy cover; D-2: reported, never
  // thresholded into pass/fail here).
  readonly dispersion: number | null;
  readonly coveringSpecs: readonly string[];
  // Orphaned commits only: the uncovered present-name paths, verbatim.
  readonly orphans: readonly string[];
  readonly governedPaths: number;
  readonly excludedPaths: number;
  readonly remainderPaths: number;
  readonly error: string | null;
}

export interface OrphanTouch {
  readonly path: string;
  readonly touches: number;
}

export interface DispersionBucket {
  readonly specs: number;
  readonly commits: number;
}

// The full score (B-2): no single scalar stands in for it, and every count
// travels beside its denominator. JSON-safe by construction, because B-3
// journals it verbatim.
export interface HoldbackScore {
  readonly ref: string;
  readonly refFallback: string | null;
  readonly mode: HistoryMode;
  readonly requested: number;
  readonly read: number;
  readonly shortfall: string | null;
  readonly evaluated: number;
  readonly covered: number;
  readonly orphaned: number;
  readonly ungovernedOnly: number;
  readonly errored: number;
  readonly orphanPaths: readonly OrphanTouch[];
  readonly dispersion: readonly DispersionBucket[];
  readonly failures: readonly CommitVerdict[];
  readonly errors: readonly { readonly sha: string; readonly detail: string }[];
  readonly exclusions: readonly AppliedExclusionRule[];
  readonly remainder: { readonly prefixes: readonly string[]; readonly matched: number };
}

// D-6: dispersion is the size of a deterministic greedy minimal cover: the
// spec covering the most still-uncovered paths is chosen next, ties broken
// lexicographically by id, so "how many specs would this change have had to
// touch" is a pure function of the inputs. Every path here has at least one
// owner (orphans were split off), so the loop always terminates.
function greedyCover(pathOwners: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const uncovered = new Set(pathOwners.keys());
  const chosen: string[] = [];
  while (uncovered.size > 0) {
    const gain = new Map<string, number>();
    for (const path of uncovered) {
      for (const spec of pathOwners.get(path)!) gain.set(spec, (gain.get(spec) ?? 0) + 1);
    }
    const best = [...gain.entries()].sort(([aId, aGain], [bId, bGain]) => bGain - aGain || aId.localeCompare(bId))[0]![0];
    chosen.push(best);
    for (const path of [...uncovered]) {
      if (pathOwners.get(path)!.includes(best)) uncovered.delete(path);
    }
  }
  return chosen.sort();
}

// The replay itself: pure over (history, ownership, exclusion rules).
export function replayHoldback(
  history: ReplayHistory,
  ownership: CorpusOwnership,
  rules: readonly ExclusionRule[] = DEFAULT_EXCLUSIONS
): HoldbackScore {
  const resolved = resolvePresentNames(history.commits);
  const excludedByRule = rules.map(() => new Set<string>());
  const remainderMatched = new Set<string>();
  const orphanTouches = new Map<string, number>();
  const dispersionCounts = new Map<number, number>();
  const failures: CommitVerdict[] = [];
  const errors: { sha: string; detail: string }[] = [];

  let covered = 0;
  let orphaned = 0;
  let ungovernedOnly = 0;
  let errored = 0;

  history.commits.forEach((commit, index) => {
    if (commit.parseError !== null) {
      errored += 1;
      errors.push({ sha: commit.sha, detail: commit.parseError });
      return;
    }

    const governed: string[] = [];
    let excludedPaths = 0;
    let remainderPaths = 0;
    for (const path of resolved[index]!) {
      const ruleIndex = rules.findIndex((rule) => ruleExcludes(rule, path));
      if (ruleIndex >= 0) {
        excludedByRule[ruleIndex]!.add(path);
        excludedPaths += 1;
        continue;
      }
      if (ownership.remainderPrefixes.some((prefix) => path.startsWith(prefix))) {
        remainderMatched.add(path);
        remainderPaths += 1;
        continue;
      }
      governed.push(path);
    }

    if (governed.length === 0) {
      // Counted in neither numerator nor denominator (B-1's remainder rule
      // extended to whole commits), and reported as its own bucket.
      ungovernedOnly += 1;
      return;
    }

    const pathOwners = new Map<string, readonly string[]>();
    const orphans: string[] = [];
    for (const path of governed) {
      const owners = ownership.specs
        .filter((spec) => spec.units.some((unit) => unitOwns(unit, path)))
        .map((spec) => spec.id);
      if (owners.length === 0) orphans.push(path);
      else pathOwners.set(path, owners);
    }

    if (orphans.length > 0) {
      orphaned += 1;
      for (const path of orphans) orphanTouches.set(path, (orphanTouches.get(path) ?? 0) + 1);
      failures.push({
        sha: commit.sha,
        subject: commit.subject,
        outcome: "orphaned",
        dispersion: null,
        coveringSpecs: [],
        orphans,
        governedPaths: governed.length,
        excludedPaths,
        remainderPaths,
        error: null,
      });
      return;
    }

    const cover = greedyCover(pathOwners);
    covered += 1;
    dispersionCounts.set(cover.length, (dispersionCounts.get(cover.length) ?? 0) + 1);
  });

  return {
    ref: history.ref,
    refFallback: history.refFallback,
    mode: history.mode,
    requested: history.requested,
    read: history.commits.length,
    shortfall: history.shortfall,
    evaluated: covered + orphaned,
    covered,
    orphaned,
    ungovernedOnly,
    errored,
    orphanPaths: [...orphanTouches.entries()]
      .sort(([aPath, aTouches], [bPath, bTouches]) => bTouches - aTouches || aPath.localeCompare(bPath))
      .map(([path, touches]) => ({ path, touches })),
    dispersion: [...dispersionCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([specs, commits]) => ({ specs, commits })),
    failures,
    errors,
    exclusions: rules.map((rule, index) => ({ ...rule, matched: excludedByRule[index]!.size })),
    remainder: { prefixes: ownership.remainderPrefixes, matched: remainderMatched.size },
  };
}

// --- the report (B-2, B-5, FR-004) ------------------------------------------

export interface HoldbackReportContext {
  readonly corpusRef: string;
  readonly corpusHash: string;
  readonly corpusSpecs: number;
  readonly corpusHead: string | null;
  readonly targetDir: string;
  readonly targetHead: string | null;
}

function pctOf(part: number, whole: number): string {
  return whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

// FR-004: a denominator beside every percentage, and the per-commit failure
// detail carries its uncovered paths verbatim. The report never collapses
// to one scalar (B-2): coverage, orphans, dispersion, and failures travel
// together or not at all.
export function renderHoldbackReport(score: HoldbackScore, context: HoldbackReportContext): string[] {
  const lines: string[] = [];

  lines.push(`corpus:  ${context.corpusRef} (${context.corpusSpecs} spec(s), attested ${context.corpusHash})`);
  if (context.corpusHead !== null) lines.push(`         at ${context.corpusHead}`);
  lines.push(`target:  ${context.targetDir} at ${context.targetHead ?? "(no commits)"}`);

  const unit = score.mode === "merges" ? "first-parent merge(s)" : "first-parent commit(s), no merges on the first-parent line";
  lines.push(`history: ${score.read} ${unit} on ${score.ref} (window requested ${score.requested})`);
  if (score.refFallback !== null) lines.push(`         ${score.refFallback}`);
  if (score.shortfall !== null) lines.push(`         shortfall: ${score.shortfall}`);

  lines.push(`coverage: ${score.covered} of ${score.evaluated} evaluated commit(s) fully covered (${pctOf(score.covered, score.evaluated)})`);
  if (score.ungovernedOnly > 0) {
    lines.push(
      `          ${score.ungovernedOnly} of ${score.read} read commit(s) touched no governed path (excluded, declared ungoverned, or an empty diff) and were evaluated as neither`
    );
  }
  if (score.errored > 0) {
    lines.push(`          ${score.errored} of ${score.read} read commit(s) could not be evaluated:`);
    for (const error of score.errors) lines.push(`            ${error.sha}: ${error.detail}`);
  }

  if (score.orphanPaths.length === 0) {
    lines.push("orphans: none; every governed path the window touched is owned by some spec");
  } else {
    lines.push(`orphans: ${score.orphanPaths.length} path(s) no spec owns, ranked by touch count:`);
    for (const orphan of score.orphanPaths) {
      lines.push(`  ${orphan.path} (orphan in ${orphan.touches} of ${score.evaluated} evaluated commit(s))`);
    }
  }

  if (score.covered > 0) {
    // D-2: evidence for the operator's judgment, never a pass/fail line.
    const buckets = score.dispersion
      .map((bucket) => `${bucket.specs} spec(s): ${bucket.commits} of ${score.covered}`)
      .join("   ");
    lines.push(`dispersion (owning specs per covered commit): ${buckets}`);
  }

  if (score.failures.length > 0) {
    lines.push(`failures (${score.failures.length} of ${score.evaluated} evaluated commit(s)):`);
    for (const failure of score.failures) {
      lines.push(`  ${failure.sha.slice(0, 12)}  ${failure.subject}`);
      for (const orphan of failure.orphans) lines.push(`    orphan: ${orphan}`);
    }
  }

  if (score.remainder.prefixes.length > 0) {
    lines.push(
      `remainder: ${score.remainder.matched} path(s) under ${score.remainder.prefixes.length} prefix(es) the corpus declares ` +
        `ungoverned (coupling bypass): ${score.remainder.prefixes.join(", ")}; counted as neither covered nor orphan`
    );
  }
  const firedRules = score.exclusions.filter((rule) => rule.matched > 0);
  if (firedRules.length > 0) {
    lines.push(
      `excluded by rule (${score.exclusions.length} rule floor, 034 D-2): ` +
        firedRules.map((rule) => `${rule.rule} (${rule.why}): ${rule.matched} path(s)`).join(", ")
    );
  }

  // B-5: the limit of the instrument, said in the report itself.
  lines.push("note: this replay measures where the declared boundaries would have held, not whether the specs' prose");
  lines.push("      is true; prose truth is what the operator's ratification read (010 D18) is for");

  return lines;
}
