// The orchestrator's primary control plane (spec 023): one command group on
// the observatory binary that is a pure client of the daemon's HTTP API
// (spec 022), plus the two jobs only a terminal can do: verifying both hash
// chains offline, and owning the daemon process's own lifecycle.
//
// Three disciplines shape everything below.
//
// First, B-1: every command except `journal verify` and `daemon
// start|stop|status` goes through the typed client in api-client.ts. Nothing
// here folds a journal, reads the registry, or re-derives readiness while a
// daemon is running; if the answer is not in an envelope the daemon served,
// this file does not know it.
//
// Second, B-3: the exit code carries the outcome for scripts (0 ok, 1
// operational failure, 2 unreachable daemon, 3 usage), `--json` prints the
// envelope the daemon served verbatim, and human output never launders an
// estimate into a fact (the quota horizon says "estimate" when the daemon
// says `estimated: true`, and "unknown" when the daemon knows nothing).
//
// Third, testability: the whole command group is `runOrchestratorCli(args,
// deps)` returning an exit code, with every side effect (streams, spawn,
// kill, clock, process inspection) behind `OrchestratorCliDeps`. The
// process-exiting wrapper `cmdOrchestrator` is the only thing index.ts sees.
import { spawn } from "child_process";
import * as fs from "fs";
import { join } from "path";
import { DATA_DIR, PROJECT_DIR } from "../paths";
import { verifyChain, type JournalRecord } from "../orchestrator/journal";
import { createApiClient, type ApiClient } from "../orchestrator/api/api-client";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  createApiServer,
  type ApiServer,
  type JournalView,
} from "../orchestrator/api/server";
import {
  Daemon,
  createProcessInspector,
  createProductionDaemonDeps,
  type ProcessInspector,
} from "../orchestrator/daemon";
import type {
  ApiErrorKind,
  ApiResponse,
  ControlResult,
  DagSpecNode,
  DagView,
  DecisionsView,
  HistoryEntry,
  HistoryView,
  QuotaView,
  RunView,
  SpecBlockerView,
  SpecControlVerb,
} from "../orchestrator/api/types";
import type { DecisionRecord } from "../orchestrator/decisions";

// --- exit codes (B-3) -------------------------------------------------------

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_UNREACHABLE = 2;
export const EXIT_USAGE = 3;

// A daemon that is not there is its own outcome, distinct from one that
// answered with a refusal: `unreachable` is the only kind api-client.ts
// produces without reaching the server, and `malformed-response` means the
// daemon did answer, just not in the contract, which is an operational
// failure like any other.
function exitCodeFor(kind: ApiErrorKind): number {
  return kind === "unreachable" ? EXIT_UNREACHABLE : EXIT_FAILURE;
}

export const ORCHESTRATOR_USAGE = `usage: observatory orchestrator <command> [--json] [--url <base>]

  status                       run, spec, stage, and quota state
  dag                          every spec with readiness, blockers, drift
  next                         the next ready spec, or why there is none
  start | pause | resume       run controls
  history                      spec executions with their evidence trail
  decisions <query>            search the sealed decision ledger
  spec <id> <verb>             skip | retry | reverify | force-gate | approve
  journal verify               verify both chains offline (no daemon needed)
  daemon start|stop|status     daemon process lifecycle (identity-checked lock)
  daemon run                   run the daemon in the foreground (what start spawns)

  --json                       print the raw envelope instead of human output
  --url <base>                 daemon base url (default http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT})
  --data-dir <dir>             orchestrator data directory
  --repo <dir>                 target repository (daemon run|start only)

exit: 0 ok, 1 operational failure, 2 unreachable daemon, 3 usage`;

// --- deps -------------------------------------------------------------------

export interface SpawnDaemonParams {
  readonly dataDir: string;
  readonly repoDir: string;
  readonly url: string;
  readonly logPath: string;
}

export interface OrchestratorCliDeps {
  out(line: string): void;
  err(line: string): void;
  createClient(baseUrl: string): ApiClient;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly inspector: ProcessInspector;
  // Detaches a foreground `orchestrator daemon run` and returns its pid, or
  // null when the spawn produced no pid at all.
  spawnDaemon(params: SpawnDaemonParams): number | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  readonly env: Record<string, string | undefined>;
  // How long `daemon start` waits for the lock and then the API, and how
  // long `daemon stop` waits for SIGTERM to be honored.
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export const ORCHESTRATOR_DATA_DIR = join(DATA_DIR, "orchestrator");
export const CONTROL_SOURCE = "cli";

function spawnDetachedDaemon(params: SpawnDaemonParams): number | null {
  fs.mkdirSync(params.dataDir, { recursive: true });
  const logFd = fs.openSync(params.logPath, "a");
  const child = spawn(
    process.execPath,
    [
      join(PROJECT_DIR, "src/index.ts"),
      "orchestrator",
      "daemon",
      "run",
      "--url",
      params.url,
      "--data-dir",
      params.dataDir,
      "--repo",
      params.repoDir,
    ],
    { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, NO_COLOR: "1" } }
  );
  child.unref();
  return child.pid ?? null;
}

export function defaultOrchestratorCliDeps(): OrchestratorCliDeps {
  return {
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
    createClient: (baseUrl: string) => createApiClient({ baseUrl, source: CONTROL_SOURCE }),
    dataDir: ORCHESTRATOR_DATA_DIR,
    repoDir: PROJECT_DIR,
    inspector: createProcessInspector(),
    spawnDaemon: spawnDetachedDaemon,
    kill: (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    },
    sleep: (ms: number) => Bun.sleep(ms),
    now: () => Date.now(),
    env: process.env as Record<string, string | undefined>,
    startTimeoutMs: 15_000,
    stopTimeoutMs: 15_000,
    pollIntervalMs: 100,
  };
}

// --- argument parsing -------------------------------------------------------

export const API_URL_ENV = "OBSERVATORY_ORCHESTRATOR_URL";

interface ParsedArgs {
  readonly json: boolean;
  readonly url: string | null;
  readonly dataDir: string | null;
  readonly repoDir: string | null;
  readonly rest: readonly string[];
}

type ParseResult = { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly reason: string };

// Unknown flags are refused rather than ignored. Spec 005 records silent
// flag-swallowing as a defect of the observatory commands; repeating it in a
// control plane whose verbs journal irreversible facts would be worse than a
// cosmetic annoyance.
function parseArgs(argv: readonly string[]): ParseResult {
  let json = false;
  let url: string | null = null;
  let dataDir: string | null = null;
  let repoDir: string | null = null;
  const rest: string[] = [];

  const valued: Readonly<Record<string, (value: string) => void>> = {
    "--url": (v) => {
      url = v;
    },
    "--data-dir": (v) => {
      dataDir = v;
    },
    "--repo": (v) => {
      repoDir = v;
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const setter = valued[arg];
    if (setter) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, reason: `${arg} needs a value` };
      setter(value);
      i++;
      continue;
    }
    if (arg.startsWith("--")) return { ok: false, reason: `unknown flag ${arg}` };
    rest.push(arg);
  }

  return { ok: true, args: { json, url, dataDir, repoDir, rest } };
}

function resolveBaseUrl(parsed: ParsedArgs, deps: OrchestratorCliDeps): string {
  const fromEnv = deps.env[API_URL_ENV];
  const chosen = parsed.url ?? (fromEnv && fromEnv.length > 0 ? fromEnv : null);
  return (chosen ?? `http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT}`).replace(/\/+$/, "");
}

// One knob for both halves: the same `--url` that tells a client where to
// look tells `daemon run` where to bind, so an operator cannot start a daemon
// on one port and then query another without noticing.
interface Bind {
  readonly host: string;
  readonly port: number;
}

function parseBind(baseUrl: string): Bind | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) return null;
  const port = parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_API_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
  return { host, port };
}

// --- output helpers ---------------------------------------------------------

function usage(deps: OrchestratorCliDeps, reason: string): number {
  deps.err(`observatory orchestrator: ${reason}`);
  deps.err(ORCHESTRATOR_USAGE);
  return EXIT_USAGE;
}

function printJson(deps: OrchestratorCliDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

// Every API-backed command funnels through here: `--json` prints the served
// envelope verbatim (success or failure), human mode renders the data or
// reports the error kind, and the exit code follows B-3's table either way.
function respond<T>(
  deps: OrchestratorCliDeps,
  json: boolean,
  response: ApiResponse<T>,
  render: (data: T) => readonly string[]
): number {
  if (json) {
    printJson(deps, response);
    return response.ok ? EXIT_OK : exitCodeFor(response.error.kind);
  }
  if (!response.ok) {
    deps.err(`error: ${response.error.kind}: ${response.error.message}`);
    return exitCodeFor(response.error.kind);
  }
  for (const line of render(response.data)) deps.out(line);
  return EXIT_OK;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function fmtIso(ms: number): string {
  return new Date(ms).toISOString();
}

// --- human rendering --------------------------------------------------------

function renderBlockers(blockers: readonly SpecBlockerView[], indent: string): string[] {
  const lines: string[] = [];
  for (const blocker of blockers) {
    lines.push(`${indent}${blocker.specId}:`);
    for (const reason of blocker.reasons) lines.push(`${indent}  ${reason}`);
  }
  return lines;
}

// B-3's honesty clause lives here: a horizon the daemon flagged as estimated
// is printed as an estimate, an unflagged one as reported, and an absent one
// as unknown. Nothing in this function can turn a null into a number.
function renderQuota(quota: QuotaView): string[] {
  const lines: string[] = [];
  if (!quota.parked) {
    lines.push(`quota:   not parked`);
  } else if (quota.msUntilTarget === null || quota.targetMs === null) {
    lines.push(`quota:   parked, reset horizon unknown (no target journaled)`);
  } else {
    const basis = quota.estimated === true ? "estimate, not a promise" : quota.estimated === false ? "reported reset" : "unknown basis";
    const remaining =
      quota.msUntilTarget > 0
        ? `${fmtDuration(quota.msUntilTarget)} until ${fmtIso(quota.targetMs)}`
        : `target ${fmtIso(quota.targetMs)} passed ${fmtDuration(quota.msUntilTarget)} ago`;
    lines.push(`quota:   parked, ${remaining} (${basis})`);
  }
  lines.push(`         consecutive quota parks: ${quota.consecutiveQuotaParks}${quota.warn ? " (warn)" : ""}`);
  return lines;
}

function renderStatus(run: RunView, quota: QuotaView, nowMs: number): string[] {
  const lines: string[] = [];
  if (run.run === null) {
    lines.push("run:     none yet (no run has ever been created)");
  } else {
    lines.push(`run:     ${run.run.id}  ${run.run.status}${run.run.needsReconcile ? "  (needs reconcile)" : ""}`);
    lines.push(`         repo ${run.run.targetRepo}, created ${run.run.createdTs}`);
  }
  if (run.spec === null) lines.push("spec:    none in flight");
  else {
    lines.push(
      `spec:    ${run.spec.specId}  ${run.spec.status}  attempt ${run.spec.attempt}` +
        `${run.spec.needsReconcile ? "  (needs reconcile)" : ""}`
    );
  }
  if (run.stage === null) lines.push("stage:   none in flight");
  else {
    lines.push(
      `stage:   ${run.stage.stage}  ${run.stage.status}  attempt ${run.stage.attempt}` +
        `${run.stage.needsReconcile ? "  (needs reconcile)" : ""}`
    );
  }
  if (run.pauseReason !== null) lines.push(`paused:  ${run.pauseReason}`);
  lines.push(...renderQuota(quota));
  if (run.lastHeartbeatMs === null) lines.push("beat:    none journaled");
  else lines.push(`beat:    ${fmtIso(run.lastHeartbeatMs)} (${fmtDuration(nowMs - run.lastHeartbeatMs)} ago)`);
  if (run.awaitingApproval.length > 0) lines.push(`gated:   ${run.awaitingApproval.join(", ")}`);
  if (run.blockers.length > 0) {
    lines.push("blocked:");
    lines.push(...renderBlockers(run.blockers, "  "));
  }
  return lines;
}

function nodeState(node: DagSpecNode): string {
  if (node.shipped) return `shipped(${node.shippedSource ?? "unknown"})`;
  if (node.skipped) return "skipped";
  if (node.ready) return "ready";
  return "blocked";
}

function nodeNotes(node: DagSpecNode): string {
  const notes: string[] = [];
  if (node.invalidated) notes.push("invalidated");
  if (node.drifted) notes.push("pin drift");
  if (node.pinError !== null) notes.push(`pin unreadable: ${node.pinError}`);
  if (node.specExecStatus !== null) notes.push(`exec ${node.specExecStatus}`);
  return notes.length > 0 ? `  [${notes.join(", ")}]` : "";
}

function renderDag(dag: DagView): string[] {
  const lines: string[] = [];
  const width = dag.specs.reduce((max, node) => Math.max(max, node.id.length), 0);
  for (const node of dag.specs) {
    lines.push(
      `${node.id.padEnd(width)}  ${nodeState(node).padEnd(18)}  ${(node.implementation ?? "unknown").padEnd(12)}${nodeNotes(node)}`.trimEnd()
    );
  }
  lines.push("");
  lines.push(...renderNext(dag));
  if (dag.invalidated.length > 0) lines.push(`invalidated: ${dag.invalidated.join(", ")}`);
  return lines;
}

function renderNext(dag: DagView): string[] {
  const lines = [`next ready: ${dag.nextReady ?? "none"}`];
  // A cycle is why scheduling refuses (spec 012 B-5), so it is reported
  // whether or not something else happens to be ready.
  if (dag.cycle !== null) lines.push(`cycle: ${dag.cycle.join(" -> ")}`);
  if (dag.nextReady === null && dag.blockers.length > 0) {
    lines.push("blocked:");
    lines.push(...renderBlockers(dag.blockers, "  "));
  }
  return lines;
}

function renderHistoryEntry(entry: HistoryEntry): string[] {
  const stages = entry.stages.map((stage) => `${stage.stage}:${stage.status}`).join(" ");
  const lines = [
    `${entry.specId}  attempt ${entry.attempt}  ${entry.status}${entry.needsReconcile ? "  (needs reconcile)" : ""}`,
    `  stages:   ${stages.length > 0 ? stages : "none"}`,
    `  pr:       ${entry.prNumber === null ? "none" : `#${entry.prNumber}`}   ci: ${entry.ciConclusion ?? "unknown"}   verify: ${entry.verifyVerdict ?? "unknown"}`,
    `  merge:    ${entry.mergeSha ?? "none"}`,
  ];
  if (entry.evidenceRefs.length > 0) lines.push(`  evidence: ${entry.evidenceRefs.join(", ")}`);
  return lines;
}

function renderHistory(history: HistoryView): string[] {
  if (history.entries.length === 0) return ["no spec executions journaled yet"];
  const lines: string[] = [];
  for (const entry of history.entries) {
    lines.push(...renderHistoryEntry(entry));
    lines.push("");
  }
  lines.pop();
  return lines;
}

function renderDecision(decision: DecisionRecord): string[] {
  const lines = [
    `${decision.id}  (${decision.specId})`,
    `  ${decision.title}`,
    `  decision:  ${decision.decision}`,
    `  rationale: ${decision.rationale}`,
  ];
  if (decision.scope.length > 0) lines.push(`  scope:     ${decision.scope.join(", ")}`);
  if (decision.supersedes !== undefined) lines.push(`  supersedes: ${decision.supersedes}`);
  return lines;
}

function renderDecisions(view: DecisionsView): string[] {
  const term = view.query.query ?? "";
  if (view.total === 0) return [`no decisions match "${term}"`];
  const lines = [`${view.total} decision${view.total === 1 ? "" : "s"} matching "${term}"`, ""];
  for (const decision of view.decisions) {
    lines.push(...renderDecision(decision));
    lines.push("");
  }
  lines.pop();
  return lines;
}

function renderControl(result: ControlResult): string[] {
  const target = result.specId === null ? "" : ` ${result.specId}`;
  const lines: string[] = [];
  if (!result.applied) {
    lines.push(`${result.verb}${target}: no-op, already satisfied (run ${result.runStatus ?? "unknown"})`);
    return lines;
  }
  lines.push(`${result.verb}${target}: applied (run ${result.runStatus ?? "unknown"})`);
  if (result.record !== null) lines.push(`journaled: seq ${result.record.seq}  ${result.record.kind}  ${result.record.ts}`);
  return lines;
}

// --- API-backed commands (B-1) ----------------------------------------------

// `status` is the one composite read: a run without its quota state cannot
// answer "what is it doing" honestly, because a parked run looks idle. Both
// halves travel as the shapes types.ts already defines, so `--json` is still
// the served envelopes and not a third declaration of either.
async function cmdStatus(deps: OrchestratorCliDeps, client: ApiClient, json: boolean): Promise<number> {
  const [run, quota] = await Promise.all([client.run(), client.quota()]);
  if (!run.ok) return respond(deps, json, run, () => []);
  if (!quota.ok) return respond(deps, json, quota, () => []);
  const composed: ApiResponse<{ run: RunView; quota: QuotaView }> = { ok: true, data: { run: run.data, quota: quota.data } };
  return respond(deps, json, composed, (data) => renderStatus(data.run, data.quota, data.quota.nowMs));
}

const SPEC_VERB_ALIASES: Readonly<Record<string, SpecControlVerb>> = {
  skip: "skip",
  retry: "retry-stage",
  "retry-stage": "retry-stage",
  reverify: "reverify",
  "force-gate": "force-human-gate",
  "force-human-gate": "force-human-gate",
  approve: "approve",
};

async function cmdSpecControl(
  deps: OrchestratorCliDeps,
  client: ApiClient,
  json: boolean,
  specId: string,
  verb: SpecControlVerb
): Promise<number> {
  const call: Record<SpecControlVerb, () => Promise<ApiResponse<ControlResult>>> = {
    skip: () => client.skipSpec(specId),
    "retry-stage": () => client.retryStage(specId),
    reverify: () => client.reverify(specId),
    "force-human-gate": () => client.forceHumanGate(specId),
    approve: () => client.approve(specId),
  };
  return respond(deps, json, await call[verb](), renderControl);
}

// --- journal verify (B-4) ---------------------------------------------------

interface ChainVerdict {
  readonly chain: string;
  readonly file: string;
  readonly verified: boolean;
  readonly count: number | null;
  readonly brokenSeq: number | null;
  readonly reason: string | null;
}

interface JournalVerifyData {
  readonly dir: string;
  readonly verified: boolean;
  readonly chains: readonly ChainVerdict[];
}

function verifyOneChain(dir: string, chain: string, basename?: string): ChainVerdict {
  const file = basename === undefined ? "journal.jsonl" : `${basename}.jsonl`;
  try {
    const result = verifyChain(dir, basename);
    if (result.ok) return { chain, file, verified: true, count: result.count, brokenSeq: null, reason: null };
    return { chain, file, verified: false, count: null, brokenSeq: result.brokenSeq, reason: result.reason };
  } catch (err) {
    // A missing anchor (nothing was ever journaled here) is reported, not
    // thrown: the operator asked a question and gets an answer plus a
    // non-zero exit, never a stack trace.
    return { chain, file, verified: false, count: null, brokenSeq: null, reason: (err as Error).message };
  }
}

// B-4: the operator's independent check walks both chains from their anchors
// with no daemon involved. It is deliberately not an API route, because a
// daemon vouching for its own chain is not an independent check.
function cmdJournalVerify(deps: OrchestratorCliDeps, json: boolean): number {
  const chains = [verifyOneChain(deps.dataDir, "work"), verifyOneChain(deps.dataDir, "decisions", "decisions")];
  const data: JournalVerifyData = { dir: deps.dataDir, verified: chains.every((c) => c.verified), chains };

  if (json) {
    // Offline commands answer in the same envelope shape, with the verdict
    // inside `data`: the command itself succeeded even when the chain it
    // inspected did not, and the exit code carries that distinction.
    printJson(deps, { ok: true, data } satisfies ApiResponse<JournalVerifyData>);
    return data.verified ? EXIT_OK : EXIT_FAILURE;
  }

  deps.out(`chains under ${data.dir}`);
  for (const chain of chains) {
    if (chain.verified) deps.out(`  ${chain.chain.padEnd(9)} ok, ${chain.count} record${chain.count === 1 ? "" : "s"} (${chain.file})`);
    else if (chain.brokenSeq !== null) deps.err(`  ${chain.chain.padEnd(9)} BROKEN at seq ${chain.brokenSeq}: ${chain.reason}`);
    else deps.err(`  ${chain.chain.padEnd(9)} unverifiable: ${chain.reason}`);
  }
  return data.verified ? EXIT_OK : EXIT_FAILURE;
}

// --- daemon lifecycle (B-2) -------------------------------------------------

interface DaemonLockFile {
  readonly pid: number;
  readonly procStartMs: number;
}

type LockState =
  | { readonly kind: "none" }
  | { readonly kind: "live"; readonly lock: DaemonLockFile }
  | { readonly kind: "stale"; readonly lock: DaemonLockFile; readonly reason: string }
  | { readonly kind: "corrupt"; readonly reason: string };

function daemonLockPath(dataDir: string): string {
  return join(dataDir, "daemon.lock");
}

function daemonLogPath(dataDir: string): string {
  return join(dataDir, "daemon.log");
}

// The same identity check spec 021 B-1 acquires under: a live pid whose
// process start time no longer matches the recorded one is pid reuse, not a
// running daemon, which is exactly the defect spec 007 recorded.
function readLockState(deps: OrchestratorCliDeps): LockState {
  const path = daemonLockPath(deps.dataDir);
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return { kind: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "corrupt", reason: `lock file is not JSON: ${(err as Error).message}` };
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw?.pid !== "number" || typeof raw?.procStartMs !== "number") {
    return { kind: "corrupt", reason: "lock file is not {pid, procStartMs}" };
  }
  const lock: DaemonLockFile = { pid: raw.pid, procStartMs: raw.procStartMs };
  if (!deps.inspector.isAlive(lock.pid)) return { kind: "stale", lock, reason: `pid ${lock.pid} is not running` };
  const currentStart = deps.inspector.procStartMs(lock.pid);
  if (currentStart === null) return { kind: "stale", lock, reason: `pid ${lock.pid} has no readable start time` };
  if (currentStart !== lock.procStartMs) {
    return { kind: "stale", lock, reason: `pid ${lock.pid} was reused by a process started at ${fmtIso(currentStart)}` };
  }
  return { kind: "live", lock };
}

interface DaemonStatusData {
  readonly lockPath: string;
  readonly logPath: string;
  readonly url: string;
  readonly running: boolean;
  readonly pid: number | null;
  readonly procStartMs: number | null;
  readonly staleLock: boolean;
  readonly detail: string | null;
}

function daemonStatusData(deps: OrchestratorCliDeps, url: string, state: LockState): DaemonStatusData {
  const base = { lockPath: daemonLockPath(deps.dataDir), logPath: daemonLogPath(deps.dataDir), url };
  switch (state.kind) {
    case "live":
      return { ...base, running: true, pid: state.lock.pid, procStartMs: state.lock.procStartMs, staleLock: false, detail: null };
    case "stale":
      return { ...base, running: false, pid: state.lock.pid, procStartMs: state.lock.procStartMs, staleLock: true, detail: state.reason };
    case "corrupt":
      return { ...base, running: false, pid: null, procStartMs: null, staleLock: true, detail: state.reason };
    case "none":
      return { ...base, running: false, pid: null, procStartMs: null, staleLock: false, detail: null };
  }
}

function respondDaemon(deps: OrchestratorCliDeps, json: boolean, data: DaemonStatusData, lines: readonly string[], code: number): number {
  if (json) printJson(deps, { ok: true, data } satisfies ApiResponse<DaemonStatusData>);
  else for (const line of lines) deps.out(line);
  return code;
}

// "Not running" is the same absence `orchestrator status` reports as exit 2,
// so a script can branch on one code for "there is no daemon" whichever
// command asked.
function cmdDaemonStatus(deps: OrchestratorCliDeps, url: string, json: boolean): number {
  const state = readLockState(deps);
  const data = daemonStatusData(deps, url, state);
  if (data.running) {
    return respondDaemon(
      deps,
      json,
      data,
      [
        `orchestrator daemon running (pid ${data.pid}, started ${fmtIso(data.procStartMs!)})`,
        // This command is offline by design (B-1), so the url is the one the
        // other commands would use, not one this answer has confirmed is
        // being served.
        `api:  ${url} (configured, not probed)`,
        `log:  ${data.logPath}`,
      ],
      EXIT_OK
    );
  }
  const detail = data.detail === null ? "" : ` (${data.detail})`;
  return respondDaemon(deps, json, data, [`no orchestrator daemon running${detail}`, `lock: ${data.lockPath}`], EXIT_UNREACHABLE);
}

async function waitUntil(deps: OrchestratorCliDeps, deadlineMs: number, condition: () => boolean | Promise<boolean>): Promise<boolean> {
  for (;;) {
    if (await condition()) return true;
    if (deps.now() >= deadlineMs) return false;
    await deps.sleep(deps.pollIntervalMs);
  }
}

interface DaemonStartData extends DaemonStatusData {
  readonly spawned: boolean;
  readonly ready: boolean;
}

// `daemon start` is the one thing no HTTP request can do (spec 022 D-1): it
// creates the process. It then waits for two proofs before claiming success,
// the identity lock appearing (the daemon reached spec 021 B-2's first step)
// and the API answering (it reached the last one), because a pid alone
// proves nothing about a process that may have died on its first read.
async function cmdDaemonStart(deps: OrchestratorCliDeps, url: string, json: boolean): Promise<number> {
  const existing = readLockState(deps);
  if (existing.kind === "live") {
    const data: DaemonStartData = { ...daemonStatusData(deps, url, existing), spawned: false, ready: true };
    if (json) printJson(deps, { ok: true, data } satisfies ApiResponse<DaemonStartData>);
    else deps.out(`orchestrator daemon already running (pid ${data.pid})`);
    return EXIT_OK;
  }

  const logPath = daemonLogPath(deps.dataDir);
  const pid = deps.spawnDaemon({ dataDir: deps.dataDir, repoDir: deps.repoDir, url, logPath });

  // One deadline covers both proofs: an operator who allowed fifteen seconds
  // for the daemon to come up meant fifteen seconds in total, not per step.
  const deadline = deps.now() + deps.startTimeoutMs;
  const locked = await waitUntil(deps, deadline, () => readLockState(deps).kind === "live");
  const client = deps.createClient(url);
  const ready = locked && (await waitUntil(deps, deadline, async () => (await client.meta()).ok));

  const state = readLockState(deps);
  const data: DaemonStartData = {
    ...daemonStatusData(deps, url, state),
    spawned: pid !== null,
    ready,
    ...(state.kind === "none" && pid !== null ? { pid } : {}),
  };

  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<DaemonStartData>);
    return ready ? EXIT_OK : EXIT_FAILURE;
  }
  if (ready) {
    deps.out(`orchestrator daemon started (pid ${data.pid ?? pid ?? "unknown"})`);
    deps.out(`api:  ${url}`);
    deps.out(`log:  ${logPath}`);
    return EXIT_OK;
  }
  deps.err(
    locked
      ? `orchestrator daemon holds the lock but ${url} did not answer within ${fmtDuration(deps.startTimeoutMs)}; see ${logPath}`
      : `orchestrator daemon did not acquire ${daemonLockPath(deps.dataDir)} within ${fmtDuration(deps.startTimeoutMs)}; see ${logPath}`
  );
  return EXIT_FAILURE;
}

// SIGTERM only. Spec 021 B-6 defines what the daemon does with it (finish the
// current journal write, kill any live session child, release the lock); an
// escalation to SIGKILL would be this file inventing a shutdown policy the
// kernel spec deliberately does not have.
async function cmdDaemonStop(deps: OrchestratorCliDeps, url: string, json: boolean): Promise<number> {
  const state = readLockState(deps);
  if (state.kind !== "live") {
    const data = daemonStatusData(deps, url, state);
    const detail = data.detail === null ? "" : ` (${data.detail})`;
    return respondDaemon(deps, json, data, [`no orchestrator daemon running${detail}`], EXIT_OK);
  }

  const pid = state.lock.pid;
  try {
    deps.kill(pid, "SIGTERM");
  } catch (err) {
    const reason = `could not signal pid ${pid}: ${(err as Error).message}`;
    const data: DaemonStatusData = { ...daemonStatusData(deps, url, readLockState(deps)), detail: reason };
    if (json) printJson(deps, { ok: true, data } satisfies ApiResponse<DaemonStatusData>);
    else deps.err(reason);
    return EXIT_FAILURE;
  }

  const stopped = await waitUntil(deps, deps.now() + deps.stopTimeoutMs, () => readLockState(deps).kind !== "live");
  const data = daemonStatusData(deps, url, readLockState(deps));
  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<DaemonStatusData>);
    return stopped ? EXIT_OK : EXIT_FAILURE;
  }
  if (stopped) {
    deps.out(`orchestrator daemon stopped (pid ${pid})`);
    return EXIT_OK;
  }
  deps.err(`pid ${pid} still holds ${data.lockPath} ${fmtDuration(deps.stopTimeoutMs)} after SIGTERM`);
  return EXIT_FAILURE;
}

// --- the foreground daemon (what `daemon start` spawns) ---------------------

function chainFileName(basename: string | undefined): string {
  return basename === undefined ? "journal.jsonl" : `${basename}.jsonl`;
}

function isJournalRecordShape(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seq === "number" &&
    Number.isInteger(record.seq) &&
    typeof record.ts === "string" &&
    typeof record.kind === "string" &&
    typeof record.prevHash === "string" &&
    typeof record.recordHash === "string" &&
    "payload" in record
  );
}

// The API needs a read-only view of both chains while the daemon holds the
// single writer handle for each (spec 011 B-2), and that handle is the
// Daemon's own private field: `journalViewFromHandle` is unreachable from
// outside the kernel module. So the boot path reads the chain file instead.
// Appends only ever extend it, so a size or mtime change is the whole cache
// key, and a trailing line that does not parse (or does not continue the
// sequence) is a torn tail, which is what journal.ts's own open-time recovery
// calls it too: it is dropped rather than raised, because the writer is about
// to rewrite it.
export function journalViewFromDir(dir: string, basename?: string): JournalView {
  const path = join(dir, chainFileName(basename));
  let cachedSize = -1;
  let cachedMtimeMs = -1;
  let cached: JournalRecord[] = [];

  return {
    records(): readonly JournalRecord[] {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path);
      } catch {
        return [];
      }
      if (stat.size === cachedSize && stat.mtimeMs === cachedMtimeMs) return cached;

      const text = fs.readFileSync(path, "utf8");
      const records: JournalRecord[] = [];
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          break;
        }
        if (!isJournalRecordShape(parsed) || parsed.seq !== records.length) break;
        records.push(parsed);
      }

      cachedSize = stat.size;
      cachedMtimeMs = stat.mtimeMs;
      cached = records;
      return records;
    },
  };
}

// Spec 021 B-2 fixes the boot order (lock, journals, recovery, then the loop
// and the API), and `Daemon.start()` owns all of it up to the loop; this
// function adds the last step, the HTTP surface spec 022 serves in the same
// process, and the shutdown that stops it before the daemon releases its
// lock. It is what `daemon start` spawns, and it is runnable directly for an
// operator who wants the daemon in the foreground.
async function cmdDaemonRun(deps: OrchestratorCliDeps, url: string): Promise<number> {
  const bind = parseBind(url);
  if (bind === null) return usage(deps, `--url ${url} is not a usable base url`);

  const daemonDeps = createProductionDaemonDeps({ dataDir: deps.dataDir, repoDir: deps.repoDir });
  const daemon = new Daemon(daemonDeps);
  try {
    // The identity lock is spec 021 B-1's, so a second daemon is refused
    // there, by the strongest check available (pid plus process start time).
    // Here it is simply an honest message rather than a stack trace.
    await daemon.start();
  } catch (err) {
    deps.err(`orchestrator daemon: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  let server: ApiServer;
  try {
    server = createApiServer({
      journal: journalViewFromDir(deps.dataDir),
      decisions: journalViewFromDir(deps.dataDir, "decisions"),
      dagReader: daemonDeps.dagReader,
      repoDir: deps.repoDir,
      evidenceDir: join(deps.dataDir, "verify-evidence"),
      controls: daemon,
      host: bind.host,
      port: bind.port,
    });
  } catch (err) {
    // The daemon is up and holding the lock; if the API cannot bind there is
    // no interface to control it through, so it comes back down cleanly
    // rather than running headless.
    await daemon.shutdown();
    deps.err(`orchestrator daemon: api refused to bind: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  deps.out(`orchestrator daemon running (pid ${process.pid}, run ${daemon.runId} ${daemon.runStatus})`);
  deps.out(`api:  ${server.url}`);

  let signalled = false;
  const onSignal = (): void => {
    if (signalled) return;
    signalled = true;
    void (async () => {
      await server.stop();
      await daemon.shutdown();
      process.exit(EXIT_OK);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await daemon.join();
    deps.out(`orchestrator daemon: run ${daemon.runId} ended ${daemon.runStatus}`);
    return EXIT_OK;
  } catch (err) {
    deps.err(`orchestrator daemon: the run loop died: ${(err as Error).message}`);
    return EXIT_FAILURE;
  } finally {
    await server.stop();
    await daemon.shutdown();
    // A registered signal listener keeps the event loop alive, so a run that
    // ends on its own would otherwise leave the process hanging with nothing
    // left to do.
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

async function cmdDaemon(deps: OrchestratorCliDeps, url: string, json: boolean, rest: readonly string[]): Promise<number> {
  const sub = rest[0];
  if (sub === undefined) return usage(deps, "daemon needs a subcommand (start|stop|status|run)");
  if (rest.length > 1) return usage(deps, `unexpected argument "${rest[1]}" after daemon ${sub}`);
  switch (sub) {
    case "status":
      return cmdDaemonStatus(deps, url, json);
    case "start":
      return cmdDaemonStart(deps, url, json);
    case "stop":
      return cmdDaemonStop(deps, url, json);
    case "run":
      return cmdDaemonRun(deps, url);
    default:
      return usage(deps, `unknown daemon subcommand "${sub}" (expected start, stop, status, or run)`);
  }
}

// --- dispatch ---------------------------------------------------------------

export async function runOrchestratorCli(
  argv: readonly string[],
  overrides: Partial<OrchestratorCliDeps> = {}
): Promise<number> {
  const deps: OrchestratorCliDeps = { ...defaultOrchestratorCliDeps(), ...overrides };
  const parsed = parseArgs(argv);
  if (!parsed.ok) return usage(deps, parsed.reason);

  const args = parsed.args;
  const scoped: OrchestratorCliDeps = {
    ...deps,
    ...(args.dataDir !== null ? { dataDir: args.dataDir } : {}),
    ...(args.repoDir !== null ? { repoDir: args.repoDir } : {}),
  };
  const url = resolveBaseUrl(args, scoped);
  const [command, ...rest] = args.rest;
  if (command === undefined) return usage(scoped, "a command is required");

  // The API-backed commands cannot throw (api-client.ts answers transport
  // failure in the envelope), but the offline ones touch the filesystem and
  // spawn processes. An operator asking a question gets an answer and an
  // exit code, never a stack trace: that is what the "exit 2, never a crash"
  // clause of this spec's own verification is about.
  try {
    return await dispatch(scoped, args, url, command, rest);
  } catch (err) {
    scoped.err(`error: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }
}

async function dispatch(
  scoped: OrchestratorCliDeps,
  args: ParsedArgs,
  url: string,
  command: string,
  rest: readonly string[]
): Promise<number> {
  // The two offline commands (B-4 and the daemon lifecycle) are dispatched
  // before a client is ever created: they must work with nothing listening.
  if (command === "journal") {
    if (rest[0] !== "verify") return usage(scoped, `journal needs the "verify" subcommand`);
    if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after journal verify`);
    return cmdJournalVerify(scoped, args.json);
  }
  if (command === "daemon") return cmdDaemon(scoped, url, args.json, rest);

  const client = scoped.createClient(url);
  switch (command) {
    case "status":
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after status`);
      return cmdStatus(scoped, client, args.json);
    case "dag":
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after dag`);
      return respond(scoped, args.json, await client.dag(), renderDag);
    case "next":
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after next`);
      return respond(scoped, args.json, await client.dag(), renderNext);
    case "history":
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after history`);
      return respond(scoped, args.json, await client.history(), renderHistory);
    case "start":
    case "pause":
    case "resume": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after ${command}`);
      const control =
        command === "start" ? client.startRun() : command === "pause" ? client.pauseRun() : client.resumeRun();
      return respond(scoped, args.json, await control, renderControl);
    }
    case "decisions": {
      const query = rest[0];
      if (query === undefined) return usage(scoped, "decisions needs a query");
      if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after decisions`);
      return respond(scoped, args.json, await client.decisions({ query }), renderDecisions);
    }
    case "spec": {
      const specId = rest[0];
      const verbToken = rest[1];
      if (specId === undefined) return usage(scoped, "spec needs a spec id");
      if (verbToken === undefined) return usage(scoped, `spec ${specId} needs a verb (skip|retry|reverify|force-gate|approve)`);
      if (rest.length > 2) return usage(scoped, `unexpected argument "${rest[2]}" after spec ${specId} ${verbToken}`);
      const verb = SPEC_VERB_ALIASES[verbToken];
      if (verb === undefined) {
        return usage(scoped, `unknown spec verb "${verbToken}" (expected skip, retry, reverify, force-gate, or approve)`);
      }
      return cmdSpecControl(scoped, client, args.json, specId, verb);
    }
    default:
      return usage(scoped, `unknown command "${command}"`);
  }
}

export async function cmdOrchestrator(args: string[]): Promise<void> {
  const code = await runOrchestratorCli(args);
  if (code !== EXIT_OK) process.exit(code);
}
