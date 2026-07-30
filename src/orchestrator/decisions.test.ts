import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, stableStringify } from "./journal";
import {
  type DecisionRecord,
  validateDecisionRecord,
  openDecisionsChain,
  decisionRecordsFromChain,
  contentHashOf,
  sealDropbox,
  decisionsFor,
  queryDecisions,
} from "./decisions";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "decisions-test-"));
}

function validDecisionRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "d-1",
    specId: "020-decision-ledger",
    scope: ["020-decision-ledger", "src/orchestrator/decisions.ts"],
    title: "Use X",
    decision: "We will do X",
    rationale: "Because Y",
    ...overrides,
  };
}

// Mirrors decisionPayload()'s canonical shape so tests can compute the exact
// size decisionsFor's budget accounting uses, without decisions.ts having to
// export an internal helper for it.
function payloadSize(record: DecisionRecord): number {
  const payload: Record<string, unknown> = {
    id: record.id,
    specId: record.specId,
    scope: [...record.scope],
    title: record.title,
    decision: record.decision,
    rationale: record.rationale,
  };
  if (record.alternatives !== undefined) payload.alternatives = [...record.alternatives];
  if (record.supersedes !== undefined) payload.supersedes = record.supersedes;
  return stableStringify(payload).length;
}

// --- schema validation (FR-001) --------------------------------------------

test("validateDecisionRecord rejects a payload missing a required field", () => {
  const raw = { specId: "020-decision-ledger", scope: [], title: "t", decision: "d", rationale: "r" };
  const result = validateDecisionRecord(raw, new Set(["020-decision-ledger"]));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/missing field "id"/);
});

test("validateDecisionRecord rejects a payload with an unknown field", () => {
  const raw = { ...validDecisionRaw(), extra: "nope" };
  const result = validateDecisionRecord(raw, new Set(["020-decision-ledger"]));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/unknown field "extra"/);
});

test("validateDecisionRecord rejects a payload containing a non-integer number (floats)", () => {
  const raw = { ...validDecisionRaw(), scope: ["020-decision-ledger", 1.5] };
  const result = validateDecisionRecord(raw, new Set(["020-decision-ledger"]));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/non-integer number/);
});

test("validateDecisionRecord rejects a scope entry that is neither a known spec id nor a plausible repo path", () => {
  const raw = { ...validDecisionRaw(), scope: ["020-decision-ledger", "not a path!!"] };
  const result = validateDecisionRecord(raw, new Set(["020-decision-ledger"]));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/scope entry/);
});

test("validateDecisionRecord accepts a well-formed record, optional fields included", () => {
  const raw = validDecisionRaw({ alternatives: ["do Y instead"], supersedes: "d-0" });
  const result = validateDecisionRecord(raw, new Set(["020-decision-ledger"]));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.record.id).toBe("d-1");
    expect(result.record.alternatives).toEqual(["do Y instead"]);
    expect(result.record.supersedes).toBe("d-0");
  }
});

// --- content hash (dedup key, D-2) -----------------------------------------

test("contentHashOf is stable regardless of field insertion order", () => {
  const a: DecisionRecord = { specId: "z", id: "a", scope: ["x"], title: "t", decision: "d", rationale: "r" };
  const b: DecisionRecord = { id: "a", scope: ["x"], specId: "z", rationale: "r", decision: "d", title: "t" };
  expect(contentHashOf(a)).toBe(contentHashOf(b));
});

// --- chain reuse (B-2) ------------------------------------------------

test("openDecisionsChain opens decisions.jsonl and its own anchor alongside journal.jsonl", () => {
  const dir = freshDir();
  const journal = openJournal(dir);
  journal.append("work.k", { x: 1 });

  const chain = openDecisionsChain(dir);
  chain.append("decision.sealed", { id: "d-1" });

  expect(fs.existsSync(join(dir, "journal.jsonl"))).toBe(true);
  expect(fs.existsSync(join(dir, "anchor.json"))).toBe(true);
  expect(fs.existsSync(join(dir, "decisions.jsonl"))).toBe(true);
  expect(fs.existsSync(join(dir, "decisions.anchor.json"))).toBe(true);

  journal.close();
  chain.close();
});

// --- injection (B-4, FR-002) ------------------------------------------

test("decisionsFor matches via the spec's depends_on closure and territory paths, not only its own id", () => {
  const recA: DecisionRecord = {
    id: "d-1",
    specId: "011-work-journal",
    scope: ["011-work-journal"],
    title: "t1",
    decision: "dec1",
    rationale: "r1",
  };
  const result = decisionsFor({
    records: [recA],
    specId: "020-decision-ledger",
    dependsOnClosure: ["011-work-journal"],
    territoryPaths: ["src/orchestrator/decisions.ts"],
    budgetChars: 10_000,
  });
  expect(result.included.map((r) => r.id)).toEqual(["d-1"]);
  expect(result.overflowCount).toBe(0);
});

test("decisionsFor excludes a record whose scope intersects neither the closure nor the territory paths", () => {
  const recA: DecisionRecord = {
    id: "d-1",
    specId: "099-unrelated",
    scope: ["099-unrelated"],
    title: "t",
    decision: "d",
    rationale: "r",
  };
  const result = decisionsFor({
    records: [recA],
    specId: "020-decision-ledger",
    dependsOnClosure: ["011-work-journal"],
    territoryPaths: ["src/orchestrator/decisions.ts"],
    budgetChars: 10_000,
  });
  expect(result.included).toEqual([]);
  expect(result.overflowCount).toBe(0);
});

test("decisionsFor resolves away a record shadowed by a later record's supersedes", () => {
  const older: DecisionRecord = {
    id: "d-1",
    specId: "020-decision-ledger",
    scope: ["020-decision-ledger"],
    title: "old",
    decision: "old dec",
    rationale: "r",
  };
  const newer: DecisionRecord = {
    id: "d-2",
    specId: "020-decision-ledger",
    scope: ["020-decision-ledger"],
    title: "new",
    decision: "new dec",
    rationale: "r",
    supersedes: "d-1",
  };
  const result = decisionsFor({
    records: [older, newer],
    specId: "020-decision-ledger",
    dependsOnClosure: [],
    territoryPaths: [],
    budgetChars: 10_000,
  });
  expect(result.included.map((r) => r.id)).toEqual(["d-2"]);
});

test("decisionsFor bounds by budgetChars newest-first and reports overflowCount, never silently truncating", () => {
  const records: DecisionRecord[] = ["d-1", "d-2", "d-3"].map((id, i) => ({
    id,
    specId: "020-decision-ledger",
    scope: ["020-decision-ledger"],
    title: `t${i}`,
    decision: `decision text number ${i}`,
    rationale: `rationale text number ${i}`,
  }));
  // records[2] ("d-3") is newest (last in chain order).
  const budgetChars = payloadSize(records[2]!);
  const result = decisionsFor({
    records,
    specId: "020-decision-ledger",
    dependsOnClosure: [],
    territoryPaths: [],
    budgetChars,
  });
  expect(result.included.map((r) => r.id)).toEqual(["d-3"]);
  expect(result.overflowCount).toBe(2);
});

// --- drop-box (B-3, FR-003, AC-2) ---------------------------------------

test("sealDropbox seals a valid decision, preserves a malformed file, and journals a sealing summary", () => {
  const dir = freshDir();
  const dropboxDir = join(dir, "decision-dropbox");
  fs.mkdirSync(dropboxDir, { recursive: true });

  const validPath = join(dropboxDir, "a-valid.json");
  const malformedPath = join(dropboxDir, "b-malformed.json");
  fs.writeFileSync(validPath, JSON.stringify(validDecisionRaw()));
  fs.writeFileSync(malformedPath, "{ not json");

  const chain = openDecisionsChain(dir);
  const journal = openJournal(dir);

  const result = sealDropbox({
    dropboxDir,
    chain,
    knownSpecIds: new Set(["020-decision-ledger"]),
    journal,
  });

  expect(result.sealed.length).toBe(1);
  expect(result.sealed[0]!.id).toBe("d-1");
  expect(result.invalid.length).toBe(1);
  expect(result.invalid[0]!.file).toBe("b-malformed.json");

  expect(fs.existsSync(validPath)).toBe(false);
  expect(fs.existsSync(malformedPath)).toBe(true);

  const sealedRecords = decisionRecordsFromChain(chain.fold());
  expect(sealedRecords.length).toBe(1);

  const outcomeRecords = journal.fold().byKind["decision.sealed.outcome"];
  expect(outcomeRecords?.length).toBe(1);

  chain.close();
  journal.close();
});

test("sealDropbox is idempotent across a crash between seal and unlink (dedup by content hash, FR-003)", () => {
  const dir = freshDir();
  const dropboxDir = join(dir, "decision-dropbox");
  fs.mkdirSync(dropboxDir, { recursive: true });
  const filePath = join(dropboxDir, "a-valid.json");
  const raw = validDecisionRaw();
  fs.writeFileSync(filePath, JSON.stringify(raw));

  const chain = openDecisionsChain(dir);
  const journal = openJournal(dir);
  const knownSpecIds = new Set(["020-decision-ledger"]);

  const first = sealDropbox({ dropboxDir, chain, knownSpecIds, journal });
  expect(first.sealed.length).toBe(1);
  expect(fs.existsSync(filePath)).toBe(false);

  // Simulate a crash between the chain append (already fsynced and durable)
  // and the drop-box unlink: the file is back, exactly as a supervisor that
  // resumes would find it.
  fs.writeFileSync(filePath, JSON.stringify(raw));

  const second = sealDropbox({ dropboxDir, chain, knownSpecIds, journal });
  expect(second.sealed.length).toBe(1);
  expect(fs.existsSync(filePath)).toBe(false);

  const sealedRecords = decisionRecordsFromChain(chain.fold());
  expect(sealedRecords.length).toBe(1); // no duplicate chain record

  chain.close();
  journal.close();
});

test("decisionsFor returns a drop-box-sealed decision for a downstream spec (AC-2)", () => {
  const dir = freshDir();
  const dropboxDir = join(dir, "decision-dropbox");
  fs.mkdirSync(dropboxDir, { recursive: true });
  fs.writeFileSync(
    join(dropboxDir, "a.json"),
    JSON.stringify({
      id: "d-upstream",
      specId: "011-work-journal",
      scope: ["011-work-journal"],
      title: "Chain reused under a basename",
      decision: "openJournal takes an optional basename",
      rationale: "avoids a second chain implementation",
    })
  );

  const chain = openDecisionsChain(dir);
  const journal = openJournal(dir);
  const result = sealDropbox({
    dropboxDir,
    chain,
    knownSpecIds: new Set(["011-work-journal", "020-decision-ledger"]),
    journal,
  });
  expect(result.sealed.length).toBe(1);

  const records = decisionRecordsFromChain(chain.fold());
  const forDownstream = decisionsFor({
    records,
    specId: "020-decision-ledger",
    dependsOnClosure: ["011-work-journal"],
    territoryPaths: ["src/orchestrator/decisions.ts"],
    budgetChars: 10_000,
  });
  expect(forDownstream.included.map((r) => r.id)).toEqual(["d-upstream"]);

  chain.close();
  journal.close();
});

// --- query (B-5) --------------------------------------------------------

test("queryDecisions filters by specId, path, and case-insensitive full-text, newest-first", () => {
  const records: DecisionRecord[] = [
    {
      id: "d-1",
      specId: "011-work-journal",
      scope: ["011-work-journal", "src/orchestrator/journal.ts"],
      title: "Basename reuse",
      decision: "Parameterize openJournal",
      rationale: "Avoid a second chain",
    },
    {
      id: "d-2",
      specId: "020-decision-ledger",
      scope: ["020-decision-ledger", "src/orchestrator/decisions.ts"],
      title: "Content hash",
      decision: "Hash the record fields",
      rationale: "Idempotent re-seal",
    },
  ];

  expect(queryDecisions(records, { specId: "020-decision-ledger" }).map((r) => r.id)).toEqual(["d-2"]);
  expect(queryDecisions(records, { path: "src/orchestrator/journal.ts" }).map((r) => r.id)).toEqual(["d-1"]);
  expect(queryDecisions(records, { text: "IDEMPOTENT" }).map((r) => r.id)).toEqual(["d-2"]);
  expect(queryDecisions(records, {}).map((r) => r.id)).toEqual(["d-2", "d-1"]);
});
