// Spec 043 FR-001, FR-003, FR-004: the engine's side of the seam against a
// fake driver script. Nothing here spawns a provider; the member side is
// driver-session.test.ts, and the two meet in the profile spawn tests.
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "./journal";
import {
  DEGRADED_KIND,
  createProcessDriver,
  killLiveSession,
  parseDriverEvent,
  resolveDriverCommand,
  toWireRequest,
  type SessionResult,
} from "./driver";
import { createBrowserMcpVerifier } from "./stages/verify";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "driver-seam-"));
}

// A driver member stand-in: records the request it was handed, then plays a
// scripted event stream. `--member-manifest` answers with the given tier.
function writeFakeDriver(dir: string, tier: "reference" | "basic", body: string): string {
  const path = join(dir, "fake-driver.sh");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--member-manifest" ]; then',
      `  echo '{"schemaVersion":"1","name":"statecraft-driver-fake","version":"0","contract":"042","verbs":["session"],"capabilityTier":"${tier}","exitCodes":{"0":"ok"},"envelope":"ok-data"}'`,
      "  exit 0",
      "fi",
      `printf 'argv:%s\\n' "$*" > "${join(dir, "argv")}"`,
      `cat > "${join(dir, "request.json")}"`,
      body,
    ].join("\n") + "\n"
  );
  chmodSync(path, 0o755);
  return path;
}

const COMPLETED_RESULT: SessionResult = {
  classification: { kind: "completed", resetAtMs: null, detail: "result event: success" },
  exitCode: 0,
  durationMs: 12,
  numTurns: 2,
  costMicroUsd: 12345,
  usage: { input_tokens: 100, output_tokens: 42 },
  sessionId: "sess-1",
  transcriptPath: "/tmp/sess-1.jsonl",
  overflow: { lines: [], truncatedCount: 0 },
  stderrTail: "",
};

const INIT_PAYLOAD = { claudeBin: "claude", repo: "/r", model: "m", maxTurns: null, timeoutMs: 1, sessionId: "sess-1", profile: { mode: "bypass", allowedTools: null, disallowedTools: null, models: null } };
const RESULT_PAYLOAD = { classification: "completed", resetAtMs: null, detail: "result event: success", exitCode: 0 };

function scriptedStream(): string {
  return [
    `echo '${JSON.stringify({ event: "journal", kind: "session.init", payload: INIT_PAYLOAD })}'`,
    `echo '${JSON.stringify({ event: "stream", raw: { type: "system", subtype: "init", session_id: "sess-1" } })}'`,
    `echo '${JSON.stringify({ event: "stream", raw: { type: "assistant" } })}'`,
    "echo 'not an event line'",
    `echo '${JSON.stringify({ event: "journal", kind: "session.result", payload: RESULT_PAYLOAD })}'`,
    `echo '${JSON.stringify({ event: "result", result: COMPLETED_RESULT })}'`,
    "exit 0",
  ].join("\n");
}

// --- FR-001: request out, events in, journal written by the engine ---------

test("FR-001: the request is one JSON object on stdin, argv is `session run`, and stdin is closed", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "reference", scriptedStream());
  const driver = createProcessDriver({ driverBin: bin });
  const sink: unknown[] = [];
  const result = await driver.runSession({
    repo: dir,
    prompt: "hello\nworld",
    tier: "strong",
    maxTurns: 4,
    timeoutMs: 5000,
    profile: { mode: "guarded", allowedTools: ["Read"] },
    sink: (e) => sink.push(e),
  });
  expect(readFileSync(join(dir, "argv"), "utf8")).toBe("argv:session run\n");
  const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
  expect(request).toEqual({
    schemaVersion: "1",
    repo: dir,
    prompt: "hello\nworld",
    tier: "strong",
    model: null,
    maxTurns: 4,
    timeoutMs: 5000,
    mcpConfigPath: null,
    profile: { mode: "guarded", allowedTools: ["Read"], disallowedTools: null, models: null },
    killGraceMs: null,
  });
  // Every stream event reached the sink verbatim; the stray line did not.
  expect(sink).toEqual([{ type: "system", subtype: "init", session_id: "sess-1" }, { type: "assistant" }]);
  expect(result).toEqual(COMPLETED_RESULT);
});

test("FR-001: journal events are appended by the engine with their payloads intact, in order", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "reference", scriptedStream());
  const journal = openJournal(dir, "orchestrator");
  try {
    const driver = createProcessDriver({ driverBin: bin });
    await driver.runSession({ repo: dir, prompt: "hi", journal });
    const records = journal.fold().records.map((r) => ({ kind: r.kind, payload: r.payload }));
    expect(records).toEqual([
      { kind: "session.init", payload: INIT_PAYLOAD },
      { kind: "session.result", payload: RESULT_PAYLOAD },
    ]);
  } finally {
    journal.close();
  }
});

test("toWireRequest and parseDriverEvent are inverses of what the member writes", () => {
  const wire = toWireRequest({ repo: "/r", prompt: "p" });
  expect(wire.schemaVersion).toBe("1");
  expect(wire.profile).toBeNull();
  expect(parseDriverEvent("{}")).toBeNull();
  expect(parseDriverEvent("nope")).toBeNull();
  expect(parseDriverEvent('{"event":"stream","raw":1}')).toEqual({ event: "stream", raw: 1 });
  expect(parseDriverEvent('{"event":"journal","kind":"k"}')).toBeNull();
});

// --- FR-003: kill and deadline ----------------------------------------------

test("FR-003: killLiveSession severs the member with SIGTERM and the result is `killed`", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(
    dir,
    "reference",
    [
      `echo '${JSON.stringify({ event: "journal", kind: "session.init", payload: INIT_PAYLOAD })}'`,
      `trap 'echo signalled > "${join(dir, "signal")}"; kill $child; exit 143' TERM`,
      "sleep 30 & child=$!; wait $child",
    ].join("\n")
  );
  const journal = openJournal(dir, "orchestrator");
  try {
    const driver = createProcessDriver({ driverBin: bin });
    const running = driver.runSession({ repo: dir, prompt: "hi", journal, killGraceMs: 500 });
    // Let the member start and write its init line before severing.
    await Bun.sleep(300);
    expect(killLiveSession()).toBe(true);
    const result = await running;
    expect(result.classification.kind).toBe("killed");
    expect(result.classification.detail).toContain("severed by the engine");
    expect(readFileSync(join(dir, "signal"), "utf8").trim()).toBe("signalled");
    const kinds = journal.fold().records.map((r) => r.kind);
    expect(kinds).toEqual(["session.init", "session.result"]);
    expect(driver.killLiveSession()).toBe(false);
  } finally {
    journal.close();
  }
}, 10_000);

test("FR-003: a member that never writes `result` is killed at the deadline plus grace and classified `crashed`", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "reference", "sleep 30 & wait $!");
  const driver = createProcessDriver({ driverBin: bin, deadlineSlackMs: 100 });
  const result = await driver.runSession({ repo: dir, prompt: "hi", timeoutMs: 200, killGraceMs: 100 });
  expect(result.classification.kind).toBe("crashed");
  expect(result.classification.detail).toContain("no result within the deadline");
}, 10_000);

test("a member that exits without a result is `crashed` with its exit code and stderr in the record", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "reference", "echo 'boom' >&2\nexit 1");
  const driver = createProcessDriver({ driverBin: bin });
  const result = await driver.runSession({ repo: dir, prompt: "hi" });
  expect(result.classification.kind).toBe("crashed");
  expect(result.classification.detail).toContain("exited 1 without a result");
  expect(result.stderrTail).toContain("boom");
});

// --- FR-004: degradation ------------------------------------------------------

test("FR-004: a basic driver is never spawned for an mcp-config request; the degradation is journaled", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "basic", scriptedStream());
  const journal = openJournal(dir, "orchestrator");
  try {
    const driver = createProcessDriver({ driverBin: bin });
    expect(await driver.tier()).toBe("basic");
    const result = await driver.runSession({ repo: dir, prompt: "hi", mcpConfigPath: "/x/mcp.json", journal });
    expect(result.classification.kind).toBe("crashed");
    expect(result.classification.detail).toContain("mcp-config");
    let spawned = true;
    try {
      readFileSync(join(dir, "request.json"));
    } catch {
      spawned = false;
    }
    expect(spawned).toBe(false);
    const records = journal.fold().records.map((r) => ({ kind: r.kind, payload: r.payload }));
    expect(records[0]).toEqual({ kind: DEGRADED_KIND, payload: { driver: "claude", tier: "basic", feature: "mcp-config" } });
    expect(records[1]?.kind).toBe("session.result");
  } finally {
    journal.close();
  }
});

test("FR-004: the browser verifier reports a degraded assertion as not passed, naming the feature", async () => {
  const dir = freshDir();
  const bin = writeFakeDriver(dir, "basic", scriptedStream());
  const verifier = createBrowserMcpVerifier({
    repo: dir,
    driver: createProcessDriver({ driverBin: bin }),
    profile: { mode: "bypass" },
  });
  const verdict = await verifier.assert("http://127.0.0.1:1/", "the page says hello");
  expect(verdict.pass).toBe(false);
  expect(verdict.detail).toContain("mcp-config");
});

// --- B-5: discovery --------------------------------------------------------------

test("B-5: STATECRAFT_DRIVER_BIN wins, then the managed directory, then PATH, then the checkout", () => {
  const dir = freshDir();
  const managed = join(dir, "managed");
  const onPath = join(dir, "path");
  for (const d of [managed, onPath]) {
    Bun.spawnSync(["mkdir", "-p", d]);
  }
  const explicit = resolveDriverCommand("claude", { STATECRAFT_DRIVER_BIN: "/x/driver", PATH: "" });
  expect(explicit).toEqual({ argv: ["/x/driver"], location: "explicit" });

  const managedBin = join(managed, "statecraft-driver-claude");
  writeFileSync(managedBin, "#!/bin/sh\n");
  chmodSync(managedBin, 0o755);
  const pathBin = join(onPath, "statecraft-driver-claude");
  writeFileSync(pathBin, "#!/bin/sh\n");
  chmodSync(pathBin, 0o755);
  expect(resolveDriverCommand("claude", { STATECRAFT_MEMBER_DIR: managed, PATH: onPath })).toEqual({
    argv: [managedBin],
    location: "managed",
  });
  expect(resolveDriverCommand("claude", { STATECRAFT_MEMBER_DIR: join(dir, "empty"), PATH: onPath })).toEqual({
    argv: [pathBin],
    location: "path",
  });
  // Nothing installed: from this checkout the member entrypoint runs under bun.
  const source = resolveDriverCommand("claude", { STATECRAFT_MEMBER_DIR: join(dir, "empty"), PATH: "" });
  expect(source?.location).toBe("source");
  expect(source?.argv[1]).toEndWith("src/members/driver.ts");
  expect(resolveDriverCommand("nonesuch", { STATECRAFT_MEMBER_DIR: join(dir, "empty"), PATH: "" })).toBeNull();
});
