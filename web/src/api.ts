// The SPA's one seam onto the daemon (spec 024 B-1).
//
// Every shape and every path comes from the API territory itself
// (src/orchestrator/api), never from a second copy declared here: spec 022
// D-8 made api-client.ts route-table driven precisely so a client cannot
// drift from the server without failing typecheck, and this app is one of the
// two clients that promise buys. Only `types.ts` and `api-client.ts` are
// imported, and both are pure of Node built-ins, so the bundle stays a
// browser bundle.
export {
  API_ROUTES,
  API_VERSION,
  SPEC_CONTROL_VERBS,
} from "../../src/orchestrator/api/types";

export type {
  ApiError,
  ApiErrorKind,
  ApiEvent,
  ApiEventType,
  ApiJournalRecord,
  ApiMeta,
  ApiResponse,
  ControlResult,
  ControlVerbToken,
  DagSpecNode,
  DagView,
  DecisionQueryParams,
  DecisionsView,
  EvidenceView,
  HistoryEntry,
  HistoryView,
  QuotaView,
  RunView,
  SpecBlockerView,
  SpecControlVerb,
} from "../../src/orchestrator/api/types";

export { createApiClient } from "../../src/orchestrator/api/api-client";
export type { ApiClient } from "../../src/orchestrator/api/api-client";

import { createApiClient } from "../../src/orchestrator/api/api-client";
import type { ApiClient } from "../../src/orchestrator/api/api-client";
import { API_ROUTES } from "../../src/orchestrator/api/types";

// What the daemon records as the `source` of every control this UI issues
// (spec 021 B-4). It is also what the confirmation dialog previews, so the
// record shown before a click is the record written after it.
export const WEB_UI_CONTROL_SOURCE = "web-ui";

// Same-origin, always: the base url is wherever this page was served from, so
// there is no configuration to get wrong and no second origin to trust.
export function browserClient(origin: string = window.location.origin): ApiClient {
  return createApiClient({ baseUrl: origin, source: WEB_UI_CONTROL_SOURCE });
}

export function eventsUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, "")}${API_ROUTES.events}`;
}
