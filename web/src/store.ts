// The SPA's data layer (spec 024 B-3, B-7).
//
// Two rules shape all of it. First, nothing here derives state from a control
// it just issued or from an event payload: every value on screen comes from a
// read route the daemon answered, so a rendered number is always something
// the journal said, not something this page inferred (B-7, "no optimistic
// UI"). Events are a trigger to refetch and a scrollback, never a source of
// truth. Second, not knowing is a state: a resource that has never loaded is
// `null` rather than an empty object, and a daemon that stopped answering
// sets `reach: "unreachable"` rather than leaving the last good fold on
// screen looking live (AC-2).
//
// v2 adds a third rule (spec 027 B-3): a scoped value is only ever shown under
// the project it was read from. The store holds one selected project, reads
// the four scoped routes through that project's sub-client, and drops those
// folds outright when the selection changes, because carrying one project's
// DAG under another's name is the misstatement of scope v2 exists to prevent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiClient,
  ApiError,
  ApiEventType,
  ApiMeta,
  ApiResponse,
  DagView,
  DecisionQueryParams,
  DecisionsView,
  HistoryView,
  ProjectsView,
  QuotaView,
  RunView,
} from "./api";

// --- resources --------------------------------------------------------------

export interface Resource<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  // When the daemon last confirmed this value. Rendered next to stale data so
  // "as of 40 s ago" is visible rather than implied.
  readonly loadedAtMs: number | null;
}

export function emptyResource<T>(): Resource<T> {
  return { data: null, error: null, loadedAtMs: null };
}

// A failed refetch keeps the last confirmed value and its timestamp, and adds
// the error: dropping the data would hide what was true, and dropping the
// error would make stale data look live. Both are shown.
function settle<T>(previous: Resource<T>, result: { ok: true; data: T } | { ok: false; error: ApiError }, atMs: number): Resource<T> {
  if (result.ok) return { data: result.data, error: null, loadedAtMs: atMs };
  return { data: previous.data, error: result.error, loadedAtMs: previous.loadedAtMs };
}

// --- the event stream -------------------------------------------------------

export const ALL_EVENT_TYPES: readonly ApiEventType[] = [
  "journal",
  "transition",
  "session",
  "quota",
  "control",
  "stage",
  "project",
  "meta",
];

export interface StreamEvent {
  // Local, monotonic, and never reused: the server's own event id restarts at
  // 1 when the daemon restarts, so it is shown but not used as a React key.
  readonly key: number;
  readonly id: number | null;
  // Which project's chain this came off (027 B-4), null for a daemon-scoped
  // event. One stream carries every project, so a tail line that did not name
  // its own project would be unreadable on a multi-project daemon.
  readonly project: string | null;
  readonly type: ApiEventType;
  readonly seq: number | null;
  readonly ts: string | null;
  readonly kind: string;
  readonly data: unknown;
}

export type StreamStatus = "connecting" | "open" | "closed";
export type Reachability = "unknown" | "reachable" | "unreachable";

// B-3's "scrollback-bounded": the tail is a window on the stream, not a
// transcript. The full history lives in the journal, which the read routes
// serve.
export const MAX_SCROLLBACK = 400;

// How often the daemon is probed while nothing is streaming. Cheap (one
// /api/meta) and it is what turns a killed daemon into an explicit
// unreachable state within a few seconds (AC-2).
export const PROBE_INTERVAL_MS = 4000;

// Events arrive in bursts (a session streams many in a row); one refetch per
// burst is enough, and it keeps a busy build from refolding the DAG per line.
export const REFRESH_DEBOUNCE_MS = 400;

// The subset of EventSource this store uses, so tests can drive the stream
// without a browser.
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
}

// --- state ------------------------------------------------------------------

export interface ObservatoryState {
  readonly meta: Resource<ApiMeta>;
  readonly projects: Resource<ProjectsView>;
  // The project every scoped resource below was read from (027 B-3). null
  // before the registry has been folded, and while it is empty: a daemon with
  // no project registered shows no project's DAG rather than some project's.
  readonly project: string | null;
  readonly dag: Resource<DagView>;
  readonly run: Resource<RunView>;
  readonly quota: Resource<QuotaView>;
  readonly history: Resource<HistoryView>;
  readonly decisions: Resource<DecisionsView>;
  readonly events: readonly StreamEvent[];
  readonly stream: StreamStatus;
  readonly reach: Reachability;
  // The last moment any request reached the daemon at all.
  readonly lastContactMs: number | null;
  // The daemon's clock minus this page's, from /api/quota's `nowMs`. The
  // quota countdown is arithmetic on a journaled target, so it has to tick
  // against the daemon's clock rather than the browser's.
  readonly serverSkewMs: number | null;
}

export function initialState(): ObservatoryState {
  return {
    meta: emptyResource<ApiMeta>(),
    projects: emptyResource<ProjectsView>(),
    project: null,
    dag: emptyResource<DagView>(),
    run: emptyResource<RunView>(),
    quota: emptyResource<QuotaView>(),
    history: emptyResource<HistoryView>(),
    decisions: emptyResource<DecisionsView>(),
    events: [],
    stream: "connecting",
    reach: "unknown",
    lastContactMs: null,
    serverSkewMs: null,
  };
}

export interface ObservatoryActions {
  refresh(): Promise<void>;
  // Point every scoped panel at another registered project, then refold.
  selectProject(name: string): Promise<void>;
  searchDecisions(query: DecisionQueryParams): Promise<void>;
  clearEvents(): void;
}

export interface ObservatoryOptions {
  readonly client: ApiClient;
  readonly eventsUrl: string;
  // Absent disables streaming entirely (the store still probes and refetches),
  // which is what the component tests use.
  readonly openStream?: ((url: string) => EventSourceLike) | null;
  readonly probeIntervalMs?: number;
  readonly maxScrollback?: number;
  readonly now?: () => number;
}

// The three scoped reads behind the run, dag, and history panels, taken
// through one project's sub-client so they cannot address two projects
// between them.
type ScopedReads = readonly [ApiResponse<DagView>, ApiResponse<RunView>, ApiResponse<HistoryView>];

function readProject(client: ApiClient, name: string): Promise<ScopedReads> {
  const project = client.project(name);
  return Promise.all([project.dag(), project.run(), project.history()]);
}

// Which project the scoped panels show. A selection the operator made is kept
// for as long as the registry still carries it; past that the daemon's own
// active project wins, because that is the one actually being driven, and past
// that it is the registry's first row, so a single-project daemon needs no
// choosing at all.
export function resolveProject(
  projects: ApiResponse<ProjectsView>,
  meta: ApiResponse<ApiMeta>,
  current: string | null
): string | null {
  // A registry read that failed says nothing about which project is right;
  // swapping the view out on a transient error would be the store inventing a
  // change the daemon never reported.
  if (!projects.ok) return current;
  const names = projects.data.projects.map((project) => project.name);
  if (current !== null && names.includes(current)) return current;
  const active = meta.ok ? meta.data.daemon?.activeProject ?? null : null;
  if (active !== null && names.includes(active)) return active;
  return names[0] ?? null;
}

export function useObservatory(options: ObservatoryOptions): {
  state: ObservatoryState;
  actions: ObservatoryActions;
} {
  const { client, eventsUrl } = options;
  const now = options.now ?? Date.now;
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const maxScrollback = options.maxScrollback ?? MAX_SCROLLBACK;
  const openStream = options.openStream;

  const [state, setState] = useState<ObservatoryState>(initialState);

  const eventKey = useRef(0);
  const reachRef = useRef<Reachability>("unknown");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The selected project lives in a ref as well as in state, so `refresh` keeps
  // one identity across a project switch and the effects below are not torn
  // down and rebuilt every time the operator picks a different project.
  const selection = useRef<string | null>(null);
  // Refreshes overlap routinely: an event burst schedules one while another is
  // still in flight, and picking a project starts one of its own. Only the
  // newest may land, because an older one carries the project that was
  // selected when it started, and writing that back would undo the operator's
  // choice for good rather than for one render: `selection.current` is what
  // every later refresh reads its scope from.
  const generation = useRef(0);

  // The three global routes plus, for the selected project, its own three,
  // refolded together so no two panels can disagree about which moment (or
  // which project) they are showing.
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    const guessed = selection.current;
    const [meta, quota, projects, guessedScoped] = await Promise.all([
      client.meta(),
      client.quota(),
      client.projects(),
      guessed === null ? Promise.resolve(null) : readProject(client, guessed),
    ]);
    if (generation.current !== mine) return;

    // The registry can have moved underneath the selection: a project removed
    // through the CLI, or simply the first fold arriving. When it has, the
    // scoped reads just taken belong to a project this page is no longer
    // showing, so they are dropped and the resolved one is read instead.
    const project = resolveProject(projects, meta, guessed);
    selection.current = project;
    const scoped =
      project === guessed ? guessedScoped : project === null ? null : await readProject(client, project);
    if (generation.current !== mine) return;

    const atMs = now();
    const results = [meta, quota, projects, ...(scoped ?? [])];
    // "Unreachable" is only claimed when nothing got through. A daemon that
    // answered even one route with an error is up and disagreeing, which is a
    // different fact and is shown as that route's error instead.
    const answered = results.some((r) => r.ok || r.error.kind !== "unreachable");
    const reach: Reachability = answered ? "reachable" : "unreachable";
    reachRef.current = reach;

    setState((prev) => {
      // A change of project drops the previous one's folds rather than letting
      // them stand under the new name. Keeping them would be precisely the
      // "this means the one repo" misreading v2 removed from the wire.
      const kept = project === prev.project;
      const before = {
        dag: kept ? prev.dag : emptyResource<DagView>(),
        run: kept ? prev.run : emptyResource<RunView>(),
        history: kept ? prev.history : emptyResource<HistoryView>(),
        decisions: kept ? prev.decisions : emptyResource<DecisionsView>(),
      };
      return {
        ...prev,
        meta: settle(prev.meta, meta, atMs),
        quota: settle(prev.quota, quota, atMs),
        projects: settle(prev.projects, projects, atMs),
        project,
        dag: scoped === null ? before.dag : settle(before.dag, scoped[0], atMs),
        run: scoped === null ? before.run : settle(before.run, scoped[1], atMs),
        history: scoped === null ? before.history : settle(before.history, scoped[2], atMs),
        decisions: before.decisions,
        reach,
        lastContactMs: answered ? atMs : prev.lastContactMs,
        serverSkewMs: quota.ok ? quota.data.nowMs - atMs : prev.serverSkewMs,
      };
    });
  }, [client, now]);

  const selectProject = useCallback(
    async (name: string): Promise<void> => {
      selection.current = name;
      await refresh();
    },
    [refresh]
  );

  const searchDecisions = useCallback(
    async (query: DecisionQueryParams): Promise<void> => {
      const name = selection.current;
      // The ledger belongs to a project (027 B-3). With none selected there is
      // no ledger to query, which is said outright rather than answered with an
      // empty result set that would read as "this project has no decisions".
      const result: ApiResponse<DecisionsView> =
        name === null
          ? {
              ok: false,
              error: { kind: "unavailable", message: "no project is selected, so there is no decision ledger to query" },
            }
          : await client.project(name).decisions(query);
      const atMs = now();
      setState((prev) => ({ ...prev, decisions: settle(prev.decisions, result, atMs) }));
    },
    [client, now]
  );

  const clearEvents = useCallback((): void => {
    setState((prev) => ({ ...prev, events: [] }));
  }, []);

  const scheduleRefresh = useCallback((): void => {
    if (debounce.current !== null) return;
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  // Mount: one full read, then a cheap liveness probe on a fixed cadence. The
  // probe is what makes a killed daemon visible while a view sits idle; when
  // it finds the daemon again it triggers a full refold rather than letting
  // the pre-death values stand.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void (async () => {
        const result = await client.meta();
        const atMs = now();
        const reachable = result.ok || result.error.kind !== "unreachable";
        const recovered = reachable && reachRef.current !== "reachable";
        reachRef.current = reachable ? "reachable" : "unreachable";
        setState((prev) => ({
          ...prev,
          meta: settle(prev.meta, result, atMs),
          reach: reachable ? "reachable" : "unreachable",
          lastContactMs: reachable ? atMs : prev.lastContactMs,
        }));
        if (recovered) await refresh();
      })();
    }, probeIntervalMs);
    return () => clearInterval(timer);
  }, [client, now, probeIntervalMs, refresh]);

  // The stream (B-3). EventSource reconnects on its own and replays with
  // `Last-Event-ID` for free, which is exactly the behaviour spec 022 B-4's
  // ring was built to answer; the only thing to add is a full refold on
  // reconnect, because the ring is bounded and a long outage drops records.
  useEffect(() => {
    if (!openStream) return;
    const source = openStream(eventsUrl);

    const record = (type: ApiEventType) => (event: MessageEvent) => {
      let parsed: { project?: unknown; seq?: unknown; ts?: unknown; kind?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(String(event.data)) as typeof parsed;
      } catch {
        return;
      }
      const id = Number.parseInt(event.lastEventId ?? "", 10);
      const entry: StreamEvent = {
        key: eventKey.current++,
        id: Number.isSafeInteger(id) ? id : null,
        project: typeof parsed.project === "string" ? parsed.project : null,
        type,
        seq: typeof parsed.seq === "number" ? parsed.seq : null,
        ts: typeof parsed.ts === "string" ? parsed.ts : null,
        kind: typeof parsed.kind === "string" ? parsed.kind : "(unnamed)",
        data: parsed.data,
      };
      setState((prev) => {
        const events = [...prev.events, entry];
        return { ...prev, events: events.length > maxScrollback ? events.slice(events.length - maxScrollback) : events };
      });
      scheduleRefresh();
    };

    for (const type of ALL_EVENT_TYPES) source.addEventListener(type, record(type));

    source.onopen = () => {
      setState((prev) => ({ ...prev, stream: "open" }));
      void refresh();
    };
    source.onerror = () => {
      setState((prev) => ({ ...prev, stream: "closed" }));
    };

    return () => {
      source.close();
    };
  }, [eventsUrl, maxScrollback, openStream, refresh, scheduleRefresh]);

  useEffect(
    () => () => {
      if (debounce.current !== null) clearTimeout(debounce.current);
    },
    []
  );

  const actions = useMemo<ObservatoryActions>(
    () => ({ refresh, selectProject, searchDecisions, clearEvents }),
    [refresh, selectProject, searchDecisions, clearEvents]
  );

  return { state, actions };
}
