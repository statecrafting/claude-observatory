// The spec DAG resolver the orchestrator schedules from. spec-spine compiles
// depends_on into a clean graph but deliberately attaches no mechanics to it
// (no readiness, no cycle detection, no invalidation); this module is those
// mechanics, computed honestly from a target repo's own corpus.
//
// Structural data comes only from `spec-spine registry list/show --json`
// subprocess calls (B-1); the compiled `.derived/**` JSON is never read
// directly (governed-artifact-reads.md). Subprocess execution and file reads
// sit behind the injected DagReader (FR-002), so every readiness,
// invalidation, cycle, and next-ready computation below is a pure function
// of (registry snapshot, shipped-set, pin lookup): tests run entirely
// against fixtures, no subprocess involved.
import * as fs from "fs";
import { join } from "path";
import { sha256Hex } from "./journal";

// --- registry snapshot ----------------------------------------------------

export interface RegistrySpecEntry {
  readonly id: string;
  readonly implementation: string | undefined;
  readonly dependsOn: readonly string[];
}

// Keyed by spec id; the pure functions below only ever need lookup by id, so
// this is a map rather than the raw `list --json` array.
export type RegistrySnapshot = ReadonlyMap<string, RegistrySpecEntry>;

// --- shipped-set (D-1: provenance lives outside this module) --------------

// D-1: this module does not decide how a spec came to count as shipped; it
// only consumes the result. "pipeline" is a spec shipped through the
// orchestrator's own ship stage (spec 021 journals it); "adopted" is a
// bootstrap-era spec that predates the orchestrator, pinned at first
// observation by adoptedShipped() below (the daemon journals the adoption).
export type ShippedSource = "pipeline" | "adopted";

export interface ShippedEntry {
  readonly pin: string;
  readonly source: ShippedSource;
}

export type ShippedMap = ReadonlyMap<string, ShippedEntry>;

export type PinLookup = (specId: string) => string;

export interface SpecBlocker {
  readonly specId: string;
  readonly reasons: readonly string[];
}

// nextReady() returns the bare id string when a spec is ready to run
// (AC-2: `nextReady(...) === "011-work-journal"`), or the blockers shape
// when nothing is ready (B-6: "honest blockers for the UI").
export type NextReadyResult = string | { readonly ready: null; readonly blockers: readonly SpecBlocker[] };

// --- governed reads (B-1, FR-001, FR-002) ----------------------------------

// Injected boundary: the production implementation shells out to spec-spine
// and reads specs/<id>/spec.md; tests supply a fixture reader instead. Every
// pure function past this section takes a RegistrySnapshot/ShippedMap/
// PinLookup built through a reader, never the reader itself.
export interface DagReader {
  registryListJson(repoDir: string): string;
  registryShowJson(repoDir: string, specId: string): string;
  readSpecFile(repoDir: string, specId: string): Buffer;
}

function runSpecSpine(args: readonly string[]): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["spec-spine", ...args]);
  } catch (err) {
    throw new Error(`dag: spec-spine not found on PATH (needed for "${args.join(" ")}"): ${(err as Error).message}`);
  }
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`dag: spec-spine ${args.join(" ")} failed (exit ${result.exitCode}): ${stderr.trim()}`);
  }
  return new TextDecoder().decode(result.stdout);
}

// The production reader (Bun.spawnSync + fs). Never used by dag.test.ts,
// which builds fixtures by hand (FR-002).
export function createProcessDagReader(): DagReader {
  return {
    registryListJson(repoDir: string): string {
      return runSpecSpine(["registry", "list", "--json", "--repo", repoDir]);
    },
    registryShowJson(repoDir: string, specId: string): string {
      return runSpecSpine(["registry", "show", specId, "--json", "--repo", repoDir]);
    },
    readSpecFile(repoDir: string, specId: string): Buffer {
      const path = join(repoDir, "specs", specId, "spec.md");
      try {
        return fs.readFileSync(path);
      } catch (err) {
        throw new Error(`dag: cannot read spec file for ${specId} at ${path}: ${(err as Error).message}`);
      }
    },
  };
}

function parseRegistrySpecEntry(item: unknown, label: string): RegistrySpecEntry {
  if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).id !== "string") {
    throw new Error(`dag: ${label} produced unparseable output (entry missing string id)`);
  }
  const obj = item as Record<string, unknown>;
  const implementation = typeof obj.implementation === "string" ? obj.implementation : undefined;
  const dependsOnRaw = obj.dependsOn;
  const dependsOn = Array.isArray(dependsOnRaw) ? dependsOnRaw.filter((d): d is string => typeof d === "string") : [];
  return { id: obj.id as string, implementation, dependsOn };
}

// Loads a RegistrySnapshot through the injected reader (FR-002). This is the
// only place `spec-spine registry list --json` output is parsed; unparseable
// output is a typed error, never an empty snapshot (FR-001).
export function loadRegistrySnapshot(reader: DagReader, repoDir: string): RegistrySnapshot {
  const label = "spec-spine registry list --json";
  const raw = reader.registryListJson(repoDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dag: ${label} produced unparseable output: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`dag: ${label} produced unparseable output (expected a JSON array)`);
  }
  const specs = new Map<string, RegistrySpecEntry>();
  for (const item of parsed) {
    const entry = parseRegistrySpecEntry(item, label);
    specs.set(entry.id, entry);
  }
  return specs;
}

// Single-spec counterpart of loadRegistrySnapshot, through `registry show
// --json` (B-1). Not used by the pure DAG functions (they operate on a full
// snapshot), but exposed for callers that only need one spec's current
// registry-recorded state.
export function showRegistrySpec(reader: DagReader, repoDir: string, specId: string): RegistrySpecEntry {
  const label = "spec-spine registry show --json";
  const raw = reader.registryShowJson(repoDir, specId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dag: ${label} produced unparseable output: ${(err as Error).message}`);
  }
  return parseRegistrySpecEntry(parsed, label);
}

// --- contract pinning (B-2) ------------------------------------------------

// Same normalization spec-spine's own content hashing uses (crates/spec-spine-core/src/hash.rs
// normalize()): strip a leading UTF-8 BOM, then fold CRLF and lone CR to LF,
// so the pin is stable across platforms and line-ending styles.
export function normalizeForHash(text: string): string {
  const noBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function pinOfBytes(bytes: Buffer): string {
  return sha256Hex(normalizeForHash(bytes.toString("utf8")));
}

// pinOf(specId) = sha256 over specs/<id>/spec.md, normalized per above.
export function pinOf(reader: DagReader, repoDir: string, specId: string): string {
  return pinOfBytes(reader.readSpecFile(repoDir, specId));
}

// Closes over (reader, repoDir) into the PinLookup shape the pure functions
// below take, so the I/O boundary is crossed exactly once per call site.
export function makePinLookup(reader: DagReader, repoDir: string): PinLookup {
  return (specId: string) => pinOf(reader, repoDir, specId);
}

// --- internal helpers -------------------------------------------------

function mustGetSpec(snapshot: RegistrySnapshot, specId: string): RegistrySpecEntry {
  const entry = snapshot.get(specId);
  if (!entry) throw new Error(`dag: unknown spec id ${specId} (not present in the registry snapshot)`);
  return entry;
}

function isValidlyShipped(specId: string, shipped: ShippedMap, invalid: ReadonlySet<string>): boolean {
  return shipped.has(specId) && !invalid.has(specId);
}

function readyGivenInvalid(entry: RegistrySpecEntry, shipped: ShippedMap, invalid: ReadonlySet<string>): boolean {
  return entry.dependsOn.every((dep) => isValidlyShipped(dep, shipped, invalid));
}

// Numeric-lexicographic order on "NNN-slug" ids, so "002-x" sorts before
// "010-y" (plain string compare would not).
function compareSpecIds(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

// --- readiness (B-3) --------------------------------------------------

// ready(specId) iff every depends_on target is currently, validly shipped:
// present in the shipped-set and not dropped to invalidated by a pin drift
// anywhere upstream (see invalidatedSet). A spec with no dependencies is
// always ready.
export function ready(snapshot: RegistrySnapshot, shipped: ShippedMap, pinOf: PinLookup, specId: string): boolean {
  const entry = mustGetSpec(snapshot, specId);
  const invalid = invalidatedSet(snapshot, shipped, pinOf);
  return readyGivenInvalid(entry, shipped, invalid);
}

// --- invalidation cascade (B-4) ----------------------------------------

// A shipped spec is a "drifted root" when its own recorded pin no longer
// matches pinOf() now: its spec.md was amended after it shipped. Every
// transitive dependent of a drifted root that was itself shipped drops to
// invalidated, cascading through the full depends_on graph regardless of
// how many hops deep (FR-003: cascade depth >= 2).
export function invalidatedSet(snapshot: RegistrySnapshot, shipped: ShippedMap, pinOf: PinLookup): ReadonlySet<string> {
  const driftedRoots: string[] = [];
  for (const [id, entry] of shipped) {
    if (entry.pin !== pinOf(id)) driftedRoots.push(id);
  }
  if (driftedRoots.length === 0) return new Set();

  const dependents = new Map<string, string[]>();
  for (const [id, entry] of snapshot) {
    for (const dep of entry.dependsOn) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(id);
    }
  }

  const visited = new Set<string>();
  const invalid = new Set<string>();
  const queue: string[] = [...driftedRoots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (shipped.has(id)) invalid.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      if (!visited.has(dependent)) queue.push(dependent);
    }
  }
  return invalid;
}

// --- cycle detection (B-5) ----------------------------------------------

// DFS over the full depends_on graph; returns the cycle path (closing back
// on its own start, e.g. ["012-a", "016-b", "012-a"]) or null if acyclic.
// Pure and exception-free: nextReady() below decides whether a found cycle
// actually refuses scheduling.
export function findCycle(snapshot: RegistrySnapshot): readonly string[] | null {
  const DONE = "done";
  const VISITING = "visiting";
  const state = new Map<string, typeof DONE | typeof VISITING>();
  const stack: string[] = [];

  function visit(id: string): readonly string[] | null {
    state.set(id, VISITING);
    stack.push(id);
    const entry = snapshot.get(id);
    for (const dep of entry?.dependsOn ?? []) {
      const depState = state.get(dep);
      if (depState === VISITING) {
        const cycleStart = stack.indexOf(dep);
        return [...stack.slice(cycleStart), dep];
      }
      if (depState !== DONE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, DONE);
    return null;
  }

  for (const id of [...snapshot.keys()].sort(compareSpecIds)) {
    if (state.get(id) !== DONE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// A cycle only refuses scheduling when at least one spec on it is not
// shipped (B-5): a cycle entirely among already-shipped specs cannot block
// anything, since nothing on it is waiting to become ready.
function cycleBlocksScheduling(cyclePath: readonly string[], shipped: ShippedMap): boolean {
  const ids = new Set(cyclePath.slice(0, -1));
  for (const id of ids) {
    if (!shipped.has(id)) return true;
  }
  return false;
}

// --- next ready (B-6) ----------------------------------------------------

// Lowest-numbered ready spec with implementation: pending, mirroring the
// AGENTS.md backlog protocol; or, if nothing is ready, null with the
// blocking reasons for every pending spec (honest blockers for the UI).
// Cycle detection runs first (B-5): a cycle among specs that are not all
// shipped refuses scheduling entirely, naming the path.
export function nextReady(snapshot: RegistrySnapshot, shipped: ShippedMap, pinOf: PinLookup): NextReadyResult {
  const cycle = findCycle(snapshot);
  if (cycle && cycleBlocksScheduling(cycle, shipped)) {
    throw new Error(`dag: dependency cycle refuses scheduling: ${cycle.join(" -> ")}`);
  }

  const invalid = invalidatedSet(snapshot, shipped, pinOf);
  const pendingIds = [...snapshot.entries()]
    .filter(([, entry]) => entry.implementation === "pending")
    .map(([id]) => id)
    .sort(compareSpecIds);

  const blockers: SpecBlocker[] = [];
  for (const id of pendingIds) {
    const entry = snapshot.get(id)!;
    const unmetDeps = entry.dependsOn.filter((dep) => !isValidlyShipped(dep, shipped, invalid));
    if (unmetDeps.length === 0) return id;

    const reasons = unmetDeps.map((dep) => {
      if (!snapshot.has(dep)) return `dependency ${dep} is not in the registry`;
      if (invalid.has(dep)) return `dependency ${dep} is invalidated (pin drift)`;
      if (!shipped.has(dep)) return `dependency ${dep} is not shipped`;
      return `dependency ${dep} is not ready`;
    });
    blockers.push({ specId: id, reasons });
  }
  return { ready: null, blockers };
}

// --- adopted shipped-set (D-1) --------------------------------------------

// D-1: bootstrap-era specs (implementation complete or n-a) predate the
// orchestrator and were never journaled as shipped through the pipeline.
// This computes their shipped entries, pinned at first observation, so the
// daemon can journal the adoption once; it does not itself write anything.
export function adoptedShipped(snapshot: RegistrySnapshot, pinOf: PinLookup): ShippedMap {
  const out = new Map<string, ShippedEntry>();
  for (const [id, entry] of snapshot) {
    if (entry.implementation === "complete" || entry.implementation === "n-a") {
      out.set(id, { pin: pinOf(id), source: "adopted" });
    }
  }
  return out;
}
