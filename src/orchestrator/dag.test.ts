import { test, expect, spyOn } from "bun:test";
import {
  ready,
  invalidatedSet,
  findCycle,
  nextReady,
  adoptedShipped,
  loadRegistrySnapshot,
  showRegistrySpec,
  createProcessDagReader,
  normalizeForHash,
  pinOfBytes,
  makePinLookup,
  type DagReader,
  type RegistrySpecEntry,
  type RegistrySnapshot,
  type ShippedEntry,
  type ShippedMap,
  type PinLookup,
} from "./dag";
import { sha256Hex } from "./journal";

// --- fixtures ---------------------------------------------------------

function snapshotFrom(entries: readonly RegistrySpecEntry[]): RegistrySnapshot {
  return new Map(entries.map((e) => [e.id, e]));
}

function spec(
  id: string,
  dependsOn: readonly string[] = [],
  implementation = "pending",
  status: string | undefined = "approved"
): RegistrySpecEntry {
  return { id, implementation, status, dependsOn };
}

function shippedFrom(entries: Record<string, ShippedEntry>): ShippedMap {
  return new Map(Object.entries(entries));
}

// A fixture reader (FR-002): never shells out, never touches this repo. Spec
// content is synthesized deterministically from the id so pinOf() results
// are stable and drift is simulated just by changing what this map returns.
function fixtureReader(specFiles: Record<string, string>): DagReader {
  return {
    registryListJson(): string {
      throw new Error("fixtureReader.registryListJson: not wired for this test");
    },
    registryShowJson(): string {
      throw new Error("fixtureReader.registryShowJson: not wired for this test");
    },
    readSpecFile(_repoDir: string, specId: string): Buffer {
      const content = specFiles[specId];
      if (content === undefined) throw new Error(`fixtureReader: no content registered for ${specId}`);
      return Buffer.from(content, "utf8");
    },
  };
}

// --- B-2: contract pinning ---------------------------------------------

test("normalizeForHash strips a leading BOM and folds CRLF/CR to LF", () => {
  expect(normalizeForHash("﻿a\r\nb\rc")).toBe("a\nb\nc");
});

test("pinOfBytes is identical across CRLF and LF line endings (matches spec-spine's own hash normalization)", () => {
  const unix = pinOfBytes(Buffer.from("line1\nline2\n", "utf8"));
  const win = pinOfBytes(Buffer.from("line1\r\nline2\r\n", "utf8"));
  expect(unix).toBe(win);
  expect(unix).toBe(sha256Hex("line1\nline2\n"));
});

test("pinOf reads through the injected reader and hashes normalized content", () => {
  const reader = fixtureReader({ "012-x": "# 012\r\ncontent\r\n" });
  const lookup = makePinLookup(reader, "/fake/repo");
  expect(lookup("012-x")).toBe(sha256Hex("# 012\ncontent\n"));
});

// --- B-3: readiness with and without pins -------------------------------

test("ready: a spec with no dependencies is always ready", () => {
  const snapshot = snapshotFrom([spec("020-a", [])]);
  const pin: PinLookup = () => "irrelevant";
  expect(ready(snapshot, shippedFrom({}), pin, "020-a")).toBe(true);
});

test("ready: true when the dependency is shipped and its pin matches", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"])]);
  const shipped = shippedFrom({ "010-a": { pin: "pin-a", source: "adopted" } });
  const pin: PinLookup = (id) => (id === "010-a" ? "pin-a" : "pin-b");
  expect(ready(snapshot, shipped, pin, "011-b")).toBe(true);
});

test("ready: false when the dependency is not in the shipped-set", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"])]);
  const pin: PinLookup = () => "pin-a";
  expect(ready(snapshot, shippedFrom({}), pin, "011-b")).toBe(false);
});

test("ready: false when the dependency's pin has drifted since it shipped", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"])]);
  const shipped = shippedFrom({ "010-a": { pin: "pin-a-old", source: "pipeline" } });
  const pin: PinLookup = (id) => (id === "010-a" ? "pin-a-new" : "pin-b");
  expect(ready(snapshot, shipped, pin, "011-b")).toBe(false);
});

test("ready: unknown spec id throws (never silently false)", () => {
  const snapshot = snapshotFrom([spec("010-a", [])]);
  const pin: PinLookup = () => "x";
  expect(() => ready(snapshot, shippedFrom({}), pin, "999-nope")).toThrow(/unknown spec id/);
});

// --- B-4: invalidation cascade, depth >= 2 ------------------------------

test("invalidatedSet: a drift at the root cascades through two hops of dependents", () => {
  // A <- B <- C (B depends on A, C depends on B)
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"]), spec("012-c", ["011-b"])]);
  const shipped = shippedFrom({
    "010-a": { pin: "pin-a-old", source: "adopted" },
    "011-b": { pin: "pin-b", source: "pipeline" },
    "012-c": { pin: "pin-c", source: "pipeline" },
  });
  // A's content changed after it shipped; B and C's own files did not.
  const pin: PinLookup = (id) => (id === "010-a" ? "pin-a-new" : shipped.get(id)!.pin);

  const invalid = invalidatedSet(snapshot, shipped, pin);
  expect([...invalid].sort()).toEqual(["010-a", "011-b", "012-c"]);

  // The cascade feeds back into readiness: C is no longer validly shipped,
  // so anything depending on C is not ready either.
  const withDownstream = snapshotFrom([...snapshot.values(), spec("013-d", ["012-c"])]);
  expect(ready(withDownstream, shipped, pin, "013-d")).toBe(false);
});

test("invalidatedSet: no drift means an empty set and untouched readiness", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"])]);
  const shipped = shippedFrom({
    "010-a": { pin: "pin-a", source: "adopted" },
    "011-b": { pin: "pin-b", source: "pipeline" },
  });
  const pin: PinLookup = (id) => shipped.get(id)!.pin;
  expect(invalidatedSet(snapshot, shipped, pin).size).toBe(0);
});

test("invalidatedSet: a drift only invalidates specs that were actually shipped", () => {
  // A drifted, B depends on A but was never shipped: B stays out of the set,
  // it was never "shipped" to begin with (it just stays not-ready).
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"])]);
  const shipped = shippedFrom({ "010-a": { pin: "pin-a-old", source: "adopted" } });
  const pin: PinLookup = (id) => (id === "010-a" ? "pin-a-new" : "pin-b");
  expect([...invalidatedSet(snapshot, shipped, pin)]).toEqual(["010-a"]);
});

// --- B-5: cycle detection and refusal -----------------------------------

test("findCycle: returns null for an acyclic graph", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("011-b", ["010-a"]), spec("012-c", ["011-b"])]);
  expect(findCycle(snapshot)).toBeNull();
});

test("findCycle: names the path when two pending specs depend on each other", () => {
  const snapshot = snapshotFrom([spec("016-x", ["017-y"]), spec("017-y", ["016-x"])]);
  const cycle = findCycle(snapshot);
  expect(cycle).not.toBeNull();
  expect(cycle!.at(0)).toBe(cycle!.at(-1));
  expect(new Set(cycle)).toEqual(new Set(["016-x", "017-y"]));
});

test("nextReady: refuses scheduling and names the cycle path when not all cycle members are shipped", () => {
  const snapshot = snapshotFrom([spec("016-x", ["017-y"]), spec("017-y", ["016-x"])]);
  const pin: PinLookup = () => "x";
  expect(() => nextReady(snapshot, shippedFrom({}), pin)).toThrow(/dependency cycle refuses scheduling/);
  try {
    nextReady(snapshot, shippedFrom({}), pin);
    throw new Error("expected nextReady to throw");
  } catch (err) {
    expect((err as Error).message).toContain("016-x");
    expect((err as Error).message).toContain("017-y");
    expect((err as Error).message).toContain("->");
  }
});

test("nextReady: a cycle entirely among already-shipped specs does not block scheduling", () => {
  // Two adopted specs that happen to reference each other (a bootstrap-era
  // artifact): both already shipped with matching pins, so the cycle cannot
  // block anything (B-5: "not all shipped" is the trigger).
  const snapshot = snapshotFrom([
    spec("003-x", ["004-y"], "complete"),
    spec("004-y", ["003-x"], "complete"),
    spec("005-z", ["003-x"], "pending"),
  ]);
  const shipped = shippedFrom({
    "003-x": { pin: "pin-x", source: "adopted" },
    "004-y": { pin: "pin-y", source: "adopted" },
  });
  const pin: PinLookup = (id) => shipped.get(id)?.pin ?? "n/a";
  expect(findCycle(snapshot)).not.toBeNull();
  expect(nextReady(snapshot, shipped, pin)).toBe("005-z");
});

// --- B-6: nextReady tie-break and blocker reporting ---------------------

test("nextReady: tie-break by lowest spec number among several ready pending specs", () => {
  const snapshot = snapshotFrom([spec("010-a", []), spec("015-b", []), spec("012-c", [])]);
  const pin: PinLookup = () => "x";
  expect(nextReady(snapshot, shippedFrom({}), pin)).toBe("010-a");
});

test("nextReady: returns null with a blocker per pending spec when nothing is ready", () => {
  const snapshot = snapshotFrom([
    spec("010-a", [], "complete"),
    spec("011-b", ["999-missing"]),
    spec("012-c", ["010-a"]),
  ]);
  // 010-a is complete but never recorded as shipped in this shipped-set, so
  // 012-c is blocked on it; 011-b depends on a spec absent from the registry.
  const pin: PinLookup = () => "x";
  const result = nextReady(snapshot, shippedFrom({}), pin);
  expect(typeof result).toBe("object");
  if (typeof result === "string") throw new Error("expected blockers, got a ready id");
  expect(result.ready).toBeNull();
  expect(result.blockers.map((b) => b.specId)).toEqual(["011-b", "012-c"]);
  expect(result.blockers[0]!.reasons).toEqual(["dependency 999-missing is not in the registry"]);
  expect(result.blockers[1]!.reasons).toEqual(["dependency 010-a is not shipped"]);
});

test("nextReady: blocker reason distinguishes an invalidated dependency from a never-shipped one", () => {
  const snapshot = snapshotFrom([
    spec("010-a", [], "complete"),
    spec("011-b", ["010-a"], "complete"),
    spec("012-c", ["011-b"]),
  ]);
  const shipped = shippedFrom({
    "010-a": { pin: "pin-a-old", source: "adopted" },
    "011-b": { pin: "pin-b", source: "pipeline" },
  });
  const pin: PinLookup = (id) => (id === "010-a" ? "pin-a-new" : shipped.get(id)?.pin ?? "n/a");
  const result = nextReady(snapshot, shipped, pin);
  if (typeof result === "string") throw new Error("expected blockers, got a ready id");
  const blocker = result.blockers.find((b) => b.specId === "012-c");
  expect(blocker?.reasons).toEqual(["dependency 011-b is invalidated (pin drift)"]);
});

// --- D-1: adoptedShipped --------------------------------------------------

test("adoptedShipped: pins complete and n-a specs, ignores pending, tags the source as adopted", () => {
  const snapshot = snapshotFrom([
    spec("010-a", [], "n-a"),
    spec("011-b", ["010-a"], "complete"),
    spec("012-c", ["011-b"], "pending"),
    spec("000-bootstrap", [], undefined),
  ]);
  const pin: PinLookup = (id) => `pin-${id}`;
  const adopted = adoptedShipped(snapshot, pin);
  expect([...adopted.keys()].sort()).toEqual(["010-a", "011-b"]);
  expect(adopted.get("010-a")).toEqual({ pin: "pin-010-a", source: "adopted" });
  expect(adopted.get("011-b")).toEqual({ pin: "pin-011-b", source: "adopted" });
});

// --- FR-001: typed subprocess errors, never an empty DAG ------------------

test("loadRegistrySnapshot: unparseable JSON is a typed error, not an empty snapshot", () => {
  const reader: DagReader = {
    registryListJson: () => "not json at all {{{",
    registryShowJson: () => "",
    readSpecFile: () => Buffer.from(""),
  };
  expect(() => loadRegistrySnapshot(reader, "/fake/repo")).toThrow(/unparseable output/);
});

test("loadRegistrySnapshot: a JSON value that isn't an array is a typed error", () => {
  const reader: DagReader = {
    registryListJson: () => JSON.stringify({ not: "an array" }),
    registryShowJson: () => "",
    readSpecFile: () => Buffer.from(""),
  };
  expect(() => loadRegistrySnapshot(reader, "/fake/repo")).toThrow(/expected a JSON array/);
});

test("loadRegistrySnapshot: an entry missing a string id is a typed error", () => {
  const reader: DagReader = {
    registryListJson: () => JSON.stringify([{ title: "no id here" }]),
    registryShowJson: () => "",
    readSpecFile: () => Buffer.from(""),
  };
  expect(() => loadRegistrySnapshot(reader, "/fake/repo")).toThrow(/missing string id/);
});

test("loadRegistrySnapshot: parses implementation and dependsOn from a realistic list --json shape", () => {
  const reader: DagReader = {
    registryListJson: () =>
      JSON.stringify([
        { id: "010-a", title: "A", status: "approved", implementation: "n-a" },
        { id: "011-b", title: "B", status: "approved", implementation: "complete", dependsOn: ["010-a"] },
      ]),
    registryShowJson: () => "",
    readSpecFile: () => Buffer.from(""),
  };
  const snapshot = loadRegistrySnapshot(reader, "/fake/repo");
  expect(snapshot.get("010-a")).toEqual({ id: "010-a", implementation: "n-a", status: "approved", dependsOn: [] });
  expect(snapshot.get("011-b")).toEqual({
    id: "011-b",
    implementation: "complete",
    status: "approved",
    dependsOn: ["010-a"],
  });
});

test("showRegistrySpec: parses a single spec-spine registry show --json entry", () => {
  const reader: DagReader = {
    registryListJson: () => "",
    registryShowJson: () => JSON.stringify({ id: "011-b", implementation: "complete", dependsOn: ["010-a"] }),
    readSpecFile: () => Buffer.from(""),
  };
  expect(showRegistrySpec(reader, "/fake/repo", "011-b")).toEqual({
    id: "011-b",
    implementation: "complete",
    status: undefined,
    dependsOn: ["010-a"],
  });
});

// --- status guard (D-3) --------------------------------------------------

test("D-3: an unapproved pending spec is never offered by nextReady and blocks with its status named", () => {
  const snapshot = snapshotFrom([
    spec("010-a", [], "complete"),
    spec("011-draft", ["010-a"], "pending", "draft"),
    spec("012-c", ["010-a"], "pending"),
  ]);
  const shipped = shippedFrom({ "010-a": { pin: "pin-a", source: "adopted" } });
  const pinOf: PinLookup = () => "pin-a";

  // 011-draft is lower-numbered and dependency-ready, but its status keeps
  // it out of the schedule; 012-c is offered instead.
  expect(nextReady(snapshot, shipped, pinOf)).toBe("012-c");

  // With nothing else pending, the draft is reported, never offered.
  const alone = snapshotFrom([spec("010-a", [], "complete"), spec("011-draft", ["010-a"], "pending", "draft")]);
  const result = nextReady(alone, shipped, pinOf);
  expect(typeof result).not.toBe("string");
  if (typeof result !== "string") {
    expect(result.blockers).toEqual([{ specId: "011-draft", reasons: ["status draft is not approved"] }]);
  }
});

test("D-3: ready() is false for an unapproved spec regardless of its dependencies", () => {
  const snapshot = snapshotFrom([spec("010-a", [], "complete"), spec("011-draft", ["010-a"], "pending", "draft")]);
  const shipped = shippedFrom({ "010-a": { pin: "pin-a", source: "adopted" } });
  const pinOf: PinLookup = () => "pin-a";
  expect(ready(snapshot, shipped, pinOf, "011-draft")).toBe(false);
});

test("D-3: adoptedShipped never adopts an unapproved spec, whatever its implementation claims", () => {
  const snapshot = snapshotFrom([
    spec("010-a", [], "complete"),
    spec("011-generated", [], "complete", "draft"),
    spec("012-c", [], "n-a", "proposed"),
  ]);
  const adopted = adoptedShipped(snapshot, () => "pin");
  expect([...adopted.keys()]).toEqual(["010-a"]);
});

test("D-3: an absent status (a reader that does not emit it) stays schedulable, the fixture-trust convention", () => {
  const snapshot = snapshotFrom([spec("010-a", [], "pending", undefined)]);
  expect(nextReady(snapshot, shippedFrom({}), () => "pin")).toBe("010-a");
});

test("createProcessDagReader: spec-spine missing on PATH surfaces as a typed error", () => {
  const spy = spyOn(Bun, "spawnSync").mockImplementation(() => {
    const err = new Error('Executable not found in $PATH: "spec-spine"');
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
  try {
    const reader = createProcessDagReader();
    expect(() => reader.registryListJson("/fake/repo")).toThrow(/spec-spine not found on PATH/);
  } finally {
    spy.mockRestore();
  }
});

test("createProcessDagReader: a non-zero spec-spine exit surfaces as a typed error with stderr", () => {
  const spy = spyOn(Bun, "spawnSync").mockImplementation(
    () =>
      ({
        exitCode: 3,
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("spec-spine: io error: no such repo"),
      }) as ReturnType<typeof Bun.spawnSync>
  );
  try {
    const reader = createProcessDagReader();
    expect(() => reader.registryListJson("/fake/repo")).toThrow(/failed \(exit 3\).*io error: no such repo/s);
  } finally {
    spy.mockRestore();
  }
});

// --- AC-2: this repo's own bootstrap order is the fixture -----------------
//
// Hand-built in the shape `spec-spine registry list --json` actually emits
// (id, implementation, dependsOn; see the real output captured for specs
// 010-024), with only 010-orchestrator-thesis adopted (n-a) and every other
// orchestrator spec still pending, mirroring the bootstrap state before any
// spec ships through the pipeline. No subprocess is invoked: the fixture
// reader below stands in for spec-spine entirely.
test("AC-2: nextReady() returns 011-work-journal when nothing has shipped yet, from this repo's own dependency shape", () => {
  const registryListShape = [
    { id: "010-orchestrator-thesis", title: "Orchestrator thesis", status: "approved", implementation: "n-a" },
    {
      id: "011-work-journal",
      title: "Durable hash-linked work journal",
      status: "approved",
      implementation: "pending",
      dependsOn: ["010-orchestrator-thesis"],
    },
    {
      id: "012-spec-dag-readiness",
      title: "Spec DAG readiness",
      status: "approved",
      implementation: "pending",
      dependsOn: ["010-orchestrator-thesis"],
    },
    {
      id: "013-run-state-machine",
      status: "approved",
      implementation: "pending",
      dependsOn: ["011-work-journal"],
    },
    { id: "014-session-driver", status: "approved", implementation: "pending", dependsOn: ["013-run-state-machine"] },
    { id: "015-quota-scheduler", status: "approved", implementation: "pending", dependsOn: ["014-session-driver"] },
    {
      id: "016-stage-build",
      status: "approved",
      implementation: "pending",
      dependsOn: ["012-spec-dag-readiness", "014-session-driver", "020-decision-ledger"],
    },
    { id: "017-stage-ship", status: "approved", implementation: "pending", dependsOn: ["016-stage-build"] },
    { id: "018-stage-shepherd", status: "approved", implementation: "pending", dependsOn: ["017-stage-ship"] },
    { id: "019-stage-verify", status: "approved", implementation: "pending", dependsOn: ["018-stage-shepherd"] },
    { id: "020-decision-ledger", status: "approved", implementation: "pending", dependsOn: ["011-work-journal"] },
    {
      id: "021-orchestrator-daemon",
      status: "approved",
      implementation: "pending",
      dependsOn: [
        "012-spec-dag-readiness",
        "015-quota-scheduler",
        "016-stage-build",
        "017-stage-ship",
        "018-stage-shepherd",
        "019-stage-verify",
        "020-decision-ledger",
      ],
    },
    { id: "022-http-api-and-events", status: "approved", implementation: "pending", dependsOn: ["021-orchestrator-daemon"] },
    { id: "023-orchestrator-cli", status: "approved", implementation: "pending", dependsOn: ["022-http-api-and-events"] },
    { id: "024-web-ui", status: "approved", implementation: "pending", dependsOn: ["022-http-api-and-events"] },
  ];

  const reader: DagReader = {
    registryListJson: () => JSON.stringify(registryListShape),
    registryShowJson: () => {
      throw new Error("AC-2 fixture: registryShowJson should not be called by loadRegistrySnapshot/nextReady");
    },
    readSpecFile: (_repoDir, specId) => Buffer.from(`fixture content for ${specId}\n`, "utf8"),
  };

  const snapshot = loadRegistrySnapshot(reader, "/fake/repo");
  const pin = makePinLookup(reader, "/fake/repo");
  const shipped = adoptedShipped(snapshot, pin);

  expect([...shipped.keys()]).toEqual(["010-orchestrator-thesis"]);
  expect(findCycle(snapshot)).toBeNull();
  expect(nextReady(snapshot, shipped, pin)).toBe("011-work-journal");
});
