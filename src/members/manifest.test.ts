// Spec 042 FR-001: the three declarations, checked as data before any
// process is spawned.
import { test, expect } from "bun:test";
import {
  DRIVER_MANIFEST,
  ENGINE_MANIFEST,
  MEMBER_CONTRACT,
  MEMBER_MANIFESTS,
  SENSOR_MANIFEST,
  UMBRELLA_EXIT_FLOOR,
  memberBinaryPath,
  scopeOf,
  serializeManifest,
} from "./manifest";
import pkg from "../../package.json";

// B-1's output paths, as the build scripts write them. The names are the
// umbrella's discovery keys, so the test spells them out rather than deriving
// them from the declaration it is checking.
const BUILD_OUTPUTS: Record<string, string> = {
  "build:member:sensor": "dist/statecraft-sensor-claude",
  "build:member:engine": "dist/statecraft-engine",
  "build:member:driver": "dist/statecraft-driver-claude",
};

test("FR-001: every manifest serializes to one JSON object that parses back to itself", () => {
  for (const manifest of MEMBER_MANIFESTS) {
    const text = serializeManifest(manifest);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(text)).toEqual(manifest);
  }
});

test("FR-001: every manifest carries the contract id, the package version and the schema", () => {
  for (const manifest of MEMBER_MANIFESTS) {
    expect(manifest.contract).toBe(MEMBER_CONTRACT);
    expect(manifest.contract).toBe("042");
    expect(manifest.schemaVersion).toBe("1");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.envelope).toBe("ok-data");
  }
});

test("FR-001: every manifest names its binary exactly as B-1 builds it", () => {
  const scripts = pkg.scripts as Record<string, string>;
  for (const [script, output] of Object.entries(BUILD_OUTPUTS)) {
    expect(scripts[script]).toBeDefined();
    expect(scripts[script]).toContain("bun build --compile");
    expect(scripts[script]).toContain(`--outfile ${output}`);
  }
  const built = new Set(Object.values(BUILD_OUTPUTS));
  for (const manifest of MEMBER_MANIFESTS) {
    expect(built.has(memberBinaryPath(manifest))).toBe(true);
  }
});

test("FR-001: every manifest declares a non-empty verb set, and the names are distinct", () => {
  for (const manifest of MEMBER_MANIFESTS) {
    expect(manifest.verbs.length).toBeGreaterThan(0);
    expect(new Set(manifest.verbs).size).toBe(manifest.verbs.length);
  }
  const names = MEMBER_MANIFESTS.map((m) => m.name);
  expect(new Set(names).size).toBe(names.length);
});

test("B-6: no member declares a code at or above the umbrella's floor", () => {
  for (const manifest of MEMBER_MANIFESTS) {
    for (const code of Object.keys(manifest.exitCodes)) {
      expect(Number(code)).toBeLessThan(UMBRELLA_EXIT_FLOOR);
    }
  }
});

test("B-6, B-8: the engine and driver carry 023 D-4's taxonomy; the tiers are declared", () => {
  const taxonomy = { "0": "ok", "1": "operational", "2": "unreachable", "3": "usage" };
  expect(ENGINE_MANIFEST.exitCodes).toEqual(taxonomy);
  expect(DRIVER_MANIFEST.exitCodes).toEqual(taxonomy);
  expect(DRIVER_MANIFEST.capabilityTier).toBe("reference");
  expect(ENGINE_MANIFEST.capabilityTier).toBe("basic");
  expect(SENSOR_MANIFEST.capabilityTier).toBe("basic");
});

test("B-2: a member's scope carries its verbs and its own usage code", () => {
  expect(scopeOf(ENGINE_MANIFEST).usageExit).toBe(3);
  expect(scopeOf(DRIVER_MANIFEST).usageExit).toBe(3);
  expect(scopeOf(SENSOR_MANIFEST).usageExit).toBe(1);
  expect([...scopeOf(SENSOR_MANIFEST).verbs]).toEqual([...SENSOR_MANIFEST.verbs]);
});
