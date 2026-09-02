// Execution profiles (spec 032): what a driven session is allowed to do on
// the operator's machine, as per-project registry state.
//
// Spec 010 D14 made pointing the orchestrator at a project the consent to
// drive it. That consent was silently carrying a second one: every session
// spawned with `--dangerously-skip-permissions` hardcoded at spec 014's one
// argv construction site, whatever the target. This module splits the second
// consent out. A profile is operator-owned, journaled state on the projects
// chain (spec 025's chain-not-table discipline), folded onto the project
// exactly as `armed` is, and turned into session argv by one pure function
// that every spawn path uses.
//
// Three invariants shape everything here:
//
//   B-1: the two modes are mutually exclusive by construction. `bypass`
//   derives the bypass flag and nothing else; `guarded` derives
//   `--permission-mode acceptEdits` plus a tool allowlist and never the
//   bypass flag. No derivable argv contains both.
//
//   B-2: a project whose chain holds no profile record folds to bypass
//   flagged `legacy`. Registrations made before this spec existed keep
//   today's behavior and lose today's silence; every surface says which
//   bypass it is looking at.
//
//   B-3: sessionArgsForProfile() is the only source of permission-related
//   argv in this codebase. Nothing composes a permission flag by hand.
import type { JsonValue } from "./journal";
import type { SessionModels } from "./models";
import { parseSessionModels, sessionModelsPayload } from "./models";

// --- the model (B-1) --------------------------------------------------------

export const EXECUTION_MODES = ["bypass", "guarded"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

export interface ExecutionProfile {
  readonly mode: ExecutionMode;
  // Present only on a guarded profile. Absent means the D-2 baseline below;
  // present replaces it wholesale (an operator extends the baseline by
  // listing it, which is what the write verbs materialize for them). Carried
  // verbatim into argv and into the journal.
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  // 040 B-4: the project's model pair, or absent for the default pair. It
  // rides here rather than on a record of its own because it answers the same
  // question the mode does, "under what posture does this project's session
  // run", and folds, sets and renders in the same places (040 D-2). It is
  // orthogonal to the mode: either mode may carry a pair.
  readonly models?: SessionModels;
}

// A profile as read back off the projects chain. `legacy` is the honest
// difference between a bypass an operator chose and a bypass nobody ever
// spoke about (B-2); it is derived by the fold, never journaled, so it can
// only ever describe pre-032 history.
export interface RecordedProfile extends ExecutionProfile {
  readonly legacy: boolean;
}

// What a chain with no profile record folds to: today's posture, kept.
export const LEGACY_BYPASS_PROFILE: RecordedProfile = { mode: "bypass", legacy: true };

// What a registration records when the operator names no profile (D-1). A
// guarded default would need an allowlist chosen sight unseen, and an empty
// or wrong one cannot run the governed gate; the safety this spec adds is
// that the posture is chosen, journaled, and displayed, never that a default
// silently flips under an existing target.
export const DEFAULT_REGISTRATION_PROFILE: ExecutionProfile = { mode: "bypass" };

// --- threading a profile to a spawn path (B-4) ------------------------------

// What a session factory is handed: the owning project's profile, or a
// late-bound read of it. The daemon passes a reader rather than a value
// because its per-project seams are built once and reused for the process's
// life, while a profile can be set at any moment through a control surface.
// A posture an operator tightened that quietly does not apply until the
// daemon restarts is the failure this seam exists to prevent.
export type ProfileSource = ExecutionProfile | (() => ExecutionProfile);

export function resolveProfileSource(source: ProfileSource | undefined): ExecutionProfile {
  if (source === undefined) return DEFAULT_REGISTRATION_PROFILE;
  return typeof source === "function" ? source() : source;
}

// --- the guarded baseline (D-2) ---------------------------------------------

// Policy as reviewable, tested data rather than as code (031 FR-002's
// precedent): the governed loop's own commands, so a guarded session can
// still drive build, gate, and ship. A profile may extend this or replace it
// entirely; replacing it with less than the loop needs is an operator's
// right and their gate failure to read.
export const GUARDED_BASELINE_ALLOWED_TOOLS: readonly string[] = [
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(bun:*)",
  "Bash(spec-spine:*)",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
];

// --- the one derivation (B-3) -----------------------------------------------

// Spec 014's hardcoded flag, now derived rather than typed at the spawn site.
export const BYPASS_FLAG = "--dangerously-skip-permissions";
export const PERMISSION_MODE_FLAG = "--permission-mode";
export const GUARDED_PERMISSION_MODE = "acceptEdits";
export const ALLOWED_TOOLS_FLAG = "--allowed-tools";
export const DISALLOWED_TOOLS_FLAG = "--disallowed-tools";

// The effective allowlist of a guarded profile: its own list when it carries
// one, the D-2 baseline when it does not.
export function allowedToolsFor(profile: ExecutionProfile): readonly string[] {
  if (profile.mode !== "guarded") return [];
  return profile.allowedTools ?? GUARDED_BASELINE_ALLOWED_TOOLS;
}

// One flag and its value as one argv element. Every guarded flag is emitted
// this way, and that is what makes B-1's mutual exclusion structural rather
// than conventional: `--allowed-tools` is variadic in the real CLI, so a
// space-separated `--allowed-tools <value>` whose value began with `--` would
// end the list and leave that value to be parsed as a flag in its own right.
// An allowlist entry of "--dangerously-skip-permissions" would then derive
// exactly the argv B-1 forbids. Joined with `=`, an operator's list can only
// ever be read as a value, however absurd its contents.
function flagValue(flag: string, value: string): string {
  return `${flag}=${value}`;
}

// The permission portion of a session's argv, and the only place it is ever
// composed (B-3). For `bypass` the output is byte-identical to spec 014's
// original hardcoded construction, so nothing about today's posture moves
// when this lands.
//
// The tool lists travel as one comma-joined value each: comma separation is
// what the CLI's variadic tool flags accept alongside repetition, and one
// value keeps one flag to one argv element. An effective allowlist that is
// empty emits no flag at all: there is nothing to say, and the write verbs
// refuse to record an empty explicit list rather than leaving that ambiguity
// to argv.
export function sessionArgsForProfile(profile: ExecutionProfile): readonly string[] {
  if (profile.mode === "bypass") return [BYPASS_FLAG];

  const args: string[] = [flagValue(PERMISSION_MODE_FLAG, GUARDED_PERMISSION_MODE)];
  const allowed = allowedToolsFor(profile);
  if (allowed.length > 0) args.push(flagValue(ALLOWED_TOOLS_FLAG, allowed.join(",")));
  const disallowed = profile.disallowedTools ?? [];
  if (disallowed.length > 0) args.push(flagValue(DISALLOWED_TOOLS_FLAG, disallowed.join(",")));
  return args;
}

// --- payload codec (B-2, B-5) -----------------------------------------------

// The profile as it rides in a journal payload: the mode plus both lists,
// explicit nulls rather than absent keys, so a reader never has to tell
// "omitted" from "empty" (spec 011's canonical payloads keep either faithfully,
// but only one of them reads unambiguously).
export function profilePayload(profile: ExecutionProfile): Record<string, JsonValue> {
  return {
    mode: profile.mode,
    allowedTools: profile.allowedTools === undefined ? null : [...profile.allowedTools],
    disallowedTools: profile.disallowedTools === undefined ? null : [...profile.disallowedTools],
    models: sessionModelsPayload(profile.models),
  };
}

function stringList(value: JsonValue | undefined, field: string, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`profile: ${label} expected a string array or null for "${field}"`);
  }
  return value as string[];
}

// Reads a profile back out of a payload. A malformed one throws a typed
// error rather than degrading to a default: a posture that cannot be read is
// not a posture anyone should be driven under.
export function parseProfile(value: JsonValue | undefined, label: string): ExecutionProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`profile: ${label} expected a JSON object`);
  }
  const o = value as Record<string, JsonValue>;
  const mode = o.mode;
  if (typeof mode !== "string" || !isExecutionMode(mode)) {
    throw new Error(`profile: ${label} expected mode "bypass" or "guarded", got ${JSON.stringify(mode)}`);
  }
  const allowedTools = stringList(o.allowedTools, "allowedTools", label);
  const disallowedTools = stringList(o.disallowedTools, "disallowedTools", label);
  // A pre-040 record has no `models` key at all, which parses to undefined and
  // folds to the default pair. A half-written one throws (040 FR-004).
  const models = parseSessionModels(o.models, label);
  return {
    mode,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(models === undefined ? {} : { models }),
  };
}

// --- write-verb validation --------------------------------------------------

// What the CLI and the API refuse before appending (B-2's "chosen, journaled,
// displayed"): a bypass profile carrying tool lists it can never honor, and a
// guarded profile whose explicit allowlist is empty, which would derive an
// argv indistinguishable from "no allowlist at all". Returns null when the
// profile is recordable, the operator-facing reason when it is not.
export function profileRefusal(profile: ExecutionProfile): string | null {
  // Note the model pair is not checked here: it is orthogonal to the mode,
  // and its own half-a-pair refusal is 040's sessionModelsRefusal, applied by
  // the write surface before it ever assembles a profile.
  if (profile.mode === "bypass") {
    if (profile.allowedTools !== undefined || profile.disallowedTools !== undefined) {
      return "a bypass profile carries no tool lists (bypass skips permissions entirely); use guarded to constrain tools";
    }
    return null;
  }
  if (profile.allowedTools !== undefined && profile.allowedTools.length === 0) {
    return "a guarded profile needs at least one allowed tool; omit the allowlist to take the guarded baseline";
  }
  return null;
}

// --- rendering (B-6) --------------------------------------------------------

// The posture as one short cell, for every surface that names the project.
// A legacy-derived bypass is distinguishable from an operator-set one, and
// no surface ever renders a blank: an absent profile is impossible by
// construction (the fold always produces one).
export function renderProfile(profile: RecordedProfile): string {
  if (profile.mode === "bypass") return profile.legacy ? "bypass (legacy)" : "bypass";
  const allowed = allowedToolsFor(profile);
  const baseline = profile.allowedTools === undefined ? " baseline" : "";
  const denied = profile.disallowedTools?.length ? `, ${profile.disallowedTools.length} denied` : "";
  return `guarded (${allowed.length}${baseline} tools${denied})`;
}
