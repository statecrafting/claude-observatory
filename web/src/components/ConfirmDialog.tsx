// The confirmation pattern itself (spec 024 B-6, extended to the registry by
// spec 029 B-3), factored out of the two controls that use it.
//
// There is one pattern, not two that look alike: a control names the record it
// will append, waits for a click it did not assume, and then shows what the
// daemon actually journaled. Keeping the chrome here is what stops the run
// controls and the registry controls from drifting into two different promises
// about what a confirmation means.
import type { ReactNode } from "react";
import type { ApiJournalRecord } from "../api";
import { formatJson } from "../format";
import { Badge } from "./bits";

// "no-op" is the run controls' idempotent case (022 B-5); the registry chain
// has none, because it records the request rather than only the change.
export type DialogEffect = "journals" | "no-op" | "refused";

export function EffectBadge({ effect }: { effect: DialogEffect }): ReactNode {
  if (effect === "journals") return <Badge tone="info">writes one record</Badge>;
  if (effect === "no-op") return <Badge tone="neutral">no-op, writes nothing</Badge>;
  return <Badge tone="warn">the daemon will refuse this</Badge>;
}

export function ControlDialog({
  testId,
  label,
  target,
  effect,
  children,
}: {
  testId: string;
  label: string;
  // The project or spec the verb addresses, when it addresses one.
  target?: string | null;
  effect: DialogEffect;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="control-dialog" role="dialog" aria-label={`${label} confirmation`} data-testid={`${testId}-dialog`}>
      <header className="control-dialog-head">
        <strong>{label}</strong>
        {target ? <code className="control-target">{target}</code> : null}
        <EffectBadge effect={effect} />
      </header>
      {children}
    </div>
  );
}

// The half of the dialog that precedes the write: the record, verbatim, or the
// statement that there will not be one. An outcome the client expects the
// daemon to refuse is still sendable, because the plan is a prediction from the
// last fetched state and the daemon is the one that decides.
export function ConfirmPrompt({
  testId,
  previewJson,
  note,
  effect,
  sending,
  onConfirm,
  onCancel,
}: {
  testId: string;
  // Empty when this control journals nothing.
  previewJson: string;
  note: string;
  effect: DialogEffect;
  sending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <>
      {previewJson.length === 0 ? (
        <p className="control-preview-empty" data-testid={`${testId}-preview`}>
          No record will be journaled.
        </p>
      ) : (
        <>
          <p className="control-preview-lead">This appends exactly one record:</p>
          <pre className="control-preview" data-testid={`${testId}-preview`}>
            {previewJson}
          </pre>
        </>
      )}
      <p className="control-note">{note}</p>
      <div className="control-dialog-actions">
        <button
          type="button"
          className="control-confirm"
          data-testid={`${testId}-confirm`}
          disabled={sending}
          onClick={onConfirm}
        >
          {effect === "refused" ? "Send anyway" : "Confirm"}
        </button>
        <button type="button" className="control-cancel" data-testid={`${testId}-cancel`} disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

// What the daemon journaled, read off its own answer (022 D-2 diffs the record
// out of the chain rather than synthesizing it), so this is the record itself
// and not a second rendering of the preview.
export function JournaledRecord({ record }: { record: ApiJournalRecord }): ReactNode {
  return (
    <>
      <p className="control-answer-lead">
        Journaled at seq <code>{record.seq}</code> ({record.ts}):
      </p>
      <pre className="control-preview">{formatJson({ kind: record.kind, payload: record.payload })}</pre>
    </>
  );
}

export function DismissButton({ testId, onDismiss }: { testId: string; onDismiss: () => void }): ReactNode {
  return (
    <div className="control-dialog-actions">
      <button type="button" className="control-cancel" data-testid={`${testId}-dismiss`} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
