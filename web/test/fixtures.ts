// The fixture API the component tests render against (spec 024 FR-002).
//
// The corpus is the same three-spec world the API territory's own fixtures
// use (001-alpha adopted, 002-beta depending on it, 003-gamma depending on
// that), plus one shipped-then-amended spec so pin drift and the invalidation
// cascade have something to render. Shapes come from the wire contract, so a
// change to a served type breaks these fixtures at typecheck rather than
// leaving the tests passing against a shape the daemon no longer serves.
import type {
  ApiClient,
  ApiMeta,
  ApiResponse,
  ControlResult,
  ControlVerbToken,
  DagView,
  DecisionsView,
  HistoryView,
  QuotaView,
  RunView,
} from "../src/api";

const PIN_ALPHA = "a".repeat(64);
const PIN_BETA = "b".repeat(64);
const PIN_GAMMA = "c".repeat(64);
const PIN_DELTA_SHIPPED = "d".repeat(64);
const PIN_DELTA_NOW = "e".repeat(64);
const EVIDENCE_HASH = "f".repeat(64);

export const FIXTURE_DAG: DagView = {
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

export const FIXTURE_QUOTA: QuotaView = {
  parked: true,
  targetMs: Date.parse("2026-07-30T13:00:00.000Z"),
  estimated: true,
  msUntilTarget: 3_600_000,
  consecutiveQuotaParks: 3,
  warn: true,
  nowMs: Date.parse("2026-07-30T12:00:00.000Z"),
};

export const FIXTURE_HISTORY: HistoryView = {
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

export const FIXTURE_META: ApiMeta = {
  apiVersion: 1,
  service: "claude-observatory-orchestrator",
  loopbackOnly: true,
  controlsAvailable: true,
  routes: ["/api/meta"],
};

// --- the fixture client -----------------------------------------------------

export interface RecordedCall {
  readonly method: string;
  readonly specId: string | null;
}

export interface FixtureClient extends ApiClient {
  readonly calls: RecordedCall[];
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

export function fixtureClient(options: FixtureClientOptions = {}): FixtureClient {
  const calls: RecordedCall[] = [];
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
    baseUrl: "http://127.0.0.1:4519",
    eventsUrl: "http://127.0.0.1:4519/api/events",
    meta: () => ok(FIXTURE_META),
    dag: () => ok(FIXTURE_DAG),
    run: () => ok(FIXTURE_RUN),
    quota: () => ok(FIXTURE_QUOTA),
    decisions: () => ok(FIXTURE_DECISIONS),
    history: () => ok(FIXTURE_HISTORY),
    evidence: (hash) =>
      ok({ hash, mediaType: "text/plain" as const, bytes: 3, text: "ok\n", base64: null }),
    evidenceUrl: (hash) => `http://127.0.0.1:4519/api/evidence/${hash}?raw=1`,
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
