// Spec 034's colocated tests. Extraction, clustering, and serialization are
// exercised as the pure functions they are (FR-001, FR-003), against
// synthetic fixture histories; surface detection runs against real fixture
// directories (FR-002); the production git reader runs against a real git
// repository with a genuine merge, exactly as projects.test.ts drives the
// production probe.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, verifyChain } from "../journal";
import type { Project } from "../projects";
import {
  DEFAULT_EXCLUSIONS,
  DEFAULT_HISTORY_WINDOW,
  MIN_TERRITORY_COMMITS,
  PREFLIGHT_RECORD_KIND,
  WIDE_COMMIT_PATH_LIMIT,
  adoptableDagReader,
  applyExclusions,
  buildProposal,
  churnByPath,
  clusterPaths,
  createProcessPreflightGitReader,
  detectSurfaces,
  exclusionAdditionsFromFlag,
  extractHistory,
  journalPreflight,
  proposalHash,
  proposeTerritories,
  renderProposal,
  ruleExcludes,
  runPreflight,
  unknownSurfaces,
  type CommitChange,
  type PreflightGitReader,
  type SurfaceReport,
} from "./preflight";

// --- fixtures ---------------------------------------------------------------

function commit(sha: string, subject: string, paths: readonly string[]): CommitChange {
  return { sha, subject, paths };
}

function fixtureReader(
  merges: readonly CommitChange[],
  commits: readonly CommitChange[],
  head: string | null = "f".repeat(40)
): PreflightGitReader {
  return {
    headSha: () => head,
    firstParentLog: (_repoDir, limit, mergesOnly) => (mergesOnly ? merges : commits).slice(0, limit),
  };
}

// Two clearly separate subsystems (FR-001's first fixture): auth and billing
// each ship internally, never together.
const TWO_SUBSYSTEMS: readonly CommitChange[] = [
  commit("a1", "auth: sessions", ["src/auth/login.ts", "src/auth/token.ts"]),
  commit("b1", "billing: invoices", ["src/billing/invoice.ts", "src/billing/ledger.ts"]),
  commit("a2", "auth: refresh", ["src/auth/login.ts", "src/auth/token.ts"]),
  commit("b2", "billing: totals", ["src/billing/invoice.ts", "src/billing/ledger.ts"]),
  commit("a3", "auth: logout", ["src/auth/login.ts", "src/auth/token.ts"]),
  commit("b3", "billing: refunds", ["src/billing/invoice.ts", "src/billing/ledger.ts"]),
];

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `preflight-${prefix}-`));
}

function git(dir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

// A real repository whose only first-parent merge changed exactly the
// feature branch's files: what the production reader must report.
function repoWithMerge(): string {
  const dir = freshDir("repo");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  git(dir, ["checkout", "-qb", "feature"]);
  writeFileSync(join(dir, "one.txt"), "one\n");
  writeFileSync(join(dir, "two.txt"), "two\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "feature work"]);
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--no-ff", "feature", "-m", "merge feature (#1)"]);
  return dir;
}

// --- history extraction (B-3, D-1) ------------------------------------------

test("extractHistory prefers first-parent merges when the branch has any (D-1)", () => {
  const merges = [commit("m1", "merge (#1)", ["a.ts"])];
  const plain = [commit("c1", "direct", ["b.ts"]), ...merges];
  const history = extractHistory(fixtureReader(merges, plain), "/target");
  expect(history.mode).toBe("merges");
  expect(history.commits).toEqual(merges);
  expect(history.requested).toBe(DEFAULT_HISTORY_WINDOW);
});

test("a branch with no merge commits falls back to plain first-parent history, named (D-1)", () => {
  const plain = [commit("c1", "direct", ["b.ts"])];
  const history = extractHistory(fixtureReader([], plain), "/target");
  expect(history.mode).toBe("commits");
  expect(history.commits).toEqual(plain);
});

test("a shallow clone names its shortfall instead of absorbing it (FR-001)", () => {
  const merges = Array.from({ length: 5 }, (_, i) => commit(`m${i}`, `merge ${i}`, ["a.ts", "b.ts"]));
  const history = extractHistory(fixtureReader(merges, []), "/target", 200);
  expect(history.commits.length).toBe(5);
  expect(history.shortfall).toContain("only 5");
  expect(history.shortfall).toContain("200");
});

test("a window fully served has no shortfall to name", () => {
  const merges = [commit("m1", "merge", ["a.ts"]), commit("m2", "merge", ["a.ts"])];
  const history = extractHistory(fixtureReader(merges, []), "/target", 2);
  expect(history.shortfall).toBeNull();
});

test("an empty history is empty mode: the proposal says so and proposes nothing (FR-001)", () => {
  const history = extractHistory(fixtureReader([], [], null), "/target");
  expect(history.mode).toBe("empty");
  const proposal = buildProposal({
    repoDir: "/target",
    headSha: null,
    surfaces: detectSurfaces(freshDir("empty-surfaces")),
    history,
  });
  expect(proposal.territories.candidates.length).toBe(0);
  expect(proposal.territories.remainder.length).toBe(0);
  const document = renderProposal(proposal);
  expect(document).toContain("no readable commit history");
  expect(document).toContain("proposes nothing");
});

// --- exclusions (B-3, D-2) --------------------------------------------------

test("directory rules exclude at any depth; basename rules exclude the exact name", () => {
  const dirRule = { rule: "node_modules/", why: "vendored" } as const;
  expect(ruleExcludes(dirRule, "node_modules/pkg/index.js")).toBe(true);
  expect(ruleExcludes(dirRule, "a/node_modules/pkg/index.js")).toBe(true);
  expect(ruleExcludes(dirRule, "node_modules")).toBe(false);
  expect(ruleExcludes(dirRule, "src/node_modules.ts")).toBe(false);

  const nested = { rule: "src/gen/", why: "generated" } as const;
  expect(ruleExcludes(nested, "src/gen/types.ts")).toBe(true);
  expect(ruleExcludes(nested, "other/src/gen/types.ts")).toBe(true);
  expect(ruleExcludes(nested, "src/genuine/file.ts")).toBe(false);

  const lock = { rule: "bun.lock", why: "lockfile" } as const;
  expect(ruleExcludes(lock, "bun.lock")).toBe(true);
  expect(ruleExcludes(lock, "packages/app/bun.lock")).toBe(true);
  expect(ruleExcludes(lock, "bun.lockb")).toBe(false);
});

test("the default exclusion floor carries the audited vendored, generated, and lockfile entries", () => {
  const rules = DEFAULT_EXCLUSIONS.map((entry) => entry.rule);
  expect(rules).toContain("node_modules/");
  expect(rules).toContain(".derived/");
  expect(rules).toContain("target/");
  expect(rules).toContain("bun.lock");
  expect(rules).toContain("Cargo.lock");
  expect(rules).toContain("go.sum");
});

test("applyExclusions removes matched paths and reports every rule with its count", () => {
  const commits = [
    commit("c1", "one", ["src/a.ts", "node_modules/x/y.js", "bun.lock"]),
    commit("c2", "two", ["src/a.ts", "node_modules/z/w.js"]),
  ];
  const applied = applyExclusions(commits, DEFAULT_EXCLUSIONS);
  expect(applied.commits.map((c) => c.paths)).toEqual([["src/a.ts"], ["src/a.ts"]]);
  const byRule = new Map(applied.rules.map((rule) => [rule.rule, rule.matched]));
  expect(byRule.get("node_modules/")).toBe(2);
  expect(byRule.get("bun.lock")).toBe(1);
  // A rule in force is visible even when it matched nothing (B-3).
  expect(byRule.get("Cargo.lock")).toBe(0);
});

test("the CLI's additions flag parses to operator rules and refuses an empty flag (D-2)", () => {
  expect(exclusionAdditionsFromFlag(null)).toEqual([]);
  expect(exclusionAdditionsFromFlag("docs/, fixtures.json")).toEqual([
    { rule: "docs/", why: "operator" },
    { rule: "fixtures.json", why: "operator" },
  ]);
  expect(typeof exclusionAdditionsFromFlag(" , ")).toBe("string");
});

// --- clustering and candidates (B-4, D-3, FR-001) ---------------------------

test("two clearly separate subsystems propose two territories with an empty remainder (FR-001)", () => {
  const territories = proposeTerritories(TWO_SUBSYSTEMS);
  expect(territories.candidates.length).toBe(2);
  const paths = territories.candidates.map((candidate) => candidate.paths);
  expect(paths).toContainEqual(["src/auth/login.ts", "src/auth/token.ts"]);
  expect(paths).toContainEqual(["src/billing/invoice.ts", "src/billing/ledger.ts"]);
  expect(territories.remainder).toEqual([]);
  // Evidence rides on every candidate (B-4): churn share and sample commits.
  for (const candidate of territories.candidates) {
    expect(candidate.churnShare).toBeCloseTo(0.5);
    expect(candidate.commitCount).toBe(3);
    expect(candidate.sampleCommits.length).toBeGreaterThan(0);
  }
});

test("a hot subsystem clusters while the cold remainder stays explicit (FR-001)", () => {
  const commits = [
    ...Array.from({ length: 5 }, (_, i) => commit(`h${i}`, `hot ${i}`, ["src/hot/a.ts", "src/hot/b.ts"])),
    commit("c1", "cold one", ["docs/notes.md"]),
    commit("c2", "cold two", ["scripts/tool.sh"]),
    // A pair that co-changed once: perfect affinity, but below the live-churn
    // floor (MIN_TERRITORY_COMMITS), so it stays remainder, not territory.
    commit("d1", "drive-by", ["src/once/x.ts", "src/once/y.ts"]),
  ];
  expect(MIN_TERRITORY_COMMITS).toBeGreaterThan(1);
  const territories = proposeTerritories(commits);
  expect(territories.candidates.length).toBe(1);
  expect(territories.candidates[0]!.paths).toEqual(["src/hot/a.ts", "src/hot/b.ts"]);
  expect(territories.remainder.map((entry) => entry.path)).toEqual([
    "docs/notes.md",
    "scripts/tool.sh",
    "src/once/x.ts",
    "src/once/y.ts",
  ]);
  expect(territories.remainder[0]!.churn).toBe(1);
});

test("clusterPaths is deterministic greedy agglomeration over the affinity threshold (D-3)", () => {
  const clusters = clusterPaths(TWO_SUBSYSTEMS);
  expect(clusters).toEqual([
    ["src/auth/login.ts", "src/auth/token.ts"],
    ["src/billing/invoice.ts", "src/billing/ledger.ts"],
  ]);
  // Files that rarely ship together stay apart: 1 co-change out of 6 commits
  // touching either is far below the exported threshold.
  const weak = [
    ...Array.from({ length: 3 }, (_, i) => commit(`a${i}`, "a", ["a.ts"])),
    ...Array.from({ length: 3 }, (_, i) => commit(`b${i}`, "b", ["b.ts"])),
    commit("ab", "both", ["a.ts", "b.ts"]),
  ];
  expect(clusterPaths(weak)).toEqual([["a.ts"], ["b.ts"]]);
});

test("a repo-wide sweep contributes churn but no coupling, and is counted, never silent", () => {
  const wide = commit("w1", "format everything", Array.from({ length: WIDE_COMMIT_PATH_LIMIT + 1 }, (_, i) => `f${i}.ts`));
  const commits = [
    wide,
    commit("n1", "pair", ["src/a.ts", "src/b.ts"]),
    commit("n2", "pair again", ["src/a.ts", "src/b.ts"]),
  ];
  const territories = proposeTerritories(commits);
  expect(territories.wideCommits).toBe(1);
  expect(territories.candidates.length).toBe(1);
  expect(territories.candidates[0]!.paths).toEqual(["src/a.ts", "src/b.ts"]);
  // The sweep's churn still counts: its paths are remainder, each touched once.
  expect(territories.remainder.length).toBe(WIDE_COMMIT_PATH_LIMIT + 1);
  expect(churnByPath(commits).get("f0.ts")).toBe(1);
});

// --- surface detection (B-2, FR-002) ----------------------------------------

test("a Bun/TypeScript fixture is detected from its manifests (FR-002)", () => {
  const dir = freshDir("bun");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -b", test: "bun test" } }));
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, "bun.lock"), "");
  const report = detectSurfaces(dir);
  expect(report.language.value).toBe("typescript");
  expect(report.build.value).toBe("bun run build");
  expect(report.test.value).toBe("bun run test");
  expect(unknownSurfaces(report)).toEqual([]);
});

test("a Cargo fixture is detected from Cargo.toml alone (FR-002)", () => {
  const dir = freshDir("cargo");
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "fixture"\n`);
  const report = detectSurfaces(dir);
  expect(report.language.value).toBe("rust");
  expect(report.build.value).toBe("cargo build");
  expect(report.test.value).toBe("cargo test");
});

test("a fixture with both manifests reports both and chooses neither (FR-002)", () => {
  const dir = freshDir("both");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "bun test" } }));
  writeFileSync(join(dir, "bun.lock"), "");
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "fixture"\n`);
  const report = detectSurfaces(dir);
  for (const kind of ["language", "build", "test"] as const) {
    expect(report[kind].value).toBeNull();
    expect(report[kind].candidates.length).toBe(2);
    for (const candidate of report[kind].candidates) {
      expect(candidate.unconfirmed).toContain("does not choose");
    }
  }
});

test("a fixture with no manifest evidence is unknown with empty candidates (FR-002)", () => {
  const report = detectSurfaces(freshDir("none"));
  expect(unknownSurfaces(report)).toEqual(["language", "build", "test"]);
  expect(report.language.candidates).toEqual([]);
  expect(report.build.candidates).toEqual([]);
  expect(report.test.candidates).toEqual([]);
});

test("a package.json without a lockfile reports the script but not a guessed runner (B-2)", () => {
  const dir = freshDir("nolock");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const report = detectSurfaces(dir);
  expect(report.build.value).toBeNull();
  expect(report.build.candidates.length).toBe(1);
  expect(report.build.candidates[0]!.unconfirmed).toContain("no lockfile names the package runner");
});

// --- the proposal (B-1, B-4, FR-003) ----------------------------------------

function surfacesOf(dir: string): SurfaceReport {
  return detectSurfaces(dir);
}

test("proposal serialization is deterministic and carries every candidate's evidence (FR-003)", () => {
  const dir = freshDir("det");
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "fixture"\n`);
  const build = (): string =>
    renderProposal(
      buildProposal({
        repoDir: "/fixed/target",
        headSha: "a".repeat(40),
        surfaces: surfacesOf(dir),
        history: { mode: "merges", requested: 200, commits: TWO_SUBSYSTEMS, shortfall: "the clone holds only 6 first-parent merge(s) of the 200 requested" },
      })
    );
  const first = build();
  expect(build()).toBe(first);
  expect(proposalHash(build())).toBe(proposalHash(first));

  // Every claim travels with its evidence: file sets, churn share, sample
  // commits, the shortfall, the exclusion floor, and the 036 wording.
  expect(first).toContain("src/auth/login.ts");
  expect(first).toContain("50.0% of churn");
  expect(first).toContain("auth: sessions");
  expect(first).toContain("only 6");
  expect(first).toContain("node_modules/ (vendored)");
  expect(first).toContain("spec 036's holdback replay");
  expect(first).toContain("does not claim this partition is correct");
});

test("the remainder is explicit in the document, with churn attached (B-4)", () => {
  const commits = [
    ...Array.from({ length: 2 }, (_, i) => commit(`h${i}`, `hot ${i}`, ["src/hot/a.ts", "src/hot/b.ts"])),
    commit("c1", "loner", ["docs/notes.md"]),
  ];
  const document = renderProposal(
    buildProposal({
      repoDir: "/fixed/target",
      headSha: "b".repeat(40),
      surfaces: surfacesOf(freshDir("rem")),
      history: { mode: "commits", requested: 200, commits, shortfall: null },
    })
  );
  expect(document).toContain("## Ungoverned remainder");
  expect(document).toContain("- docs/notes.md (touched 1x)");
  expect(document).toContain("D-1 fallback");
});

// --- the production git reader ----------------------------------------------

test("the production reader extracts first-parent merges with first-parent diffs", () => {
  const dir = repoWithMerge();
  const reader = createProcessPreflightGitReader();
  expect(reader.headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
  const merges = reader.firstParentLog(dir, 10, true)!;
  expect(merges.length).toBe(1);
  expect(merges[0]!.subject).toBe("merge feature (#1)");
  expect([...merges[0]!.paths].sort()).toEqual(["one.txt", "two.txt"]);
  // The same repo through the D-1 decision: merges mode wins.
  expect(extractHistory(reader, dir).mode).toBe("merges");
});

test("the production reader answers null outside a repository, read as empty history", () => {
  const dir = freshDir("norepo");
  const reader = createProcessPreflightGitReader();
  expect(reader.headSha(dir)).toBeNull();
  expect(reader.firstParentLog(dir, 10, false)).toBeNull();
  expect(extractHistory(reader, dir).mode).toBe("empty");
});

test("runPreflight over a real repo is read-only and byte-stable across runs (AC-2's core)", () => {
  const dir = repoWithMerge();
  const first = runPreflight({ repoDir: dir });
  const second = runPreflight({ repoDir: dir });
  expect(second.document).toBe(first.document);
  expect(second.contentHash).toBe(first.contentHash);
  expect(first.proposal.history.mode).toBe("merges");
});

// --- the journal record (B-6) -----------------------------------------------

test("journalPreflight appends the citable record: head, window used, content hash", () => {
  const stateRoot = freshDir("journal");
  const run = runPreflight({ repoDir: "/fixed/target", reader: fixtureReader(TWO_SUBSYSTEMS, []) });
  const handle = openJournal(stateRoot);
  try {
    const record = journalPreflight({ handle, project: "fixture", source: "cli", run, out: "/tmp/out.md" });
    expect(record.kind).toBe(PREFLIGHT_RECORD_KIND);
    const payload = record.payload as Record<string, unknown>;
    expect(payload.project).toBe("fixture");
    expect(payload.headSha).toBe("f".repeat(40));
    expect(payload.historyMode).toBe("merges");
    expect(payload.window).toEqual({ requested: DEFAULT_HISTORY_WINDOW, used: 6 });
    expect(payload.contentHash).toBe(run.contentHash);
  } finally {
    handle.close();
  }
  const verified = verifyChain(stateRoot);
  expect(verified.ok).toBe(true);
});

// --- the adoptable refusal (B-5) --------------------------------------------

function projectWith(qualified: boolean, adoptable: boolean): Project {
  return {
    name: "beta",
    repoDir: "/targets/beta",
    armed: true,
    qualification: {
      qualified,
      adoptable,
      checks: [
        { id: "git-repo", ok: true, detail: "git work tree root" },
        { id: "specs-present", ok: qualified, detail: qualified ? "1 spec(s)" : "specs/ is missing or holds no spec.md" },
      ],
      warnings: [],
      checkedAt: "2026-08-05T00:00:00.000Z",
    },
    profile: { mode: "bypass", legacy: true },
    ceiling: null,
    // 041 B-3: the fold always produces a gate, so a hand-built Project
    // carries one too. Legacy here, because this fixture stands in for a
    // registration that predates every later registry field.
    gate: { commands: [], source: null, rule: null, legacy: true },
  };
}

test("an adoptable project's dag reader refuses every structural read by name (B-5, AC-3)", () => {
  const reader = adoptableDagReader(projectWith(false, true));
  expect(reader).not.toBeNull();
  for (const call of [
    () => reader!.registryListJson("/targets/beta"),
    () => reader!.registryShowJson("/targets/beta", "001-x"),
    () => reader!.readSpecFile("/targets/beta", "001-x"),
  ]) {
    expect(call).toThrow(/adoptable, not governed/);
    expect(call).toThrow(/specs\/ is missing/);
    expect(call).toThrow(/adopt preflight/);
  }
});

test("a governed or merely-unqualified project is untouched by the refusal (FR-004)", () => {
  expect(adoptableDagReader(projectWith(true, false))).toBeNull();
  expect(adoptableDagReader(projectWith(false, false))).toBeNull();
});
