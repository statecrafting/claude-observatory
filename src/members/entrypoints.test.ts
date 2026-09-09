// Spec 042 FR-002 through FR-005: the entrypoints as processes. Every test
// here spawns `bun` on a source entrypoint, argv only, no shell (B-7); the
// build test additionally runs the compiled binaries B-1 produces.
import { test, expect } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { createApiServer } from "../orchestrator/api/server";
import { fixtureApiDeps, freshRegistry, seedRun } from "../orchestrator/api/fixtures";
import {
  DRIVER_MANIFEST,
  ENGINE_MANIFEST,
  MANIFEST_FLAG,
  MEMBER_MANIFESTS,
  SENSOR_MANIFEST,
  memberBinaryPath,
  type MemberManifest,
} from "./manifest";

const ROOT = join(import.meta.dir, "..", "..");

const ENTRYPOINTS: Record<string, string> = {
  [SENSOR_MANIFEST.name]: "src/members/sensor.ts",
  [ENGINE_MANIFEST.name]: "src/members/engine.ts",
  [DRIVER_MANIFEST.name]: "src/members/driver.ts",
};

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn([...cmd], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const viaEntrypoint = (manifest: MemberManifest, args: readonly string[]) =>
  run(["bun", ENTRYPOINTS[manifest.name]!, ...args]);
const viaObservatory = (args: readonly string[]) => run(["bun", "src/index.ts", ...args]);

// An address nothing listens on, so the engine answers with the unreachable
// envelope (023 B-3) and nothing in the test depends on a daemon.
const DEAD_URL = "http://127.0.0.1:1";

// One verb per member that is deterministic and side-effect free: `daemon
// plist` prints text and touches nothing; `orchestrator status --json` is an
// envelope either way; `models` reads a constant.
const PROBE: Record<string, readonly string[]> = {
  [SENSOR_MANIFEST.name]: ["daemon", "plist"],
  [ENGINE_MANIFEST.name]: ["orchestrator", "status", "--json", "--url", DEAD_URL],
  [DRIVER_MANIFEST.name]: ["models", "--json"],
};

// A verb that belongs to another member, per member.
const FOREIGN: Record<string, string> = {
  [SENSOR_MANIFEST.name]: "orchestrator",
  [ENGINE_MANIFEST.name]: "watch",
  [DRIVER_MANIFEST.name]: "orchestrator",
};

function usageExitOf(manifest: MemberManifest): number {
  const entry = Object.entries(manifest.exitCodes).find(([, meaning]) => meaning.includes("usage"));
  if (entry === undefined) throw new Error(`${manifest.name} declares no usage code`);
  return Number(entry[0]);
}

function parseSingleObject(stdout: string): unknown {
  // Exactly one JSON object: the text parses as a whole, and it has one
  // top-level value. A second object or a stray human line would fail either.
  const parsed: unknown = JSON.parse(stdout);
  expect(typeof parsed).toBe("object");
  expect(stdout.trimEnd().split("\n").filter((l) => l.startsWith("{")).length).toBeLessThanOrEqual(1);
  return parsed;
}

// --- FR-002: the manifest flag ----------------------------------------------

for (const manifest of MEMBER_MANIFESTS) {
  test(`FR-002: ${manifest.name} answers ${MANIFEST_FLAG} with its declaration and nothing else`, async () => {
    const ran = await viaEntrypoint(manifest, [MANIFEST_FLAG]);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe("");
    expect(JSON.parse(ran.stdout)).toEqual(manifest);
  });

  test(`FR-002: ${manifest.name} answers ${MANIFEST_FLAG} before a malformed flag placed ahead of it`, async () => {
    const ran = await viaEntrypoint(manifest, ["--definitely-not-a-flag", "nonsense", MANIFEST_FLAG]);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe("");
    expect(JSON.parse(ran.stdout)).toEqual(manifest);
  });
}

// --- FR-003: routing -------------------------------------------------------

for (const manifest of MEMBER_MANIFESTS) {
  test(`FR-003: ${manifest.name}'s probe verb is byte-identical through the entrypoint and through observatory`, async () => {
    const args = PROBE[manifest.name]!;
    const [direct, member] = await Promise.all([viaObservatory(args), viaEntrypoint(manifest, args)]);
    expect(member.stdout).toBe(direct.stdout);
    expect(member.code).toBe(direct.code);
  });

  test(`FR-003: ${manifest.name} refuses another member's verb with its usage code, unexecuted`, async () => {
    const foreign = FOREIGN[manifest.name]!;
    expect(manifest.verbs).not.toContain(foreign);
    const ran = await viaEntrypoint(manifest, [foreign, "--json"]);
    expect(ran.code).toBe(usageExitOf(manifest));
    expect(ran.stdout).toContain("usage: observatory <command>");
    // Not executed: the engine's `status` would have printed an envelope, the
    // sensor's `watch` would still be running.
    expect(ran.stdout).not.toContain('"ok"');
  });
}

// --- FR-005: stdout hygiene ------------------------------------------------

test("FR-005: the engine's --json verb writes exactly one JSON object to stdout", async () => {
  const ran = await viaEntrypoint(ENGINE_MANIFEST, PROBE[ENGINE_MANIFEST.name]!);
  const parsed = parseSingleObject(ran.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(false);
  expect(ran.code).toBe(2);
});

test("FR-005: the driver's --json verb writes exactly one JSON object to stdout and nothing to stderr", async () => {
  const ran = await viaEntrypoint(DRIVER_MANIFEST, PROBE[DRIVER_MANIFEST.name]!);
  const parsed = parseSingleObject(ran.stdout) as { ok: boolean; data: { strong: string } };
  expect(parsed.ok).toBe(true);
  expect(typeof parsed.data.strong).toBe("string");
  expect(ran.stderr).toBe("");
  expect(ran.code).toBe(0);
});

test("FR-005 (D-9): the sensor's one JSON surface is the manifest, and it is one object", async () => {
  const ran = await viaEntrypoint(SENSOR_MANIFEST, [MANIFEST_FLAG]);
  parseSingleObject(ran.stdout);
  expect(ran.stderr).toBe("");
});

// --- FR-004 and AC-4: the compiled binaries --------------------------------

test("FR-004: each build target produces a binary that answers the manifest the unit test saw", async () => {
  for (const manifest of MEMBER_MANIFESTS) {
    const script = `build:member:${manifest.name === ENGINE_MANIFEST.name ? "engine" : manifest.name === SENSOR_MANIFEST.name ? "sensor" : "driver"}`;
    const built = await run(["bun", "run", script]);
    expect(built.code).toBe(0);
    const binary = join(ROOT, memberBinaryPath(manifest));
    expect(fs.existsSync(binary)).toBe(true);
    fs.accessSync(binary, fs.constants.X_OK);
    const ran = await run([binary, MANIFEST_FLAG]);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe("");
    expect(JSON.parse(ran.stdout)).toEqual(manifest);
  }
}, 120_000);

test("AC-4: the compiled engine's `orchestrator status --json` is byte-identical to observatory's against one fixture daemon", async () => {
  const registry = freshRegistry("member-ac4");
  const world = registry.add("alpha");
  seedRun(world);
  // A pinned clock: `status` reports the daemon's `nowMs`, and two requests a
  // millisecond apart would differ there without the outputs differing at all.
  const server = createApiServer(
    fixtureApiDeps(registry, { pumpIntervalMs: 60_000, clock: { now: () => 1_700_000_000_000 } })
  );
  try {
    const binary = join(ROOT, memberBinaryPath(ENGINE_MANIFEST));
    if (!fs.existsSync(binary)) {
      const built = await run(["bun", "run", "build:member:engine"]);
      expect(built.code).toBe(0);
    }
    const args = ["orchestrator", "status", "--json", "--url", server.url];
    const [direct, compiled] = await Promise.all([viaObservatory(args), run([binary, ...args])]);
    expect(direct.code).toBe(0);
    expect(compiled.code).toBe(0);
    expect(compiled.stdout).toBe(direct.stdout);
    const envelope = JSON.parse(direct.stdout) as { ok: boolean };
    expect(envelope.ok).toBe(true);
  } finally {
    await server.stop();
    registry.close();
  }
}, 120_000);
