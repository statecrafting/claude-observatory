// The typed fetch wrapper every client uses (spec 022 FR-002): the CLI
// (spec 023) and the web UI (spec 024) both talk to the daemon through this
// and never hand-build a URL or re-declare a response shape.
//
// "Generated" in the sense that matters: nothing here is a second copy of
// the contract. The paths come from API_ROUTES and the payload types come
// from types.ts, both shared verbatim with the server, so a route or a shape
// cannot drift between the two halves without failing typecheck.
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
  type ApiErrorKind,
  type ApiMeta,
  type ApiResponse,
  type ControlResult,
  type DagView,
  type DecisionQueryParams,
  type DecisionsView,
  type EvidenceView,
  type HistoryView,
  type QuotaView,
  type RunView,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  // e.g. "http://127.0.0.1:4519"; a trailing slash is tolerated.
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  // Recorded in the journal as the control's source (spec 021 B-4).
  readonly source?: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly eventsUrl: string;
  meta(): Promise<ApiResponse<ApiMeta>>;
  dag(): Promise<ApiResponse<DagView>>;
  run(): Promise<ApiResponse<RunView>>;
  quota(): Promise<ApiResponse<QuotaView>>;
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

  const post = <T>(path: string): Promise<ApiResponse<T>> => request<T>(path, { method: "POST" });

  function decisionsPath(query: DecisionQueryParams | undefined): string {
    if (!query) return API_ROUTES.decisions;
    const params = new URLSearchParams();
    if (query.query !== undefined) params.set("query", query.query);
    if (query.specId !== undefined) params.set("specId", query.specId);
    if (query.path !== undefined) params.set("path", query.path);
    const encoded = params.toString();
    return encoded.length === 0 ? API_ROUTES.decisions : `${API_ROUTES.decisions}?${encoded}`;
  }

  function specControlPath(specId: string, verb: string): string {
    return `${API_ROUTES.specPrefix}${encodeURIComponent(specId)}/${verb}`;
  }

  return {
    baseUrl,
    eventsUrl: `${baseUrl}${API_ROUTES.events}`,
    meta: () => request<ApiMeta>(API_ROUTES.meta),
    dag: () => request<DagView>(API_ROUTES.dag),
    run: () => request<RunView>(API_ROUTES.run),
    quota: () => request<QuotaView>(API_ROUTES.quota),
    decisions: (query) => request<DecisionsView>(decisionsPath(query)),
    history: () => request<HistoryView>(API_ROUTES.history),
    evidence: (hash) => request<EvidenceView>(`${API_ROUTES.evidencePrefix}${encodeURIComponent(hash)}`),
    evidenceUrl: (hash) => `${baseUrl}${API_ROUTES.evidencePrefix}${encodeURIComponent(hash)}?raw=1`,
    startRun: () => post<ControlResult>(API_ROUTES.runStart),
    pauseRun: () => post<ControlResult>(API_ROUTES.runPause),
    resumeRun: () => post<ControlResult>(API_ROUTES.runResume),
    skipSpec: (specId) => post<ControlResult>(specControlPath(specId, "skip")),
    retryStage: (specId) => post<ControlResult>(specControlPath(specId, "retry-stage")),
    reverify: (specId) => post<ControlResult>(specControlPath(specId, "reverify")),
    forceHumanGate: (specId) => post<ControlResult>(specControlPath(specId, "force-human-gate")),
    approve: (specId) => post<ControlResult>(specControlPath(specId, "approve")),
  };
}
