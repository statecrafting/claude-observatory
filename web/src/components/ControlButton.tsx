// The only writes this app performs (spec 024 B-6), and the confirmation
// that has to precede them.
//
// The dialog's job is to make the write legible before it happens: it shows
// the exact journal record the daemon will append, computed by controls.ts
// from the run state the API last served. Where the outcome is an idempotent
// no-op or a refusal, it says that instead of showing a record that will not
// exist. Nothing is predicted after the fact: once the POST returns, what is
// displayed is the record the daemon actually journaled (spec 022 D-2 diffs
// it out of the chain rather than synthesizing it), and the surrounding views
// are refolded from the read routes rather than patched locally (B-7).
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ApiError, ControlResult, ControlVerbToken, RunView } from "../api";
import { planControl, previewJson } from "../controls";
import { formatJson } from "../format";
import { Badge, ErrorNote } from "./bits";

export interface ControlButtonProps {
  readonly verb: ControlVerbToken;
  readonly client: ApiClient;
  readonly run: RunView | null;
  readonly specId?: string | null;
  // Called once the daemon has answered, so the caller can refold every view
  // from the read routes. Never used to apply a local state change.
  readonly onApplied?: () => void;
}

type Phase = "idle" | "confirming" | "sending" | "answered";

function issue(client: ApiClient, verb: ControlVerbToken, specId: string | null): Promise<{ ok: true; data: ControlResult } | { ok: false; error: ApiError }> {
  switch (verb) {
    case "start":
      return client.startRun();
    case "pause":
      return client.pauseRun();
    case "resume":
      return client.resumeRun();
    case "skip":
      return client.skipSpec(specId ?? "");
    case "retry-stage":
      return client.retryStage(specId ?? "");
    case "reverify":
      return client.reverify(specId ?? "");
    case "force-human-gate":
      return client.forceHumanGate(specId ?? "");
    case "approve":
      return client.approve(specId ?? "");
  }
}

export function ControlButton({ verb, client, run, specId = null, onApplied }: ControlButtonProps): ReactNode {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ControlResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const plan = planControl(verb, { run, specId });
  const testId = specId === null ? `control-${verb}` : `control-${verb}-${specId}`;

  const confirm = useCallback(async (): Promise<void> => {
    setPhase("sending");
    setError(null);
    setResult(null);
    const answer = await issue(client, verb, specId);
    if (answer.ok) setResult(answer.data);
    else setError(answer.error);
    setPhase("answered");
    onApplied?.();
  }, [client, onApplied, specId, verb]);

  const dismiss = useCallback((): void => {
    setPhase("idle");
    setResult(null);
    setError(null);
  }, []);

  if (phase === "idle") {
    return (
      <button type="button" className="control-open" data-testid={testId} onClick={() => setPhase("confirming")}>
        {plan.label}
      </button>
    );
  }

  return (
    <div className="control-dialog" role="dialog" aria-label={`${plan.label} confirmation`} data-testid={`${testId}-dialog`}>
      <header className="control-dialog-head">
        <strong>{plan.label}</strong>
        {plan.specId ? <code className="control-target">{plan.specId}</code> : null}
        <EffectBadge effect={plan.effect} />
      </header>

      {phase === "confirming" || phase === "sending" ? (
        <>
          {plan.record === null ? (
            <p className="control-preview-empty" data-testid={`${testId}-preview`}>
              No record will be journaled.
            </p>
          ) : (
            <>
              <p className="control-preview-lead">This appends exactly one record to the work journal:</p>
              <pre className="control-preview" data-testid={`${testId}-preview`}>
                {previewJson(plan)}
              </pre>
            </>
          )}
          <p className="control-note">{plan.note}</p>
          <div className="control-dialog-actions">
            <button
              type="button"
              className="control-confirm"
              data-testid={`${testId}-confirm`}
              disabled={phase === "sending"}
              onClick={() => void confirm()}
            >
              {plan.effect === "refused" ? "Send anyway" : "Confirm"}
            </button>
            <button
              type="button"
              className="control-cancel"
              data-testid={`${testId}-cancel`}
              disabled={phase === "sending"}
              onClick={dismiss}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <Answer result={result} error={error} testId={testId} onDismiss={dismiss} />
      )}
    </div>
  );
}

function EffectBadge({ effect }: { effect: ReturnType<typeof planControl>["effect"] }): ReactNode {
  if (effect === "journals") return <Badge tone="info">writes one record</Badge>;
  if (effect === "no-op") return <Badge tone="neutral">no-op, writes nothing</Badge>;
  return <Badge tone="warn">the daemon will refuse this</Badge>;
}

// What actually happened, straight from the envelope. `applied: false` is
// reported as the no-op it is, never smoothed into a success message.
function Answer({
  result,
  error,
  testId,
  onDismiss,
}: {
  result: ControlResult | null;
  error: ApiError | null;
  testId: string;
  onDismiss: () => void;
}): ReactNode {
  return (
    <div className="control-answer" data-testid={`${testId}-answer`}>
      {error !== null ? <ErrorNote error={error} /> : null}
      {result !== null && result.applied && result.record !== null ? (
        <>
          <p className="control-answer-lead">
            Journaled at seq <code>{result.record.seq}</code> ({result.record.ts}):
          </p>
          <pre className="control-preview">{formatJson({ kind: result.record.kind, payload: result.record.payload })}</pre>
        </>
      ) : null}
      {result !== null && !result.applied ? (
        <p className="control-answer-lead">Nothing was journaled: the daemon reported this control as already satisfied.</p>
      ) : null}
      {result !== null && result.applied && result.record === null ? (
        <p className="control-answer-lead">
          The daemon reported the control applied but returned no record; the journal is the authority here.
        </p>
      ) : null}
      {result !== null ? (
        <p className="control-answer-status">
          run status after the call: <code>{result.runStatus ?? "unknown"}</code>
        </p>
      ) : null}
      <div className="control-dialog-actions">
        <button type="button" className="control-cancel" data-testid={`${testId}-dismiss`} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
