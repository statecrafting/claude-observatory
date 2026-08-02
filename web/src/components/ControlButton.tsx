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
import type { ApiError, ControlResult, ControlVerbToken, ProjectClient, RunView } from "../api";
import { planControl, previewJson } from "../controls";
import { ErrorNote } from "./bits";
import { ConfirmPrompt, ControlDialog, DismissButton, JournaledRecord } from "./ConfirmDialog";

export interface ControlButtonProps {
  readonly verb: ControlVerbToken;
  // Scoped to one project (spec 027 B-5); null while no project has been
  // selected yet, which is refused rather than sent to a guessed one.
  readonly client: ProjectClient | null;
  readonly run: RunView | null;
  readonly specId?: string | null;
  // Called once the daemon has answered, so the caller can refold every view
  // from the read routes. Never used to apply a local state change.
  readonly onApplied?: () => void;
}

type Phase = "idle" | "confirming" | "sending" | "answered";

function issue(client: ProjectClient, verb: ControlVerbToken, specId: string | null): Promise<{ ok: true; data: ControlResult } | { ok: false; error: ApiError }> {
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
    const answer =
      client === null
        ? { ok: false as const, error: { kind: "unavailable" as const, message: "no project is selected yet" } }
        : await issue(client, verb, specId);
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
    <ControlDialog testId={testId} label={plan.label} target={plan.specId} effect={plan.effect}>
      {phase === "confirming" || phase === "sending" ? (
        <ConfirmPrompt
          testId={testId}
          previewJson={previewJson(plan)}
          note={plan.note}
          effect={plan.effect}
          sending={phase === "sending"}
          onConfirm={() => void confirm()}
          onCancel={dismiss}
        />
      ) : (
        <Answer result={result} error={error} testId={testId} onDismiss={dismiss} />
      )}
    </ControlDialog>
  );
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
      {result !== null && result.applied && result.record !== null ? <JournaledRecord record={result.record} /> : null}
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
      <DismissButton testId={testId} onDismiss={onDismiss} />
    </div>
  );
}
