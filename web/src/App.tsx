// The shell (spec 024 B-1, B-7).
//
// Its one real job beyond routing is the honesty banner. When the daemon
// stops answering, the panels below keep showing the last fold it confirmed,
// because that is genuinely the last thing known to be true; what must not
// happen is for that to look live. So the banner names the state, the panels
// are marked stale, and every panel already carries the moment its data was
// confirmed. That is AC-2's "explicit daemon unreachable state, not a
// stale-but-live-looking dashboard".
//
// v2 adds the project picker (spec 027 B-3). One daemon answers for many
// projects, so the shell has to name which one the panels below are showing;
// the scoped sub-client is built from that selection and handed down, which is
// what stops any panel from addressing a project the header does not name.
//
// Spec 029 adds the second banner and the sixth view. The banner carries the
// two facts that are the account's rather than a project's (B-4): the flight
// slot and the quota pool. Rendering either inside a project's panel would say
// they were that project's, which is exactly the misstatement v2 removed from
// the wire, so they are rendered once, here, above everything scoped. The view
// is standby (B-2), and it is where the app opens: on a daemon with several
// targets, "what is being driven, and what is waiting" comes before any one
// project's DAG.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ApiMeta, DecisionQueryParams, ProjectView, QuotaView } from "./api";
import { useObservatory } from "./store";
import type { EventSourceLike } from "./store";
import { countdownMs, formatAgo, formatCount, formatDuration, formatTimestamp } from "./format";
import { Badge } from "./components/bits";
import { StandbyPanel } from "./views/StandbyPanel";
import { DagPanel } from "./views/DagPanel";
import { RunPanel } from "./views/RunPanel";
import { QuotaPanel } from "./views/QuotaPanel";
import { DecisionsPanel } from "./views/DecisionsPanel";
import { HistoryPanel } from "./views/HistoryPanel";

const VIEWS = ["standby", "run", "dag", "quota", "decisions", "history"] as const;
export type ViewName = (typeof VIEWS)[number];

function viewFromHash(hash: string): ViewName {
  const candidate = hash.replace(/^#\/?/, "");
  return (VIEWS as readonly string[]).includes(candidate) ? (candidate as ViewName) : "standby";
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
    // The stream is subscribed unfiltered (029 D-2): it is this page's refetch
    // trigger for every project's row, not only the selected one's tail.
    client,
    eventsUrl: eventsUrl ?? client.eventsUrl(),
    ...(openStream === undefined ? {} : { openStream }),
  });
  const now = useNow();

  const [view, setView] = useState<ViewName>(() =>
    typeof window === "undefined" ? "standby" : viewFromHash(window.location.hash)
  );
  useEffect(() => {
    const onHashChange = (): void => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const projects = state.projects.data?.projects ?? [];
  // The registry's names, as one value an effect can depend on: a refold of the
  // same names must not re-trigger the backlog reads that produced it.
  const registeredNames = projects.map((project) => project.name).join("\n");

  const refreshBacklogs = useCallback((): void => {
    void actions.refreshBacklogs();
  }, [actions]);

  const refresh = useCallback((): void => {
    void actions.refresh();
    // The fleet view's own reads are on demand (029 D-1), so a refetch while it
    // is open has to ask for them too, or the button would refresh everything
    // except the thing on screen.
    if (view === "standby") void actions.refreshBacklogs();
  }, [actions, view]);

  // Fold every project's backlog when the standby view is what is open, and
  // again when the registry itself changes underneath it.
  useEffect(() => {
    if (view !== "standby" || registeredNames.length === 0) return;
    void actions.refreshBacklogs();
  }, [actions, registeredNames, view]);

  const search = useCallback(
    (query: DecisionQueryParams): void => {
      void actions.searchDecisions(query);
    },
    [actions]
  );

  const selectProject = useCallback(
    (name: string): void => {
      void actions.selectProject(name);
    },
    [actions]
  );

  const stale = state.reach !== "reachable";
  const controlsAvailable = state.meta.data?.controlsAvailable ?? true;

  // Every scoped panel talks to one project or to none (027 B-5). Building the
  // sub-client here, from the one selection the header renders, is what makes
  // that structural rather than a convention each panel has to keep.
  const projectClient = useMemo(
    () => (state.project === null ? null : client.project(state.project)),
    [client, state.project]
  );

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
          <ProjectPicker
            projects={projects}
            selected={state.project}
            onSelect={selectProject}
            loaded={state.projects.data !== null}
          />
          {state.meta.data === null ? null : (
            <>
              <Badge tone="neutral" title="the wire contract this daemon serves">
                api v{state.meta.data.apiVersion}
              </Badge>
              {state.meta.data.daemon === null ? null : (
                <Badge
                  tone={state.meta.data.daemon.state === "standby" ? "neutral" : "good"}
                  title="what the daemon itself is doing, across every project"
                >
                  daemon {state.meta.data.daemon.state}
                </Badge>
              )}
              {state.meta.data.loopbackOnly ? <Badge tone="neutral">loopback only</Badge> : null}
              {controlsAvailable ? null : <Badge tone="warn">read-only daemon</Badge>}
            </>
          )}
          <button type="button" className="refresh" onClick={refresh} data-testid="refresh">
            refetch
          </button>
        </div>
      </header>

      <GlobalBanner meta={state.meta.data} quota={state.quota.data} nowMs={now} serverSkewMs={state.serverSkewMs} />

      <ConnectionBanner
        reach={state.reach}
        baseUrl={client.baseUrl}
        lastContactMs={state.lastContactMs}
        nowMs={now}
      />

      <main className="app-main">
        {view === "standby" ? (
          <StandbyPanel
            meta={state.meta.data}
            projects={state.projects.data}
            projectsError={state.projects.error}
            backlogs={state.backlogs}
            selected={state.project}
            onSelect={selectProject}
            client={client}
            onApplied={refresh}
            onRefoldBacklogs={refreshBacklogs}
            controlsAvailable={controlsAvailable}
            stale={stale}
            nowMs={now}
          />
        ) : null}

        {view === "run" ? (
          <RunPanel
            run={state.run.data}
            error={state.run.error}
            events={state.events}
            stream={state.stream}
            nowMs={now}
            project={state.project}
            client={projectClient}
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
            client={projectClient}
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
          <DecisionsPanel
            decisions={state.decisions.data}
            error={state.decisions.error}
            project={state.project}
            onSearch={search}
            stale={stale}
          />
        ) : null}

        {view === "history" ? (
          <HistoryPanel history={state.history.data} error={state.history.error} client={projectClient} stale={stale} />
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
    case "standby":
      // The fleet view is the registry plus a fold per project; the registry is
      // the one moment that covers the rows themselves, and each row carries
      // its own backlog's timestamp.
      return state.projects.loadedAtMs;
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

// Which project the scoped panels are showing, and the means to change it.
// It renders as an explicit unknown in the two cases that are not a project:
// a registry that has not been folded yet, and one that is genuinely empty.
// Neither is allowed to look like a project named nothing.
function ProjectPicker({
  projects,
  selected,
  onSelect,
  loaded,
}: {
  projects: readonly ProjectView[];
  selected: string | null;
  onSelect: (name: string) => void;
  loaded: boolean;
}): ReactNode {
  if (!loaded) {
    return (
      <span className="project-picker muted" data-testid="project-picker">
        no registry read yet
      </span>
    );
  }
  if (projects.length === 0) {
    return (
      <span className="project-picker muted" data-testid="project-picker">
        no project is registered
      </span>
    );
  }

  return (
    <label className="project-picker" data-testid="project-picker">
      <span className="field-label">project</span>
      <select
        value={selected ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        data-testid="project-select"
      >
        {projects.map((project) => (
          <option key={project.name} value={project.name}>
            {/* 025 B-4's verdict travels with the name: a project the daemon
                will not drive should not read as one it will. */}
            {project.name}
            {project.qualification.qualified ? "" : " (unqualified)"}
            {project.armed ? "" : " (disarmed)"}
          </option>
        ))}
      </select>
    </label>
  );
}

// The two facts that belong to the account rather than to a project (spec 029
// B-4), rendered once and never inside a project's panel.
//
// The flight slot is one globally (010 D15): naming its holder next to the
// quota pool is what makes "parked" legible, because a parked slot is held, not
// idle. The quota is one pool for the account (026 B-5), so a countdown shown
// under a project would read as that project's wait when it is every project's.
// The `estimated` flag travels with the horizon for the same reason it does in
// the quota panel: an inferred reset is not a reported one.
function GlobalBanner({
  meta,
  quota,
  nowMs,
  serverSkewMs,
}: {
  meta: ApiMeta | null;
  quota: QuotaView | null;
  nowMs: number;
  serverSkewMs: number | null;
}): ReactNode {
  const daemon = meta?.daemon ?? null;
  const remaining = quota === null ? null : countdownMs(quota.targetMs, nowMs, serverSkewMs);

  return (
    <div className="global-banner" data-testid="global-banner">
      <span className="global-banner-label">daemon</span>
      {meta === null ? (
        <span className="muted">not yet read</span>
      ) : daemon === null ? (
        <Badge tone="neutral" title="no scheduler is attached; this server serves journals read-only">
          no scheduler attached
        </Badge>
      ) : (
        <>
          <Badge tone={daemon.state === "driving" ? "good" : daemon.state === "parked" ? "warn" : "neutral"}>
            {daemon.state}
          </Badge>
          <span className="global-banner-item">
            flight slot{" "}
            {daemon.activeProject === null ? (
              <span className="muted">free</span>
            ) : (
              <code>{daemon.activeProject}</code>
            )}
          </span>
        </>
      )}

      <span className="global-banner-label">account quota</span>
      {quota === null ? (
        <span className="muted">not yet read</span>
      ) : !quota.parked ? (
        <Badge tone="good">not parked</Badge>
      ) : (
        <>
          <Badge tone="warn">parked</Badge>
          <span className="global-banner-item" data-testid="global-quota">
            {remaining === null
              ? "no horizon has been journaled"
              : remaining > 0
                ? `${formatDuration(remaining)} to reset`
                : `target passed ${formatDuration(-remaining)} ago`}
            {quota.estimated === true ? " (estimated)" : quota.estimated === false ? " (reported)" : ""}
            {quota.project === null ? "" : `, hit by ${quota.project}`}
          </span>
        </>
      )}
      {quota !== null && quota.warn ? (
        <Badge tone="bad" title="consecutive quota parks have crossed the warning threshold">
          {formatCount(quota.consecutiveQuotaParks, "park")} in a row
        </Badge>
      ) : null}
      <span className="global-banner-scope muted">account-wide, not this project&apos;s</span>
    </div>
  );
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
