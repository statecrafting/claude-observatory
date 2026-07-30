// Quota state (spec 024 B-4).
//
// The countdown is the one number on screen this page computes rather than
// reads, so it is computed carefully: the target is the journaled one, and
// the clock it counts against is the daemon's, reconstructed from the skew
// between /api/quota's own `nowMs` and this page's clock at the moment that
// response arrived. Counting against the browser's clock would drift against
// the thing actually holding the timer.
//
// `estimated` is never quietly dropped. Spec 015 marks a horizon the CLI did
// not report as inferred, and a countdown that hides that is the exact kind
// of confident-looking number this spec's purpose section rules out.
import type { ReactNode } from "react";
import type { ApiError, QuotaView } from "../api";
import { countdownMs, formatCount, formatDuration, formatTimestamp } from "../format";
import { Badge, Empty, ErrorNote, Field, Panel, Unknown } from "../components/bits";

export interface QuotaPanelProps {
  readonly quota: QuotaView | null;
  readonly error: ApiError | null;
  readonly nowMs: number;
  readonly serverSkewMs: number | null;
  readonly stale?: boolean;
}

export function QuotaPanel({ quota, error, nowMs, serverSkewMs, stale = false }: QuotaPanelProps): ReactNode {
  const remaining = quota === null ? null : countdownMs(quota.targetMs, nowMs, serverSkewMs);

  return (
    <Panel
      title="Quota"
      stale={stale}
      note={
        <>
          The countdown is arithmetic on the journaled target, ticked against the daemon&apos;s clock (skew{" "}
          {serverSkewMs === null ? "not yet measured" : `${formatDuration(serverSkewMs)}`}). It is not a progress bar and
          the daemon does not resume early because of it.
        </>
      }
    >
      <ErrorNote error={error} />

      {quota === null ? (
        <Empty>No quota state has been served yet.</Empty>
      ) : (
        <>
          <div className="run-grid">
            <Field label="parked">
              {quota.parked ? <Badge tone="warn">parked on quota</Badge> : <Badge tone="good">not parked</Badge>}
            </Field>

            <Field label="horizon">
              {quota.estimated === null ? (
                <Unknown why="no park has ever been journaled, so there is no horizon to qualify" />
              ) : quota.estimated ? (
                <Badge tone="warn" title="spec 015: the reset horizon was inferred, not reported">
                  estimated
                </Badge>
              ) : (
                <Badge tone="good" title="the reset horizon was reported, not inferred">
                  reported
                </Badge>
              )}
            </Field>

            <Field label="target">
              {quota.targetMs === null ? (
                <Unknown why="no park has ever been journaled" />
              ) : (
                formatTimestamp(new Date(quota.targetMs).toISOString())
              )}
            </Field>

            <Field label="time to reset">
              {remaining === null ? (
                <Unknown why="no park has ever been journaled" />
              ) : remaining > 0 ? (
                <span data-testid="quota-countdown">{formatDuration(remaining)}</span>
              ) : (
                <span data-testid="quota-countdown">
                  target passed {formatDuration(-remaining)} ago; the daemon resumes at its next check
                </span>
              )}
            </Field>

            <Field label="consecutive parks">
              {formatCount(quota.consecutiveQuotaParks, "park")}
              {quota.warn ? (
                <Badge tone="bad" title="consecutive quota parks have crossed the warning threshold">
                  repeated parking
                </Badge>
              ) : null}
            </Field>

            <Field label="daemon clock at last read">{formatTimestamp(new Date(quota.nowMs).toISOString())}</Field>
          </div>

          {quota.warn ? (
            <p className="alarm" data-testid="quota-warning">
              The run has parked on quota {formatCount(quota.consecutiveQuotaParks, "time")} in a row. Repeated parking
              usually means the work is outrunning the quota window rather than that any one session failed.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
