// The verify stage (spec 019): the fourth pipeline stage, and the
// re-qualification path for invalidated specs (spec 012 B-4). A spec MAY
// declare observable behavior in a `## Verification` section (B-1):
// `verify:cli` fenced blocks (shell commands, one per line, comments with
// `#` allowed) and `verify:browser` fenced blocks (a `url:` first line, then
// one natural-language assertion per line). The parser is pure and typed
// (FR-001): a spec with no such section parses to `{declared: false}`; a
// malformed block (an unknown `verify:*` tag, a browser block with no url
// line, or an empty block) is a parse error, never silently skipped or
// dropped.
//
// CLI assertions (B-2) run serially, one shell command at a time, each with
// its own timeout, inside a clean `git worktree` checked out at the merged
// sha, never the caller's own working tree (which may be dirty, mid-flight,
// or simply on a different branch). The worktree is created before anything
// else runs and removed again once the stage is done, pass or fail. Browser
// assertions (B-3) run behind a BrowserVerifier seam; the production
// implementation drives a fresh claude session per assertion, instructed to
// use the Claude in Chrome MCP tools (spec 014's own runSession) and reply
// in a strict JSON schema, and is never constructed by this file's own
// tests (FR-002: unit tests use a fake BrowserVerifier only, mirroring
// spec 014's and spec 017's own "never spawn the real claude/gh in tests"
// convention; the live path is excluded from CI the same way spec 014's own
// AC-2 live smoke session is, run manually rather than checked in).
//
// Every assertion's evidence (a cli command's bounded stdout+stderr; a
// browser assertion's verdict detail and, when the verifier returns one, a
// screenshot) is written to a content-addressed file (sha256 name) under
// the caller's evidenceDir; the journal only ever references {assertion,
// evidenceHash}, never inline content (FR-003).
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID, createHash } from "crypto";
import type { JournalHandle, JsonValue } from "../journal";
import { runSession as driveClaudeSession } from "../session";

// --- Verification-section parser (B-1, FR-001) ------------------------------

export interface CliBlock {
  readonly blockIndex: number;
  readonly commands: readonly string[];
}

export interface BrowserBlock {
  readonly blockIndex: number;
  readonly url: string;
  readonly assertions: readonly string[];
}

export type ParseVerificationResult =
  | { readonly declared: false }
  | { readonly declared: true; readonly cli: readonly CliBlock[]; readonly browser: readonly BrowserBlock[] }
  | { readonly declared: "error"; readonly message: string };

const VERIFICATION_HEADING_RE = /^## Verification\s*$/m;
const NEXT_HEADING_RE = /^## /m;
// Matches a fenced code block whose opening line is ```<tag> and whose
// closing line is a bare ``` starting a line of its own; the body (possibly
// empty) is captured non-greedily so an immediately-closed fence (no body
// line at all) still matches rather than being silently skipped.
const FENCE_RE = /^```([^\n`]*)\r?\n([\s\S]*?)^```[ \t]*\r?$/gm;
const URL_LINE_RE = /^url:\s*(\S+)\s*$/i;

function extractVerificationSection(specBody: string): string | null {
  const heading = VERIFICATION_HEADING_RE.exec(specBody);
  if (!heading) return null;
  const rest = specBody.slice(heading.index + heading[0].length);
  const next = NEXT_HEADING_RE.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

type BlockParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function parseCliBlockBody(body: string): BlockParse<{ commands: string[] }> {
  const commands: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    commands.push(line);
  }
  if (commands.length === 0) {
    return { ok: false, error: "empty verify:cli block (no commands after stripping comments and blank lines)" };
  }
  return { ok: true, value: { commands } };
}

function parseBrowserBlockBody(body: string): BlockParse<{ url: string; assertions: string[] }> {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: "empty verify:browser block" };

  const urlMatch = URL_LINE_RE.exec(lines[0]!);
  if (!urlMatch) {
    return { ok: false, error: `verify:browser block without a "url: <url>" first line (found "${lines[0]}")` };
  }

  const assertions = lines.slice(1);
  if (assertions.length === 0) return { ok: false, error: "empty verify:browser block (a url but no assertions)" };
  return { ok: true, value: { url: urlMatch[1]!, assertions } };
}

// Pure (FR-001). No Verification section at all is honestly `not-declared`,
// never guessed at; a malformed block anywhere in the section fails the
// whole parse (every malformed block is collected into the one message,
// never just the first, so nothing is silently skipped).
export function parseVerificationSection(specBody: string): ParseVerificationResult {
  const section = extractVerificationSection(specBody);
  if (section === null) return { declared: false };

  const cli: CliBlock[] = [];
  const browser: BrowserBlock[] = [];
  const errors: string[] = [];

  FENCE_RE.lastIndex = 0;
  let fenceOrdinal = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(section)) !== null) {
    fenceOrdinal++;
    const tag = match[1]!.trim();
    const body = match[2]!;
    if (!tag.startsWith("verify:")) continue; // an unrelated fence (e.g. a plain example snippet): not this section's business

    const kind = tag.slice("verify:".length).trim();
    if (kind === "cli") {
      const parsed = parseCliBlockBody(body);
      if (parsed.ok) cli.push({ blockIndex: cli.length, commands: parsed.value.commands });
      else errors.push(`fenced block ${fenceOrdinal} (${tag}): ${parsed.error}`);
    } else if (kind === "browser") {
      const parsed = parseBrowserBlockBody(body);
      if (parsed.ok) browser.push({ blockIndex: browser.length, url: parsed.value.url, assertions: parsed.value.assertions });
      else errors.push(`fenced block ${fenceOrdinal} (${tag}): ${parsed.error}`);
    } else {
      errors.push(`fenced block ${fenceOrdinal}: unknown verification tag "${tag}" (expected verify:cli or verify:browser)`);
    }
  }

  if (errors.length > 0) return { declared: "error", message: errors.join("; ") };
  return { declared: true, cli, browser };
}

// --- evidence (FR-003: content-addressed, journal references only) --------

function sha256HexBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function tailText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

// Writes `buf` under `evidenceDir` named by its own sha256 hash; a second
// assertion whose output hashes identically reuses the same file rather
// than writing a duplicate. Returns the hash, the only thing the journal
// ever carries (FR-003: never inline content).
function writeEvidenceFile(evidenceDir: string, buf: Buffer, ext: string): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const hash = sha256HexBuffer(buf);
  const filePath = join(evidenceDir, `${hash}${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buf);
  return hash;
}

function writeTextEvidence(evidenceDir: string, text: string, maxBytes: number): string {
  return writeEvidenceFile(evidenceDir, Buffer.from(tailText(text, maxBytes), "utf8"), ".txt");
}

export const DEFAULT_EVIDENCE_TEXT_BYTES = 16 * 1024;

// --- VerifyRunner seam (B-2): worktree lifecycle + bounded command exec ----
//
// A new seam rather than an extension of build.ts's own Runner (spec 016):
// that interface's `runGate` always runs in one fixed repoDir with no
// per-call timeout, but B-2 needs commands to run inside a just-created
// worktree directory (never the fixed repoDir) with a per-command deadline.
// The shape still follows the family convention build.ts established
// (interface + a Bun.spawnSync-backed production factory + scripted fakes
// in tests), just for a genuinely different set of operations (see this
// spec's Resolved decisions).

export interface CliRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface VerifyRunner {
  // Creates `git worktree add --detach <tmp> <sha>` against the target repo
  // and returns the absolute path to the new worktree.
  addWorktree(sha: string): string;
  // Removes the worktree created by addWorktree, including a filesystem
  // fallback and a `git worktree prune`, so a partial or already-gone
  // worktree never leaves stray registrations or files behind.
  removeWorktree(path: string): void;
  // Runs `cmd` with the given cwd (always the worktree, never the target
  // repo's own working tree) and a hard timeout.
  runCommand(cwd: string, cmd: readonly string[], timeoutMs: number): CliRunResult;
  // Reads a file at an absolute path (used to read spec.md out of the
  // worktree once it exists); verify never writes back into the target
  // repo or its worktree.
  readFile(path: string): string;
}

export interface CreateProcessVerifyRunnerParams {
  readonly repoDir: string;
}

export function createProcessVerifyRunner(params: CreateProcessVerifyRunnerParams): VerifyRunner {
  const { repoDir } = params;

  return {
    addWorktree(sha: string): string {
      // Shepherd merges remotely; the merge sha may not exist locally until
      // fetched (the live run failed on exactly this: invalid reference).
      const known = Bun.spawnSync(["git", "rev-parse", "--verify", `${sha}^{commit}`], { cwd: repoDir });
      if (known.exitCode !== 0) {
        const fetch = Bun.spawnSync(["git", "fetch", "origin"], { cwd: repoDir });
        if (fetch.exitCode !== 0) {
          throw new Error(`verify: git fetch origin failed: ${new TextDecoder().decode(fetch.stderr).trim()}`);
        }
      }
      const target = join(tmpdir(), `verify-worktree-${randomUUID()}`);
      const result = Bun.spawnSync(["git", "worktree", "add", "--detach", target, sha], { cwd: repoDir });
      if (result.exitCode !== 0) {
        throw new Error(
          `verify: git worktree add ${target} ${sha} failed: ${new TextDecoder().decode(result.stderr).trim()}`
        );
      }
      return target;
    },

    removeWorktree(path: string): void {
      Bun.spawnSync(["git", "worktree", "remove", "--force", path], { cwd: repoDir });
      try {
        fs.rmSync(path, { recursive: true, force: true });
      } catch {
        // already gone
      }
      Bun.spawnSync(["git", "worktree", "prune"], { cwd: repoDir });
    },

    runCommand(cwd: string, cmd: readonly string[], timeoutMs: number): CliRunResult {
      const startedAtMs = Date.now();
      const result = Bun.spawnSync(cmd as string[], { cwd, timeout: timeoutMs, killSignal: "SIGKILL" });
      return {
        exitCode: result.exitedDueToTimeout ? null : result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        timedOut: Boolean(result.exitedDueToTimeout),
        durationMs: Date.now() - startedAtMs,
      };
    },

    readFile(path: string): string {
      try {
        return fs.readFileSync(path, "utf8");
      } catch (err) {
        throw new Error(`verify: could not read "${path}": ${(err as Error).message}`);
      }
    },
  };
}

// --- BrowserVerifier seam (B-3, FR-002) -------------------------------------

export interface BrowserAssertResult {
  readonly pass: boolean;
  readonly detail: string;
  readonly screenshotPngBase64?: string;
}

export interface BrowserVerifier {
  assert(url: string, assertion: string): Promise<BrowserAssertResult>;
}

// A remediation-shaped quota signal (mirroring shepherd's own StatuslessAbortError
// pattern, spec 018): the BrowserVerifier interface's happy path only ever
// returns pass/detail/screenshot, so a session that classifies `quota`
// (spec 014) is surfaced as a typed throw instead, letting runVerifyStage
// map it to outcome "quota" without inventing a fourth field on the
// interface's return shape (Resolved decisions).
export class BrowserVerifierQuotaError extends Error {
  readonly resetAtMs: number | null;
  constructor(detail: string, resetAtMs: number | null) {
    super(`verify: browser assertion driving classified quota: ${detail}`);
    this.name = "BrowserVerifierQuotaError";
    this.resetAtMs = resetAtMs;
  }
}

export const BROWSER_PROMPT_VERSION = 1;

export interface BrowserVerifyPromptParams {
  readonly url: string;
  readonly assertion: string;
}

export function buildBrowserVerifyPrompt(params: BrowserVerifyPromptParams): string {
  const { url, assertion } = params;
  return `You are verifying one observable behavior of a running web application
through the Claude in Chrome MCP tools, in this one session. Verify browser
prompt template version: ${BROWSER_PROMPT_VERSION}.

## What to do

Use the Claude in Chrome MCP tools to navigate to the URL below and check
exactly one assertion against what you actually observe there. Do not check
anything else and do not modify the page's state beyond what observing it
requires.

URL: ${url}

Assertion to check: ${assertion}

Take a screenshot as part of your check when the tools allow it. If you
cannot produce one, say so plainly rather than claiming one exists.

## How to answer

Reply with exactly one JSON object and nothing else (no markdown fence, no
prose before or after it), matching this schema:

  {"pass": true or false, "detail": "one or two sentences on what you observed"}

## House style

No em dashes (U+2014) anywhere. Report only what you actually observed; a
failing or uncertain result reported honestly is correct behavior, not a
mistake.
`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Exported for unit testing without ever driving a real (or fake-script)
// claude session (FR-002): the assistant's final reply may or may not be
// wrapped in prose or a markdown fence, so a direct parse is tried first and
// a best-effort brace-extraction is tried second, never a guess at pass/fail
// when neither parses.
export function parseBrowserVerdict(text: string): BrowserAssertResult | null {
  const candidates = [text.trim()];
  const braceMatch = /\{[\s\S]*\}/.exec(text);
  if (braceMatch) candidates.push(braceMatch[0]);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (isRecord(parsed) && typeof parsed.pass === "boolean" && typeof parsed.detail === "string") {
      const screenshot = typeof parsed.screenshotPngBase64 === "string" ? parsed.screenshotPngBase64 : undefined;
      return { pass: parsed.pass, detail: parsed.detail, ...(screenshot !== undefined ? { screenshotPngBase64: screenshot } : {}) };
    }
  }
  return null;
}

function extractResultText(event: unknown): string | null {
  if (!isRecord(event)) return null;
  if (event.type === "result" && typeof event.result === "string") return event.result;
  return null;
}

export const DEFAULT_BROWSER_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_BROWSER_MAX_TURNS = 40;

export interface CreateClaudeChromeBrowserVerifierParams {
  readonly repo: string;
  readonly claudeBin?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

// The production BrowserVerifier (B-3): a fresh claude session per
// assertion, driven exactly like every other session in this codebase
// (spec 014's own runSession), instructed to use the Claude in Chrome MCP
// tools and reply in buildBrowserVerifyPrompt's strict JSON schema. Kept
// thin on purpose and never constructed by verify.test.ts's scenarios
// (FR-002): those drive runVerifyStage against a hand-written fake
// BrowserVerifier instead, the same "never spawn the real claude in tests"
// convention spec 014's own session.test.ts documents. A live smoke check
// of this function against a real browser session is run manually, not
// checked into the suite (mirroring spec 014's own AC-2 live smoke).
export function createClaudeChromeBrowserVerifier(params: CreateClaudeChromeBrowserVerifierParams): BrowserVerifier {
  const claudeBin = params.claudeBin ?? "claude";

  return {
    async assert(url: string, assertion: string): Promise<BrowserAssertResult> {
      let resultText: string | null = null;

      const session = await driveClaudeSession({
        repo: params.repo,
        claudeBin,
        model: params.model,
        maxTurns: params.maxTurns ?? DEFAULT_BROWSER_MAX_TURNS,
        timeoutMs: params.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
        prompt: buildBrowserVerifyPrompt({ url, assertion }),
        sink: (event) => {
          const text = extractResultText(event);
          if (text !== null) resultText = text;
        },
      });

      if (session.classification.kind === "quota") {
        throw new BrowserVerifierQuotaError(session.classification.detail, session.classification.resetAtMs);
      }
      if (session.classification.kind !== "completed") {
        return {
          pass: false,
          detail: `browser verification session did not complete (${session.classification.kind}): ${session.classification.detail}`,
        };
      }
      if (resultText === null) {
        return { pass: false, detail: "browser verification session completed with no result text to parse" };
      }
      const parsed = parseBrowserVerdict(resultText);
      if (!parsed) {
        return {
          pass: false,
          detail: `browser verification session's result text did not match the expected JSON schema: ${(resultText as string).slice(0, 500)}`,
        };
      }
      return parsed;
    },
  };
}

// --- evidence and outcome shapes (B-4, FR-003) ------------------------------

export type VerifyOutcome = "passed" | "failed" | "not-declared" | "quota";

export interface VerifyCliEvidence {
  readonly blockIndex: number;
  readonly commandIndex: number;
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly evidenceHash: string;
}

export interface VerifyBrowserEvidence {
  readonly blockIndex: number;
  readonly assertionIndex: number;
  readonly url: string;
  readonly assertion: string;
  readonly pass: boolean;
  readonly detailHash: string;
  readonly screenshotHash: string | null;
}

export interface VerifyFailure {
  readonly kind: "cli" | "browser";
  readonly description: string;
  readonly evidenceHash: string;
}

export interface VerifyEvidence {
  readonly specId: string;
  readonly sha: string;
  readonly declared: boolean;
  readonly parseError: string | null;
  readonly cli: readonly VerifyCliEvidence[];
  readonly browser: readonly VerifyBrowserEvidence[];
  readonly firstFailure: VerifyFailure | null;
  readonly evidenceDir: string;
  // B-5: true only when this is a re-verification run and the outcome is
  // failed (mirroring shepherd's own needsHuman convention, spec 018): the
  // upstream amendment broke a downstream contract, a human decision, not a
  // rebuild loop.
  readonly needsHuman: boolean;
  readonly quotaResetAtMs: number | null;
}

export interface VerifyResult {
  readonly outcome: VerifyOutcome;
  readonly evidence: VerifyEvidence;
}

// --- defaults ----------------------------------------------------------------

export const DEFAULT_CLI_TIMEOUT_MS = 5 * 60_000;

// --- the stage (B-1 through B-5) --------------------------------------------

export interface RunVerifyStageOptions {
  readonly runner: VerifyRunner;
  readonly browserVerifier: BrowserVerifier;
  readonly specId: string;
  // The merged sha to verify (B-2): the caller (the daemon) supplies this
  // explicitly, the same "specId is always an explicit field, never
  // inferred" convention ship.ts's own D-6 established, since verify has no
  // "current branch" of its own to read it from.
  readonly sha: string;
  readonly journal: JournalHandle;
  readonly evidenceDir: string;
  readonly cliTimeoutMs?: number;
  // B-5: set by the daemon when this call is re-verifying a spec invalidated
  // per spec 012 B-4, rather than a first-time verify inside the normal
  // pipeline.
  readonly isReVerification?: boolean;
}

export async function runVerifyStage(options: RunVerifyStageOptions): Promise<VerifyResult> {
  const { runner, browserVerifier, specId, sha, journal, evidenceDir } = options;
  const cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const isReVerification = options.isReVerification ?? false;
  const specPath = `specs/${specId}/spec.md`;

  // B-2: the clean checkout. Created before anything else runs (so even the
  // "is Verification even declared" read comes from the merged sha's own
  // spec.md, never a possibly-stale local copy) and removed on every exit
  // path, success or failure.
  const worktreePath = runner.addWorktree(sha);
  try {
    const specBody = runner.readFile(join(worktreePath, specPath));
    const parsed = parseVerificationSection(specBody);

    const parsedPayload: Record<string, JsonValue> = {
      specId,
      sha,
      declared: parsed.declared === true,
      parseError: parsed.declared === "error" ? parsed.message : null,
      cliBlocks: parsed.declared === true ? parsed.cli.length : 0,
      browserBlocks: parsed.declared === true ? parsed.browser.length : 0,
    };
    journal.append("stage.verify.parsed", parsedPayload);

    if (parsed.declared === false) {
      const evidence: VerifyEvidence = {
        specId,
        sha,
        declared: false,
        parseError: null,
        cli: [],
        browser: [],
        firstFailure: null,
        evidenceDir,
        needsHuman: false,
        quotaResetAtMs: null,
      };
      const resultPayload: Record<string, JsonValue> = { specId, sha, outcome: "not-declared", needsHuman: false };
      journal.append("stage.verify.result", resultPayload);
      return { outcome: "not-declared", evidence };
    }

    if (parsed.declared === "error") {
      const evidence: VerifyEvidence = {
        specId,
        sha,
        declared: true,
        parseError: parsed.message,
        cli: [],
        browser: [],
        firstFailure: null,
        evidenceDir,
        needsHuman: isReVerification,
        quotaResetAtMs: null,
      };
      const resultPayload: Record<string, JsonValue> = {
        specId,
        sha,
        outcome: "failed",
        needsHuman: isReVerification,
        parseError: parsed.message,
      };
      journal.append("stage.verify.result", resultPayload);
      return { outcome: "failed", evidence };
    }

    // --- B-2: cli assertions, serial, run to completion (never stopped
    // early on a failure: AC-2's "both outputs recorded" needs every
    // assertion's evidence on disk regardless of which one failed first).
    const cliEvidence: VerifyCliEvidence[] = [];
    let firstFailure: VerifyFailure | null = null;

    for (const block of parsed.cli) {
      for (let i = 0; i < block.commands.length; i++) {
        const command = block.commands[i]!;
        const runResult = runner.runCommand(worktreePath, ["sh", "-c", command], cliTimeoutMs);
        const combined = `$ ${command}\n\n--- stdout ---\n${runResult.stdout}\n--- stderr ---\n${runResult.stderr}`;
        const evidenceHash = writeTextEvidence(evidenceDir, combined, DEFAULT_EVIDENCE_TEXT_BYTES);

        const entry: VerifyCliEvidence = {
          blockIndex: block.blockIndex,
          commandIndex: i,
          command,
          exitCode: runResult.exitCode,
          timedOut: runResult.timedOut,
          durationMs: runResult.durationMs,
          evidenceHash,
        };
        cliEvidence.push(entry);

        const cliPayload: Record<string, JsonValue> = {
          specId,
          sha,
          blockIndex: entry.blockIndex,
          commandIndex: entry.commandIndex,
          command,
          exitCode: entry.exitCode,
          timedOut: entry.timedOut,
          evidenceHash,
        };
        journal.append("stage.verify.cli", cliPayload);

        const passed = !runResult.timedOut && runResult.exitCode === 0;
        if (!passed && firstFailure === null) {
          firstFailure = {
            kind: "cli",
            description: `verify:cli block ${entry.blockIndex + 1}, command ${entry.commandIndex + 1}: ${command}`,
            evidenceHash,
          };
        }
      }
    }

    if (firstFailure) {
      const evidence: VerifyEvidence = {
        specId,
        sha,
        declared: true,
        parseError: null,
        cli: cliEvidence,
        browser: [],
        firstFailure,
        evidenceDir,
        needsHuman: isReVerification,
        quotaResetAtMs: null,
      };
      const resultPayload: Record<string, JsonValue> = {
        specId,
        sha,
        outcome: "failed",
        needsHuman: isReVerification,
        firstFailure: firstFailure.description,
      };
      journal.append("stage.verify.result", resultPayload);
      return { outcome: "failed", evidence };
    }

    // --- B-3: browser assertions, run to completion the same way, unless a
    // session classifies quota: that stops everything immediately, since no
    // further session can be driven without it (B-3, obeys the scheduler).
    const browserEvidence: VerifyBrowserEvidence[] = [];

    for (const block of parsed.browser) {
      for (let i = 0; i < block.assertions.length; i++) {
        const assertion = block.assertions[i]!;

        let assertResult: BrowserAssertResult;
        try {
          assertResult = await browserVerifier.assert(block.url, assertion);
        } catch (err) {
          if (err instanceof BrowserVerifierQuotaError) {
            const quotaPayload: Record<string, JsonValue> = {
              specId,
              sha,
              blockIndex: block.blockIndex,
              assertionIndex: i,
              url: block.url,
              assertion,
              resetAtMs: err.resetAtMs,
            };
            journal.append("stage.verify.quota", quotaPayload);

            const evidence: VerifyEvidence = {
              specId,
              sha,
              declared: true,
              parseError: null,
              cli: cliEvidence,
              browser: browserEvidence,
              firstFailure: null,
              evidenceDir,
              needsHuman: false,
              quotaResetAtMs: err.resetAtMs,
            };
            const resultPayload: Record<string, JsonValue> = { specId, sha, outcome: "quota", needsHuman: false };
            journal.append("stage.verify.result", resultPayload);
            return { outcome: "quota", evidence };
          }
          throw err;
        }

        const detailHash = writeTextEvidence(evidenceDir, assertResult.detail, DEFAULT_EVIDENCE_TEXT_BYTES);
        // B-3: whatever the verifier returns is stored honestly; a session
        // that could not produce a screenshot leaves this null rather than
        // faking one.
        const screenshotHash = assertResult.screenshotPngBase64
          ? writeEvidenceFile(evidenceDir, Buffer.from(assertResult.screenshotPngBase64, "base64"), ".png")
          : null;

        const entry: VerifyBrowserEvidence = {
          blockIndex: block.blockIndex,
          assertionIndex: i,
          url: block.url,
          assertion,
          pass: assertResult.pass,
          detailHash,
          screenshotHash,
        };
        browserEvidence.push(entry);

        const browserPayload: Record<string, JsonValue> = {
          specId,
          sha,
          blockIndex: entry.blockIndex,
          assertionIndex: entry.assertionIndex,
          url: entry.url,
          assertion,
          pass: entry.pass,
          detailHash,
          screenshotHash,
        };
        journal.append("stage.verify.browser", browserPayload);

        if (!assertResult.pass && firstFailure === null) {
          firstFailure = {
            kind: "browser",
            description: `verify:browser block ${entry.blockIndex + 1}, assertion ${entry.assertionIndex + 1} (${entry.url}): ${assertion}`,
            evidenceHash: detailHash,
          };
        }
      }
    }

    // --- B-4: verdict -------------------------------------------------------
    const outcome: VerifyOutcome = firstFailure ? "failed" : "passed";
    const needsHuman = outcome === "failed" && isReVerification;
    const evidence: VerifyEvidence = {
      specId,
      sha,
      declared: true,
      parseError: null,
      cli: cliEvidence,
      browser: browserEvidence,
      firstFailure,
      evidenceDir,
      needsHuman,
      quotaResetAtMs: null,
    };
    const resultPayload: Record<string, JsonValue> = {
      specId,
      sha,
      outcome,
      needsHuman,
      firstFailure: firstFailure?.description ?? null,
    };
    journal.append("stage.verify.result", resultPayload);
    return { outcome, evidence };
  } finally {
    runner.removeWorktree(worktreePath);
  }
}
