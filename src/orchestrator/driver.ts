// The driver seam (spec 043): the one way the engine drives a session.
//
// The engine never spawns a provider and never parses one. It spawns a
// driver member (`statecraft-driver-<name>`, 042 B-1) as a process, writes
// one provider-neutral request to its stdin, and reads a line-delimited
// event stream off its stdout (B-2):
//
//   {"event":"journal","kind":"session.init","payload":{...}}
//   {"event":"stream","raw":<the provider's own event, verbatim>}
//   {"event":"journal","kind":"session.result","payload":{...}}
//   {"event":"result","result":<SessionResult>}
//
// The engine journals the `journal` events itself (B-3, D-3): the driver
// holds no journal path, and the payloads are the ones spec 014 wrote when
// runSession held the journal in-process, forwarded rather than rebuilt, so
// the chain shape is unchanged. Every `stream` event reaches the sink the
// stages inject, exactly as session.ts's sink did. Kill and deadline (B-4)
// act on the member process; the member forwards to the provider child.
//
// Nothing in this file names a provider. The strings that do live under
// src/members/ and in session.ts, and engine-bundle.test.ts proves the
// compiled engine carries none of them (FR-005).
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, join, resolve } from "path";
import type { JournalHandle, JsonValue } from "./journal";
import type { ExecutionProfile } from "./profile";
import { profilePayload } from "./profile";
import type { ModelTier } from "./models";

// The result and classification shapes are the driver's to define (014);
// the engine consumes them as data. Type-only re-exports are erased by the
// compiler, so the engine bundle's import graph does not reach session.ts.
export type { SessionResult, OverflowInfo, SessionEventSink } from "./session";
export type { Classification, TerminationKind } from "./classify-termination";
import type { SessionResult, SessionEventSink } from "./session";
import type { TerminationKind } from "./classify-termination";

// --- the seam (B-1) ---------------------------------------------------------

export type CapabilityTier = "reference" | "basic";

export interface DriverSessionRequest {
  readonly repo: string;
  readonly prompt: string;
  // A model tier (040 B-2) the driver resolves to an id; an explicit `model`
  // wins when present (040 B-1). The engine never names a model id itself.
  readonly tier?: ModelTier;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  // Reference-tier feature (B-6): an MCP server set the session must see.
  readonly mcpConfigPath?: string;
  readonly profile?: ExecutionProfile;
  readonly killGraceMs?: number;
  // The two engine callbacks the process cannot carry.
  readonly journal?: JournalHandle;
  readonly sink?: SessionEventSink;
}

export interface Driver {
  readonly name: string;
  // Read from the member manifest (042 B-8), consumed as a declaration (D-4).
  tier(): Promise<CapabilityTier>;
  runSession(request: DriverSessionRequest): Promise<SessionResult>;
  // Severs the live session (021 B-6): SIGTERM to the member, which forwards
  // it to the provider child. True when something was in flight.
  killLiveSession(graceMs?: number): boolean;
}

// The request as it crosses the process boundary: the engine callbacks
// removed, the profile serialized the way the journal already does (032
// B-5), so a driver reads mode, tool lists and the model pair verbatim.
export interface DriverWireRequest {
  readonly schemaVersion: "1";
  readonly repo: string;
  readonly prompt: string;
  readonly tier: ModelTier | null;
  readonly model: string | null;
  readonly maxTurns: number | null;
  readonly timeoutMs: number | null;
  readonly mcpConfigPath: string | null;
  readonly profile: Record<string, JsonValue> | null;
  readonly killGraceMs: number | null;
}

export function toWireRequest(request: DriverSessionRequest): DriverWireRequest {
  return {
    schemaVersion: "1",
    repo: resolve(request.repo),
    prompt: request.prompt,
    tier: request.tier ?? null,
    model: request.model ?? null,
    maxTurns: request.maxTurns ?? null,
    timeoutMs: request.timeoutMs ?? null,
    mcpConfigPath: request.mcpConfigPath ?? null,
    profile: request.profile === undefined ? null : profilePayload(request.profile),
    killGraceMs: request.killGraceMs ?? null,
  };
}

// --- events (B-2) -----------------------------------------------------------

export type DriverEvent =
  | { readonly event: "journal"; readonly kind: string; readonly payload: JsonValue }
  | { readonly event: "stream"; readonly raw: unknown }
  | { readonly event: "result"; readonly result: SessionResult };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseDriverEvent(line: string): DriverEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (parsed.event) {
    case "journal":
      if (typeof parsed.kind !== "string" || !("payload" in parsed)) return null;
      return { event: "journal", kind: parsed.kind, payload: parsed.payload as JsonValue };
    case "stream":
      return { event: "stream", raw: parsed.raw };
    case "result":
      if (!isRecord(parsed.result)) return null;
      return { event: "result", result: parsed.result as unknown as SessionResult };
    default:
      return null;
  }
}

// --- discovery (B-5) ---------------------------------------------------------

export const MEMBER_PREFIX = "statecraft-driver-";
export const MEMBER_DIR_ENV = "STATECRAFT_MEMBER_DIR";
export const DRIVER_BIN_ENV = "STATECRAFT_DRIVER_BIN";
export const DEFAULT_DRIVER_NAME = "claude";

// The umbrella's managed member directory (statecraft-cli 008 §4), resolved
// the same way so the engine and the umbrella find the same binary.
export function managedMemberDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[MEMBER_DIR_ENV];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "statecraft", "members");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "statecraft", "members");
  return join(homedir(), ".local", "share", "statecraft", "members");
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Whether this module runs from a checkout rather than a compiled bundle:
// inside a `bun build --compile` binary import.meta.dir is a virtual path
// that exists nowhere on disk.
function runningFromSource(): boolean {
  return existsSync(join(import.meta.dir, "..", "..", "package.json"));
}

export interface ResolvedDriverCommand {
  readonly argv: readonly string[];
  readonly location: "explicit" | "managed" | "path" | "source";
}

// The command that runs the driver member: `STATECRAFT_DRIVER_BIN`, else
// the managed directory, else PATH, else (from a checkout only) the member
// entrypoint under bun. Null when nothing is found.
export function resolveDriverCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedDriverCommand | null {
  const explicit = env[DRIVER_BIN_ENV];
  if (explicit !== undefined && explicit.length > 0) return { argv: [explicit], location: "explicit" };
  const binary = `${MEMBER_PREFIX}${name}`;
  const managed = managedMemberDir(env);
  if (managed !== null) {
    const candidate = join(managed, binary);
    if (isExecutableFile(candidate)) return { argv: [candidate], location: "managed" };
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (isExecutableFile(candidate)) return { argv: [candidate], location: "path" };
  }
  if (runningFromSource()) {
    const entry = join(import.meta.dir, "..", "members", `${name === DEFAULT_DRIVER_NAME ? "driver" : `driver-${name}`}.ts`);
    if (existsSync(entry)) return { argv: [process.execPath, entry], location: "source" };
  }
  return null;
}

export function describeSearch(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const managed = managedMemberDir(env) ?? "(no managed directory)";
  return `${DRIVER_BIN_ENV} unset; ${MEMBER_PREFIX}${name} not in ${managed} or on PATH`;
}

// --- the process driver ---------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const KILL_GRACE_MS = 5000;
// How long past the member's own deadline the engine waits for `result`
// before killing the member itself (B-4). The member enforces the session
// deadline; this covers a member that hangs after its child is gone.
export const DEADLINE_SLACK_MS = 10_000;
// How long to keep draining the member's pipes after it has exited. A
// grandchild that inherited them can hold them open indefinitely (014 has
// the same bound for the provider's own orphans).
export const PIPE_DRAIN_GRACE_MS = 2000;
export const STDERR_TAIL_BYTES = 16 * 1024;

export interface CreateProcessDriverParams {
  readonly name?: string;
  // The driver command, when the caller has one (tests do, the CLI's env
  // does). Absent resolves per B-5 at first use.
  readonly driverBin?: string;
  // The tier, when the caller already knows it. Absent asks the member for
  // its manifest once (042 B-3) and caches the answer.
  readonly tier?: CapabilityTier;
  readonly env?: NodeJS.ProcessEnv;
  // How long past the session deadline plus grace the engine waits for a
  // member's `result` before killing the member (B-4). Tests shorten it.
  readonly deadlineSlackMs?: number;
}

export class DriverNotFoundError extends Error {
  constructor(name: string, detail: string) {
    super(`driver: no driver member for "${name}": ${detail}`);
    this.name = "DriverNotFoundError";
  }
}

interface ManifestLike {
  readonly capabilityTier?: unknown;
}

function tailBytes(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

// The result the engine synthesizes when the member never produced one: a
// classification the stages already handle, with the detail naming the
// driver rather than the provider.
function synthesizedResult(kind: TerminationKind, detail: string, durationMs: number, stderrTail: string): SessionResult {
  return {
    classification: { kind, resetAtMs: null, detail },
    exitCode: null,
    durationMs,
    numTurns: null,
    costMicroUsd: null,
    usage: null,
    sessionId: null,
    transcriptPath: null,
    overflow: { lines: [], truncatedCount: 0 },
    stderrTail,
  };
}

// The `session.result` payload for a synthesized result, field for field
// what session.ts writes, so a reader sees one shape whether the session
// ended in the provider or in the driver.
function synthesizedResultPayload(result: SessionResult): Record<string, JsonValue> {
  return {
    classification: result.classification.kind,
    resetAtMs: result.classification.resetAtMs,
    detail: result.classification.detail,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    costMicroUsd: result.costMicroUsd,
    usage: result.usage,
    sessionId: result.sessionId,
    transcriptPath: result.transcriptPath,
    overflowLineCount: result.overflow.lines.length,
    overflowTruncatedCount: result.overflow.truncatedCount,
    stderrTail: result.stderrTail,
    resultTextTail: null,
  };
}

export const DEGRADED_KIND = "driver.degraded";

// Every live session across every process driver in this process, so the
// daemon's shutdown path (021 B-6) can sever whichever one is in flight
// without holding a handle through the stage call stack: the shape
// session.ts's killLiveSession had, over the seam instead of the provider.
const liveKills = new Set<(graceMs?: number) => void>();

export function killLiveSession(graceMs?: number): boolean {
  if (liveKills.size === 0) return false;
  for (const kill of [...liveKills]) kill(graceMs);
  return true;
}

export function createProcessDriver(params: CreateProcessDriverParams = {}): Driver {
  const name = params.name ?? DEFAULT_DRIVER_NAME;
  const env = params.env ?? process.env;
  let command: readonly string[] | null = params.driverBin !== undefined ? [params.driverBin] : null;
  let cachedTier: CapabilityTier | null = params.tier ?? null;
  let liveKill: ((graceMs?: number) => void) | null = null;

  function resolveCommand(): readonly string[] {
    if (command !== null) return command;
    const resolved = resolveDriverCommand(name, env);
    if (resolved === null) throw new DriverNotFoundError(name, describeSearch(name, env));
    command = resolved.argv;
    return command;
  }

  async function tier(): Promise<CapabilityTier> {
    if (cachedTier !== null) return cachedTier;
    const argv = [...resolveCommand(), "--member-manifest"];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`driver: ${argv[0]} --member-manifest exited ${code}`);
    let manifest: ManifestLike;
    try {
      manifest = JSON.parse(text) as ManifestLike;
    } catch (err) {
      throw new Error(`driver: ${argv[0]} manifest does not parse: ${(err as Error).message}`);
    }
    const declared = manifest.capabilityTier;
    if (declared !== "reference" && declared !== "basic") {
      throw new Error(`driver: ${argv[0]} manifest declares no capability tier`);
    }
    cachedTier = declared;
    return cachedTier;
  }

  async function runSession(request: DriverSessionRequest): Promise<SessionResult> {
    const startedAtMs = Date.now();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const killGraceMs = request.killGraceMs ?? KILL_GRACE_MS;

    // B-6: the tier is a declaration the engine honors before spawning.
    if (request.mcpConfigPath !== undefined) {
      const declared = await tier();
      if (declared !== "reference") {
        const detail = `driver "${name}" is ${declared} tier and cannot host an MCP server set (mcp-config)`;
        request.journal?.append(DEGRADED_KIND, { driver: name, tier: declared, feature: "mcp-config" });
        const result = synthesizedResult("crashed", detail, 0, "");
        request.journal?.append("session.result", synthesizedResultPayload(result));
        return result;
      }
    }

    let argv: readonly string[];
    try {
      argv = [...resolveCommand(), "session", "run"];
    } catch (err) {
      const detail = (err as Error).message;
      const result = synthesizedResult("crashed", detail, 0, "");
      request.journal?.append("session.result", synthesizedResultPayload(result));
      return result;
    }

    const proc = Bun.spawn([...argv], {
      cwd: resolve(request.repo),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const state = {
      exited: false,
      killedByEngine: false,
      killedForDeadline: false,
      result: null as SessionResult | null,
      stderr: "",
      graceTimer: null as ReturnType<typeof setTimeout> | null,
      deadlineTimer: null as ReturnType<typeof setTimeout> | null,
    };

    const sever = (graceMs: number): void => {
      if (state.exited) return;
      proc.kill("SIGTERM");
      state.graceTimer = setTimeout(() => {
        if (!state.exited) proc.kill("SIGKILL");
      }, graceMs);
    };

    liveKill = (graceMs = killGraceMs) => {
      if (state.exited || state.killedByEngine) return;
      state.killedByEngine = true;
      sever(graceMs);
    };
    liveKills.add(liveKill);

    // B-4: the member enforces the session deadline; this is the backstop
    // for a member that never answers.
    state.deadlineTimer = setTimeout(() => {
      if (state.exited || state.result !== null) return;
      state.killedForDeadline = true;
      sever(killGraceMs);
    }, timeoutMs + killGraceMs + (params.deadlineSlackMs ?? DEADLINE_SLACK_MS));

    try {
      proc.stdin.write(JSON.stringify(toWireRequest(request)));
      await proc.stdin.end();
    } catch {
      // A member severed before the request landed still unwinds below.
    }

    const readStdout = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handle(line);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.length > 0) handle(buffer);
    })();

    const readStderr = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        state.stderr = tailBytes(state.stderr + decoder.decode(chunk, { stream: true }), STDERR_TAIL_BYTES);
      }
    })();

    function handle(line: string): void {
      if (line.trim().length === 0) return;
      const event = parseDriverEvent(line);
      if (event === null) {
        // A line that is not an event is the member talking out of turn;
        // keep it where a stderr line would land, never on the chain.
        state.stderr = tailBytes(`${state.stderr}${line}\n`, STDERR_TAIL_BYTES);
        return;
      }
      switch (event.event) {
        case "journal":
          request.journal?.append(event.kind, event.payload);
          return;
        case "stream":
          request.sink?.(event.raw);
          return;
        case "result":
          state.result = event.result;
          return;
      }
    }

    const exitCode = await proc.exited;
    state.exited = true;
    if (state.graceTimer !== null) clearTimeout(state.graceTimer);
    if (state.deadlineTimer !== null) clearTimeout(state.deadlineTimer);
    if (liveKill !== null) liveKills.delete(liveKill);
    liveKill = null;
    await Promise.race([Promise.all([readStdout, readStderr]), Bun.sleep(PIPE_DRAIN_GRACE_MS)]);

    if (state.result !== null) return state.result;

    // The member exited without a result: the failure is the driver's, and
    // the record says so in the shape every other end has.
    const durationMs = Date.now() - startedAtMs;
    const kind: TerminationKind = state.killedByEngine ? "killed" : "crashed";
    const detail = state.killedByEngine
      ? `driver "${name}" severed by the engine before it produced a result`
      : state.killedForDeadline
        ? `driver "${name}" produced no result within the deadline and was killed`
        : `driver "${name}" exited ${exitCode} without a result`;
    const result = synthesizedResult(kind, detail, durationMs, state.stderr);
    request.journal?.append("session.result", synthesizedResultPayload(result));
    return result;
  }

  return {
    name,
    tier,
    runSession,
    killLiveSession(graceMs?: number): boolean {
      if (liveKill === null) return false;
      liveKill(graceMs);
      return true;
    },
  };
}
