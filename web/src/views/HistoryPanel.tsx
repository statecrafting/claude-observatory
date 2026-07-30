// Run history and the per-spec evidence trail (spec 024 B-5).
//
// The evidence links are real links: /api/evidence/<hash>?raw=1 serves the
// bytes the verify stage actually wrote (spec 022 D-3), same-origin, so a
// verdict on this page can be opened and read rather than taken on trust.
// The PR number and merge sha are shown as the identifiers they are and not
// turned into github.com URLs: the API serves no repository slug, and a
// fabricated link is exactly the kind of confident-looking detail B-7 rules
// out.
import type { ReactNode } from "react";
import type { ApiClient, ApiError, HistoryEntry, HistoryView } from "../api";
import { shortHash } from "../format";
import { Badge, Empty, ErrorNote, Panel, Unknown } from "../components/bits";

export interface HistoryPanelProps {
  readonly history: HistoryView | null;
  readonly error: ApiError | null;
  readonly client: ApiClient;
  readonly stale?: boolean;
}

function verdictTone(verdict: string | null): "good" | "bad" | "warn" | "neutral" {
  if (verdict === null) return "neutral";
  if (verdict === "passed") return "good";
  if (verdict === "failed") return "bad";
  return "warn";
}

export function HistoryPanel({ history, error, client, stale = false }: HistoryPanelProps): ReactNode {
  const entries: readonly HistoryEntry[] = history?.entries ?? [];

  return (
    <Panel
      title="History"
      stale={stale}
      note={
        <>
          Newest first. Per-session cost is journaled on the session records but is not projected into{" "}
          <code>/api/history</code> in API v1, so it is not shown here; it streams into the run view&apos;s live tail as
          the sessions finish.
        </>
      }
    >
      <ErrorNote error={error} />

      {history === null ? (
        <Empty>No history has been served yet.</Empty>
      ) : entries.length === 0 ? (
        <Empty>No spec execution has been recorded in this journal.</Empty>
      ) : (
        <ol className="history-list">
          {[...entries].reverse().map((entry) => (
            <li key={entry.specExecId} className="history-entry" data-testid={`history-${entry.specExecId}`}>
              <header className="history-head">
                <code className="history-spec">{entry.specId}</code>
                <Badge tone={entry.status === "shipped" ? "good" : entry.status === "failed" ? "bad" : "info"}>
                  {entry.status}
                </Badge>
                <span className="muted">attempt {entry.attempt}</span>
                {entry.needsReconcile ? <Badge tone="warn">needs reconcile</Badge> : null}
                <code className="muted" title={entry.pin}>
                  pin {shortHash(entry.pin)}
                </code>
              </header>

              <dl className="history-fields">
                <dt>PR</dt>
                <dd>{entry.prNumber === null ? <Unknown why="no ship result journaled a PR number" /> : `#${entry.prNumber}`}</dd>

                <dt>CI</dt>
                <dd>
                  {entry.ciConclusion === null ? (
                    <Unknown why="shepherd has not reported on this execution" />
                  ) : (
                    <Badge tone={verdictTone(entry.ciConclusion)}>{entry.ciConclusion}</Badge>
                  )}
                </dd>

                <dt>merge sha</dt>
                <dd>
                  {entry.mergeSha === null ? (
                    <Unknown why="nothing has been merged for this execution" />
                  ) : (
                    <code title={entry.mergeSha}>{shortHash(entry.mergeSha)}</code>
                  )}
                </dd>

                <dt>verify</dt>
                <dd>
                  {entry.verifyVerdict === null ? (
                    <Unknown why="the verify stage has not reported on this execution" />
                  ) : (
                    <Badge tone={verdictTone(entry.verifyVerdict)}>{entry.verifyVerdict}</Badge>
                  )}
                </dd>

                <dt>stages</dt>
                <dd>
                  {entry.stages.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    entry.stages.map((stage) => (
                      <span key={stage.id} className="history-stage">
                        {stage.stage}
                        <Badge tone={verdictTone(stage.status === "passed" ? "passed" : stage.status === "failed" ? "failed" : null)}>
                          {stage.status}
                        </Badge>
                        {stage.attempt > 1 ? <span className="muted">attempt {stage.attempt}</span> : null}
                      </span>
                    ))
                  )}
                </dd>

                <dt>evidence</dt>
                <dd>
                  {entry.evidenceRefs.length === 0 ? (
                    <span className="muted">no evidence file was written</span>
                  ) : (
                    entry.evidenceRefs.map((hash) => (
                      <a
                        key={hash}
                        className="evidence-link"
                        href={client.evidenceUrl(hash)}
                        title={hash}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortHash(hash)}
                      </a>
                    ))
                  )}
                </dd>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
