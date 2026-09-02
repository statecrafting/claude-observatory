// The coherence mechanism across sessions (spec 020): an append-only,
// hash-linked ledger of decisions made where a spec was silent. Sessions
// cannot append to the chain directly (the daemon holds the writer lock);
// they write one JSON file per decision into a drop-box, and the
// orchestrator validates and seals the drop-box into the chain at stage end
// (B-3). Future sessions read the chain back through decisionsFor() (B-4,
// scope-matched, budget-bounded) or queryDecisions() (B-5, browsing).
//
// The chain reuses journal.ts's hash-linked envelope wholesale (B-2, "same
// implementation, second chain") under the basename "decisions", so
// decisions.jsonl and its own anchor live alongside journal.jsonl in the
// same directory without colliding files or a second implementation.
import * as fs from "fs";
import { join } from "path";
import type { FoldedState, JournalHandle, JsonValue } from "./journal";
import { openJournal, sha256Hex, stableStringify } from "./journal";

// --- record shape (B-1) ----------------------------------------------------

// scope: a list of spec ids and/or path prefixes the decision touches.
// alternatives: the spec is silent on this field's shape; resolved as free
// text per alternative considered and rejected (Resolved decisions, D-1).
export interface DecisionRecord {
  readonly id: string;
  readonly specId: string;
  readonly scope: readonly string[];
  readonly title: string;
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives?: readonly string[];
  readonly supersedes?: string;
}

const REQUIRED_FIELDS = ["id", "specId", "scope", "title", "decision", "rationale"] as const;
const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, "alternatives", "supersedes"]);

// --- content hash (B-2, B-3, FR-003) ---------------------------------------

// The canonical, chain-storable shape of a DecisionRecord: exactly the
// fields defined by B-1, optional fields omitted (never `undefined`) so
// canonicalizeValue (via stableStringify) accepts it. This is both what
// gets appended as the "decision.sealed" payload and what contentHashOf
// hashes, so two records that would seal to the same bytes always produce
// the same hash regardless of when either one was computed.
function decisionPayload(record: DecisionRecord): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    id: record.id,
    specId: record.specId,
    scope: [...record.scope],
    title: record.title,
    decision: record.decision,
    rationale: record.rationale,
  };
  if (record.alternatives !== undefined) payload.alternatives = [...record.alternatives];
  if (record.supersedes !== undefined) payload.supersedes = record.supersedes;
  return payload;
}

// Resolved decisions, D-2: the dedup key is sha256 over the canonical
// (key-sorted) JSON of the record's own fields, the same bytes stored as
// the "decision.sealed" payload, not the journal envelope (seq/ts/hashes
// vary per append attempt; the record's content does not). A crash between
// a chain append and the drop-box unlink leaves a dropbox file whose
// content hashes identically to the record already sealed, so a re-run
// recognizes it as already-sealed instead of duplicating it (FR-003).
export function contentHashOf(record: DecisionRecord): string {
  return sha256Hex(stableStringify(decisionPayload(record)));
}

// --- schema validation (FR-001) --------------------------------------------

export type DecisionValidationResult = { readonly ok: true; readonly record: DecisionRecord } | { readonly ok: false; readonly reason: string };

// Recursively scans for a JS number that is not a safe integer, the same
// portability rule journal.ts's canonicalizeValue enforces at hash time.
// Checked explicitly here (rather than relying on the throw from
// canonicalizeValue during sealing) so the drop-box flow can report a
// clean, specific "invalid" reason instead of an uncaught exception.
function findNonPortableNumberPath(value: unknown, path: string): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? null : path || "<root>";
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findNonPortableNumberPath(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findNonPortableNumberPath(v, path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return null;
}

// A "plausible repo path prefix": relative (no leading "/"), no parent
// traversal (".."), and built only from the characters an ordinary repo
// path uses. Deliberately permissive (this is a drop-box sanity check, not
// a filesystem existence check): a scope entry that is neither a known
// spec id nor shaped like this is rejected (FR-001).
function isPlausibleRepoPathPrefix(entry: string): boolean {
  if (entry.length === 0) return false;
  if (entry.startsWith("/")) return false;
  if (entry.includes("..")) return false;
  return /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?$/.test(entry);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Validates a raw drop-box payload against B-1's shape and FR-001's
// rejection classes (missing fields, unknown fields, floats, scope entries
// that are neither a known spec id nor a plausible repo path prefix).
// knownSpecIds is the caller's registry snapshot (sealDropbox's caller
// supplies it); this function never reaches out to spec-spine itself.
export function validateDecisionRecord(raw: unknown, knownSpecIds: ReadonlySet<string>): DecisionValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "payload is not a JSON object" };
  }

  const floatPath = findNonPortableNumberPath(raw, "");
  if (floatPath) {
    return { ok: false, reason: `field "${floatPath}" is a non-integer number (floats are not portable)` };
  }

  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, reason: `unknown field "${key}"` };
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined) {
      return { ok: false, reason: `missing field "${field}"` };
    }
  }

  if (typeof obj.id !== "string" || obj.id.length === 0) return { ok: false, reason: `field "id" must be a non-empty string` };
  if (typeof obj.specId !== "string" || obj.specId.length === 0) {
    return { ok: false, reason: `field "specId" must be a non-empty string` };
  }
  if (!isStringArray(obj.scope)) return { ok: false, reason: `field "scope" must be an array of strings` };
  if (typeof obj.title !== "string") return { ok: false, reason: `field "title" must be a string` };
  if (typeof obj.decision !== "string") return { ok: false, reason: `field "decision" must be a string` };
  if (typeof obj.rationale !== "string") return { ok: false, reason: `field "rationale" must be a string` };
  // D-7: an explicit null on an optional field reads as absent, not as a
  // malformed value. JSON writers spell "no value" both ways, and FR-001's
  // rejection classes do not include this one; rejecting it discarded three
  // whole butler-ai decisions over an encoding choice that loses no meaning.
  if (obj.alternatives !== null && obj.alternatives !== undefined && !isStringArray(obj.alternatives)) {
    return { ok: false, reason: `field "alternatives" must be an array of strings` };
  }
  if (
    obj.supersedes !== null &&
    obj.supersedes !== undefined &&
    (typeof obj.supersedes !== "string" || obj.supersedes.length === 0)
  ) {
    return { ok: false, reason: `field "supersedes" must be a non-empty string` };
  }

  for (const entry of obj.scope as string[]) {
    if (!knownSpecIds.has(entry) && !isPlausibleRepoPathPrefix(entry)) {
      return {
        ok: false,
        reason: `scope entry "${entry}" is neither a known spec id nor a plausible repo path prefix`,
      };
    }
  }

  const record: DecisionRecord = {
    id: obj.id,
    specId: obj.specId,
    scope: obj.scope as string[],
    title: obj.title,
    decision: obj.decision,
    rationale: obj.rationale,
    // D-7: null is absent, so it must not survive into the record either;
    // carried through, it would put a null in the canonical payload the
    // content hash is taken over.
    ...(obj.alternatives != null ? { alternatives: obj.alternatives as string[] } : {}),
    ...(obj.supersedes != null ? { supersedes: obj.supersedes as string } : {}),
  };
  return { ok: true, record };
}

// --- chain (B-2) -------------------------------------------------------

const CHAIN_KIND = "decision.sealed";
const OUTCOME_KIND = "decision.sealed.outcome";

// D-6: where a rejected drop-box file is preserved. A subdirectory of the
// drop-box itself, so the operator finds it next to the records it failed
// to join, and so nothing needs a second configured path.
export const QUARANTINE_DIRNAME = "invalid";

// Opens the decision chain: decisions.jsonl + its own anchor, in `dir`,
// through journal.ts's parameterized opener (basename "decisions"). Reused
// wholesale, not reimplemented (B-2).
export function openDecisionsChain(dir: string): JournalHandle {
  return openJournal(dir, "decisions");
}

function asRecord(v: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`decisions: ${label} expected a JSON object payload`);
  }
  return v as Record<string, JsonValue>;
}

function asString(o: Record<string, JsonValue>, field: string): string {
  const v = o[field];
  if (typeof v !== "string") throw new Error(`decisions: expected string field "${field}"`);
  return v;
}

function asStringArrayField(o: Record<string, JsonValue>, field: string): string[] {
  const v = o[field];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`decisions: expected string array field "${field}"`);
  }
  return v as string[];
}

function parseDecisionRecordPayload(payload: JsonValue): DecisionRecord {
  const o = asRecord(payload, CHAIN_KIND);
  const record: DecisionRecord = {
    id: asString(o, "id"),
    specId: asString(o, "specId"),
    scope: asStringArrayField(o, "scope"),
    title: asString(o, "title"),
    decision: asString(o, "decision"),
    rationale: asString(o, "rationale"),
    ...(o.alternatives !== undefined ? { alternatives: asStringArrayField(o, "alternatives") } : {}),
    ...(o.supersedes !== undefined ? { supersedes: asString(o, "supersedes") } : {}),
  };
  return record;
}

// Reads every sealed decision back out of a folded chain state, in chain
// (append) order, oldest first. decisionsFor/queryDecisions below both
// expect that ordering and reverse it themselves for newest-first output.
export function decisionRecordsFromChain(state: FoldedState): DecisionRecord[] {
  const records = state.byKind[CHAIN_KIND] ?? [];
  return records.map((r) => parseDecisionRecordPayload(r.payload));
}

// --- drop-box (B-3, FR-003) -------------------------------------------------

export interface SealDropboxParams {
  readonly dropboxDir: string;
  readonly chain: JournalHandle;
  readonly knownSpecIds: ReadonlySet<string>;
  readonly journal: JournalHandle;
}

export interface SealDropboxInvalid {
  readonly file: string;
  readonly reason: string;
}

export interface SealDropboxResult {
  readonly sealed: readonly DecisionRecord[];
  readonly invalid: readonly SealDropboxInvalid[];
}

// Validates every *.json file in the drop-box against the schema, seals
// valid ones into the chain, and journals a summary of the sweep into the
// work journal handle passed in (not the decisions chain itself), kind
// "decision.sealed.outcome". A valid file is unlinked only after its chain
// append has fsynced (append() is fully synchronous, so by the time it
// returns the record is durable) or, on a re-run after a crash between a
// prior seal and unlink, once its content hash is found already sealed
// (dedup, FR-003).
//
// D-6: an invalid file is preserved, as B-3 requires, but preserved in the
// quarantine subdirectory rather than in place. Left in place it is re-read,
// re-rejected and re-reported by every later sweep in the same project,
// without bound and with no path to resolution: found live on butler-ai,
// where eight files rejected on 2026-09-01 were still being re-reported in
// every build two days later. Quarantine keeps the session's work (the
// operator can repair a file and move it back) while making the sweep
// report only what this sweep found.
export function sealDropbox(params: SealDropboxParams): SealDropboxResult {
  const { dropboxDir, chain, knownSpecIds, journal } = params;

  const existingHashes = new Set(decisionRecordsFromChain(chain.fold()).map(contentHashOf));

  const files = fs.existsSync(dropboxDir)
    ? fs
        .readdirSync(dropboxDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];

  // Created lazily, so a project that never writes a bad record never grows
  // an empty directory.
  const quarantineDir = join(dropboxDir, QUARANTINE_DIRNAME);
  const quarantine = (file: string): void => {
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.renameSync(join(dropboxDir, file), join(quarantineDir, file));
  };

  const sealed: DecisionRecord[] = [];
  const invalid: SealDropboxInvalid[] = [];

  for (const file of files) {
    const filePath = join(dropboxDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      invalid.push({ file, reason: `malformed JSON: ${(err as Error).message}` });
      quarantine(file);
      continue;
    }

    const result = validateDecisionRecord(parsed, knownSpecIds);
    if (!result.ok) {
      invalid.push({ file, reason: result.reason });
      quarantine(file);
      continue;
    }

    const hash = contentHashOf(result.record);
    if (!existingHashes.has(hash)) {
      chain.append(CHAIN_KIND, decisionPayload(result.record));
      existingHashes.add(hash);
    }
    // Reached only once the record is durably in the chain, whether that
    // happened just now or already happened before a crash on a prior run.
    fs.unlinkSync(filePath);
    sealed.push(result.record);
  }

  const outcome: Record<string, JsonValue> = {
    sealedIds: sealed.map((r) => r.id),
    invalidFiles: invalid.map((i) => ({ file: i.file, reason: i.reason })),
  };
  // Named only when it exists, so the record points an operator at the files
  // without asserting a directory that was never created.
  if (invalid.length > 0) outcome.quarantineDir = quarantineDir;
  journal.append(OUTCOME_KIND, outcome);

  return { sealed, invalid };
}

// --- injection (B-4) --------------------------------------------------

function normalizePathPrefix(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

// Two scope entries "overlap" when one is a prefix of the other's directory
// path (either direction), so a decision scoped to a directory matches a
// spec whose territory is a file beneath it, and vice versa.
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalizePathPrefix(a);
  const nb = normalizePathPrefix(b);
  return na.startsWith(nb) || nb.startsWith(na);
}

export interface DecisionsForParams {
  // Sealed decisions in chain (append) order, oldest first.
  readonly records: readonly DecisionRecord[];
  readonly specId: string;
  readonly dependsOnClosure: readonly string[];
  readonly territoryPaths: readonly string[];
  readonly budgetChars: number;
}

export interface DecisionsForResult {
  readonly included: readonly DecisionRecord[];
  readonly overflowCount: number;
}

// Selects records whose scope intersects specId, its depends_on closure, or
// its territory paths, newest-first, with superseded records resolved away
// (a record named in any other record's `supersedes` is shadowed), bounded
// to budgetChars. Never silently truncates: everything past the budget is
// counted in overflowCount instead of dropped without a trace (B-4).
export function decisionsFor(params: DecisionsForParams): DecisionsForResult {
  const { records, specId, dependsOnClosure, territoryPaths, budgetChars } = params;

  const shadowed = new Set<string>();
  for (const r of records) {
    if (r.supersedes !== undefined) shadowed.add(r.supersedes);
  }

  const specMatch = new Set<string>([specId, ...dependsOnClosure]);

  const matching = records.filter((r) => {
    if (shadowed.has(r.id)) return false;
    return r.scope.some((s) => specMatch.has(s) || territoryPaths.some((tp) => pathsOverlap(s, tp)));
  });

  // records arrives oldest-first (chain order); newest-first is the reverse.
  const newestFirst = [...matching].reverse();

  const included: DecisionRecord[] = [];
  let used = 0;
  let overflowCount = 0;
  for (let i = 0; i < newestFirst.length; i++) {
    const record = newestFirst[i]!;
    const size = stableStringify(decisionPayload(record)).length;
    if (used + size <= budgetChars) {
      included.push(record);
      used += size;
    } else {
      overflowCount = newestFirst.length - i;
      break;
    }
  }

  return { included, overflowCount };
}

// --- query (B-5, supports spec 022) ----------------------------------------

export interface DecisionQuery {
  readonly specId?: string;
  readonly path?: string;
  readonly text?: string;
}

// Simple filters over the full ledger (including superseded records: this
// is browsing, not injection, so nothing is resolved away). All provided
// filters must match (AND); full-text is a case-insensitive substring over
// title + decision + rationale. Returns newest-first, consistent with
// decisionsFor.
export function queryDecisions(records: readonly DecisionRecord[], query: DecisionQuery): DecisionRecord[] {
  const needle = query.text?.toLowerCase();

  const matching = records.filter((r) => {
    if (query.specId !== undefined && r.specId !== query.specId) return false;
    if (query.path !== undefined && !r.scope.some((s) => pathsOverlap(s, query.path!))) return false;
    if (needle !== undefined) {
      const haystack = `${r.title} ${r.decision} ${r.rationale}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return [...matching].reverse();
}
