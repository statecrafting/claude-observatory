// The fixture API the component tests render against (spec 024 FR-002).
//
// The corpus is the same three-spec world the API territory's own fixtures
// use (001-alpha adopted, 002-beta depending on it, 003-gamma depending on
// that), plus one shipped-then-amended spec so pin drift and the invalidation
// cascade have something to render. Shapes come from the wire contract, so a
// change to a served type breaks these fixtures at typecheck rather than
// leaving the tests passing against a shape the daemon no longer serves.
//
// v2 splits the client in two (spec 027): `fixtureProjectClient` is the scoped
// half the panels take, `fixtureClient` the global half the shell takes, and
// both record into the same `calls` array so a test can assert what a panel
// issued no matter which half it was handed.
import type {
  ApiClient,
  ApiMeta,
  ApiResponse,
  ControlResult,
  ControlVerbToken,
  DagView,
  DecisionsView,
  HistoryView,
  ProjectClient,
  ProjectView,
  ProjectsView,
  QuotaView,
  RunView,
} from "../src/api";

const PIN_ALPHA = "a".repeat(64);
const PIN_BETA = "b".repeat(64);
const PIN_GAMMA = "c".repeat(64);
const PIN_DELTA_SHIPPED = "d".repeat(64);
const PIN_DELTA_NOW = "e".repeat(64);
const EVIDENCE_HASH = "f".repeat(64);

// The project every scoped fixture below belongs to. Named once, so a panel
// rendering the wrong project's fold is visible as a mismatch rather than as
// two unrelated string literals that happen to differ.
export const FIXTURE_PROJECT = "alpha";

export const FIXTURE_DAG: DagView = {
  project: FIXTURE_PROJECT,
  specs: [
    {
      id: "001-alpha",
      implementation: "complete",
      dependsOn: [],
      shipped: true,
      shippedSource: "adopted",
      shippedPin: PIN_ALPHA,
      currentPin: PIN_ALPHA,
      pinError: null,
      drifted: false,
      invalidated: false,
      skipped: false,
      ready: true,
      blockers: [],
      specExecStatus: null,
    },
    {
      id: "002-beta",
      implementation: "pending",
      dependsOn: ["001-alpha"],
      shipped: false,
      shippedSource: null,
      shippedPin: null,
      currentPin: PIN_BETA,
      pinError: null,
      drifted: false,
      invalidated: false,
      skipped: false,
      ready: true,
      blockers: [],
      specExecStatus: "building",
    },
    {
      id: "003-gamma",
      implementation: "pending",
      dependsOn: ["002-beta", "004-delta"],
      shipped: false,
      shippedSource: null,
      shippedPin: null,
      currentPin: PIN_GAMMA,
      pinError: null,
      drifted: false,
      invalidated: false,
      skipped: false,
      ready: false,
      blockers: ["dependency 002-beta is not shipped", "dependency 004-delta is invalidated (pin drift)"],
      specExecStatus: null,
    },
    {
      id: "004-delta",
      implementation: "complete",
      dependsOn: [],
      shipped: true,
      shippedSource: "pipeline",
      shippedPin: PIN_DELTA_SHIPPED,
      currentPin: PIN_DELTA_NOW,
      pinError: null,
      drifted: true,
      invalidated: true,
      skipped: false,
      ready: true,
      blockers: [],
      specExecStatus: "shipped",
    },
  ],
  nextReady: "002-beta",
  blockers: [],
  cycle: null,
  invalidated: ["004-delta"],
};

type RunStatus = NonNullable<RunView["run"]>["status"];

export function runViewWithStatus(status: RunStatus): RunView {
  return {
    project: FIXTURE_PROJECT,
    run: {
      id: "run-1",
      targetRepo: "/repo",
      createdTs: "2026-07-30T11:00:00.000Z",
      status,
      needsReconcile: false,
    },
    spec: { id: "se-1", specId: "002-beta", pin: PIN_BETA, attempt: 1, status: "building", needsReconcile: false },
    stage: { id: "st-1", stage: "build", attempt: 1, status: "running", needsReconcile: false },
    pauseReason: null,
    blockers: [],
    lastHeartbeatMs: Date.parse("2026-07-30T11:30:00.000Z"),
    awaitingApproval: [],
  };
}

export const FIXTURE_RUN: RunView = runViewWithStatus("running");

// Global, not scoped (027 B-4): the account's quota is one pool, and `project`
// names the run that hit the wall rather than scoping the fact itself.
export const FIXTURE_QUOTA: QuotaView = {
  parked: true,
  project: FIXTURE_PROJECT,
  targetMs: Date.parse("2026-07-30T13:00:00.000Z"),
  estimated: true,
  msUntilTarget: 3_600_000,
  consecutiveQuotaParks: 3,
  warn: true,
  nowMs: Date.parse("2026-07-30T12:00:00.000Z"),
};

export const FIXTURE_HISTORY: HistoryView = {
  project: FIXTURE_PROJECT,
  entries: [
    {
      specExecId: "se-0",
      runId: "run-1",
      specId: "001-alpha",
      pin: PIN_ALPHA,
      attempt: 1,
      status: "shipped",
      needsReconcile: false,
      stages: [{ id: "st-0", stage: "verify", attempt: 1, status: "passed", needsReconcile: false }],
      prNumber: 7,
      mergeSha: "0".repeat(40),
      ciConclusion: "passed",
      verifyVerdict: "passed",
      evidenceRefs: [EVIDENCE_HASH],
    },
  ],
};

export const FIXTURE_DECISIONS: DecisionsView = {
  project: FIXTURE_PROJECT,
  query: {},
  total: 1,
  decisions: [
    {
      id: "024-d1-example",
      specId: "024-web-ui",
      scope: ["web/"],
      title: "An example decision",
      decision: "The UI renders only what the API serves.",
      rationale: "Anything else is a number with no journal behind it.",
    },
  ],
};

export const FIXTURE_PROJECT_VIEW: ProjectView = {
  name: FIXTURE_PROJECT,
  repoDir: "/repo",
  armed: true,
  qualification: {
    qualified: true,
    checks: [{ id: "git-repo", ok: true, detail: "git work tree root" }],
    warnings: [],
    checkedAt: "2026-07-30T10:00:00.000Z",
  },
  run: FIXTURE_RUN.run,
  spec: FIXTURE_RUN.spec,
  stage: FIXTURE_RUN.stage,
  readError: null,
};

export const FIXTURE_PROJECTS: ProjectsView = { projects: [FIXTURE_PROJECT_VIEW] };

export const FIXTURE_META: ApiMeta = {
  apiVersion: 2,
  service: "claude-observatory-orchestrator",
  loopbackOnly: true,
  controlsAvailable: true,
  daemon: { state: "driving", activeProject: FIXTURE_PROJECT, scanIntervalMs: 60_000, lastScanMs: null },
  projectCount: 1,
  routes: ["/api/meta"],
};

// --- the fixture client -----------------------------------------------------

export interface RecordedCall {
  readonly method: string;
  readonly specId: string | null;
}

export interface FixtureProjectClient extends ProjectClient {
  readonly calls: RecordedCall[];
}

export interface FixtureClient extends ApiClient {
  readonly calls: RecordedCall[];
  project(name: string): FixtureProjectClient;
}

function ok<T>(data: T): Promise<ApiResponse<T>> {
  return Promise.resolve({ ok: true, data });
}

export function controlAnswer(
  verb: ControlVerbToken,
  specId: string | null,
  kind: string,
  payload: Record<string, string>,
  seq: number = 41
): ControlResult {
  return {
    project: FIXTURE_PROJECT,
    verb,
    specId,
    applied: true,
    record: { seq, ts: "2026-07-30T12:00:00.000Z", kind, payload },
    runStatus: "running",
  };
}

export interface FixtureClientOptions {
  readonly control?: (verb: ControlVerbToken, specId: string | null) => ApiResponse<ControlResult>;
}

const BASE_URL = "http://127.0.0.1:4519";

// The scoped half: what a panel is handed (027 B-3, B-5). `calls` is passed in
// rather than owned, so the global client below shares one record of what was
// issued across every project it hands out.
function projectClient(name: string, calls: RecordedCall[], options: FixtureClientOptions): FixtureProjectClient {
  const control =
    options.control ??
    ((verb: ControlVerbToken, specId: string | null): ApiResponse<ControlResult> => ({
      ok: true,
      data: controlAnswer(verb, specId, `control.${verb}`, specId === null ? {} : { specId, source: "web-ui" }),
    }));

  const issue = (method: string, verb: ControlVerbToken, specId: string | null): Promise<ApiResponse<ControlResult>> => {
    calls.push({ method, specId });
    return Promise.resolve(control(verb, specId));
  };

  return {
    calls,
    name,
    dag: () => ok(FIXTURE_DAG),
    run: () => ok(FIXTURE_RUN),
    decisions: () => ok(FIXTURE_DECISIONS),
    history: () => ok(FIXTURE_HISTORY),
    evidence: (hash) => ok({ project: name, hash, mediaType: "text/plain" as const, bytes: 3, text: "ok\n", base64: null }),
    evidenceUrl: (hash) => `${BASE_URL}/api/projects/${name}/evidence/${hash}?raw=1`,
    startRun: () => issue("startRun", "start", null),
    pauseRun: () => issue("pauseRun", "pause", null),
    resumeRun: () => issue("resumeRun", "resume", null),
    skipSpec: (specId) => issue("skipSpec", "skip", specId),
    retryStage: (specId) => issue("retryStage", "retry-stage", specId),
    reverify: (specId) => issue("reverify", "reverify", specId),
    forceHumanGate: (specId) => issue("forceHumanGate", "force-human-gate", specId),
    approve: (specId) => issue("approve", "approve", specId),
  };
}

// What a panel takes: one project, already chosen.
export function fixtureClient(options: FixtureClientOptions = {}): FixtureProjectClient {
  return projectClient(FIXTURE_PROJECT, [], options);
}

// What the shell takes: the global routes, with `project()` handing out the
// scoped half above (027 B-2, B-4).
export function fixtureApiClient(options: FixtureClientOptions = {}): FixtureClient {
  const calls: RecordedCall[] = [];
  const registryAnswer = (verb: "register" | "arm" | "disarm" | "requalify" | "remove", name: string | null) => {
    calls.push({ method: verb, specId: null });
    return ok({ verb, project: name, applied: true, record: null, snapshot: FIXTURE_PROJECT_VIEW });
  };

  return {
    calls,
    baseUrl: BASE_URL,
    eventsUrl: (project) =>
      project === undefined ? `${BASE_URL}/api/events` : `${BASE_URL}/api/events?project=${project}`,
    meta: () => ok(FIXTURE_META),
    quota: () => ok(FIXTURE_QUOTA),
    projects: () => ok(FIXTURE_PROJECTS),
    registerProject: (request) => registryAnswer("register", request.name ?? null),
    armProject: (name) => registryAnswer("arm", name),
    disarmProject: (name) => registryAnswer("disarm", name),
    requalifyProject: (name) => registryAnswer("requalify", name),
    removeProject: (name) => registryAnswer("remove", name),
    project: (name) => projectClient(name, calls, options),
  };
}
