// Per-project economics (spec 038 B-1).
//
// Spec 030 made cost and rework a served fact and left the panel to a later
// spec; this is it, and it adds nothing to what 030 serves. Every number here
// is a field of `/api/projects/<name>/economics`, rendered under two rules.
//
// A denominator travels with every aggregate (B-2). A cost is a sum over the
// sessions that reported one, and the sessions that reported nothing are not
// part of it, so the count of each is said next to the money rather than left
// for the reader to assume. And a spec whose whole cost went unreported
// renders as an explicit unknown: 0.00 would claim it was free when the truth
// is that nobody said.
//
// A table rather than a chart (D-1): the rollup is one row per spec, and the
// facts worth seeing are precisely the denominators and the unknowns, which a
// chart would have to drop to draw an axis.
import type { ReactNode } from "react";
import type { ApiError } from "../api";
import type { EconomicsTotals, RunEconomics, ServedEconomicsView, SpecEconomics } from "../economics";
import { denominator, economicsPath, formatMicroUsd, specsByKnownCost } from "../economics";
import { formatCount, formatDuration, formatTimestamp } from "../format";
import { Badge, Empty, ErrorNote, Field, Panel, Unknown } from "../components/bits";

export interface EconomicsPanelProps {
  readonly economics: ServedEconomicsView | null;
  readonly error: ApiError | null;
  // The project this rollup was read from; null until the registry resolves
  // one, which is said outright rather than rendered as an empty rollup.
  readonly project: string | null;
  readonly stale?: boolean;
}

// The money itself. Null is the honest case that B-2 exists for, not a
// missing value to paper over: the sessions ran, and what they cost was never
// journaled.
function Cost({ costMicroUsd }: { costMicroUsd: number | null }): ReactNode {
  if (costMicroUsd === null) {
    return <Unknown why="no session here reported a cost, so there is no sum to show" />;
  }
  return <span className="econ-cost">{formatMicroUsd(costMicroUsd)}</span>;
}

// Spec 014's kinds, listed only where they happened. A zero-filled list of
// nine kinds per row would bury the one that fired.
function terminations(byTermination: Readonly<Record<string, number>>): string {
  const fired = Object.entries(byTermination)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return fired.length === 0 ? "none journaled" : fired.join(", ");
}

function parked(quotaParks: number, parkedMs: number | null): ReactNode {
  if (quotaParks === 0) return <>no quota park</>;
  return (
    <>
      {formatCount(quotaParks, "park")}
      {parkedMs === null ? (
        <Unknown why="a park was never resumed in this journal, so the total time parked cannot be summed" />
      ) : (
        <span>, {formatDuration(parkedMs)} parked</span>
      )}
    </>
  );
}

// The whole-journal aggregates (030 D-1), which is what "run totals" means for
// a project whose journal holds more than one run.
function Totals({ totals }: { totals: EconomicsTotals }): ReactNode {
  return (
    <div className="run-grid" data-testid="economics-totals">
      <Field label="cost">
        <Cost costMicroUsd={totals.costMicroUsd} />
      </Field>
      <Field label="over">
        <span data-testid="economics-totals-denominator">
          {denominator(totals.sessions, totals.costUnknownSessions)}
        </span>
      </Field>
      <Field label="sessions ended">{terminations(totals.sessionsByTermination)}</Field>
      <Field label="rework">{formatCount(totals.remediationRounds, "attempt beyond the first", "attempts beyond the first")}</Field>
      <Field label="hook blocks">{formatCount(totals.hookBlockedStages, "stage")}</Field>
      <Field label="quota">{parked(totals.quotaParks, totals.parkedMs)}</Field>
    </div>
  );
}

function runTone(status: RunEconomics["status"]): "good" | "bad" | "info" | "neutral" {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "running") return "info";
  return "neutral";
}

function Run({ run }: { run: RunEconomics }): ReactNode {
  return (
    <li className="econ-run" data-testid={`economics-run-${run.runId}`}>
      <header className="econ-run-head">
        <code className="econ-run-id">{run.runId}</code>
        <Badge tone={runTone(run.status)}>{run.status}</Badge>
        <span className="muted">
          {run.wallClockMs === null ? (
            <Unknown why="this run has no terminal transition journaled, so its wall-clock has only one end" />
          ) : (
            formatDuration(run.wallClockMs)
          )}
        </span>
      </header>
      <p className="econ-run-body">
        <Cost costMicroUsd={run.costMicroUsd} /> over {denominator(run.sessions, run.costUnknownSessions)}.{" "}
        {formatCount(run.remediationRounds, "attempt beyond the first", "attempts beyond the first")},{" "}
        {formatCount(run.hookBlockedStages, "hook-blocked stage")}, {parked(run.quotaParks, run.parkedMs)}.
      </p>
    </li>
  );
}

function SpecRow({ spec }: { spec: SpecEconomics }): ReactNode {
  return (
    <tr data-testid={`economics-spec-${spec.specId}`}>
      <th scope="row">
        <code>{spec.specId}</code>
      </th>
      <td>
        <Cost costMicroUsd={spec.costMicroUsd} />
      </td>
      <td>{denominator(spec.sessions, spec.costUnknownSessions)}</td>
      <td>{spec.remediationRounds}</td>
    </tr>
  );
}

export function EconomicsPanel({ economics, error, project, stale = false }: EconomicsPanelProps): ReactNode {
  const specs = economics === null ? [] : specsByKnownCost(economics.specs);

  return (
    <Panel
      title="Economics"
      stale={stale}
      note={
        project === null ? (
          <>No project is selected, so there is no rollup to read.</>
        ) : (
          <>
            Rolled up by the daemon from <code>{economicsPath(project)}</code>, journal-derived and nothing else (030
            B-5). A cost is the sum over the sessions that reported one; the sessions that reported none are counted
            beside it rather than folded in.
            {economics === null ? null : (
              <> Generated {formatTimestamp(new Date(economics.generatedAt).toISOString())}.</>
            )}
          </>
        )
      }
    >
      <ErrorNote error={error} />

      {project === null ? (
        <Empty testId="economics-unscoped">A rollup belongs to a project, and none is selected.</Empty>
      ) : economics === null ? (
        <Empty testId="economics-unread">No economics has been served yet.</Empty>
      ) : economics.totals === null ? (
        // B-3: the reason, not an empty table. An empty journal has no run, no
        // spec execution and no session, and a grid of zeros would claim it had
        // them and that they cost nothing.
        <Empty testId="economics-empty">
          This project&apos;s journal is empty, so there is nothing to roll up: no run, no spec execution, and no
          session has been recorded for {project}.
        </Empty>
      ) : (
        <>
          <Totals totals={economics.totals} />

          <h3 className="econ-heading">runs</h3>
          {economics.runs.length === 0 ? (
            <Empty testId="economics-no-runs">No run has been created in this journal.</Empty>
          ) : (
            <ol className="econ-runs">
              {economics.runs.map((run) => (
                <Run key={run.runId} run={run} />
              ))}
            </ol>
          )}

          <h3 className="econ-heading">specs</h3>
          {specs.length === 0 ? (
            <Empty testId="economics-no-specs">No spec execution has been recorded in this journal.</Empty>
          ) : (
            <table className="econ-table" data-testid="economics-specs">
              <thead>
                <tr>
                  <th scope="col">spec</th>
                  <th scope="col">known cost</th>
                  <th scope="col">over</th>
                  <th scope="col">rework</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((spec) => (
                  <SpecRow key={spec.specId} spec={spec} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}
