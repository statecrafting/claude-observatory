import { test, expect } from "bun:test";
import {
  classifyTermination,
  extractResetAtMs,
  TERMINATION_RULES,
  type ClassifyTerminationInput,
  type ResultEventLike,
} from "./classify-termination";

function input(overrides: Partial<ClassifyTerminationInput> = {}): ClassifyTerminationInput {
  return { exitCode: 1, resultEvent: null, stderrTail: "", ...overrides };
}

function completedResult(text?: string): ResultEventLike {
  return { is_error: false, subtype: "success", result: text };
}

function errorResult(text: string): ResultEventLike {
  return { is_error: true, subtype: "error_max_turns", result: text };
}

// --- completed ---------------------------------------------------------

test("classifyTermination: a result event with is_error false is completed", () => {
  const c = classifyTermination(input({ exitCode: 0, resultEvent: completedResult("DONE") }));
  expect(c.kind).toBe("completed");
  expect(c.resetAtMs).toBeNull();
});

test("classifyTermination: completed wins even if the driver also flagged a timeout race", () => {
  const c = classifyTermination(input({ exitCode: 0, resultEvent: completedResult("DONE"), timedOut: true }));
  expect(c.kind).toBe("completed");
});

// --- timeout -------------------------------------------------------------

test("classifyTermination: a driver-flagged timeout with no result event classifies timeout", () => {
  const c = classifyTermination(input({ exitCode: null, resultEvent: null, timedOut: true }));
  expect(c.kind).toBe("timeout");
  expect(c.resetAtMs).toBeNull();
});

// --- auth ------------------------------------------------------------------

test("classifyTermination: an authentication error in stderr classifies auth", () => {
  const c = classifyTermination(input({ stderrTail: "Authentication_error: invalid credentials" }));
  expect(c.kind).toBe("auth");
});

test("classifyTermination: an invalid API key message classifies auth", () => {
  const c = classifyTermination(input({ stderrTail: "Error: invalid x-api-key provided" }));
  expect(c.kind).toBe("auth");
});

test("classifyTermination: an expired OAuth token classifies auth even when it mentions rate limits", () => {
  const c = classifyTermination(
    input({
      resultEvent: errorResult("OAuth token expired; this account has also hit its rate limit"),
    })
  );
  expect(c.kind).toBe("auth");
});

// --- quota -----------------------------------------------------------------

test("classifyTermination: a usage limit message with an ISO reset classifies quota with resetAtMs", () => {
  const c = classifyTermination(
    input({ resultEvent: errorResult("Claude usage limit reached. Your limit resets at 2026-08-01T00:00:00Z") })
  );
  expect(c.kind).toBe("quota");
  expect(c.resetAtMs).toBe(Date.parse("2026-08-01T00:00:00Z"));
});

test("classifyTermination: a rate-limit message with a relative reset classifies quota with resetAtMs", () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  const c = classifyTermination(input({ stderrTail: "rate limit exceeded, resets in 15 minutes" }));
  expect(c.kind).toBe("quota");
  expect(c.resetAtMs).not.toBeNull();
  // The classifier uses the real clock internally; assert the extraction
  // logic directly against an injected clock for an exact figure, and only
  // sanity-check the live value is in the right neighborhood.
  const direct = extractResetAtMs("rate limit exceeded, resets in 15 minutes", now);
  expect(direct).toBe(now + 15 * 60_000);
  expect(c.resetAtMs!).toBeGreaterThan(Date.now());
});

test("classifyTermination: a quota message with no reset hint returns resetAtMs null", () => {
  const c = classifyTermination(input({ stderrTail: "You have hit your usage limit for this session." }));
  expect(c.kind).toBe("quota");
  expect(c.resetAtMs).toBeNull();
});

test("classifyTermination: too many requests / 429 classifies quota", () => {
  const c = classifyTermination(input({ stderrTail: "429 Too Many Requests" }));
  expect(c.kind).toBe("quota");
});

// --- hook-blocked ------------------------------------------------------------

test("classifyTermination: a pr-gate blocked marker classifies hook-blocked", () => {
  const c = classifyTermination(input({ stderrTail: "[pr-gate] BLOCKED: missing spec coupling" }));
  expect(c.kind).toBe("hook-blocked");
});

test("classifyTermination: a PreToolUse hook exit code 2 classifies hook-blocked", () => {
  const c = classifyTermination(
    input({ resultEvent: errorResult("PreToolUse:Bash hook blocked this action (exit code 2)") })
  );
  expect(c.kind).toBe("hook-blocked");
});

// --- transient ---------------------------------------------------------------

test("classifyTermination: an overloaded/5xx message classifies transient", () => {
  const c = classifyTermination(input({ stderrTail: "upstream connect error: 503 overloaded" }));
  expect(c.kind).toBe("transient");
});

test("classifyTermination: a network reset classifies transient", () => {
  const c = classifyTermination(input({ stderrTail: "fetch failed: ECONNRESET" }));
  expect(c.kind).toBe("transient");
});

// --- crashed (fallback) -------------------------------------------------------

test("classifyTermination: an unmatched nonzero exit with no result event classifies crashed", () => {
  const c = classifyTermination(input({ exitCode: 134, stderrTail: "Segmentation fault" }));
  expect(c.kind).toBe("crashed");
  expect(c.detail).toContain("134");
});

test("classifyTermination: a null exit code with no signal is still classifiable as crashed", () => {
  const c = classifyTermination(input({ exitCode: null, stderrTail: "" }));
  expect(c.kind).toBe("crashed");
});

// --- rule table shape / order (B-4) -------------------------------------------

test("TERMINATION_RULES is ordered auth, quota, hook-blocked, transient", () => {
  expect(TERMINATION_RULES.map((r) => r.kind)).toEqual(["auth", "quota", "hook-blocked", "transient"]);
});

// --- reset-time extraction (FR-002) -------------------------------------------

test("extractResetAtMs: an absolute ISO instant is parsed exactly", () => {
  const ms = extractResetAtMs("limit resets at 2026-12-25T09:30:00Z");
  expect(ms).toBe(Date.parse("2026-12-25T09:30:00Z"));
});

test("extractResetAtMs: a relative duration in hours is normalized against the injected clock", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const ms = extractResetAtMs("quota resets in 2 hours", now);
  expect(ms).toBe(now + 2 * 3_600_000);
});

test("extractResetAtMs: a relative duration in minutes is normalized against the injected clock", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const ms = extractResetAtMs("resets in 5 minutes", now);
  expect(ms).toBe(now + 5 * 60_000);
});

test("extractResetAtMs: no reset hint present returns null, never a guess", () => {
  expect(extractResetAtMs("usage limit reached, try again later")).toBeNull();
  expect(extractResetAtMs("")).toBeNull();
});

test("extractResetAtMs: an epoch-seconds hint is normalized to epoch ms", () => {
  const epochSeconds = 1_800_000_000;
  const ms = extractResetAtMs(`resets at ${epochSeconds}`);
  expect(ms).toBe(epochSeconds * 1000);
});
