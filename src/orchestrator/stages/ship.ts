// The ship stage (spec 017): the second pipeline stage. Drives the target
// repo's own `/ship` skill in a session rather than reimplementing its gate
// (B-1); the orchestrator itself never runs `gh pr create`, that stays
// inside `/ship`'s own governed, hook-enforced sequence. A session that ends
// hook-blocked (spec 014 classification) is terminal for the stage: it maps
// to outcome "blocked", carries the refusal text as evidence, and is never
// resolved here (the coherence-guard rule, adversarial-prompt-refusal.md:
// the daemon decides loop-back or a human-approved waiver, this stage never
// self-approves one) (B-2). After a session actually ran, the result is
// verified from the outside through a typed GitHub client seam (FR-001):
// the PR exists for the branch, its head sha matches the local branch head,
// CI was triggered, and no session-link URL or AI attribution marker
// appears in the PR title, body, or any of its commits; a mismatch fails
// the stage with the diff as evidence (B-3). Retrying a ship whose PR
// already exists and already verifies is a pass without driving a second
// session (B-4).
//
// Git reads (current branch, local head sha) and session driving reuse
// spec 016's own Runner seam verbatim (imported from build.ts), rather than
// a second, duplicate seam: this stage's only new surface is GitHubClient,
// a typed read seam over the `gh` CLI (FR-001). Its production
// implementation shells out to `gh pr view --json` and `gh api`; tests
// drive this module against a scripted fake GitHubClient (fixtures), never
// the real `gh` binary, mirroring spec 014's own "never spawn the real
// claude in tests" convention.
import type { JournalHandle, JsonValue } from "../journal";
import type { Runner } from "./build";
import type { SessionResult } from "../session";

// --- GitHubClient seam (FR-001) --------------------------------------------

export interface GitHubPr {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly body: string;
  readonly title: string;
}

export interface GitHubCommit {
  readonly sha: string;
  readonly message: string;
}

// --- shepherd extensions (spec 018, additive) --------------------------------
//
// The shepherd stage (spec 018) watches checks by sha, remediates a red run,
// and merges when green; it reuses this client seam rather than declaring a
// second one (see specs/017-stage-ship/spec.md's Resolved decisions D-7).
// `required` is optional because this seam's `checkRunsForSha` cannot always
// resolve branch-protection membership; a run with `required` absent or
// `true` counts toward the merge gate, only an explicit `false` excludes it
// (spec 018's own Resolved decisions).

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly required?: boolean;
}

export type MergeMethod = "squash" | "merge" | "rebase";

export interface MergeOutcome {
  readonly mergeSha: string;
}

export interface GitHubClient {
  prForBranch(branch: string): GitHubPr | null;
  commitsForPr(number: number): readonly GitHubCommit[];
  checksTriggered(headSha: string): boolean;
  // --- shepherd extensions (spec 018) ---
  checkRunsForSha(sha: string): readonly CheckRun[];
  jobLogTail(runId: number, maxBytes: number): string;
  mergePr(number: number, method: MergeMethod): MergeOutcome;
  branchContains(branch: string, sha: string): boolean;
  deleteRemoteBranch(branch: string): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function runGhSync(cwd: string, cmd: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd as string[], { cwd });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function tailText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

export interface CreateGitHubClientParams {
  readonly repoDir: string;
  readonly ghBin?: string;
}

// The production GitHubClient: every read shells out to the `gh` CLI (never
// the GitHub REST API directly, and never a mutation), following the same
// Bun.spawnSync seam pattern build.ts's createProcessRunner already
// established. Never constructed by ship.test.ts's fixture flows; those
// supply a scripted fake GitHubClient instead (FR-001's own "no live gh in
// unit tests").
export function createProcessGitHubClient(params: CreateGitHubClientParams): GitHubClient {
  const { repoDir } = params;
  const ghBin = params.ghBin ?? "gh";

  return {
    prForBranch(branch: string): GitHubPr | null {
      const result = runGhSync(repoDir, [
        ghBin,
        "pr",
        "view",
        branch,
        "--json",
        "number,url,headRefOid,body,title",
      ]);
      if (result.exitCode !== 0) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return null;
      }
      if (!isRecord(parsed)) return null;
      const { number, url, headRefOid, body, title } = parsed;
      if (typeof number !== "number" || typeof url !== "string" || typeof headRefOid !== "string") return null;
      return {
        number,
        url,
        headSha: headRefOid,
        body: typeof body === "string" ? body : "",
        title: typeof title === "string" ? title : "",
      };
    },

    commitsForPr(number: number): readonly GitHubCommit[] {
      const result = runGhSync(repoDir, [ghBin, "pr", "view", String(number), "--json", "commits"]);
      if (result.exitCode !== 0) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return [];
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.commits)) return [];
      const commits: GitHubCommit[] = [];
      for (const raw of parsed.commits) {
        if (!isRecord(raw) || typeof raw.oid !== "string") continue;
        const headline = typeof raw.messageHeadline === "string" ? raw.messageHeadline : "";
        const body = typeof raw.messageBody === "string" ? raw.messageBody : "";
        commits.push({ sha: raw.oid, message: body ? `${headline}\n${body}` : headline });
      }
      return commits;
    },

    checksTriggered(headSha: string): boolean {
      const result = runGhSync(repoDir, [ghBin, "api", `repos/{owner}/{repo}/commits/${headSha}/check-runs`]);
      if (result.exitCode !== 0) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return false;
      }
      return isRecord(parsed) && typeof parsed.total_count === "number" && parsed.total_count > 0;
    },

    // --- shepherd extensions (spec 018) ---

    checkRunsForSha(sha: string): readonly CheckRun[] {
      const result = runGhSync(repoDir, [ghBin, "api", `repos/{owner}/{repo}/commits/${sha}/check-runs`]);
      if (result.exitCode !== 0) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return [];
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.check_runs)) return [];
      const runs: CheckRun[] = [];
      for (const raw of parsed.check_runs) {
        if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.name !== "string") continue;
        const status = typeof raw.status === "string" ? raw.status : "unknown";
        const conclusion = typeof raw.conclusion === "string" ? raw.conclusion : null;
        // This endpoint carries no branch-protection membership; `required`
        // is left unset here (the seam's own default reading treats an
        // unset flag as required, see the GitHubClient doc comment above).
        runs.push({ id: raw.id, name: raw.name, status, conclusion });
      }
      return runs;
    },

    jobLogTail(runId: number, maxBytes: number): string {
      const result = runGhSync(repoDir, [ghBin, "run", "view", String(runId), "--log"]);
      if (result.exitCode !== 0) return tailText(result.stderr, maxBytes);
      return tailText(result.stdout, maxBytes);
    },

    mergePr(number: number, method: MergeMethod): MergeOutcome {
      const result = runGhSync(repoDir, [
        ghBin,
        "api",
        "-X",
        "PUT",
        `repos/{owner}/{repo}/pulls/${number}/merge`,
        "-f",
        `merge_method=${method}`,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`ship: gh pr merge (#${number}, ${method}) failed: ${result.stderr.trim()}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(`ship: gh pr merge (#${number}, ${method}) returned unparseable output`);
      }
      if (!isRecord(parsed) || typeof parsed.sha !== "string") {
        throw new Error(`ship: gh pr merge (#${number}, ${method}) response carried no merge sha`);
      }
      return { mergeSha: parsed.sha };
    },

    branchContains(branch: string, sha: string): boolean {
      const result = runGhSync(repoDir, [ghBin, "api", `repos/{owner}/{repo}/compare/${branch}...${sha}`]);
      if (result.exitCode !== 0) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return false;
      }
      // ahead_by counts commits reachable from `sha` but not from `branch`;
      // zero means `sha` is already fully contained in `branch`'s history.
      return isRecord(parsed) && typeof parsed.ahead_by === "number" && parsed.ahead_by === 0;
    },

    deleteRemoteBranch(branch: string): void {
      const result = runGhSync(repoDir, [ghBin, "api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${branch}`]);
      if (result.exitCode !== 0) {
        throw new Error(`ship: deleting remote branch "${branch}" failed: ${result.stderr.trim()}`);
      }
    },
  };
}

// --- forbidden markers (B-3: no session link, no AI attribution) -----------

const SESSION_LINK_PATTERN = /claude\.ai\/code\/session/i;
const CO_AUTHORED_BY_CLAUDE_PATTERN = /co-authored-by:\s*claude/i;
const GENERATED_WITH_PATTERN = /generated with/i;
const ROBOT_EMOJI_PATTERN = /\u{1F916}/u;

function findForbiddenMarkers(text: string): string[] {
  const hits: string[] = [];
  if (SESSION_LINK_PATTERN.test(text)) hits.push("a session-link URL (claude.ai/code/session)");
  if (CO_AUTHORED_BY_CLAUDE_PATTERN.test(text)) hits.push('AI attribution ("Co-Authored-By: Claude")');
  if (GENERATED_WITH_PATTERN.test(text)) hits.push('AI attribution ("Generated with")');
  if (ROBOT_EMOJI_PATTERN.test(text)) hits.push("AI attribution (a robot emoji)");
  return hits;
}

function markerDiff(label: string, text: string): string[] {
  return findForbiddenMarkers(text).map((hit) => `${label} contains ${hit}`);
}

// --- outside verification (B-3, B-4) ----------------------------------------

export interface VerificationResult {
  readonly ok: boolean;
  readonly diff: readonly string[];
  readonly ciTriggered: boolean;
}

// Every check runs and every finding is collected, rather than stopping at
// the first mismatch: the diff in evidence should say everything that is
// wrong, not just the first thing found.
function verifyOutside(gh: GitHubClient, pr: GitHubPr, localHeadSha: string): VerificationResult {
  const diff: string[] = [];

  if (pr.headSha !== localHeadSha) {
    diff.push(`PR head sha "${pr.headSha}" does not match the local branch head "${localHeadSha}"`);
  }

  const ciTriggered = gh.checksTriggered(pr.headSha);
  if (!ciTriggered) {
    diff.push(`CI was not triggered for head sha "${pr.headSha}"`);
  }

  diff.push(...markerDiff("PR title", pr.title));
  diff.push(...markerDiff("PR body", pr.body));
  for (const commit of gh.commitsForPr(pr.number)) {
    diff.push(...markerDiff(`commit ${commit.sha}`, commit.message));
  }

  return { ok: diff.length === 0, diff, ciTriggered };
}

// --- prompt template (B-1) --------------------------------------------------

export const SHIP_PROMPT_VERSION = 1;

export interface ShipPromptParams {
  readonly branch: string;
}

export function buildShipPrompt(params: ShipPromptParams): string {
  const { branch } = params;
  return `You are shipping the current branch ("${branch}") of this repository,
in this one session. Ship prompt template version: ${SHIP_PROMPT_VERSION}.

## What to do

Run this repository's own \`/ship\` skill for the current branch: run the
governed gate locally, review the diff, commit with a conventional message
on this branch, push, and open the pull request through \`gh pr create\`.
Follow \`/ship\`'s own steps and checkpoints exactly; do not invent a
different sequence and do not bypass its hooks. You never construct your
own \`gh pr create\` call outside of \`/ship\`'s governed sequence.

## PR title and body conventions

- Title: a conventional-commit-style subject (\`type(scope): subject\`).
- Body: two sections, \`## Summary\` and \`## Testing\`, each a short
  bulleted list.
- No session-link URLs (no \`claude.ai/code/session...\`) anywhere in the
  title, the body, or any commit message.
- No AI attribution anywhere (no "Generated with", no
  \`Co-Authored-By: Claude\`, no robot emoji) in the title, the body, or any
  commit message.

## House style

No em dashes (U+2014) anywhere: chat, code, comments, commit messages, PR
title, PR body. Match the surrounding repository's style.
`;
}

// --- session evidence (FR-002) ----------------------------------------------

export interface ShipSessionEvidence {
  readonly sessionId: string | null;
  readonly classification: string;
  readonly detail: string;
  readonly stderrTail: string;
  readonly costMicroUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number;
}

function toShipSessionEvidence(result: SessionResult): ShipSessionEvidence {
  return {
    sessionId: result.sessionId,
    classification: result.classification.kind,
    detail: result.classification.detail,
    stderrTail: result.stderrTail,
    costMicroUsd: result.costMicroUsd,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
  };
}

// --- evidence and outcome (FR-002) ------------------------------------------

export type ShipOutcome = "passed" | "failed" | "blocked";

export interface ShipPrEvidence {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
}

export interface ShipEvidence {
  readonly specId: string;
  readonly branch: string;
  readonly localHeadSha: string;
  readonly promptVersion: number | null;
  readonly sessions: readonly ShipSessionEvidence[];
  readonly pr: ShipPrEvidence | null;
  readonly ciTriggered: boolean | null;
  // Always null: the GitHubClient seam (FR-001) exposes only
  // checksTriggered(headSha): boolean, with no run id, so "when visible"
  // never resolves through this seam version (see Resolved decisions).
  readonly ciRunId: string | null;
  readonly verification: VerificationResult | null;
  readonly costMicroUsd: number | null;
}

export interface ShipResult {
  readonly outcome: ShipOutcome;
  readonly evidence: ShipEvidence;
}

function toPrEvidence(pr: GitHubPr): ShipPrEvidence {
  return { number: pr.number, url: pr.url, headSha: pr.headSha };
}

// --- defaults ----------------------------------------------------------------

export const DEFAULT_SHIP_DEADLINE_MS = 15 * 60_000;
export const DEFAULT_SHIP_MAX_TURNS = 30;

// --- the stage (B-1 through B-4) --------------------------------------------

export interface RunShipStageOptions {
  readonly runner: Runner;
  readonly gh: GitHubClient;
  readonly specId: string;
  readonly journal: JournalHandle;
  readonly deadlineMs?: number;
  readonly maxTurns?: number;
  readonly model?: string;
}

export async function runShipStage(options: RunShipStageOptions): Promise<ShipResult> {
  const { runner, gh, specId, journal } = options;
  const deadlineMs = options.deadlineMs ?? DEFAULT_SHIP_DEADLINE_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_SHIP_MAX_TURNS;

  const branch = runner.currentBranch();
  const localHeadSha = runner.headSha();

  // --- B-4: idempotency pre-check. A matching PR already open for this
  // branch means a prior attempt already shipped it; pass without driving
  // a second session rather than risk /ship's own gh pr create tripping
  // over an existing PR. A PR that exists but does not yet verify (e.g. new
  // local commits since it opened) falls through to a normal session drive;
  // only the post-session check in B-3 below is allowed to fail the stage.
  const precheckPr = gh.prForBranch(branch);
  if (precheckPr) {
    const precheckVerification = verifyOutside(gh, precheckPr, localHeadSha);
    const idempotentPayload: Record<string, JsonValue> = {
      specId,
      branch,
      prNumber: precheckPr.number,
      ok: precheckVerification.ok,
      diff: [...precheckVerification.diff],
    };
    journal.append("stage.ship.idempotent-check", idempotentPayload);

    if (precheckVerification.ok) {
      const evidence: ShipEvidence = {
        specId,
        branch,
        localHeadSha,
        promptVersion: null,
        sessions: [],
        pr: toPrEvidence(precheckPr),
        ciTriggered: precheckVerification.ciTriggered,
        ciRunId: null,
        verification: precheckVerification,
        costMicroUsd: null,
      };
      const resultPayload: Record<string, JsonValue> = {
        specId,
        branch,
        outcome: "passed",
        prNumber: precheckPr.number,
        sessionIds: [],
      };
      journal.append("stage.ship.result", resultPayload);
      return { outcome: "passed", evidence };
    }
  }

  // --- B-1: drive the /ship session -------------------------------------
  const prompt = buildShipPrompt({ branch });
  const promptPayload: Record<string, JsonValue> = { specId, branch, promptVersion: SHIP_PROMPT_VERSION };
  journal.append("stage.ship.prompt", promptPayload);

  const session = await runner.runSession({ prompt, timeoutMs: deadlineMs, maxTurns, model: options.model, journal });
  const sessionEvidence = toShipSessionEvidence(session);

  // --- B-2: a hook-blocked session is terminal for the stage. No outside
  // verification (B-3) is attempted in response: a refusal is not a claim
  // about the state of a PR, and treating it as one would risk misreading a
  // stale, unrelated PR as this attempt's result. AC-2's "no PR-existence
  // check attempted" is this: the B-4 idempotency pre-check above already
  // ran (it has to, to decide whether a session was needed at all), but
  // once blocked, no further GitHubClient call (a second prForBranch,
  // commitsForPr, checksTriggered) is ever made (see Resolved decisions
  // D-3).
  if (session.classification.kind === "hook-blocked") {
    const evidence: ShipEvidence = {
      specId,
      branch,
      localHeadSha,
      promptVersion: SHIP_PROMPT_VERSION,
      sessions: [sessionEvidence],
      pr: precheckPr ? toPrEvidence(precheckPr) : null,
      ciTriggered: null,
      ciRunId: null,
      verification: null,
      costMicroUsd: sessionEvidence.costMicroUsd,
    };
    const resultPayload: Record<string, JsonValue> = {
      specId,
      branch,
      outcome: "blocked",
      sessionIds: [sessionEvidence.sessionId],
      refusalDetail: sessionEvidence.detail,
    };
    journal.append("stage.ship.result", resultPayload);
    return { outcome: "blocked", evidence };
  }

  // --- B-3: outside verification, after the session -----------------------
  const pr = gh.prForBranch(branch);
  const verification: VerificationResult = pr
    ? verifyOutside(gh, pr, localHeadSha)
    : { ok: false, diff: [`no pull request found for branch "${branch}"`], ciTriggered: false };

  const verificationPayload: Record<string, JsonValue> = {
    specId,
    branch,
    prNumber: pr?.number ?? null,
    ok: verification.ok,
    diff: [...verification.diff],
  };
  journal.append("stage.ship.verification", verificationPayload);

  const outcome: ShipOutcome = verification.ok ? "passed" : "failed";
  const evidence: ShipEvidence = {
    specId,
    branch,
    localHeadSha,
    promptVersion: SHIP_PROMPT_VERSION,
    sessions: [sessionEvidence],
    pr: pr ? toPrEvidence(pr) : null,
    ciTriggered: pr ? verification.ciTriggered : null,
    ciRunId: null,
    verification,
    costMicroUsd: sessionEvidence.costMicroUsd,
  };
  const resultPayload: Record<string, JsonValue> = {
    specId,
    branch,
    outcome,
    prNumber: pr?.number ?? null,
    sessionIds: [sessionEvidence.sessionId],
  };
  journal.append("stage.ship.result", resultPayload);

  return { outcome, evidence };
}
