import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "../journal";
import {
  parseVerificationSection,
  parseBrowserVerdict,
  buildBrowserVerifyPrompt,
  createProcessVerifyRunner,
  runVerifyStage,
  BrowserVerifierQuotaError,
  BROWSER_PROMPT_VERSION,
  type BrowserVerifier,
  type BrowserAssertResult,
} from "./verify";

// --- fixture repo (real git, never a real `claude`) -------------------------

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-stage-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function specFixture(specId: string, verificationSection: string): string {
  return `---
id: "${specId}"
title: "Fixture spec"
status: approved
kind: stage
implementation: complete
depends_on: []
establishes:
  - "src/example.ts"
---

# ${specId}: Fixture

Fixture spec body for verify stage tests.
${verificationSection}
`;
}

// Commits (or amends onto) whatever files already sit in `dir`, plus the
// fixture's own spec.md, and returns the resulting commit sha: the "merged
// sha" runVerifyStage is handed.
function commitSpec(dir: string, specId: string, verificationSection: string): string {
  mkdirSync(join(dir, "specs", specId), { recursive: true });
  writeFileSync(join(dir, "specs", specId, "spec.md"), specFixture(specId, verificationSection));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `spec ${specId}`]);
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir });
  return new TextDecoder().decode(result.stdout).trim();
}

function openHandles(): { journalDir: string; evidenceDir: string } {
  return {
    journalDir: mkdtempSync(join(tmpdir(), "verify-stage-journal-")),
    evidenceDir: mkdtempSync(join(tmpdir(), "verify-stage-evidence-")),
  };
}

function worktreeCount(dir: string): number {
  const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: dir });
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

function neverCalledVerifier(): BrowserVerifier {
  return {
    async assert(): Promise<BrowserAssertResult> {
      throw new Error("browserVerifier.assert should never be called in this scenario");
    },
  };
}

function readEvidenceText(evidenceDir: string, hash: string): string {
  return readFileSync(join(evidenceDir, `${hash}.txt`), "utf8");
}

// --- parseVerificationSection (B-1, FR-001) ---------------------------------

test("parseVerificationSection: a spec with no Verification section is not-declared", () => {
  const result = parseVerificationSection("# 900-x: Fixture\n\nJust a body, no Verification heading.\n");
  expect(result.declared).toBe(false);
});

test("parseVerificationSection: parses both verify:cli and verify:browser blocks", () => {
  const body = `# 900-x: Fixture

## Verification

\`\`\`verify:cli
bun test
# a comment, skipped
bun run typecheck
\`\`\`

\`\`\`verify:browser
url: https://example.com/dashboard
The page title reads "Dashboard"
The login button is visible
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe(true);
  if (result.declared !== true) throw new Error("unreachable");
  expect(result.cli).toEqual([{ blockIndex: 0, commands: ["bun test", "bun run typecheck"] }]);
  expect(result.browser).toEqual([
    {
      blockIndex: 0,
      url: "https://example.com/dashboard",
      assertions: ['The page title reads "Dashboard"', "The login button is visible"],
    },
  ]);
});

test("parseVerificationSection: stops the section at the next top-level heading", () => {
  const body = `## Verification

\`\`\`verify:cli
bun test
\`\`\`

## Out of scope

\`\`\`verify:cli
should-not-be-parsed
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe(true);
  if (result.declared !== true) throw new Error("unreachable");
  expect(result.cli.length).toBe(1);
  expect(result.cli[0]!.commands).toEqual(["bun test"]);
});

test("parseVerificationSection: an unknown verify:* tag is a parse error, not silently skipped", () => {
  const body = `## Verification

\`\`\`verify:database
select 1;
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe("error");
  if (result.declared !== "error") throw new Error("unreachable");
  expect(result.message).toContain("unknown verification tag");
  expect(result.message).toContain("verify:database");
});

test("parseVerificationSection: a verify:browser block without a url line is a parse error", () => {
  const body = `## Verification

\`\`\`verify:browser
The page loads
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe("error");
  if (result.declared !== "error") throw new Error("unreachable");
  expect(result.message).toContain("without a");
  expect(result.message).toContain("url:");
});

test("parseVerificationSection: an empty verify:cli block (comments/blanks only) is a parse error", () => {
  const body = `## Verification

\`\`\`verify:cli
# just a comment

\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe("error");
  if (result.declared !== "error") throw new Error("unreachable");
  expect(result.message).toContain("empty verify:cli block");
});

test("parseVerificationSection: a verify:browser block with a url but no assertions is a parse error", () => {
  const body = `## Verification

\`\`\`verify:browser
url: https://example.com
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe("error");
  if (result.declared !== "error") throw new Error("unreachable");
  expect(result.message).toContain("empty verify:browser block");
});

test("parseVerificationSection: every malformed block in the section is collected, not just the first", () => {
  const body = `## Verification

\`\`\`verify:foo
x
\`\`\`

\`\`\`verify:browser
no url here
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe("error");
  if (result.declared !== "error") throw new Error("unreachable");
  expect(result.message).toContain("verify:foo");
  expect(result.message).toContain("verify:browser");
});

test("parseVerificationSection: a fenced block unrelated to verify: is ignored, not an error", () => {
  const body = `## Verification

Illustrative example, not itself an assertion:

\`\`\`bash
echo hello
\`\`\`

\`\`\`verify:cli
bun test
\`\`\`
`;
  const result = parseVerificationSection(body);
  expect(result.declared).toBe(true);
  if (result.declared !== true) throw new Error("unreachable");
  expect(result.cli.length).toBe(1);
});

// --- buildBrowserVerifyPrompt / parseBrowserVerdict (B-3, FR-002) ----------

test("buildBrowserVerifyPrompt embeds the url, the assertion, the JSON schema, and the house style rules", () => {
  const prompt = buildBrowserVerifyPrompt({ url: "https://example.com", assertion: "The header says Welcome" });
  expect(prompt).toContain("https://example.com");
  expect(prompt).toContain("The header says Welcome");
  expect(prompt).toContain(`version: ${BROWSER_PROMPT_VERSION}`);
  expect(prompt).toContain('"pass"');
  expect(prompt).toContain('"detail"');
  expect(prompt).toContain("No em dashes");
  expect(prompt.indexOf(String.fromCharCode(0x2014))).toBe(-1);
});

test("parseBrowserVerdict: parses a bare JSON object", () => {
  const result = parseBrowserVerdict('{"pass": true, "detail": "the header reads Welcome"}');
  expect(result).toEqual({ pass: true, detail: "the header reads Welcome" });
});

test("parseBrowserVerdict: parses a JSON object embedded in surrounding prose", () => {
  const result = parseBrowserVerdict(
    'Here is what I found:\n{"pass": false, "detail": "the header was missing"}\nThat is all.'
  );
  expect(result).toEqual({ pass: false, detail: "the header was missing" });
});

test("parseBrowserVerdict: carries screenshotPngBase64 through when present", () => {
  const result = parseBrowserVerdict('{"pass": true, "detail": "ok", "screenshotPngBase64": "aGVsbG8="}');
  expect(result).toEqual({ pass: true, detail: "ok", screenshotPngBase64: "aGVsbG8=" });
});

test("parseBrowserVerdict: returns null rather than guessing when nothing matches the schema", () => {
  expect(parseBrowserVerdict("I looked at the page and it seemed fine.")).toBeNull();
  expect(parseBrowserVerdict('{"pass": "yes", "detail": "wrong type"}')).toBeNull();
});

// --- createProcessVerifyRunner (production seam) ----------------------------

test("createProcessVerifyRunner: runCommand captures exit code, stdout, and stderr", () => {
  const dir = initRepo();
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const result = runner.runCommand(dir, ["sh", "-c", "echo out-marker; echo err-marker 1>&2; exit 7"], 5000);
  expect(result.exitCode).toBe(7);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toContain("out-marker");
  expect(result.stderr).toContain("err-marker");
});

test("createProcessVerifyRunner: runCommand kills a command that exceeds its timeout", () => {
  const dir = initRepo();
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const result = runner.runCommand(dir, ["sh", "-c", "sleep 5"], 200);
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).toBeNull();
});

test("createProcessVerifyRunner: addWorktree/removeWorktree round-trip a clean checkout of the given sha", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "marker.txt"), "v1");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();

  const runner = createProcessVerifyRunner({ repoDir: dir });
  const before = worktreeCount(dir);
  const worktreePath = runner.addWorktree(sha);
  expect(existsSync(join(worktreePath, "marker.txt"))).toBe(true);
  expect(readFileSync(join(worktreePath, "marker.txt"), "utf8")).toBe("v1");
  expect(worktreeCount(dir)).toBe(before + 1);

  runner.removeWorktree(worktreePath);
  expect(worktreeCount(dir)).toBe(before);
  expect(existsSync(worktreePath)).toBe(false);
});

// --- runVerifyStage: not-declared (B-1, B-4) --------------------------------

test("runVerifyStage: a spec with no Verification section verifies not-declared and still cleans up the worktree", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(dir, specId, "");
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const before = worktreeCount(dir);
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
  });

  expect(result.outcome).toBe("not-declared");
  expect(result.evidence.declared).toBe(false);
  expect(result.evidence.cli).toEqual([]);
  expect(result.evidence.browser).toEqual([]);
  expect(result.evidence.needsHuman).toBe(false);
  expect(worktreeCount(dir)).toBe(before);
  expect(journal.fold().byKind["stage.verify.result"]?.length).toBe(1);

  journal.close();
});

// --- runVerifyStage: malformed section fails with the parse error (FR-001) -

test("runVerifyStage: a malformed Verification section fails the stage with the parse error, needsHuman only on re-verification", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:nope
x
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const before = worktreeCount(dir);
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
  });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.parseError).toContain("unknown verification tag");
  expect(result.evidence.needsHuman).toBe(false);
  expect(worktreeCount(dir)).toBe(before);

  const reVerify = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
    isReVerification: true,
  });
  expect(reVerify.outcome).toBe("failed");
  expect(reVerify.evidence.needsHuman).toBe(true);

  journal.close();
});

// --- runVerifyStage: AC-2 fixture, one failing + one passing cli assertion -

test("AC-2: one failing and one passing cli assertion yields failed, naming the failing block, with both outputs recorded", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:cli
echo failing-output-marker && exit 3
echo passing-output-marker
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
  });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.firstFailure?.kind).toBe("cli");
  expect(result.evidence.firstFailure?.description).toContain("command 1");
  expect(result.evidence.cli.length).toBe(2);
  expect(result.evidence.cli.map((c) => c.exitCode)).toEqual([3, 0]);

  const failingText = readEvidenceText(evidenceDir, result.evidence.cli[0]!.evidenceHash);
  const passingText = readEvidenceText(evidenceDir, result.evidence.cli[1]!.evidenceHash);
  expect(failingText).toContain("failing-output-marker");
  expect(passingText).toContain("passing-output-marker");

  expect(journal.fold().byKind["stage.verify.cli"]?.length).toBe(2);

  journal.close();
});

// --- runVerifyStage: clean-worktree isolation (B-2) -------------------------

test("runVerifyStage: cli assertions run against the merged sha's content, not a dirty working tree", async () => {
  const dir = initRepo();
  writeFileSync(join(dir, "marker.txt"), "clean-content\n");
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:cli
grep -q clean-content marker.txt
\`\`\`
`
  );
  // Dirty the working tree after the commit, without committing: if the
  // stage ran the assertion against dir directly instead of a clean
  // worktree, this would flip the assertion from pass to fail.
  writeFileSync(join(dir, "marker.txt"), "dirty-content\n");

  const runner = createProcessVerifyRunner({ repoDir: dir });
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
  });

  expect(result.outcome).toBe("passed");
  expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("dirty-content\n");

  journal.close();
});

// --- runVerifyStage: browser assertions, fake verifier (B-3, FR-002) -------

function fakeVerifier(byAssertion: Record<string, BrowserAssertResult | "quota">): BrowserVerifier {
  return {
    async assert(_url: string, assertion: string): Promise<BrowserAssertResult> {
      const scripted = byAssertion[assertion];
      if (scripted === undefined) throw new Error(`fakeVerifier: no script for assertion "${assertion}"`);
      if (scripted === "quota") throw new BrowserVerifierQuotaError("matched quota pattern", 1_800_000);
      return scripted;
    },
  };
}

test("runVerifyStage: browser assertions all pass, yielding outcome passed with evidence for each", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:browser
url: https://example.com/dashboard
The title reads Dashboard
The login button is visible
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const verifier = fakeVerifier({
    "The title reads Dashboard": { pass: true, detail: "title matched" },
    "The login button is visible": { pass: true, detail: "button visible", screenshotPngBase64: Buffer.from("fake-png-bytes").toString("base64") },
  });

  const result = await runVerifyStage({ runner, browserVerifier: verifier, specId, sha, journal, evidenceDir });

  expect(result.outcome).toBe("passed");
  expect(result.evidence.browser.length).toBe(2);
  expect(result.evidence.browser[0]!.screenshotHash).toBeNull();
  const screenshotHash = result.evidence.browser[1]!.screenshotHash;
  expect(screenshotHash).not.toBeNull();
  const screenshotBytes = readFileSync(join(evidenceDir, `${screenshotHash}.png`));
  expect(screenshotBytes.toString("utf8")).toBe("fake-png-bytes");

  journal.close();
});

test("runVerifyStage: a failing browser assertion fails the stage, still recording every assertion run", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:browser
url: https://example.com/dashboard
The title reads Dashboard
The login button is visible
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const verifier = fakeVerifier({
    "The title reads Dashboard": { pass: false, detail: "title read Home instead" },
    "The login button is visible": { pass: true, detail: "button visible" },
  });

  const result = await runVerifyStage({ runner, browserVerifier: verifier, specId, sha, journal, evidenceDir });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.firstFailure?.kind).toBe("browser");
  expect(result.evidence.firstFailure?.description).toContain("The title reads Dashboard");
  // Both assertions ran to completion even though the first one failed.
  expect(result.evidence.browser.length).toBe(2);
  expect(result.evidence.browser.map((b) => b.pass)).toEqual([false, true]);

  journal.close();
});

test("runVerifyStage: a browser session classified quota reports outcome quota, not a failure", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:browser
url: https://example.com/dashboard
The title reads Dashboard
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const before = worktreeCount(dir);
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const verifier = fakeVerifier({ "The title reads Dashboard": "quota" });

  const result = await runVerifyStage({ runner, browserVerifier: verifier, specId, sha, journal, evidenceDir });

  expect(result.outcome).toBe("quota");
  expect(result.evidence.needsHuman).toBe(false);
  expect(result.evidence.quotaResetAtMs).toBe(1_800_000);
  expect(result.evidence.browser).toEqual([]);
  expect(worktreeCount(dir)).toBe(before);
  expect(journal.fold().byKind["stage.verify.quota"]?.length).toBe(1);

  journal.close();
});

// --- runVerifyStage: cli assertions skip the browser section on failure ----

test("runVerifyStage: a failing cli assertion never drives the browser verifier at all", async () => {
  const dir = initRepo();
  const specId = "900-fixture-verify";
  const sha = commitSpec(
    dir,
    specId,
    `
## Verification

\`\`\`verify:cli
exit 1
\`\`\`

\`\`\`verify:browser
url: https://example.com
Some assertion
\`\`\`
`
  );
  const runner = createProcessVerifyRunner({ repoDir: dir });
  const { journalDir, evidenceDir } = openHandles();
  const journal = openJournal(journalDir);

  const result = await runVerifyStage({
    runner,
    browserVerifier: neverCalledVerifier(),
    specId,
    sha,
    journal,
    evidenceDir,
  });

  expect(result.outcome).toBe("failed");
  expect(result.evidence.firstFailure?.kind).toBe("cli");
  expect(result.evidence.browser).toEqual([]);

  journal.close();
});

test("addWorktree fetches from origin when the sha is not yet local (remote squash merge)", () => {
  // origin with two commits; the local clone only has the first, so the
  // second sha is unknown locally until the runner fetches.
  const originDir = mkdtempSync(join(tmpdir(), "verify-origin-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "verify-clone-"));
  const g = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  g(originDir, "init", "-b", "main");
  g(originDir, "config", "user.email", "t@t");
  g(originDir, "config", "user.name", "t");
  writeFileSync(join(originDir, "a.txt"), "one\n");
  g(originDir, "add", "a.txt");
  g(originDir, "commit", "-m", "one");
  g(cloneDir, "clone", originDir, "repo");
  const repoDir = join(cloneDir, "repo");
  writeFileSync(join(originDir, "a.txt"), "two\n");
  g(originDir, "add", "a.txt");
  g(originDir, "commit", "-m", "two");
  const remoteSha = g(originDir, "rev-parse", "HEAD");

  const runner = createProcessVerifyRunner({ repoDir });
  const worktree = runner.addWorktree(remoteSha);
  try {
    expect(readFileSync(join(worktree, "a.txt"), "utf8")).toBe("two\n");
  } finally {
    runner.removeWorktree(worktree);
  }
});
