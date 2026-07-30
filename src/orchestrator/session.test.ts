import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, resolve } from "path";
import { openJournal } from "./journal";
import {
  runSession,
  claudeVersion,
  deriveTranscriptPath,
  SessionsSerialError,
  OVERFLOW_LINE_CAP,
} from "./session";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "session-test-"));
}

// Writes an executable fake `claude` (a bash script) that stands in for the
// real CLI: this repo never spawns the real `claude` in tests (AC-2's live
// smoke is run manually).
function writeFakeClaude(dir: string, body: string): string {
  const path = join(dir, "fake-claude.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// --- classification paths (FR-001, every kind without network) -------------

test("runSession: a completed result event carries cost, usage, and turns; forwards every event to the sink", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    [
      'echo \'{"type":"system","subtype":"init","session_id":"sess-completed"}\'',
      'echo \'{"type":"assistant","message":{"role":"assistant","content":[]}}\'',
      'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE","total_cost_usd":0.012345,"usage":{"input_tokens":100,"output_tokens":42,"cache_read_input_tokens":3.5},"num_turns":2,"session_id":"sess-completed"}\'',
      "exit 0",
    ].join("\n")
  );

  const events: unknown[] = [];
  const result = await runSession({
    repo: dir,
    prompt: "reply DONE",
    claudeBin: script,
    sink: (e) => events.push(e),
  });

  expect(result.classification.kind).toBe("completed");
  expect(result.exitCode).toBe(0);
  expect(result.costMicroUsd).toBe(12345);
  // cache_read_input_tokens is non-integer and is dropped (B-6: integers only).
  expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 42 });
  expect(result.numTurns).toBe(2);
  expect(result.sessionId).toBe("sess-completed");
  expect(result.transcriptPath).toBe(deriveTranscriptPath(dir, "sess-completed"));
  expect(events.map((e) => (e as { type: string }).type)).toEqual(["system", "assistant", "result"]);
});

test("runSession: an auth failure with no result event classifies auth (B-4)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "OAuth token expired for this workspace" 1>&2', "exit 1"].join("\n"));

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("auth");
  expect(result.exitCode).toBe(1);
  expect(result.sessionId).toBeNull();
  expect(result.transcriptPath).toBeNull();
});

test("runSession: a quota message with an ISO reset hint classifies quota with resetAtMs (FR-002)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    [
      'echo \'{"type":"result","subtype":"error","is_error":true,"result":"Claude usage limit reached. Your limit resets at 2026-08-01T00:00:00Z","session_id":"sess-quota"}\'',
      "exit 1",
    ].join("\n")
  );

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("quota");
  expect(result.classification.resetAtMs).toBe(Date.parse("2026-08-01T00:00:00Z"));
});

test("runSession: a quota message with a relative reset in minutes classifies quota with resetAtMs (FR-002)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "rate limit exceeded, resets in 20 minutes" 1>&2', "exit 1"].join("\n"));

  const before = Date.now();
  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  const after = Date.now();

  expect(result.classification.kind).toBe("quota");
  expect(result.classification.resetAtMs).not.toBeNull();
  expect(result.classification.resetAtMs!).toBeGreaterThanOrEqual(before + 20 * 60_000);
  expect(result.classification.resetAtMs!).toBeLessThanOrEqual(after + 20 * 60_000);
});

test("runSession: a quota message with no reset hint classifies quota with resetAtMs null, never a guess (FR-002)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "usage limit reached" 1>&2', "exit 1"].join("\n"));

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("quota");
  expect(result.classification.resetAtMs).toBeNull();
});

test("runSession: a pr-gate blocked message classifies hook-blocked (B-4)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "[pr-gate] BLOCKED: missing spec coupling" 1>&2', "exit 2"].join("\n"));

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("hook-blocked");
});

test("runSession: an overloaded/5xx message classifies transient (B-4)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "upstream overloaded: 503" 1>&2', "exit 1"].join("\n"));

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("transient");
});

test("runSession: an unrecognized nonzero exit with no result event classifies crashed (B-4 fallback)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "boom, unexpected failure" 1>&2', "exit 3"].join("\n"));

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("crashed");
  expect(result.exitCode).toBe(3);
});

// --- unparseable stdout / overflow bounds (B-3) -----------------------------

test("runSession: unparseable stdout lines are preserved verbatim in the overflow buffer, never dropped", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    [
      'echo "not json at all"',
      'echo \'{"type":"system","subtype":"init","session_id":"sess-overflow"}\'',
      'echo "also not json {{{"',
      'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"sess-overflow"}\'',
      "exit 0",
    ].join("\n")
  );

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.classification.kind).toBe("completed");
  expect(result.overflow.lines).toEqual(["not json at all", "also not json {{{"]);
  expect(result.overflow.truncatedCount).toBe(0);
});

test("runSession: the overflow buffer is bounded and counts lines beyond the cap without storing them", async () => {
  const dir = freshDir();
  const totalGarbage = OVERFLOW_LINE_CAP + 40;
  const script = writeFakeClaude(
    dir,
    [`for i in $(seq 1 ${totalGarbage}); do echo "garbage-$i"; done`, "exit 1"].join("\n")
  );

  const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(result.overflow.lines.length).toBe(OVERFLOW_LINE_CAP);
  expect(result.overflow.truncatedCount).toBe(totalGarbage - OVERFLOW_LINE_CAP);
  expect(result.classification.kind).toBe("crashed");
});

// --- env hygiene (B-2) -------------------------------------------------------

test("runSession: the child env has ANTHROPIC_API_KEY removed and NO_COLOR=1 set", async () => {
  const dir = freshDir();
  const dumpPath = join(dir, "env-dump.txt");
  const script = writeFakeClaude(
    dir,
    [
      `if [ -z "\${ANTHROPIC_API_KEY+x}" ]; then echo "ANTHROPIC_API_KEY=unset" > "${dumpPath}"; else echo "ANTHROPIC_API_KEY=set" > "${dumpPath}"; fi`,
      `echo "NO_COLOR=\${NO_COLOR:-}" >> "${dumpPath}"`,
      'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE"}\'',
      "exit 0",
    ].join("\n")
  );

  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "leaked-secret-should-not-reach-child";
  let result;
  try {
    result = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }

  expect(result.classification.kind).toBe("completed");
  const dump = readFileSync(dumpPath, "utf8");
  expect(dump).toContain("ANTHROPIC_API_KEY=unset");
  expect(dump).toContain("NO_COLOR=1");
});

// --- stdin round trip (B-1) ---------------------------------------------------

test("runSession: the prompt is delivered via stdin only, never argv or a shell", async () => {
  const dir = freshDir();
  const dumpPath = join(dir, "stdin-dump.txt");
  const script = writeFakeClaude(
    dir,
    [
      `cat > "${dumpPath}"`,
      'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE"}\'',
      "exit 0",
    ].join("\n")
  );

  const dangerousPrompt = 'Implement spec 014; never run $(rm -rf /) or `echo pwned`; quotes " and \' too.';
  const result = await runSession({ repo: dir, prompt: dangerousPrompt, claudeBin: script });

  expect(result.classification.kind).toBe("completed");
  expect(readFileSync(dumpPath, "utf8")).toBe(dangerousPrompt);
});

// --- deadline enforcement (B-5) ------------------------------------------------

test(
  "runSession: kills the child at its deadline and classifies timeout",
  async () => {
    const dir = freshDir();
    const script = writeFakeClaude(dir, ["sleep 30", "exit 0"].join("\n"));

    const start = Date.now();
    // Short grace so the SIGKILL escalation is reached quickly even where
    // SIGTERM does not end the fake (CI bash keeps waiting on its child).
    const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script, timeoutMs: 150, killGraceMs: 300 });
    const elapsed = Date.now() - start;

    expect(result.classification.kind).toBe("timeout");
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  },
  15_000
);

test(
  "runSession: escalates to SIGKILL after the grace period when the child ignores SIGTERM",
  async () => {
    const dir = freshDir();
    const script = writeFakeClaude(dir, ["trap '' TERM", "sleep 30", "exit 0"].join("\n"));

    const start = Date.now();
    const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script, timeoutMs: 100, killGraceMs: 300 });
    const elapsed = Date.now() - start;

    expect(result.classification.kind).toBe("timeout");
    // Dies at roughly timeoutMs + killGraceMs, not the full 30s sleep.
    expect(elapsed).toBeLessThan(10_000);
  },
  15_000
);

// --- serial invariant (FR-003) ------------------------------------------------

test("FR-003: a second concurrent runSession is rejected while one is in flight, released after", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    ["sleep 0.3", 'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE"}\'', "exit 0"].join(
      "\n"
    )
  );

  const first = runSession({ repo: dir, prompt: "hi", claudeBin: script });
  const second = runSession({ repo: dir, prompt: "hi", claudeBin: script });
  await expect(second).rejects.toThrow(SessionsSerialError);

  const result = await first;
  expect(result.classification.kind).toBe("completed");

  // Released in `finally`: a call after the first resolves must succeed.
  const third = await runSession({ repo: dir, prompt: "hi", claudeBin: script });
  expect(third.classification.kind).toBe("completed");
});

// --- journal boundaries (B-2, B-3, B-6) ---------------------------------------

test("runSession: journals exactly one session.init and one session.result boundary, JsonValue-safe", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    [
      'echo \'{"type":"system","subtype":"init","session_id":"sess-journal"}\'',
      'echo \'{"type":"assistant","message":{"role":"assistant","content":[]}}\'',
      'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE","total_cost_usd":0.5,"usage":{"input_tokens":10},"num_turns":1,"session_id":"sess-journal"}\'',
      "exit 0",
    ].join("\n")
  );

  const journal = openJournal(join(dir, "journal"));
  try {
    const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script, model: "claude-test", journal });
    expect(result.classification.kind).toBe("completed");

    const records = journal.fold().records;
    expect(records.map((r) => r.kind)).toEqual(["session.init", "session.result"]);

    const initPayload = records[0]!.payload as Record<string, unknown>;
    expect(initPayload.claudeBin).toBe(script);
    expect(initPayload.model).toBe("claude-test");
    expect(initPayload.sessionId).toBe("sess-journal");

    const resultPayload = records[1]!.payload as Record<string, unknown>;
    expect(resultPayload.classification).toBe("completed");
    expect(resultPayload.costMicroUsd).toBe(500000);
    expect(resultPayload.usage).toEqual({ input_tokens: 10 });
    expect(resultPayload.sessionId).toBe("sess-journal");
  } finally {
    journal.close();
  }
});

test("runSession: a timed-out session with no result event still journals session.result (B-5)", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ["sleep 30", "exit 0"].join("\n"));

  const journal = openJournal(join(dir, "journal"));
  try {
    const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script, timeoutMs: 100, journal });
    expect(result.classification.kind).toBe("timeout");

    const records = journal.fold().records;
    expect(records.map((r) => r.kind)).toEqual(["session.result"]);

    const payload = records[0]!.payload as Record<string, unknown>;
    expect(payload.classification).toBe("timeout");
    expect(payload.costMicroUsd).toBeNull();
    expect(payload.numTurns).toBeNull();
    expect(payload.sessionId).toBeNull();
  } finally {
    journal.close();
  }
});

// --- claude --version helper (B-2) --------------------------------------------

test("claudeVersion: runs `<bin> --version` and returns trimmed stdout", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(
    dir,
    ['if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi', "exit 1"].join("\n")
  );

  const version = await claudeVersion(script);
  expect(version).toBe("2.1.0 (Claude Code)");
});

test("claudeVersion: a nonzero exit throws with stderr context", async () => {
  const dir = freshDir();
  const script = writeFakeClaude(dir, ['echo "boom" 1>&2', "exit 7"].join("\n"));

  await expect(claudeVersion(script)).rejects.toThrow(/exit 7/);
});

// --- transcript path (observational, B-6) -------------------------------------

test("deriveTranscriptPath: replaces / and . with - and joins under ~/.claude/projects", () => {
  const path = deriveTranscriptPath("/Users/bart/DevWork/claude-observatory", "sess-abc123");
  expect(path).toBe(
    join(homedir(), ".claude", "projects", "-Users-bart-DevWork-claude-observatory", "sess-abc123.jsonl")
  );
});

test("deriveTranscriptPath: resolves a relative repo path before slugging", () => {
  const cwdSlug = resolve(".").replace(/[/.]/g, "-");
  const path = deriveTranscriptPath(".", "sess-xyz");
  expect(path).toBe(join(homedir(), ".claude", "projects", cwdSlug, "sess-xyz.jsonl"));
});

test(
  "runSession: a background grandchild holding the inherited pipes does not hang the driver past the drain grace",
  async () => {
    const dir = freshDir();
    // bash exits immediately; the disowned sleep inherits our stdout/stderr
    // pipes and holds them open, so pipe EOF arrives ~30s after process exit.
    const script = writeFakeClaude(dir, ["sleep 30 &", "disown", "exit 0"].join("\n"));

    const start = Date.now();
    const result = await runSession({ repo: dir, prompt: "hi", claudeBin: script, timeoutMs: 20_000 });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(result.classification.kind).toBe("crashed");
    expect(elapsed).toBeLessThan(8_000);
  },
  15_000
);
