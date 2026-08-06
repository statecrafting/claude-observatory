// Spec 036 FR-001: the replay and the scoring are pure over (commit path
// sets, ownership snapshot) and are exercised here against synthetic
// histories and hand-built corpora, no subprocess involved. FR-002's typed
// errors and FR-004's denominator discipline are covered against fixture
// readers and rendered reports; the one real-git section at the end pins
// the production reader's rename detection, which D-1's following depends
// on.
import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_EXCLUSIONS } from "./preflight";
import {
  createProcessHoldbackGitReader,
  extractReplayHistory,
  loadCorpusOwnership,
  remainderPrefixesFromToml,
  renderHoldbackReport,
  replayHoldback,
  resolvePresentNames,
  unitOwns,
  type CorpusOwnership,
  type HoldbackCorpusReader,
  type HoldbackGitReader,
  type HoldbackReportContext,
  type ReplayCommit,
  type ReplayHistory,
} from "./holdback";

// --- fixtures ---------------------------------------------------------------

type ChangeSpec = string | { readonly path: string; readonly from: string };

function commit(sha: string, subject: string, changes: readonly ChangeSpec[]): ReplayCommit {
  return {
    sha,
    subject,
    changes: changes.map((change) =>
      typeof change === "string" ? { path: change, renamedFrom: null } : { path: change.path, renamedFrom: change.from }
    ),
    parseError: null,
  };
}

function historyOf(commits: readonly ReplayCommit[], over: Partial<ReplayHistory> = {}): ReplayHistory {
  return {
    mode: "merges",
    ref: "origin/main",
    refFallback: null,
    requested: commits.length,
    commits,
    shortfall: null,
    ...over,
  };
}

// A path ending in "/" becomes a directory unit, anything else a file unit.
function corpusOf(specs: Readonly<Record<string, readonly string[]>>, over: Partial<CorpusOwnership> = {}): CorpusOwnership {
  return {
    specs: Object.entries(specs).map(([id, paths]) => ({
      id,
      units: paths.map((path) => ({ kind: path.endsWith("/") ? ("directory" as const) : ("file" as const), path })),
    })),
    remainderPrefixes: [],
    corpusHash: "a".repeat(64),
    corpusHead: null,
    ...over,
  };
}

const reportContext: HoldbackReportContext = {
  corpusRef: "draft/corpus",
  corpusHash: "a".repeat(64),
  corpusSpecs: 2,
  corpusHead: null,
  targetDir: "/target",
  targetHead: "b".repeat(40),
};

// --- the replay (FR-001) ----------------------------------------------------

test("full coverage: every governed path owned, every commit covered", () => {
  const history = historyOf([
    commit("c1", "auth round", ["src/auth/login.ts", "src/auth/token.ts"]),
    commit("c2", "core round", ["src/core/db.ts"]),
  ]);
  const corpus = corpusOf({ "001-auth": ["src/auth/login.ts", "src/auth/token.ts"], "002-core": ["src/core/db.ts"] });
  const score = replayHoldback(history, corpus);

  expect(score.evaluated).toBe(2);
  expect(score.covered).toBe(2);
  expect(score.orphaned).toBe(0);
  expect(score.orphanPaths).toHaveLength(0);
  expect(score.failures).toHaveLength(0);
  expect(score.dispersion).toEqual([{ specs: 1, commits: 2 }]);
});

test("orphans fail their commit, rank by touch count, and travel verbatim (B-2)", () => {
  const history = historyOf([
    commit("c1", "hot", ["src/rogue.ts", "src/owned.ts"]),
    commit("c2", "hot again", ["src/rogue.ts"]),
    commit("c3", "cooler", ["src/other.ts", "src/owned.ts"]),
  ]);
  const corpus = corpusOf({ "001-owned": ["src/owned.ts"] });
  const score = replayHoldback(history, corpus);

  expect(score.evaluated).toBe(3);
  expect(score.covered).toBe(0);
  expect(score.orphaned).toBe(3);
  // Ranked by touches, ties would break lexicographically.
  expect(score.orphanPaths).toEqual([
    { path: "src/rogue.ts", touches: 2 },
    { path: "src/other.ts", touches: 1 },
  ]);
  const failure = score.failures.find((entry) => entry.sha === "c1")!;
  expect(failure.orphans).toEqual(["src/rogue.ts"]);
  expect(failure.subject).toBe("hot");
});

test("dispersion is a deterministic minimal cover, reported never judged (D-2, D-6)", () => {
  const history = historyOf([
    commit("c1", "one spec suffices", ["src/a.ts", "src/shared.ts"]),
    commit("c2", "three territories", ["src/a.ts", "src/b.ts", "src/c.ts"]),
  ]);
  const corpus = corpusOf({
    "001-a": ["src/a.ts", "src/shared.ts"],
    "002-b": ["src/b.ts", "src/shared.ts"],
    "003-c": ["src/c.ts"],
  });
  const score = replayHoldback(history, corpus);

  expect(score.covered).toBe(2);
  // c1: 001-a covers both paths alone even though 002-b also owns shared.ts;
  // c2: no single spec covers a/b/c, the minimal cover is all three.
  expect(score.dispersion).toEqual([
    { specs: 1, commits: 1 },
    { specs: 3, commits: 1 },
  ]);
});

test("directory units own every path under them", () => {
  expect(unitOwns({ kind: "directory", path: "src/auth/" }, "src/auth/deep/nested.ts")).toBe(true);
  expect(unitOwns({ kind: "directory", path: "src/auth/" }, "src/authx/file.ts")).toBe(false);
  expect(unitOwns({ kind: "file", path: "src/auth/login.ts" }, "src/auth/login.ts")).toBe(true);

  const history = historyOf([commit("c1", "nested", ["src/auth/deep/nested.ts"])]);
  const score = replayHoldback(history, corpusOf({ "001-auth": ["src/auth/"] }));
  expect(score.covered).toBe(1);
});

test("the declared remainder is counted as neither, and a remainder-only commit is not evaluated (B-1)", () => {
  const history = historyOf([
    commit("c1", "code and docs", ["src/owned.ts", "docs/notes.md"]),
    commit("c2", "docs only", ["docs/other.md"]),
  ]);
  const corpus = corpusOf({ "001-owned": ["src/owned.ts"] }, { remainderPrefixes: ["docs/"] });
  const score = replayHoldback(history, corpus);

  expect(score.evaluated).toBe(1);
  expect(score.covered).toBe(1);
  expect(score.ungovernedOnly).toBe(1);
  expect(score.remainder).toEqual({ prefixes: ["docs/"], matched: 2 });
});

test("the exclusion floor keeps mechanical noise out of the orphan list (D-3)", () => {
  const history = historyOf([commit("c1", "bump", ["bun.lock", "src/owned.ts"])]);
  const score = replayHoldback(history, corpusOf({ "001-owned": ["src/owned.ts"] }));

  expect(score.covered).toBe(1);
  expect(score.orphanPaths).toHaveLength(0);
  const fired = score.exclusions.filter((rule) => rule.matched > 0);
  expect(fired).toEqual([{ rule: "bun.lock", why: "lockfile", matched: 1 }]);
  expect(score.exclusions).toHaveLength(DEFAULT_EXCLUSIONS.length);
});

test("the empty corpus scores 0 of N with every governed path an orphan, not an error (FR-001)", () => {
  const history = historyOf([
    commit("c1", "one", ["src/a.ts"]),
    commit("c2", "two", ["src/b.ts"]),
  ]);
  const score = replayHoldback(history, corpusOf({}));

  expect(score.evaluated).toBe(2);
  expect(score.covered).toBe(0);
  expect(score.orphaned).toBe(2);
  expect(score.orphanPaths.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
});

test("a shortfall travels into the score named, and still scores (B-5)", () => {
  const history = historyOf([commit("c1", "only one", ["src/owned.ts"])], {
    requested: 200,
    shortfall: "the clone holds only 1 first-parent merge(s) of the 200 requested",
  });
  const score = replayHoldback(history, corpusOf({ "001-owned": ["src/owned.ts"] }));
  expect(score.covered).toBe(1);
  expect(score.shortfall).toContain("only 1");
});

test("a commit that could not be parsed is reported per commit, never skipped (B-5)", () => {
  const broken: ReplayCommit = { sha: "(unparsed)", subject: "??", changes: [], parseError: "log record has no sha/subject header" };
  const history = historyOf([broken, commit("c2", "fine", ["src/owned.ts"])]);
  const score = replayHoldback(history, corpusOf({ "001-owned": ["src/owned.ts"] }));

  expect(score.errored).toBe(1);
  expect(score.errors).toEqual([{ sha: "(unparsed)", detail: "log record has no sha/subject header" }]);
  expect(score.evaluated).toBe(1);
  expect(score.covered).toBe(1);
});

// --- rename following (D-1) -------------------------------------------------

test("a path renamed by a newer commit is evaluated under its present name (D-1)", () => {
  // Newest first: c2 renamed old.ts to new.ts, c1 (older) touched old.ts.
  const commits = [
    commit("c2", "rename", [{ path: "src/new.ts", from: "src/old.ts" }]),
    commit("c1", "edit before the rename", ["src/old.ts"]),
  ];
  expect(resolvePresentNames(commits)).toEqual([["src/new.ts"], ["src/new.ts"]]);

  const score = replayHoldback(historyOf(commits), corpusOf({ "001-new": ["src/new.ts"] }));
  expect(score.covered).toBe(2);
  expect(score.orphaned).toBe(0);
});

test("rename chains follow transitively and a cycle settles instead of spinning", () => {
  const chain = [
    commit("c3", "rename again", [{ path: "src/c.ts", from: "src/b.ts" }]),
    commit("c2", "rename", [{ path: "src/b.ts", from: "src/a.ts" }]),
    commit("c1", "edit the original", ["src/a.ts"]),
  ];
  expect(resolvePresentNames(chain)[2]).toEqual(["src/c.ts"]);

  const cycle = [
    commit("c3", "swap back", [{ path: "src/a.ts", from: "src/b.ts" }]),
    commit("c2", "swap", [{ path: "src/b.ts", from: "src/a.ts" }]),
    commit("c1", "edit", ["src/a.ts"]),
  ];
  // The resolution terminates and lands on a name inside the cycle.
  const resolved = resolvePresentNames(cycle)[2]!;
  expect(resolved).toHaveLength(1);
  expect(["src/a.ts", "src/b.ts"]).toContain(resolved[0]!);
});

// --- corpus reads (FR-002) --------------------------------------------------

function fixtureCorpusReader(over: Partial<HoldbackCorpusReader> = {}): HoldbackCorpusReader {
  return {
    compile: () => {},
    attestationHash: () => "c".repeat(64),
    registryListJson: () => JSON.stringify([{ id: "001-auth", status: "draft", establishes: [{ kind: "file", path: "src/auth/login.ts" }] }]),
    headSha: () => null,
    configToml: () => null,
    ...over,
  };
}

test("loadCorpusOwnership reads establishes, extends, and section units through the reader", () => {
  const reader = fixtureCorpusReader({
    registryListJson: () =>
      JSON.stringify([
        {
          id: "001-auth",
          status: "draft",
          establishes: [
            { kind: "file", path: "src/auth/login.ts" },
            { kind: "directory", path: "src/auth/helpers" },
          ],
          extends: [{ spec: "000-bootstrap", unit: { kind: "section", file: "package.json", anchor: "scripts" }, nature: "additive" }],
        },
        { id: "002-retired", status: "retired", establishes: [{ kind: "file", path: "src/gone.ts" }] },
      ]),
    configToml: () => `[coupling]\nbypass_prefixes = ["FINDINGS.md", "docs/"]\n`,
  });
  const ownership = loadCorpusOwnership(reader, "/corpus");

  expect(ownership.specs).toHaveLength(1);
  expect(ownership.specs[0]!.units).toEqual([
    { kind: "file", path: "src/auth/login.ts" },
    // The directory unit is normalized to a trailing slash; the section unit
    // collapses to its file.
    { kind: "directory", path: "src/auth/helpers/" },
    { kind: "file", path: "package.json" },
  ]);
  expect(ownership.remainderPrefixes).toEqual(["FINDINGS.md", "docs/"]);
  expect(ownership.corpusHash).toBe("c".repeat(64));
});

test("a subprocess failure is a typed error, never an empty ownership map (FR-002)", () => {
  const compileRed = fixtureCorpusReader({
    compile: () => {
      throw new Error("holdback: spec-spine compile failed against /corpus (exit 1): duplicate id");
    },
  });
  expect(() => loadCorpusOwnership(compileRed, "/corpus")).toThrow("spec-spine compile failed");

  const garbage = fixtureCorpusReader({ registryListJson: () => "not json" });
  expect(() => loadCorpusOwnership(garbage, "/corpus")).toThrow("unparseable");

  const notArray = fixtureCorpusReader({ registryListJson: () => `{"id":"x"}` });
  expect(() => loadCorpusOwnership(notArray, "/corpus")).toThrow("expected a JSON array");
});

test("remainder prefixes parse from the corpus's own config, and bad TOML is a typed error (D-3)", () => {
  expect(remainderPrefixesFromToml(null, "/corpus")).toEqual([]);
  expect(remainderPrefixesFromToml("[layout]\nspecs_dir = \"specs\"\n", "/corpus")).toEqual([]);
  expect(remainderPrefixesFromToml(`[coupling]\nbypass_prefixes = ["a/", "b.md"]\n`, "/corpus")).toEqual(["a/", "b.md"]);
  expect(() => remainderPrefixesFromToml("[coupling]\nbypass_prefixes = [", "/corpus")).toThrow("not parseable TOML");
});

// --- history extraction (B-1) -----------------------------------------------

function fixtureGitReader(byMode: { merges?: readonly ReplayCommit[]; commits?: readonly ReplayCommit[] }): HoldbackGitReader {
  return {
    headSha: () => "d".repeat(40),
    defaultBranchRef: () => "origin/main",
    firstParentChanges: (_repo, _ref, _limit, mergesOnly) => (mergesOnly ? (byMode.merges ?? []) : (byMode.commits ?? [])),
  };
}

test("extraction prefers merges, falls back to commits, and names an empty history (034's discipline)", () => {
  const merge = commit("m1", "merge", ["src/a.ts"]);
  const plain = commit("p1", "plain", ["src/a.ts"]);

  const merges = extractReplayHistory(fixtureGitReader({ merges: [merge] }), "/target", 200);
  expect(merges.mode).toBe("merges");
  expect(merges.shortfall).toContain("only 1 first-parent merge(s)");

  const commits = extractReplayHistory(fixtureGitReader({ commits: [plain] }), "/target", 200);
  expect(commits.mode).toBe("commits");

  const empty = extractReplayHistory(fixtureGitReader({}), "/target", 200);
  expect(empty.mode).toBe("empty");
  expect(empty.commits).toHaveLength(0);
});

test("an unresolvable default branch falls back to HEAD with the fallback named (B-5)", () => {
  const reader: HoldbackGitReader = {
    headSha: () => null,
    defaultBranchRef: () => null,
    firstParentChanges: (_repo, ref) => (ref === "HEAD" ? [commit("c1", "x", ["src/a.ts"])] : []),
  };
  const history = extractReplayHistory(reader, "/target", 10);
  expect(history.ref).toBe("HEAD");
  expect(history.refFallback).toContain("HEAD stood in");
});

// --- the report (B-2, B-5, FR-004) ------------------------------------------

test("the report prints denominators everywhere and carries uncovered paths verbatim (FR-004)", () => {
  const history = historyOf([
    commit("a".repeat(40), "covered change", ["src/owned.ts"]),
    commit("f".repeat(40), "stray change", ["src/rogue.ts"]),
    commit("e".repeat(40), "docs only", ["docs/notes.md"]),
  ]);
  const corpus = corpusOf({ "001-owned": ["src/owned.ts"] }, { remainderPrefixes: ["docs/"] });
  const score = replayHoldback(history, corpus);
  const report = renderHoldbackReport(score, reportContext).join("\n");

  // The coverage line carries both integers beside the percentage (B-2).
  expect(report).toContain("coverage: 1 of 2 evaluated commit(s) fully covered (50.0%)");
  expect(report).toContain("1 of 3 read commit(s) touched no governed path");
  expect(report).toContain("orphans: 1 path(s) no spec owns");
  expect(report).toContain("src/rogue.ts (orphan in 1 of 2 evaluated commit(s))");
  // The failure detail names the commit and its uncovered paths verbatim.
  expect(report).toContain(`${"f".repeat(12)}  stray change`);
  expect(report).toContain("    orphan: src/rogue.ts");
  expect(report).toContain("dispersion (owning specs per covered commit): 1 spec(s): 1 of 1");
  expect(report).toContain("declares ungoverned (coupling bypass): docs/");
  // B-5: the limit of the instrument is part of the report itself.
  expect(report).toContain("not whether the specs' prose");
});

test("a fully covered report says orphans: none rather than omitting the section", () => {
  const history = historyOf([commit("c1", "fine", ["src/owned.ts"])]);
  const score = replayHoldback(history, corpusOf({ "001-owned": ["src/owned.ts"] }));
  const report = renderHoldbackReport(score, reportContext).join("\n");
  expect(report).toContain("coverage: 1 of 1 evaluated commit(s) fully covered (100.0%)");
  expect(report).toContain("orphans: none");
});

// --- the production git reader (D-1's substrate) ------------------------------

function gitIn(dir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

test("the production reader reports renames with both names, so D-1 has something to follow", () => {
  const dir = mkdtempSync(join(tmpdir(), "holdback-git-"));
  try {
    gitIn(dir, ["init", "-q", "-b", "main"]);
    gitIn(dir, ["config", "user.email", "test@example.com"]);
    gitIn(dir, ["config", "user.name", "Test"]);
    fs.mkdirSync(join(dir, "src"));
    fs.writeFileSync(join(dir, "src", "old.ts"), "export const value = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "add old"]);
    gitIn(dir, ["mv", "src/old.ts", "src/new.ts"]);
    gitIn(dir, ["commit", "-qm", "rename old to new"]);

    const reader = createProcessHoldbackGitReader();
    // No origin in this fixture: the default branch is honestly unresolvable.
    expect(reader.defaultBranchRef(dir)).toBeNull();
    const commits = reader.firstParentChanges(dir, "HEAD", 10, false)!;
    expect(commits).toHaveLength(2);
    expect(commits[0]!.subject).toBe("rename old to new");
    expect(commits[0]!.changes).toEqual([{ path: "src/new.ts", renamedFrom: "src/old.ts" }]);
    expect(commits[1]!.changes).toEqual([{ path: "src/old.ts", renamedFrom: null }]);

    const history = extractReplayHistory(reader, dir, 10);
    expect(history.mode).toBe("commits");
    const score = replayHoldback(history, corpusOf({ "001-src": ["src/new.ts"] }));
    expect(score.covered).toBe(2);
    expect(score.orphaned).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
