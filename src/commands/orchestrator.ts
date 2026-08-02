// The orchestrator's primary control plane (specs 023 and 028): one command
// group on the observatory binary that is a pure client of the daemon's HTTP
// API (specs 022 and 027), plus the two jobs only a terminal can do:
// verifying both hash chains offline, and owning the daemon process's own
// lifecycle.
//
// v2 is project-scoped, because one daemon now answers for many projects
// (028): a `projects` subgroup registers and arms them, `--project <name>`
// says which one a verb means, and `status` without it is the composite view
// of the daemon itself plus one row per project. What a verb addresses is
// therefore always explicit or always the sole registered project, never a
// silent guess.
//
// Three disciplines shape everything below.
//
// First, B-1: every command except `journal verify` and `daemon
// start|stop|status` goes through the typed client in api-client.ts. Nothing
// here folds a journal, reads the registry, or re-derives readiness while a
// daemon is running; if the answer is not in an envelope the daemon served,
// this file does not know it. `journal verify --project` is the one place
// this file folds the registry itself, and precisely because it must not ask
// the daemon where to look (028 B-3).
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
import { join, resolve } from "path";
import { DATA_DIR, PROJECT_DIR } from "../paths";
import { verifyChain, type JournalHandle, type JournalRecord } from "../orchestrator/journal";
import { createApiClient, type ApiClient, type ProjectClient } from "../orchestrator/api/api-client";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  createApiServer,
  type ApiServer,
  type JournalView,
  type ProjectsTarget,
} from "../orchestrator/api/server";
import { createProcessInspector, createProductionDaemonDeps, type ProcessInspector } from "../orchestrator/daemon";
import { StandbyDaemon } from "../orchestrator/standby";
import { killLiveSession } from "../orchestrator/session";
import { createProcessDagReader } from "../orchestrator/dag";
import {
  PROJECTS_CHAIN_BASENAME,
  createProcessProjectProbe,
  foldProjects,
  projectStateRoot,
  qualifyProject,
  registerProject,
  removeProject,
  requalifyProject,
  setProjectArmed,
  type Project,
  type ProjectProbe,
  type ProjectSource,
  type RecordedQualification,
} from "../orchestrator/projects";
import { API_VERSION, API_VERSION_HEADER, projectRoute } from "../orchestrator/api/types";
import { ECONOMICS_ROUTE, type RunEconomics, type SpecEconomics } from "../orchestrator/economics";
import type { ServedEconomicsView } from "../orchestrator/api/state";
import type {
  ApiErrorKind,
  ApiMeta,
  ApiResponse,
  ControlResult,
  DagSpecNode,
  DagView,
  DecisionsView,
  HistoryEntry,
  HistoryView,
  ProjectControlResult,
  ProjectView,
  ProjectsView,
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

  status                       daemon state, quota, and one row per project
  projects                     the registry: name, armed, qualification, run
  projects add <path>          register a project [--name <slug>] [--disarmed]
  projects arm|disarm <name>   let the scheduler drive it, or hold it back
  projects requalify <name>    re-run the preflight and journal the verdict
  projects remove <name>       drop it from the registry (a tombstone)
  dag                          every spec with readiness, blockers, drift
  next                         the next ready spec, or why there is none
  start | pause | resume       run controls
  history                      spec executions with their evidence trail
  economics                    per-spec cost and rework rollups, run totals
  decisions <query>            search the sealed decision ledger
  spec <id> <verb>             skip | retry | reverify | force-gate | approve
  journal verify               verify both chains offline (no daemon needed)
  daemon start|stop|status     daemon process lifecycle (identity-checked lock)
  daemon run                   run the daemon in the foreground (what start spawns)

  --project <name>             scope a verb (status through spec) to one project
  --json                       print the raw envelope instead of human output
  --url <base>                 daemon base url (default http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT})
  --data-dir <dir>             the daemon home (lock, log, projects chain)
  --dir <dir>                  state root for journal verify, bypassing the registry
  --name <slug>                project name for projects add
  --disarmed                   register disarmed (projects add)
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
  // 028 B-2's scoping flag, and the two flags the projects group's `add` takes.
  readonly project: string | null;
  readonly dir: string | null;
  readonly name: string | null;
  readonly disarmed: boolean;
  readonly rest: readonly string[];
}

type ParseResult = { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly reason: string };

// Unknown flags are refused rather than ignored. Spec 005 records silent
// flag-swallowing as a defect of the observatory commands; repeating it in a
// control plane whose verbs journal irreversible facts would be worse than a
// cosmetic annoyance.
function parseArgs(argv: readonly string[]): ParseResult {
  let json = false;
  let disarmed = false;
  let url: string | null = null;
  let dataDir: string | null = null;
  let repoDir: string | null = null;
  let project: string | null = null;
  let dir: string | null = null;
  let name: string | null = null;
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
    "--project": (v) => {
      project = v;
    },
    "--dir": (v) => {
      dir = v;
    },
    "--name": (v) => {
      name = v;
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--disarmed") {
      disarmed = true;
      continue;
    }
    // `Object.hasOwn`, not a truthiness test: a plain object literal inherits
    // Object.prototype, so a bare word like "toString" or "constructor" would
    // otherwise look up as a valued flag and silently swallow the argument
    // after it. That is the flag-swallowing 023 D-6 refuses, reached by a
    // different door. Every string-keyed table in this file is read this way.
    const setter = Object.hasOwn(valued, arg) ? valued[arg] : undefined;
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

  return { ok: true, args: { json, url, dataDir, repoDir, project, dir, name, disarmed, rest } };
}

// The extra flags each command accepts. 023 D-6 refuses an unknown flag
// rather than ignoring it, and a known flag that means nothing to the verb at
// hand is the same defect in different clothes: `--project` on `daemon status`
// would silently address nothing at all. A command absent from this table is
// an unknown command, reported as one before its flags are judged.
const EXTRA_FLAGS: Readonly<Record<string, readonly string[] | undefined>> = {
  status: ["--project"],
  dag: ["--project"],
  next: ["--project"],
  start: ["--project"],
  pause: ["--project"],
  resume: ["--project"],
  history: ["--project"],
  economics: ["--project"],
  decisions: ["--project"],
  spec: ["--project"],
  projects: [],
  journal: ["--project", "--dir"],
  daemon: [],
};

const PROJECTS_ADD_FLAGS: readonly string[] = ["--name", "--disarmed"];

function strayFlag(args: ParsedArgs, accepted: readonly string[]): string | null {
  const present = [
    args.project !== null ? "--project" : null,
    args.dir !== null ? "--dir" : null,
    args.name !== null ? "--name" : null,
    args.disarmed ? "--disarmed" : null,
  ].filter((flag): flag is string => flag !== null);
  return present.find((flag) => !accepted.includes(flag)) ?? null;
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
  // The pool is the account's, but the park was journaled by one project's
  // run (027 B-4), and an operator who cannot see which one cannot check the
  // horizon against anything.
  if (quota.parked && quota.project !== null) lines.push(`         park journaled by project ${quota.project}`);
  lines.push(`         consecutive quota parks: ${quota.consecutiveQuotaParks}${quota.warn ? " (warn)" : ""}`);
  return lines;
}

// 027 B-4's daemon meta: standby, driving, or parked, plus who holds the one
// flight slot. A server with no scheduler attached says so rather than having
// a state invented for it.
function renderDaemon(meta: ApiMeta, nowMs: number): string[] {
  const daemon = meta.daemon;
  if (daemon === null) return ["daemon:  no scheduler attached (this server answers reads only)"];
  const holder = daemon.activeProject === null ? "" : `  ${daemon.activeProject}`;
  const scan = daemon.scanIntervalMs === null ? "scan interval unknown" : `scan every ${fmtDuration(daemon.scanIntervalMs)}`;
  const last = daemon.lastScanMs === null ? "no scan yet" : `last scan ${fmtDuration(nowMs - daemon.lastScanMs)} ago`;
  return [`daemon:  ${daemon.state}${holder}`, `         ${scan}, ${last}`];
}

// 025 B-4: an unqualified project stays visible with why it was refused, so
// the row names the checks that failed rather than reducing the verdict to a
// word.
function qualificationCell(qualification: RecordedQualification): string {
  if (qualification.qualified) return "qualified";
  const failed = qualification.checks.filter((check) => !check.ok).map((check) => check.id);
  return failed.length === 0 ? "unqualified" : `unqualified (${failed.join(", ")})`;
}

// What that project's run is doing, as its row's last column. A state root
// that could not be read says so (022 B-6): it is not the same fact as a
// project that has no run yet.
function projectRunCell(view: ProjectView): string {
  if (view.readError !== null) return `unreadable: ${view.readError}`;
  if (view.run === null) return "no run yet";
  const spec = view.spec === null ? "" : `  ${view.spec.specId}`;
  const stage = view.stage === null ? "" : `/${view.stage.stage}`;
  return `${view.run.status}${spec}${stage}${view.run.needsReconcile ? "  (needs reconcile)" : ""}`;
}

// B-1's one row per project, shared by the `projects` list, the composite
// `status`, and the snapshot a registry control returns.
function renderProjectRows(projects: readonly ProjectView[]): string[] {
  if (projects.length === 0) return ["no projects are registered with this daemon"];
  const nameWidth = projects.reduce((max, view) => Math.max(max, view.name.length), 0);
  return projects.map((view) =>
    `${view.name.padEnd(nameWidth)}  ${(view.armed ? "armed" : "disarmed").padEnd(8)}  ` +
    `${qualificationCell(view.qualification).padEnd(11)}  ${projectRunCell(view)}`.trimEnd()
  );
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
    // The run's own journaled stop reason (run.blocked), not a live
    // readiness read: a requalification can heal the cascade afterwards,
    // and `dag` is the view that reflects that (023 D-9).
    lines.push("blocked (journaled at run stop; `dag` shows the live view):");
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

// --- economics rendering (spec 030 B-4) --------------------------------------

// Micro-USD to dollars at four decimals: the journal's own unit is exact
// integers, and $0.0001 resolution keeps a cheap session from rendering as a
// bare $0.00.
function fmtMicroUsd(micro: number): string {
  return `$${(micro / 1e6).toFixed(4)}`;
}

// FR-003's honesty clause: an unreported cost is named unknown, never
// printed as a zero. A reported sum and an unknown count can coexist (some
// sessions reported, some did not) and both are said.
function costCell(costMicroUsd: number | null, costUnknownSessions: number): string {
  const parts: string[] = [];
  if (costMicroUsd !== null) parts.push(fmtMicroUsd(costMicroUsd));
  if (costUnknownSessions > 0) parts.push(`cost unknown x${costUnknownSessions}`);
  return parts.length === 0 ? "no cost journaled" : parts.join(" + ");
}

function terminationCell(byTermination: Readonly<Record<string, number>>): string {
  const parts = Object.entries(byTermination)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function parkCell(run: RunEconomics): string {
  if (run.quotaParks === 0) return "quota parks 0";
  const parked =
    run.parkedMs === null ? "parked duration unknown (a park never resumed)" : `parked ${fmtDuration(run.parkedMs)}`;
  return `quota parks ${run.quotaParks} (${parked})`;
}

function wallCell(wallClockMs: number | null): string {
  return wallClockMs === null ? "duration unknown" : fmtDuration(wallClockMs);
}

function renderSpecEconomics(spec: SpecEconomics, width: number): string {
  return (
    `${spec.specId.padEnd(width)}  sessions ${spec.sessions}${terminationCell(spec.sessionsByTermination)}  ` +
    `remediations ${spec.remediationRounds}  hook blocks ${spec.hookBlockedStages}  ` +
    `${costCell(spec.costMicroUsd, spec.costUnknownSessions)}  ${wallCell(spec.wallClockMs)}`
  );
}

function renderEconomics(view: ServedEconomicsView): string[] {
  // B-2 as rendered: an empty journal has nothing to total, and saying so
  // beats a page of fabricated zeros.
  if (view.totals === null) return [`project ${view.project}: the journal is empty; nothing to roll up`];

  const lines: string[] = [];
  if (view.specs.length === 0) lines.push("no spec executions journaled yet");
  const width = view.specs.reduce((max, spec) => Math.max(max, spec.specId.length), 0);
  for (const spec of view.specs) lines.push(renderSpecEconomics(spec, width));

  for (const run of view.runs) {
    lines.push("");
    lines.push(`run ${run.runId}  ${run.status}  ${wallCell(run.wallClockMs)}`);
    lines.push(
      `  sessions ${run.sessions}${terminationCell(run.sessionsByTermination)}  ` +
        `remediations ${run.remediationRounds}  hook blocks ${run.hookBlockedStages}`
    );
    lines.push(`  cost ${costCell(run.costMicroUsd, run.costUnknownSessions)}  ${parkCell(run)}`);
  }

  const totals = view.totals;
  lines.push("");
  lines.push(
    `totals: sessions ${totals.sessions}${terminationCell(totals.sessionsByTermination)}  ` +
      `remediations ${totals.remediationRounds}  hook blocks ${totals.hookBlockedStages}`
  );
  const parked =
    totals.quotaParks === 0
      ? "quota parks 0"
      : totals.parkedMs === null
        ? `quota parks ${totals.quotaParks} (parked duration unknown, a park never resumed)`
        : `quota parks ${totals.quotaParks} (parked ${fmtDuration(totals.parkedMs)})`;
  lines.push(`  cost ${costCell(totals.costMicroUsd, totals.costUnknownSessions)}  ${parked}`);
  return lines;
}

// Spec 030 B-4: the one economics read. The typed client (api-client.ts)
// belongs to specs 022/027 and is outside 030's declared territory, so this
// verb fetches its single route directly, under the same discipline the
// client applies everywhere else: the path comes from the shared constants
// (never hand-built twice), transport failure answers in the envelope as
// `unreachable`, and an answer that is not an envelope is
// `malformed-response`, never coerced into a plausible shape.
async function fetchEconomics(baseUrl: string, project: string): Promise<ApiResponse<ServedEconomicsView>> {
  const path = projectRoute(project, ECONOMICS_ROUTE);
  let text: string;
  try {
    const response = await fetch(`${baseUrl}${path}`, { headers: { [API_VERSION_HEADER]: String(API_VERSION) } });
    text = await response.text();
  } catch (err) {
    return { ok: false, error: { kind: "unreachable", message: `${baseUrl}${path}: ${(err as Error).message}` } };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { ok?: unknown }).ok === "boolean") {
      return parsed as ApiResponse<ServedEconomicsView>;
    }
  } catch {
    // not JSON; reported below
  }
  return { ok: false, error: { kind: "malformed-response", message: "response body is not an {ok, ...} envelope" } };
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

// A registry control's answer (027 B-2): the journaled record itself, plus the
// project's row as it stands afterwards, which is what makes an arm or a
// disarm checkable without a second command.
function renderProjectControl(result: ProjectControlResult): string[] {
  const target = result.project ?? "(no name journaled)";
  if (!result.applied) return [`${result.verb} ${target}: no-op, nothing journaled`];
  const lines = [`${result.verb} ${target}: applied`];
  if (result.record !== null) lines.push(`journaled: seq ${result.record.seq}  ${result.record.kind}  ${result.record.ts}`);
  if (result.snapshot !== null) lines.push(...renderProjectRows([result.snapshot]).map((line) => `  ${line}`));
  return lines;
}

// --- API-backed commands (B-1) ----------------------------------------------

// Which project a project-scoped verb addresses (028 B-2). `--project <name>`
// says it outright and the daemon resolves it: an unknown name comes back
// `not-found` from the route itself, which is B-4's operational failure and
// not something a client should pre-empt by listing the registry first.
// Without the flag the sole registered project is the only unambiguous
// answer, and zero or several is refused by name rather than guessed at.
async function resolveProject(client: ApiClient, named: string | null): Promise<ApiResponse<ProjectClient>> {
  if (named !== null) return { ok: true, data: client.project(named) };
  const listed = await client.projects();
  if (!listed.ok) return listed;
  const names = listed.data.projects.map((project) => project.name);
  if (names.length === 1) return { ok: true, data: client.project(names[0]!) };
  if (names.length === 0) {
    return { ok: false, error: { kind: "not-found", message: "no projects are registered with this daemon" } };
  }
  return {
    ok: false,
    error: {
      kind: "conflict",
      message: `${names.length} projects are registered (${names.join(", ")}); name one with --project`,
    },
  };
}

// The composite `status` (028 B-2, spec 023 D-1 as amended): what the daemon
// itself is doing, the account's one quota pool, and one row per project.
// Composed from three served envelopes whose payloads are the types the API
// already declares, so `--json` is still the daemon's own shapes and not a
// fourth declaration of any of them.
interface CompositeStatusView {
  readonly meta: ApiMeta;
  readonly quota: QuotaView;
  readonly projects: ProjectsView;
}

function renderCompositeStatus(view: CompositeStatusView): string[] {
  const lines = renderDaemon(view.meta, view.quota.nowMs);
  lines.push(...renderQuota(view.quota));
  const rows = view.projects.projects;
  lines.push(`projects: ${rows.length}`);
  lines.push(...renderProjectRows(rows).map((line) => `  ${line}`));
  return lines;
}

async function cmdStatusAll(deps: OrchestratorCliDeps, client: ApiClient, json: boolean): Promise<number> {
  const [meta, quota, projects] = await Promise.all([client.meta(), client.quota(), client.projects()]);
  if (!meta.ok) return respond(deps, json, meta, () => []);
  if (!quota.ok) return respond(deps, json, quota, () => []);
  if (!projects.ok) return respond(deps, json, projects, () => []);
  const composed: ApiResponse<CompositeStatusView> = {
    ok: true,
    data: { meta: meta.data, quota: quota.data, projects: projects.data },
  };
  return respond(deps, json, composed, renderCompositeStatus);
}

// `status --project <name>`: a run without its quota state cannot answer
// "what is it doing" honestly, because a parked run looks idle. The run is
// the project's and the quota is the account's (027 B-4), and both travel as
// the shapes types.ts already defines, so `--json` is still the served
// envelopes and not a third declaration of either.
async function cmdStatus(
  deps: OrchestratorCliDeps,
  client: ApiClient,
  project: ProjectClient,
  json: boolean
): Promise<number> {
  const [run, quota] = await Promise.all([project.run(), client.quota()]);
  if (!run.ok) return respond(deps, json, run, () => []);
  if (!quota.ok) return respond(deps, json, quota, () => []);
  const composed: ApiResponse<{ run: RunView; quota: QuotaView }> = { ok: true, data: { run: run.data, quota: quota.data } };
  return respond(deps, json, composed, (data) => renderStatus(data.run, data.quota, data.quota.nowMs));
}

// --- the projects group (028 B-1) -------------------------------------------

const PROJECT_REGISTRY_CALLS: Readonly<
  Record<string, ((client: ApiClient, name: string) => Promise<ApiResponse<ProjectControlResult>>) | undefined>
> = {
  arm: (client, name) => client.armProject(name),
  disarm: (client, name) => client.disarmProject(name),
  requalify: (client, name) => client.requalifyProject(name),
  remove: (client, name) => client.removeProject(name),
};

// What `projects add --disarmed` prints under `--json` (D-1): the two served
// payloads, because registering disarmed is two controls against a v2
// registration route that has no armed field of its own.
interface ProjectAddView {
  readonly registered: ProjectControlResult;
  readonly disarmed: ProjectControlResult;
}

async function cmdProjectsAdd(
  deps: OrchestratorCliDeps,
  client: ApiClient,
  json: boolean,
  path: string,
  name: string | null,
  disarmed: boolean
): Promise<number> {
  // D-2: the path is resolved against this shell's working directory before
  // it travels, because the registry stores an absolute path and the daemon's
  // own cwd is not the operator's.
  const absolute = resolve(path);
  const registered = await client.registerProject({ path: absolute, ...(name === null ? {} : { name }) });
  if (!registered.ok) return respond(deps, json, registered, renderProjectControl);
  if (!disarmed) return respond(deps, json, registered, renderProjectControl);

  // Registration derives its own name when none was passed (025 D-1), so the
  // follow-up control addresses the name the chain journaled, not a guess.
  const journaled = registered.data.project;
  if (journaled === null) return respond(deps, json, registered, renderProjectControl);

  const held = await client.disarmProject(journaled);
  if (!held.ok) {
    // Half-applied, and said so: the project is registered and armed. `--json`
    // still prints the served failure envelope verbatim.
    if (!json) deps.err(`registered "${journaled}", but disarming it failed`);
    return respond(deps, json, held, () => []);
  }
  const composed: ApiResponse<ProjectAddView> = { ok: true, data: { registered: registered.data, disarmed: held.data } };
  return respond(deps, json, composed, (data) => [
    ...renderProjectControl(data.registered),
    ...renderProjectControl(data.disarmed),
  ]);
}

async function cmdProjects(
  deps: OrchestratorCliDeps,
  client: ApiClient,
  args: ParsedArgs,
  rest: readonly string[]
): Promise<number> {
  const sub = rest[0];
  if (sub === undefined) {
    return respond(deps, args.json, await client.projects(), (view) => renderProjectRows(view.projects));
  }

  if (sub === "add") {
    const path = rest[1];
    // An empty path is refused rather than resolved: `resolve("")` is the
    // working directory, so `projects add "$UNSET"` would otherwise register
    // whatever repository the operator happened to be standing in (D-2).
    if (path === undefined || path.trim().length === 0) {
      return usage(deps, "projects add needs a repository path");
    }
    if (rest.length > 2) return usage(deps, `unexpected argument "${rest[2]}" after projects add`);
    return cmdProjectsAdd(deps, client, args.json, path, args.name, args.disarmed);
  }

  const call = Object.hasOwn(PROJECT_REGISTRY_CALLS, sub) ? PROJECT_REGISTRY_CALLS[sub] : undefined;
  if (call === undefined) {
    return usage(deps, `unknown projects subcommand "${sub}" (expected add, arm, disarm, requalify, or remove)`);
  }
  const name = rest[1];
  if (name === undefined) return usage(deps, `projects ${sub} needs a project name`);
  if (rest.length > 2) return usage(deps, `unexpected argument "${rest[2]}" after projects ${sub}`);
  return respond(deps, args.json, await call(client, name), renderProjectControl);
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
  project: ProjectClient,
  json: boolean,
  specId: string,
  verb: SpecControlVerb
): Promise<number> {
  const call: Record<SpecControlVerb, () => Promise<ApiResponse<ControlResult>>> = {
    skip: () => project.skipSpec(specId),
    "retry-stage": () => project.retryStage(specId),
    reverify: () => project.reverify(specId),
    "force-human-gate": () => project.forceHumanGate(specId),
    approve: () => project.approve(specId),
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
  // Which registered project's state root `dir` is, null when the root came
  // from `--dir` or from this checkout's own daemon home.
  readonly project: string | null;
  // Why `dir` is empty, when it is: the named project could not be resolved
  // out of the registry, so no chain was walked at all (D-3).
  readonly resolveError: string | null;
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

interface VerifyRoot {
  readonly dir: string | null;
  readonly error: string | null;
}

// 028 B-3: which state root the offline check walks. `--dir` names one
// outright; `--project` folds the daemon home's own projects chain off disk
// and takes that project's root (010 D13's inside-the-target layout); neither
// leaves the self-hosted root, which is what this command has always walked.
//
// The fold is a file read, never an API call: `journal verify` is the
// operator's independent check (023 B-4), and a check that had to ask the
// daemon where to look would not be independent of it. The chain is read
// through the same file-backed view the hosted API uses, so this never opens
// a second writer against a lock a live daemon holds (spec 011 B-2).
function verifyRoot(deps: OrchestratorCliDeps, project: string | null, dir: string | null): VerifyRoot {
  if (dir !== null) return { dir: resolve(dir), error: null };
  if (project === null) return { dir: deps.dataDir, error: null };
  try {
    const registry = foldProjects(journalViewFromDir(deps.dataDir, PROJECTS_CHAIN_BASENAME).records());
    const found = registry.get(project);
    if (found !== undefined) return { dir: projectStateRoot(found.repoDir), error: null };
    const known = [...registry.keys()];
    return {
      dir: null,
      error:
        known.length === 0
          ? `no registered project named "${project}": the registry under ${deps.dataDir} holds none`
          : `no registered project named "${project}" (registered: ${known.join(", ")})`,
    };
  } catch (err) {
    return { dir: null, error: `the projects chain under ${deps.dataDir} could not be folded: ${(err as Error).message}` };
  }
}

// B-4: the operator's independent check walks both chains from their anchors
// with no daemon involved. It is deliberately not an API route, because a
// daemon vouching for its own chain is not an independent check.
function cmdJournalVerify(deps: OrchestratorCliDeps, json: boolean, project: string | null, dir: string | null): number {
  const root = verifyRoot(deps, project, dir);
  const chains =
    root.dir === null ? [] : [verifyOneChain(root.dir, "work"), verifyOneChain(root.dir, "decisions", "decisions")];
  const data: JournalVerifyData = {
    dir: root.dir ?? "",
    project,
    resolveError: root.error,
    verified: root.dir !== null && chains.every((c) => c.verified),
    chains,
  };

  if (json) {
    // Offline commands answer in the same envelope shape, with the verdict
    // inside `data`: the command itself succeeded even when the chain it
    // inspected did not, and the exit code carries that distinction.
    printJson(deps, { ok: true, data } satisfies ApiResponse<JournalVerifyData>);
    return data.verified ? EXIT_OK : EXIT_FAILURE;
  }

  if (data.resolveError !== null) {
    deps.err(`journal verify: ${data.resolveError}`);
    return EXIT_FAILURE;
  }
  deps.out(project === null ? `chains under ${data.dir}` : `chains under ${data.dir} (project ${project})`);
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

// The registry the v2 API reads and mutates (spec 027 B-2), composed out of
// the scheduler the daemon already runs. Three things make this a composition
// rather than a second implementation: the projects chain is the scheduler's
// own writer handle (spec 011 B-2 allows exactly one, and 026 says a control
// surface mutates through it), every project's journals are read from that
// project's state root inside the target (010 D13), and a project's controls
// are the live Daemon driving it, or null when nothing is driving it, which
// is the honest answer rather than a fabricated one.
function standbyProjects(standby: StandbyDaemon, probe: ProjectProbe): ProjectsTarget {
  const dagReader = createProcessDagReader();
  // One cached reader per state root: `journalViewFromDir` keys its cache on
  // the chain file's size and mtime, and a fresh reader per request would
  // throw that cache away every time.
  const views = new Map<string, { readonly journal: JournalView; readonly decisions: JournalView }>();

  const chain = (): JournalHandle => standby.projectsChain;
  const fold = (): ReadonlyMap<string, Project> => foldProjects(chain().fold().records);
  const live = (name: string): Project => {
    const project = fold().get(name);
    if (!project) throw new Error(`projects: no registered project named "${name}"`);
    return project;
  };

  return {
    chain: { records: () => chain().fold().records },
    projects: fold,
    resourcesFor(project: Project) {
      const stateRoot = projectStateRoot(project.repoDir);
      let cached = views.get(stateRoot);
      if (cached === undefined) {
        cached = { journal: journalViewFromDir(stateRoot), decisions: journalViewFromDir(stateRoot, "decisions") };
        views.set(stateRoot, cached);
      }
      return {
        journal: cached.journal,
        decisions: cached.decisions,
        dagReader,
        repoDir: project.repoDir,
        evidenceDir: join(stateRoot, "verify-evidence"),
        controls: standby.daemonFor(project.name),
        // 026 D-5 / 027 D-3: reverify may wake a daemon for a project
        // nothing is driving; the scheduler parks it live and drives it on
        // the next cycle for the queued requalification.
        wakeControls: () => standby.openForControl(project.name),
      };
    },
    register(path: string, name: string | undefined, source: ProjectSource): void {
      registerProject({
        chain: chain(),
        repoDir: path,
        qualification: qualifyProject(probe, path),
        source,
        ...(name === undefined ? {} : { name }),
      });
    },
    setArmed(name: string, armed: boolean, source: ProjectSource): void {
      setProjectArmed({ chain: chain(), name, armed, source });
    },
    requalify(name: string, source: ProjectSource): void {
      const project = live(name);
      requalifyProject({ chain: chain(), name, qualification: qualifyProject(probe, project.repoDir), source });
    },
    remove(name: string, source: ProjectSource): void {
      removeProject({ chain: chain(), name, source });
    },
  };
}

// Spec 021 B-2 fixes the boot order (lock, journals, recovery, then the loop
// and the API); spec 026 puts a scheduler above that per-run loop, so what
// this function composes is the standby daemon (identity lock, project
// registry, the one flight slot) rather than a single run. The process now
// outlives a terminal run: `join()` resolves only when an operator stops the
// daemon (026 B-1), and the HTTP surface spec 022 serves stays up throughout.
// It is what `daemon start` spawns, and it is runnable directly for an
// operator who wants the daemon in the foreground.
async function cmdDaemonRun(deps: OrchestratorCliDeps, url: string): Promise<number> {
  const bind = parseBind(url);
  if (bind === null) return usage(deps, `--url ${url} is not a usable base url`);

  const probe = createProcessProjectProbe();
  const standby = new StandbyDaemon({
    daemonHomeDir: deps.dataDir,
    // 010 D13: each project's state root lives inside that project, in
    // exactly this checkout's own layout; 026 B-6: the scheduler holds the
    // one identity lock, so a project's run takes none.
    makeProjectDeps: (project) =>
      createProductionDaemonDeps({
        dataDir: projectStateRoot(project.repoDir),
        repoDir: project.repoDir,
        supervised: true,
      }),
    // 021 B-6, D-19: SIGTERM severs the live session child; without this a
    // mid-build stop waits out the child's own 30-minute deadline.
    killLiveSession,
    processInspector: deps.inspector,
    clock: { now: deps.now },
    sleep: deps.sleep,
    log: (line) => deps.out(line),
    // 026 D-3: a registry that has never held a record adopts the checkout
    // this daemon was pointed at, so `--repo` keeps meaning what it meant
    // before there was a registry to point at instead.
    bootstrap: { repoDir: deps.repoDir, probe },
  });

  try {
    // The identity lock is spec 021 B-1's, so a second daemon is refused
    // there, by the strongest check available (pid plus process start time).
    // Here it is simply an honest message rather than a stack trace.
    await standby.start();
  } catch (err) {
    deps.err(`orchestrator daemon: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  let server: ApiServer;
  try {
    server = createApiServer({
      projects: standbyProjects(standby, probe),
      // 027 B-4: the scheduler's own state is what `/api/meta` reports, so
      // "standby" is served as the first-class state it is rather than
      // inferred from an absence of activity.
      daemon: { status: () => standby.snapshot },
      host: bind.host,
      port: bind.port,
    });
  } catch (err) {
    // The daemon is up and holding the lock; if the API cannot bind there is
    // no interface to control it through, so it comes back down cleanly
    // rather than running headless.
    await standby.shutdown();
    deps.err(`orchestrator daemon: api refused to bind: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  const registered = standby.projects.size;
  deps.out(`orchestrator daemon running (pid ${process.pid}, ${registered} project${registered === 1 ? "" : "s"} registered)`);
  deps.out(`api:  ${server.url}`);

  let signalled = false;
  const onSignal = (): void => {
    if (signalled) return;
    signalled = true;
    void (async () => {
      await server.stop();
      await standby.shutdown();
      process.exit(EXIT_OK);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await standby.join();
    deps.out("orchestrator daemon: standby stopped");
    return EXIT_OK;
  } catch (err) {
    deps.err(`orchestrator daemon: the scheduler died: ${(err as Error).message}`);
    return EXIT_FAILURE;
  } finally {
    await server.stop();
    await standby.shutdown();
    // A registered signal listener keeps the event loop alive, so a daemon
    // that stops on its own would otherwise leave the process hanging with
    // nothing left to do.
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
  // A flag the verb at hand has no use for is refused, not ignored: see
  // EXTRA_FLAGS. A command that table does not name is an unknown command,
  // left to the switch below to report as one, so a typo does not come back
  // as a complaint about its flags.
  const accepted =
    command === "projects" && rest[0] === "add"
      ? PROJECTS_ADD_FLAGS
      : Object.hasOwn(EXTRA_FLAGS, command)
        ? EXTRA_FLAGS[command]
        : undefined;
  if (accepted !== undefined) {
    const stray = strayFlag(args, accepted);
    if (stray !== null) return usage(scoped, `${stray} is not a flag of "${command}"`);
  }

  // The two offline commands (B-4 and the daemon lifecycle) are dispatched
  // before a client is ever created: they must work with nothing listening.
  if (command === "journal") {
    if (rest[0] !== "verify") return usage(scoped, `journal needs the "verify" subcommand`);
    if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after journal verify`);
    if (args.project !== null && args.dir !== null) {
      return usage(scoped, "journal verify takes --project or --dir, not both");
    }
    return cmdJournalVerify(scoped, args.json, args.project, args.dir);
  }
  if (command === "daemon") return cmdDaemon(scoped, url, args.json, rest);

  const client = scoped.createClient(url);
  if (command === "projects") return cmdProjects(scoped, client, args, rest);

  // Usage is checked before the project is resolved, in every case below: a
  // wrong argument is exit 3 whether or not a daemon is listening, and asking
  // one which projects it has would turn that into exit 2.
  const project = async (): Promise<ApiResponse<ProjectClient>> => resolveProject(client, args.project);

  switch (command) {
    case "status": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after status`);
      // 028 B-2: unscoped `status` is the composite over the whole daemon, so
      // it addresses no project and resolves none.
      if (args.project === null) return cmdStatusAll(scoped, client, args.json);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return cmdStatus(scoped, client, target.data, args.json);
    }
    case "dag":
    case "next": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after ${command}`);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return respond(scoped, args.json, await target.data.dag(), command === "dag" ? renderDag : renderNext);
    }
    case "history": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after history`);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return respond(scoped, args.json, await target.data.history(), renderHistory);
    }
    case "economics": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after economics`);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return respond(scoped, args.json, await fetchEconomics(url, target.data.name), renderEconomics);
    }
    case "start":
    case "pause":
    case "resume": {
      if (rest.length > 0) return usage(scoped, `unexpected argument "${rest[0]}" after ${command}`);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      const run = target.data;
      const control = command === "start" ? run.startRun() : command === "pause" ? run.pauseRun() : run.resumeRun();
      return respond(scoped, args.json, await control, renderControl);
    }
    case "decisions": {
      const query = rest[0];
      if (query === undefined) return usage(scoped, "decisions needs a query");
      if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after decisions`);
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return respond(scoped, args.json, await target.data.decisions({ query }), renderDecisions);
    }
    case "spec": {
      const specId = rest[0];
      const verbToken = rest[1];
      if (specId === undefined) return usage(scoped, "spec needs a spec id");
      if (verbToken === undefined) return usage(scoped, `spec ${specId} needs a verb (skip|retry|reverify|force-gate|approve)`);
      if (rest.length > 2) return usage(scoped, `unexpected argument "${rest[2]}" after spec ${specId} ${verbToken}`);
      const verb = Object.hasOwn(SPEC_VERB_ALIASES, verbToken) ? SPEC_VERB_ALIASES[verbToken] : undefined;
      if (verb === undefined) {
        return usage(scoped, `unknown spec verb "${verbToken}" (expected skip, retry, reverify, force-gate, or approve)`);
      }
      const target = await project();
      if (!target.ok) return respond(scoped, args.json, target, () => []);
      return cmdSpecControl(scoped, target.data, args.json, specId, verb);
    }
    default:
      return usage(scoped, `unknown command "${command}"`);
  }
}

export async function cmdOrchestrator(args: string[]): Promise<void> {
  const code = await runOrchestratorCli(args);
  if (code !== EXIT_OK) process.exit(code);
}
