// The one place that spawns Claude Code (spec 014). A fresh `claude -p
// --output-format stream-json --verbose --dangerously-skip-permissions`
// process per attempt: the prompt is written to stdin and stdin is closed,
// never placed on argv or interpolated through a shell (B-1). The child's
// env is the parent's env with ANTHROPIC_API_KEY deleted (an empty or unset
// key must not shadow OAuth) and NO_COLOR=1 (B-2). stdout is parsed as
// newline-delimited stream-json and forwarded to an injected sink; only the
// init and result boundaries are journaled (B-3). Termination is classified
// by the pure function in classify-termination.ts, never guessed here
// (B-4). Every session carries a wall-clock deadline, enforced
// SIGTERM-then-SIGKILL (B-5). Session end journals the full evidence bundle
// (B-6). Only one session may run at a time in this process (FR-003).
import { resolve, join } from "path";
import { homedir } from "os";
import type { JournalHandle, JsonValue } from "./journal";
import { classifyTermination, type Classification, type ResultEventLike } from "./classify-termination";

// --- stream-json event shapes (the subset this module reads) --------------

type StreamRecord = { readonly [key: string]: unknown };

function isRecord(v: unknown): v is StreamRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface InitEventShape {
  readonly type: "system";
  readonly subtype: "init";
  readonly session_id?: string;
}

function isInitEvent(v: unknown): v is InitEventShape {
  return isRecord(v) && v.type === "system" && v.subtype === "init";
}

interface ResultEventShape extends ResultEventLike {
  readonly type: "result";
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly usage?: unknown;
  readonly num_turns?: number;
}

function isResultEvent(v: unknown): v is ResultEventShape {
  return isRecord(v) && v.type === "result";
}

// --- public shapes ----------------------------------------------------------

export type SessionEventSink = (event: unknown) => void;

export interface RunSessionOptions {
  readonly repo: string;
  readonly prompt: string;
  readonly claudeBin?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  // SIGTERM-to-SIGKILL grace at the deadline (B-5). Configurable so tests can
  // exercise the escalation deterministically; defaults to KILL_GRACE_MS.
  readonly killGraceMs?: number;
  readonly journal?: JournalHandle;
  readonly sink?: SessionEventSink;
}

export interface OverflowInfo {
  // Unparseable stdout lines, kept verbatim, up to OVERFLOW_LINE_CAP; never
  // dropped silently (B-3).
  readonly lines: readonly string[];
  readonly truncatedCount: number;
}

export interface SessionResult {
  readonly classification: Classification;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly numTurns: number | null;
  // total_cost_usd converted to an integer count of millionths of a dollar
  // (Math.round(usd * 1e6)), so the journaled value stays in JsonValue's
  // integers-only portability set (see journal.ts canonicalizeValue).
  readonly costMicroUsd: number | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly overflow: OverflowInfo;
  readonly stderrTail: string;
}

// --- defaults (B-5) ----------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const KILL_GRACE_MS = 5000;
// How long to keep draining stdout/stderr after the child has exited. An
// orphaned grandchild that inherited the pipes can hold them open forever;
// waiting on EOF unconditionally would hang the driver with it.
export const PIPE_DRAIN_GRACE_MS = 2000;
export const STDERR_TAIL_BYTES = 16 * 1024;
export const OVERFLOW_LINE_CAP = 256;

// --- serial invariant (FR-003) ----------------------------------------------

export class SessionsSerialError extends Error {
  constructor() {
    super("session: another runSession() is already in flight in this process (serial v1 invariant, FR-003)");
    this.name = "SessionsSerialError";
  }
}

let sessionInFlight = false;

// --- transcript path (observational only, B-6) ------------------------------

// Claude Code's own CLI writes session transcripts under
// ~/.claude/projects/<cwd with "/" and "." replaced by "-">/<session_id>.jsonl.
// This only computes where that file would be; ~/.claude is observed, never
// written, by any code path in this repo (AGENTS.md, spec 001 B-7).
export function deriveTranscriptPath(repo: string, sessionId: string): string {
  const slug = resolve(repo).replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

// --- claude --version (B-2) --------------------------------------------------

// Exposed as a primitive; per this spec's implementation notes the caller
// decides when "once per run" is (e.g. once per daemon lifetime) and
// journals the result itself, rather than runSession spawning an extra
// process on every single session just to re-read the same version string.
export async function claudeVersion(claudeBin: string): Promise<string> {
  const proc = Bun.spawn([claudeBin, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`session: ${claudeBin} --version failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

// --- env hygiene (B-2) -------------------------------------------------------

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ANTHROPIC_API_KEY") env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

// --- small pure helpers -------------------------------------------------------

function tailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

function sanitizeUsage(usage: unknown): Record<string, number> | null {
  if (!isRecord(usage)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isInteger(value)) out[key] = value;
  }
  return out;
}

function toCostMicroUsd(totalCostUsd: unknown): number | null {
  if (typeof totalCostUsd !== "number" || !Number.isFinite(totalCostUsd)) return null;
  return Math.round(totalCostUsd * 1e6);
}

// --- driver (B-1, B-3, B-5) ---------------------------------------------------

export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  if (sessionInFlight) throw new SessionsSerialError();
  sessionInFlight = true;
  try {
    return await runSessionOnce(opts);
  } finally {
    sessionInFlight = false;
  }
}

async function runSessionOnce(opts: RunSessionOptions): Promise<SessionResult> {
  const claudeBin = opts.claudeBin ?? "claude";
  const absRepo = resolve(opts.repo);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [claudeBin, "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (opts.model !== undefined) args.push("--model", opts.model);
  if (opts.maxTurns !== undefined) args.push("--max-turns", String(opts.maxTurns));

  const proc = Bun.spawn(args, {
    cwd: absRepo,
    env: buildChildEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // B-1: the prompt reaches the child only via stdin, then stdin is closed;
  // it never touches argv or a shell.
  proc.stdin.write(opts.prompt);
  await proc.stdin.end();

  const startedAtMs = Date.now();

  // Mutable session state lives on one object rather than as separate `let`
  // bindings: TypeScript's control-flow narrowing gets confused about a
  // `let` that is only ever reassigned from inside a nested closure (it can
  // narrow the outer binding to `never` at the read site), which an object
  // property is not subject to.
  const state: {
    sessionId: string | null;
    resultEvent: ResultEventShape | null;
    initJournaled: boolean;
    overflowLines: string[];
    overflowTruncated: number;
    killedForTimeout: boolean;
    exited: boolean;
    deadlineTimer: ReturnType<typeof setTimeout> | null;
    graceTimer: ReturnType<typeof setTimeout> | null;
  } = {
    sessionId: null,
    resultEvent: null,
    initJournaled: false,
    overflowLines: [],
    overflowTruncated: 0,
    killedForTimeout: false,
    exited: false,
    deadlineTimer: null,
    graceTimer: null,
  };

  function clearTimers(): void {
    if (state.deadlineTimer !== null) {
      clearTimeout(state.deadlineTimer);
      state.deadlineTimer = null;
    }
    if (state.graceTimer !== null) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
  }

  // B-5: wall-clock deadline, SIGTERM then a grace period then SIGKILL. The
  // escalation guards on our own exited flag, not proc.killed: killed only
  // says a signal was sent (our SIGTERM sets it), which would skip the
  // escalation exactly when the child ignored the SIGTERM.
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  state.deadlineTimer = setTimeout(() => {
    state.killedForTimeout = true;
    proc.kill("SIGTERM");
    state.graceTimer = setTimeout(() => {
      if (!state.exited) proc.kill("SIGKILL");
    }, killGraceMs);
  }, timeoutMs);

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Unparseable stdout is preserved verbatim, bounded, never dropped
      // silently (B-3).
      if (state.overflowLines.length < OVERFLOW_LINE_CAP) state.overflowLines.push(line);
      else state.overflowTruncated++;
      return;
    }

    // Every parsed event goes to the injected sink; only init/result are
    // journaled boundaries (B-3).
    opts.sink?.(parsed);

    if (isInitEvent(parsed)) {
      if (typeof parsed.session_id === "string") state.sessionId = parsed.session_id;
      if (opts.journal && !state.initJournaled) {
        state.initJournaled = true;
        const initPayload: Record<string, JsonValue> = {
          claudeBin,
          repo: absRepo,
          model: opts.model ?? null,
          maxTurns: opts.maxTurns ?? null,
          timeoutMs,
          sessionId: state.sessionId ?? null,
        };
        opts.journal.append("session.init", initPayload);
      }
    } else if (isResultEvent(parsed)) {
      state.resultEvent = parsed;
      if (typeof parsed.session_id === "string") state.sessionId = parsed.session_id;
      // A result arrived: the process is finishing on its own, so a deadline
      // that hasn't fired yet should not fire a redundant kill underneath it.
      clearTimers();
    }
  }

  async function readStdout(): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.length > 0) handleLine(line);
        }
      }
    } finally {
      buf += decoder.decode();
      if (buf.trim().length > 0) handleLine(buf);
    }
  }

  // stderr is captured incrementally (tail-bounded as it arrives) rather
  // than via one read-to-EOF: a killed child can leave an orphaned
  // grandchild holding the inherited pipe descriptors open long after the
  // child itself died, so EOF is not a boundary this driver may wait on
  // unconditionally.
  let stderrText = "";
  async function readStderr(): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText = tailBytes(stderrText + decoder.decode(value, { stream: true }), STDERR_TAIL_BYTES);
      }
    } finally {
      stderrText = tailBytes(stderrText + decoder.decode(), STDERR_TAIL_BYTES);
    }
  }

  const exitedPromise = proc.exited.then((code) => {
    state.exited = true;
    return code;
  });
  const streamsDone = Promise.all([readStdout(), readStderr()]);

  // Process exit is the boundary that matters; pipe EOF is only a bounded
  // courtesy afterwards (see the orphaned-grandchild note above).
  const exitCode = await exitedPromise;
  clearTimers();
  await Promise.race([streamsDone, Bun.sleep(PIPE_DRAIN_GRACE_MS)]);

  const durationMs = Date.now() - startedAtMs;
  const stderrTail = stderrText;
  const { resultEvent, sessionId, overflowLines, overflowTruncated } = state;

  const classification = classifyTermination({
    exitCode,
    resultEvent,
    stderrTail,
    timedOut: state.killedForTimeout,
  });

  const costMicroUsd = toCostMicroUsd(resultEvent?.total_cost_usd);
  const usage = resultEvent ? sanitizeUsage(resultEvent.usage) : null;
  const numTurns =
    resultEvent && typeof resultEvent.num_turns === "number" && Number.isInteger(resultEvent.num_turns)
      ? resultEvent.num_turns
      : null;
  const transcriptPath = sessionId ? deriveTranscriptPath(absRepo, sessionId) : null;

  const result: SessionResult = {
    classification,
    exitCode,
    durationMs,
    numTurns,
    costMicroUsd,
    usage,
    sessionId,
    transcriptPath,
    overflow: { lines: overflowLines, truncatedCount: overflowTruncated },
    stderrTail,
  };

  // B-6: session end journals the evidence bundle. A killed session still
  // journals here (classification "timeout") even when no result event ever
  // arrived (B-5); only the fields a result event would have carried stay
  // null. Raw overflow lines are not duplicated into the journal (they are
  // already bounded and returned on SessionResult); only their counts are,
  // so this record stays small regardless of how noisy stdout got.
  if (opts.journal) {
    const resultPayload: Record<string, JsonValue> = {
      classification: classification.kind,
      resetAtMs: classification.resetAtMs,
      detail: classification.detail,
      exitCode,
      durationMs,
      numTurns,
      costMicroUsd,
      usage,
      sessionId,
      transcriptPath,
      overflowLineCount: overflowLines.length,
      overflowTruncatedCount: overflowTruncated,
      stderrTail,
    };
    opts.journal.append("session.result", resultPayload);
  }

  return result;
}
