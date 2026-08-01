// The DAG view (spec 024 B-2).
//
// Every field on a node is served by /api/dag and rendered as served: the
// blocker strings are the daemon's own words, not re-phrased here, because
// they are what the scheduler will say when it refuses to pick the spec.
// Pin drift and invalidation are given their own summary above the graph and
// a badge on the node, since a drifted dependency is the one condition that
// silently changes what the whole backlog is allowed to do.
import type { ReactNode } from "react";
import type { ApiError, DagSpecNode, DagView, ProjectClient, RunView, SpecControlVerb } from "../api";
import { shortHash } from "../format";
import { Badge, Empty, ErrorNote, Panel, Unknown } from "../components/bits";
import { ControlButton } from "../components/ControlButton";

// The spec-scoped verbs, offered on every node. Which of them the daemon will
// honour depends on state it re-reads at its next checkpoint, so they are all
// offered and the confirmation says what each one will write.
const SPEC_VERBS: readonly SpecControlVerb[] = ["skip", "retry-stage", "reverify", "force-human-gate", "approve"];

export interface DagPanelProps {
  readonly dag: DagView | null;
  readonly error: ApiError | null;
  readonly stale?: boolean;
  readonly client: ProjectClient | null;
  readonly run: RunView | null;
  readonly onApplied?: () => void;
  // Controls are hidden when the daemon reports it has none attached
  // (a read-only server, spec 022's `controlsAvailable`).
  readonly controlsAvailable?: boolean;
}

export function DagPanel({
  dag,
  error,
  stale = false,
  client,
  run,
  onApplied,
  controlsAvailable = true,
}: DagPanelProps): ReactNode {
  return (
    <Panel
      title="DAG"
      stale={stale}
      note={
        <>
          Spec title and lifecycle status are not carried by <code>/api/dag</code> in API v1, so each node shows the
          registry <code>implementation</code> value and this run&apos;s execution status instead. Blocker text is the
          scheduler&apos;s own.
        </>
      }
    >
      <ErrorNote error={error} />
      {dag === null ? (
        <Empty>No DAG has been served yet.</Empty>
      ) : (
        <>
          <DagSummary dag={dag} />
          <div className="dag-nodes">
            {dag.specs.map((node) => (
              <DagNode
                key={node.id}
                node={node}
                isNext={dag.nextReady === node.id}
                client={client}
                run={run}
                onApplied={onApplied}
                controlsAvailable={controlsAvailable}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function DagSummary({ dag }: { dag: DagView }): ReactNode {
  return (
    <div className="dag-summary">
      <div className="dag-summary-row">
        <span className="field-label">next ready</span>
        <span className="field-value" data-testid="dag-next-ready">
          {dag.nextReady === null ? <Unknown why="the scheduler offered no next spec" /> : <code>{dag.nextReady}</code>}
        </span>
      </div>

      {dag.nextReady === null && dag.blockers.length > 0 ? (
        <div className="dag-summary-block" data-testid="dag-scheduler-blockers">
          <span className="field-label">why nothing is ready</span>
          <ul className="blockers">
            {dag.blockers.map((blocker) => (
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

      {dag.cycle !== null ? (
        <div className="dag-summary-block alarm" data-testid="dag-cycle">
          <Badge tone="bad">dependency cycle</Badge> scheduling is refused while any spec on this cycle is unshipped:{" "}
          <code>{dag.cycle.join(" -> ")}</code>
        </div>
      ) : null}

      {dag.invalidated.length > 0 ? (
        <div className="dag-summary-block alarm" data-testid="dag-invalidated">
          <Badge tone="bad">invalidated</Badge> pin drift has invalidated{" "}
          {dag.invalidated.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DagNode({
  node,
  isNext,
  client,
  run,
  onApplied,
  controlsAvailable,
}: {
  node: DagSpecNode;
  isNext: boolean;
  client: ProjectClient | null;
  run: RunView | null;
  onApplied?: () => void;
  controlsAvailable: boolean;
}): ReactNode {
  const classes = ["dag-node"];
  if (node.invalidated) classes.push("dag-node-invalidated");
  else if (node.drifted) classes.push("dag-node-drifted");
  if (isNext) classes.push("dag-node-next");

  return (
    <article className={classes.join(" ")} data-testid={`dag-node-${node.id}`}>
      <header className="dag-node-head">
        <code className="dag-node-id">{node.id}</code>
        {isNext ? <Badge tone="good">next ready</Badge> : null}
        {node.shipped ? <Badge tone="good" title={`shipped source: ${node.shippedSource ?? "unknown"}`}>shipped</Badge> : null}
        {node.skipped ? <Badge tone="warn">skipped by control</Badge> : null}
        {node.drifted ? <Badge tone="bad">pin drift</Badge> : null}
        {node.invalidated ? <Badge tone="bad">invalidated</Badge> : null}
      </header>

      <dl className="dag-node-fields">
        <dt>implementation</dt>
        <dd>{node.implementation === null ? <Unknown why="the registry carries no implementation field for this spec" /> : node.implementation}</dd>

        <dt>this run</dt>
        <dd>{node.specExecStatus === null ? <span className="muted">not executed in this run</span> : node.specExecStatus}</dd>

        <dt>depends on</dt>
        <dd>
          {node.dependsOn.length === 0 ? (
            <span className="muted">nothing</span>
          ) : (
            node.dependsOn.map((dep) => <code key={dep}>{dep}</code>)
          )}
        </dd>

        <dt>readiness</dt>
        <dd data-testid={`dag-ready-${node.id}`}>
          {node.ready ? (
            <Badge tone="good">ready</Badge>
          ) : (
            <>
              <Badge tone="warn">blocked</Badge>
              <ul className="blockers">
                {node.blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}
        </dd>

        <dt>pin</dt>
        <dd data-testid={`dag-pin-${node.id}`}>
          {node.pinError !== null ? (
            <span className="error-note">
              <span className="error-kind">pin unreadable</span> {node.pinError}
            </span>
          ) : node.drifted ? (
            <span className="pin-drift">
              shipped at <code title={node.shippedPin ?? undefined}>{shortHash(node.shippedPin)}</code>, now{" "}
              <code title={node.currentPin ?? undefined}>{shortHash(node.currentPin)}</code>
            </span>
          ) : node.currentPin === null ? (
            <Unknown why="no pin was served for this spec" />
          ) : (
            <code title={node.currentPin}>{shortHash(node.currentPin)}</code>
          )}
        </dd>
      </dl>

      {controlsAvailable ? (
        <div className="dag-node-controls">
          {SPEC_VERBS.map((verb) => (
            <ControlButton key={verb} verb={verb} client={client} run={run} specId={node.id} {...(onApplied ? { onApplied } : {})} />
          ))}
        </div>
      ) : null}
    </article>
  );
}
