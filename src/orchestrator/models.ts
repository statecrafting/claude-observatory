// Session models (spec 040): which model a driven session runs on, chosen per
// stage instead of inherited from whatever the CLI resolves at spawn time.
//
// Spec 014 has always accepted an optional model and appended `--model` when
// one was given. Nothing ever gave one. The consequence was not that sessions
// ran badly; it was that nobody could say what they ran on. `session.init`'s
// `model` field was null for every session the journal holds, while the
// transcripts of a driven run show hundreds of assistant turns on a model no
// part of this system selected.
//
// This module is the counterpart of profile.ts. The invariants mirror it:
//
//   B-1: modelForStage() is the only place a `--model` value is produced.
//   Nothing composes one by hand, and no spawn path omits one.
//
//   B-2: the stage-to-tier map is data. A tier is a role ("strong", "fast"),
//   not a model id, so moving a project between models never edits the map.
//
//   B-4: a project's override travels as a complete pair or not at all. Half
//   a pair would make a stage's effective model a function of two sources,
//   which is the unpredictability this spec exists to remove.
import type { JsonValue } from "./journal";
import type { Stage } from "./state";

// --- tiers (B-2) ------------------------------------------------------------

export const MODEL_TIERS = ["strong", "fast"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export interface SessionModels {
  readonly strong: string;
  readonly fast: string;
}

// Which tier each stage spawns under. `Record<Stage, ModelTier>` rather than a
// lookup with a fallback: a stage added to 013's machine without a tier here
// fails to compile, which is FR-002 and the reason this is not a Map.
//
// build and ship write code and argue with the governance gate; shepherd
// watches CI and verify reads assertion output. The split follows that, not
// the stage ordering.
export const STAGE_MODEL_TIERS: Readonly<Record<Stage, ModelTier>> = {
  build: "strong",
  ship: "strong",
  shepherd: "fast",
  verify: "fast",
};

// --- the default pair (B-3) -------------------------------------------------

// Moved to the driver member by spec 043 (D-7): the engine never names a
// model id. It passes a tier, and the driver resolves it against the
// project's pair or its own default. `tierForStage` is what the engine
// keeps; the ids live in src/members/driver-session.ts.
export function tierForStage(stage: Stage): ModelTier {
  return STAGE_MODEL_TIERS[stage];
}

// --- payload codec (B-4, B-5) -----------------------------------------------

// The pair as it rides in a journal payload, or an explicit null when the
// project carries none. Explicit null rather than an absent key, for the
// reason profilePayload gives: a reader should never have to tell "omitted"
// from "empty".
export function sessionModelsPayload(models: SessionModels | undefined): JsonValue {
  if (models === undefined) return null;
  return { strong: models.strong, fast: models.fast };
}

function modelId(value: JsonValue | undefined, field: string, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`models: ${label} expected a non-empty string for "${field}"`);
  }
  return value;
}

// Reads a pair back out of a payload. A half-written pair throws rather than
// defaulting the missing half (FR-004): a profile that cannot be read as it
// was written is not a profile anyone should be driven under, which is the
// same judgment parseProfile makes about a malformed posture.
export function parseSessionModels(value: JsonValue | undefined, label: string): SessionModels | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`models: ${label} expected a JSON object or null`);
  }
  const o = value as Record<string, JsonValue>;
  const strong = modelId(o.strong, "strong", label);
  const fast = modelId(o.fast, "fast", label);
  if (strong === undefined && fast === undefined) return undefined;
  const missing = strong === undefined ? "strong" : fast === undefined ? "fast" : null;
  if (missing !== null) {
    throw new Error(`models: ${label} carries half a pair; "${missing}" is missing`);
  }
  return { strong: strong as string, fast: fast as string };
}

// --- write-verb validation (FR-005) -----------------------------------------

// What a write surface refuses before appending: one half of a pair. Returns
// null when the input is recordable, the operator-facing reason when it is
// not. Naming the missing half is the whole value of the message.
export function sessionModelsRefusal(strong: string | null, fast: string | null): string | null {
  if (strong === null && fast === null) return null;
  if (strong === null) return "--model-strong is missing; a model pair is set whole (both halves) or not at all";
  if (fast === null) return "--model-fast is missing; a model pair is set whole (both halves) or not at all";
  if (strong.trim() === "" || fast.trim() === "") return "a model id cannot be empty";
  return null;
}

// --- rendering (B-6) --------------------------------------------------------

// The pair as one short cell, for every surface that renders the posture. A
// project on the defaults says so rather than rendering blank: "nobody chose"
// is the state this spec exists to end, so no surface may look like it.
export function renderSessionModels(models: SessionModels | undefined): string {
  // 043 D-7: the default pair is the driver's; the engine can only say that
  // no override is set. `statecraft driver-claude models` prints the pair.
  if (models === undefined) return "(driver default)";
  return `${models.strong} / ${models.fast}`;
}
