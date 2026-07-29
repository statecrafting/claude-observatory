import { test, expect, spyOn } from "bun:test";
import * as fs from "fs";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  openJournal,
  verifyChain,
  foldState,
  canonicalizeValue,
  stableStringify,
  appendIntent,
  appendOutcome,
  unresolvedIntents,
} from "./journal";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "journal-test-"));
}

// --- canonicalization (B-1) -------------------------------------------

test("canonicalizeValue sorts object keys recursively and is byte-stable across insertion order", () => {
  const a = { z: 1, a: { n: 2, b: 3 }, m: [{ y: 4, x: 5 }] };
  const b = { a: { b: 3, n: 2 }, m: [{ x: 5, y: 4 }], z: 1 };
  expect(stableStringify(a)).toBe(stableStringify(b));
  expect(stableStringify(a)).toBe('{"a":{"b":3,"n":2},"m":[{"x":5,"y":4}],"z":1}');
});

test("canonicalizeValue throws on non-integer numbers", () => {
  expect(() => canonicalizeValue({ x: 1.5 })).toThrow(/non-integer/);
});

test("canonicalizeValue passes through null, booleans, strings, arrays, integers", () => {
  expect(canonicalizeValue(null)).toBe(null);
  expect(canonicalizeValue(true)).toBe(true);
  expect(canonicalizeValue("hi")).toBe("hi");
  expect(canonicalizeValue(42)).toBe(42);
  expect(canonicalizeValue([3, 1, 2])).toEqual([3, 1, 2]);
});

// --- append/fold round-trip (FR-001, FR-004) -----------------------------

test("append/fold round-trip: appends persist and refold identically after reopen", () => {
  const dir = freshDir();
  const h1 = openJournal(dir);
  expect(h1.headSeq).toBe(-1);
  expect(h1.state.records).toEqual([]);

  const r0 = h1.append("run.start", { run: "a" });
  const r1 = h1.append("stage.build", { ok: true });
  const r2 = h1.append("run.start", { run: "b" });
  expect(r0.seq).toBe(0);
  expect(r1.seq).toBe(1);
  expect(r2.seq).toBe(2);
  expect(r0.prevHash).not.toBe(r1.prevHash);
  expect(h1.headSeq).toBe(2);

  const folded = h1.fold();
  expect(folded.records.length).toBe(3);
  expect(folded.byKind["run.start"]?.length).toBe(2);
  expect(folded.byKind["stage.build"]?.length).toBe(1);
  h1.close();

  const h2 = openJournal(dir);
  expect(h2.headSeq).toBe(2);
  expect(h2.state.records.length).toBe(3);
  expect(h2.state.byKind["run.start"]?.map((r) => r.payload)).toEqual([{ run: "a" }, { run: "b" }]);
  expect(h2.tornRecovered).toBe(false);

  const v = verifyChain(dir);
  expect(v).toEqual({ ok: true, count: 3 });
  h2.close();
});

test("foldState is a pure grouping of the raw list, nothing more", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  h.append("a.intent", { n: 1 });
  h.append("b.outcome", { n: 2 });
  const folded = foldState(h.fold().records);
  expect(Object.keys(folded.byKind).sort()).toEqual(["a.intent", "b.outcome"]);
  expect(folded.records.length).toBe(2);
  h.close();
});

// --- torn-tail recovery (B-6) -------------------------------------------

test("torn-tail recovery: a partial last line is quarantined and the journal stays usable", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  h.append("k1", { i: 0 });
  h.append("k2", { i: 1 });
  h.close();

  const journalPath = join(dir, "journal.jsonl");
  const goodBytes = readFileSync(journalPath);
  const garbage = '{"seq":2,"ts":"2026-07-29T00:00:00.000Z","kind":"k3","payload":{"i":2},"prevHash":"ab';
  // No trailing newline: this is exactly the crash-mid-write signal (B-2's
  // durability contract is "bytes + trailing newline, fsynced together").
  appendFileSync(journalPath, garbage);

  const reopened = openJournal(dir);
  expect(reopened.tornRecovered).toBe(true);
  expect(reopened.state.records.length).toBe(2);
  expect(reopened.headSeq).toBe(1);

  const tornPath = join(dir, "journal.jsonl.torn");
  expect(existsSync(tornPath)).toBe(true);
  expect(readFileSync(tornPath, "utf8")).toBe(garbage);

  const truncated = readFileSync(journalPath);
  expect(truncated.equals(goodBytes)).toBe(true);

  expect(verifyChain(dir)).toEqual({ ok: true, count: 2 });
  reopened.close();
});

// --- broken-chain refusal (B-3, B-6) -------------------------------------

test("broken-chain refusal: a corrupted tail record refuses to open", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  h.append("k1", { tag: "record-zero" });
  h.close();

  const journalPath = join(dir, "journal.jsonl");
  const text = readFileSync(journalPath, "utf8");
  // Flip one letter inside the payload string: stays valid JSON, breaks the
  // stored recordHash's match against recomputed content.
  const tampered = text.replace("record-zero", "record-ZERO");
  expect(tampered).not.toBe(text);
  writeFileSync(journalPath, tampered);

  expect(() => openJournal(dir)).toThrow(/journal corrupted/);
});

// --- AC-3: verifyChain detects a flip anywhere, not just the tail --------

test("verifyChain detects a single flipped byte in a non-tail record; open() does not (by design)", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  for (let i = 0; i < 5; i++) h.append("k", { tag: `record-${i}` });
  h.close();

  const journalPath = join(dir, "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(5);
  // Corrupt record seq=2 (not the tail at seq=4).
  lines[2] = lines[2]!.replace("record-2", "record-X");
  writeFileSync(journalPath, lines.join("\n") + "\n");

  // open() only validates the tail (B-3): a non-tail corruption does not
  // block opening.
  const reopened = openJournal(dir);
  expect(reopened.state.records.length).toBe(5);
  reopened.close();

  // A full walk finds it.
  const v = verifyChain(dir);
  expect(v).toEqual({ ok: false, brokenSeq: 2, reason: "recordHash does not match its content" });
});

// --- second-writer lock exclusion (B-2) ----------------------------------

test("second-writer lock exclusion: a second open on the same dir is refused until the first closes", () => {
  const dir = freshDir();
  const h1 = openJournal(dir);
  expect(() => openJournal(dir)).toThrow(/locked/);
  h1.close();

  const h2 = openJournal(dir);
  expect(h2.headSeq).toBe(-1);
  h2.close();
});

// --- fsync called before acknowledge (FR-004) ----------------------------

test("fsync is called synchronously inside append(), before it returns (durability, B-2)", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  const fsyncSpy = spyOn(fs, "fsyncSync");
  const callsBefore = fsyncSpy.mock.calls.length;

  h.append("k", { x: 1 });

  // append() is fully synchronous; fsyncSync having been invoked by the time
  // this assertion runs proves it happened inside append(), before the
  // caller ever observed the returned record.
  expect(fsyncSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  fsyncSpy.mockRestore();
  h.close();
});

// --- intent/outcome bracket (B-4) ----------------------------------------

test("unresolvedIntents flags an intent with no matching outcome, and only that one", () => {
  const dir = freshDir();
  const h = openJournal(dir);
  appendIntent(h, "build", { spec: "011" });
  appendOutcome(h, "build", { spec: "011", result: "ok" });
  appendIntent(h, "ship", { spec: "011" });
  // no ship.outcome: a crash between the two would leave exactly this.

  const unresolved = unresolvedIntents(h.fold().records);
  expect(unresolved.length).toBe(1);
  expect(unresolved[0]?.kind).toBe("ship.intent");
  h.close();
});

// --- AC-2: kill -9 during an append storm --------------------------------

test(
  "AC-2: kill -9 mid append-storm leaves a journal that opens with at most one torn record and folds consistently",
  async () => {
    const dir = freshDir();
    const journalModulePath = fileURLToPath(new URL("./journal.ts", import.meta.url));
    const childPath = join(dir, "storm-child.ts");
    const childSrc = `
import { openJournal } from ${JSON.stringify(journalModulePath)};
const dir = process.argv[2];
const handle = openJournal(dir);
let i = 0;
while (i < 5_000_000) {
  handle.append("storm.tick", { i });
  i++;
}
`;
    writeFileSync(childPath, childSrc);

    const proc = Bun.spawn(["bun", childPath, dir], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(200);
    proc.kill(9);
    await proc.exited;

    // The child died holding the lock. A supervisor that has confirmed the
    // writer is dead clears it before reopening (out of scope: automated
    // stale-lock detection, spec 011 section 6).
    const lockPath = join(dir, "journal.lock");
    if (existsSync(lockPath)) unlinkSync(lockPath);

    const reopened = openJournal(dir);
    expect(reopened.state.records.length).toBe(reopened.headSeq + 1);
    // Every record folded is exactly what a full recompute confirms: no
    // partial or tampered record survived into the usable journal.
    const v = verifyChain(dir);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.count).toBe(reopened.state.records.length);
    reopened.close();
  },
  15000
);

test("unresolvedIntents is order-aware: a repeated op's latest unpaired intent is unresolved", () => {
  const dir = freshDir();
  const handle = openJournal(dir);
  appendIntent(handle, "stage.run", { attempt: 1 });
  appendOutcome(handle, "stage.run", { attempt: 1, ok: true });
  const second = appendIntent(handle, "stage.run", { attempt: 2 });
  // Crash here: attempt 2 has an intent, no outcome. Pairing by op name
  // alone would report nothing unresolved; order-aware pairing must not.
  const unresolved = unresolvedIntents(handle.fold().records);
  expect(unresolved.length).toBe(1);
  expect(unresolved[0]!.seq).toBe(second.seq);
  handle.close();
});
