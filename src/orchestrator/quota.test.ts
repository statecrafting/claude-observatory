import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal } from "./journal";
import { runSession } from "./session";
import type { Classification } from "./classify-termination";
import {
  QUOTA_CADENCE_MS,
  QUOTA_BASE_ESTIMATE_MS,
  QUOTA_HEALTH_WARNING_THRESHOLD,
  RESUME_JITTER_MIN_MS,
  RESUME_JITTER_MAX_MS,
  planPark,
  resumeJitterMs,
  resumeAtMs,
  isResumeDue,
  shouldWarn,
  parkDecision,
  journalPark,
  journalResume,
  foldQuotaState,
  corroborateParkWindow,
} from "./quota";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "quota-test-"));
}

function writeFakeClaude(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function quotaClassification(resetAtMs: number | null): Classification {
  return { kind: "quota", resetAtMs, detail: "test fixture" };
}

function authClassification(): Classification {
  return { kind: "auth", resetAtMs: null, detail: "test fixture" };
}

// --- planPark: hinted reset (B-1) ------------------------------------------

test("planPark: a hinted resetAtMs is the target verbatim, never re-estimated", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);
  const resetAtMs = now + 42 * 60_000;
  const plan = planPark({ classification: quotaClassification(resetAtMs), now });
  expect(plan.targetMs).toBe(resetAtMs);
  expect(plan.estimated).toBe(false);
  expect(plan.consecutiveQuotaParks).toBe(1);
});

test("planPark: a hinted resetAtMs still increments consecutiveQuotaParks off lastPark history", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);
  const resetAtMs = now + 5 * 60_000;
  const plan = planPark({
    classification: quotaClassification(resetAtMs),
    now,
    lastPark: { estimated: true, consecutiveQuotaParks: 2 },
  });
  expect(plan.consecutiveQuotaParks).toBe(3);
  expect(plan.estimated).toBe(false);
  expect(plan.targetMs).toBe(resetAtMs);
});

// --- planPark: estimated, no history (B-1) ---------------------------------

test("planPark: no hint and no history anchors the full cadence at the failure time (B-1)", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);
  const plan = planPark({ classification: quotaClassification(null), now });
  expect(plan.estimated).toBe(true);
  expect(plan.targetMs).toBe(now + QUOTA_CADENCE_MS);
  expect(plan.consecutiveQuotaParks).toBe(1);
});

// --- planPark: estimated, with history (B-3 doubling) -----------------------

test("planPark: consecutive estimated parks double from the base, capped at the cadence (B-3)", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);

  const second = planPark({
    classification: quotaClassification(null),
    now,
    lastPark: { estimated: true, consecutiveQuotaParks: 1 },
  });
  expect(second.consecutiveQuotaParks).toBe(2);
  expect(second.targetMs).toBe(now + QUOTA_BASE_ESTIMATE_MS);

  const third = planPark({
    classification: quotaClassification(null),
    now,
    lastPark: { estimated: true, consecutiveQuotaParks: 2 },
  });
  expect(third.targetMs).toBe(now + QUOTA_BASE_ESTIMATE_MS * 2);

  const fourth = planPark({
    classification: quotaClassification(null),
    now,
    lastPark: { estimated: true, consecutiveQuotaParks: 3 },
  });
  expect(fourth.targetMs).toBe(now + QUOTA_BASE_ESTIMATE_MS * 4);
});

test("planPark: the doubling horizon never exceeds the cadence", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);
  // A long streak: base * 2^(n-1) blows well past the cadence eventually.
  const plan = planPark({
    classification: quotaClassification(null),
    now,
    lastPark: { estimated: true, consecutiveQuotaParks: 10 },
  });
  expect(plan.targetMs).toBe(now + QUOTA_CADENCE_MS);
  expect(plan.targetMs - now).toBeLessThanOrEqual(QUOTA_CADENCE_MS);
});

test("planPark: a non-quota classification throws", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);
  expect(() => planPark({ classification: authClassification(), now })).toThrow(/non-quota/);
});

// --- FR-001: DST boundary, pure epoch-ms arithmetic --------------------------

test("FR-001: countdown math crosses a DST boundary unaffected (pure epoch ms; display is the client's concern)", () => {
  // 2026-03-08T06:30:00Z: US Eastern DST springs forward at 2026-03-08 02:00
  // local (07:00Z), so the anchored cadence target below lands on the other
  // side of that local wall-clock jump. The arithmetic is plain addition
  // over epoch ms; no calendar or timezone table is consulted, so the
  // result is exact regardless of what a client later renders it as in any
  // timezone.
  const now = Date.UTC(2026, 2, 8, 6, 30, 0);
  const plan = planPark({ classification: quotaClassification(null), now });
  expect(plan.targetMs).toBe(now + QUOTA_CADENCE_MS);
  expect(plan.targetMs - now).toBe(5 * 3_600_000);

  // A hinted reset expressed as an absolute instant on the far side of the
  // same local transition is likewise carried through verbatim.
  const resetAtMs = Date.UTC(2026, 2, 8, 8, 15, 0);
  const hinted = planPark({ classification: quotaClassification(resetAtMs), now });
  expect(hinted.targetMs).toBe(resetAtMs);
});

// --- resumeJitterMs / resumeAtMs / isResumeDue (B-3) -------------------------

test("resumeJitterMs: defaults land in the 30-120 s window", () => {
  const atMin = resumeJitterMs(() => 0);
  const atMax = resumeJitterMs(() => 0.999999);
  expect(atMin).toBe(RESUME_JITTER_MIN_MS);
  expect(atMin).toBeGreaterThanOrEqual(30_000);
  expect(atMax).toBeLessThan(RESUME_JITTER_MAX_MS);
  expect(atMax).toBeGreaterThanOrEqual(RESUME_JITTER_MIN_MS);
});

test("resumeJitterMs: is deterministic for a seeded rng and overridable bounds", () => {
  const a = resumeJitterMs(() => 0.5, 10, 20);
  const b = resumeJitterMs(() => 0.5, 10, 20);
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(10);
  expect(a).toBeLessThan(20);
});

test("isResumeDue: fires only once now reaches target + jitter, never before", () => {
  const target = 1_000_000;
  const jitter = 5_000;
  expect(isResumeDue(target, target, jitter)).toBe(false);
  expect(isResumeDue(resumeAtMs(target, jitter) - 1, target, jitter)).toBe(false);
  expect(isResumeDue(resumeAtMs(target, jitter), target, jitter)).toBe(true);
  expect(isResumeDue(resumeAtMs(target, jitter) + 1, target, jitter)).toBe(true);
});

// --- shouldWarn (B-3 health warning) -----------------------------------------

test("shouldWarn: fires at the threshold and beyond, not before", () => {
  expect(shouldWarn(QUOTA_HEALTH_WARNING_THRESHOLD - 1)).toBe(false);
  expect(shouldWarn(QUOTA_HEALTH_WARNING_THRESHOLD)).toBe(true);
  expect(shouldWarn(QUOTA_HEALTH_WARNING_THRESHOLD + 5)).toBe(true);
  expect(shouldWarn(0)).toBe(false);
});

// --- parkDecision (FR-003) ---------------------------------------------------

test("parkDecision: quota parks, auth stops needing a human, everything else is not this module's business", () => {
  expect(parkDecision(quotaClassification(null))).toBe("park");
  expect(parkDecision(authClassification())).toBe("stop-needs-human");
  expect(parkDecision({ kind: "transient", resetAtMs: null, detail: "x" })).toBe("not-quota");
  expect(parkDecision({ kind: "hook-blocked", resetAtMs: null, detail: "x" })).toBe("not-quota");
  expect(parkDecision({ kind: "timeout", resetAtMs: null, detail: "x" })).toBe("not-quota");
  expect(parkDecision({ kind: "crashed", resetAtMs: null, detail: "x" })).toBe("not-quota");
  expect(parkDecision({ kind: "completed", resetAtMs: null, detail: "x" })).toBe("not-quota");
});

// --- journal integration (B-2, FR-002) ---------------------------------------

test("journalPark + foldQuotaState: recovers parked state and the exact target", () => {
  const dir = freshDir();
  const journal = openJournal(join(dir, "journal"));
  try {
    const plan = planPark({ classification: quotaClassification(null), now: Date.UTC(2026, 6, 29, 0, 0, 0) });
    journalPark(journal, plan);

    const folded = foldQuotaState(journal.fold().records);
    expect(folded.parked).toBe(true);
    expect(folded.lastPark).toEqual({
      targetMs: plan.targetMs,
      estimated: plan.estimated,
      consecutiveQuotaParks: plan.consecutiveQuotaParks,
    });
  } finally {
    journal.close();
  }
});

test("journalResume clears parked but retains lastPark for streak chaining", () => {
  const dir = freshDir();
  const journal = openJournal(join(dir, "journal"));
  try {
    const plan = planPark({ classification: quotaClassification(null), now: Date.UTC(2026, 6, 29, 0, 0, 0) });
    journalPark(journal, plan);
    journalResume(journal, Date.UTC(2026, 6, 29, 5, 1, 0));

    const folded = foldQuotaState(journal.fold().records);
    expect(folded.parked).toBe(false);
    expect(folded.lastPark?.consecutiveQuotaParks).toBe(plan.consecutiveQuotaParks);
  } finally {
    journal.close();
  }
});

test("FR-002: a daemon restart recovers the countdown from the journaled target, not restart time", () => {
  const dir = freshDir();
  const journalDir = join(dir, "journal");
  const journal1 = openJournal(journalDir);
  const now = Date.UTC(2026, 6, 29, 0, 0, 0);
  const plan = planPark({ classification: quotaClassification(now + 3_600_000), now });
  journalPark(journal1, plan);
  journal1.close();

  // Simulate a restart well past the original failure time: reopening reads
  // the same journaled target, never a target recomputed from "now".
  const journal2 = openJournal(journalDir);
  try {
    const folded = foldQuotaState(journal2.fold().records);
    expect(folded.parked).toBe(true);
    expect(folded.lastPark?.targetMs).toBe(plan.targetMs);
  } finally {
    journal2.close();
  }
});

test("foldQuotaState: no records means not parked and no history", () => {
  expect(foldQuotaState([])).toEqual({ parked: false, lastPark: null });
});

// --- corroboration (B-5, optional, observational only) -----------------------

test("corroborateParkWindow: reports activity strictly within the window and its count", () => {
  const events = [
    { ts: 100, kind: "assistant" },
    { ts: 500, kind: "assistant" },
    { ts: 1_500, kind: "assistant" },
  ];
  const result = corroborateParkWindow(events, 200, 1_000);
  expect(result.windowHadActivity).toBe(true);
  expect(result.matchingEventCount).toBe(1);
});

test("corroborateParkWindow: an empty window (no activity) reports false with a zero count", () => {
  const events = [{ ts: 100, kind: "assistant" }];
  const result = corroborateParkWindow(events, 200, 1_000);
  expect(result.windowHadActivity).toBe(false);
  expect(result.matchingEventCount).toBe(0);
});

// --- AC-2: park -> countdown -> restart -> resume -> retry, compressed ------

test(
  "AC-2: a quota session parks, survives a simulated restart, and resumes into a retry session that completes",
  async () => {
    const dir = freshDir();
    const journalDir = join(dir, "journal");

    // A reset hint a few hundred ms in the future, expressed as an absolute
    // ISO instant the classifier's own reset-time extraction understands.
    const resetAtMs = Date.now() + 300;
    const resetIso = new Date(resetAtMs).toISOString();
    const quotaScript = writeFakeClaude(
      dir,
      "fake-claude-quota.sh",
      [
        `echo '{"type":"result","subtype":"error","is_error":true,"result":"Claude usage limit reached. Your limit resets at ${resetIso}","session_id":"sess-quota"}'`,
        "exit 1",
      ].join("\n")
    );

    const journal1 = openJournal(journalDir);
    const firstAttempt = await runSession({ repo: dir, prompt: "hi", claudeBin: quotaScript, journal: journal1 });
    expect(firstAttempt.classification.kind).toBe("quota");
    expect(firstAttempt.classification.resetAtMs).toBe(resetAtMs);

    const plan = planPark({ classification: firstAttempt.classification, now: Date.now() });
    expect(plan.estimated).toBe(false);
    expect(plan.targetMs).toBe(resetAtMs);
    journalPark(journal1, plan);
    journal1.close(); // simulate the daemon stopping while parked

    // Simulate restart: reopen the journal and fold to recover the target,
    // never trusting anything held in memory across the "restart" (FR-002).
    const journal2 = openJournal(journalDir);
    const recovered = foldQuotaState(journal2.fold().records);
    expect(recovered.parked).toBe(true);
    expect(recovered.lastPark?.targetMs).toBe(resetAtMs);

    // Compressed jitter: a tiny deterministic rng over tiny bounds keeps the
    // total test time well under 3 s while still exercising the same
    // target-plus-jitter resume boundary B-3 describes.
    const jitterMs = resumeJitterMs(() => 0.25, 10, 40);
    const dueAtMs = resumeAtMs(recovered.lastPark!.targetMs, jitterMs);

    expect(isResumeDue(Date.now(), recovered.lastPark!.targetMs, jitterMs)).toBe(false);
    await Bun.sleep(Math.max(0, dueAtMs - Date.now()));
    expect(isResumeDue(Date.now(), recovered.lastPark!.targetMs, jitterMs)).toBe(true);

    journalResume(journal2, Date.now());

    const successScript = writeFakeClaude(
      dir,
      "fake-claude-retry.sh",
      [
        'echo \'{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"sess-retry"}\'',
        "exit 0",
      ].join("\n")
    );
    const retryAttempt = await runSession({ repo: dir, prompt: "hi", claudeBin: successScript, journal: journal2 });
    expect(retryAttempt.classification.kind).toBe("completed");

    const finalFold = foldQuotaState(journal2.fold().records);
    expect(finalFold.parked).toBe(false);

    journal2.close();
  },
  3_000
);
