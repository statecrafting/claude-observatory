// The typed fetch wrapper every client uses (spec 022 FR-002, spec 027
// FR-002): the CLI (spec 023) and the web UI (spec 024) both talk to the
// daemon through this and never hand-build a URL or re-declare a response
// shape.
//
// "Generated" in the sense that matters: nothing here is a second copy of
// the contract. The paths come from API_ROUTES and PROJECT_ROUTES and the
// payload types come from types.ts, both shared verbatim with the server, so
// a route or a shape cannot drift between the two halves without failing
// typecheck. No v1 path survives in either table.
//
// v2's shape follows the API's own (027 B-1): the client itself carries the
// global routes, and `client.project(name)` returns the scoped half. A caller
// that has not decided which project it means cannot accidentally address one,
// because there is no unscoped `dag()` to call.
//
// Every method returns the same envelope the server serves, including for
// failures that never reached the server: an unreachable daemon becomes
// `{ok: false, error: {kind: "unreachable"}}` rather than a thrown
// exception, which is what lets spec 023 B-3 map it to its own exit code
// without a try/catch around every call.
import {
  API_ROUTES,
  API_VERSION,
  API_VERSION_HEADER,
  CONTROL_SOURCE_HEADER,
  DEFAULT_CONTROL_SOURCE,
  EVENTS_PROJECT_PARAM,
  PROJECT_ROUTES,
  projectRoute,
  type ApiErrorKind,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type DagView,
  type DecisionQueryParams,
  type DecisionsView,
  type EvidenceView,
  type HistoryView,
  type ProjectControlResult,
  type ProjectsView,
  type QuotaView,
  type RegisterProjectRequest,
  type RunView,
} from "./types";
import type { ExecutionProfile } from "../profile";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  // e.g. "http://127.0.0.1:4519"; a trailing slash is tolerated.
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  // Recorded in the journal as the control's source (spec 021 B-4).
  readonly source?: string;
}

// The project-scoped half of the API (027 B-3, B-5). Every method here
// addresses one named project, and the name is fixed when the sub-client is
// made rather than passed to each call, so no call site can mix two projects
// by accident.
export interface ProjectClient {
  readonly name: string;
  dag(): Promise<ApiResponse<DagView>>;
  run(): Promise<ApiResponse<RunView>>;
  decisions(query?: DecisionQueryParams): Promise<ApiResponse<DecisionsView>>;
  history(): Promise<ApiResponse<HistoryView>>;
  evidence(hash: string): Promise<ApiResponse<EvidenceView>>;
  evidenceUrl(hash: string): string;
  startRun(): Promise<ApiResponse<ControlResult>>;
  pauseRun(): Promise<ApiResponse<ControlResult>>;
  resumeRun(): Promise<ApiResponse<ControlResult>>;
  skipSpec(specId: string): Promise<ApiResponse<ControlResult>>;
  retryStage(specId: string): Promise<ApiResponse<ControlResult>>;
  reverify(specId: string): Promise<ApiResponse<ControlResult>>;
  forceHumanGate(specId: string): Promise<ApiResponse<ControlResult>>;
  approve(specId: string): Promise<ApiResponse<ControlResult>>;
}

// The global half: daemon meta, the account's one quota pool, the registry
// and its controls, and the one event stream (027 B-2, B-4).
export interface ApiClient {
  readonly baseUrl: string;
  // Omitting the project subscribes to everything; naming one applies the
  // server-side filter, which still carries daemon-scoped events.
  eventsUrl(project?: string): string;
  meta(): Promise<ApiResponse<ApiMeta>>;
  quota(): Promise<ApiResponse<QuotaView>>;
  projects(): Promise<ApiResponse<ProjectsView>>;
  registerProject(request: RegisterProjectRequest): Promise<ApiResponse<ProjectControlResult>>;
  armProject(name: string): Promise<ApiResponse<ProjectControlResult>>;
  disarmProject(name: string): Promise<ApiResponse<ProjectControlResult>>;
  requalifyProject(name: string): Promise<ApiResponse<ProjectControlResult>>;
  removeProject(name: string): Promise<ApiResponse<ProjectControlResult>>;
  // 032 B-2: sets the posture sessions driven against this project run
  // under. The whole profile travels, never a patch.
  setProjectProfile(name: string, profile: ExecutionProfile): Promise<ApiResponse<ProjectControlResult>>;
  project(name: string): ProjectClient;
}

function clientError<T>(kind: ApiErrorKind, message: string): ApiResponse<T> {
  return { ok: false, error: { kind, message } };
}

// The server always answers in the envelope, including for its own internal
// errors, so anything that does not parse as one is reported as
// `malformed-response` rather than being coerced into a plausible shape.
function parseEnvelope<T>(text: string): ApiResponse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return clientError<T>("malformed-response", `response body is not JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
    return clientError<T>("malformed-response", "response body is not an {ok, ...} envelope");
  }
  return parsed as ApiResponse<T>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const source = options.source ?? DEFAULT_CONTROL_SOURCE;

  async function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { [API_VERSION_HEADER]: String(API_VERSION) };
    if (init?.method === "POST") headers[CONTROL_SOURCE_HEADER] = source;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      return clientError<T>("unreachable", `${baseUrl}${path}: ${(err as Error).message}`);
    }

    // The body can fail after the headers already arrived (a connection
    // dropped mid-response), which is the same transport failure class as
    // never reaching the daemon at all. It must not escape as a throw either,
    // or the try/catch this module exists to remove comes back at every call
    // site.
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return clientError<T>("unreachable", `${baseUrl}${path}: ${(err as Error).message}`);
    }
    return parseEnvelope<T>(text);
  }

  const post = <T>(path: string, body?: unknown): Promise<ApiResponse<T>> =>
    request<T>(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });

  function decisionsPath(project: string, query: DecisionQueryParams | undefined): string {
    const base = projectRoute(project, PROJECT_ROUTES.decisions);
    if (!query) return base;
    const params = new URLSearchParams();
    if (query.query !== undefined) params.set("query", query.query);
    if (query.specId !== undefined) params.set("specId", query.specId);
    if (query.path !== undefined) params.set("path", query.path);
    const encoded = params.toString();
    return encoded.length === 0 ? base : `${base}?${encoded}`;
  }

  // D-1: a project name needs no escaping, so it goes into the path as it is.
  // A spec id and an evidence hash are not slugs and still do.
  function specControlPath(project: string, specId: string, verb: string): string {
    return projectRoute(project, `${PROJECT_ROUTES.specPrefix}${encodeURIComponent(specId)}/${verb}`);
  }

  function projectClient(name: string): ProjectClient {
    const evidencePath = (hash: string): string =>
      projectRoute(name, `${PROJECT_ROUTES.evidencePrefix}${encodeURIComponent(hash)}`);

    return {
      name,
      dag: () => request<DagView>(projectRoute(name, PROJECT_ROUTES.dag)),
      run: () => request<RunView>(projectRoute(name, PROJECT_ROUTES.run)),
      decisions: (query) => request<DecisionsView>(decisionsPath(name, query)),
      history: () => request<HistoryView>(projectRoute(name, PROJECT_ROUTES.history)),
      evidence: (hash) => request<EvidenceView>(evidencePath(hash)),
      evidenceUrl: (hash) => `${baseUrl}${evidencePath(hash)}?raw=1`,
      startRun: () => post<ControlResult>(projectRoute(name, PROJECT_ROUTES.runStart)),
      pauseRun: () => post<ControlResult>(projectRoute(name, PROJECT_ROUTES.runPause)),
      resumeRun: () => post<ControlResult>(projectRoute(name, PROJECT_ROUTES.runResume)),
      skipSpec: (specId) => post<ControlResult>(specControlPath(name, specId, "skip")),
      retryStage: (specId) => post<ControlResult>(specControlPath(name, specId, "retry-stage")),
      reverify: (specId) => post<ControlResult>(specControlPath(name, specId, "reverify")),
      forceHumanGate: (specId) => post<ControlResult>(specControlPath(name, specId, "force-human-gate")),
      approve: (specId) => post<ControlResult>(specControlPath(name, specId, "approve")),
    };
  }

  return {
    baseUrl,
    eventsUrl: (project) =>
      project === undefined
        ? `${baseUrl}${API_ROUTES.events}`
        : `${baseUrl}${API_ROUTES.events}?${EVENTS_PROJECT_PARAM}=${encodeURIComponent(project)}`,
    meta: () => request<ApiMeta>(API_ROUTES.meta),
    quota: () => request<QuotaView>(API_ROUTES.quota),
    projects: () => request<ProjectsView>(API_ROUTES.projects),
    registerProject: (registration) => post<ProjectControlResult>(API_ROUTES.projects, registration),
    armProject: (name) => post<ProjectControlResult>(projectRoute(name, PROJECT_ROUTES.arm)),
    disarmProject: (name) => post<ProjectControlResult>(projectRoute(name, PROJECT_ROUTES.disarm)),
    requalifyProject: (name) => post<ProjectControlResult>(projectRoute(name, PROJECT_ROUTES.requalify)),
    removeProject: (name) => post<ProjectControlResult>(projectRoute(name, PROJECT_ROUTES.remove)),
    setProjectProfile: (name, profile) =>
      post<ProjectControlResult>(projectRoute(name, PROJECT_ROUTES.profile), { profile }),
    project: projectClient,
  };
}
