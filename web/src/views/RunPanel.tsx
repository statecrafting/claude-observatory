// The live run view (spec 024 B-3): what the daemon is doing right now, and
// the stream it is saying it on.
//
// Elapsed times are the delicate part. The run has a journaled `createdTs`,
// so its elapsed time is arithmetic. A stage does not: /api/run serves a
// stage's id, attempt, and status but no start time, so this view will only
// claim a stage elapsed once it has seen that stage's own transition on the
// stream, and otherwise says it does not know (B-7). Inventing one from the
// page's own first render would be a number that looks journaled and is not.
import { useState } from "react";
import type { ReactNode } from "react";
import type { ApiError, ApiEventType, ProjectClient, RunView } from "../api";
import type { StreamEvent, StreamStatus } from "../store";
import { ALL_EVENT_TYPES, eventBelongsToProject } from "../store";
import { formatDuration, formatElapsed, formatTimestamp, parseTimestamp, shortHash, summarizePayload, UNKNOWN } from "../format";
import { Badge, Empty, ErrorNote, Field, Panel, Unknown } from "../components/bits";
import { ControlButton } from "../components/ControlButton";

export interface RunPanelProps {
  readonly run: RunView | null;
  readonly error: ApiError | null;
  readonly events: readonly StreamEvent[];
  readonly stream: StreamStatus;
  readonly nowMs: number;
  // Which project this panel is showing, so the tail carries that project's
  // lines rather than every project's (spec 029 B-5).
  readonly project: string | null;
  readonly client: ProjectClient | null;
  readonly stale?: boolean;
  readonly onApplied?: () => void;
  readonly onClearEvents?: () => void;
  readonly controlsAvailable?: boolean;
}

// The newest transition this stream has carried for a given stage execution,
// which is the only stage start time available to a client.
function stageSinceMs(events: readonly StreamEvent[], stageExecId: string | null): number | null {
  if (stageExecId === null) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.kind !== "state.transition.outcome") continue;
    const payload = event.data;
    if (typeof payload !== "object" || payload === null) continue;
    const shaped = payload as { entity?: unknown; id?: unknown };
    if (shaped.entity !== "stageExec" || shaped.id !== stageExecId) continue;
    return parseTimestamp(event.ts);
  }
  return null;
}

export function RunPanel({
  run,
  error,
  events,
  stream,
  nowMs,
  project,
  client,
  stale = false,
  onApplied,
  onClearEvents,
  controlsAvailable = true,
}: RunPanelProps): ReactNode {
  const summary = run?.run ?? null;
  const stageStarted = stageSinceMs(events, run?.stage?.id ?? null);

  return (
    <Panel
      title="Run"
      stale={stale}
      actions={
        controlsAvailable ? (
          <>
            <ControlButton verb="start" client={client} run={run} {...(onApplied ? { onApplied } : {})} />
            <ControlButton verb="pause" client={client} run={run} {...(onApplied ? { onApplied } : {})} />
            <ControlButton verb="resume" client={client} run={run} {...(onApplied ? { onApplied } : {})} />
          </>
        ) : (
          <Badge tone="neutral">this daemon serves no controls</Badge>
        )
      }
    >
      <ErrorNote error={error} />

      {summary === null ? (
        <Empty>No run exists in the journal yet.</Empty>
      ) : (
        <div className="run-grid">
          <Field label="run">
            <code>{summary.id}</code>
          </Field>
          <Field label="status">
            <Badge tone={summary.status === "running" ? "good" : summary.status === "failed" ? "bad" : "warn"}>
              {summary.status}
            </Badge>
            {summary.needsReconcile ? <Badge tone="warn">needs reconcile</Badge> : null}
          </Field>
          <Field label="target repo">
            <code>{summary.targetRepo}</code>
          </Field>
          <Field label="started">{formatTimestamp(summary.createdTs)}</Field>
          <Field label="run elapsed">{formatElapsed(parseTimestamp(summary.createdTs), nowMs)}</Field>
          <Field label="last heartbeat">
            {run?.lastHeartbeatMs == null ? (
              <Unknown why="no daemon.heartbeat record has been journaled" />
            ) : (
              `${formatDuration(nowMs - run.lastHeartbeatMs)} ago`
            )}
          </Field>
        </div>
      )}

      {run?.pauseReason ? (
        <p className="run-pause-reason" data-testid="run-pause-reason">
          <Badge tone="warn">paused</Badge> {run.pauseReason}
        </p>
      ) : null}

      {run !== null && run.awaitingApproval.length > 0 ? (
        <p className="run-awaiting" data-testid="run-awaiting-approval">
          <Badge tone="warn">awaiting approval</Badge>{" "}
          {run.awaitingApproval.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </p>
      ) : null}

      {run !== null && run.blockers.length > 0 ? (
        <div className="run-blockers" data-testid="run-blockers">
          <span className="field-label">the loop reported these blockers</span>
          <ul className="blockers">
            {run.blockers.map((blocker) => (
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
        </div>
      ) : null}

      <div className="run-grid">
        <Field label="spec">
          {run?.spec == null ? <Unknown why="no spec execution is current in this run" /> : <code>{run.spec.specId}</code>}
        </Field>
        <Field label="spec status">{run?.spec?.status ?? UNKNOWN}</Field>
        <Field label="attempt">{run?.spec == null ? UNKNOWN : run.spec.attempt}</Field>
        <Field label="pin">
          {run?.spec == null ? <Unknown /> : <code title={run.spec.pin}>{shortHash(run.spec.pin)}</code>}
        </Field>
        <Field label="stage">{run?.stage == null ? <Unknown why="no stage execution is current" /> : run.stage.stage}</Field>
        <Field label="stage status">{run?.stage?.status ?? UNKNOWN}</Field>
        <Field label="stage attempt">{run?.stage == null ? UNKNOWN : run.stage.attempt}</Field>
        <Field label="stage elapsed">
          {stageStarted === null ? (
            <Unknown why="/api/run serves no stage start time; this page has not observed a transition for this stage on the stream" />
          ) : (
            formatDuration(nowMs - stageStarted)
          )}
        </Field>
      </div>

      <LiveTail events={events} stream={stream} project={project} {...(onClearEvents ? { onClear: onClearEvents } : {})} />
    </Panel>
  );
}

function streamBadge(stream: StreamStatus): ReactNode {
  if (stream === "open") return <Badge tone="good">stream open</Badge>;
  if (stream === "connecting") return <Badge tone="warn">stream connecting</Badge>;
  return <Badge tone="bad">stream closed</Badge>;
}

// The tail is one project's (029 B-5). One stream carries every project, so the
// default view applies the same predicate the server's own `?project=` filter
// applies: this project's records plus the daemon-scoped ones, which belong to
// no project and matter to whichever is being watched. The unfiltered view is
// one click away and says what it is, because a line from another project under
// this project's run panel would be a scope error, not extra information.
function LiveTail({
  events,
  stream,
  project,
  onClear,
}: {
  events: readonly StreamEvent[];
  stream: StreamStatus;
  project: string | null;
  onClear?: () => void;
}): ReactNode {
  const [sessionOnly, setSessionOnly] = useState(false);
  const [everyProject, setEveryProject] = useState(false);

  const filter = everyProject ? null : project;
  const scoped = events.filter((event) => eventBelongsToProject(event, filter));
  const shown: readonly StreamEvent[] = sessionOnly ? scoped.filter((e) => e.type === "session") : scoped;

  return (
    <div className="tail">
      <div className="tail-head">
        <span className="field-label">live tail</span>
        {streamBadge(stream)}
        <label className="tail-filter">
          <input type="checkbox" checked={sessionOnly} onChange={(e) => setSessionOnly(e.target.checked)} /> session events
          only
        </label>
        <label className="tail-filter">
          <input
            type="checkbox"
            checked={everyProject}
            onChange={(e) => setEveryProject(e.target.checked)}
            data-testid="tail-every-project"
          />{" "}
          every project
        </label>
        {onClear ? (
          <button type="button" className="tail-clear" onClick={onClear}>
            clear
          </button>
        ) : null}
        <span className="muted" data-testid="tail-counts">
          {shown.length} of {events.length} buffered ({countByType(scoped)})
        </span>
      </div>
      {shown.length === 0 ? (
        <Empty>
          {events.length === 0 ? (
            <>
              Nothing has streamed yet. The stream starts at the journal&apos;s tail, so records written before this
              page opened are in the read routes, not here.
            </>
          ) : (
            <>
              Nothing on the stream belongs to{" "}
              {project === null ? "the selected project" : <code>{project}</code>} yet; {events.length} buffered record
              {events.length === 1 ? "" : "s"} came off other chains.
            </>
          )}
        </Empty>
      ) : (
        <ol className="tail-list" data-testid="run-tail">
          {[...shown].reverse().map((event) => (
            <li key={event.key} className={`tail-item tail-${event.type}`}>
              <span className="tail-seq" title={event.seq === null ? "synthesized by the server, not a journal record" : undefined}>
                {event.seq === null ? "synth" : event.seq}
              </span>
              {/* One stream carries every project (027 B-4), so a line that
                  did not name its own would be unreadable here. A daemon-scoped
                  event belongs to no project and says that rather than
                  borrowing the selected one's name. */}
              <span className="tail-project" title={event.project === null ? "a daemon-scoped event, not a project's" : undefined}>
                {event.project ?? "daemon"}
              </span>
              <span className="tail-kind">{event.kind}</span>
              <span className="tail-ts">{event.ts === null ? "" : formatTimestamp(event.ts)}</span>
              <span className="tail-data">{summarizePayload(event.data)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function countByType(events: readonly StreamEvent[]): string {
  const counts = new Map<ApiEventType, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const parts = ALL_EVENT_TYPES.filter((type) => counts.has(type)).map((type) => `${type} ${counts.get(type)}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}
