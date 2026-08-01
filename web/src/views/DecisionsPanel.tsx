// The decision-ledger browser (spec 024 B-5).
//
// The three inputs are a straight passthrough to the ledger route's own query
// parameters (spec 020 B-5's query surface); no filtering happens in the
// browser, so what is listed is what the daemon matched, and the same query
// typed into `observatory orchestrator decisions` returns the same set.
//
// The ledger is a project's own (spec 027 B-3), so this panel refuses to
// search while no project is selected rather than issuing a query with no
// scope behind it.
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { ApiError, DecisionQueryParams, DecisionsView } from "../api";
import { Empty, ErrorNote, Panel } from "../components/bits";

export interface DecisionsPanelProps {
  readonly decisions: DecisionsView | null;
  readonly error: ApiError | null;
  // The project whose ledger this queries; null until the registry resolves
  // one, which disables the form rather than guessing a scope.
  readonly project: string | null;
  readonly onSearch: (query: DecisionQueryParams) => void;
  readonly stale?: boolean;
}

export function DecisionsPanel({ decisions, error, project, onSearch, stale = false }: DecisionsPanelProps): ReactNode {
  const [text, setText] = useState("");
  const [specId, setSpecId] = useState("");
  const [path, setPath] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (project === null) return;
    onSearch({
      ...(text.trim().length > 0 ? { query: text.trim() } : {}),
      ...(specId.trim().length > 0 ? { specId: specId.trim() } : {}),
      ...(path.trim().length > 0 ? { path: path.trim() } : {}),
    });
  };

  return (
    <Panel
      title="Decisions"
      stale={stale}
      note={
        project === null ? (
          <>No project is selected, so there is no ledger to query.</>
        ) : (
          <>
            Queries go to <code>{`/api/projects/${project}/decisions`}</code> unchanged. An empty form lists that
            project&apos;s whole sealed ledger.
          </>
        )
      }
    >
      <form className="decision-form" onSubmit={submit}>
        <label>
          text
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="free text" data-testid="decisions-query" />
        </label>
        <label>
          spec
          <input value={specId} onChange={(e) => setSpecId(e.target.value)} placeholder="022-http-api-and-events" />
        </label>
        <label>
          path
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/orchestrator/api/" />
        </label>
        <button type="submit" data-testid="decisions-search" disabled={project === null}>
          search
        </button>
      </form>

      <ErrorNote error={error} />

      {decisions === null ? (
        <Empty>No ledger query has been run yet.</Empty>
      ) : decisions.decisions.length === 0 ? (
        <Empty>No decision matched this query.</Empty>
      ) : (
        <>
          <p className="muted" data-testid="decisions-total">
            {decisions.total} matching {decisions.total === 1 ? "decision" : "decisions"}
          </p>
          <ol className="decision-list">
            {decisions.decisions.map((decision) => (
              <li key={decision.id} className="decision">
                <header>
                  <code className="decision-id">{decision.id}</code>
                  <code className="decision-spec">{decision.specId}</code>
                </header>
                <h3>{decision.title}</h3>
                <p className="decision-body">{decision.decision}</p>
                <p className="decision-rationale">
                  <span className="field-label">why</span> {decision.rationale}
                </p>
                {decision.scope.length > 0 ? (
                  <p className="decision-scope">
                    <span className="field-label">scope</span>{" "}
                    {decision.scope.map((entry) => (
                      <code key={entry}>{entry}</code>
                    ))}
                  </p>
                ) : null}
                {decision.alternatives && decision.alternatives.length > 0 ? (
                  <div className="decision-alternatives">
                    <span className="field-label">alternatives considered</span>
                    <ul>
                      {decision.alternatives.map((alternative) => (
                        <li key={alternative}>{alternative}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {decision.supersedes ? (
                  <p className="decision-supersedes">
                    <span className="field-label">supersedes</span> <code>{decision.supersedes}</code>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}
