// `statecraft-driver-claude session run` (spec 043 B-2): the Claude driver
// member's side of the driver seam.
//
// One JSON request on stdin (driver.ts's DriverWireRequest), an event stream
// on stdout, spec 014's runSession underneath and unchanged. The journal the
// engine would have handed runSession in-process is replaced by a capturing
// handle that forwards every append as a `journal` event, so the payloads
// the engine writes to its chain are the ones 014 built, byte for byte
// (B-3, D-3). Every parsed provider event rides out as a `stream` event; the
// SessionResult is the last line. SIGTERM and SIGINT reaching this process
// sever the live provider child through 014's own grace-then-SIGKILL path.
//
// This file is the only place that resolves a model tier to a Claude model
// id: spec 040's default pair lives here (D-7), and the engine passes a tier.
import type { JournalHandle, JournalRecord, JsonValue } from "../orchestrator/journal";
import type { ModelTier, SessionModels } from "../orchestrator/models";
import { parseProfile } from "../orchestrator/profile";
import type { ExecutionProfile } from "../orchestrator/profile";
import { killLiveSession, runSession, type RunSessionOptions, type SessionResult } from "../orchestrator/session";

// --- the default pair (040 B-3, moved here by 043 D-7) ----------------------

// Plain ids, deliberately not the long-context variants (040 D-4). The engine
// never sees these: it asks for a tier, and a project's override pair rides
// in the request's profile.
export const DEFAULT_SESSION_MODELS: SessionModels = {
  strong: "claude-opus-5",
  fast: "claude-sonnet-5",
};

// The one derivation (040 B-1): an explicit id wins, then the project's
// pair, then the default pair, for the requested tier.
export function resolveModel(tier: ModelTier | null, explicit: string | null, models: SessionModels | undefined): string | undefined {
  if (explicit !== null) return explicit;
  if (tier === null) return undefined;
  return (models ?? DEFAULT_SESSION_MODELS)[tier];
}

// --- the request ------------------------------------------------------------

export const CLAUDE_BIN_ENV = "STATECRAFT_CLAUDE_BIN";

export class RequestError extends Error {}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RequestError(`request: "${field}" must be a number`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestError(`request: "${field}" must be a string`);
  return value;
}

export interface ParsedRequest {
  readonly options: RunSessionOptions;
  readonly profile: ExecutionProfile | undefined;
}

export function parseRequest(text: string, env: NodeJS.ProcessEnv = process.env): ParsedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RequestError(`request: stdin is not JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestError("request: expected one JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== "1") throw new RequestError(`request: unsupported schemaVersion ${JSON.stringify(o.schemaVersion)}`);
  if (typeof o.repo !== "string" || o.repo.length === 0) throw new RequestError('request: "repo" is required');
  if (typeof o.prompt !== "string") throw new RequestError('request: "prompt" is required');
  const tier = o.tier === null || o.tier === undefined ? null : o.tier;
  if (tier !== null && tier !== "strong" && tier !== "fast") throw new RequestError('request: "tier" must be "strong" or "fast"');
  const profile = o.profile === null || o.profile === undefined ? undefined : parseProfile(o.profile as JsonValue, "request.profile");
  const model = resolveModel(tier, optionalString(o.model, "model") ?? null, profile?.models);
  const claudeBin = env[CLAUDE_BIN_ENV];
  const options: RunSessionOptions = {
    repo: o.repo,
    prompt: o.prompt,
    ...(claudeBin !== undefined && claudeBin.length > 0 ? { claudeBin } : {}),
    ...(model === undefined ? {} : { model }),
    ...(optionalNumber(o.maxTurns, "maxTurns") === undefined ? {} : { maxTurns: optionalNumber(o.maxTurns, "maxTurns") }),
    ...(optionalNumber(o.timeoutMs, "timeoutMs") === undefined ? {} : { timeoutMs: optionalNumber(o.timeoutMs, "timeoutMs") }),
    ...(optionalString(o.mcpConfigPath, "mcpConfigPath") === undefined ? {} : { mcpConfigPath: optionalString(o.mcpConfigPath, "mcpConfigPath") }),
    ...(profile === undefined ? {} : { profile }),
    ...(optionalNumber(o.killGraceMs, "killGraceMs") === undefined ? {} : { killGraceMs: optionalNumber(o.killGraceMs, "killGraceMs") }),
  };
  return { options, profile };
}

// --- the events -------------------------------------------------------------

export type EmitLine = (line: string) => void;

// A JournalHandle that forwards instead of writing. runSession only calls
// append(); the rest exists to satisfy the type and would be a defect to
// reach, so it says so.
export function forwardingJournal(emit: EmitLine): JournalHandle {
  const refuse = (what: string): never => {
    throw new Error(`driver session: the forwarding journal has no ${what}`);
  };
  let seq = 0;
  return {
    dir: "",
    headSeq: -1,
    tornRecovered: false,
    get state() {
      return refuse("state");
    },
    append(kind: string, payload: JsonValue): JournalRecord {
      emit(JSON.stringify({ event: "journal", kind, payload }));
      seq += 1;
      // The record itself is the engine's to produce; nothing here reads the
      // return value, so a placeholder keeps the interface honest.
      return { seq, ts: 0, kind, payload, prevHash: "", recordHash: "" } as unknown as JournalRecord;
    },
    fold() {
      return refuse("fold");
    },
    close() {},
  };
}

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

// Exit codes follow 023 D-4, the taxonomy the driver manifest declares (042
// B-6): 0 for any session outcome, 1 for a driver that could not run the
// provider, 3 for a request that does not parse.
export async function runSessionVerb(rest: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (rest[0] !== "run" || rest.length > 1) {
    console.error("usage: statecraft-driver-claude session run  (reads one JSON request on stdin)");
    return 3;
  }
  const emit: EmitLine = (line) => {
    process.stdout.write(`${line}\n`);
  };
  let parsed: ParsedRequest;
  try {
    parsed = parseRequest(await readStdin(), env);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 3;
  }

  const onSignal = (): void => {
    killLiveSession();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const result: SessionResult = await runSession({
      ...parsed.options,
      journal: forwardingJournal(emit),
      sink: (event) => emit(JSON.stringify({ event: "stream", raw: event })),
    });
    emit(JSON.stringify({ event: "result", result }));
    return 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
