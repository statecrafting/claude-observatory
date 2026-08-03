// Spec 031 FR-001 and FR-002: export and verification are exercised against
// fixture journals built through the real journal writer, so every hash the
// bundle preserves was minted by the code under 011's own discipline. The
// tamper cases (byte flip, dropped record, truncated tail) each assert a
// named reason, and the redaction policy is checked field by field plus a
// sweep over the whole fixture corpus: nothing an allowlisted kind includes
// may carry an absolute path or a free-text tail.
import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendIntent, appendOutcome, openJournal, sha256Hex, stableStringify, type JournalRecord, type JsonValue } from "./journal";
import { openDecisionsChain } from "./decisions";
import {
  BUNDLE_FORMAT_VERSION,
  REDACTION_POLICY,
  buildBundle,
  exportBundleFromRoot,
  isPrivatePathString,
  parseBundle,
  redactPayload,
  serializeBundle,
  verifyBundle,
  writeBundle,
  type BundleRecord,
  type JournalBundle,
} from "./export";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runOrchestratorCli } from "../commands/orchestrator";

// --- fixtures ----------------------------------------------------------------

function freshRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `export-${prefix}-`));
}

interface SeededChains {
  readonly work: readonly JournalRecord[];
  readonly decisions: readonly JournalRecord[];
}

// A corpus that touches every redaction outcome: verbatim payloads, payloads
// with named fields stripped, payloads whose fields hold absolute or home
// paths, and hash-only kinds the policy does not name.
function seedFixtureChains(root: string): SeededChains {
  const work = openJournal(root);
  const workRecords: JournalRecord[] = [];
  workRecords.push(
    work.append("run.created", {
      id: "r1",
      targetRepo: "/Users/operator/repo",
      createdTs: "2026-08-01T00:00:00.000Z",
      status: "idle",
    })
  );
  workRecords.push(appendIntent(work, "state.transition", { entity: "run", id: "r1", from: "idle", to: "running" }));
  workRecords.push(appendOutcome(work, "state.transition", { entity: "run", id: "r1", from: "idle", to: "running" }));
  workRecords.push(
    work.append("specexec.created", { id: "s1", runId: "r1", specId: "031-journal-export", pin: "aaaa1111", attempt: 1, status: "pending" })
  );
  workRecords.push(
    work.append("stageexec.created", { id: "g1", specExecId: "s1", stage: "build", attempt: 1, status: "queued", evidenceRefs: [] })
  );
  workRecords.push(
    work.append("session.init", {
      claudeBin: "/usr/local/bin/claude",
      repo: "/Users/operator/repo",
      model: null,
      maxTurns: 40,
      timeoutMs: 1800000,
      sessionId: "sess-1",
    })
  );
  workRecords.push(
    work.append("session.result", {
      classification: "clean",
      resetAtMs: null,
      detail: "matched the clean rule",
      exitCode: 0,
      durationMs: 120000,
      numTurns: 41,
      costMicroUsd: 1234567,
      usage: { inputTokens: 100, outputTokens: 200 },
      sessionId: "sess-1",
      transcriptPath: "/Users/operator/.claude/projects/x/sess-1.jsonl",
      overflowLineCount: 3,
      overflowTruncatedCount: 0,
      stderrTail: "warning at /Users/operator/repo/file.ts",
      resultTextTail: "did the thing",
    })
  );
  workRecords.push(
    work.append("stage.build.gate", {
      specId: "031-journal-export",
      round: 1,
      frontmatterComplete: true,
      gates: [{ cmd: ["spec-spine", "compile"], exitCode: 0, stdoutTail: "compiled 31 specs", stderrTail: "" }],
    })
  );
  workRecords.push(
    work.append("stage.build.result", {
      specId: "031-journal-export",
      outcome: "passed",
      branch: "031-journal-export",
      headSha: "bbbb2222",
      decisionsSealed: [],
      decisionsInvalid: [],
    })
  );
  workRecords.push(
    work.append("stage.crashed", { specId: "031-journal-export", stage: "verify", attempt: 1, error: "boom at /Users/operator/repo/src/x.ts" })
  );
  workRecords.push(work.append("quota.parked", { targetMs: 1754000000000, estimated: true, consecutiveQuotaParks: 1 }));
  workRecords.push(work.append("quota.resumed", { resumedAtMs: 1754003600000 }));
  workRecords.push(work.append("control.pause", { runId: "r1", source: "cli" }));
  workRecords.push(work.append("stage.build.prompt", { specId: "031-journal-export", prompt: "the full build prompt text" }));
  workRecords.push(work.append("run.result", { runId: "r1", status: "completed" }));
  work.close();

  const decisions = openDecisionsChain(root);
  const decisionRecords: JournalRecord[] = [];
  decisionRecords.push(
    decisions.append("decision.sealed", {
      id: "031-d1-fixture",
      specId: "031-journal-export",
      scope: ["031-journal-export", "src/orchestrator/export.ts", "docs/design/00-ecosystem-analysis.md"],
      title: "the bundle is one file",
      decision: "one canonical JSON file",
      rationale: "deterministic bytes commit cleanly",
    })
  );
  decisionRecords.push(
    decisions.append("decision.sealed", {
      id: "031-d2-fixture",
      specId: "031-journal-export",
      scope: ["031-journal-export"],
      title: "a rationale holding a home path",
      decision: "kept short",
      rationale: "evidence lands under ~/.claude transcripts",
    })
  );
  decisions.close();
  return { work: workRecords, decisions: decisionRecords };
}

function exportFixture(root: string): JournalBundle {
  const result = exportBundleFromRoot(root, null);
  if (!result.ok) throw new Error(`fixture export refused: ${result.reason}`);
  return result.bundle;
}

// Deep clone through JSON so a tamper case never mutates the bundle another
// assertion still reads.
function clone(bundle: JournalBundle): JournalBundle {
  return JSON.parse(JSON.stringify(bundle)) as JournalBundle;
}

function chainOf(bundle: JournalBundle, name: string) {
  const chain = bundle.chains.find((c) => c.chain === name);
  if (!chain) throw new Error(`no ${name} chain in bundle`);
  return chain;
}

// Tamper helper: the bundle shape is readonly by design; these tests
// deliberately corrupt deep clones, so the mutability cast is honest here
// and nowhere else.
function tamperable(bundle: JournalBundle, name: string): { records: BundleRecord[]; recordCount: number } {
  return chainOf(bundle, name) as unknown as { records: BundleRecord[]; recordCount: number };
}

function recordOfKind(bundle: JournalBundle, chain: string, kind: string): BundleRecord {
  const found = chainOf(bundle, chain).records.find((r) => r.kind === kind);
  if (!found) throw new Error(`no ${kind} record in the ${chain} chain`);
  return found;
}

function expectFailure(bundle: JournalBundle, chain: string, reasonFragment: string, seq?: number | null): void {
  const verdict = verifyBundle(bundle);
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.chain).toBe(chain);
  expect(verdict.reason).toContain(reasonFragment);
  if (seq !== undefined) expect(verdict.seq).toBe(seq);
}

// --- the redaction policy, field by field (B-2, FR-002) ----------------------

test("a kind the policy does not name is hash-only, whatever it carries", () => {
  const init = redactPayload("session.init", { claudeBin: "/usr/local/bin/claude", sessionId: "s" });
  expect(init.withheldPayload).toBe(true);
  expect(init.payload).toBeUndefined();
  // Growth of the journal's vocabulary can never leak by omission (B-2).
  const future = redactPayload("stage.future.telemetry", { anything: "at all" });
  expect(future.withheldPayload).toBe(true);
});

test("session.result keeps costs, counts, and classification; tails, transcript path, and detail are stripped", () => {
  const redacted = redactPayload("session.result", {
    classification: "clean",
    detail: "free text",
    exitCode: 0,
    durationMs: 5,
    numTurns: 2,
    costMicroUsd: 99,
    usage: { inputTokens: 1 },
    sessionId: "sess-9",
    transcriptPath: "/Users/x/.claude/t.jsonl",
    overflowLineCount: 0,
    overflowTruncatedCount: 0,
    stderrTail: "tail",
    resultTextTail: "tail",
  });
  expect(redacted.withheldPayload).toBe(false);
  const payload = redacted.payload as Record<string, JsonValue>;
  expect(payload.classification).toBe("clean");
  expect(payload.exitCode).toBe(0);
  expect(payload.costMicroUsd).toBe(99);
  expect(payload.numTurns).toBe(2);
  expect(payload.sessionId).toBe("sess-9");
  expect(payload.usage).toEqual({ inputTokens: 1 });
  expect(payload.detail).toBeUndefined();
  expect(payload.stderrTail).toBeUndefined();
  expect(payload.resultTextTail).toBeUndefined();
  expect(payload.transcriptPath).toBeUndefined();
  expect(redacted.withheldFields).toEqual(["detail", "resultTextTail", "stderrTail", "transcriptPath"]);
});

test("named fields are stripped at any nesting depth: a gate's tails go, its command and exit code stay", () => {
  const redacted = redactPayload("stage.build.gate", {
    specId: "031-journal-export",
    round: 1,
    frontmatterComplete: true,
    gates: [{ cmd: ["spec-spine", "compile"], exitCode: 1, stdoutTail: "noise", stderrTail: "more noise" }],
  });
  expect(redacted.withheldPayload).toBe(false);
  const gates = (redacted.payload as { gates: Record<string, JsonValue>[] }).gates;
  expect(gates[0]!.cmd).toEqual(["spec-spine", "compile"]);
  expect(gates[0]!.exitCode).toBe(1);
  expect(gates[0]!.stdoutTail).toBeUndefined();
  expect(gates[0]!.stderrTail).toBeUndefined();
  expect(redacted.withheldFields).toEqual(["stderrTail", "stdoutTail"]);
});

test("a field holding an absolute or home path is stripped even when the policy does not name it", () => {
  const created = redactPayload("run.created", { id: "r1", targetRepo: "/Users/operator/repo", createdTs: "t", status: "idle" });
  expect((created.payload as Record<string, JsonValue>).targetRepo).toBeUndefined();
  expect(created.withheldFields).toEqual(["targetRepo"]);

  const embedded = redactPayload("run.result", { runId: "r1", status: "completed", note: "see ~/.claude for the transcript" });
  expect((embedded.payload as Record<string, JsonValue>).note).toBeUndefined();
  expect(embedded.withheldFields).toEqual(["note"]);

  // A bare path inside an array strips the field holding the array: there is
  // no smaller unit to remove.
  const refs = redactPayload("control.pause", { runId: "r1", source: "cli", refs: ["/private/tmp/evidence"] });
  expect((refs.payload as Record<string, JsonValue>).refs).toBeUndefined();
  expect(refs.withheldFields).toEqual(["refs"]);

  // A payload that is itself a bare path degrades to fully withheld.
  const bare = redactPayload("run.result", "/Users/operator/repo");
  expect(bare.withheldPayload).toBe(true);
});

test("relative repo paths, spec ids, branches, and shas survive the path scan", () => {
  const sealed = redactPayload("decision.sealed", {
    id: "031-d1",
    specId: "031-journal-export",
    scope: ["031-journal-export", "src/orchestrator/export.ts", "docs/design/00-ecosystem-analysis.md"],
    title: "t",
    decision: "d",
    rationale: "r",
  });
  expect(sealed.withheldPayload).toBe(false);
  expect(sealed.withheldFields).toEqual([]);
  expect((sealed.payload as Record<string, JsonValue>).scope).toEqual([
    "031-journal-export",
    "src/orchestrator/export.ts",
    "docs/design/00-ecosystem-analysis.md",
  ]);
});

// FR-002's corpus sweep: after redaction, no included payload in the whole
// fixture bundle carries a stripped field name or a private-path string.
test("no allowlisted kind's included fields contain an absolute path or a free-text tail in the fixture corpus", () => {
  const root = freshRoot("corpus");
  try {
    seedFixtureChains(root);
    const bundle = exportFixture(root);
    const stripped = new Set(REDACTION_POLICY.strippedFields);
    const assertClean = (value: JsonValue): void => {
      if (typeof value === "string") {
        expect(isPrivatePathString(value)).toBe(false);
        return;
      }
      if (Array.isArray(value)) {
        for (const element of value) assertClean(element);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          expect(stripped.has(key)).toBe(false);
          assertClean(child);
        }
      }
    };
    for (const chain of bundle.chains) {
      for (const record of chain.records) {
        if (!record.withheldPayload) assertClean(record.payload!);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- bundle shape and round trip (B-1, B-5, FR-001) --------------------------

test("a clean export round-trips through serialize, parse, and verify with nothing dropped", () => {
  const root = freshRoot("roundtrip");
  try {
    const seeded = seedFixtureChains(root);
    const bundle = exportFixture(root);

    // B-1: record count in equals record count out, link hashes verbatim.
    const work = chainOf(bundle, "work");
    expect(work.records.length).toBe(seeded.work.length);
    expect(work.records.map((r) => r.recordHash)).toEqual(seeded.work.map((r) => r.recordHash));
    expect(work.records.map((r) => r.prevHash)).toEqual(seeded.work.map((r) => r.prevHash));
    expect(work.records.map((r) => r.payloadHash)).toEqual(seeded.work.map((r) => sha256Hex(stableStringify(r.payload))));
    expect(chainOf(bundle, "decisions").records.length).toBe(seeded.decisions.length);

    // B-5: the bundle names the policy it was produced under.
    expect(bundle.policyVersion).toBe(REDACTION_POLICY.version);

    // The kind is always included, even for a withheld payload (B-1), and a
    // withheld record carries no payload at all.
    const init = recordOfKind(bundle, "work", "session.init");
    expect(init.withheldPayload).toBe(true);
    expect("payload" in init).toBe(false);

    // The true offline path: bytes to parse to verdict (B-3).
    const reparsed = parseBundle(serializeBundle(bundle));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const verdict = verifyBundle(reparsed.bundle);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.chains).toEqual([
      { chain: "work", records: 15, payloadsVerified: 9, payloadsRedacted: 4, payloadsWithheld: 2 },
      { chain: "decisions", records: 2, payloadsVerified: 1, payloadsRedacted: 1, payloadsWithheld: 0 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two exports of the same journals produce byte-identical bundles", () => {
  const root = freshRoot("determinism");
  try {
    seedFixtureChains(root);
    const first = serializeBundle(exportFixture(root));
    const second = serializeBundle(exportFixture(root));
    expect(second).toBe(first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- tamper detection (B-3, FR-001) ------------------------------------------

test("flipping one byte in an included payload fails with a named reason", () => {
  const root = freshRoot("flip");
  try {
    seedFixtureChains(root);
    const bundle = clone(exportFixture(root));
    const parked = recordOfKind(bundle, "work", "quota.parked");
    (parked.payload as { targetMs: number }).targetMs += 1;
    expectFailure(bundle, "work", "included payload does not match its payload hash", parked.seq);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tampering a verbatim record's envelope fails against its recordHash", () => {
  const root = freshRoot("envelope");
  try {
    seedFixtureChains(root);
    const bundle = clone(exportFixture(root));
    const pause = recordOfKind(bundle, "work", "control.pause");
    (pause as { ts: string }).ts = "2020-01-01T00:00:00.000Z";
    expectFailure(bundle, "work", "recordHash does not match the included record content", pause.seq);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dropping a record fails with a named reason", () => {
  const root = freshRoot("drop");
  try {
    seedFixtureChains(root);
    const bundle = clone(exportFixture(root));
    const work = tamperable(bundle, "work");
    work.records.splice(3, 1);
    // With the declared count left honest, the walk itself names the gap.
    work.recordCount -= 1;
    expectFailure(bundle, "work", "record sequence breaks");

    // With the declared count untouched, the mismatch is named instead.
    const padded = clone(exportFixture(root));
    tamperable(padded, "work").records.splice(3, 1);
    expectFailure(padded, "work", "truncated or padded", null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("truncating the tail fails with a named reason", () => {
  const root = freshRoot("truncate");
  try {
    seedFixtureChains(root);
    const bundle = clone(exportFixture(root));
    const work = tamperable(bundle, "work");
    work.records.pop();
    expectFailure(bundle, "work", "truncated or padded", null);

    // A truncation that also fixes up the count still contradicts the
    // declared head.
    const consistent = clone(exportFixture(root));
    const chain = tamperable(consistent, "work");
    chain.records.pop();
    chain.recordCount -= 1;
    expectFailure(consistent, "work", "does not match the declared head", null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the withheld annotation is load-bearing in both directions", () => {
  const root = freshRoot("annotation");
  try {
    seedFixtureChains(root);
    const grown = clone(exportFixture(root));
    const init = recordOfKind(grown, "work", "session.init") as { payload?: JsonValue };
    init.payload = { smuggled: true };
    expectFailure(grown, "work", "a record marked withheld carries a payload");

    const lost = clone(exportFixture(root));
    const parked = recordOfKind(lost, "work", "quota.parked") as { payload?: JsonValue };
    delete parked.payload;
    expectFailure(lost, "work", "carries no payload and no withheld annotation");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- export refusals and parse rejections ------------------------------------

test("export refuses a broken chain and a missing anchor by name", () => {
  const broken = freshRoot("broken");
  const bare = freshRoot("bare");
  try {
    seedFixtureChains(broken);
    fs.appendFileSync(join(broken, "journal.jsonl"), '{"seq":999}\n');
    const refused = exportBundleFromRoot(broken, null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("the work chain is broken at seq");

    const anchorless = exportBundleFromRoot(bare, null);
    expect(anchorless.ok).toBe(false);
    if (!anchorless.ok) expect(anchorless.reason).toContain("has no anchor");

    // Both chains are the export (B-1): a work journal alone is refused too.
    const half = freshRoot("half");
    try {
      openJournal(half).close();
      const missing = exportBundleFromRoot(half, null);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toContain("the decisions chain has no anchor");
    } finally {
      fs.rmSync(half, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("parseBundle rejects what it cannot vouch for, by name", () => {
  expect(parseBundle("not json")).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
  expect(parseBundle('{"format":"something-else"}')).toMatchObject({ ok: false, reason: expect.stringContaining("unknown bundle format") });
  const future = { format: "observatory-journal-export", formatVersion: BUNDLE_FORMAT_VERSION + 1 };
  expect(parseBundle(JSON.stringify(future))).toMatchObject({ ok: false, reason: expect.stringContaining("unsupported bundle format version") });
  const empty = buildBundle({ project: null, work: { anchorHash: "a", records: [] }, decisions: { anchorHash: "b", records: [] } });
  expect(parseBundle(serializeBundle(empty)).ok).toBe(true);
});

// --- the CLI verbs (B-4) -----------------------------------------------------

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runCli(argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOrchestratorCli(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: {},
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("journal export writes a bundle that journal verify --bundle then checks offline", async () => {
  const root = freshRoot("cli");
  const outPath = join(root, "bundles", "evidence.json");
  try {
    seedFixtureChains(root);
    const exported = await runCli(["journal", "export", "--out", outPath, "--data-dir", root]);
    expect(exported.code).toBe(EXIT_OK);
    expect(exported.out).toContain(`bundle written to ${outPath}`);
    expect(exported.out).toContain("work      15 records: 13 payloads included (4 with fields withheld), 2 withheld");
    expect(exported.out).toContain("decisions 2 records: 2 payloads included (1 with fields withheld), 0 withheld");

    const verified = await runCli(["journal", "verify", "--bundle", outPath]);
    expect(verified.code).toBe(EXIT_OK);
    expect(verified.out).toContain("chains intact");
    expect(verified.out).toContain("work      15 records: 9 payloads verified, 4 redacted, 2 withheld");

    const asJson = await runCli(["journal", "verify", "--bundle", outPath, "--json"]);
    expect(asJson.code).toBe(EXIT_OK);
    const envelope = JSON.parse(asJson.out) as { ok: boolean; data: { verified: boolean; policyVersion: number } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.verified).toBe(true);
    expect(envelope.data.policyVersion).toBe(REDACTION_POLICY.version);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal verify --bundle names a tampered bundle and a missing one, exit 1 not a crash", async () => {
  const root = freshRoot("cli-tamper");
  const outPath = join(root, "bundle.json");
  try {
    seedFixtureChains(root);
    expect((await runCli(["journal", "export", "--out", outPath, "--data-dir", root])).code).toBe(EXIT_OK);
    const tampered = clone(JSON.parse(fs.readFileSync(outPath, "utf8")) as JournalBundle);
    (recordOfKind(tampered, "work", "quota.parked").payload as { targetMs: number }).targetMs += 1;
    fs.writeFileSync(outPath, serializeBundle(tampered));

    const verdict = await runCli(["journal", "verify", "--bundle", outPath]);
    expect(verdict.code).toBe(EXIT_FAILURE);
    expect(verdict.err).toContain("work chain broken");
    expect(verdict.err).toContain("included payload does not match its payload hash");

    const missing = await runCli(["journal", "verify", "--bundle", join(root, "nowhere.json")]);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.err).toContain("could not be read");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the export and bundle verbs refuse inapplicable flags and missing arguments as usage", async () => {
  const root = freshRoot("cli-usage");
  try {
    expect((await runCli(["journal", "export", "--data-dir", root])).code).toBe(EXIT_USAGE);
    expect((await runCli(["journal", "export", "--out", "x", "--dir", root])).code).toBe(EXIT_USAGE);
    expect((await runCli(["journal", "export", "--out", "x", "--bundle", "y"])).code).toBe(EXIT_USAGE);
    expect((await runCli(["journal", "verify", "--bundle", "x", "--project", "p"])).code).toBe(EXIT_USAGE);
    expect((await runCli(["journal", "verify", "--bundle", "x", "--dir", root])).code).toBe(EXIT_USAGE);
    expect((await runCli(["journal", "verify", "--out", "x"])).code).toBe(EXIT_USAGE);
    const unknown = await runCli(["journal", "seal"]);
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.err).toContain(`journal needs the "verify" or "export" subcommand`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export is read-only: both chains carry the same bytes after an export", async () => {
  const root = freshRoot("readonly");
  const outPath = join(root, "bundle.json");
  try {
    seedFixtureChains(root);
    const before = {
      work: fs.readFileSync(join(root, "journal.jsonl"), "utf8"),
      decisions: fs.readFileSync(join(root, "decisions.jsonl"), "utf8"),
    };
    expect((await runCli(["journal", "export", "--out", outPath, "--data-dir", root])).code).toBe(EXIT_OK);
    expect(fs.readFileSync(join(root, "journal.jsonl"), "utf8")).toBe(before.work);
    expect(fs.readFileSync(join(root, "decisions.jsonl"), "utf8")).toBe(before.decisions);
    // No writer lock was taken and none is left behind.
    expect(fs.existsSync(join(root, "journal.lock"))).toBe(false);
    expect(fs.existsSync(join(root, "decisions.lock"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeBundle overwrites deterministically", () => {
  const root = freshRoot("write");
  const outPath = join(root, "nested", "bundle.json");
  try {
    seedFixtureChains(root);
    const bundle = exportFixture(root);
    writeBundle(bundle, outPath);
    writeBundle(bundle, outPath);
    expect(fs.readFileSync(outPath, "utf8")).toBe(serializeBundle(bundle));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
