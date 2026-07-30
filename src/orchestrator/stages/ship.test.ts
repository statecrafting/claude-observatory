import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "../journal";
import { createProcessRunner, type Runner } from "./build";
import type { SessionResult } from "../session";
import {
  runShipStage,
  buildShipPrompt,
  SHIP_PROMPT_VERSION,
  createProcessGitHubClient,
  type GitHubClient,
  type GitHubPr,
  type GitHubCommit,
} from "./ship";

// --- fixture repo (real git, never a real `claude` or `gh`) -----------------

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function initFixtureRepo(branch = "900-fixture-ship"): { dir: string; branch: string; headSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "ship-stage-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: fixture base"]);
  git(dir, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: fixture feature"]);
  const headSha = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout).trim();
  return { dir, branch, headSha };
}

function openHandles(): { journalDir: string } {
  return { journalDir: mkdtempSync(join(tmpdir(), "ship-stage-journal-")) };
}

function fakeSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    classification: { kind: "completed", resetAtMs: null, detail: "fake" },
    exitCode: 0,
    durationMs: 5,
    numTurns: 3,
    costMicroUsd: 4200,
    usage: null,
    sessionId: "fake-ship-session",
    transcriptPath: null,
    overflow: { lines: [], truncatedCount: 0 },
    stderrTail: "",
    ...overrides,
  };
}

function cleanPr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    number: 42,
    url: "https://github.com/example/example/pull/42",
    headSha: "deadbeef",
    body: "## Summary\n\n- did the thing\n\n## Testing\n\n- bun test\n",
    title: "feat(ship): fixture feature",
    ...overrides,
  };
}

function cleanCommit(overrides: Partial<GitHubCommit> = {}): GitHubCommit {
  return { sha: "deadbeef", message: "feat: fixture feature", ...overrides };
}

interface FakeGhState {
  prForBranchCalls: number;
  commitsForPrCalls: number;
  checksTriggeredCalls: number;
}

function freshFakeGhState(): FakeGhState {
  return { prForBranchCalls: 0, commitsForPrCalls: 0, checksTriggeredCalls: 0 };
}

// A scripted fake GitHubClient (FR-001: no live `gh` in unit tests).
// `prSequence` answers successive `prForBranch` calls in order (the last
// entry repeats once exhausted), so a single fixture can express "no PR yet
// at the idempotency pre-check, a PR by the post-session check" without a
// stateful mock library.
function makeFakeGh(
  params: { prSequence: readonly (GitHubPr | null)[]; commits?: readonly GitHubCommit[]; ciTriggered?: boolean },
  state: FakeGhState
): GitHubClient {
  const commits = params.commits ?? [];
  const ciTriggered = params.ciTriggered ?? true;
  return {
    prForBranch(_branch: string): GitHubPr | null {
      const index = Math.min(state.prForBranchCalls, params.prSequence.length - 1);
      state.prForBranchCalls++;
      return params.prSequence[index] ?? null;
    },
    commitsForPr(_number: number): readonly GitHubCommit[] {
      state.commitsForPrCalls++;
      return commits;
    },
    checksTriggered(_headSha: string): boolean {
      state.checksTriggeredCalls++;
      return ciTriggered;
    },
    // --- shepherd extensions (spec 018): unused by this spec's own
    // scenarios, so these stubs exist only to satisfy the shared
    // GitHubClient shape (see specs/017-stage-ship/spec.md D-7).
    checkRunsForSha(_sha: string) {
      throw new Error("ship.test.ts: checkRunsForSha is a shepherd-stage seam, not exercised here");
    },
    jobLogTail(_runId: number, _maxBytes: number): string {
      throw new Error("ship.test.ts: jobLogTail is a shepherd-stage seam, not exercised here");
    },
    mergePr(_number: number, _method) {
      throw new Error("ship.test.ts: mergePr is a shepherd-stage seam, not exercised here");
    },
    branchContains(_branch: string, _sha: string): boolean {
      throw new Error("ship.test.ts: branchContains is a shepherd-stage seam, not exercised here");
    },
    deleteRemoteBranch(_branch: string): void {
      throw new Error("ship.test.ts: deleteRemoteBranch is a shepherd-stage seam, not exercised here");
    },
  };
}

// --- prompt template (B-1) ----------------------------------------------------

test("buildShipPrompt embeds the branch, the prompt version, and the house style rules", () => {
  const prompt = buildShipPrompt({ branch: "017-stage-ship" });
  expect(prompt).toContain("017-stage-ship");
  expect(prompt).toContain(`version: ${SHIP_PROMPT_VERSION}`);
  expect(prompt).toContain("/ship");
  expect(prompt).toContain("No session-link URLs");
  expect(prompt).toContain("No AI attribution");
  expect(prompt).toContain("No em dashes");
  // The template itself must never contain the character it forbids.
  expect(prompt.indexOf(String.fromCharCode(0x2014))).toBe(-1);
});

// --- createProcessGitHubClient (production seam, fake `gh` script only) -----

function writeFakeGhScript(dir: string, body: string): string {
  const path = join(dir, "fake-gh.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("createProcessGitHubClient: prForBranch parses gh pr view --json output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-gh-test-"));
  const script = writeFakeGhScript(
    dir,
    'echo \'{"number":7,"url":"https://github.com/example/example/pull/7","headRefOid":"abc123","body":"## Summary","title":"feat: x"}\''
  );
  const client = createProcessGitHubClient({ repoDir: dir, ghBin: script });
  expect(client.prForBranch("some-branch")).toEqual({
    number: 7,
    url: "https://github.com/example/example/pull/7",
    headSha: "abc123",
    body: "## Summary",
    title: "feat: x",
  });
});

test("createProcessGitHubClient: prForBranch returns null when gh exits non-zero (no PR for branch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-gh-test-"));
  const script = writeFakeGhScript(dir, ['echo "no pull requests found" 1>&2', "exit 1"].join("\n"));
  const client = createProcessGitHubClient({ repoDir: dir, ghBin: script });
  expect(client.prForBranch("some-branch")).toBeNull();
});

test("createProcessGitHubClient: commitsForPr joins the headline and body into one message", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-gh-test-"));
  const script = writeFakeGhScript(
    dir,
    'echo \'{"commits":[{"oid":"abc123","messageHeadline":"feat: x","messageBody":"detail line"}]}\''
  );
  const client = createProcessGitHubClient({ repoDir: dir, ghBin: script });
  expect(client.commitsForPr(7)).toEqual([{ sha: "abc123", message: "feat: x\ndetail line" }]);
});

test("createProcessGitHubClient: checksTriggered reads total_count from the check-runs response", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-gh-test-"));
  const script = writeFakeGhScript(dir, 'echo \'{"total_count":2,"check_runs":[]}\'');
  const client = createProcessGitHubClient({ repoDir: dir, ghBin: script });
  expect(client.checksTriggered("abc123")).toBe(true);
});

test("createProcessGitHubClient: checksTriggered is false when total_count is zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-gh-test-"));
  const script = writeFakeGhScript(dir, 'echo \'{"total_count":0,"check_runs":[]}\'');
  const client = createProcessGitHubClient({ repoDir: dir, ghBin: script });
  expect(client.checksTriggered("abc123")).toBe(false);
});

// --- runShipStage: happy path (B-1, B-3) -------------------------------------

test("happy path: the session runs, the PR verifies clean, and the stage passes", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const pr = cleanPr({ headSha });
  const gh = makeFakeGh({ prSequence: [null, pr], commits: [cleanCommit({ sha: headSha })], ciTriggered: true }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.branch).toBe(branch);
  expect(result.evidence.localHeadSha).toBe(headSha);
  expect(result.evidence.promptVersion).toBe(SHIP_PROMPT_VERSION);
  expect(result.evidence.sessions.length).toBe(1);
  expect(result.evidence.pr).toEqual({ number: 42, url: pr.url, headSha });
  expect(result.evidence.ciTriggered).toBe(true);
  expect(result.evidence.verification?.ok).toBe(true);
  expect(result.evidence.costMicroUsd).toBe(4200);
  // One pre-session idempotency check (finds nothing yet) plus one
  // post-session outside-verification check (finds the PR /ship opened).
  expect(state.prForBranchCalls).toBe(2);

  journal.close();
});

// --- B-2 / AC-2: hook-blocked session ----------------------------------------

test("AC-2: a hook-blocked session yields blocked with the refusal tail in evidence, and outside verification is never attempted", async () => {
  const { dir, branch } = initFixtureRepo();
  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runSession: async () =>
      fakeSessionResult({
        classification: {
          kind: "hook-blocked",
          resetAtMs: null,
          detail: 'matched hook-blocked pattern: "[pr-gate] BLOCKED"',
        },
        exitCode: 2,
        stderrTail: "[pr-gate] BLOCKED: gh pr create bypasses /ship's own governed sequence",
      }),
  };
  const state = freshFakeGhState();
  const gh = makeFakeGh({ prSequence: [null] }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("blocked");
  expect(result.evidence.sessions.length).toBe(1);
  expect(result.evidence.sessions[0]!.classification).toBe("hook-blocked");
  expect(result.evidence.sessions[0]!.stderrTail).toContain("[pr-gate] BLOCKED");
  expect(result.evidence.verification).toBeNull();
  // Only the B-4 idempotency pre-check ran (found nothing, so the session
  // was driven); once the session came back blocked, no further GitHubClient
  // call was made: no post-session prForBranch, no commitsForPr, no
  // checksTriggered. This is the "no PR-existence check attempted" AC-2
  // requires: outside verification is never attempted in response to a
  // refusal.
  expect(state.prForBranchCalls).toBe(1);
  expect(state.commitsForPrCalls).toBe(0);
  expect(state.checksTriggeredCalls).toBe(0);

  journal.close();
});

// --- B-3: verification mismatch ----------------------------------------------

test("verification mismatch: a PR whose head sha differs from the local branch head fails with the diff in evidence", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const mismatchedPr = cleanPr({ headSha: "0000000000000000000000000000000000dead" });
  const gh = makeFakeGh(
    { prSequence: [null, mismatchedPr], commits: [cleanCommit({ sha: mismatchedPr.headSha })], ciTriggered: true },
    state
  );
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.verification?.ok).toBe(false);
  expect(result.evidence.verification?.diff.some((d) => d.includes(headSha) && d.includes("does not match"))).toBe(
    true
  );

  journal.close();
});

// --- B-4: idempotency, pre-existing matching PR -------------------------------

test("idempotency: a pre-existing matching PR passes without driving a session", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  let sessionCalls = 0;
  const runner: Runner = {
    ...createProcessRunner({ repoDir: dir }),
    runSession: async () => {
      sessionCalls++;
      return fakeSessionResult();
    },
  };
  const state = freshFakeGhState();
  const pr = cleanPr({ headSha });
  const gh = makeFakeGh({ prSequence: [pr], commits: [cleanCommit({ sha: headSha })], ciTriggered: true }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.sessions).toEqual([]);
  expect(result.evidence.promptVersion).toBeNull();
  expect(sessionCalls).toBe(0);
  expect(state.prForBranchCalls).toBe(1);

  journal.close();
});

// --- B-3: AI attribution in a commit message ----------------------------------

test("attribution violation: a commit message carrying Co-Authored-By: Claude fails verification", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const pr = cleanPr({ headSha });
  const badCommit = cleanCommit({
    sha: headSha,
    message: "feat: fixture feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  });
  const gh = makeFakeGh({ prSequence: [null, pr], commits: [badCommit], ciTriggered: true }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.verification?.diff.some((d) => d.includes("Co-Authored-By"))).toBe(true);

  journal.close();
});

// --- B-3: session-link URL in the PR body --------------------------------------

test("session-link violation: a PR body carrying a claude.ai/code/session URL fails verification", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const pr = cleanPr({ headSha, body: "## Summary\n\nSee https://claude.ai/code/session_abc123 for detail.\n" });
  const gh = makeFakeGh({ prSequence: [null, pr], commits: [cleanCommit({ sha: headSha })], ciTriggered: true }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.verification?.diff.some((d) => d.includes("session-link"))).toBe(true);

  journal.close();
});

// --- B-3: CI not triggered -------------------------------------------------------

test("CI not triggered: a matching PR with no checks yet fails verification", async () => {
  const { dir, branch, headSha } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const pr = cleanPr({ headSha });
  const gh = makeFakeGh({ prSequence: [null, pr], commits: [cleanCommit({ sha: headSha })], ciTriggered: false }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.verification?.diff.some((d) => d.includes("CI was not triggered"))).toBe(true);

  journal.close();
});

// --- B-3: no PR at all after the session -----------------------------------------

test("no PR opened: the session ran but no PR exists afterward, so the stage fails", async () => {
  const { dir, branch } = initFixtureRepo();
  const runner: Runner = { ...createProcessRunner({ repoDir: dir }), runSession: async () => fakeSessionResult() };
  const state = freshFakeGhState();
  const gh = makeFakeGh({ prSequence: [null, null] }, state);
  const { journalDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runShipStage({ runner, gh, specId: branch, journal });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.pr).toBeNull();
  expect(result.evidence.verification?.diff.some((d) => d.includes("no pull request found"))).toBe(true);

  journal.close();
});
