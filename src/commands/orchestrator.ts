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
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { DATA_DIR, PROJECT_DIR } from "../paths";
import { openJournal, verifyChain, type JournalHandle, type JournalRecord } from "../orchestrator/journal";
import {
  ATTEST_ABSENT,
  REDACTION_POLICY,
  attestationAbsent,
  exportBundleFromRoot,
  parseBundle,
  runCorpusAttest,
  verifyAttestation,
  verifyBundle,
  writeBundle,
  type AttestationVerification,
  type BundleAttestation,
  type ChainVerification,
  type JournalBundle,
} from "../orchestrator/export";
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
import { killLiveSession, runSession } from "../orchestrator/session";
import { createProcessDagReader } from "../orchestrator/dag";
import {
  PROJECTS_CHAIN_BASENAME,
  createProcessProjectProbe,
  foldProjects,
  journalValidation,
  projectStateRoot,
  qualifyProject,
  registerProject,
  removeProject,
  requalifyProject,
  setProjectArmed,
  setProjectCeiling,
  migrateProjectGate,
  setProjectGate,
  setProjectProfile,
  slugifyProjectName,
  type Project,
  type ProjectProbe,
  type ProjectSource,
  type RecordedQualification,
} from "../orchestrator/projects";
import {
  adoptableDagReader,
  exclusionAdditionsFromFlag,
  journalPreflight,
  proposalHash,
  runPreflight,
  unknownSurfaces,
  type ExclusionRule,
  type HistoryMode,
} from "../orchestrator/adopt/preflight";
import {
  createProcessHoldbackCorpusReader,
  createProcessHoldbackGitReader,
  extractReplayHistory,
  loadCorpusOwnership,
  renderHoldbackReport,
  replayHoldback,
  type HoldbackScore,
} from "../orchestrator/adopt/holdback";
import {
  createProcessSynthesisGate,
  createProcessSynthesisGit,
  renderSynthesisReport,
  runSynthesis,
  type SynthesisReport,
  type SynthesisSessionFn,
} from "../orchestrator/adopt/synthesis";
import {
  ceilingOf,
  ceilingRefusal,
  renderBudget,
  renderBudgetStop,
  renderCeiling,
  type CostCeiling,
} from "../orchestrator/budget";
import {
  DEFAULT_REGISTRATION_PROFILE,
  GUARDED_BASELINE_ALLOWED_TOOLS,
  isExecutionMode,
  profileRefusal,
  renderProfile,
  type ExecutionProfile,
} from "../orchestrator/profile";
import { gateRefusal, renderGate, renderGateDetail, type GateContract } from "../orchestrator/gate-contract";
import { renderSessionModels, sessionModelsRefusal, type SessionModels } from "../orchestrator/models";
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
  projects                     the registry: name, armed, posture, qualification, run
  projects add <path>          register a project [--name <slug>] [--disarmed]
  projects arm|disarm <name>   let the scheduler drive it, or hold it back
  projects profile <name> <mode>  set the execution posture: bypass | guarded
  projects gate <name> -- <argv>  set the language gate run after the spec-spine floor
                                  and, with both model flags, the model pair
  projects ceiling <name>      spend limits: --per-run/--per-day <usd>, or "none"
  projects requalify <name>    re-run the preflight and journal the verdict
  projects remove <name>       drop it from the registry (a tombstone)
  adopt preflight <path>       read-only cartography: propose spec territories for
                               an ungoverned target [--out <path>] [--exclude <rules>]
  adopt validate <project>     replay the target's history against a candidate
                               corpus and journal the score (--corpus <ref-or-path>)
  adopt synthesize <project>   driven sessions author a draft corpus on a feature
                               branch of an adoptable target (--proposal <path|hash>)
  dag                          every spec with readiness, blockers, drift
  next                         the next ready spec, or why there is none
  start | pause | resume       run controls
  history                      spec executions with their evidence trail
  economics                    per-spec cost and rework rollups, run totals
  decisions <query>            search the sealed decision ledger
  spec <id> <verb>             skip | retry | reverify | force-gate | approve
  journal verify               verify both chains offline (no daemon needed)
  journal export               write a redacted, offline-verifiable evidence bundle
  daemon start|stop|status     daemon process lifecycle (identity-checked lock)
  daemon run                   run the daemon in the foreground (what start spawns)

  --project <name>             scope a verb (status through spec) to one project
  --json                       print the raw envelope instead of human output
  --url <base>                 daemon base url (default http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT})
  --data-dir <dir>             the daemon home (lock, log, projects chain)
  --dir <dir>                  state root for journal verify, bypassing the registry
  --bundle <path>              an exported bundle for journal verify to check offline
  --out <path>                 where journal export writes its bundle, or adopt
                               preflight its proposal (default under the daemon home)
  --exclude <rules>            extra exclusion rules for adopt preflight, comma-
                               separated ("dir/" or exact basename); additions only
  --corpus <ref-or-path>       the candidate corpus for adopt validate: a branch or
                               committish of the target, or a corpus checkout path
  --proposal <path-or-hash>    the 034 proposal adopt synthesize works from: a
                               document path, or a sha256 resolved through the
                               project's journaled preflight records
  --name <slug>                project name for projects add
  --disarmed                   register disarmed (projects add)
  --profile <mode>             posture for projects add: bypass | guarded
  --model-strong <id>          build and ship model (both model flags or neither)
  --model-fast <id>            shepherd and verify model
  --allow <tools>              comma-separated allowlist for a guarded posture
  --deny <tools>               comma-separated disallowlist for a guarded posture
  --per-run <usd>              cost ceiling for one run (projects ceiling)
  --per-day <usd>              cost ceiling for one UTC day (projects ceiling)
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
  // 035's session seam: absent, `adopt synthesize` drives real spec 014
  // sessions under the project's execution profile; tests inject scripted
  // ones so AC-2 runs with no model anywhere near it.
  readonly makeSynthesisSession?: (project: Project, journal: JournalHandle) => SynthesisSessionFn;
  // 039 B-1's seam: `journal export` shells out to `spec-spine attest
  // --with-coupling` over the checkout it runs in. Tests supply the outcome
  // directly, so an export under test neither needs spec-spine on PATH nor
  // rewrites the real repository's derived attestation.
  attest(repoDir: string): BundleAttestation;
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
    attest: runCorpusAttest,
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
  // 032's posture flags: the mode a registration consents to, and the two
  // tool lists a guarded one may carry.
  readonly profile: string | null;
  readonly allow: string | null;
  readonly deny: string | null;
  // 040 B-4's model pair. Both halves or neither; the refusal names which one
  // is missing rather than defaulting it.
  readonly modelStrong: string | null;
  readonly modelFast: string | null;
  // 033 B-1's spend limits, in dollars as typed (see `ceilingFromFlags`).
  readonly perRun: string | null;
  readonly perDay: string | null;
  // 031 B-4's journal flags: where export writes, and which bundle verify reads.
  readonly out: string | null;
  readonly bundle: string | null;
  // 034 D-2's additions flag: extra exclusion rules for adopt preflight.
  readonly exclude: string | null;
  // 036's corpus source: a ref of the target or a checkout path (D-5).
  readonly corpus: string | null;
  // 035's proposal source: a document path or a sha256 content hash (B-1).
  readonly proposal: string | null;
  // 041 B-7's gate argv: everything after a bare `--`, unparsed. null when no
  // separator was given.
  readonly passthrough: readonly string[] | null;
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
  let profile: string | null = null;
  let allow: string | null = null;
  let deny: string | null = null;
  let modelStrong: string | null = null;
  let modelFast: string | null = null;
  let perRun: string | null = null;
  let perDay: string | null = null;
  let out: string | null = null;
  let bundle: string | null = null;
  let exclude: string | null = null;
  let corpus: string | null = null;
  let proposal: string | null = null;
  // 041 B-7: everything after a bare `--`, verbatim. Nothing before this spec
  // used the separator, and flag parsing stops at it entirely, so a gate
  // command that itself starts with a dash (`cargo clippy -- -D warnings`)
  // reaches the registry as the operator typed it instead of being refused as
  // an unknown flag. null means no separator was given at all, which is a
  // different thing from `--` with nothing after it (the empty contract).
  let passthrough: string[] | null = null;
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
    "--profile": (v) => {
      profile = v;
    },
    "--allow": (v) => {
      allow = v;
    },
    "--deny": (v) => {
      deny = v;
    },
    "--model-strong": (v) => {
      modelStrong = v;
    },
    "--model-fast": (v) => {
      modelFast = v;
    },
    "--per-run": (v) => {
      perRun = v;
    },
    "--per-day": (v) => {
      perDay = v;
    },
    "--out": (v) => {
      out = v;
    },
    "--bundle": (v) => {
      bundle = v;
    },
    "--exclude": (v) => {
      exclude = v;
    },
    "--corpus": (v) => {
      corpus = v;
    },
    "--proposal": (v) => {
      proposal = v;
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
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

  return {
    ok: true,
    args: { json, url, dataDir, repoDir, project, dir, name, disarmed, profile, allow, deny, modelStrong, modelFast, perRun, perDay, out, bundle, exclude, corpus, proposal, passthrough, rest },
  };
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
  adopt: [],
  journal: ["--project", "--dir", "--bundle"],
  daemon: [],
};

const PROJECTS_ADD_FLAGS: readonly string[] = [
  "--name",
  "--disarmed",
  "--profile",
  "--allow",
  "--deny",
  "--model-strong",
  "--model-fast",
];
// 032 B-2: the posture verb takes its mode as a positional, so only the two
// list flags belong to it; `--profile` is registration's way of saying the
// same thing and is refused here rather than silently outranked.
const PROJECTS_PROFILE_FLAGS: readonly string[] = ["--allow", "--deny", "--model-strong", "--model-fast"];
// 033 B-1: the ceiling verb's two limits. Neither belongs to any other verb,
// and the posture flags do not belong to this one.
const PROJECTS_CEILING_FLAGS: readonly string[] = ["--per-run", "--per-day"];
// 041 B-7: the gate verb's whole payload arrives after a bare `--`, so it
// takes no flags of its own; every named flag is a stray here.
const PROJECTS_GATE_FLAGS: readonly string[] = [];
// 031 B-4: `journal export` takes its own flag set, exactly as `projects add`
// does; `--dir` and `--bundle` belong to verify alone and are refused here.
const JOURNAL_EXPORT_FLAGS: readonly string[] = ["--project", "--out"];
// 034 B-1: where the proposal lands, and D-2's additions to the exclusion
// floor. Nothing else: the preflight is offline and addresses its target by
// path, so `--project` means nothing to it and is refused like any stray.
const ADOPT_PREFLIGHT_FLAGS: readonly string[] = ["--out", "--exclude"];
// 036: the corpus source is the validate verb's one flag and belongs to it
// alone; the target is the positional project name, so `--project` is as
// much a stray here as it is on preflight.
const ADOPT_VALIDATE_FLAGS: readonly string[] = ["--corpus"];
// 035 B-1: the proposal source is the synthesize verb's one flag; the target
// is the positional project name, so every other flag is a stray here.
const ADOPT_SYNTHESIZE_FLAGS: readonly string[] = ["--proposal"];

// The flags a command accepts, subcommand included: three of them carry flag
// sets of their own, and everything else takes the group's.
function acceptedFlags(command: string, sub: string | undefined): readonly string[] | undefined {
  if (command === "projects" && sub === "add") return PROJECTS_ADD_FLAGS;
  if (command === "projects" && sub === "profile") return PROJECTS_PROFILE_FLAGS;
  if (command === "projects" && sub === "ceiling") return PROJECTS_CEILING_FLAGS;
  if (command === "projects" && sub === "gate") return PROJECTS_GATE_FLAGS;
  if (command === "journal" && sub === "export") return JOURNAL_EXPORT_FLAGS;
  if (command === "adopt" && sub === "preflight") return ADOPT_PREFLIGHT_FLAGS;
  if (command === "adopt" && sub === "validate") return ADOPT_VALIDATE_FLAGS;
  if (command === "adopt" && sub === "synthesize") return ADOPT_SYNTHESIZE_FLAGS;
  return Object.hasOwn(EXTRA_FLAGS, command) ? EXTRA_FLAGS[command] : undefined;
}

function strayFlag(args: ParsedArgs, accepted: readonly string[]): string | null {
  const present = [
    args.project !== null ? "--project" : null,
    args.dir !== null ? "--dir" : null,
    args.name !== null ? "--name" : null,
    args.disarmed ? "--disarmed" : null,
    args.profile !== null ? "--profile" : null,
    args.allow !== null ? "--allow" : null,
    args.deny !== null ? "--deny" : null,
    args.modelStrong !== null ? "--model-strong" : null,
    args.modelFast !== null ? "--model-fast" : null,
    args.perRun !== null ? "--per-run" : null,
    args.perDay !== null ? "--per-day" : null,
    args.out !== null ? "--out" : null,
    args.bundle !== null ? "--bundle" : null,
    args.exclude !== null ? "--exclude" : null,
    args.corpus !== null ? "--corpus" : null,
    args.proposal !== null ? "--proposal" : null,
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
// word. 034 B-5: an unqualified verdict whose recorded reading is adoptable
// (sound repo, no corpus) says so instead, with the same failed-check
// reasons attached; it is a fact about the target, not a softer failure.
function qualificationCell(qualification: RecordedQualification): string {
  if (qualification.qualified) return "qualified";
  const failed = qualification.checks.filter((check) => !check.ok).map((check) => check.id);
  const word = qualification.adoptable === true ? "adoptable" : "unqualified";
  return failed.length === 0 ? word : `${word} (${failed.join(", ")})`;
}

// What that project's run is doing, as its row's last column. A state root
// that could not be read says so (022 B-6): it is not the same fact as a
// project that has no run yet.
function projectRunCell(view: ProjectView): string {
  if (view.readError !== null) return `unreadable: ${view.readError}`;
  if (view.run === null) return "no run yet";
  // 028 D-11: a terminal run's last spec and stage are history, and printing
  // them beside "completed" read as work in flight (found live: a settled
  // project whose row said `completed  033-cost-ceiling/build` for a day).
  const terminal = view.run.status === "completed" || view.run.status === "failed";
  const spec = terminal || view.spec === null ? "" : `  ${view.spec.specId}`;
  const stage = terminal || view.stage === null ? "" : `/${view.stage.stage}`;
  // 033 B-7: a tripped ceiling names itself here. "parked" and "paused" are
  // each reached for more than one reason now, and an operator scanning the
  // list has to be able to tell a quota horizon from a spend limit without
  // opening the project.
  const budget = view.budget.stop === null ? "" : `  (${view.budget.stop.reason})`;
  return `${view.run.status}${budget}${spec}${stage}${view.run.needsReconcile ? "  (needs reconcile)" : ""}`;
}

// B-1's one row per project, shared by the `projects` list, the composite
// `status`, and the snapshot a registry control returns.
// 032 B-6: the posture appears wherever the project does, and a legacy-derived
// bypass reads differently from one an operator chose. Never blank: the fold
// always produces a profile, so a missing column would be this surface's
// omission rather than the registry's.
// 041 B-6: the gate takes the next column on the same reasoning. What a target
// is judged by after its session ends is not a detail an operator should have
// to open the project to learn.
function renderProjectRows(projects: readonly ProjectView[]): string[] {
  if (projects.length === 0) return ["no projects are registered with this daemon"];
  const nameWidth = projects.reduce((max, view) => Math.max(max, view.name.length), 0);
  const postureWidth = projects.reduce((max, view) => Math.max(max, renderProfile(view.profile).length), 0);
  const gateWidth = projects.reduce((max, view) => Math.max(max, renderGate(view.gate).length), 0);
  return projects.map((view) =>
    `${view.name.padEnd(nameWidth)}  ${(view.armed ? "armed" : "disarmed").padEnd(8)}  ` +
    `${renderProfile(view.profile).padEnd(postureWidth)}  ` +
    `${renderGate(view.gate).padEnd(gateWidth)}  ` +
    `${qualificationCell(view.qualification).padEnd(11)}  ${projectRunCell(view)}`.trimEnd()
  );
}

// The project detail an operator reads before deciding anything (B-6): the
// row, then the posture spelled out in full, because "guarded (9 baseline
// tools)" is a summary and an allowlist is a thing you check item by item.
function renderProjectDetail(view: ProjectView): string[] {
  const lines = [...renderProjectRows([view])];
  const profile = view.profile;
  lines.push(`posture: ${renderProfile(profile)}`);
  lines.push(`models:  ${renderSessionModels(profile.models)}`);
  if (profile.mode === "bypass") {
    lines.push(
      profile.legacy
        ? "         no profile record on the chain; sessions skip permissions (pre-032 default)"
        : "         sessions skip permissions entirely"
    );
  } else {
    const allowed = profile.allowedTools ?? GUARDED_BASELINE_ALLOWED_TOOLS;
    const origin = profile.allowedTools === undefined ? " (guarded baseline)" : "";
    lines.push(`         allowed${origin}: ${allowed.join(", ")}`);
    if (profile.disallowedTools?.length) lines.push(`         denied: ${profile.disallowedTools.join(", ")}`);
  }
  // 041 B-6: the gate spelled out command by command, for the same reason the
  // allowlist is: "cargo" is a summary, and a gate is a thing you check item
  // by item before you let it certify a merge.
  lines.push(...renderGateDetail(view.gate));
  // 033 B-7: the ceiling and the spend evaluated against it, on the surface an
  // operator reads before deciding anything. Both floors are named even when
  // there is no ceiling, because "what has this cost so far" is the question
  // that makes someone set one.
  lines.push(...renderBudget(view.budget));
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

// 033 B-7: the ceiling above the spend it governs. Economics is 030's fold of
// the journal; a ceiling is registry state on the projects payload, so this
// verb reads both surfaces and renders them together rather than growing
// 030's payload a field its own scope line puts outside it. A registry read
// that failed says so: the numbers below are still true, and an absent
// ceiling line would read as "no ceiling" when the truth is "not known".
async function economicsCeilingLines(client: ApiClient, name: string): Promise<readonly string[]> {
  const rows = await client.projects();
  if (!rows.ok) return [`ceiling: unknown (${rows.error.kind}: ${rows.error.message})`, ""];
  const view = rows.data.projects.find((row) => row.name === name);
  if (view === undefined) return [`ceiling: unknown ("${name}" is not in the registry)`, ""];
  return [...renderBudget(view.budget), ""];
}

async function cmdEconomics(
  deps: OrchestratorCliDeps,
  client: ApiClient,
  url: string,
  json: boolean,
  name: string
): Promise<number> {
  const economics = await fetchEconomics(url, name);
  // `--json` prints the envelope the daemon served, verbatim (023 B-3). The
  // ceiling already has a served shape of its own on /api/projects, and two
  // payloads claiming the same fact is exactly the drift the shared contract
  // exists to prevent.
  if (json || !economics.ok) return respond(deps, json, economics, renderEconomics);
  const ceiling = await economicsCeilingLines(client, name);
  return respond(deps, false, economics, (view) => [...ceiling, ...renderEconomics(view)]);
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
  // The detail rather than the row (032 B-6): a registration or a profile
  // change is exactly the moment an operator needs the whole posture spelled
  // out, not summarized.
  if (result.snapshot !== null) lines.push(...renderProjectDetail(result.snapshot).map((line) => `  ${line}`));
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

// 041 B-7: the argv after `--`, split into one argv array per gate command on
// a standalone `;` token, the `find -exec` idiom. Not on a second `--`: the
// probe's own Rust rule contains `cargo clippy --workspace --all-targets --
// -D warnings`, so `--` has to survive inside a command for an operator to be
// able to type the thing they are correcting. A `;` is never a program name
// or a flag, and a shell already makes anyone quote it. An empty run between
// two separators is dropped rather than recorded as a command that could
// never be executed.
export const GATE_COMMAND_SEPARATOR = ";";

export function splitGateCommands(passthrough: readonly string[]): readonly (readonly string[])[] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const token of passthrough) {
    if (token === GATE_COMMAND_SEPARATOR) {
      if (current.length > 0) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

// 032 B-2: a posture an operator typed, assembled into the profile that
// travels to the registry, or the reason it is not one. A comma-separated
// list is split and trimmed here so the wire carries the array the chain
// stores; an empty entry is dropped rather than journaled as a tool named "".
// Returns undefined when no posture was named at all, which registration
// reads as D-1's default and the profile verb refuses outright.
type ProfileFromFlags =
  | { readonly ok: true; readonly profile: ExecutionProfile | undefined }
  | { readonly ok: false; readonly reason: string };

function toolList(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function profileFromFlags(
  mode: string | null,
  allow: string | null,
  deny: string | null,
  modelStrong: string | null,
  modelFast: string | null
): ProfileFromFlags {
  // 040 B-4: half a pair is refused before anything else is assembled, so the
  // operator reads which half rather than a downstream mode complaint.
  const modelsRefusal = sessionModelsRefusal(modelStrong, modelFast);
  if (modelsRefusal !== null) return { ok: false, reason: modelsRefusal };
  const models: SessionModels | undefined =
    modelStrong === null || modelFast === null ? undefined : { strong: modelStrong, fast: modelFast };
  if (mode === null) {
    if (allow !== null || deny !== null) {
      return { ok: false, reason: `--allow and --deny need a guarded posture; name one with --profile guarded` };
    }
    // A pair without a mode is still a posture change: it needs a mode to ride
    // on, and silently inventing one would pick a permission posture nobody
    // typed.
    if (models !== undefined) {
      return { ok: false, reason: `--model-strong and --model-fast need a posture; name one with --profile bypass` };
    }
    return { ok: true, profile: undefined };
  }
  if (!isExecutionMode(mode)) {
    return { ok: false, reason: `"${mode}" is not an execution mode (expected bypass or guarded)` };
  }
  const allowed = toolList(allow);
  const disallowed = toolList(deny);
  const profile: ExecutionProfile = {
    mode,
    ...(allowed === undefined ? {} : { allowedTools: allowed }),
    ...(disallowed === undefined ? {} : { disallowedTools: disallowed }),
    ...(models === undefined ? {} : { models }),
  };
  const refusal = profileRefusal(profile);
  return refusal === null ? { ok: true, profile } : { ok: false, reason: refusal };
}

// 033 B-1's limits as an operator types them. The journal's unit is micro-USD
// and stays micro-USD on the wire, but a terminal asks for dollars, because
// "5" is a spend limit a person can check at a glance and "5000000" is one
// they can be off by a factor of ten on without noticing. The conversion is
// exact: anything finer than a micro-dollar is refused rather than rounded,
// since silently rounding a limit down would enforce something the operator
// did not ask for and rounding it up would permit it.
type CeilingFromFlags =
  | { readonly ok: true; readonly ceiling: CostCeiling | null }
  | { readonly ok: false; readonly reason: string };

function microUsdFromDollars(flag: string, value: string): number | string {
  const trimmed = value.trim();
  // Number("") is 0 and Number(" ") is 0; a limit of zero is a real thing to
  // set, so an empty flag must not become one by accident.
  if (trimmed.length === 0) return `${flag} needs a dollar amount`;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return `${flag} expects a non-negative dollar amount, got "${value}"`;
  }
  const micro = Number(trimmed) * 1e6;
  if (!Number.isFinite(micro)) return `${flag} is too large to express in micro-USD`;
  // Decimal-to-binary conversion leaves the odd $0.07 style value a hair off a
  // whole micro-dollar; rounding to the nearest one is exact for every amount
  // with six or fewer decimal places, and the digit check below is what
  // refuses the ones that have more.
  if (/\.\d{7,}$/.test(trimmed)) return `${flag} is finer than one micro-USD, got "${value}"`;
  return Math.round(micro);
}

function ceilingFromFlags(perRun: string | null, perDay: string | null, clear: boolean): CeilingFromFlags {
  if (clear) {
    if (perRun !== null || perDay !== null) {
      return { ok: false, reason: `"none" clears the ceiling; it takes no --per-run or --per-day` };
    }
    return { ok: true, ceiling: null };
  }
  if (perRun === null && perDay === null) {
    return { ok: false, reason: `projects ceiling needs --per-run <usd>, --per-day <usd>, or "none" to clear` };
  }
  const limits: { perRunMicroUsd?: number; perDayMicroUsd?: number } = {};
  for (const [flag, value, field] of [
    ["--per-run", perRun, "perRunMicroUsd"],
    ["--per-day", perDay, "perDayMicroUsd"],
  ] as const) {
    if (value === null) continue;
    const micro = microUsdFromDollars(flag, value);
    if (typeof micro === "string") return { ok: false, reason: micro };
    limits[field] = micro;
  }
  const ceiling = ceilingOf(limits);
  const refusal = ceilingRefusal(ceiling);
  return refusal === null ? { ok: true, ceiling } : { ok: false, reason: refusal };
}

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
  disarmed: boolean,
  profile: ExecutionProfile | undefined
): Promise<number> {
  // D-2: the path is resolved against this shell's working directory before
  // it travels, because the registry stores an absolute path and the daemon's
  // own cwd is not the operator's.
  const absolute = resolve(path);
  const registered = await client.registerProject({
    path: absolute,
    ...(name === null ? {} : { name }),
    // 032 B-2: omitted is not "guarded by accident" and not silence either;
    // the registry records D-1's bypass explicitly, and the output below
    // says which posture landed.
    ...(profile === undefined ? {} : { profile }),
  });
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
    const posture = profileFromFlags(args.profile, args.allow, args.deny, args.modelStrong, args.modelFast);
    if (!posture.ok) return usage(deps, posture.reason);
    return cmdProjectsAdd(deps, client, args.json, path, args.name, args.disarmed, posture.profile);
  }

  // 032 B-2's one write verb: the mode is a positional because it is the
  // whole point of the command, and the whole profile travels rather than a
  // patch, so what the chain records is what the operator typed.
  if (sub === "profile") {
    const name = rest[1];
    if (name === undefined) return usage(deps, "projects profile needs a project name");
    const mode = rest[2];
    if (mode === undefined) return usage(deps, "projects profile needs a mode (bypass or guarded)");
    if (rest.length > 3) return usage(deps, `unexpected argument "${rest[3]}" after projects profile`);
    const posture = profileFromFlags(mode, args.allow, args.deny, args.modelStrong, args.modelFast);
    if (!posture.ok) return usage(deps, posture.reason);
    // profileFromFlags only answers undefined for a null mode, which the
    // check above has already refused.
    const profile = posture.profile ?? DEFAULT_REGISTRATION_PROFILE;
    return respond(deps, args.json, await client.setProjectProfile(name, profile), renderProjectControl);
  }

  // 033 B-1's one write verb. The whole ceiling travels, so naming only
  // `--per-day` sets a day limit and no run limit rather than patching the day
  // limit into whatever run limit the chain already held: an operator reading
  // the record back sees the limits the project is actually driven under.
  // Clearing is the positional "none", because an absence of flags is how a
  // typo reads and it must not be how "remove the limit" reads.
  if (sub === "ceiling") {
    const name = rest[1];
    if (name === undefined) return usage(deps, "projects ceiling needs a project name");
    const clear = rest[2];
    if (clear !== undefined && clear !== "none") {
      return usage(deps, `unexpected argument "${clear}" after projects ceiling (expected "none" or nothing)`);
    }
    if (rest.length > 3) return usage(deps, `unexpected argument "${rest[3]}" after projects ceiling`);
    const limits = ceilingFromFlags(args.perRun, args.perDay, clear === "none");
    if (!limits.ok) return usage(deps, limits.reason);
    return respond(deps, args.json, await client.setProjectCeiling(name, limits.ceiling), renderProjectControl);
  }

  // 041 B-7's one write verb. The command list arrives after a bare `--`,
  // unparsed, because a gate command is argv and argv is exactly what a flag
  // parser is entitled to mangle: `cargo clippy --workspace -- -D warnings`
  // has to reach the chain as the operator typed it. A standalone `;`
  // separates one command from the next, and `--` with nothing after it is
  // the explicit governance-only contract, which is a decision rather than a
  // typo.
  if (sub === "gate") {
    const name = rest[1];
    if (name === undefined) return usage(deps, "projects gate needs a project name");
    if (rest.length > 2) return usage(deps, `unexpected argument "${rest[2]}" after projects gate`);
    if (args.passthrough === null) {
      return usage(
        deps,
        'projects gate needs the commands after "--" (for example: projects gate rahi -- make ci), ' +
          'a standalone ";" between commands, or "--" with nothing after it for governance-only'
      );
    }
    const commands = splitGateCommands(args.passthrough);
    const refusal = gateRefusal({ commands, source: "cli", rule: null });
    if (refusal !== null) return usage(deps, refusal);
    return respond(deps, args.json, await client.setProjectGate(name, commands), renderProjectControl);
  }

  const call = Object.hasOwn(PROJECT_REGISTRY_CALLS, sub) ? PROJECT_REGISTRY_CALLS[sub] : undefined;
  if (call === undefined) {
    return usage(
      deps,
      `unknown projects subcommand "${sub}" (expected add, arm, disarm, profile, ceiling, gate, requalify, or remove)`
    );
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

// --- journal export and bundle verify (spec 031 B-4) -------------------------

// What one exported chain amounts to, for the operator: how many records
// travelled, and of those, how many carry a payload (with how many of them
// field-redacted) versus hash-only. Nothing is silently dropped (031 B-1),
// so the three buckets always sum to the record count.
interface ChainExportSummary {
  readonly chain: string;
  readonly records: number;
  readonly payloadsIncluded: number;
  readonly payloadsRedacted: number;
  readonly payloadsWithheld: number;
}

function summarizeBundle(bundle: JournalBundle): ChainExportSummary[] {
  return bundle.chains.map((chain) => ({
    chain: chain.chain,
    records: chain.records.length,
    payloadsIncluded: chain.records.filter((r) => !r.withheldPayload).length,
    payloadsRedacted: chain.records.filter((r) => r.withheldFields.length > 0).length,
    payloadsWithheld: chain.records.filter((r) => r.withheldPayload).length,
  }));
}

interface JournalExportData {
  readonly out: string;
  readonly dir: string;
  readonly project: string | null;
  readonly resolveError: string | null;
  readonly exportError: string | null;
  readonly exported: boolean;
  readonly policyVersion: number | null;
  // 039 B-3: the block verbatim, exactly as the bundle carries it.
  readonly attestation: BundleAttestation | null;
  readonly chains: readonly ChainExportSummary[];
}

// 031 B-4: assemble and write the bundle, offline and read-only with respect
// to both chains. The state root resolves exactly as `journal verify` does
// (self-hosted by default, or through the registry for `--project`), so what
// gets exported is always the same thing verify would have walked.
function cmdJournalExport(deps: OrchestratorCliDeps, json: boolean, project: string | null, out: string): number {
  const root = verifyRoot(deps, project, null);
  const outPath = resolve(out);
  // 039 B-1 attests the checkout the export runs in, which is the corpus
  // behind the self-hosted journals and no others. A `--project` export is
  // the one case where those two come apart, and it records the absence
  // rather than carrying this checkout's attestation beside another
  // project's chains, which is the laundering B-2 refuses (039 D-3).
  const attestation = project === null ? deps.attest(deps.repoDir) : attestationAbsent(ATTEST_ABSENT.notSelfHosted);
  const result = root.dir === null ? null : exportBundleFromRoot(root.dir, project, REDACTION_POLICY, attestation);
  const bundle = result?.ok === true ? result.bundle : null;
  if (bundle !== null) writeBundle(bundle, outPath);

  const data: JournalExportData = {
    out: outPath,
    dir: root.dir ?? "",
    project,
    resolveError: root.error,
    exportError: result !== null && !result.ok ? result.reason : null,
    exported: bundle !== null,
    policyVersion: bundle?.policyVersion ?? null,
    attestation: bundle?.attestation ?? null,
    chains: bundle === null ? [] : summarizeBundle(bundle),
  };

  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<JournalExportData>);
    return data.exported ? EXIT_OK : EXIT_FAILURE;
  }
  if (data.resolveError !== null) {
    deps.err(`journal export: ${data.resolveError}`);
    return EXIT_FAILURE;
  }
  if (data.exportError !== null) {
    deps.err(`journal export: ${data.exportError}`);
    return EXIT_FAILURE;
  }
  deps.out(`bundle written to ${outPath} (policy v${data.policyVersion}${project === null ? "" : `, project ${project}`})`);
  deps.out(`source chains under ${data.dir}`);
  // 039 B-3: one line for what the bundle now carries about the corpus.
  const attested = data.attestation;
  deps.out(
    attested?.attested === true
      ? `corpus attestation ${attested.attestationHash} (spec-spine, with coupling)`
      : `no corpus attestation: ${attested?.reason ?? ATTEST_ABSENT.notRun}`
  );
  for (const chain of data.chains) {
    const redacted = chain.payloadsRedacted > 0 ? ` (${chain.payloadsRedacted} with fields withheld)` : "";
    deps.out(
      `  ${chain.chain.padEnd(9)} ${chain.records} record${chain.records === 1 ? "" : "s"}: ` +
        `${chain.payloadsIncluded} payload${chain.payloadsIncluded === 1 ? "" : "s"} included${redacted}, ${chain.payloadsWithheld} withheld`
    );
  }
  return EXIT_OK;
}

interface BundleVerifyData {
  readonly bundle: string;
  readonly readError: string | null;
  readonly verified: boolean;
  readonly policyVersion: number | null;
  readonly project: string | null;
  readonly failure: { readonly chain: string; readonly seq: number | null; readonly reason: string } | null;
  // 039 B-3: the carried block verbatim, and what recomputing its hash showed.
  readonly attestation: BundleAttestation | null;
  readonly attestationCheck: AttestationVerification | null;
  readonly chains: readonly ChainVerification[];
}

const NO_ATTESTATION_CHECK = {
  attestation: null,
  attestationCheck: null,
} satisfies Pick<BundleVerifyData, "attestation" | "attestationCheck">;

// 031 B-3 behind B-4's verb: check a bundle with no daemon, no original
// journal, and no network, and map the verdict onto 023's exit codes (0 the
// chains are intact, 1 anything else, and never 2, because nothing here can
// be unreachable).
function cmdBundleVerify(deps: OrchestratorCliDeps, json: boolean, bundleArg: string): number {
  const bundlePath = resolve(bundleArg);
  let data: BundleVerifyData;

  let text: string | null = null;
  let readError: string | null = null;
  try {
    text = fs.readFileSync(bundlePath, "utf8");
  } catch (err) {
    readError = `the bundle at ${bundlePath} could not be read: ${(err as Error).message}`;
  }

  if (text === null) {
    data = { bundle: bundlePath, readError, verified: false, policyVersion: null, project: null, failure: null, ...NO_ATTESTATION_CHECK, chains: [] };
  } else {
    const parsed = parseBundle(text);
    if (!parsed.ok) {
      data = { bundle: bundlePath, readError: parsed.reason, verified: false, policyVersion: null, project: null, failure: null, ...NO_ATTESTATION_CHECK, chains: [] };
    } else {
      const verdict = verifyBundle(parsed.bundle);
      data = {
        bundle: bundlePath,
        readError: null,
        verified: verdict.ok,
        policyVersion: parsed.bundle.policyVersion,
        project: parsed.bundle.project,
        failure: verdict.ok ? null : { chain: verdict.chain, seq: verdict.seq, reason: verdict.reason },
        attestation: parsed.bundle.attestation ?? null,
        attestationCheck: verifyAttestation(parsed.bundle),
        chains: verdict.ok ? verdict.chains : [],
      };
    }
  }

  // 039 B-2: the chains and the carried provenance are two verdicts, and a
  // mangled attestation must not be able to make intact chains read as
  // broken. Both must hold for the command to succeed (039 D-4).
  const attestationBroken = data.attestationCheck !== null && (data.attestationCheck.state === "mismatch" || data.attestationCheck.state === "malformed");
  const exit = data.verified && !attestationBroken ? EXIT_OK : EXIT_FAILURE;

  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<BundleVerifyData>);
    return exit;
  }
  if (data.readError !== null) {
    deps.err(`journal verify: ${data.readError}`);
    return EXIT_FAILURE;
  }
  if (data.failure !== null) {
    const at = data.failure.seq === null ? "" : ` at seq ${data.failure.seq}`;
    deps.err(`bundle ${bundlePath}: ${data.failure.chain} chain broken${at}: ${data.failure.reason}`);
    return EXIT_FAILURE;
  }
  deps.out(
    `bundle ${bundlePath} (policy v${data.policyVersion}${data.project === null ? "" : `, project ${data.project}`}): chains intact`
  );
  for (const chain of data.chains) {
    deps.out(
      `  ${chain.chain.padEnd(9)} ${chain.records} record${chain.records === 1 ? "" : "s"}: ` +
        `${chain.payloadsVerified} payload${chain.payloadsVerified === 1 ? "" : "s"} verified, ` +
        `${chain.payloadsRedacted} redacted, ${chain.payloadsWithheld} withheld`
    );
  }
  reportAttestation(deps, data.attestationCheck);
  return exit;
}

// 039 B-2 and B-3 in one line. "Intact" is a statement about the document,
// never about the corpus: verifying that the attestation reproduces would
// need the repository, and a bundle exists for the reader who has none.
function reportAttestation(deps: OrchestratorCliDeps, check: AttestationVerification | null): void {
  if (check === null) return;
  switch (check.state) {
    case "intact":
      deps.out(`attested corpus ${check.attestationHash}, document intact`);
      return;
    case "absent":
      deps.out(`no attestation carried (${check.reason})`);
      return;
    case "mismatch":
      deps.err(
        `attestation document does not match its hash (carried ${check.attestationHash}, recomputed ${check.computedHash})`
      );
      return;
    case "malformed":
      deps.err(`attestation unusable: ${check.reason}`);
  }
}

// --- adoption preflight (spec 034) ------------------------------------------

interface AdoptPreflightData {
  readonly target: string;
  readonly targetError: string | null;
  // The registered project this path resolves to, when it is one: the
  // preflight runs against any path (B-1), and registration is only what
  // makes the run journalable (B-6).
  readonly project: string | null;
  readonly out: string | null;
  readonly contentHash: string | null;
  readonly headSha: string | null;
  readonly historyMode: HistoryMode | null;
  readonly window: { readonly requested: number; readonly used: number } | null;
  readonly shortfall: string | null;
  readonly candidates: number;
  readonly remainderPaths: number;
  readonly unknownSurfaces: readonly string[];
  readonly journaled: { readonly seq: number; readonly kind: string; readonly ts: string } | null;
  readonly journalError: string | null;
}

// B-1: the proposal defaults under the daemon home, never inside the target.
function defaultPreflightOut(dataDir: string, name: string): string {
  return join(dataDir, "adoption", `${name}.preflight.md`);
}

// 034's one read verb, offline like `journal verify`: the preflight reads
// the target directly and the registry as a file, because it must work
// against a repository no daemon has ever heard of. Writes exactly two
// things, neither inside the target: the proposal at `--out`, and, for a
// registered target, the B-6 record in that project's own work journal (the
// one permitted state-root growth, through the same single-writer handle
// discipline every chain has).
function cmdAdoptPreflight(
  deps: OrchestratorCliDeps,
  json: boolean,
  path: string,
  outFlag: string | null,
  extras: readonly ExclusionRule[]
): number {
  const target = resolve(path);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    // reported below: a missing target and a non-directory read the same
  }

  if (!isDirectory) {
    const data: AdoptPreflightData = {
      target,
      targetError: `${target} is not a readable directory`,
      project: null,
      out: null,
      contentHash: null,
      headSha: null,
      historyMode: null,
      window: null,
      shortfall: null,
      candidates: 0,
      remainderPaths: 0,
      unknownSurfaces: [],
      journaled: null,
      journalError: null,
    };
    if (json) {
      printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptPreflightData>);
      return EXIT_FAILURE;
    }
    deps.err(`adopt preflight: ${data.targetError}`);
    return EXIT_FAILURE;
  }

  // Which registered project this path is, if any: a file-read fold of the
  // daemon home's chain (028 B-3's stance), matched on the normalized path
  // exactly as registration stored it. A home with no chain yet folds empty.
  let project: Project | null = null;
  try {
    const registry = foldProjects(journalViewFromDir(deps.dataDir, PROJECTS_CHAIN_BASENAME).records());
    project = [...registry.values()].find((candidate) => candidate.repoDir === target) ?? null;
  } catch {
    project = null;
  }

  const run = runPreflight({ repoDir: target, extraExclusions: extras });
  const fallbackName = slugifyProjectName(basename(target));
  const out =
    outFlag !== null
      ? resolve(outFlag)
      : defaultPreflightOut(deps.dataDir, project?.name ?? (fallbackName.length > 0 ? fallbackName : "target"));
  fs.mkdirSync(dirname(out), { recursive: true });
  fs.writeFileSync(out, run.document);

  // B-6: journaled only against a registered project, into that project's
  // state root. The writer lock is held for one append; a target something
  // else is writing (a live daemon driving it) refuses cleanly, and the
  // refusal is reported as the operational failure it is, with the proposal
  // itself already safely written.
  let journaled: AdoptPreflightData["journaled"] = null;
  let journalError: string | null = null;
  if (project !== null) {
    try {
      const handle = openJournal(projectStateRoot(project.repoDir));
      try {
        const record = journalPreflight({ handle, project: project.name, source: CONTROL_SOURCE, run, out });
        journaled = { seq: record.seq, kind: record.kind, ts: record.ts };
      } finally {
        handle.close();
      }
    } catch (err) {
      journalError = `the preflight record could not be journaled: ${(err as Error).message}`;
    }
  }

  const proposal = run.proposal;
  const data: AdoptPreflightData = {
    target,
    targetError: null,
    project: project?.name ?? null,
    out,
    contentHash: run.contentHash,
    headSha: proposal.headSha,
    historyMode: proposal.history.mode,
    window: { requested: proposal.history.requested, used: proposal.history.used },
    shortfall: proposal.history.shortfall,
    candidates: proposal.territories.candidates.length,
    remainderPaths: proposal.territories.remainder.length,
    unknownSurfaces: unknownSurfaces(proposal.surfaces),
    journaled,
    journalError,
  };

  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptPreflightData>);
    return journalError === null ? EXIT_OK : EXIT_FAILURE;
  }

  deps.out(`proposal written to ${out}`);
  deps.out(`         sha256 ${run.contentHash}`);
  deps.out(`target:  ${target} at ${data.headSha ?? "(no commits)"}`);
  const modeCell =
    data.historyMode === "empty"
      ? "no readable commit history"
      : `${data.window!.used} first-parent ${data.historyMode === "merges" ? "merge(s)" : "commit(s), no merges on the first-parent line"} (requested ${data.window!.requested})`;
  deps.out(`history: ${modeCell}`);
  if (data.shortfall !== null) deps.out(`         shortfall: ${data.shortfall}`);
  deps.out(`candidates: ${data.candidates}`);
  deps.out(`remainder:  ${data.remainderPaths} path(s)`);
  deps.out(`unknowns:   ${data.unknownSurfaces.length === 0 ? "none" : data.unknownSurfaces.join(", ")}`);
  if (journaled !== null) {
    deps.out(`journaled: seq ${journaled.seq}  ${journaled.kind}  ${journaled.ts} (project ${data.project})`);
  } else if (journalError !== null) {
    deps.err(`adopt preflight: ${journalError}`);
    return EXIT_FAILURE;
  } else {
    deps.out("journaled: nothing (the target is not a registered project; register it to make this run citable)");
  }
  return EXIT_OK;
}

// --- adoption validate (spec 036) -------------------------------------------

interface AdoptValidateCorpusData {
  readonly ref: string;
  readonly hash: string;
  readonly specs: number;
  readonly head: string | null;
}

interface AdoptValidateData {
  readonly project: string | null;
  // Why nothing was scored, when nothing was: an unknown project, an
  // unusable corpus, or a history too shallow to evaluate (036 B-5).
  readonly resolveError: string | null;
  readonly corpus: AdoptValidateCorpusData | null;
  readonly targetHead: string | null;
  readonly score: HoldbackScore | null;
  readonly journaled: { readonly seq: number; readonly kind: string; readonly ts: string } | null;
  readonly journalError: string | null;
}

function adoptValidateFailure(
  deps: OrchestratorCliDeps,
  json: boolean,
  project: string | null,
  resolveError: string,
  corpus: AdoptValidateCorpusData | null = null
): number {
  const data: AdoptValidateData = {
    project,
    resolveError,
    corpus,
    targetHead: null,
    score: null,
    journaled: null,
    journalError: null,
  };
  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptValidateData>);
    return EXIT_FAILURE;
  }
  deps.err(`adopt validate: ${resolveError}`);
  return EXIT_FAILURE;
}

interface MaterializedCorpus {
  readonly dir: string;
  readonly cleanup: () => void;
}

function gitInTarget(repoDir: string, args: readonly string[]): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoDir });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

// 036 D-5: an existing directory is a corpus checkout used as-is; anything
// else names a committish of the target (the synthesis branch is the
// expected case), materialized through a local clone into a temp directory
// and checked out detached there. Nothing is ever written inside the target
// (034 B-1's stance carried forward): the clone only reads its object store,
// and compile/attest later run in the temp checkout.
function materializeCorpus(repoDir: string, corpusFlag: string): MaterializedCorpus {
  const asPath = resolve(corpusFlag);
  try {
    if (fs.statSync(asPath).isDirectory()) return { dir: asPath, cleanup: () => {} };
  } catch {
    // not a directory: read it as a ref of the target below
  }

  const rev = gitInTarget(repoDir, ["rev-parse", "--verify", "--quiet", `${corpusFlag}^{commit}`]);
  if (rev.exitCode !== 0) {
    throw new Error(`--corpus "${corpusFlag}" is neither a readable directory nor a committish of ${repoDir}`);
  }
  const sha = rev.stdout;

  const dir = fs.mkdtempSync(join(tmpdir(), "observatory-corpus-"));
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  const clone = gitInTarget(repoDir, ["clone", "--quiet", "--no-checkout", repoDir, dir]);
  if (clone.exitCode !== 0) {
    cleanup();
    throw new Error(`cloning ${repoDir} to read the corpus failed: ${clone.stderr}`);
  }
  const checkout = gitInTarget(dir, ["checkout", "--quiet", "--detach", sha]);
  if (checkout.exitCode !== 0) {
    cleanup();
    throw new Error(`checking out ${corpusFlag} (${sha.slice(0, 12)}) in the corpus clone failed: ${checkout.stderr}`);
  }
  return { dir, cleanup };
}

// 036's one verb, offline like preflight (B-4: a compiling corpus and a git
// history, nothing else; no daemon is asked anything). The replay reads the
// corpus through spec-spine and the target through git, prints the B-2
// report with a denominator beside every number (FR-004), and journals the
// B-3 ratification-input record into the project's own work journal.
function cmdAdoptValidate(deps: OrchestratorCliDeps, json: boolean, projectName: string, corpusFlag: string): number {
  // Resolved offline exactly as journal verify resolves its root (028 B-3's
  // stance): validate must work with no daemon anywhere, and the registered
  // project is what makes the record citable and addressable.
  let project: Project | null = null;
  let resolveError: string | null = null;
  try {
    const registry = foldProjects(journalViewFromDir(deps.dataDir, PROJECTS_CHAIN_BASENAME).records());
    const found = registry.get(projectName);
    if (found !== undefined) project = found;
    else {
      const known = [...registry.keys()];
      resolveError =
        known.length === 0
          ? `no registered project named "${projectName}": the registry under ${deps.dataDir} holds none`
          : `no registered project named "${projectName}" (registered: ${known.join(", ")})`;
    }
  } catch (err) {
    resolveError = `the projects chain under ${deps.dataDir} could not be folded: ${(err as Error).message}`;
  }
  if (project === null) return adoptValidateFailure(deps, json, null, resolveError!);

  let corpus: MaterializedCorpus;
  try {
    corpus = materializeCorpus(project.repoDir, corpusFlag);
  } catch (err) {
    return adoptValidateFailure(deps, json, project.name, (err as Error).message);
  }

  let corpusData: AdoptValidateCorpusData;
  let score: HoldbackScore;
  let targetHead: string | null;
  try {
    let ownership;
    try {
      ownership = loadCorpusOwnership(createProcessHoldbackCorpusReader(), corpus.dir);
    } catch (err) {
      return adoptValidateFailure(deps, json, project.name, (err as Error).message);
    }
    corpusData = {
      ref: corpusFlag,
      hash: ownership.corpusHash,
      specs: ownership.specs.length,
      head: ownership.corpusHead,
    };

    const gitReader = createProcessHoldbackGitReader();
    const history = extractReplayHistory(gitReader, project.repoDir);
    if (history.mode === "empty") {
      // B-5: too shallow to evaluate says so and scores nothing; no record
      // is journaled, because nothing was measured.
      return adoptValidateFailure(
        deps,
        json,
        project.name,
        `the target's history is too shallow to evaluate: no readable first-parent commits on ${history.ref}; nothing was scored and nothing was journaled`,
        corpusData
      );
    }
    score = replayHoldback(history, ownership);
    targetHead = gitReader.headSha(project.repoDir);
  } finally {
    corpus.cleanup();
  }

  // B-3: the ratification-input record, appended through a short-lived
  // writer handle exactly as the preflight record is (034 B-6); a lock held
  // by something driving this project refuses cleanly and is reported as
  // the operational failure it is, with the report already printed.
  let journaled: AdoptValidateData["journaled"] = null;
  let journalError: string | null = null;
  try {
    const handle = openJournal(projectStateRoot(project.repoDir));
    try {
      const record = journalValidation({
        handle,
        project: project.name,
        source: CONTROL_SOURCE,
        corpus: corpusData,
        target: { headSha: targetHead, ref: score.ref, mode: score.mode, requested: score.requested, read: score.read },
        score,
      });
      journaled = { seq: record.seq, kind: record.kind, ts: record.ts };
    } finally {
      handle.close();
    }
  } catch (err) {
    journalError = `the ratification-input record could not be journaled: ${(err as Error).message}`;
  }

  const data: AdoptValidateData = {
    project: project.name,
    resolveError: null,
    corpus: corpusData,
    targetHead,
    score,
    journaled,
    journalError,
  };

  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptValidateData>);
    return journalError === null ? EXIT_OK : EXIT_FAILURE;
  }

  for (const line of renderHoldbackReport(score, {
    corpusRef: corpusFlag,
    corpusHash: corpusData.hash,
    corpusSpecs: corpusData.specs,
    corpusHead: corpusData.head,
    targetDir: project.repoDir,
    targetHead,
  })) {
    deps.out(line);
  }
  if (journaled !== null) {
    deps.out(`journaled: seq ${journaled.seq}  ${journaled.kind}  ${journaled.ts} (project ${project.name})`);
    return EXIT_OK;
  }
  deps.err(`adopt validate: ${journalError}`);
  return EXIT_FAILURE;
}

// --- adoption synthesize (spec 035) -----------------------------------------

interface AdoptSynthesizeData {
  readonly project: string | null;
  readonly resolveError: string | null;
  readonly proposalPath: string | null;
  readonly report: (Omit<SynthesisReport, "claimed"> & { readonly claimed: Record<string, readonly string[]> }) | null;
}

function adoptSynthesizeFailure(deps: OrchestratorCliDeps, json: boolean, project: string | null, resolveError: string): number {
  const data: AdoptSynthesizeData = { project, resolveError, proposalPath: null, report: null };
  if (json) {
    printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptSynthesizeData>);
    return EXIT_FAILURE;
  }
  deps.err(`adopt synthesize: ${resolveError}`);
  return EXIT_FAILURE;
}

// B-1: the proposal by path or by content hash. A 64-hex argument resolves
// through the project's journaled adopt.preflight records to the recorded
// out path, and the document there must still hash to the requested value: a
// proposal that moved or was edited since the operator read it refuses
// rather than synthesizing from something nobody chose (D-9).
function resolveProposalDocument(project: Project, flag: string): { readonly path: string; readonly document: string } | string {
  const isHash = /^[0-9a-f]{64}$/.test(flag);
  let path = flag;
  if (isHash) {
    let recordedOut: string | null = null;
    try {
      const records = journalViewFromDir(projectStateRoot(project.repoDir)).records();
      for (const record of records) {
        if (record.kind !== "adopt.preflight") continue;
        const payload = record.payload as Record<string, unknown>;
        if (payload.contentHash === flag && typeof payload.out === "string") recordedOut = payload.out;
      }
    } catch (err) {
      return `the work journal under ${projectStateRoot(project.repoDir)} could not be read: ${(err as Error).message}`;
    }
    if (recordedOut === null) {
      return `no journaled adopt.preflight record of project "${project.name}" carries content hash ${flag}`;
    }
    path = recordedOut;
  }
  let document: string;
  try {
    document = fs.readFileSync(resolve(path), "utf8");
  } catch (err) {
    return `the proposal at ${resolve(path)} could not be read: ${(err as Error).message}`;
  }
  if (isHash && proposalHash(document) !== flag) {
    return `the proposal at ${path} no longer hashes to ${flag}; re-run adopt preflight and choose again`;
  }
  return { path: resolve(path), document };
}

// 035's one verb. Offline of any daemon like the rest of the adopt group,
// but not free: it drives real sessions against the target unless the test
// seam is injected, journals into the project's work journal for its whole
// duration (a live daemon driving this project holds that writer and refuses
// this run cleanly), and applies the project's own ceiling (B-2).
async function cmdAdoptSynthesize(deps: OrchestratorCliDeps, json: boolean, projectName: string, proposalFlag: string): Promise<number> {
  let project: Project | null = null;
  let resolveError: string | null = null;
  try {
    const registry = foldProjects(journalViewFromDir(deps.dataDir, PROJECTS_CHAIN_BASENAME).records());
    const found = registry.get(projectName);
    if (found !== undefined) project = found;
    else {
      const known = [...registry.keys()];
      resolveError =
        known.length === 0
          ? `no registered project named "${projectName}": the registry under ${deps.dataDir} holds none`
          : `no registered project named "${projectName}" (registered: ${known.join(", ")})`;
    }
  } catch (err) {
    resolveError = `the projects chain under ${deps.dataDir} could not be folded: ${(err as Error).message}`;
  }
  if (project === null) return adoptSynthesizeFailure(deps, json, null, resolveError!);

  // B-1: synthesis is for adoptable targets. A governed project's corpus is
  // driven by the daemon, and an unsound repository cannot take a branch;
  // both refuse by name rather than authoring over the operator's head.
  if (project.qualification.adoptable !== true) {
    const word = project.qualification.qualified ? "already governed" : "not adoptable";
    return adoptSynthesizeFailure(
      deps,
      json,
      project.name,
      `"${project.name}" is ${word}: adopt synthesize needs a target whose qualification reads adoptable (a sound repository with no corpus; see projects requalify)`
    );
  }

  const resolved = resolveProposalDocument(project, proposalFlag);
  if (typeof resolved === "string") return adoptSynthesizeFailure(deps, json, project.name, resolved);

  let journal: JournalHandle;
  try {
    journal = openJournal(projectStateRoot(project.repoDir));
  } catch (err) {
    return adoptSynthesizeFailure(
      deps,
      json,
      project.name,
      `the work journal could not be opened for writing: ${(err as Error).message}`
    );
  }

  let report: SynthesisReport;
  try {
    const boundProject = project;
    const session: SynthesisSessionFn =
      deps.makeSynthesisSession !== undefined
        ? deps.makeSynthesisSession(project, journal)
        : async (request) =>
            runSession({
              repo: boundProject.repoDir,
              prompt: request.prompt,
              profile: boundProject.profile,
              journal,
            });
    report = await runSynthesis({
      projectName: project.name,
      proposalDocument: resolved.document,
      journal,
      session,
      git: createProcessSynthesisGit(project.repoDir),
      gate: createProcessSynthesisGate(project.repoDir),
      clock: { now: () => deps.now() },
      source: CONTROL_SOURCE,
      ceiling: project.ceiling,
    });
  } finally {
    journal.close();
  }

  if (json) {
    const data: AdoptSynthesizeData = {
      project: project.name,
      resolveError: null,
      proposalPath: resolved.path,
      report: { ...report, claimed: Object.fromEntries(report.claimed) },
    };
    printJson(deps, { ok: true, data } satisfies ApiResponse<AdoptSynthesizeData>);
    return report.outcome === "completed" ? EXIT_OK : EXIT_FAILURE;
  }

  for (const line of renderSynthesisReport(report)) deps.out(line);
  return report.outcome === "completed" ? EXIT_OK : EXIT_FAILURE;
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
        // 034 B-5: an adoptable project's structural reads refuse by name, so
        // `dag` and `next` answer with why there is nothing to schedule
        // rather than an empty corpus or a raw spec-spine failure (AC-3). A
        // governed project keeps the shared process reader untouched.
        dagReader: adoptableDagReader(project) ?? dagReader,
        repoDir: project.repoDir,
        evidenceDir: join(stateRoot, "verify-evidence"),
        controls: standby.daemonFor(project.name),
        // 026 D-5 / 027 D-3: reverify may wake a daemon for a project
        // nothing is driving; the scheduler parks it live and drives it on
        // the next cycle for the queued requalification.
        wakeControls: () => standby.openForControl(project.name),
      };
    },
    register(path: string, name: string | undefined, profile: ExecutionProfile | undefined, source: ProjectSource): void {
      registerProject({
        chain: chain(),
        repoDir: path,
        qualification: qualifyProject(probe, path),
        source,
        ...(name === undefined ? {} : { name }),
        ...(profile === undefined ? {} : { profile }),
      });
    },
    setArmed(name: string, armed: boolean, source: ProjectSource): void {
      setProjectArmed({ chain: chain(), name, armed, source });
    },
    setProfile(name: string, profile: ExecutionProfile, source: ProjectSource): void {
      setProjectProfile({ chain: chain(), name, profile, source });
    },
    setCeiling(name: string, ceiling: CostCeiling | null, source: ProjectSource): void {
      setProjectCeiling({ chain: chain(), name, ceiling, source });
    },
    setGate(name: string, gate: GateContract): void {
      setProjectGate({ chain: chain(), name, gate });
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

// 026 D-7's staleness proxy: the sha of the checkout this process's code was
// loaded from, read at the code root itself (two levels above this file),
// never from --repo: the two coincide for the self-hosted daemon but only
// the former names the running modules. HEAD is a proxy: a dirty working
// tree changes code without moving it, which the gate knowingly misses.
function readCodeHeadSha(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const sha = proc.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
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
  // Annotated because `makeProjectDeps` reads the live registry back off this
  // same daemon (032 B-4), which is a cycle the inferencer will not resolve.
  const standby: StandbyDaemon = new StandbyDaemon({
    daemonHomeDir: deps.dataDir,
    // 010 D13: each project's state root lives inside that project, in
    // exactly this checkout's own layout; 026 B-6: the scheduler holds the
    // one identity lock, so a project's run takes none.
    makeProjectDeps: (project) =>
      createProductionDaemonDeps({
        dataDir: projectStateRoot(project.repoDir),
        repoDir: project.repoDir,
        supervised: true,
        // 032 B-4: every session this project's seams spawn runs under the
        // posture the chain holds now, not the one it held when the seams
        // were built. The scheduler caches a seam set per project for the
        // process's life, so a profile read once here would mean a posture
        // an operator tightened did not apply until the daemon restarted.
        profile: () => standby.projects.get(project.name)?.profile ?? project.profile,
        // 033 B-2: read at every spawn boundary for the same reason, and one
        // more besides. A per-run trip pauses for an operator (B-4), and the
        // act that releases it is usually raising this very ceiling; a value
        // read once when the seams were built could not carry that release to
        // the boundary that is waiting for it.
        ceiling: () => standby.projects.get(project.name)?.ceiling ?? project.ceiling,
        // 041 B-4: read at every stage boundary for the same reason, and one
        // more besides. A gate that refuses a build at the base commit is
        // corrected by the operator through `projects gate`, and that
        // correction has to reach the stage that is waiting for it.
        gate: () => standby.projects.get(project.name)?.gate ?? project.gate,
        // 041 B-8: a project registered before this spec has no gate record
        // and folds to governance-only; the first daemon to service it probes
        // its tree and writes the record it was missing, before any stage of
        // that run is scheduled. The scheduler holds the chain's one writer
        // handle (026 B-6), so the write goes through it.
        migrateGateContract: () => {
          migrateProjectGate(standby.projectsChain, project.name);
        },
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
    // 026 D-7: a merge under a running daemon must freeze driving, not let
    // stale in-memory code verify specs it does not implement.
    readCodeSha: readCodeHeadSha,
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
  const accepted = acceptedFlags(command, rest[0]);
  if (accepted !== undefined) {
    const stray = strayFlag(args, accepted);
    if (stray !== null) return usage(scoped, `${stray} is not a flag of "${command}"`);
  }
  // 041 B-7's `--` belongs to `projects gate` alone. Every other verb refuses
  // it rather than ignoring what follows: silently swallowing arguments is
  // the defect 023 D-6 refuses, and a separator that means nothing to the
  // verb at hand is the same defect wearing a dash.
  if (args.passthrough !== null && !(command === "projects" && rest[0] === "gate")) {
    return usage(scoped, `"--" and everything after it means nothing to "${command}"`);
  }

  // The two offline commands (B-4 and the daemon lifecycle) are dispatched
  // before a client is ever created: they must work with nothing listening.
  if (command === "journal") {
    const sub = rest[0];
    if (sub === "verify") {
      if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after journal verify`);
      // 031 B-4: a bundle check reads the bundle and nothing else, so the
      // root-addressing flags mean nothing to it and are refused (028 D-5).
      if (args.bundle !== null) {
        if (args.project !== null || args.dir !== null) {
          return usage(scoped, "journal verify --bundle takes neither --project nor --dir");
        }
        return cmdBundleVerify(scoped, args.json, args.bundle);
      }
      if (args.project !== null && args.dir !== null) {
        return usage(scoped, "journal verify takes --project or --dir, not both");
      }
      return cmdJournalVerify(scoped, args.json, args.project, args.dir);
    }
    if (sub === "export") {
      if (rest.length > 1) return usage(scoped, `unexpected argument "${rest[1]}" after journal export`);
      if (args.out === null) return usage(scoped, "journal export needs --out <path>");
      return cmdJournalExport(scoped, args.json, args.project, args.out);
    }
    return usage(scoped, `journal needs the "verify" or "export" subcommand`);
  }
  if (command === "daemon") return cmdDaemon(scoped, url, args.json, rest);

  // The adopt group is offline too: preflight must work against a repository
  // no daemon has ever heard of, and validate (036 B-4) needs a compiling
  // corpus and a git history, nothing else; no client is created for either.
  if (command === "adopt") {
    const sub = rest[0];
    if (sub === "preflight") {
      const path = rest[1];
      if (path === undefined || path.trim().length === 0) return usage(scoped, "adopt preflight needs a repository path");
      if (rest.length > 2) return usage(scoped, `unexpected argument "${rest[2]}" after adopt preflight`);
      const extras = exclusionAdditionsFromFlag(args.exclude);
      if (typeof extras === "string") return usage(scoped, extras);
      return cmdAdoptPreflight(scoped, args.json, path, args.out, extras);
    }
    if (sub === "validate") {
      const projectName = rest[1];
      if (projectName === undefined || projectName.trim().length === 0) {
        return usage(scoped, "adopt validate needs a project name");
      }
      if (rest.length > 2) return usage(scoped, `unexpected argument "${rest[2]}" after adopt validate`);
      if (args.corpus === null) return usage(scoped, "adopt validate needs --corpus <branch-or-path>");
      return cmdAdoptValidate(scoped, args.json, projectName, args.corpus);
    }
    if (sub === "synthesize") {
      const projectName = rest[1];
      if (projectName === undefined || projectName.trim().length === 0) {
        return usage(scoped, "adopt synthesize needs a project name");
      }
      if (rest.length > 2) return usage(scoped, `unexpected argument "${rest[2]}" after adopt synthesize`);
      if (args.proposal === null) return usage(scoped, "adopt synthesize needs --proposal <path-or-hash>");
      return cmdAdoptSynthesize(scoped, args.json, projectName, args.proposal);
    }
    return usage(scoped, `adopt needs the "preflight", "validate", or "synthesize" subcommand`);
  }

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
      return cmdEconomics(scoped, client, url, args.json, target.data.name);
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
