// The registry's writes (spec 029 B-3), under 024 B-6's confirmation pattern.
//
// Same promise as the run controls and the same chrome: the record that will
// land on the daemon's projects chain is shown first, nothing is sent until it
// is accepted, and what is displayed afterwards is the record the daemon
// journaled plus the registry row as it stands after the call. Nothing is
// patched locally; the caller refolds from the read routes (024 B-7).
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ApiError, ProjectControlResult, ProjectView } from "../api";
import { planRegistryControl, registryPreviewJson, type RegistryVerb } from "../registry";
import { Badge, ErrorNote } from "./bits";
import { ConfirmPrompt, ControlDialog, DismissButton, JournaledRecord } from "./ConfirmDialog";

export interface RegistryControlButtonProps {
  readonly verb: RegistryVerb;
  // The global half of the client: the registry is the daemon's, not any one
  // project's (027 B-2).
  readonly client: ApiClient;
  // The row the verb addresses; absent for a registration.
  readonly project?: ProjectView | null;
  // The typed registration, for `register` only.
  readonly path?: string;
  readonly name?: string;
  // Called once the daemon has answered, so the caller can refold the registry
  // and everything read through it.
  readonly onApplied?: () => void;
}

type Phase = "idle" | "confirming" | "sending" | "answered";

function issue(
  client: ApiClient,
  verb: RegistryVerb,
  project: ProjectView | null,
  registration: { path: string; name: string }
): Promise<{ ok: true; data: ProjectControlResult } | { ok: false; error: ApiError }> {
  if (verb === "register") {
    const name = registration.name.trim();
    return client.registerProject({
      path: registration.path.trim(),
      // 025 D-1: omitting the name is what asks the daemon to derive it, which
      // is a different request from sending an empty one.
      ...(name.length === 0 ? {} : { name }),
    });
  }
  const target = project?.name ?? "";
  if (verb === "arm") return client.armProject(target);
  if (verb === "disarm") return client.disarmProject(target);
  return client.requalifyProject(target);
}

export function RegistryControlButton({
  verb,
  client,
  project = null,
  path = "",
  name = "",
  onApplied,
}: RegistryControlButtonProps): ReactNode {
  const [phase, setPhase] = useState<Phase>("idle");
  // The verb an open dialog is about. The row's own verb flips the moment the
  // registry refolds after a call (an armed project is offered disarm, not a
  // second arm), so a dialog reading its verb off the prop would re-label itself
  // over its own answer and name a request the operator never made. It is
  // released on dismiss, when the button goes back to offering whatever the row
  // now needs.
  const [pending, setPending] = useState<RegistryVerb | null>(null);
  const [result, setResult] = useState<ProjectControlResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const active = pending ?? verb;
  const plan = planRegistryControl(active, {
    project,
    registration: { path, name },
  });
  const testId = project === null ? `registry-${active}` : `registry-${active}-${project.name}`;

  const confirm = useCallback(async (): Promise<void> => {
    setPhase("sending");
    setError(null);
    setResult(null);
    const answer = await issue(client, active, project, { path, name });
    if (answer.ok) setResult(answer.data);
    else setError(answer.error);
    setPhase("answered");
    onApplied?.();
  }, [active, client, name, onApplied, path, project]);

  const dismiss = useCallback((): void => {
    setPhase("idle");
    setPending(null);
    setResult(null);
    setError(null);
  }, []);

  if (phase === "idle") {
    return (
      <button
        type="button"
        className="control-open"
        data-testid={testId}
        onClick={() => {
          setPending(verb);
          setPhase("confirming");
        }}
      >
        {plan.label}
      </button>
    );
  }

  return (
    <ControlDialog testId={testId} label={plan.label} target={plan.project} effect={plan.effect}>
      {phase === "confirming" || phase === "sending" ? (
        <ConfirmPrompt
          testId={testId}
          previewJson={registryPreviewJson(plan)}
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

// The registry's own answer shape (027 B-2): the journaled record, and the row
// as the chain folds it afterwards. `applied: false` means the chain appended
// nothing, which is reported rather than smoothed into a success.
function Answer({
  result,
  error,
  testId,
  onDismiss,
}: {
  result: ProjectControlResult | null;
  error: ApiError | null;
  testId: string;
  onDismiss: () => void;
}): ReactNode {
  const snapshot = result?.snapshot ?? null;
  return (
    <div className="control-answer" data-testid={`${testId}-answer`}>
      {error !== null ? <ErrorNote error={error} /> : null}
      {result !== null && result.record !== null ? <JournaledRecord record={result.record} /> : null}
      {result !== null && result.record === null ? (
        <p className="control-answer-lead">
          The daemon appended nothing to the registry chain{result.applied ? " but reported the verb applied; the chain is the authority here" : ""}.
        </p>
      ) : null}
      {snapshot !== null ? (
        <p className="control-answer-status" data-testid={`${testId}-snapshot`}>
          <code>{snapshot.name}</code> now reads as{" "}
          <Badge tone={snapshot.armed ? "good" : "neutral"}>{snapshot.armed ? "armed" : "disarmed"}</Badge>{" "}
          <Badge tone={snapshot.qualification.qualified ? "good" : "warn"}>
            {snapshot.qualification.qualified ? "qualified" : "unqualified"}
          </Badge>
        </p>
      ) : null}
      <DismissButton testId={testId} onDismiss={onDismiss} />
    </div>
  );
}
