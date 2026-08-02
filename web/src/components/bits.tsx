// The small shared vocabulary every view is built from.
//
// `Unknown` and `NotServed` are the load-bearing ones: spec 024 B-7 forbids
// rendering an unknown as a spinner or a plausible default, so the app needs
// a way to say "the daemon did not tell us" that is as easy to reach for as
// printing a value. `NotServed` is the sharper case, for a field this UI
// would like to show and the API does not carry at all; naming the route
// keeps the gap traceable instead of mysterious.
import type { ReactNode } from "react";
import type { ApiError } from "../api";

export function Unknown({ why }: { why?: string }): ReactNode {
  return (
    <span className="unknown" title={why ?? "the daemon did not serve a value for this field"}>
      unknown
    </span>
  );
}

export function NotServed({ route, field }: { route: string; field: string }): ReactNode {
  return (
    <span className="not-served" title={`${route} carries no ${field}`}>
      not served by {route}
    </span>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export function Badge({ tone = "neutral", title, children }: { tone?: Tone; title?: string; children: ReactNode }): ReactNode {
  return (
    <span className={`badge badge-${tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

export function Panel({
  title,
  note,
  stale,
  actions,
  children,
}: {
  title: string;
  note?: ReactNode;
  stale?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={stale ? "panel panel-stale" : "panel"}>
      <header className="panel-head">
        <h2>{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {note ? <p className="panel-note">{note}</p> : null}
      {children}
    </section>
  );
}

// An API error is shown with its stable `kind` token, not just its prose:
// that token is the contract (spec 022 B-2), and it is what an operator would
// grep for.
export function ErrorNote({ error }: { error: ApiError | null }): ReactNode {
  if (error === null) return null;
  return (
    <p className="error-note" role="status">
      <span className="error-kind">{error.kind}</span> {error.message}
    </p>
  );
}

export function Empty({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <p className="empty" {...(testId === undefined ? {} : { "data-testid": testId })}>
      {children}
    </p>
  );
}
