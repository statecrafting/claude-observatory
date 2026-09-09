// Spec 043 FR-002 and B-3: the driver member's `session run` as a process,
// over spec 014's own fake-claude convention, and the byte-identity of what
// it forwards against what runSession journals in-process.
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSession } from "../orchestrator/session";
import { createProcessDriver } from "../orchestrator/driver";
import { openJournal } from "../orchestrator/journal";
import type { JsonValue } from "../orchestrator/journal";
import { DEFAULT_SESSION_MODELS, forwardingJournal, parseRequest, resolveModel } from "./driver-session";

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "src", "members", "driver.ts");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "driver-session-"));
}

function writeFakeClaude(dir: string, body: string): string {
  const path = join(dir, "fake-claude.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const COMPLETED = [
  'echo \'{"type":"system","subtype":"init","session_id":"sess-seam"}\'',
  'echo \'{"type":"assistant","message":{"role":"assistant","content":[]}}\'',
  'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE","total_cost_usd":0.012345,"usage":{"input_tokens":100,"output_tokens":42},"num_turns":2,"session_id":"sess-seam"}\'',
  "exit 0",
].join("\n");

const QUOTA = [
  'echo \'{"type":"system","subtype":"init","session_id":"sess-quota"}\'',
  'echo \'{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You have hit your usage limit. Your limit will reset at 3pm (UTC).","session_id":"sess-quota"}\'',
  "exit 1",
].join("\n");

interface Ran {
  readonly code: number;
  readonly lines: string[];
  readonly stderr: string;
}

async function runVerb(dir: string, claudeBin: string, request: unknown, args: readonly string[] = ["session", "run"]): Promise<Ran> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, STATECRAFT_CLAUDE_BIN: claudeBin, NO_COLOR: "1" },
  });
  proc.stdin.write(typeof request === "string" ? request : JSON.stringify(request));
  await proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, lines: stdout.split("\n").filter((l) => l.length > 0), stderr };
}

function request(repo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: "1", repo, prompt: "reply DONE", tier: "strong", ...extra };
}

// --- FR-002 ---------------------------------------------------------------------

test("FR-002: a completed session writes journal, stream, journal, result in order and exits 0", async () => {
  const dir = freshDir();
  const ran = await runVerb(dir, writeFakeClaude(dir, COMPLETED), request(dir, { timeoutMs: 10_000 }));
  expect(ran.stderr).toBe("");
  expect(ran.code).toBe(0);
  const events = ran.lines.map((l) => JSON.parse(l) as { event: string; kind?: string; raw?: { type: string }; result?: { classification: { kind: string } } });
  // The sink sees the provider's init event before 014 journals it, so the
  // first stream line precedes the first journal line, as it always has.
  expect(events.map((e) => e.event)).toEqual(["stream", "journal", "stream", "stream", "journal", "result"]);
  expect(events[1]!.kind).toBe("session.init");
  expect(events[4]!.kind).toBe("session.result");
  expect(events.filter((e) => e.event === "stream").map((e) => e.raw!.type)).toEqual(["system", "assistant", "result"]);
  expect(events[5]!.result!.classification.kind).toBe("completed");
});

test("FR-002: a quota park and a timeout are answers, not driver failures: exit 0 either way", async () => {
  const dir = freshDir();
  const quota = await runVerb(dir, writeFakeClaude(dir, QUOTA), request(dir));
  expect(quota.code).toBe(0);
  const quotaResult = JSON.parse(quota.lines.at(-1)!) as { event: string; result: { classification: { kind: string; resetAtMs: number | null } } };
  expect(quotaResult.event).toBe("result");
  expect(quotaResult.result.classification.kind).toBe("quota");

  const slow = await runVerb(dir, writeFakeClaude(dir, "exec sleep 30"), request(dir, { timeoutMs: 200, killGraceMs: 100 }));
  expect(slow.code).toBe(0);
  const slowResult = JSON.parse(slow.lines.at(-1)!) as { result: { classification: { kind: string } } };
  expect(slowResult.result.classification.kind).toBe("timeout");
}, 15_000);

test("FR-002: a request that does not parse is usage (exit 3) with nothing on stdout", async () => {
  const dir = freshDir();
  const claude = writeFakeClaude(dir, COMPLETED);
  const garbage = await runVerb(dir, claude, "not json");
  expect(garbage.code).toBe(3);
  expect(garbage.lines).toEqual([]);
  expect(garbage.stderr).toContain("not JSON");
  const wrongVersion = await runVerb(dir, claude, { schemaVersion: "9", repo: dir, prompt: "x" });
  expect(wrongVersion.code).toBe(3);
  const wrongVerb = await runVerb(dir, claude, request(dir), ["session", "walk"]);
  expect(wrongVerb.code).toBe(3);
});

// --- B-3: byte-identity with the in-process path ----------------------------------

function normalize(records: readonly { kind: string; payload: JsonValue }[]): unknown[] {
  return records.map((r) => {
    const payload = { ...(r.payload as Record<string, JsonValue>) };
    // The one field that legitimately differs between two runs.
    if ("durationMs" in payload) payload.durationMs = 0;
    return { kind: r.kind, payload };
  });
}

test("B-3: the records the engine journals through the seam equal the ones runSession writes in-process", async () => {
  const dir = freshDir();
  const claude = writeFakeClaude(dir, COMPLETED);
  const profile = { mode: "guarded" as const, allowedTools: ["Read"] };

  const inProcess: { kind: string; payload: JsonValue }[] = [];
  await runSession({
    repo: dir,
    prompt: "reply DONE",
    claudeBin: claude,
    model: DEFAULT_SESSION_MODELS.strong,
    maxTurns: 3,
    timeoutMs: 10_000,
    profile,
    journal: forwardingJournal((line) => {
      const parsed = JSON.parse(line) as { kind: string; payload: JsonValue };
      inProcess.push({ kind: parsed.kind, payload: parsed.payload });
    }),
  });

  const journal = openJournal(dir, "orchestrator");
  try {
    const driver = createProcessDriver({ env: { ...process.env, STATECRAFT_CLAUDE_BIN: claude, STATECRAFT_MEMBER_DIR: join(dir, "none"), PATH: "/usr/bin:/bin" } });
    await driver.runSession({ repo: dir, prompt: "reply DONE", tier: "strong", maxTurns: 3, timeoutMs: 10_000, profile, journal });
    const viaSeam = journal.fold().records.map((r) => ({ kind: r.kind, payload: r.payload }));
    expect(normalize(viaSeam)).toEqual(normalize(inProcess));
    expect((viaSeam[0]!.payload as Record<string, JsonValue>).model).toBe(DEFAULT_SESSION_MODELS.strong);
  } finally {
    journal.close();
  }
}, 20_000);

// --- D-7: the model derivation lives here ---------------------------------------------

test("D-7: an explicit id wins, then the project's pair, then the default pair, for the tier", () => {
  expect(resolveModel("strong", "explicit", { strong: "s", fast: "f" })).toBe("explicit");
  expect(resolveModel("fast", null, { strong: "s", fast: "f" })).toBe("f");
  expect(resolveModel("strong", null, undefined)).toBe(DEFAULT_SESSION_MODELS.strong);
  expect(resolveModel(null, null, undefined)).toBeUndefined();
  const parsed = parseRequest(JSON.stringify(request("/r", { profile: { mode: "bypass", allowedTools: null, disallowedTools: null, models: { strong: "ps", fast: "pf" } } })), {});
  expect(parsed.options.model).toBe("ps");
  expect(parsed.options.profile?.mode).toBe("bypass");
});
