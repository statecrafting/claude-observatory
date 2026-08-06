import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, type JsonValue } from "../journal";
import type { SessionResult } from "../session";
import { buildProposal, renderProposal, proposalHash, type CommitChange, type SurfaceReport } from "./preflight";
import {
  CORPUS_SET,
  RETROACTIVE_RULES,
  claimedPaths,
  confinementViolations,
  createProcessSynthesisGate,
  createProcessSynthesisGit,
  draftShapeViolations,
  establishesViolations,
  parseProposalDocument,
  renderSynthesisReport,
  runSynthesis,
  scaffoldPrompt,
  synthesisBranchName,
  territoryPrompt,
  territorySpecId,
  type ParsedProposal,
  type SynthesisParams,
  type SynthesisReport,
  type SynthesisSessionRequest,
} from "./synthesis";

// --- fixtures ----------------------------------------------------------------

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `synthesis-test-${prefix}-`));
}

function gitFor(repoDir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoDir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
}

// A target repository with the territory files on disk and one commit, so the
// synthesized corpus's establishes edges point at real paths and the branch
// has a HEAD to grow from.
function fixtureTarget(): string {
  const dir = freshDir("target");
  gitFor(dir, ["init", "-q", "-b", "main"]);
  gitFor(dir, ["config", "user.email", "test@example.com"]);
  gitFor(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(join(dir, "src", "auth"), { recursive: true });
  fs.mkdirSync(join(dir, "src", "core"), { recursive: true });
  fs.mkdirSync(join(dir, "src", "util"), { recursive: true });
  for (const file of ["src/auth/login.ts", "src/auth/token.ts", "src/core/db.ts", "src/core/schema.ts", "src/util/helper.ts"]) {
    fs.writeFileSync(join(dir, file), "export {};\n");
  }
  gitFor(dir, ["add", "-A"]);
  gitFor(dir, ["commit", "-qm", "init"]);
  return dir;
}

const EMPTY_SURFACES: SurfaceReport = {
  language: { value: null, candidates: [] },
  build: { value: null, candidates: [] },
  test: { value: null, candidates: [] },
};

// Two clean territories (auth, core) and one loner that lands in the
// remainder, rendered by the real 034 renderer so the parser is tested
// against the exact document synthesis receives in production.
function fixtureProposalDocument(target: string): string {
  const commits: CommitChange[] = [
    { sha: "c4c4c4c4c4c4", subject: "auth round 2", paths: ["src/auth/login.ts", "src/auth/token.ts"] },
    { sha: "c3c3c3c3c3c3", subject: "auth round 1", paths: ["src/auth/login.ts", "src/auth/token.ts"] },
    { sha: "c2c2c2c2c2c2", subject: "core round 2", paths: ["src/core/db.ts", "src/core/schema.ts"] },
    { sha: "c1c1c1c1c1c1", subject: "core round 1", paths: ["src/core/db.ts", "src/core/schema.ts"] },
    { sha: "c0c0c0c0c0c0", subject: "loner", paths: ["src/util/helper.ts"] },
  ];
  const proposal = buildProposal({
    repoDir: target,
    headSha: "abcabcabcabc",
    surfaces: EMPTY_SURFACES,
    history: { mode: "commits", requested: 200, commits, shortfall: null },
  });
  return renderProposal(proposal);
}

function completedSession(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    classification: { kind: "completed", resetAtMs: null, detail: "ok" },
    exitCode: 0,
    durationMs: 5,
    numTurns: 3,
    costMicroUsd: 100_000,
    usage: null,
    sessionId: "s-fixture",
    transcriptPath: null,
    overflow: { lines: [], truncatedCount: 0 },
    stderrTail: "",
    ...overrides,
  };
}

function writeDraftSpec(repoDir: string, specId: string, title: string, paths: readonly string[], overrides: { status?: string; retroactive?: boolean; body?: string } = {}): void {
  const establishes = paths.map((path) => `  - { kind: file, path: "${path}" }`).join("\n");
  const origin = overrides.retroactive === false ? "" : "origin:\n  retroactive: true\n";
  fs.mkdirSync(join(repoDir, "specs", specId), { recursive: true });
  fs.writeFileSync(
    join(repoDir, "specs", specId, "spec.md"),
    `---\nid: "${specId}"\ntitle: "${title}"\nstatus: ${overrides.status ?? "draft"}\ncreated: "2026-08-06"\nsummary: >\n  ${title}, recorded as found.\n${origin}establishes:\n${establishes}\n---\n\n# ${specId}\n\n${overrides.body ?? "Records the territory as found.\n\n## Known defects\n\nNone found during adoption."}\n`
  );
}

// The scripted scaffold: what a real session would leave behind, without a
// model anywhere near the test (FR-003).
function scriptedScaffold(repoDir: string): void {
  const init = Bun.spawnSync(["spec-spine", "init"], { cwd: repoDir });
  if (init.exitCode !== 0) throw new Error(`spec-spine init failed: ${new TextDecoder().decode(init.stderr)}`);
  // The scaffold prompt's step 2: the two ignores every governed target needs.
  fs.appendFileSync(join(repoDir, ".gitignore"), "/data/\n.derived/**/build-meta.json\n");
  writeDraftSpec(repoDir, "000-bootstrap", "Bootstrap, recorded as found", []);
}

interface Harness {
  readonly target: string;
  readonly stateRoot: string;
  readonly document: string;
  readonly requests: SynthesisSessionRequest[];
  run(overrides?: Partial<SynthesisParams>, script?: (request: SynthesisSessionRequest) => SessionResult | Promise<SessionResult>): Promise<SynthesisReport>;
  records(): { readonly kind: string; readonly payload: JsonValue }[];
}

// One harness per test: a real target, a real journal, real git seams, the
// real spec-spine gate, and a scripted session that authors a conforming
// corpus unless the test scripts otherwise.
function makeHarness(): Harness {
  const target = fixtureTarget();
  const stateRoot = freshDir("state");
  const document = fixtureProposalDocument(target);
  const requests: SynthesisSessionRequest[] = [];

  const defaultScript = (request: SynthesisSessionRequest): SessionResult => {
    if (request.purpose === "scaffold") {
      scriptedScaffold(target);
    } else if (request.purpose === "001-src-auth") {
      writeDraftSpec(target, request.purpose, "Auth territory", ["src/auth/login.ts", "src/auth/token.ts"]);
    } else if (request.purpose === "002-src-core") {
      writeDraftSpec(target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
    }
    return completedSession();
  };

  return {
    target,
    stateRoot,
    document,
    requests,
    async run(overrides = {}, script = defaultScript) {
      const journal = openJournal(stateRoot);
      try {
        return await runSynthesis({
          projectName: "adoptee",
          proposalDocument: document,
          journal,
          session: async (request) => {
            requests.push(request);
            return script(request);
          },
          git: createProcessSynthesisGit(target),
          gate: createProcessSynthesisGate(target),
          clock: { now: () => Date.now() },
          source: "test",
          ceiling: null,
          ...overrides,
        });
      } finally {
        journal.close();
      }
    },
    records() {
      const journal = openJournal(stateRoot);
      try {
        return journal.fold().records.map((record) => ({ kind: record.kind, payload: record.payload }));
      } finally {
        journal.close();
      }
    },
  };
}

// --- the corpus set (FR-002, D-2) --------------------------------------------

test("the corpus set is exactly the init scaffold plus derived artifacts and the ignore file (D-2, D-4)", () => {
  expect(CORPUS_SET).toEqual([
    { kind: "dir", path: "specs" },
    { kind: "file", path: "spec-spine.toml" },
    { kind: "dir", path: "standards" },
    { kind: "dir", path: ".derived" },
    { kind: "dir", path: ".claude/rules" },
    { kind: "file", path: ".gitignore" },
  ]);
});

test("confinement: corpus paths pass and everything else fails with the path named (FR-002)", () => {
  const allowed = [
    "specs/001-auth/spec.md",
    "spec-spine.toml",
    "standards/spec/contract.md",
    ".derived/spec-registry/by-spec/001-auth.json",
    ".claude/rules/orchestrator-rules.md",
    ".gitignore",
  ];
  expect(confinementViolations(allowed)).toEqual([]);

  // A source file, a test file, and a dotfile outside the corpus, each named.
  const offending = ["src/index.ts", "test/index.test.ts", ".github/workflows/ci.yml", "README.md"];
  expect(confinementViolations([...allowed, ...offending])).toEqual([...offending].sort());

  // A file that merely shares a prefix with a corpus rule is not inside it.
  expect(confinementViolations(["specs.md", "spec-spine.toml.bak", "standards-notes.md"])).toEqual(
    ["spec-spine.toml.bak", "specs.md", "standards-notes.md"]
  );
});

// --- reading the proposal back -----------------------------------------------

test("the parser reads territories and remainder back from the real 034 renderer", () => {
  const target = fixtureTarget();
  try {
    const document = fixtureProposalDocument(target);
    const parsed = parseProposalDocument(document);
    expect(typeof parsed).not.toBe("string");
    const proposal = parsed as ParsedProposal;
    expect(proposal.target).toBe(target);
    expect(proposal.headSha).toBe("abcabcabcabc");
    expect(proposal.territories).toHaveLength(2);
    expect(proposal.territories[0]).toEqual({ index: 1, label: "src/auth/", files: ["src/auth/login.ts", "src/auth/token.ts"] });
    expect(proposal.territories[1]).toEqual({ index: 2, label: "src/core/", files: ["src/core/db.ts", "src/core/schema.ts"] });
    expect(proposal.remainder).toEqual(["src/util/helper.ts"]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a document that is not a proposal, and a proposal with nothing to synthesize, both refuse with the reason", () => {
  expect(parseProposalDocument("# release notes\n")).toContain("not a preflight proposal");
  const empty = renderProposal(
    buildProposal({
      repoDir: "/tmp/empty",
      headSha: null,
      surfaces: EMPTY_SURFACES,
      history: { mode: "empty", requested: 200, commits: [], shortfall: null },
    })
  );
  expect(parseProposalDocument(empty)).toContain("no candidate territories");
});

// --- ids and prompts (FR-001) ------------------------------------------------

test("spec ids are churn-ranked, zero-padded, and slugged from the territory label", () => {
  expect(territorySpecId(1, "src/auth")).toBe("001-src-auth");
  expect(territorySpecId(12, "Web / UI")).toBe("012-web-ui");
  expect(territorySpecId(3, "///")).toBe("003-territory");
});

test("prompt assembly is pure and carries the file list, the retroactive posture, and the draft requirement (FR-001)", () => {
  const proposal: ParsedProposal = {
    target: "/repo/x",
    headSha: "abc",
    territories: [{ index: 1, label: "src/auth", files: ["src/auth/login.ts", "src/auth/token.ts"] }],
    remainder: [],
  };
  const territory = proposal.territories[0]!;
  const prompt = territoryPrompt(proposal, territory, "001-src-auth");

  for (const file of territory.files) expect(prompt).toContain(file);
  expect(prompt).toContain("status: draft");
  expect(prompt).toContain("origin.retroactive: true");
  expect(prompt).toContain("## Known defects");
  expect(prompt).toContain("record what the code does, never what it should do");
  expect(prompt).toContain("do not fix it");
  expect(prompt).toContain('id "001-src-auth"');
  // Pure: same inputs, byte-identical prompt.
  expect(territoryPrompt(proposal, territory, "001-src-auth")).toBe(prompt);

  const scaffold = scaffoldPrompt(proposal);
  expect(scaffold).toContain("spec-spine init");
  expect(scaffold).toContain("status: draft");
  for (const rule of RETROACTIVE_RULES) expect(scaffold).toContain(rule);
});

// --- the draft-born guard (B-3) ----------------------------------------------

test("the shape guard reports approved status, a missing retroactive marker, and no frontmatter, all at once", () => {
  const violations = draftShapeViolations([
    { path: "specs/001-a/spec.md", content: `---\nstatus: draft\norigin:\n  retroactive: true\n---\nbody` },
    { path: "specs/002-b/spec.md", content: `---\nstatus: approved\norigin:\n  retroactive: true\n---\nbody` },
    { path: "specs/003-c/spec.md", content: `---\nstatus: draft\n---\nbody` },
    { path: "specs/004-d/spec.md", content: `no frontmatter at all` },
  ]);
  expect(violations.map((violation) => violation.path)).toEqual([
    "specs/002-b/spec.md",
    "specs/003-c/spec.md",
    "specs/004-d/spec.md",
  ]);
  expect(violations[0]!.reason).toContain('"approved"');
  expect(violations[1]!.reason).toContain("origin.retroactive");
});

test("a territory spec must enumerate its whole file list in establishes (B-3)", () => {
  const spec = {
    path: "specs/001-a/spec.md",
    content: `---\nstatus: draft\nestablishes:\n  - { kind: file, path: "src/auth/login.ts" }\n---\nbody`,
  };
  expect(establishesViolations(spec, ["src/auth/login.ts"])).toEqual([]);
  const missing = establishesViolations(spec, ["src/auth/login.ts", "src/auth/token.ts"]);
  expect(missing).toHaveLength(1);
  expect(missing[0]!.reason).toContain("src/auth/token.ts");
});

test("claimed paths are read from both establishes forms", () => {
  const claimed = claimedPaths([
    {
      path: "specs/001-a/spec.md",
      content: `---\nestablishes:\n  - { kind: file, path: "src/a.ts" }\n  - "src/b.ts"\n---\nbody`,
    },
  ]);
  expect(claimed.get("specs/001-a/spec.md")).toEqual(["src/a.ts", "src/b.ts"]);
});

// --- the end-to-end fixture run (FR-003) -------------------------------------

test("scripted sessions produce a compiling draft corpus on a provenance-named branch, journaled (FR-003)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run();

    expect(report.outcome).toBe("completed");
    expect(report.failure).toBeNull();
    const hash = proposalHash(harness.document);
    expect(report.proposalHash).toBe(hash);
    expect(report.branch).toBe(synthesisBranchName(hash));
    expect(report.territories.map((territory) => [territory.specId, territory.outcome])).toEqual([
      ["001-src-auth", "authored"],
      ["002-src-core", "authored"],
    ]);
    // The remainder is carried forward, never silently absorbed (B-5).
    expect(report.unclaimed).toEqual(["src/util/helper.ts"]);
    expect(report.sessions.map((session) => session.purpose)).toEqual(["scaffold", "001-src-auth", "002-src-core"]);
    expect(report.gate.compile?.exitCode).toBe(0);
    expect(report.gate.lint?.exitCode).toBe(0);

    // The branch is real, checked out, and carries one commit per passing
    // session plus the derived artifacts (D-3, D-5).
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: harness.target });
    expect(new TextDecoder().decode(branch.stdout).trim()).toBe(report.branch!);
    const log = Bun.spawnSync(["git", "log", "--format=%s", "main..HEAD"], { cwd: harness.target });
    expect(new TextDecoder().decode(log.stdout).trim().split("\n")).toEqual([
      "synthesis: derived artifacts",
      "synthesis: 002-src-core",
      "synthesis: 001-src-auth",
      "synthesis: scaffold",
    ]);

    // The corpus on the branch compiles under the real gate, drafts included.
    const compile = Bun.spawnSync(["spec-spine", "compile", "--repo", harness.target]);
    expect(compile.exitCode).toBe(0);

    // The journal carries the proposal hash, the per-session costs, and the
    // report (FR-003).
    const kinds = harness.records().map((record) => record.kind);
    expect(kinds).toEqual([
      "adopt.synthesis.started",
      "adopt.synthesis.session",
      "adopt.synthesis.session",
      "adopt.synthesis.session",
      "adopt.synthesis",
    ]);
    const started = harness.records()[0]!.payload as Record<string, JsonValue>;
    expect(started.proposalHash).toBe(hash);
    expect(started.branch).toBe(report.branch);
    const sessionRecord = harness.records()[1]!.payload as Record<string, JsonValue>;
    expect(sessionRecord.costMicroUsd).toBe(100_000);
    const result = harness.records()[4]!.payload as Record<string, JsonValue>;
    expect(result.outcome).toBe("completed");

    // Every prompt the sessions received carried the posture (FR-001 wiring).
    expect(harness.requests).toHaveLength(3);
    for (const request of harness.requests) expect(request.prompt).toContain("status: draft");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

// --- the guard, end to end (FR-004) ------------------------------------------

test("a session that writes status: approved is failed, journaled, and its writes discarded (FR-004)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run({}, (request) => {
      if (request.purpose === "scaffold") scriptedScaffold(harness.target);
      if (request.purpose === "001-src-auth") {
        writeDraftSpec(harness.target, request.purpose, "Auth, blessed", ["src/auth/login.ts", "src/auth/token.ts"], { status: "approved" });
      }
      if (request.purpose === "002-src-core") {
        writeDraftSpec(harness.target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
      }
      return completedSession();
    });

    expect(report.outcome).toBe("failed");
    const auth = report.territories.find((territory) => territory.specId === "001-src-auth")!;
    expect(auth.outcome).toBe("guard-failed");
    expect(auth.detail).toContain('"approved"');
    // The violating spec never landed on the branch (D-5), and the other
    // territory still ran and passed (D-6).
    expect(fs.existsSync(join(harness.target, "specs", "001-src-auth"))).toBe(false);
    expect(report.territories.find((territory) => territory.specId === "002-src-core")!.outcome).toBe("authored");

    const violations = harness.records().filter((record) => record.kind === "adopt.synthesis.violation");
    expect(violations).toHaveLength(1);
    expect(JSON.stringify(violations[0]!.payload)).toContain("approved");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

test("a session that omits the retroactive marker is failed with the reason journaled (FR-004)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run({}, (request) => {
      if (request.purpose === "scaffold") scriptedScaffold(harness.target);
      if (request.purpose === "001-src-auth") {
        writeDraftSpec(harness.target, request.purpose, "Auth", ["src/auth/login.ts", "src/auth/token.ts"], { retroactive: false });
      }
      if (request.purpose === "002-src-core") {
        writeDraftSpec(harness.target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
      }
      return completedSession();
    });

    expect(report.outcome).toBe("failed");
    const auth = report.territories.find((territory) => territory.specId === "001-src-auth")!;
    expect(auth.outcome).toBe("guard-failed");
    expect(auth.detail).toContain("origin.retroactive");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

test("a session that edits target source is failed by confinement with the path named (FR-004, B-3)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run({}, (request) => {
      if (request.purpose === "scaffold") scriptedScaffold(harness.target);
      if (request.purpose === "001-src-auth") {
        writeDraftSpec(harness.target, request.purpose, "Auth", ["src/auth/login.ts", "src/auth/token.ts"]);
        // The tempting case (037 B-3): the session found a bug and fixed it.
        fs.appendFileSync(join(harness.target, "src/auth/login.ts"), "// fixed a bug\n");
      }
      if (request.purpose === "002-src-core") {
        writeDraftSpec(harness.target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
      }
      return completedSession();
    });

    expect(report.outcome).toBe("failed");
    const auth = report.territories.find((territory) => territory.specId === "001-src-auth")!;
    expect(auth.outcome).toBe("guard-failed");
    expect(auth.detail).toContain("outside the corpus set: src/auth/login.ts");
    // The fix was discarded: record, never fix (B-3).
    expect(fs.readFileSync(join(harness.target, "src/auth/login.ts"), "utf8")).toBe("export {};\n");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

test("the 037 checker seam is invoked after every session and its violations journal verbatim (037 FR-002)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run({
      shapeChecker: ({ specs }) =>
        specs
          .filter((spec) => !spec.content.includes("## Known defects"))
          .map((spec) => ({ path: spec.path, reason: "no Known defects section (037 B-1)" })),
    }, (request) => {
      if (request.purpose === "scaffold") scriptedScaffold(harness.target);
      if (request.purpose === "001-src-auth") {
        writeDraftSpec(harness.target, request.purpose, "Auth", ["src/auth/login.ts", "src/auth/token.ts"], {
          body: "No defects section here.",
        });
      }
      if (request.purpose === "002-src-core") {
        writeDraftSpec(harness.target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
      }
      return completedSession();
    });

    expect(report.outcome).toBe("failed");
    const auth = report.territories.find((territory) => territory.specId === "001-src-auth")!;
    expect(auth.outcome).toBe("guard-failed");
    expect(auth.detail).toContain("no Known defects section (037 B-1)");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

// --- sessions that die, ceilings, and refusals --------------------------------

test("a territory whose session dies is recorded and the remaining territories still run (D-1, D-6)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run({}, (request) => {
      if (request.purpose === "scaffold") scriptedScaffold(harness.target);
      if (request.purpose === "001-src-auth") {
        return completedSession({ classification: { kind: "max-turns", resetAtMs: null, detail: "error_max_turns" } });
      }
      if (request.purpose === "002-src-core") {
        writeDraftSpec(harness.target, request.purpose, "Core territory", ["src/core/db.ts", "src/core/schema.ts"]);
      }
      return completedSession();
    });

    expect(report.outcome).toBe("failed");
    expect(report.territories.map((territory) => [territory.specId, territory.outcome])).toEqual([
      ["001-src-auth", "session-failed"],
      ["002-src-core", "authored"],
    ]);
    expect(report.failure).toContain("not a success");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

test("the per-invocation ceiling stops the next spawn, journaled (033 B-2, D-7)", async () => {
  const harness = makeHarness();
  try {
    // Scaffold and the first territory cost 100k each; the ceiling of 150k is
    // crossed before the second territory's spawn boundary.
    const report = await harness.run({ ceiling: { perRunMicroUsd: 150_000 } });

    expect(report.outcome).toBe("failed");
    expect(report.territories.map((territory) => [territory.specId, territory.outcome])).toEqual([
      ["001-src-auth", "authored"],
      ["002-src-core", "not-run"],
    ]);
    expect(report.territories[1]!.detail!).toContain("cost ceiling (run)");
    // Only two sessions ever spawned.
    expect(report.sessions.map((session) => session.purpose)).toEqual(["scaffold", "001-src-auth"]);
    const violations = harness.records().filter((record) => record.kind === "adopt.synthesis.violation");
    expect(violations).toHaveLength(1);
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

test("a dirty target tree refuses before any branch or session exists", async () => {
  const harness = makeHarness();
  try {
    fs.appendFileSync(join(harness.target, "src/util/helper.ts"), "// uncommitted\n");
    const report = await harness.run();
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("dirty");
    expect(report.branch).toBeNull();
    expect(harness.requests).toHaveLength(0);
    expect(report.territories.every((territory) => territory.outcome === "not-run")).toBe(true);
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});

// --- the rendered report (B-5) ------------------------------------------------

test("the rendered report names territories, claims, the remainder, sessions, and costs (B-5)", async () => {
  const harness = makeHarness();
  try {
    const report = await harness.run();
    const lines = renderSynthesisReport(report).join("\n");
    expect(lines).toContain("synthesis: completed");
    expect(lines).toContain(`branch:   ${report.branch}`);
    expect(lines).toContain("001-src-auth  authored  2 claimed");
    expect(lines).toContain("002-src-core  authored  2 claimed");
    expect(lines).toContain("unclaimed: 1 path(s)");
    expect(lines).toContain("src/util/helper.ts");
    expect(lines).toContain("sessions: 3, known cost 0.30 USD");
  } finally {
    fs.rmSync(harness.target, { recursive: true, force: true });
    fs.rmSync(harness.stateRoot, { recursive: true, force: true });
  }
});
