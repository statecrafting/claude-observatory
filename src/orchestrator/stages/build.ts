// The build stage (spec 016): the first pipeline stage. Preflights refuse
// before anything starts (B-1); the orchestrator itself creates the branch
// and flips the target spec's frontmatter to in-progress before any session
// runs (B-2, "orchestrator-owned bracket"); a versioned prompt assembles the
// spec body, the backlog protocol, and scope-matched decisions (B-3); one
// fresh session drives the implementation, with at most one remediation
// session on a red post-session gate (B-4); the orchestrator itself judges
// completion from gate evidence and the spec's own frontmatter, never from
// the session's own claim (B-5); decisions dropped during the session are
// sealed at stage end (B-6, spec 020).
//
// Every side effect (git, gate commands, file edits, session driving) sits
// behind the Runner seam (FR-001): the production Runner spawns real
// processes (Bun.spawnSync) and touches the real filesystem; tests drive
// this module against a scripted fake Runner (and, where a session needs to
// look real, a fake `claude` script per spec 014's own convention), never
// the real `claude` binary.
import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JsonValue } from "../journal";
import { runSession as driveClaudeSession, type SessionResult } from "../session";
import {
  decisionRecordsFromChain,
  decisionsFor,
  sealDropbox,
  type DecisionsForResult,
  type SealDropboxResult,
} from "../decisions";

// --- Runner seam (FR-001) --------------------------------------------------

export interface GateResult {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface RunnerSessionOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly journal?: JournalHandle;
}

export interface Runner {
  // --- git ops ---
  statusClean(): boolean;
  currentBranch(): string;
  // Idempotent (FR-003 reconcile): creates and checks out `branch` when it
  // does not exist yet; when it already does (a crashed prior attempt),
  // simply checks it out instead of erroring. Returns true when the branch
  // was reused rather than freshly created.
  createBranch(branch: string): boolean;
  checkout(branch: string): void;
  add(paths: readonly string[]): void;
  commit(message: string): void;
  headSha(): string;
  // Fast-forward the current branch from its upstream when one exists;
  // throws on divergence (the preflight treats that as a refusal, never a
  // silent merge). A branch with no upstream cannot be stale: no-op.
  pullFfOnly(): void;

  // --- gate commands ---
  runGate(cmd: readonly string[]): GateResult;

  // --- file edits (repo-relative paths) ---
  readFile(path: string): string;
  writeFile(path: string, content: string): void;

  // --- session driving (delegates to spec 014's driver) ---
  runSession(options: RunnerSessionOptions): Promise<SessionResult>;
}

const GATE_TAIL_BYTES = 16 * 1024;

function tailText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

function runProcessSync(cwd: string, cmd: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd as string[], { cwd });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function requireOk(cwd: string, cmd: readonly string[], label: string): void {
  const result = runProcessSync(cwd, cmd);
  if (result.exitCode !== 0) {
    throw new Error(`build: ${label} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

export interface CreateProcessRunnerParams {
  readonly repoDir: string;
  readonly claudeBin?: string;
}

// The production Runner: Bun.spawnSync for git and gate commands, fs for
// file edits, and spec 014's own runSession for driving. Never constructed
// by build.test.ts's fake-session/fake-gate scenarios (those override
// runGate/runSession on top of this); AC-2's real-git fixture flow reuses
// this wholesale for the git half so the reconcile and preflight paths run
// against a genuine repository.
export function createProcessRunner(params: CreateProcessRunnerParams): Runner {
  const { repoDir } = params;
  const claudeBin = params.claudeBin ?? "claude";

  return {
    statusClean(): boolean {
      const result = runProcessSync(repoDir, ["git", "status", "--porcelain"]);
      return result.stdout.trim().length === 0;
    },

    currentBranch(): string {
      const result = runProcessSync(repoDir, ["git", "branch", "--show-current"]);
      return result.stdout.trim();
    },

    createBranch(branch: string): boolean {
      const exists =
        runProcessSync(repoDir, ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
      if (exists) {
        requireOk(repoDir, ["git", "checkout", branch], `git checkout ${branch}`);
        return true;
      }
      requireOk(repoDir, ["git", "checkout", "-b", branch], `git checkout -b ${branch}`);
      return false;
    },

    checkout(branch: string): void {
      requireOk(repoDir, ["git", "checkout", branch], `git checkout ${branch}`);
    },

    pullFfOnly(): void {
      const upstream = runProcessSync(repoDir, ["git", "rev-parse", "--abbrev-ref", "@{u}"]);
      if (upstream.exitCode !== 0) return; // no upstream: nothing to be stale against
      requireOk(repoDir, ["git", "pull", "--ff-only"], "git pull --ff-only");
    },

    add(paths: readonly string[]): void {
      const existing = paths.filter((p) => fs.existsSync(join(repoDir, p)));
      if (existing.length === 0) return;
      requireOk(repoDir, ["git", "add", "--", ...existing], "git add");
    },

    commit(message: string): void {
      requireOk(repoDir, ["git", "commit", "-m", message], "git commit");
    },

    headSha(): string {
      const result = runProcessSync(repoDir, ["git", "rev-parse", "HEAD"]);
      return result.stdout.trim();
    },

    runGate(cmd: readonly string[]): GateResult {
      const result = runProcessSync(repoDir, cmd);
      return {
        exitCode: result.exitCode,
        stdoutTail: tailText(result.stdout, GATE_TAIL_BYTES),
        stderrTail: tailText(result.stderr, GATE_TAIL_BYTES),
      };
    },

    readFile(path: string): string {
      try {
        return fs.readFileSync(join(repoDir, path), "utf8");
      } catch (err) {
        throw new Error(`build: could not read "${path}" under ${repoDir}: ${(err as Error).message}`);
      }
    },

    writeFile(path: string, content: string): void {
      try {
        fs.writeFileSync(join(repoDir, path), content, "utf8");
      } catch (err) {
        throw new Error(`build: could not write "${path}" under ${repoDir}: ${(err as Error).message}`);
      }
    },

    async runSession(options: RunnerSessionOptions): Promise<SessionResult> {
      return driveClaudeSession({ repo: repoDir, claudeBin, ...options });
    },
  };
}

// --- preflight refusals (B-1) -----------------------------------------------

export type RefusalKind = "dirty-tree" | "wrong-branch" | "gate-red-at-base" | "spec-not-ready";

export interface Refusal {
  readonly kind: RefusalKind;
  readonly message: string;
}

// Injected: the daemon wires spec 012's ready() in; tests supply a trivial
// predicate. This module never imports dag.ts itself (B-1's own words:
// "readiness check injected as a predicate").
export type ReadinessCheck = (specId: string) => boolean;

// --- gate commands (B-5, reused for the B-1 "gate green at base" check) ----

export const GATE_COMMANDS: readonly (readonly string[])[] = [
  ["spec-spine", "compile"],
  ["spec-spine", "index", "check"],
  ["spec-spine", "lint", "--fail-on-warn"],
  ["spec-spine", "couple", "--base", "origin/main", "--head", "HEAD"],
  ["bun", "run", "typecheck"],
  ["bun", "test"],
];

export interface GateEvidence extends GateResult {
  readonly cmd: readonly string[];
}

function runGateSuite(runner: Runner): GateEvidence[] {
  return GATE_COMMANDS.map((cmd) => ({ cmd, ...runner.runGate(cmd) }));
}

function preflightRefusal(
  runner: Runner,
  specId: string,
  defaultBranch: string,
  isSpecReady: ReadinessCheck
): Refusal | null {
  if (!runner.statusClean()) {
    return { kind: "dirty-tree", message: "the target repo's working tree is not clean; refusing to start" };
  }

  // A clean tree on some other branch is the normal aftermath of the
  // previous spec's pipeline (ship and shepherd act remotely; nothing else
  // moves the local checkout back). Normalize instead of refusing: check
  // out the default branch and fast-forward it. Only a dirty tree above, or
  // a failed normalization here, is a genuine refusal (D-7; found live when
  // spec 024's build refused on spec 023's leftover branch).
  const branch = runner.currentBranch();
  if (branch !== defaultBranch) {
    try {
      runner.checkout(defaultBranch);
      runner.pullFfOnly();
    } catch (err) {
      return {
        kind: "wrong-branch",
        message: `on branch "${branch}" and could not normalize to "${defaultBranch}": ${(err as Error).message}`,
      };
    }
  } else {
    try {
      runner.pullFfOnly();
    } catch (err) {
      return {
        kind: "wrong-branch",
        message: `on "${defaultBranch}" but could not fast-forward it: ${(err as Error).message}`,
      };
    }
  }

  const gates = runGateSuite(runner);
  const failing = gates.find((g) => g.exitCode !== 0);
  if (failing) {
    return {
      kind: "gate-red-at-base",
      message: `"${failing.cmd.join(" ")}" exited ${failing.exitCode} at the base branch: ${
        failing.stderrTail || failing.stdoutTail
      }`,
    };
  }

  if (!isSpecReady(specId)) {
    return { kind: "spec-not-ready", message: `${specId} is not ready (unmet or invalidated dependencies)` };
  }

  return null;
}

// --- frontmatter helpers (B-2, B-5) ----------------------------------------

// No YAML parser (zero-runtime-dependency convention): every spec.md in this
// corpus writes `implementation: <status>` as its own top-level line, so a
// single-line regex is the honest minimum, matching the same style journal.ts
// and dag.ts use for their own minimal parsing.
export function readImplementationStatus(specMd: string): string | null {
  const match = /^implementation:\s*(\S+)\s*$/m.exec(specMd);
  return match ? match[1]! : null;
}

export interface FlipResult {
  readonly content: string;
  readonly changed: boolean;
}

// Idempotent (FR-003): a branch reused from a crashed or even a completed
// prior attempt may already carry the flip, or the finished state. Already
// at `to`: no-op. Already `complete` while flipping toward in-progress: also
// a no-op (a fresh attempt on a branch whose work finished simply proceeds
// to evidence evaluation; the live run hit exactly this after a mid-pipeline
// daemon restart). Anything else that is not `from`: a typed error rather
// than silently overwriting an unexpected state.
export function flipImplementation(specMd: string, from: string, to: string): FlipResult {
  const current = readImplementationStatus(specMd);
  if (current === to) return { content: specMd, changed: false };
  if (current === "complete" && to === "in-progress") return { content: specMd, changed: false };
  if (current !== from) {
    throw new Error(`build: expected "implementation: ${from}" but found "implementation: ${current ?? "<missing>"}"`);
  }
  const updated = specMd.replace(/^implementation:\s*\S+\s*$/m, `implementation: ${to}`);
  return { content: updated, changed: true };
}

// Parses a simple `field:\n  - "item"\n  - item\n` frontmatter list, the
// shape every spec.md in this corpus uses for depends_on and establishes.
export function parseFrontmatterListField(specMd: string, field: string): string[] {
  const lines = specMd.split("\n");
  const fieldPattern = new RegExp(`^${field}:\\s*$`);
  const start = lines.findIndex((l) => fieldPattern.test(l));
  if (start === -1) return [];

  const items: string[] = [];
  // Requires at least one space after the dash, so the frontmatter's own
  // closing `---` delimiter (a bare run of dashes, no space) never parses as
  // a list item.
  const itemPattern = /^\s*-\s+"?([^"]+?)"?\s*$/;
  for (let i = start + 1; i < lines.length; i++) {
    const match = itemPattern.exec(lines[i]!);
    if (!match) break;
    items.push(match[1]!);
  }
  return items;
}

// --- backlog step (B-3) -----------------------------------------------------

const FALLBACK_BACKLOG_STEP =
  "Implement exactly this spec's territory, start to finish, in this one session. " +
  "Decisions the spec is silent on go in the decision drop-box, not invented silently.";

// Extracts the "## Working the backlog" section of AGENTS.md verbatim, up to
// the next top-level heading. Falls back to a built-in summary when the
// target repo's AGENTS.md is missing or reshaped, rather than failing the
// stage over prompt-assembly prose.
export function extractBacklogStep(agentsMd: string): string {
  const heading = "## Working the backlog";
  const start = agentsMd.indexOf(heading);
  if (start === -1) return FALLBACK_BACKLOG_STEP;
  const rest = agentsMd.slice(start + heading.length);
  const nextHeading = /\n## /.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return section.trim();
}

function safeReadAgentsMd(runner: Runner): string {
  try {
    return runner.readFile("AGENTS.md");
  } catch {
    return "";
  }
}

// --- prompt template (B-3), kept in this module rather than a separate ----
// file: build-prompt.ts is not in spec 016's `establishes` list, and the
// template has no callers outside this stage, so a second file would only
// add a coupling surface with nothing to couple to (see Resolved decisions).

export const BUILD_PROMPT_VERSION = 1;

export interface BuildPromptParams {
  readonly specBody: string;
  readonly backlogStep: string;
  readonly decisions: DecisionsForResult;
  readonly dropboxDir: string;
}

export function buildPrompt(params: BuildPromptParams): string {
  const { specBody, backlogStep, decisions, dropboxDir } = params;

  const gateList = GATE_COMMANDS.map((cmd) => `  - \`${cmd.join(" ")}\``).join("\n");

  const decisionLines =
    decisions.included.length === 0
      ? "  (none recorded yet for this spec or its dependencies)"
      : decisions.included.map((d) => `  - ${d.id} (${d.specId}): ${d.title}: ${d.decision}`).join("\n");
  const overflowLine =
    decisions.overflowCount > 0
      ? `\n  (${decisions.overflowCount} older decision(s) omitted for budget; ask if you need one of them)`
      : "";

  return `You are implementing exactly one spec in this repository, start to
finish, in this one session. Build prompt template version: ${BUILD_PROMPT_VERSION}.

## Backlog protocol

${backlogStep}

## The spec to implement, verbatim

${specBody}

## Prior decisions that apply to this spec or its dependencies

${decisionLines}${overflowLine}

## The governed gate (must all exit 0 before you are done)

${gateList}

## Recording new decisions

Where this spec is silent and you must choose, write one JSON file per
decision into the decision drop-box at:

  ${dropboxDir}

Each file holds one DecisionRecord: {id, specId, scope, title, decision,
rationale, alternatives?, supersedes?}. Do not append to the decision ledger
directly; the orchestrator seals the drop-box after this session ends.

## House style

No em dashes (U+2014) anywhere: chat, code, comments, commit messages.
No AI attribution in commit messages or code. Match the surrounding code's
style.

Implement exactly this spec's territory, nothing more. When the gate is
green and the spec's acceptance criteria are satisfied, flip the spec's own
frontmatter to \`implementation: complete\` before finishing.
`;
}

interface Completion {
  readonly gates: readonly GateEvidence[];
  readonly frontmatterComplete: boolean;
  readonly passing: boolean;
}

function evaluateCompletion(runner: Runner, specPath: string): Completion {
  const gates = runGateSuite(runner);
  const allGreen = gates.every((g) => g.exitCode === 0);
  const frontmatterComplete = readImplementationStatus(runner.readFile(specPath)) === "complete";
  return { gates, frontmatterComplete, passing: allGreen && frontmatterComplete };
}

function remediationPrompt(basePrompt: string, completion: Completion): string {
  const failingGates = completion.gates.filter((g) => g.exitCode !== 0);
  const gateSection =
    failingGates.length === 0
      ? "(every gate command passed)"
      : failingGates
          .map(
            (g) =>
              `### \`${g.cmd.join(" ")}\` (exit ${g.exitCode})\n\nstdout tail:\n${g.stdoutTail}\n\nstderr tail:\n${g.stderrTail}`
          )
          .join("\n\n");
  const frontmatterNote = completion.frontmatterComplete
    ? ""
    : '\nThe spec\'s own frontmatter still does not read "implementation: complete". Flip it once the work is actually done.\n';

  return `${basePrompt}
## Remediation: the gate was red after your last session

This is a second, follow-up session on the same branch, the last one before
the build stage fails honestly. Fix the following, then finish:
${frontmatterNote}
${gateSection}
`;
}

// --- evidence and outcome (FR-002) ------------------------------------------

export type StageOutcome = "passed" | "failed" | "refused" | "blocked";

export interface SessionEvidence {
  readonly sessionId: string | null;
  readonly classification: string;
  readonly costMicroUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number;
}

export interface BuildEvidence {
  readonly specId: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly promptVersion: number | null;
  readonly refusal: Refusal | null;
  readonly sessions: readonly SessionEvidence[];
  readonly gates: readonly GateEvidence[];
  readonly frontmatterComplete: boolean | null;
  readonly decisions: SealDropboxResult | null;
}

export interface BuildResult {
  readonly outcome: StageOutcome;
  readonly evidence: BuildEvidence;
}

function toSessionEvidence(result: SessionResult): SessionEvidence {
  return {
    sessionId: result.sessionId,
    classification: result.classification.kind,
    costMicroUsd: result.costMicroUsd,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
  };
}

function gateEvidenceToJson(g: GateEvidence): Record<string, JsonValue> {
  return { cmd: [...g.cmd], exitCode: g.exitCode, stdoutTail: g.stdoutTail, stderrTail: g.stderrTail };
}

// --- defaults (B-4) ----------------------------------------------------------

export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_BUILD_DEADLINE_MS = 45 * 60_000;
export const DEFAULT_BUILD_MAX_TURNS = 80;
export const DECISION_BUDGET_CHARS = 20_000;

// --- the stage (B-1 through B-6) --------------------------------------------

export interface RunBuildStageOptions {
  readonly runner: Runner;
  readonly specId: string;
  readonly journal: JournalHandle;
  readonly decisionsChain: JournalHandle;
  readonly dropboxDir: string;
  readonly knownSpecIds: ReadonlySet<string>;
  readonly isSpecReady: ReadinessCheck;
  readonly defaultBranch?: string;
  readonly deadlineMs?: number;
  readonly maxTurns?: number;
  readonly model?: string;
}

export async function runBuildStage(options: RunBuildStageOptions): Promise<BuildResult> {
  const { runner, specId, journal, decisionsChain, dropboxDir, knownSpecIds, isSpecReady } = options;
  const defaultBranch = options.defaultBranch ?? DEFAULT_BASE_BRANCH;
  const timeoutMs = options.deadlineMs ?? DEFAULT_BUILD_DEADLINE_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_BUILD_MAX_TURNS;
  const specPath = `specs/${specId}/spec.md`;

  // --- B-1: preflight refusals ---
  const refusal = preflightRefusal(runner, specId, defaultBranch, isSpecReady);
  if (refusal) {
    const payload: Record<string, JsonValue> = { specId, kind: refusal.kind, message: refusal.message };
    journal.append("stage.build.refused", payload);
    return {
      outcome: "refused",
      evidence: {
        specId,
        branch: null,
        headSha: null,
        promptVersion: null,
        refusal,
        sessions: [],
        gates: [],
        frontmatterComplete: null,
        decisions: null,
      },
    };
  }

  // --- B-2: orchestrator-owned bracket ---
  const branch = specId;
  const reused = runner.createBranch(branch);

  const beforeContent = runner.readFile(specPath);
  const flip = flipImplementation(beforeContent, "pending", "in-progress");
  let bracketGate: GateEvidence | null = null;
  if (flip.changed) {
    runner.writeFile(specPath, flip.content);
    bracketGate = { cmd: GATE_COMMANDS[0]!, ...runner.runGate(GATE_COMMANDS[0]!) };
    runner.add([specPath, ".derived"]);
    runner.commit(`chore(${specId}): flip implementation to in-progress`);
  }
  const bracketHeadSha = runner.headSha();

  const bracketPayload: Record<string, JsonValue> = {
    specId,
    branch,
    reused,
    flipped: flip.changed,
    headSha: bracketHeadSha,
    compileExitCode: bracketGate?.exitCode ?? null,
  };
  journal.append("stage.build.bracket", bracketPayload);

  if (bracketGate && bracketGate.exitCode !== 0) {
    const resultPayload: Record<string, JsonValue> = { specId, outcome: "failed", branch, headSha: bracketHeadSha };
    journal.append("stage.build.result", resultPayload);
    return {
      outcome: "failed",
      evidence: {
        specId,
        branch,
        headSha: bracketHeadSha,
        promptVersion: null,
        refusal: null,
        sessions: [],
        gates: [bracketGate],
        frontmatterComplete: false,
        decisions: null,
      },
    };
  }

  // --- B-3: prompt assembly ---
  const specBody = flip.content;
  const backlogStep = extractBacklogStep(safeReadAgentsMd(runner));
  const dependsOnClosure = parseFrontmatterListField(specBody, "depends_on");
  const territoryPaths = parseFrontmatterListField(specBody, "establishes");
  const chainRecords = decisionRecordsFromChain(decisionsChain.fold());
  const decisionSelection = decisionsFor({
    records: chainRecords,
    specId,
    dependsOnClosure,
    territoryPaths,
    budgetChars: DECISION_BUDGET_CHARS,
  });
  const promptBase = buildPrompt({ specBody, backlogStep, decisions: decisionSelection, dropboxDir });

  const promptPayload: Record<string, JsonValue> = {
    specId,
    promptVersion: BUILD_PROMPT_VERSION,
    decisionsIncluded: decisionSelection.included.map((d) => d.id),
    decisionsOverflow: decisionSelection.overflowCount,
  };
  journal.append("stage.build.prompt", promptPayload);

  // --- B-4: drive (one session, at most one remediation) ---
  const sessions: SessionEvidence[] = [];

  const first = await runner.runSession({ prompt: promptBase, timeoutMs, maxTurns, model: options.model, journal });
  sessions.push(toSessionEvidence(first));

  let blocked = first.classification.kind === "hook-blocked";
  let completion: Completion = blocked
    ? { gates: [], frontmatterComplete: false, passing: false }
    : evaluateCompletion(runner, specPath);

  if (!blocked) {
    const gatePayload: Record<string, JsonValue> = {
      specId,
      round: 1,
      gates: completion.gates.map(gateEvidenceToJson),
      frontmatterComplete: completion.frontmatterComplete,
    };
    journal.append("stage.build.gate", gatePayload);
  }

  if (!blocked && !completion.passing) {
    const secondPrompt = remediationPrompt(promptBase, completion);
    const second = await runner.runSession({
      prompt: secondPrompt,
      timeoutMs,
      maxTurns,
      model: options.model,
      journal,
    });
    sessions.push(toSessionEvidence(second));

    blocked = second.classification.kind === "hook-blocked";
    if (!blocked) {
      completion = evaluateCompletion(runner, specPath);
      const gatePayload: Record<string, JsonValue> = {
        specId,
        round: 2,
        gates: completion.gates.map(gateEvidenceToJson),
        frontmatterComplete: completion.frontmatterComplete,
      };
      journal.append("stage.build.gate", gatePayload);
    }
  }

  // --- B-6: decision capture ---
  const sealResult = sealDropbox({ dropboxDir, chain: decisionsChain, knownSpecIds, journal });

  const headSha = runner.headSha();
  const outcome: StageOutcome = blocked ? "blocked" : completion.passing ? "passed" : "failed";

  const evidence: BuildEvidence = {
    specId,
    branch,
    headSha,
    promptVersion: BUILD_PROMPT_VERSION,
    refusal: null,
    sessions,
    gates: completion.gates,
    frontmatterComplete: completion.frontmatterComplete,
    decisions: sealResult,
  };

  const resultPayload: Record<string, JsonValue> = {
    specId,
    outcome,
    branch,
    headSha,
    gateExitCodes: completion.gates.map((g) => g.exitCode),
    sessionIds: sessions.map((s) => s.sessionId),
    decisionsSealed: sealResult.sealed.map((d) => d.id),
    decisionsInvalid: sealResult.invalid.map((i) => i.file),
  };
  journal.append("stage.build.result", resultPayload);

  return { outcome, evidence };
}
