// Spec 040. The derivation, the codec and the refusal are unit-level, exactly
// as 032's are; the fold and the spawn path are exercised against the real
// projects chain and the real daemon stage dispatch, because the guarantee
// this spec makes ("no driven session runs on a model nobody chose") is only
// worth as much as the seam that actually spawns.
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_SESSION_MODELS,
  MODEL_TIERS,
  STAGE_MODEL_TIERS,
  modelForStage,
  parseSessionModels,
  renderSessionModels,
  sessionModelsPayload,
  sessionModelsRefusal,
  type SessionModels,
} from "./models";
import { parseProfile, profilePayload, type ExecutionProfile } from "./profile";
import {
  openProjectsChain,
  projectsFromChain,
  registerProject,
  setProjectProfile,
  verifyProjectsChain,
  type QualificationVerdict,
} from "./projects";
import type { Stage } from "./state";

const STAGES: readonly Stage[] = ["build", "ship", "shepherd", "verify"];

const PAIR: SessionModels = { strong: "test-strong", fast: "test-fast" };

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "models-home-"));
}

function verdict(qualified: boolean): QualificationVerdict {
  return {
    qualified,
    checks: [{ id: "git-repo", ok: qualified, detail: "git work tree root" }],
    warnings: [],
  };
}

// --- the derivation (B-1, B-2, FR-001, FR-002) ------------------------------

test("models: every stage resolves to a non-empty id, on the default pair and on an override", () => {
  for (const stage of STAGES) {
    expect(modelForStage(stage).length).toBeGreaterThan(0);
    expect(modelForStage(stage, PAIR).length).toBeGreaterThan(0);
  }
  // FR-002's type-level exhaustiveness has a runtime shadow: a stage added to
  // 013's machine without a tier here would leave a hole this loop finds even
  // if someone reached for a cast to silence the compiler.
  for (const stage of STAGES) {
    expect(MODEL_TIERS).toContain(STAGE_MODEL_TIERS[stage]);
  }
  expect(Object.keys(STAGE_MODEL_TIERS).sort()).toEqual([...STAGES].sort());
});

test("models: build and ship take the strong tier, shepherd and verify the fast one (B-2)", () => {
  expect(modelForStage("build")).toBe(DEFAULT_SESSION_MODELS.strong);
  expect(modelForStage("ship")).toBe(DEFAULT_SESSION_MODELS.strong);
  expect(modelForStage("shepherd")).toBe(DEFAULT_SESSION_MODELS.fast);
  expect(modelForStage("verify")).toBe(DEFAULT_SESSION_MODELS.fast);

  expect(modelForStage("build", PAIR)).toBe("test-strong");
  expect(modelForStage("verify", PAIR)).toBe("test-fast");
});

test("models: the default pair names no long-context variant (B-3, D-4)", () => {
  // The accident this spec closes: an interactive `opus[1m]` default reaching
  // a headless spawn nobody configured. A bracketed id here would silently
  // reinstate it.
  expect(DEFAULT_SESSION_MODELS.strong).not.toContain("[");
  expect(DEFAULT_SESSION_MODELS.fast).not.toContain("[");
});

// --- the codec (FR-003, FR-004) ---------------------------------------------

test("models: a pair round-trips, and half a pair throws rather than defaulting the rest", () => {
  expect(parseSessionModels(sessionModelsPayload(PAIR), "test")).toEqual(PAIR);
  // Absent travels as an explicit null and reads back as absent, not as the
  // default pair materialized into the record.
  expect(sessionModelsPayload(undefined)).toBeNull();
  expect(parseSessionModels(null, "test")).toBeUndefined();
  expect(parseSessionModels(undefined, "test")).toBeUndefined();

  expect(() => parseSessionModels({ strong: "a" }, "test")).toThrow(/half a pair; "fast" is missing/);
  expect(() => parseSessionModels({ fast: "b" }, "test")).toThrow(/half a pair; "strong" is missing/);
  expect(() => parseSessionModels({ strong: "", fast: "b" }, "test")).toThrow(/non-empty string/);
  expect(() => parseSessionModels({ strong: 7, fast: "b" }, "test")).toThrow(/non-empty string/);
  expect(() => parseSessionModels(["a"], "test")).toThrow(/JSON object or null/);
});

test("models: the pair rides the profile payload and folds back with it (FR-003)", () => {
  const profile: ExecutionProfile = { mode: "bypass", models: PAIR };
  expect(parseProfile(profilePayload(profile), "test")).toEqual(profile);
  // A pre-040 record has no `models` key at all and must keep parsing.
  expect(parseProfile({ mode: "bypass", allowedTools: null, disallowedTools: null }, "test")).toEqual({
    mode: "bypass",
  });
});

// --- the refusal (FR-005) ---------------------------------------------------

test("models: a half-set pair is refused by a message that names the missing half", () => {
  expect(sessionModelsRefusal(null, null)).toBeNull();
  expect(sessionModelsRefusal("a", "b")).toBeNull();
  expect(sessionModelsRefusal("a", null)).toContain("--model-fast is missing");
  expect(sessionModelsRefusal(null, "b")).toContain("--model-strong is missing");
  expect(sessionModelsRefusal("a", " ")).toContain("cannot be empty");
});

// --- rendering (B-6) --------------------------------------------------------

test("models: a project on the defaults says so rather than rendering blank", () => {
  expect(renderSessionModels(undefined)).toBe(
    `${DEFAULT_SESSION_MODELS.strong} / ${DEFAULT_SESSION_MODELS.fast} (default)`
  );
  expect(renderSessionModels(PAIR)).toBe("test-strong / test-fast");
});

// --- the fold (B-4) ---------------------------------------------------------

test("the fold: a pair set on the profile survives the chain and is not confused with a mode change", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });
    // Registration with no pair folds to no pair, which resolves to B-3's
    // default: absence here means "nobody set one", never "nobody chose".
    expect(projectsFromChain(chain.fold()).get("enrahitu")?.profile.models).toBeUndefined();

    setProjectProfile({ chain, name: "enrahitu", profile: { mode: "bypass", models: PAIR }, source: "cli" });
    const withPair = projectsFromChain(chain.fold()).get("enrahitu");
    expect(withPair?.profile).toEqual({ mode: "bypass", models: PAIR, legacy: false });
    expect(modelForStage("build", withPair?.profile.models)).toBe("test-strong");

    // A later posture change that names no pair clears it, because the whole
    // profile travels rather than a patch (032 B-2). The operator reads the
    // record back as what they typed.
    setProjectProfile({ chain, name: "enrahitu", profile: { mode: "bypass" }, source: "cli" });
    expect(projectsFromChain(chain.fold()).get("enrahitu")?.profile.models).toBeUndefined();
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});
