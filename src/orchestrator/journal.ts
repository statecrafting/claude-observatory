// The orchestrator's crash-consistent memory: an append-only, hash-linked
// JSONL journal. Each line is a sealed record {seq, ts, kind, payload,
// prevHash, recordHash}; recordHash binds the record's own content, prevHash
// binds it to its predecessor (the genesis record binds to an anchor hash
// stored alongside the journal). State is never trusted from memory: it is
// always recovered by folding the journal (B-5).
//
// The envelope and its hash-linkage discipline mirror the family's
// attest-ledger record chain (canonical key-sorted JSON, sha256, prevHash
// chaining), reimplemented here as a small pure module rather than pulled in
// as a dependency, per this repo's zero-runtime-dependency convention.
import * as fs from "fs";
import { join } from "path";
import { createHash } from "crypto";

// --- record envelope -------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JournalRecord {
  seq: number;
  ts: string;
  kind: string;
  payload: JsonValue;
  prevHash: string;
  recordHash: string;
}

export interface FoldedState {
  records: JournalRecord[];
  byKind: Record<string, JournalRecord[]>;
}

// The pure fold: groups the raw record list by kind. This is a placeholder
// (spec 011's honest minimum); the real orchestrator state machine (runs,
// specs, stages, quota) is built on top of this in spec 013 and must not be
// anticipated here.
export function foldState(records: readonly JournalRecord[]): FoldedState {
  const byKind: Record<string, JournalRecord[]> = {};
  for (const r of records) {
    (byKind[r.kind] ??= []).push(r);
  }
  return { records: [...records], byKind };
}

export interface JournalHandle {
  readonly dir: string;
  readonly headSeq: number; // -1 when the journal is empty (nothing past the anchor)
  // The fold as of open() (or the last torn-tail recovery). Appends made
  // through this handle are not reflected here; call fold() for a fresh view.
  readonly state: FoldedState;
  readonly tornRecovered: boolean;
  append(kind: string, payload: JsonValue): JournalRecord;
  fold(): FoldedState;
  close(): void;
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenSeq: number; reason: string };

// --- canonical JSON + hashing ------------------------------------------

// Recursive lexicographic key-sort, restricted to the attest-ledger
// portability set: integers, strings, booleans, null, arrays, and plain
// objects of the same. Floats and any other JS value throw, so a payload
// that would hash differently on another runtime is rejected before it ever
// reaches disk.
export function canonicalizeValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`canonicalize: non-integer number ${value} is not portable (integers only)`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("canonicalize: only plain objects are portable");
    }
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function computeRecordHash(base: Omit<JournalRecord, "recordHash">): string {
  return sha256Hex(stableStringify(base));
}

// --- durable I/O helpers -------------------------------------------------

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += fs.writeSync(fd, buf, offset, buf.length - offset);
  }
}

// Write + fsync in one call, so callers never observe a half-written file
// for anchors, torn sidecars, or truncation.
function writeFileDurable(path: string, data: Buffer): void {
  const fd = fs.openSync(path, "w");
  try {
    writeAllSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function truncateJournalDurable(path: string, length: number): void {
  fs.truncateSync(path, length);
  const fd = fs.openSync(path, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// --- anchor ---------------------------------------------------------------

interface Anchor {
  anchorHash: string;
  createdAt: string;
}

function loadOrCreateAnchor(anchorPath: string): Anchor {
  if (fs.existsSync(anchorPath)) {
    const parsed = JSON.parse(fs.readFileSync(anchorPath, "utf8"));
    if (typeof parsed?.anchorHash !== "string" || typeof parsed?.createdAt !== "string") {
      throw new Error(`anchor corrupted: ${anchorPath}: run verifyChain() to diagnose`);
    }
    return parsed;
  }
  const createdAt = new Date().toISOString();
  const anchorHash = sha256Hex(stableStringify({ kind: "orchestrator-journal-anchor", createdAt }));
  const anchor: Anchor = { anchorHash, createdAt };
  writeFileDurable(anchorPath, Buffer.from(JSON.stringify(anchor) + "\n", "utf8"));
  return anchor;
}

// --- lock -------------------------------------------------------------

// One writer per journal (B-2). "wx" is O_CREAT|O_EXCL|O_WRONLY: creation
// fails atomically if the lockfile already exists, which is what makes this
// exclusive rather than merely advisory-by-convention. Stale-lock cleanup
// after a confirmed-dead writer is deliberately not automated here
// (multi-writer coordination is out of scope, spec 011 section 6); a
// supervisor that knows the previous writer is dead removes the lockfile
// itself before reopening.
function acquireLock(lockPath: string): number {
  try {
    const fd = fs.openSync(lockPath, "wx");
    writeAllSync(fd, Buffer.from(`${process.pid}\n`, "utf8"));
    fs.fsyncSync(fd);
    return fd;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `journal locked: another writer holds ${lockPath} (remove it once that writer is confirmed dead)`
      );
    }
    throw err;
  }
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already removed
  }
}

// --- shape validation -------------------------------------------------

function isJournalRecordShape(v: unknown): v is JournalRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.seq === "number" &&
    Number.isInteger(r.seq) &&
    typeof r.ts === "string" &&
    typeof r.kind === "string" &&
    "payload" in r &&
    typeof r.prevHash === "string" &&
    typeof r.recordHash === "string"
  );
}

// --- open + recover -------------------------------------------------

interface Recovered {
  records: JournalRecord[];
  tornRecovered: boolean;
}

// Reads the journal, recovers a torn tail if present, and validates only the
// tail's hash and link (B-3): earlier lines are parsed and shape-checked for
// folding but not re-hashed, so open() stays cheap regardless of how many
// records already exist. A full recompute of every record is verifyChain()'s
// job, run on demand.
function readAndRecover(journalPath: string, tornPath: string, anchorHash: string): Recovered {
  const raw = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : Buffer.alloc(0);
  let goodBuf = raw;
  let tornRecovered = false;

  if (raw.length > 0) {
    // Every append fsyncs its line together with the trailing newline, so a
    // missing trailing newline is itself the signal that the last write
    // never reached the acknowledge point, independent of whether the bytes
    // that did land happen to parse as JSON.
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline !== raw.length - 1) {
      const tornBytes = raw.subarray(lastNewline + 1);
      goodBuf = raw.subarray(0, lastNewline + 1);
      writeFileDurable(tornPath, tornBytes);
      truncateJournalDurable(journalPath, goodBuf.length);
      tornRecovered = true;
    }
  }

  const lineTexts = goodBuf.length ? goodBuf.toString("utf8").split("\n").filter((l) => l.length > 0) : [];

  const records: JournalRecord[] = [];
  for (let i = 0; i < lineTexts.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineTexts[i]!);
    } catch {
      throw new Error(`journal corrupted at seq ${i} (line is not valid JSON): run verifyChain() to diagnose`);
    }
    if (!isJournalRecordShape(parsed) || parsed.seq !== i) {
      throw new Error(`journal corrupted at seq ${i} (unexpected record shape): run verifyChain() to diagnose`);
    }
    records.push(parsed);
  }

  if (records.length > 0) {
    const tail = records[records.length - 1]!;
    const expectedPrev = records.length > 1 ? records[records.length - 2]!.recordHash : anchorHash;
    if (tail.prevHash !== expectedPrev) {
      throw new Error(
        `journal corrupted at seq ${tail.seq} (prevHash does not link to its predecessor): run verifyChain() to diagnose`
      );
    }
    const { recordHash, ...rest } = tail;
    if (computeRecordHash(rest) !== recordHash) {
      throw new Error(
        `journal corrupted at seq ${tail.seq} (recordHash does not match its content): run verifyChain() to diagnose`
      );
    }
  }

  return { records, tornRecovered };
}

class JournalHandleImpl implements JournalHandle {
  readonly dir: string;
  readonly state: FoldedState;
  readonly tornRecovered: boolean;
  private records: JournalRecord[];
  private head: { seq: number; hash: string };
  private readonly fd: number;
  private readonly lockFd: number;
  private readonly lockPath: string;
  private closed = false;

  constructor(
    dir: string,
    records: JournalRecord[],
    anchorHash: string,
    tornRecovered: boolean,
    fd: number,
    lockFd: number,
    lockPath: string
  ) {
    this.dir = dir;
    this.records = records;
    this.tornRecovered = tornRecovered;
    this.state = foldState(records);
    const last = records[records.length - 1];
    this.head = last ? { seq: last.seq, hash: last.recordHash } : { seq: -1, hash: anchorHash };
    this.fd = fd;
    this.lockFd = lockFd;
    this.lockPath = lockPath;
  }

  get headSeq(): number {
    return this.head.seq;
  }

  // O(1): one hash of the new record's own bytes, one write, one fsync. No
  // re-read or re-verification of prior records (B-3).
  append(kind: string, payload: JsonValue): JournalRecord {
    if (this.closed) throw new Error("journal is closed");
    const seq = this.head.seq + 1;
    const ts = new Date().toISOString();
    const base = { seq, ts, kind, payload, prevHash: this.head.hash };
    const recordHash = computeRecordHash(base);
    const record: JournalRecord = { ...base, recordHash };

    const line = Buffer.from(stableStringify(record) + "\n", "utf8");
    writeAllSync(this.fd, line);
    // Durability: the append is acknowledged (this call returns) only after
    // fsync, never merely after write() returning.
    fs.fsyncSync(this.fd);

    this.head = { seq, hash: recordHash };
    this.records.push(record);
    return record;
  }

  fold(): FoldedState {
    return foldState(this.records);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
    releaseLock(this.lockFd, this.lockPath);
  }
}

export function openJournal(dir: string): JournalHandle {
  fs.mkdirSync(dir, { recursive: true });
  const journalPath = join(dir, "journal.jsonl");
  const anchorPath = join(dir, "anchor.json");
  const tornPath = join(dir, "journal.jsonl.torn");
  const lockPath = join(dir, "journal.lock");

  const lockFd = acquireLock(lockPath);
  try {
    const anchor = loadOrCreateAnchor(anchorPath);
    if (!fs.existsSync(journalPath)) writeFileDurable(journalPath, Buffer.alloc(0));

    const { records, tornRecovered } = readAndRecover(journalPath, tornPath, anchor.anchorHash);
    const fd = fs.openSync(journalPath, "a");
    return new JournalHandleImpl(dir, records, anchor.anchorHash, tornRecovered, fd, lockFd, lockPath);
  } catch (err) {
    releaseLock(lockFd, lockPath);
    throw err;
  }
}

// --- full verification -------------------------------------------------

// Recomputes every record's hash and link from the anchor forward. Unlike
// open()'s tail-only check, this is O(n) hashing and is meant to be run on
// demand (offline, by a CLI), not on every open (B-7).
export function verifyChain(dir: string): VerifyResult {
  const anchorPath = join(dir, "anchor.json");
  const journalPath = join(dir, "journal.jsonl");
  if (!fs.existsSync(anchorPath)) {
    throw new Error(`no anchor at ${anchorPath}: nothing to verify`);
  }
  const anchor: Anchor = JSON.parse(fs.readFileSync(anchorPath, "utf8"));
  if (!fs.existsSync(journalPath)) return { ok: true, count: 0 };

  const text = fs.readFileSync(journalPath, "utf8");
  const lines = text.length ? text.split("\n").filter((l) => l.length > 0) : [];

  let prevHash = anchor.anchorHash;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, brokenSeq: i, reason: "line is not valid JSON" };
    }
    if (!isJournalRecordShape(parsed) || parsed.seq !== i) {
      return { ok: false, brokenSeq: i, reason: "unexpected record shape" };
    }
    if (parsed.prevHash !== prevHash) {
      return { ok: false, brokenSeq: i, reason: "prevHash does not link to its predecessor" };
    }
    const { recordHash, ...rest } = parsed;
    if (computeRecordHash(rest) !== recordHash) {
      return { ok: false, brokenSeq: i, reason: "recordHash does not match its content" };
    }
    prevHash = recordHash;
  }
  return { ok: true, count: lines.length };
}

// --- intent/outcome bracket (B-4) -------------------------------------

const INTENT_SUFFIX = ".intent";
const OUTCOME_SUFFIX = ".outcome";

export function appendIntent(handle: JournalHandle, op: string, payload: JsonValue): JournalRecord {
  return handle.append(`${op}${INTENT_SUFFIX}`, payload);
}

export function appendOutcome(handle: JournalHandle, op: string, payload: JsonValue): JournalRecord {
  return handle.append(`${op}${OUTCOME_SUFFIX}`, payload);
}

// An intent with no later outcome of the same op is "unknown, must
// reconcile" on recovery, never assumed successful (B-4). Pairing is
// order-aware per op (each outcome resolves the oldest unmatched intent of
// its op), so a repeated op whose latest intent never completed still
// surfaces as unresolved; an operation that needs to correlate a specific
// intent to a specific outcome carries its own key in payload (FR-002) and
// reconciles it itself. This is the honest minimum the journal can say from
// kind names, not a state machine (that arrives with spec 013).
export function unresolvedIntents(records: readonly JournalRecord[]): JournalRecord[] {
  const pendingByOp = new Map<string, JournalRecord[]>();
  for (const r of records) {
    if (r.kind.endsWith(INTENT_SUFFIX)) {
      const op = r.kind.slice(0, -INTENT_SUFFIX.length);
      (pendingByOp.get(op) ?? pendingByOp.set(op, []).get(op)!).push(r);
    } else if (r.kind.endsWith(OUTCOME_SUFFIX)) {
      pendingByOp.get(r.kind.slice(0, -OUTCOME_SUFFIX.length))?.shift();
    }
  }
  return [...pendingByOp.values()].flat().sort((a, b) => a.seq - b.seq);
}
