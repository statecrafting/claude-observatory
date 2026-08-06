// The shepherd stage (spec 018): the third pipeline stage, from open PR to
// merged. Polls the PR's checks by head sha with a watch-loop discipline
// (multiplicative backoff, change-only journaling, a typed abort on a
// response that loses required fields, a per-attempt deadline) (B-1);
// remediates a failed required check with at most two fresh sessions fed the
// failing job log tail, each on the same branch, instructed to fix and push
// through the governed gate (B-2); re-resolves the head sha after every
// remediation push and restarts the watch loop there, never mixing checks
// from a stale sha into a live attempt (B-3); merges when every required
// check is green, deletes the remote branch, and confirms the default
// branch actually contains the merge sha before the stage passes (B-4); and
// reports a remediation session classified `quota` upward rather than
// attempting to park the run itself, since the stage does not own the run
// (B-5, see this spec's Resolved decisions).
//
// Git reads and session driving reuse spec 016's own Runner seam verbatim
// (imported from build.ts); GitHub reads and mutations reuse spec 017's own
// GitHubClient seam, extended additively there rather than duplicated here
// (checkRunsForSha, jobLogTail, mergePr, branchContains,
// deleteRemoteBranch). Tests drive this module against scripted fake
// Runner/GitHubClient/Clock implementations (fixtures), never a real
// `claude` or `gh` process, mirroring spec 014's and spec 017's own
// convention.
import type { JournalHandle, JsonValue } from "../journal";
import { sha256Hex } from "../journal";
import { GATE_COMMANDS, DEFAULT_BASE_BRANCH, gateCommandsFor, type Runner } from "./build";
import type { GitHubClient, CheckRun, MergeMethod } from "./ship";

// --- clock seam (B-1: no real sleeps in unit tests) --------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms: number) => Bun.sleep(ms),
  };
}

// --- statusless abort (B-1) --------------------------------------------------
//
// A typed error, never a guess: a check-runs response whose entries are
// missing id/name/status, or carry a conclusion or required flag of the
// wrong type, is a shape that cannot terminate a watch loop honestly. This
// mirrors the statecraft-cli watch_loop pattern of aborting rather than
// polling on faith.
export class StatuslessAbortError extends Error {
  constructor(sha: string, detail: string) {
    super(`shepherd: check-runs response for sha "${sha}" lost required fields (${detail}); aborting`);
    this.name = "StatuslessAbortError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// checkRunsForSha's return type is CheckRun[] at compile time, but the
// GitHubClient seam's whole point is that a production implementation reads
// this shape off an external process; validated at the boundary, not
// trusted from the type system alone.
function validateCheckRuns(sha: string, raw: readonly CheckRun[]): CheckRun[] {
  const out: CheckRun[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (!isPlainObject(entry)) {
      throw new StatuslessAbortError(sha, `a check-run entry was not an object (${JSON.stringify(entry)})`);
    }
    const { id, name, status, conclusion, required } = entry;
    if (typeof id !== "number" || typeof name !== "string" || typeof status !== "string") {
      throw new StatuslessAbortError(sha, `a check-run entry was missing id/name/status (${JSON.stringify(entry)})`);
    }
    if (conclusion !== null && conclusion !== undefined && typeof conclusion !== "string") {
      throw new StatuslessAbortError(sha, `a check-run entry's conclusion was neither string nor null (id ${id})`);
    }
    if (required !== undefined && typeof required !== "boolean") {
      throw new StatuslessAbortError(sha, `a check-run entry's required flag was not boolean (id ${id})`);
    }
    out.push({ id, name, status, conclusion: typeof conclusion === "string" ? conclusion : null, required });
  }
  return out;
}

// A run with `required` absent or `true` counts toward the merge gate; only
// an explicit `false` excludes it (ship.ts's own GitHubClient doc comment,
// see this spec's Resolved decisions D-1).
function isRequiredCheck(c: CheckRun): boolean {
  return c.required !== false;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function isPassingConclusion(conclusion: string | null): boolean {
  return conclusion !== null && PASSING_CONCLUSIONS.has(conclusion);
}

// --- watch loop (B-1) ---------------------------------------------------------

export type WatchLoopResult =
  | { readonly kind: "green"; readonly checks: readonly CheckRun[] }
  | { readonly kind: "failed"; readonly checks: readonly CheckRun[]; readonly failing: readonly CheckRun[] }
  | { readonly kind: "timeout"; readonly checks: readonly CheckRun[] };

export interface RunWatchLoopOptions {
  readonly gh: GitHubClient;
  readonly sha: string;
  readonly clock: Clock;
  readonly journal: JournalHandle;
  readonly specId: string;
  readonly round: number;
  readonly pollBaseMs: number;
  readonly pollFactor: number;
  readonly pollCapMs: number;
  readonly deadlineMs: number;
}

function stateKeyFor(checks: readonly CheckRun[]): string {
  return checks
    .map((c) => `${c.id}:${c.status}:${c.conclusion ?? "null"}:${isRequiredCheck(c)}`)
    .sort()
    .join(",");
}

function checkRunToJson(c: CheckRun): Record<string, JsonValue> {
  return { id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, required: isRequiredCheck(c) };
}

// Polls checkRunsForSha(sha) with multiplicative backoff (base 15 s, factor
// 1.5, cap 120 s), journaling only when the observed check-run state
// actually changes, until every required check has completed or the
// per-attempt deadline elapses. Throws StatuslessAbortError, typed, rather
// than ever treating a malformed response as "still pending".
export async function runWatchLoop(options: RunWatchLoopOptions): Promise<WatchLoopResult> {
  const { gh, sha, clock, journal, specId, round, pollBaseMs, pollFactor, pollCapMs, deadlineMs } = options;

  const startedMs = clock.now();
  let intervalMs = pollBaseMs;
  let lastStateKey: string | null = null;
  let lastChecks: readonly CheckRun[] = [];

  while (true) {
    const elapsed = clock.now() - startedMs;
    if (elapsed >= deadlineMs) {
      return { kind: "timeout", checks: lastChecks };
    }

    const raw = gh.checkRunsForSha(sha);
    const checks = validateCheckRuns(sha, raw);
    lastChecks = checks;

    const stateKey = stateKeyFor(checks);
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      const payload: Record<string, JsonValue> = { specId, round, sha, checks: checks.map(checkRunToJson) };
      journal.append("stage.shepherd.watch", payload);
    }

    const required = checks.filter(isRequiredCheck);
    const hasResolvableState = checks.length > 0 && required.every((c) => c.status === "completed");
    if (hasResolvableState) {
      const failing = required.filter((c) => !isPassingConclusion(c.conclusion));
      if (failing.length === 0) return { kind: "green", checks };
      return { kind: "failed", checks, failing };
    }

    const remaining = deadlineMs - (clock.now() - startedMs);
    const sleepMs = Math.max(0, Math.min(intervalMs, remaining));
    if (sleepMs > 0) await clock.sleep(sleepMs);
    intervalMs = Math.min(pollCapMs, intervalMs * pollFactor);
  }
}

// --- remediation prompt (B-2) -------------------------------------------------

export const SHEPHERD_PROMPT_VERSION = 1;

export interface ShepherdFailureDetail {
  readonly name: string;
  readonly conclusion: string | null;
  readonly logTail: string;
}

export interface ShepherdRemediationPromptParams {
  readonly specBody: string;
  readonly branch: string;
  readonly attemptNumber: number;
  readonly maxRemediations: number;
  readonly failing: readonly ShepherdFailureDetail[];
  // 016 D-10 carried through (D-8): the target's own gate program, so a
  // remediation session on a non-TypeScript target is not told to run bun.
  readonly gateCommands?: readonly (readonly string[])[];
}

export function buildRemediationPrompt(params: ShepherdRemediationPromptParams): string {
  const { specBody, branch, attemptNumber, maxRemediations, failing } = params;
  const gateList = (params.gateCommands ?? GATE_COMMANDS).map((cmd) => `  - \`${cmd.join(" ")}\``).join("\n");
  const failureSection = failing
    .map((f) => `### \`${f.name}\` (conclusion: ${f.conclusion ?? "none"})\n\nlog tail:\n${f.logTail}`)
    .join("\n\n");

  return `You are remediating a failed CI run on the current branch ("${branch}"),
in this one session. Shepherd remediation prompt template version: ${SHEPHERD_PROMPT_VERSION}.
This is remediation attempt ${attemptNumber} of at most ${maxRemediations} for
this spec's shepherd stage.

## The spec this branch implements, verbatim

${specBody}

## What failed

${failureSection}

## What to do

Diagnose and fix the failure above, then commit and push your fix to this
same branch ("${branch}"). The pull request for this branch already exists;
do not open a new one and do not force-push over history other than your own
fix. Push through the governed gate below; every command must exit 0 before
you are done:

${gateList}

## House style

No em dashes (U+2014) anywhere: chat, code, comments, commit messages.
No AI attribution in commit messages or code. Match the surrounding code's
style.

If the failure is not something you can fix (for example, it requires a
human decision), say so plainly and stop rather than forcing a change
through.
`;
}

// --- evidence and outcome (FR-002) --------------------------------------------

export type ShepherdOutcome = "passed" | "failed" | "blocked" | "quota";

export interface ShepherdCheckEvidence {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly required: boolean;
}

export interface ShepherdWatchAttemptEvidence {
  readonly round: number;
  readonly sha: string;
  readonly outcome: "green" | "failed" | "timeout";
  readonly checks: readonly ShepherdCheckEvidence[];
}

export interface ShepherdFailingCheckEvidence {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly logTailHash: string;
}

export interface ShepherdRemediationEvidence {
  readonly attempt: number;
  readonly headSha: string;
  readonly failing: readonly ShepherdFailingCheckEvidence[];
  readonly sessionId: string | null;
  readonly classification: string;
  readonly costMicroUsd: number | null;
  readonly durationMs: number;
}

export interface ShepherdEvidence {
  readonly specId: string;
  readonly branch: string;
  readonly prNumber: number | null;
  readonly watchAttempts: readonly ShepherdWatchAttemptEvidence[];
  readonly remediations: readonly ShepherdRemediationEvidence[];
  readonly mergeSha: string | null;
  readonly branchContainsConfirmed: boolean | null;
  readonly needsHuman: boolean;
  readonly statuslessAbort: string | null;
}

export interface ShepherdResult {
  readonly outcome: ShepherdOutcome;
  readonly evidence: ShepherdEvidence;
}

function toCheckEvidence(c: CheckRun): ShepherdCheckEvidence {
  return { id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, required: isRequiredCheck(c) };
}

function toAttemptEvidence(round: number, sha: string, watch: WatchLoopResult): ShepherdWatchAttemptEvidence {
  return { round, sha, outcome: watch.kind, checks: watch.checks.map(toCheckEvidence) };
}

// --- defaults ------------------------------------------------------------------

export const DEFAULT_POLL_BASE_MS = 15_000;
export const DEFAULT_POLL_FACTOR = 1.5;
export const DEFAULT_POLL_CAP_MS = 120_000;
export const DEFAULT_WATCH_DEADLINE_MS = 45 * 60_000;
export const DEFAULT_MAX_REMEDIATIONS = 2;
export const DEFAULT_LOG_TAIL_BYTES = 16 * 1024;
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash";
export const DEFAULT_SHEPHERD_REMEDIATION_DEADLINE_MS = 30 * 60_000;
export const DEFAULT_SHEPHERD_MAX_TURNS = 40;

// --- the stage (B-1 through B-5) ----------------------------------------------

export interface RunShepherdStageOptions {
  readonly runner: Runner;
  readonly gh: GitHubClient;
  readonly specId: string;
  readonly journal: JournalHandle;
  readonly clock?: Clock;
  readonly defaultBranch?: string;
  readonly mergeMethod?: MergeMethod;
  readonly maxRemediations?: number;
  readonly pollBaseMs?: number;
  readonly pollFactor?: number;
  readonly pollCapMs?: number;
  readonly watchDeadlineMs?: number;
  readonly logTailBytes?: number;
  readonly remediationDeadlineMs?: number;
  readonly maxTurns?: number;
  readonly model?: string;
}

export async function runShepherdStage(options: RunShepherdStageOptions): Promise<ShepherdResult> {
  const { runner, gh, specId, journal } = options;
  const clock = options.clock ?? createSystemClock();
  const defaultBranch = options.defaultBranch ?? DEFAULT_BASE_BRANCH;
  const mergeMethod = options.mergeMethod ?? DEFAULT_MERGE_METHOD;
  const maxRemediations = options.maxRemediations ?? DEFAULT_MAX_REMEDIATIONS;
  const pollBaseMs = options.pollBaseMs ?? DEFAULT_POLL_BASE_MS;
  const pollFactor = options.pollFactor ?? DEFAULT_POLL_FACTOR;
  const pollCapMs = options.pollCapMs ?? DEFAULT_POLL_CAP_MS;
  const watchDeadlineMs = options.watchDeadlineMs ?? DEFAULT_WATCH_DEADLINE_MS;
  const logTailBytes = options.logTailBytes ?? DEFAULT_LOG_TAIL_BYTES;
  const remediationDeadlineMs = options.remediationDeadlineMs ?? DEFAULT_SHEPHERD_REMEDIATION_DEADLINE_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_SHEPHERD_MAX_TURNS;

  const branch = runner.currentBranch();
  const specPath = `specs/${specId}/spec.md`;

  const attempts: ShepherdWatchAttemptEvidence[] = [];
  const remediations: ShepherdRemediationEvidence[] = [];
  let mergeSha: string | null = null;
  let branchContainsConfirmed: boolean | null = null;

  function finish(outcome: ShepherdOutcome, needsHuman: boolean, statuslessAbort: string | null, prNumber: number | null): ShepherdResult {
    const evidence: ShepherdEvidence = {
      specId,
      branch,
      prNumber,
      watchAttempts: attempts,
      remediations,
      mergeSha,
      branchContainsConfirmed,
      needsHuman,
      statuslessAbort,
    };
    const resultPayload: Record<string, JsonValue> = {
      specId,
      branch,
      outcome,
      prNumber,
      mergeSha,
      watchAttempts: attempts.length,
      remediationsUsed: remediations.length,
      needsHuman,
      statuslessAbort,
    };
    journal.append("stage.shepherd.result", resultPayload);
    return { outcome, evidence };
  }

  const pr = gh.prForBranch(branch);
  if (!pr) {
    return finish("failed", true, null, null);
  }

  let headSha = pr.headSha;
  let round = 0;

  while (true) {
    round++;
    let watch: WatchLoopResult;
    try {
      watch = await runWatchLoop({
        gh,
        sha: headSha,
        clock,
        journal,
        specId,
        round,
        pollBaseMs,
        pollFactor,
        pollCapMs,
        deadlineMs: watchDeadlineMs,
      });
    } catch (err) {
      if (err instanceof StatuslessAbortError) {
        journal.append("stage.shepherd.statusless-abort", { specId, round, sha: headSha, message: err.message });
        return finish("failed", true, err.message, pr.number);
      }
      throw err;
    }

    attempts.push(toAttemptEvidence(round, headSha, watch));

    if (watch.kind === "timeout") {
      return finish("failed", true, null, pr.number);
    }

    if (watch.kind === "green") {
      const mergeOutcome = gh.mergePr(pr.number, mergeMethod);
      mergeSha = mergeOutcome.mergeSha;
      journal.append("stage.shepherd.merge", { specId, prNumber: pr.number, method: mergeMethod, mergeSha });

      gh.deleteRemoteBranch(branch);
      journal.append("stage.shepherd.branch-deleted", { specId, branch });

      branchContainsConfirmed = gh.branchContains(defaultBranch, mergeSha);
      journal.append("stage.shepherd.branch-contains", {
        specId,
        defaultBranch,
        mergeSha,
        contains: branchContainsConfirmed,
      });

      if (!branchContainsConfirmed) {
        return finish("failed", true, null, pr.number);
      }
      return finish("passed", false, null, pr.number);
    }

    // watch.kind === "failed": a required check completed red.
    if (remediations.length >= maxRemediations) {
      return finish("failed", true, null, pr.number);
    }

    const attemptNumber = remediations.length + 1;
    const failing = watch.failing;
    const failureDetails: ShepherdFailureDetail[] = [];
    const failingEvidence: ShepherdFailingCheckEvidence[] = [];
    for (const check of failing) {
      const logTail = gh.jobLogTail(check.id, logTailBytes);
      const logTailHash = sha256Hex(logTail);
      failureDetails.push({ name: check.name, conclusion: check.conclusion, logTail });
      failingEvidence.push({ id: check.id, name: check.name, conclusion: check.conclusion, logTailHash });
    }
    journal.append("stage.shepherd.remediation-evidence", {
      specId,
      attempt: attemptNumber,
      headSha,
      failing: failingEvidence.map((f) => ({ id: f.id, name: f.name, conclusion: f.conclusion, logTailHash: f.logTailHash })),
    });

    const specBody = runner.readFile(specPath);
    const prompt = buildRemediationPrompt({
      specBody,
      branch,
      attemptNumber,
      maxRemediations,
      failing: failureDetails,
      gateCommands: gateCommandsFor(runner),
    });
    journal.append("stage.shepherd.prompt", { specId, attempt: attemptNumber, promptVersion: SHEPHERD_PROMPT_VERSION });

    const session = await runner.runSession({
      prompt,
      timeoutMs: remediationDeadlineMs,
      maxTurns,
      model: options.model,
      journal,
    });

    remediations.push({
      attempt: attemptNumber,
      headSha,
      failing: failingEvidence,
      sessionId: session.sessionId,
      classification: session.classification.kind,
      costMicroUsd: session.costMicroUsd,
      durationMs: session.durationMs,
    });

    if (session.classification.kind === "hook-blocked") {
      return finish("blocked", false, null, pr.number);
    }

    if (session.classification.kind === "quota") {
      return finish("quota", false, null, pr.number);
    }

    // B-3: re-resolve the head sha after the remediation's push, and restart
    // the watch loop on it; a stale sha's checks are never polled again.
    const updatedPr = gh.prForBranch(branch);
    headSha = updatedPr ? updatedPr.headSha : headSha;
    journal.append("stage.shepherd.head-sha", { specId, attempt: attemptNumber, headSha });
  }
}
