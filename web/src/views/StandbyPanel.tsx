// The fleet view (spec 029 B-1, B-2, B-3): every registered project, what the
// daemon is doing about each one, and the registry controls that change that.
//
// This is the view spec 010 A-1 is really about. A daemon whose backlog is
// finished used to be indistinguishable from a daemon that had died, so the
// first thing this panel says is what the daemon is doing (standby, driving,
// parked), and the second is, per project, whether there is work and why it is
// or is not being taken. "Nothing pending" is written out as a fact. An empty
// registry is written out as a fact. Neither is allowed to render as a panel
// that merely looks empty.
//
// Every row is one project's own reads: the registry row from
// `GET /api/projects`, the backlog from that project's own scoped DAG route.
// Nothing here is folded across projects, because there is no such fact: the
// two genuinely global ones (the flight slot and the account's quota) are
// rendered once, by the shell's banner (B-4).
import { useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ApiError, ApiMeta, DagView, ProjectView, ProjectsView } from "../api";
import type { Resource } from "../store";
import { explainScheduling, summarizeBacklog, type BacklogState, type BacklogSummary } from "../backlog";
import { formatAgo, formatCount, formatTimestamp } from "../format";
import { Badge, Empty, ErrorNote, Field, Panel, Unknown } from "../components/bits";
import { RegistryControlButton } from "../components/RegistryControlButton";

export interface StandbyPanelProps {
  readonly meta: ApiMeta | null;
  readonly projects: ProjectsView | null;
  readonly projectsError: ApiError | null;
  // One fold per project (029 B-2), read on demand; a project missing from the
  // map has not been folded, which its row says rather than implying an empty
  // backlog.
  readonly backlogs: ReadonlyMap<string, Resource<DagView>>;
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
  readonly client: ApiClient;
  // Refold the registry and everything read through it, after a control.
  readonly onApplied: () => void;
  // Refold every project's backlog, on demand.
  readonly onRefoldBacklogs: () => void;
  readonly controlsAvailable?: boolean;
  readonly stale?: boolean;
  readonly nowMs: number;
}

export function StandbyPanel({
  meta,
  projects,
  projectsError,
  backlogs,
  selected,
  onSelect,
  client,
  onApplied,
  onRefoldBacklogs,
  controlsAvailable = true,
  stale = false,
  nowMs,
}: StandbyPanelProps): ReactNode {
  const rows = projects?.projects ?? [];

  return (
    <Panel
      title="Standby"
      stale={stale}
      actions={
        <button type="button" onClick={onRefoldBacklogs} data-testid="standby-refold">
          refold backlogs
        </button>
      }
      note={
        <>
          Each backlog below is that project&apos;s own <code>dag</code> route, folded when this view asked rather than
          on every event: a fold runs <code>spec-spine</code> inside the target. Every row carries the moment its fold
          was confirmed.
        </>
      }
    >
      <DaemonState meta={meta} nowMs={nowMs} />

      <ErrorNote error={projectsError} />

      {projects === null ? (
        <Empty>The registry has not been read yet, so no project can be listed.</Empty>
      ) : rows.length === 0 ? (
        <Empty testId="standby-empty-registry">
          No project is registered. The daemon is up and has nothing to drive; registering a target below is what gives
          it something.
        </Empty>
      ) : (
        <ol className="project-list" data-testid="standby-projects">
          {rows.map((project) => (
            <ProjectRow
              key={project.name}
              project={project}
              backlog={backlogs.get(project.name) ?? null}
              meta={meta}
              selected={project.name === selected}
              onSelect={onSelect}
              client={client}
              onApplied={onApplied}
              controlsAvailable={controlsAvailable}
              nowMs={nowMs}
            />
          ))}
        </ol>
      )}

      {controlsAvailable ? <RegisterForm client={client} onApplied={onApplied} /> : null}
    </Panel>
  );
}

// What the daemon itself is doing, always on screen (B-2). The flight slot is
// named here as well as in the shell's banner because this is the view where
// "driving" and "standby" have to be told apart at a glance.
function DaemonState({ meta, nowMs }: { meta: ApiMeta | null; nowMs: number }): ReactNode {
  const daemon = meta?.daemon ?? null;

  return (
    <div className="run-grid" data-testid="standby-daemon">
      <Field label="daemon">
        {meta === null ? (
          <Unknown why="no /api/meta answer has been folded yet" />
        ) : daemon === null ? (
          <Badge tone="neutral" title="no scheduler is attached to this server; it is serving journals read-only">
            no scheduler attached
          </Badge>
        ) : (
          <Badge tone={daemon.state === "driving" ? "good" : daemon.state === "parked" ? "warn" : "neutral"}>
            {daemon.state}
          </Badge>
        )}
      </Field>

      <Field label="flight slot">
        {daemon === null ? (
          <Unknown why="there is no scheduler to hold a flight slot" />
        ) : daemon.activeProject === null ? (
          <span className="muted">free: no project is being driven right now</span>
        ) : (
          <code>{daemon.activeProject}</code>
        )}
      </Field>

      <Field label="scan interval">
        {daemon?.scanIntervalMs == null ? (
          <Unknown why="the daemon serves no scan interval" />
        ) : (
          `${Math.round(daemon.scanIntervalMs / 1000)}s`
        )}
      </Field>

      <Field label="last scan">
        {daemon?.lastScanMs == null ? (
          <Unknown why="the scheduler has not completed a scan yet" />
        ) : (
          formatAgo(daemon.lastScanMs, nowMs)
        )}
      </Field>
    </div>
  );
}

function backlogTone(state: BacklogState): "good" | "warn" | "bad" | "neutral" {
  if (state === "complete") return "good";
  if (state === "ready") return "warn";
  if (state === "unknown") return "neutral";
  return "bad";
}

// One project: who it is, what the daemon will do about it, and the four
// registry verbs (B-1, B-2, B-3) in one place.
function ProjectRow({
  project,
  backlog,
  meta,
  selected,
  onSelect,
  client,
  onApplied,
  controlsAvailable,
  nowMs,
}: {
  project: ProjectView;
  backlog: Resource<DagView> | null;
  meta: ApiMeta | null;
  selected: boolean;
  onSelect: (name: string) => void;
  client: ApiClient;
  onApplied: () => void;
  controlsAvailable: boolean;
  nowMs: number;
}): ReactNode {
  const summary = summarizeBacklog(backlog?.data ?? null);
  const driving = meta?.daemon?.activeProject === project.name;

  return (
    <li className={selected ? "project-row project-row-selected" : "project-row"} data-testid={`project-${project.name}`}>
      <header className="project-row-head">
        <code className="project-name">{project.name}</code>
        {selected ? <Badge tone="info">showing</Badge> : null}
        {driving ? <Badge tone="good">flight slot</Badge> : null}
        <Badge tone={project.armed ? "good" : "neutral"} title={project.armed ? "the scheduler may drive this target" : "observed and reported, never driven (026 D-2)"}>
          {project.armed ? "armed" : "disarmed"}
        </Badge>
        <Badge tone={project.qualification.qualified ? "good" : "warn"}>
          {project.qualification.qualified ? "qualified" : "unqualified"}
        </Badge>
        <span className="project-repo muted">{project.repoDir}</span>
        {selected ? null : (
          <button type="button" className="project-select" data-testid={`select-${project.name}`} onClick={() => onSelect(project.name)}>
            show
          </button>
        )}
      </header>

      <div className="project-backlog" data-testid={`backlog-${project.name}`}>
        <Badge tone={backlogTone(summary.state)}>{summary.state === "unknown" ? "not folded" : summary.state}</Badge>{" "}
        <span className="project-backlog-headline">{summary.headline}</span>
        <p className="project-backlog-why">{explainScheduling(summary, project, meta)}</p>
        <BacklogDetail summary={summary} backlog={backlog} nowMs={nowMs} />
      </div>

      <div className="project-run" data-testid={`project-run-${project.name}`}>
        <span className="field-label">current run</span>{" "}
        {project.readError !== null ? (
          <span className="error-note">
            <span className="error-kind">state root unreadable</span> {project.readError}
          </span>
        ) : project.run === null ? (
          <span className="muted">no run has ever been created for this project</span>
        ) : (
          <>
            <code>{project.run.id}</code>
            <Badge tone={project.run.status === "running" ? "good" : project.run.status === "failed" ? "bad" : "neutral"}>
              {project.run.status}
            </Badge>
            {project.spec === null ? (
              <span className="muted">no spec execution is current</span>
            ) : (
              <>
                <code>{project.spec.specId}</code>
                <span className="muted">{project.spec.status}</span>
              </>
            )}
            {project.stage === null ? null : (
              <span className="muted">
                stage {project.stage.stage} ({project.stage.status})
              </span>
            )}
          </>
        )}
      </div>

      <Qualification project={project} />

      {controlsAvailable ? (
        <div className="project-controls">
          <RegistryControlButton
            verb={project.armed ? "disarm" : "arm"}
            client={client}
            project={project}
            onApplied={onApplied}
          />
          <RegistryControlButton verb="requalify" client={client} project={project} onApplied={onApplied} />
        </div>
      ) : null}
    </li>
  );
}

// The backlog's own detail: what is ready, or what is refusing. Kept below the
// one-line summary because the summary is what an operator scanning six
// projects reads, and this is what they read once one of them is wrong.
function BacklogDetail({
  summary,
  backlog,
  nowMs,
}: {
  summary: BacklogSummary;
  backlog: Resource<DagView> | null;
  nowMs: number;
}): ReactNode {
  return (
    <>
      {backlog?.error ? <ErrorNote error={backlog.error} /> : null}

      {summary.state === "ready" && summary.nextReady !== null ? (
        <p className="project-backlog-detail">
          next ready <code>{summary.nextReady}</code>, of {formatCount(summary.pending.length, "pending spec")}
        </p>
      ) : null}

      {summary.blockers.length > 0 ? (
        <ul className="blockers">
          {summary.blockers.map((blocker) => (
            <li key={blocker.specId}>
              <code>{blocker.specId}</code>
              <ul>
                {blocker.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {summary.invalidated.length > 0 ? (
        <p className="project-backlog-detail alarm">
          pin drift has invalidated{" "}
          {summary.invalidated.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </p>
      ) : null}

      <p className="project-backlog-detail muted">
        {backlog?.loadedAtMs == null
          ? "this backlog has never been folded"
          : `folded ${formatAgo(backlog.loadedAtMs, nowMs)}`}
      </p>
    </>
  );
}

// 025 B-4's verdict, reasons on demand (029 B-1). The reasons are not rendered
// until they are asked for: a qualified project would otherwise carry five
// green check lines on a view built for scanning many projects at once. They
// are one click away, and the failing ones are what the row's own explanation
// points at.
function Qualification({ project }: { project: ProjectView }): ReactNode {
  const [open, setOpen] = useState(false);
  const { qualification } = project;
  const failed = qualification.checks.filter((check) => !check.ok);

  return (
    <div className="project-qualification">
      <button type="button" className="link-button" data-testid={`qualification-${project.name}`} onClick={() => setOpen(!open)}>
        qualification: {qualification.qualified ? "passed" : `${formatCount(failed.length, "failed check")}`}
        {qualification.warnings.length > 0 ? `, ${formatCount(qualification.warnings.length, "warning")}` : ""}
        {open ? " (hide)" : " (show)"}
      </button>
      {open ? (
        <div data-testid={`qualification-detail-${project.name}`}>
          <p className="muted">
            recorded {formatTimestamp(qualification.checkedAt)}. Requalify runs the probe again and journals a fresh
            verdict.
          </p>
          <ul className="qualification-checks">
            {qualification.checks.map((check) => (
              <li key={check.id}>
                <Badge tone={check.ok ? "good" : "bad"}>{check.id}</Badge> {check.detail}
              </li>
            ))}
          </ul>
          {qualification.warnings.length > 0 ? (
            <ul className="qualification-warnings">
              {qualification.warnings.map((warning) => (
                <li key={warning}>
                  <Badge tone="warn">warning</Badge> {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Registration (B-3). The path is whatever the operator types; the daemon
// resolves it, derives the name when none is given, and runs the qualification
// probe, all of which the confirmation says before anything is sent.
function RegisterForm({ client, onApplied }: { client: ApiClient; onApplied: () => void }): ReactNode {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  return (
    <div className="register-form">
      <span className="field-label">register a target</span>
      <label>
        path
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/absolute/path/to/repo"
          data-testid="register-path"
        />
      </label>
      <label>
        name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="derived from the path"
          data-testid="register-name"
        />
      </label>
      <RegistryControlButton verb="register" client={client} path={path} name={name} onApplied={onApplied} />
    </div>
  );
}
