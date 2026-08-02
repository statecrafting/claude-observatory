// What a registry control will write, worked out before it is clicked
// (spec 029 B-3: the four registry verbs get 024 B-6's pattern, "each control
// shows the exact record that will be journaled before confirming").
//
// This is controls.ts's discipline applied to the second chain. The kinds and
// payloads below are the ones spec 025 B-2's registry mutations append
// verbatim; they are declared here rather than imported because projects.ts
// opens journals and so is not a browser module, and a test pins the two
// against each other. Where the record's content genuinely depends on
// something the daemon computes when the call lands (a derived name, a
// qualification verdict), the preview names that instead of inventing a value:
// a confident-looking guess would be worse than an honest gap.
import type { ProjectControlVerb, ProjectView } from "./api";

// The four verbs this UI offers (029 B-3). `remove` is a registry tombstone
// (025 D-2) and is deliberately not surfaced here; the CLI owns it.
export const REGISTRY_VERBS = ["register", "arm", "disarm", "requalify"] as const;
export type RegistryVerb = (typeof REGISTRY_VERBS)[number];

// A compile-time assertion that this UI's verbs are a subset of the wire's:
// a verb renamed in the contract fails typecheck here rather than 404ing.
const _VERBS_ARE_WIRE_VERBS: readonly ProjectControlVerb[] = REGISTRY_VERBS;
void _VERBS_ARE_WIRE_VERBS;

export const REGISTRY_LABELS: Readonly<Record<RegistryVerb, string>> = {
  register: "Register",
  arm: "Arm",
  disarm: "Disarm",
  requalify: "Requalify",
};

// The five kinds the registry chain carries (025 B-2); these four are the ones
// this UI can cause.
const REGISTRY_KINDS: Readonly<Record<RegistryVerb, string>> = {
  register: "project.registered",
  arm: "project.armed",
  disarm: "project.disarmed",
  requalify: "project.requalified",
};

// What the registry chain records as this UI's source. The header this client
// sends is `web-ui` (WEB_UI_CONTROL_SOURCE), and the server folds a free-form
// control source down to spec 025's three-value surface before journaling it,
// where anything starting with "web" is "ui". The preview shows the value the
// chain carries rather than the one the header sent, because the chain is what
// an operator will read back.
export const REGISTRY_CONTROL_SOURCE = "ui";

// Marked values: what the daemon computes when the call lands. They are
// rendered inside the preview so the shape of the record is complete and the
// unknown parts are visibly unknown.
const DERIVED_NAME = "<derived from the path by the daemon (025 D-1)>";
const PROBED_QUALIFICATION = "<the qualification probe's verdict, run by the daemon at this moment>";

// Spec 025 D-1's name grammar, as the API states it in its own refusal.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isRegistryName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export interface RegistryRecordPreview {
  readonly kind: string;
  readonly payload: Readonly<Record<string, string | boolean>>;
}

// "journals" is every accepted registry mutation: unlike the run controls,
// this chain has no idempotent no-op, because it records what was asked and by
// whom rather than only what changed (025 B-2). "refused" is a call the daemon
// answers with an error and writes nothing.
export type RegistryEffect = "journals" | "refused";

export interface RegistryPlan {
  readonly verb: RegistryVerb;
  readonly label: string;
  // The project the verb addresses; null for a registration whose name the
  // daemon will derive.
  readonly project: string | null;
  readonly effect: RegistryEffect;
  readonly record: RegistryRecordPreview | null;
  readonly note: string;
}

const CHAIN_NOTE =
  "The record goes on the daemon's projects chain, not on any project's work journal; the scheduler picks it up on its next scan.";

export interface RegistrationRequest {
  // The path as typed. The daemon resolves it to an absolute path before
  // journaling, so the preview says so rather than showing the typed string as
  // if it were the recorded one.
  readonly path: string;
  readonly name: string;
}

export interface RegistryContext {
  // The registry row the verb addresses, for the three verbs that take one.
  readonly project?: ProjectView | null;
  readonly registration?: RegistrationRequest;
}

function plan(
  verb: RegistryVerb,
  project: string | null,
  payload: Readonly<Record<string, string | boolean>>,
  note: string
): RegistryPlan {
  return {
    verb,
    label: REGISTRY_LABELS[verb],
    project,
    effect: "journals",
    record: { kind: REGISTRY_KINDS[verb], payload },
    note,
  };
}

function refused(verb: RegistryVerb, project: string | null, note: string): RegistryPlan {
  return { verb, label: REGISTRY_LABELS[verb], project, effect: "refused", record: null, note };
}

export function planRegistryControl(verb: RegistryVerb, context: RegistryContext): RegistryPlan {
  const source = REGISTRY_CONTROL_SOURCE;

  if (verb === "register") {
    const request = context.registration ?? { path: "", name: "" };
    const path = request.path.trim();
    const name = request.name.trim();
    if (path.length === 0) {
      return refused(
        "register",
        null,
        `A registration needs a path: the API answers a body without one with "bad-request" and writes nothing.`
      );
    }
    if (name.length > 0 && !isRegistryName(name)) {
      return refused(
        "register",
        name,
        `"${name}" is not a valid project name (lowercase slug, ${NAME_PATTERN.source}): the API refuses it before the registry is touched.`
      );
    }
    return plan(
      "register",
      name.length > 0 ? name : null,
      {
        name: name.length > 0 ? name : DERIVED_NAME,
        repoDir: path,
        // 010 D14: pointing the orchestrator at a project is the consent, so a
        // registration is armed unless something later disarms it.
        armed: true,
        qualification: PROBED_QUALIFICATION,
        source,
      },
      `The daemon resolves ${path} to an absolute path and runs spec 025's read-only qualification probe against it (git, spec-spine compile, specs present) before appending. An unqualified target still registers, with its reasons attached; the scheduler is what refuses to drive it. ${CHAIN_NOTE}`
    );
  }

  const project = context.project ?? null;
  if (project === null) {
    return refused(verb, null, "This control addresses one registered project, and none is selected.");
  }

  if (verb === "requalify") {
    return plan(
      "requalify",
      project.name,
      { name: project.name, qualification: PROBED_QUALIFICATION, source },
      `The probe runs again now and its verdict is what lands in the record, so this can flip "${project.name}" either way. ${CHAIN_NOTE}`
    );
  }

  // 025 B-2: arm and disarm append even when the project already holds that
  // state, because the chain records what was asked and by whom. That is why
  // there is no no-op case here, unlike the run controls.
  const already = verb === "arm" ? project.armed : !project.armed;
  const consequence =
    verb === "arm"
      ? `An armed project is one the scheduler may drive; it still has to be qualified, and "${project.name}" is ${project.qualification.qualified ? "qualified" : "not qualified, so arming it will not make it schedulable"}.`
      : `A disarmed project is observed and reported, never driven (026 D-2). A run already in flight for "${project.name}" is not interrupted by this.`;
  return plan(
    verb,
    project.name,
    { name: project.name, source },
    `${already ? `"${project.name}" already reads as ${verb === "arm" ? "armed" : "disarmed"}, and the record is appended anyway: this chain records the request, not only the change. ` : ""}${consequence} ${CHAIN_NOTE}`
  );
}

// The exact JSON the confirmation dialog shows, composed here so the dialog
// renders a string it did not build itself.
export function registryPreviewJson(plan: RegistryPlan): string {
  if (plan.record === null) return "";
  return JSON.stringify({ kind: plan.record.kind, payload: plan.record.payload }, null, 2);
}
