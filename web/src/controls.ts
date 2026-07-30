// What a control will write, worked out before it is clicked (spec 024 B-6:
// "each control shows the exact control record that will be journaled before
// confirming").
//
// This module is a pure function of the verb, its target, and the run state
// the API just served. It duplicates no logic: the kinds and payloads below
// are the ones spec 021 B-4's Daemon appends verbatim, and the start/pause/
// resume outcomes are spec 022 D-1 and B-5's, read off the same run status
// the server reads. Getting this wrong is worse than not showing it, so where
// the outcome genuinely depends on state the daemon will re-read, that is
// what the note says rather than a guess.
import { WEB_UI_CONTROL_SOURCE } from "./api";
import type { ControlVerbToken, RunView } from "./api";

export interface JournaledRecordPreview {
  readonly kind: string;
  readonly payload: Readonly<Record<string, string>>;
}

// "journals" writes exactly one record; "no-op" is B-5's idempotent case, in
// which the API answers `applied: false` with no record at all; "refused"
// is answered as a conflict and nothing is written.
export type ControlEffect = "journals" | "no-op" | "refused";

export interface ControlPlan {
  readonly verb: ControlVerbToken;
  readonly label: string;
  readonly specId: string | null;
  readonly effect: ControlEffect;
  readonly record: JournaledRecordPreview | null;
  readonly note: string;
}

export const CONTROL_LABELS: Readonly<Record<ControlVerbToken, string>> = {
  start: "Start",
  pause: "Pause",
  resume: "Resume",
  skip: "Skip spec",
  "retry-stage": "Retry stage",
  reverify: "Re-run verify",
  "force-human-gate": "Force human gate",
  approve: "Approve",
};

// The journal kind each spec-scoped verb appends. The names are the Daemon's
// method names, not the API's verb tokens, which is why the two lists differ.
const SPEC_VERB_KINDS: Readonly<Record<string, string>> = {
  skip: "control.skipSpec",
  "retry-stage": "control.retryStage",
  reverify: "control.reverify",
  "force-human-gate": "control.forceHumanGate",
  approve: "control.approve",
};

// Every control record the daemon writes carries the source the client sent,
// so the preview can name it exactly.
const LAG_NOTE =
  "The record is appended immediately; the run loop applies the command at its next checkpoint, so the run status lags the record by design.";

function journals(
  verb: ControlVerbToken,
  specId: string | null,
  kind: string,
  payload: Readonly<Record<string, string>>,
  note: string
): ControlPlan {
  return { verb, label: CONTROL_LABELS[verb], specId, effect: "journals", record: { kind, payload }, note };
}

function noOp(verb: ControlVerbToken, note: string): ControlPlan {
  return { verb, label: CONTROL_LABELS[verb], specId: null, effect: "no-op", record: null, note };
}

function refused(verb: ControlVerbToken, specId: string | null, note: string): ControlPlan {
  return { verb, label: CONTROL_LABELS[verb], specId, effect: "refused", record: null, note };
}

export interface ControlContext {
  readonly run: RunView | null;
  readonly specId?: string | null;
  readonly source?: string;
}

export function planControl(verb: ControlVerbToken, context: ControlContext): ControlPlan {
  const source = context.source ?? WEB_UI_CONTROL_SOURCE;
  const run = context.run?.run ?? null;

  const specKind = SPEC_VERB_KINDS[verb];
  if (specKind !== undefined) {
    const specId = context.specId ?? null;
    if (specId === null || specId.length === 0) {
      return refused(verb, null, "This control needs a spec id; the daemon refuses an empty one.");
    }
    const note =
      verb === "reverify"
        ? `${LAG_NOTE} If no shipped execution of ${specId} exists under the current run, the loop answers with its own control.reverify.refused record instead of re-verifying.`
        : LAG_NOTE;
    return journals(verb, specId, specKind, { specId, source }, note);
  }

  if (run === null) {
    return refused(verb, null, "No run exists in the journal yet, so the API answers this with a conflict and writes nothing.");
  }

  const runId = run.id;
  switch (verb) {
    case "start":
      // Spec 022 D-1: start means "ensure the run is running". It never boots
      // a process, and when it does act it acts as resume, which is the
      // record that actually lands in the journal.
      if (run.status === "running") {
        return noOp("start", "The run is already running: the API answers applied: false and nothing is journaled.");
      }
      if (run.status === "paused") {
        return journals(
          "start",
          null,
          "control.resume",
          { runId, source },
          `Start delegates to resume on a paused run, so the record written is a control.resume. ${LAG_NOTE}`
        );
      }
      return refused(
        "start",
        null,
        `A run in status "${run.status}" cannot be started: the API answers with a conflict and writes nothing.`
      );

    case "pause":
      if (run.status === "paused") {
        return noOp("pause", "The run is already paused: the API answers applied: false and nothing is journaled.");
      }
      if (run.status === "running") {
        return journals("pause", null, "control.pause", { runId, source }, LAG_NOTE);
      }
      return refused(
        "pause",
        null,
        `The daemon refuses to pause a run in status "${run.status}" (it requires "running"), so nothing is journaled.`
      );

    case "resume":
      if (run.status === "running") {
        return noOp("resume", "The run is already running: the API answers applied: false and nothing is journaled.");
      }
      if (run.status === "paused") {
        return journals("resume", null, "control.resume", { runId, source }, LAG_NOTE);
      }
      return refused(
        "resume",
        null,
        `The daemon refuses to resume a run in status "${run.status}" (it requires "paused"), so nothing is journaled.`
      );

    default:
      return refused(verb, null, `Unknown control verb "${verb}".`);
  }
}

// The exact JSON the confirmation dialog shows. Kept here so the dialog
// renders a string it did not compose itself.
export function previewJson(plan: ControlPlan): string {
  if (plan.record === null) return "";
  return JSON.stringify({ kind: plan.record.kind, payload: plan.record.payload }, null, 2);
}
