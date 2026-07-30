import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "../journal";
import { openDecisionsChain } from "../decisions";
import type { SessionResult } from "../session";
import {
  runBuildStage,
  createProcessRunner,
  buildPrompt,
  flipImplementation,
  readImplementationStatus,
  parseFrontmatterListField,
  extractBacklogStep,
  BUILD_PROMPT_VERSION,
  GATE_COMMANDS,
  type Runner,
  type RunnerSessionOptions,
} from "./build";

// --- fixture repo -----------------------------------------------------------

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function gitIsClean(dir: string): boolean {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir });
  return new TextDecoder().decode(result.stdout).trim().length === 0;
}

const AGENTS_MD_FIXTURE = `# AGENTS.md

## Working the backlog

1. Pick the next spec.
2. Flip its frontmatter to in-progress.
3. Implement exactly that spec's territory.
4. Run the gate.
5. Flip to complete.

## Conventions

Not part of the backlog step.
`;

function specFixture(specId: string, implementation: string): string {
  return `---
id: "${specId}"
title: "Fixture spec"
status: approved
kind: stage
implementation: ${implementation}
depends_on: []
establishes:
  - "src/example.ts"
---

# ${specId}: Fixture

Fixture spec body for build stage tests.
`;
}

function initFixtureRepo(specId = "900-fixture-spec"): { dir: string; specId: string } {
  const dir = mkdtempSync(join(tmpdir(), "build-stage-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  mkdirSync(join(dir, "specs", specId), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(join(dir, "AGENTS.md"), AGENTS_MD_FIXTURE);
  writeFileSync(join(dir, "specs", specId, "spec.md"), specFixture(specId, "pending"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: fixture base"]);

  return { dir, specId };
}

function greenGate(): Runner["runGate"] {
  return () => ({ exitCode: 0, stdoutTail: "", stderrTail: "" });
}

function fakeSessionResult(sessionId: string, overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    classification: { kind: "completed", resetAtMs: null, detail: "fake" },
    exitCode: 0,
    durationMs: 5,
    numTurns: 3,
    costMicroUsd: 1200,
    usage: null,
    sessionId,
    transcriptPath: null,
    overflow: { lines: [], truncatedCount: 0 },
    stderrTail: "",
    ...overrides,
  };
}

// A fake session that stands in for a real `claude` run (per spec 014's own
// "never spawn the real claude in tests" convention): it performs the same
// filesystem/git actions a real session would (write the fixture's one
// established file, flip the spec's frontmatter to complete, commit), then
// returns a completed SessionResult.
function fakeWritingSession(dir: string, specId: string): Runner["runSession"] {
  let calls = 0;
  return async (_options: RunnerSessionOptions) => {
    calls++;
    writeFileSync(join(dir, "src", "example.ts"), "export const example = 1;\n");
    const specPath = join(dir, "specs", specId, "spec.md");
    const content = readFileSync(specPath, "utf8");
    writeFileSync(specPath, content.replace("implementation: in-progress", "implementation: complete"));
    git(dir, ["add", "-A"]);
    // A remediation session may find nothing new to write (the fixture's
    // work was already complete after the first session): skip the commit
    // rather than fail on git's own "nothing to commit".
    if (!gitIsClean(dir)) git(dir, ["commit", "-q", "-m", `session commit ${calls}`]);
    return fakeSessionResult(`fake-session-${calls}`);
  };
}

// The journal/decisions chain live in their own temp directory, never
// inside the fixture git repo itself: journal.jsonl, anchor.json, and the
// lock file would otherwise show up as untracked files and trip the B-1
// dirty-tree preflight on every test.
function openHandles(_dir: string): { journalDir: string } {
  const journalDir = mkdtempSync(join(tmpdir(), "build-stage-journal-"));
  return { journalDir };
}

// --- pure helpers ------------------------------------------------------------

test("readImplementationStatus reads the top-level implementation field", () => {
  expect(readImplementationStatus(specFixture("x", "pending"))).toBe("pending");
});

test("flipImplementation rewrites from -> to and reports changed: true", () => {
  const result = flipImplementation(specFixture("x", "pending"), "pending", "in-progress");
  expect(result.changed).toBe(true);
  expect(readImplementationStatus(result.content)).toBe("in-progress");
});

test("flipImplementation is a no-op (changed: false) when already at the target status", () => {
  const content = specFixture("x", "in-progress");
  const result = flipImplementation(content, "pending", "in-progress");
  expect(result.changed).toBe(false);
  expect(result.content).toBe(content);
});

test("flipImplementation throws when the current status is neither from nor to", () => {
  const content = specFixture("x", "deferred");
  expect(() => flipImplementation(content, "pending", "in-progress")).toThrow(/expected "implementation: pending"/);
});

test("parseFrontmatterListField parses depends_on and establishes list items", () => {
  const md = specFixture("x", "pending").replace(
    "depends_on: []",
    'depends_on:\n  - "010-a"\n  - "011-b"'
  );
  expect(parseFrontmatterListField(md, "depends_on")).toEqual(["010-a", "011-b"]);
  expect(parseFrontmatterListField(md, "establishes")).toEqual(["src/example.ts"]);
});

test("parseFrontmatterListField returns an empty array when the field is absent", () => {
  expect(parseFrontmatterListField("no frontmatter here", "depends_on")).toEqual([]);
});

test("extractBacklogStep returns the Working the backlog section verbatim, stopping at the next heading", () => {
  const step = extractBacklogStep(AGENTS_MD_FIXTURE);
  expect(step).toContain("1. Pick the next spec.");
  expect(step).toContain("5. Flip to complete.");
  expect(step).not.toContain("Not part of the backlog step.");
});

test("extractBacklogStep falls back to a built-in summary when AGENTS.md has no such heading", () => {
  const step = extractBacklogStep("# AGENTS.md\n\nsomething else entirely\n");
  expect(step.length).toBeGreaterThan(0);
  expect(step).toContain("Implement exactly this spec's territory");
});

// --- prompt template (B-3) ----------------------------------------------------

test("buildPrompt embeds the spec body, backlog step, gate commands, drop-box path, and the house style rules", () => {
  const prompt = buildPrompt({
    specBody: "SPEC BODY MARKER",
    backlogStep: "BACKLOG STEP MARKER",
    decisions: { included: [], overflowCount: 0 },
    dropboxDir: "/tmp/dropbox-marker",
  });
  expect(prompt).toContain("SPEC BODY MARKER");
  expect(prompt).toContain("BACKLOG STEP MARKER");
  expect(prompt).toContain("/tmp/dropbox-marker");
  expect(prompt).toContain(`version: ${BUILD_PROMPT_VERSION}`);
  for (const cmd of GATE_COMMANDS) {
    expect(prompt).toContain(cmd.join(" "));
  }
  expect(prompt).toContain("No em dashes");
  expect(prompt).toContain("No AI attribution");
  // The template itself must never contain the character it forbids.
  expect(prompt.indexOf(String.fromCharCode(0x2014))).toBe(-1);
});

test("buildPrompt lists included decisions and states the overflow count, never silently dropping either", () => {
  const prompt = buildPrompt({
    specBody: "body",
    backlogStep: "step",
    decisions: {
      included: [
        { id: "d-1", specId: "900-x", scope: ["900-x"], title: "Use X", decision: "We use X", rationale: "because" },
      ],
      overflowCount: 2,
    },
    dropboxDir: "/tmp/dropbox",
  });
  expect(prompt).toContain("d-1 (900-x): Use X: We use X");
  expect(prompt).toContain("2 older decision(s) omitted");
});

// --- createProcessRunner (production seam) -----------------------------------

test("createProcessRunner: statusClean/currentBranch/headSha reflect real git state", () => {
  const { dir } = initFixtureRepo();
  const runner = createProcessRunner({ repoDir: dir });
  expect(runner.statusClean()).toBe(true);
  expect(runner.currentBranch()).toBe("main");
  expect(runner.headSha()).toMatch(/^[0-9a-f]{40}$/);
});

test("createProcessRunner: readFile/writeFile round-trip relative to repoDir", () => {
  const { dir, specId } = initFixtureRepo();
  const runner = createProcessRunner({ repoDir: dir });
  const path = `specs/${specId}/spec.md`;
  const content = runner.readFile(path);
  expect(content).toContain(`id: "${specId}"`);
  runner.writeFile(path, content.replace("implementation: pending", "implementation: in-progress"));
  expect(runner.readFile(path)).toContain("implementation: in-progress");
});

test("createProcessRunner: createBranch is idempotent, reusing an existing branch on the second call", () => {
  const { dir } = initFixtureRepo();
  const runner = createProcessRunner({ repoDir: dir });
  expect(runner.createBranch("feature-x")).toBe(false);
  runner.checkout("main");
  expect(runner.createBranch("feature-x")).toBe(true);
});

test("createProcessRunner: runGate runs a real subprocess and bounds its tails", () => {
  const { dir } = initFixtureRepo();
  const runner = createProcessRunner({ repoDir: dir });
  const result = runner.runGate(["git", "status", "--porcelain"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdoutTail).toBe("");
});

// --- B-1: preflight refusals --------------------------------------------------

test("B-1: refuses with dirty-tree when the target repo's working tree is not clean", async () => {
  const { dir, specId } = initFixtureRepo();
  writeFileSync(join(dir, "untracked.txt"), "dirty");
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runGate: greenGate() };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("refused");
  expect(result.evidence.refusal?.kind).toBe("dirty-tree");
  expect(result.evidence.branch).toBeNull();

  journal.close();
  decisionsChain.close();
});

test("B-1: refuses with wrong-branch when normalization to the default branch fails", async () => {
  const { dir, specId } = initFixtureRepo();
  git(dir, ["checkout", "-q", "-b", "some-other-branch"]);
  // The default branch named to the stage does not exist in this repo, so
  // the clean-tree normalization (checkout + ff pull) cannot succeed and
  // the honest refusal remains.
  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runGate: greenGate(),
    checkout: (branch: string) => {
      throw new Error(`fixture: cannot checkout ${branch}`);
    },
  };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("refused");
  expect(result.evidence.refusal?.kind).toBe("wrong-branch");

  journal.close();
  decisionsChain.close();
});

test("B-1: refuses with gate-red-at-base when a gate command is red before starting", async () => {
  const { dir, specId } = initFixtureRepo();
  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runGate: () => ({ exitCode: 1, stdoutTail: "", stderrTail: "boom: lint red at base" }),
  };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("refused");
  expect(result.evidence.refusal?.kind).toBe("gate-red-at-base");
  expect(result.evidence.refusal?.message).toContain("boom: lint red at base");

  journal.close();
  decisionsChain.close();
});

test("B-1: refuses with spec-not-ready when the injected readiness predicate says no", async () => {
  const { dir, specId } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runGate: greenGate() };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => false,
  });

  expect(result.outcome).toBe("refused");
  expect(result.evidence.refusal?.kind).toBe("spec-not-ready");

  journal.close();
  decisionsChain.close();
});

// --- AC-2: full fixture flow --------------------------------------------------

test("AC-2: passed with complete evidence when the session writes the file and flips frontmatter", async () => {
  const { dir, specId } = initFixtureRepo();
  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runGate: greenGate(),
    runSession: fakeWritingSession(dir, specId),
  };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);
  const dropboxDir = join(journalDir, "decision-dropbox");

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir,
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.branch).toBe(specId);
  expect(result.evidence.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(result.evidence.promptVersion).toBe(BUILD_PROMPT_VERSION);
  expect(result.evidence.frontmatterComplete).toBe(true);
  expect(result.evidence.sessions.length).toBe(1);
  expect(result.evidence.gates.length).toBe(GATE_COMMANDS.length);
  expect(result.evidence.gates.every((g) => g.exitCode === 0)).toBe(true);
  expect(result.evidence.decisions).not.toBeNull();
  expect(result.evidence.refusal).toBeNull();

  // Reflects the real branch actually created by the production Runner.
  expect(runner.currentBranch()).toBe(specId);

  journal.close();
  decisionsChain.close();
});

test("AC-2: a failing lint after the session triggers one remediation, then fails with the lint tail in evidence", async () => {
  const { dir, specId } = initFixtureRepo();
  const state = { sessionCalls: 0 };
  const runSession: Runner["runSession"] = async (opts) => {
    state.sessionCalls++;
    return fakeWritingSession(dir, specId)(opts);
  };
  const runGate: Runner["runGate"] = (cmd) => {
    // Green before any session has run (preflight + the B-2 compile check);
    // afterwards, lint alone stays red no matter how many sessions run, so
    // remediation is attempted once and then the stage fails honestly.
    if (state.sessionCalls === 0) return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    if (cmd.join(" ").includes("lint")) {
      return { exitCode: 1, stdoutTail: "", stderrTail: "lint: FR-001 style violation in src/example.ts" };
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runGate, runSession };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);
  const dropboxDir = join(journalDir, "decision-dropbox");

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir,
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.sessions.length).toBe(2);
  const lintEvidence = result.evidence.gates.find((g) => g.cmd.join(" ").includes("lint"));
  expect(lintEvidence?.exitCode).toBe(1);
  expect(lintEvidence?.stderrTail).toContain("FR-001 style violation");

  journal.close();
  decisionsChain.close();
});

// --- FR-003: reconcile ---------------------------------------------------------

test("FR-003: a branch that already exists from a crashed attempt is reused, not duplicated", async () => {
  const { dir, specId } = initFixtureRepo();

  // Simulate a crashed prior attempt: the branch already exists with the
  // frontmatter already flipped to in-progress, and we are back on main.
  git(dir, ["checkout", "-q", "-b", specId]);
  const specPath = join(dir, "specs", specId, "spec.md");
  writeFileSync(specPath, specFixture(specId, "in-progress"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "crashed attempt: flip to in-progress"]);
  git(dir, ["checkout", "-q", "main"]);

  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runGate: greenGate(),
    runSession: fakeWritingSession(dir, specId),
  };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.branch).toBe(specId);

  const bracketRecords = journal.fold().byKind["stage.build.bracket"];
  expect(bracketRecords?.length).toBe(1);
  expect((bracketRecords![0]!.payload as Record<string, unknown>).reused).toBe(true);
  // Already in-progress before the stage ran: the bracket itself makes no
  // further commit (flip.changed is false), so only the session's own
  // commit lands on top of the crashed attempt's commit.
  expect((bracketRecords![0]!.payload as Record<string, unknown>).flipped).toBe(false);

  journal.close();
  decisionsChain.close();
});

// --- B-4: hook-blocked classification maps to the blocked outcome -----------

test("B-4: a hook-blocked session classification maps the stage outcome to blocked", async () => {
  const { dir, specId } = initFixtureRepo();
  const runSession: Runner["runSession"] = async () =>
    fakeSessionResult("fake-blocked", {
      classification: { kind: "hook-blocked", resetAtMs: null, detail: "fake hook block" },
      exitCode: 2,
    });
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runGate: greenGate(), runSession };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("blocked");
  expect(result.evidence.sessions.length).toBe(1);
  expect(result.evidence.sessions[0]!.classification).toBe("hook-blocked");

  journal.close();
  decisionsChain.close();
});

// --- B-6: decision capture ----------------------------------------------------

test("B-6: decisions dropped in the drop-box during the session are sealed into stage evidence", async () => {
  const { dir, specId } = initFixtureRepo();
  const { journalDir } = openHandles(dir);
  const dropboxDir = join(journalDir, "decision-dropbox");

  const runSession: Runner["runSession"] = async (opts) => {
    mkdirSync(dropboxDir, { recursive: true });
    writeFileSync(
      join(dropboxDir, "d1.json"),
      JSON.stringify({ id: "d-1", specId, scope: [specId], title: "Use X", decision: "We use X", rationale: "r" })
    );
    return fakeWritingSession(dir, specId)(opts);
  };

  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runGate: greenGate(), runSession };
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir,
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.decisions?.sealed.map((d) => d.id)).toEqual(["d-1"]);
  expect(result.evidence.decisions?.invalid).toEqual([]);

  journal.close();
  decisionsChain.close();
});

test("flipImplementation: complete toward in-progress is a no-op (resume after a finished attempt)", () => {
  const spec = ["---", 'id: "900-fixture"', "implementation: complete", "---", "", "# body"].join("\n");
  const flip = flipImplementation(spec, "pending", "in-progress");
  expect(flip.changed).toBe(false);
  expect(flip.content).toBe(spec);
});

test("B-1 normalization: a clean tree on a stale feature branch checks out an updated default branch and proceeds (found live)", async () => {
  const gitOut = (d: string, args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd: d });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  const { dir: originDir, specId } = initFixtureRepo();

  // Clone the fixture so the local repo has a real upstream, leave the
  // clone on a leftover feature branch, then advance origin's main (the
  // previous spec's remote squash merge).
  const cloneParent = mkdtempSync(join(tmpdir(), "build-stage-clone-"));
  git(cloneParent, ["clone", "-q", originDir, "repo"]);
  const dir = join(cloneParent, "repo");
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  mkdirSync(join(dir, "src"), { recursive: true }); // empty dirs do not survive a clone
  git(dir, ["checkout", "-q", "-b", "leftover-previous-spec"]);
  writeFileSync(join(originDir, "advanced.txt"), "remote moved\n");
  git(originDir, ["add", "-A"]);
  git(originDir, ["commit", "-q", "-m", "chore: origin main advanced"]);
  const originHead = gitOut(originDir, ["rev-parse", "HEAD"]);

  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runGate: greenGate(),
    runSession: fakeWritingSession(dir, specId),
  };
  const { journalDir } = openHandles(dir);
  const journal = openJournal(journalDir);
  const decisionsChain = openDecisionsChain(journalDir);

  const result = await runBuildStage({
    runner,
    specId,
    journal,
    decisionsChain,
    dropboxDir: join(journalDir, "decision-dropbox"),
    knownSpecIds: new Set([specId]),
    isSpecReady: () => true,
  });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.refusal).toBeNull();
  // The spec branch was based on the fast-forwarded default branch, so the
  // advanced origin commit is in its history.
  const mergeBase = gitOut(dir, ["merge-base", specId, originHead]);
  expect(mergeBase).toBe(originHead);

  journal.close();
  decisionsChain.close();
});
