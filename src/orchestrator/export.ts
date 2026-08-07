// Journal export (spec 031): a redacted, offline-verifiable evidence bundle.
//
// The work journal and decision ledger prove the self-construction claim to
// exactly one machine: the one holding data/. This module turns both chains
// into a bundle a third party can check with nothing but the bundle and this
// binary: every record's link hashes travel verbatim, payloads are included
// only under a default-deny redaction policy (B-2), and verifyBundle() needs
// no daemon, no original journal, and no network (B-3).
//
// One structural fact shapes the whole design: spec 011's recordHash covers
// the entire payload, so a payload with even one field stripped can never be
// re-bound to the chain offline. The bundle is honest about that split:
// a payload included verbatim is fully re-hashed into the chain ("verified"),
// a field-stripped payload rides along for the reader but is only ever
// reported as redacted, and a withheld payload is an annotation plus the
// hashes. Every record carries payloadHash, sha256 over the canonical
// original payload, as a commitment anyone holding the original journal can
// check later; offline it proves inclusion-equality only for verbatim
// payloads. 011's chain format and verifyChain are consumed, never modified.
import * as fs from "fs";
import { dirname, join } from "path";
import {
  canonicalizeValue,
  sha256Hex,
  stableStringify,
  verifyChain,
  type JournalRecord,
  type JsonValue,
} from "./journal";

// --- the redaction policy (B-2, FR-002) --------------------------------------

export interface RedactionPolicy {
  readonly version: number;
  // The kind allowlist: a record of any other kind travels hash-only. New
  // journal vocabulary therefore defaults to withheld, never to leaked.
  readonly includedKinds: readonly string[];
  // Field names stripped wherever they appear in an allowlisted payload, at
  // any nesting depth: each is a place free text or a private path can live.
  readonly strippedFields: readonly string[];
}

// Reviewable data, not code (FR-002): what the bundle may carry is this
// constant, and changing it is a policy version bump, not a drive-by edit.
//
// The allowlist maps B-2's categories onto the journal's concrete kinds:
// state transitions (with the creation and result records that give their
// entity ids meaning; run.blocked and run.pause-reason stay hash-only, their
// payloads are free-text reasons), stage results and brackets, session
// results, quota events, control records, adoption and requalification
// records, and decision seals. Costs, counts, classifications, exit codes,
// shas, pins, spec ids, and timestamps all pass through untouched.
export const REDACTION_POLICY: RedactionPolicy = {
  version: 1,
  includedKinds: [
    "control.approve",
    "control.forceHumanGate",
    "control.pause",
    "control.resume",
    "control.retryStage",
    "control.reverify",
    "control.reverify.refused",
    "control.skipSpec",
    "dag.adopted",
    "dag.adopted.refreshed",
    "dag.adoption.deferred",
    "decision.sealed",
    "decision.sealed.outcome",
    "quota.parked",
    "quota.resumed",
    "run.created",
    "run.result",
    "session.result",
    "spec.requalified",
    "spec.requalify.failed",
    "spec.requalify.intent",
    "spec.requalify.refused",
    "specexec.created",
    "stage.build.bracket",
    "stage.build.gate",
    "stage.build.result",
    "stage.crashed",
    "stage.shepherd.result",
    "stage.ship.result",
    "stage.verify.result",
    "stageexec.created",
    "state.transition.intent",
    "state.transition.outcome",
  ],
  strippedFields: [
    "detail",
    "error",
    "firstFailure",
    "invalidFiles",
    "parseError",
    "reason",
    "refusalDetail",
    "resultTextTail",
    "stderrTail",
    "stdoutTail",
    "transcriptPath",
  ],
};

// The value scan behind B-2's "absolute paths in any field": a string that
// starts at the filesystem root or the home directory, or that embeds a
// well-known absolute prefix mid-sentence, strips the field holding it. The
// test is deliberately over-eager, because a false positive withholds a
// field and a false negative publishes a path.
const EMBEDDED_ABSOLUTE_PATH = /\/(Users|home|private|tmp|var)\//;

export function isPrivatePathString(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.includes("~/") || EMBEDDED_ABSOLUTE_PATH.test(value);
}

export interface RedactedPayload {
  // Present exactly when withheldPayload is false.
  readonly payload?: JsonValue;
  readonly withheldPayload: boolean;
  // Names of fields removed from an included payload, sorted and deduped:
  // B-1's annotation naming what was withheld.
  readonly withheldFields: readonly string[];
}

interface ScrubResult {
  readonly value: JsonValue;
  // True when the value itself is a private-path string (or an array
  // reaching one outside any named field): the nearest enclosing field is
  // stripped, since there is no smaller unit to remove.
  readonly bare: boolean;
}

function scrubValue(value: JsonValue, stripped: ReadonlySet<string>, removed: Set<string>): ScrubResult {
  if (typeof value === "string") return { value, bare: isPrivatePathString(value) };
  if (value === null || typeof value === "boolean" || typeof value === "number") return { value, bare: false };
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    let bare = false;
    for (const element of value) {
      const scrubbed = scrubValue(element, stripped, removed);
      if (scrubbed.bare) bare = true;
      out.push(scrubbed.value);
    }
    return { value: out, bare };
  }
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    if (stripped.has(key)) {
      removed.add(key);
      continue;
    }
    const scrubbed = scrubValue(value[key]!, stripped, removed);
    if (scrubbed.bare) {
      removed.add(key);
      continue;
    }
    out[key] = scrubbed.value;
  }
  return { value: out, bare: false };
}

// B-2 in one function: kind not on the allowlist is hash-only; on the
// allowlist, named fields and private-path values are stripped with each
// removal recorded by name. A payload that is itself a bare private-path
// value (no field to strip) degrades to fully withheld rather than leaking.
export function redactPayload(kind: string, payload: JsonValue, policy: RedactionPolicy = REDACTION_POLICY): RedactedPayload {
  if (!policy.includedKinds.includes(kind)) return { withheldPayload: true, withheldFields: [] };
  const removed = new Set<string>();
  const scrubbed = scrubValue(payload, new Set(policy.strippedFields), removed);
  if (scrubbed.bare) return { withheldPayload: true, withheldFields: [] };
  return { payload: scrubbed.value, withheldPayload: false, withheldFields: [...removed].sort() };
}

// --- the carried corpus attestation (spec 039) -------------------------------

// The chains prove they were not rewritten; they say nothing about which
// corpus the gate was adjudicating when they were written. `spec-spine attest
// --with-coupling` already emits a reproducible document over exactly that,
// so the export carries it whole (039 B-1). The bundle never interprets the
// document: the exporter copies the bytes spec-spine wrote and the hash
// spec-spine minted over them, and offline verification recomputes that hash
// and claims nothing further (039 B-2). Reproducing an attestation from a
// corpus needs the repository, which is precisely what the skeptic holding a
// bundle does not have.
export interface BundleAttestation {
  readonly attested: boolean;
  // Present exactly when attested: the document verbatim, and sha256 over
  // exactly those bytes (spec-spine's own attestationHash).
  readonly document?: string;
  readonly attestationHash?: string;
  // Present exactly when not attested: the recorded reason. A failed attest
  // never blocks an export, so absence is a state the bundle states rather
  // than a field it omits (039 B-1).
  readonly reason?: string;
}

// The fixed vocabulary of recorded absences (039 D-5). A reason travels in
// the bundle, so none of these interpolates tool output or a filesystem path:
// what a third party gets is the class of failure, and an operator who wants
// the detail runs `spec-spine attest --with-coupling` themselves and reads it
// on their own terminal. The one interpolated value is an exit code.
export const ATTEST_ABSENT = {
  notRun: "the export ran no attest",
  notSelfHosted: "the export ran outside the exported project's checkout",
  toolMissing: "spec-spine is not on PATH",
  toolFailed: "spec-spine attest --with-coupling failed",
  unparsedOutput: "spec-spine attest --with-coupling named no attestation path and hash",
  unreadable: "the attestation document spec-spine named could not be read",
  hashMismatch: "the attestation document did not match the hash spec-spine minted",
} as const;

export function attestationAbsent(reason: string): BundleAttestation {
  return { attested: false, reason };
}

// spec-spine reports both where it wrote the attestation and the hash it
// minted; both are read from that output rather than assumed, so the derived
// layout stays spec-spine's to change. The document itself is copied as
// opaque bytes and never parsed, which is what keeps this a carry rather than
// an ad-hoc read of a compiled artifact.
const ATTEST_PATH_LINE = /->\s*(\S.*?)\s*$/;
const ATTEST_HASH_LINE = /^\s*attestationHash:\s*([0-9a-f]{64})\s*$/;

function firstMatch(lines: readonly string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const found = pattern.exec(line);
    if (found !== null) return found[1]!;
  }
  return null;
}

// 039 B-1: attest the checkout, and answer with a recorded absence for every
// way that can fail. Nothing here throws, because a bundle whose export died
// on a missing tool would be worse evidence than one that says so.
export function runCorpusAttest(repoDir: string): BundleAttestation {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["spec-spine", "attest", "--with-coupling", "--repo", repoDir]);
  } catch {
    return attestationAbsent(ATTEST_ABSENT.toolMissing);
  }
  if (result.exitCode !== 0) return attestationAbsent(`${ATTEST_ABSENT.toolFailed} (exit ${result.exitCode})`);

  const lines = new TextDecoder().decode(result.stdout).split("\n");
  const documentPath = firstMatch(lines, ATTEST_PATH_LINE);
  const attestationHash = firstMatch(lines, ATTEST_HASH_LINE);
  if (documentPath === null || attestationHash === null) return attestationAbsent(ATTEST_ABSENT.unparsedOutput);

  let document: string;
  try {
    document = fs.readFileSync(documentPath, "utf8");
  } catch {
    return attestationAbsent(ATTEST_ABSENT.unreadable);
  }
  // The hash carried into the bundle is spec-spine's claim, checked against
  // the bytes at export time: a bundle never ships a pairing this side has
  // not already seen hold.
  if (sha256Hex(document) !== attestationHash) return attestationAbsent(ATTEST_ABSENT.hashMismatch);
  return { attested: true, document, attestationHash };
}

// --- bundle shape (B-1, B-5) -------------------------------------------------

export const BUNDLE_FORMAT = "observatory-journal-export";
// Unchanged by 039: the attestation is an additive member a reader that does
// not know it simply ignores, and refusing every bundle written before it
// (the committed evidence bundle included) would buy nothing (039 D-2).
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleRecord {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly prevHash: string;
  readonly recordHash: string;
  // sha256 over the canonical original payload, present for every record:
  // for a verbatim payload it is re-checkable offline, for a redacted or
  // withheld one it is the exporter's commitment, checkable against the
  // original journal by anyone who holds it.
  readonly payloadHash: string;
  readonly payload?: JsonValue;
  readonly withheldPayload: boolean;
  readonly withheldFields: readonly string[];
}

export interface BundleChain {
  readonly chain: "work" | "decisions";
  readonly file: string;
  readonly anchorHash: string;
  // Declared tail (B-3's truncation check): dropping records off the end of
  // the array leaves these behind to contradict it.
  readonly recordCount: number;
  readonly headRecordHash: string | null;
  readonly records: readonly BundleRecord[];
}

export interface JournalBundle {
  readonly format: string;
  readonly formatVersion: number;
  readonly policyVersion: number;
  readonly project: string | null;
  // 039 B-1: the corpus the gate was adjudicating, carried whole or recorded
  // absent. Optional only because bundles written before 039 have none, and
  // verification names that case as its own kind of absence (039 D-2).
  readonly attestation?: BundleAttestation;
  readonly chains: readonly BundleChain[];
}

export interface ChainSource {
  readonly anchorHash: string;
  readonly records: readonly JournalRecord[];
}

function toBundleRecord(record: JournalRecord, policy: RedactionPolicy): BundleRecord {
  const redacted = redactPayload(record.kind, record.payload, policy);
  return {
    seq: record.seq,
    ts: record.ts,
    kind: record.kind,
    prevHash: record.prevHash,
    recordHash: record.recordHash,
    payloadHash: sha256Hex(stableStringify(record.payload)),
    ...(redacted.withheldPayload ? {} : { payload: redacted.payload! }),
    withheldPayload: redacted.withheldPayload,
    withheldFields: redacted.withheldFields,
  };
}

function toBundleChain(chain: "work" | "decisions", file: string, source: ChainSource, policy: RedactionPolicy): BundleChain {
  const records = source.records.map((record) => toBundleRecord(record, policy));
  const last = records[records.length - 1];
  return {
    chain,
    file,
    anchorHash: source.anchorHash,
    recordCount: records.length,
    headRecordHash: last?.recordHash ?? null,
    records,
  };
}

// Pure assembly: same inputs, same bundle (B-5, 039 FR-001). Nothing here
// reads a clock or the filesystem, which is what makes two exports of the
// same journals and the same attestation byte-identical once serialized;
// running the attest is the caller's impure business, kept outside.
export function buildBundle(params: {
  readonly project: string | null;
  readonly work: ChainSource;
  readonly decisions: ChainSource;
  readonly policy?: RedactionPolicy;
  readonly attestation?: BundleAttestation;
}): JournalBundle {
  const policy = params.policy ?? REDACTION_POLICY;
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    policyVersion: policy.version,
    project: params.project,
    attestation: params.attestation ?? attestationAbsent(ATTEST_ABSENT.notRun),
    chains: [
      toBundleChain("work", "journal.jsonl", params.work, policy),
      toBundleChain("decisions", "decisions.jsonl", params.decisions, policy),
    ],
  };
}

// Canonical key order, two-space indent, trailing newline: deterministic
// bytes (B-5) that still diff readably once the bundle is committed.
export function serializeBundle(bundle: JournalBundle): string {
  return JSON.stringify(canonicalizeValue(bundle), null, 2) + "\n";
}

// --- reading the chains for export (B-4: read-only) --------------------------

// The four chain files of 011's on-disk format, by the same fixed names the
// offline verify command already uses. Reading them directly (never through
// openJournal) is what keeps export read-only: no writer lock is taken, no
// anchor is created where none exists, and a daemon holding the chains stays
// undisturbed.
const CHAIN_FILES = {
  work: { journal: "journal.jsonl", anchor: "anchor.json", basename: undefined },
  decisions: { journal: "decisions.jsonl", anchor: "decisions.anchor.json", basename: "decisions" },
} as const;

export type ExportResult =
  | { readonly ok: true; readonly bundle: JournalBundle }
  | { readonly ok: false; readonly reason: string };

function readChainSource(stateRoot: string, chain: keyof typeof CHAIN_FILES): { ok: true; source: ChainSource } | { ok: false; reason: string } {
  const names = CHAIN_FILES[chain];
  const anchorPath = join(stateRoot, names.anchor);
  if (!fs.existsSync(anchorPath)) {
    return { ok: false, reason: `the ${chain} chain has no anchor at ${anchorPath}: nothing to export` };
  }
  let anchorHash: string;
  try {
    const parsed = JSON.parse(fs.readFileSync(anchorPath, "utf8")) as { anchorHash?: unknown };
    if (typeof parsed?.anchorHash !== "string") throw new Error("anchor is not {anchorHash, createdAt}");
    anchorHash = parsed.anchorHash;
  } catch (err) {
    return { ok: false, reason: `the ${chain} chain's anchor is unreadable: ${(err as Error).message}` };
  }

  // A broken chain is refused by name rather than exported: a bundle that
  // fails its own verification would prove tampering where there was only a
  // damaged source, and B-3's verdict must stay unambiguous.
  const verdict = verifyChain(stateRoot, names.basename);
  if (!verdict.ok) {
    return { ok: false, reason: `the ${chain} chain is broken at seq ${verdict.brokenSeq} (${verdict.reason}): refusing to export` };
  }

  const journalPath = join(stateRoot, names.journal);
  if (!fs.existsSync(journalPath)) return { ok: true, source: { anchorHash, records: [] } };
  const text = fs.readFileSync(journalPath, "utf8");
  const lines = text.length ? text.split("\n").filter((line) => line.length > 0) : [];
  // verifyChain just recomputed every hash and link over these same bytes,
  // so this parse cannot meet a record it has not already validated.
  const records = lines.map((line) => JSON.parse(line) as JournalRecord);
  return { ok: true, source: { anchorHash, records } };
}

// Reads both chains of one state root and assembles the bundle. Export is
// read-only with respect to both chains (B-4); everything that can go wrong
// answers as a named reason, never a throw. The attestation arrives already
// run (or already recorded absent), so this stays a read of two chains.
export function exportBundleFromRoot(
  stateRoot: string,
  project: string | null,
  policy: RedactionPolicy = REDACTION_POLICY,
  attestation: BundleAttestation = attestationAbsent(ATTEST_ABSENT.notRun)
): ExportResult {
  const work = readChainSource(stateRoot, "work");
  if (!work.ok) return work;
  const decisions = readChainSource(stateRoot, "decisions");
  if (!decisions.ok) return decisions;
  return { ok: true, bundle: buildBundle({ project, work: work.source, decisions: decisions.source, policy, attestation }) };
}

// Writes the serialized bundle to a single file, creating parent directories
// as needed: the bundle is one committable artifact, not a directory tree.
export function writeBundle(bundle: JournalBundle, outPath: string): void {
  fs.mkdirSync(dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeBundle(bundle), "utf8");
}

// --- parsing a bundle back (for `journal verify --bundle`) -------------------

export type ParseBundleResult =
  | { readonly ok: true; readonly bundle: JournalBundle }
  | { readonly ok: false; readonly reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isBundleRecordShape(value: unknown): value is BundleRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seq === "number" &&
    Number.isInteger(record.seq) &&
    typeof record.ts === "string" &&
    typeof record.kind === "string" &&
    typeof record.prevHash === "string" &&
    typeof record.recordHash === "string" &&
    typeof record.payloadHash === "string" &&
    typeof record.withheldPayload === "boolean" &&
    isStringArray(record.withheldFields)
  );
}

function isBundleChainShape(value: unknown): value is BundleChain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const chain = value as Record<string, unknown>;
  return (
    (chain.chain === "work" || chain.chain === "decisions") &&
    typeof chain.file === "string" &&
    typeof chain.anchorHash === "string" &&
    typeof chain.recordCount === "number" &&
    Number.isInteger(chain.recordCount) &&
    (chain.headRecordHash === null || typeof chain.headRecordHash === "string") &&
    Array.isArray(chain.records) &&
    chain.records.every(isBundleRecordShape)
  );
}

// An attested block must carry both halves and an absent one its reason:
// a block that claims an attestation it does not carry is structurally
// unusable, not merely unverified. Whether the two halves agree is
// verifyAttestation()'s question, so a tampered document still parses.
function isBundleAttestationShape(value: unknown): value is BundleAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attestation = value as Record<string, unknown>;
  if (typeof attestation.attested !== "boolean") return false;
  if (attestation.attested) return typeof attestation.document === "string" && typeof attestation.attestationHash === "string";
  return typeof attestation.reason === "string";
}

// Structural validation only: whether the well-shaped content is intact is
// verifyBundle()'s question, and keeping the two apart is what lets a tamper
// answer with a named verification failure instead of a parse complaint.
export function parseBundle(text: string): ParseBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `the bundle is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the bundle is not a JSON object" };
  }
  const bundle = parsed as Record<string, unknown>;
  if (bundle.format !== BUNDLE_FORMAT) return { ok: false, reason: `unknown bundle format ${JSON.stringify(bundle.format)}` };
  if (bundle.formatVersion !== BUNDLE_FORMAT_VERSION) {
    return { ok: false, reason: `unsupported bundle format version ${JSON.stringify(bundle.formatVersion)} (this binary reads version ${BUNDLE_FORMAT_VERSION})` };
  }
  if (typeof bundle.policyVersion !== "number" || !Number.isInteger(bundle.policyVersion)) {
    return { ok: false, reason: "the bundle carries no integer policyVersion" };
  }
  if (bundle.project !== null && typeof bundle.project !== "string") {
    return { ok: false, reason: "the bundle's project is neither a string nor null" };
  }
  // Absent is the pre-039 bundle, and verification names it as such; present
  // and malformed is a bundle this binary cannot vouch for at all.
  if (bundle.attestation !== undefined && !isBundleAttestationShape(bundle.attestation)) {
    return { ok: false, reason: "the bundle's attestation block is neither an attestation nor a recorded absence" };
  }
  const chains = bundle.chains;
  if (!Array.isArray(chains) || chains.length !== 2 || !chains.every(isBundleChainShape)) {
    return { ok: false, reason: "the bundle does not carry exactly the work and decisions chains" };
  }
  if ((chains[0] as BundleChain).chain !== "work" || (chains[1] as BundleChain).chain !== "decisions") {
    return { ok: false, reason: "the bundle's chains are not [work, decisions]" };
  }
  return { ok: true, bundle: parsed as unknown as JournalBundle };
}

// --- offline verification (B-3, FR-001) --------------------------------------

export interface ChainVerification {
  readonly chain: string;
  readonly records: number;
  // Verbatim payloads, re-hashed all the way into the chain's recordHash.
  readonly payloadsVerified: number;
  // Included with fields withheld: readable, continuity-checked, and never
  // reported as verified content.
  readonly payloadsRedacted: number;
  readonly payloadsWithheld: number;
}

export type BundleVerifyResult =
  | { readonly ok: true; readonly chains: readonly ChainVerification[] }
  | { readonly ok: false; readonly chain: string; readonly seq: number | null; readonly reason: string };

// What recomputing the carried attestation's hash shows, and nothing wider
// (039 B-2). "intact" says the document travelled unaltered and stays
// spec-spine's to check against a checkout; it is never a claim that the
// corpus was verified here, which would need the repository the reader of a
// bundle does not have.
export type AttestationVerification =
  | { readonly state: "intact"; readonly attestationHash: string }
  | { readonly state: "mismatch"; readonly attestationHash: string; readonly computedHash: string }
  | { readonly state: "malformed"; readonly reason: string }
  | { readonly state: "absent"; readonly reason: string };

export const NO_ATTESTATION_BLOCK = "the bundle predates the attestation block";

// Deliberately not folded into verifyBundle: the chains are the bundle's
// claim and the attestation is provenance riding beside them, so a mangled
// document must not be able to make an intact chain read as broken (039
// FR-002). The caller combines the two verdicts; here they stay separable.
export function verifyAttestation(bundle: JournalBundle): AttestationVerification {
  const attestation = bundle.attestation;
  if (attestation === undefined) return { state: "absent", reason: NO_ATTESTATION_BLOCK };
  if (!attestation.attested) {
    return { state: "absent", reason: attestation.reason ?? "no reason recorded" };
  }
  const { document, attestationHash } = attestation;
  if (typeof document !== "string" || typeof attestationHash !== "string") {
    return { state: "malformed", reason: "the block claims an attestation it does not carry" };
  }
  const computedHash = sha256Hex(document);
  if (computedHash !== attestationHash) return { state: "mismatch", attestationHash, computedHash };
  return { state: "intact", attestationHash };
}

function fail(chain: string, seq: number | null, reason: string): BundleVerifyResult {
  return { ok: false, chain, seq, reason };
}

// No daemon, no original journal, no network: link-hash continuity across
// every record of both chains, full recomputation for every verbatim
// payload, and an honest three-way count. What a withheld record's hashes
// cannot prove offline (that its ts and kind are what was journaled) is not
// claimed; the payloadHash commitment leaves it checkable against the
// original by anyone who holds it.
export function verifyBundle(bundle: JournalBundle): BundleVerifyResult {
  const chains: ChainVerification[] = [];
  for (const chain of bundle.chains) {
    if (chain.records.length !== chain.recordCount) {
      return fail(chain.chain, null, `the chain declares ${chain.recordCount} records but carries ${chain.records.length} (truncated or padded)`);
    }
    let verified = 0;
    let redacted = 0;
    let withheld = 0;
    let prevHash = chain.anchorHash;
    for (let i = 0; i < chain.records.length; i++) {
      const record = chain.records[i]!;
      if (record.seq !== i) return fail(chain.chain, record.seq, `record sequence breaks at position ${i} (found seq ${record.seq})`);
      if (record.prevHash !== prevHash) return fail(chain.chain, record.seq, "prevHash does not link to its predecessor");
      if (record.withheldPayload) {
        if ("payload" in record) return fail(chain.chain, record.seq, "a record marked withheld carries a payload");
        withheld++;
      } else {
        if (!("payload" in record)) return fail(chain.chain, record.seq, "an included record carries no payload and no withheld annotation");
        if (record.withheldFields.length === 0) {
          if (sha256Hex(stableStringify(record.payload)) !== record.payloadHash) {
            return fail(chain.chain, record.seq, "included payload does not match its payload hash");
          }
          const recomputed = sha256Hex(
            stableStringify({ seq: record.seq, ts: record.ts, kind: record.kind, payload: record.payload, prevHash: record.prevHash })
          );
          if (recomputed !== record.recordHash) {
            return fail(chain.chain, record.seq, "recordHash does not match the included record content");
          }
          verified++;
        } else {
          redacted++;
        }
      }
      prevHash = record.recordHash;
    }
    const head = chain.records.length === 0 ? null : chain.records[chain.records.length - 1]!.recordHash;
    if (head !== chain.headRecordHash) {
      return fail(chain.chain, null, "the chain head does not match the declared head (truncated tail)");
    }
    chains.push({
      chain: chain.chain,
      records: chain.records.length,
      payloadsVerified: verified,
      payloadsRedacted: redacted,
      payloadsWithheld: withheld,
    });
  }
  return { ok: true, chains };
}
