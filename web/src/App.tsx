// The shell (spec 024 B-1, B-7).
//
// Its one real job beyond routing is the honesty banner. When the daemon
// stops answering, the panels below keep showing the last fold it confirmed,
// because that is genuinely the last thing known to be true; what must not
// happen is for that to look live. So the banner names the state, the panels
// are marked stale, and every panel already carries the moment its data was
// confirmed. That is AC-2's "explicit daemon unreachable state, not a
// stale-but-live-looking dashboard".
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, DecisionQueryParams } from "./api";
import { eventsUrl as defaultEventsUrl } from "./api";
import { useObservatory } from "./store";
import type { EventSourceLike } from "./store";
import { formatAgo, formatTimestamp } from "./format";
import { Badge } from "./components/bits";
import { DagPanel } from "./views/DagPanel";
import { RunPanel } from "./views/RunPanel";
import { QuotaPanel } from "./views/QuotaPanel";
import { DecisionsPanel } from "./views/DecisionsPanel";
import { HistoryPanel } from "./views/HistoryPanel";

const VIEWS = ["run", "dag", "quota", "decisions", "history"] as const;
export type ViewName = (typeof VIEWS)[number];

function viewFromHash(hash: string): ViewName {
  const candidate = hash.replace(/^#\/?/, "");
  return (VIEWS as readonly string[]).includes(candidate) ? (candidate as ViewName) : "run";
}

// A ticking clock for elapsed values. It measures real elapsed time against
// journaled timestamps, which is not the same thing as a spinner: when
// nothing is known the fields it feeds render as unknown regardless.
function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface AppProps {
  readonly client: ApiClient;
  readonly eventsUrl?: string;
  readonly openStream?: ((url: string) => EventSourceLike) | null;
}

export function App({ client, eventsUrl, openStream }: AppProps): ReactNode {
  const { state, actions } = useObservatory({
    client,
    eventsUrl: eventsUrl ?? defaultEventsUrl(),
    ...(openStream === undefined ? {} : { openStream }),
  });
  const now = useNow();

  const [view, setView] = useState<ViewName>(() =>
    typeof window === "undefined" ? "run" : viewFromHash(window.location.hash)
  );
  useEffect(() => {
    const onHashChange = (): void => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const refresh = useCallback((): void => {
    void actions.refresh();
  }, [actions]);

  const search = useCallback(
    (query: DecisionQueryParams): void => {
      void actions.searchDecisions(query);
    },
    [actions]
  );

  const stale = state.reach !== "reachable";
  const controlsAvailable = state.meta.data?.controlsAvailable ?? true;

  return (
    <div className="app">
      <header className="app-head">
        <h1>claude-observatory</h1>
        <nav className="app-nav">
          {VIEWS.map((name) => (
            <a
              key={name}
              href={`#/${name}`}
              className={name === view ? "nav-link nav-link-active" : "nav-link"}
              data-testid={`nav-${name}`}
            >
              {name}
            </a>
          ))}
        </nav>
        <div className="app-meta">
          {state.meta.data === null ? null : (
            <>
              <Badge tone="neutral" title="the wire contract this daemon serves">
                api v{state.meta.data.apiVersion}
              </Badge>
              {state.meta.data.loopbackOnly ? <Badge tone="neutral">loopback only</Badge> : null}
              {controlsAvailable ? null : <Badge tone="warn">read-only daemon</Badge>}
            </>
          )}
          <button type="button" className="refresh" onClick={refresh} data-testid="refresh">
            refetch
          </button>
        </div>
      </header>

      <ConnectionBanner
        reach={state.reach}
        baseUrl={client.baseUrl}
        lastContactMs={state.lastContactMs}
        nowMs={now}
      />

      <main className="app-main">
        {view === "run" ? (
          <RunPanel
            run={state.run.data}
            error={state.run.error}
            events={state.events}
            stream={state.stream}
            nowMs={now}
            client={client}
            stale={stale}
            onApplied={refresh}
            onClearEvents={actions.clearEvents}
            controlsAvailable={controlsAvailable}
          />
        ) : null}

        {view === "dag" ? (
          <DagPanel
            dag={state.dag.data}
            error={state.dag.error}
            client={client}
            run={state.run.data}
            stale={stale}
            onApplied={refresh}
            controlsAvailable={controlsAvailable}
          />
        ) : null}

        {view === "quota" ? (
          <QuotaPanel
            quota={state.quota.data}
            error={state.quota.error}
            nowMs={now}
            serverSkewMs={state.serverSkewMs}
            stale={stale}
          />
        ) : null}

        {view === "decisions" ? (
          <DecisionsPanel decisions={state.decisions.data} error={state.decisions.error} onSearch={search} stale={stale} />
        ) : null}

        {view === "history" ? (
          <HistoryPanel history={state.history.data} error={state.history.error} client={client} stale={stale} />
        ) : null}
      </main>

      <footer className="app-foot">
        <span>
          {view} confirmed{" "}
          {resourceLoadedAt(state, view) === null ? "never" : formatTimestamp(new Date(resourceLoadedAt(state, view)!).toISOString())}
        </span>
      </footer>
    </div>
  );
}

function resourceLoadedAt(state: ReturnType<typeof useObservatory>["state"], view: ViewName): number | null {
  switch (view) {
    case "run":
      return state.run.loadedAtMs;
    case "dag":
      return state.dag.loadedAtMs;
    case "quota":
      return state.quota.loadedAtMs;
    case "decisions":
      return state.decisions.loadedAtMs;
    case "history":
      return state.history.loadedAtMs;
  }
}

function ConnectionBanner({
  reach,
  baseUrl,
  lastContactMs,
  nowMs,
}: {
  reach: "unknown" | "reachable" | "unreachable";
  baseUrl: string;
  lastContactMs: number | null;
  nowMs: number;
}): ReactNode {
  if (reach === "reachable") return null;

  if (reach === "unknown") {
    return (
      <div className="banner banner-unknown" role="status" data-testid="connection-banner">
        No answer from <code>{baseUrl}</code> yet. Nothing below has been confirmed.
      </div>
    );
  }

  return (
    <div className="banner banner-unreachable" role="alert" data-testid="connection-banner">
      <strong>daemon unreachable</strong> at <code>{baseUrl}</code>. Everything below is the last fold the daemon
      confirmed, {formatAgo(lastContactMs, nowMs)}, and is not live.
    </div>
  );
}
