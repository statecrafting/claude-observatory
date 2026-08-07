// The economics read and the arithmetic the panel renders it with (spec 038).
//
// The route suffix is re-declared here rather than imported (D-2). Spec 030
// owns `ECONOMICS_ROUTE`, but the module that exports it folds journals and so
// reaches for `fs`, which makes it not a browser module; store.ts's
// `eventBelongsToProject` carries the same note for the same reason. The two
// must agree, and a test pins the agreement.
//
// The reader is this app's half of 030 D-7. api-client.ts belongs to specs
// 022/027 and is outside this spec's territory, so the one route is fetched
// directly, under exactly the discipline the typed client applies everywhere
// else: the path is built by the shared `projectRoute` helper rather than
// spelled a second time, transport failure answers in the envelope as
// `unreachable` rather than throwing, and an answer that is not an envelope is
// `malformed-response` rather than a shape coerced into looking served.
//
// Everything below the reader is pure and has no opinion the envelope does not
// carry (B-2): it sorts, it formats, and where a value is null it says so.
import { API_VERSION, API_VERSION_HEADER, projectRoute } from "./api";
import type { ApiResponse, FetchLike } from "./api";
import type { SpecEconomics } from "../../src/orchestrator/economics";
import type { ServedEconomicsView } from "../../src/orchestrator/api/state";

export type { EconomicsTotals, RunEconomics, SpecEconomics } from "../../src/orchestrator/economics";
export type { ServedEconomicsView } from "../../src/orchestrator/api/state";

// Must equal spec 030's own ECONOMICS_ROUTE; economics.test.tsx pins it.
export const ECONOMICS_ROUTE = "economics";

export function economicsPath(project: string): string {
  return projectRoute(project, ECONOMICS_ROUTE);
}

export type EconomicsReader = (project: string) => Promise<ApiResponse<ServedEconomicsView>>;

export function economicsReader(baseUrl: string, doFetch?: FetchLike): EconomicsReader {
  const root = baseUrl.replace(/\/+$/, "");
  const request: FetchLike = doFetch ?? ((input, init) => fetch(input, init));

  return async (project: string): Promise<ApiResponse<ServedEconomicsView>> => {
    const url = `${root}${economicsPath(project)}`;
    let text: string;
    try {
      const response = await request(url, { headers: { [API_VERSION_HEADER]: String(API_VERSION) } });
      text = await response.text();
    } catch (err) {
      return { ok: false, error: { kind: "unreachable", message: `${url}: ${(err as Error).message}` } };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { ok?: unknown }).ok === "boolean") {
        return parsed as ApiResponse<ServedEconomicsView>;
      }
    } catch {
      // not JSON; reported below
    }
    return { ok: false, error: { kind: "malformed-response", message: `${url}: response body is not an {ok, ...} envelope` } };
  };
}

// --- rendering arithmetic (B-1, B-2) ----------------------------------------

// Micro-USD to dollars at four decimals, the same resolution the CLI prints
// (030 B-4): the journal's unit is exact integers, and $0.0001 keeps a cheap
// session from rendering as a bare $0.00.
export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1e6).toFixed(4)}`;
}

// B-2's denominator, in words: how many sessions the number was summed over,
// and how many of them reported nothing. Both halves are always said, so a
// cost is never read as covering more sessions than it does.
export function denominator(sessions: number, costUnknownSessions: number): string {
  const counted = `${sessions} ${sessions === 1 ? "session" : "sessions"}`;
  if (sessions === 0) return `${counted}, so nothing has been reported`;
  if (costUnknownSessions === 0) return `${counted}, all reporting cost`;
  return `${counted}, ${costUnknownSessions} with no reported cost`;
}

// B-1's order. A spec whose cost is entirely unreported has no known cost to
// rank, so it sorts below every spec that has one rather than being treated as
// a zero (D-4); spec id breaks every tie, so the table has one stable order
// whatever the journal's creation order was.
export function specsByKnownCost(specs: readonly SpecEconomics[]): readonly SpecEconomics[] {
  return [...specs].sort((a, b) => {
    if (a.costMicroUsd !== b.costMicroUsd) {
      if (a.costMicroUsd === null) return 1;
      if (b.costMicroUsd === null) return -1;
      return b.costMicroUsd - a.costMicroUsd;
    }
    return a.specId.localeCompare(b.specId);
  });
}
