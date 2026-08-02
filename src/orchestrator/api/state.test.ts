import { test, expect } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { createSpecExec, foldOrchestratorState, transition } from "../state";
import { journalResume, QUOTA_HEALTH_WARNING_THRESHOLD } from "../quota";
import { loadRegistrySnapshot } from "../dag";
import { pinOfBytes } from "../dag";
import { dagView, decisionsView, historyView, quotaView, runView, shippedMapFromJournal } from "./state";
import { freshWorld, seedAdoption, seedPark, seedRun, FIXTURE_SPECS } from "./fixtures";

function snapshotOf(world: ReturnType<typeof freshWorld>) {
  return loadRegistrySnapshot(world.dagReader, world.repoDir);
}

// --- shipped-set ------------------------------------------------------------

test("shippedMapFromJournal merges the adoption record with pipeline-shipped specs", () => {
  const world = freshWorld("shipped");
  try {
    seedRun(world);
    const shipped = shippedMapFromJournal(world.journal.fold().records);

    expect(shipped.get("001-alpha")).toEqual({ pin: world.dagReader.pin("001-alpha"), source: "adopted" });
    expect(shipped.get("002-beta")).toEqual({ pin: world.dagReader.pin("002-beta"), source: "pipeline" });
    // 003-gamma is mid-build, not shipped: absent, not a fabricated entry.
    expect(shipped.has("003-gamma")).toBe(false);
  } finally {
    world.close();
  }
});

// A re-adopted spec (spec 021 D-11) is journaled as a dag.adopted.refreshed
// record, not by rewriting the immutable dag.adopted record. Replaying those
// is what keeps this fold equal to the daemon's own computeShippedMap; a fold
// that stopped at dag.adopted would report the superseded pin and cascade an
// invalidation the daemon does not believe in.
test("shippedMapFromJournal replays dag.adopted.refreshed over the adoption record", () => {
  const world = freshWorld("readopted");
  try {
    seedAdoption(world, ["001-alpha"]);
    const originalPin = world.dagReader.pin("001-alpha");

    world.dagReader.amend("001-alpha", "# 001-alpha\n\namended after adoption\n");
    const newPin = world.dagReader.pin("001-alpha");
    world.journal.append("dag.adopted.refreshed", { id: "001-alpha", oldPin: originalPin, newPin });

    const shipped = shippedMapFromJournal(world.journal.fold().records);
    expect(shipped.get("001-alpha")).toEqual({ pin: newPin, source: "adopted" });
  } finally {
    world.close();
  }
});

// 021 D-16 parity: a pipeline-shipped spec's pin is the file at its
// journaled merge sha, not the pre-flip content the exec was created at.
// Without this the view renders a pin drift the scheduler has already
// resolved.
test("shippedMapFromJournal resolves pipeline pins from the journaled merge sha (021 D-16)", () => {
  const world = freshWorld("d16");
  try {
    seedRun(world);
    // The merged content differs from what the exec was pinned at (the
    // build session's own frontmatter flip is part of the ship).
    const mergedBytes = Buffer.from("# 002-beta\n\nas merged\n");
    const reads: string[] = [];
    const readSpecFileAtSha = (sha: string, specId: string): Buffer | null => {
      reads.push(`${specId}@${sha}`);
      return sha === "0".repeat(40) && specId === "002-beta" ? mergedBytes : null;
    };

    const shipped = shippedMapFromJournal(world.journal.fold().records, readSpecFileAtSha);
    expect(shipped.get("002-beta")).toEqual({ pin: pinOfBytes(mergedBytes), source: "pipeline" });
    expect(reads).toEqual([`002-beta@${"0".repeat(40)}`]);
  } finally {
    world.close();
  }
});

test("shippedMapFromJournal falls back to the exec pin when the merge-sha read fails (021 D-16)", () => {
  const world = freshWorld("d16-fallback");
  try {
    seedRun(world);
    const shipped = shippedMapFromJournal(world.journal.fold().records, () => null);
    // Fallback can only over-invalidate, never under-invalidate.
    expect(shipped.get("002-beta")).toEqual({ pin: world.dagReader.pin("002-beta"), source: "pipeline" });
  } finally {
    world.close();
  }
});

// 021 D-18 parity: a successful requalification re-pins the shipped entry;
// records replay in order, latest wins, and only pipeline entries are
// eligible (an adopted spec heals through dag.adopted.refreshed instead).
test("shippedMapFromJournal replays spec.requalified re-pins, latest wins (021 D-18)", () => {
  const world = freshWorld("d18");
  try {
    seedRun(world);
    world.journal.append("spec.requalified", { specId: "002-beta", pin: "requalified-pin-1" });
    world.journal.append("spec.requalified", { specId: "002-beta", pin: "requalified-pin-2" });
    world.journal.append("spec.requalified", { specId: "001-alpha", pin: "must-not-apply" });

    const shipped = shippedMapFromJournal(world.journal.fold().records);
    expect(shipped.get("002-beta")).toEqual({ pin: "requalified-pin-2", source: "pipeline" });
    expect(shipped.get("001-alpha")!.pin).not.toBe("must-not-apply");
  } finally {
    world.close();
  }
});

// --- /api/dag ---------------------------------------------------------------

test("a re-adopted spec is not reported as drifted, and its dependents stay ready", () => {
  const world = freshWorld("readopted-dag");
  try {
    seedAdoption(world, ["001-alpha"]);
    const originalPin = world.dagReader.pin("001-alpha");

    world.dagReader.amend("001-alpha", "# 001-alpha\n\namended after adoption\n");
    const newPin = world.dagReader.pin("001-alpha");
    world.journal.append("dag.adopted.refreshed", { id: "001-alpha", oldPin: originalPin, newPin });

    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });

    const alpha = view.specs.find((s) => s.id === "001-alpha")!;
    expect(alpha.shippedPin).toBe(newPin);
    expect(alpha.drifted).toBe(false);
    expect(alpha.invalidated).toBe(false);
    expect(view.invalidated).toEqual([]);
    // The whole backlog would otherwise stall behind a pin drift the daemon
    // has already resolved.
    expect(view.nextReady).toBe("002-beta");
  } finally {
    world.close();
  }
});

// The live bug this guards against: after 026 amended 023 post-ship and
// requalification healed the cascade, the CLI/API dag still rendered
// "invalidated (pin drift)" blockers the scheduler contradicted, because
// this fold pinned the shipped spec at its pre-flip exec pin.
test("dagView agrees with the scheduler once the merge-sha read resolves a post-ship flip", () => {
  const world = freshWorld("d16-dag");
  try {
    seedRun(world);
    // The checkout's current content is what 002-beta's own merge landed;
    // it differs from the exec creation pin.
    const merged = "# 002-beta\n\nas merged\n";
    world.dagReader.amend("002-beta", merged);

    const stale = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });
    // Without the D-16 read the view invents a drift.
    expect(stale.specs.find((s) => s.id === "002-beta")!.drifted).toBe(true);

    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
      readSpecFileAtSha: (sha, specId) =>
        sha === "0".repeat(40) && specId === "002-beta" ? Buffer.from(merged) : null,
    });
    const beta = view.specs.find((s) => s.id === "002-beta")!;
    expect(beta.drifted).toBe(false);
    expect(beta.invalidated).toBe(false);
    expect(view.invalidated).toEqual([]);
  } finally {
    world.close();
  }
});

test("dagView reports readiness, blockers, pins, and the next ready spec", () => {
  const world = freshWorld("dag");
  try {
    seedAdoption(world, ["001-alpha"]);
    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });

    const byId = new Map(view.specs.map((s) => [s.id, s]));
    expect(byId.get("001-alpha")!.shipped).toBe(true);
    expect(byId.get("001-alpha")!.shippedSource).toBe("adopted");
    expect(byId.get("001-alpha")!.currentPin).toBe(world.dagReader.pin("001-alpha"));
    expect(byId.get("001-alpha")!.drifted).toBe(false);

    expect(byId.get("002-beta")!.ready).toBe(true);
    expect(byId.get("002-beta")!.blockers).toEqual([]);
    expect(byId.get("002-beta")!.shipped).toBe(false);
    expect(byId.get("002-beta")!.shippedPin).toBeNull();

    expect(byId.get("003-gamma")!.ready).toBe(false);
    expect(byId.get("003-gamma")!.blockers).toEqual(["dependency 002-beta is not shipped"]);

    expect(view.nextReady).toBe("002-beta");
    expect(view.cycle).toBeNull();
    expect(view.invalidated).toEqual([]);
  } finally {
    world.close();
  }
});

test("dagView cascades invalidation from an amended upstream spec", () => {
  const world = freshWorld("drift");
  try {
    seedRun(world);
    // 002-beta shipped at its old pin; amending its spec.md is the drift
    // spec 012 B-4 cascades from.
    world.dagReader.amend("002-beta", "# 002-beta\n\namended after shipping\n");

    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });

    const beta = view.specs.find((s) => s.id === "002-beta")!;
    expect(beta.drifted).toBe(true);
    expect(beta.invalidated).toBe(true);
    expect(view.invalidated).toContain("002-beta");

    const gamma = view.specs.find((s) => s.id === "003-gamma")!;
    expect(gamma.blockers).toEqual(["dependency 002-beta is invalidated (pin drift)"]);
    expect(gamma.ready).toBe(false);
  } finally {
    world.close();
  }
});

test("dagView reports an unreadable spec file as a pin error, never as drift", () => {
  const world = freshWorld("pin-error", {
    ...FIXTURE_SPECS,
    "004-delta": { implementation: "pending", dependsOn: [] },
  });
  try {
    seedAdoption(world, ["001-alpha"]);
    // A reader that fails for exactly one spec, as a missing spec.md would.
    const reader = {
      ...world.dagReader,
      readSpecFile: (repoDir: string, specId: string): Buffer => {
        if (specId === "004-delta") throw new Error("dag: cannot read spec file for 004-delta");
        return world.dagReader.readSpecFile(repoDir, specId);
      },
    };

    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader,
      repoDir: world.repoDir,
    });

    const delta = view.specs.find((s) => s.id === "004-delta")!;
    expect(delta.currentPin).toBeNull();
    expect(delta.pinError).toContain("cannot read spec file");
    expect(delta.drifted).toBe(false);
    expect(view.invalidated).toEqual([]);
  } finally {
    world.close();
  }
});

test("dagView masks specs the journal shows shipped or skipped from the next-ready answer", () => {
  const world = freshWorld("working-snapshot");
  try {
    seedRun(world);
    // The fixture registry still calls 002-beta pending (the frontmatter
    // flip only reaches the registry once its PR is merged and re-read),
    // but this journal shows it shipped, so it is not offered again.
    const shippedView = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });
    expect(shippedView.specs.find((s) => s.id === "002-beta")!.implementation).toBe("pending");
    expect(shippedView.nextReady).toBe("003-gamma");

    world.journal.append("control.skipSpec", { specId: "003-gamma", source: "api" });
    const skippedView = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });
    expect(skippedView.specs.find((s) => s.id === "003-gamma")!.skipped).toBe(true);
    expect(skippedView.nextReady).toBeNull();
    expect(skippedView.blockers).toEqual([]);
  } finally {
    world.close();
  }
});

test("dagView surfaces a dependency cycle instead of an unexplained empty schedule", () => {
  const world = freshWorld("cycle", {
    "010-one": { implementation: "pending", dependsOn: ["011-two"] },
    "011-two": { implementation: "pending", dependsOn: ["010-one"] },
  });
  try {
    const view = dagView({
      project: "alpha",
      records: world.journal.fold().records,
      snapshot: snapshotOf(world),
      reader: world.dagReader,
      repoDir: world.repoDir,
    });
    expect(view.cycle).not.toBeNull();
    expect(view.cycle!.length).toBeGreaterThan(2);
    expect(view.nextReady).toBeNull();
  } finally {
    world.close();
  }
});

// --- /api/run ---------------------------------------------------------------

test("runView reports the current run, spec, stage, and attempt", () => {
  const world = freshWorld("run");
  try {
    const seeded = seedRun(world);
    const view = runView(world.journal.fold().records, "alpha");

    expect(view.run?.id).toBe(seeded.runId);
    expect(view.run?.status).toBe("running");
    // 002-beta shipped, so the live spec is 003-gamma.
    expect(view.spec?.specId).toBe("003-gamma");
    expect(view.spec?.status).toBe("building");
    expect(view.spec?.attempt).toBe(1);
    expect(view.stage?.stage).toBe("build");
    expect(view.stage?.status).toBe("running");
    expect(view.pauseReason).toBeNull();
    expect(view.lastHeartbeatMs).toBe(1_700_000_000_000);
    expect(view.awaitingApproval).toEqual([]);
  } finally {
    world.close();
  }
});

test("runView serializes an empty journal as explicit unknowns", () => {
  const world = freshWorld("empty");
  try {
    const view = runView(world.journal.fold().records, "alpha");
    expect(view.run).toBeNull();
    expect(view.spec).toBeNull();
    expect(view.stage).toBeNull();
    expect(view.lastHeartbeatMs).toBeNull();
    expect(view.blockers).toEqual([]);
  } finally {
    world.close();
  }
});

test("runView surfaces the pause reason only while the run is paused", () => {
  const world = freshWorld("pause-reason");
  try {
    seedRun(world);
    const state = foldOrchestratorState(world.journal.fold().records);
    const run = [...state.runs.values()][0]!;
    world.journal.append("run.pause-reason", { runId: run.id, reason: "003-gamma: build failed after 2 attempt(s)" });
    const paused = transition(world.journal, run, "paused");

    expect(runView(world.journal.fold().records, "alpha").pauseReason).toBe("003-gamma: build failed after 2 attempt(s)");

    transition(world.journal, paused, "running");
    expect(runView(world.journal.fold().records, "alpha").pauseReason).toBeNull();
  } finally {
    world.close();
  }
});

test("runView folds gate waits and approvals into the awaiting-approval set", () => {
  const world = freshWorld("gate");
  try {
    seedRun(world);
    world.journal.append("daemon.gate.waiting", { specId: "003-gamma", stage: "ship" });
    expect(runView(world.journal.fold().records, "alpha").awaitingApproval).toEqual(["003-gamma"]);

    world.journal.append("control.approve", { specId: "003-gamma", source: "api" });
    expect(runView(world.journal.fold().records, "alpha").awaitingApproval).toEqual([]);
  } finally {
    world.close();
  }
});

// --- /api/quota -------------------------------------------------------------

test("quotaView reports the park target, the estimated flag, and the countdown", () => {
  const world = freshWorld("quota");
  try {
    const now = 1_700_000_000_000;
    seedPark(world, now + 60_000, QUOTA_HEALTH_WARNING_THRESHOLD, true);

    const view = quotaView([{ project: "alpha", records: world.journal.fold().records }], now);
    expect(view.parked).toBe(true);
    expect(view.targetMs).toBe(now + 60_000);
    expect(view.estimated).toBe(true);
    expect(view.msUntilTarget).toBe(60_000);
    expect(view.consecutiveQuotaParks).toBe(QUOTA_HEALTH_WARNING_THRESHOLD);
    expect(view.warn).toBe(true);

    journalResume(world.journal, now + 61_000);
    const resumed = quotaView([{ project: "alpha", records: world.journal.fold().records }], now + 61_000);
    expect(resumed.parked).toBe(false);
    // The last park's own data survives the resume: it is history, not a lie.
    expect(resumed.targetMs).toBe(now + 60_000);
  } finally {
    world.close();
  }
});

test("quotaView reports never-parked as explicit unknowns, not zeroes", () => {
  const world = freshWorld("quota-empty");
  try {
    const view = quotaView([{ project: "alpha", records: world.journal.fold().records }], 1_700_000_000_000);
    expect(view.parked).toBe(false);
    expect(view.targetMs).toBeNull();
    expect(view.estimated).toBeNull();
    expect(view.msUntilTarget).toBeNull();
    expect(view.consecutiveQuotaParks).toBe(0);
    expect(view.warn).toBe(false);
  } finally {
    world.close();
  }
});

// --- /api/decisions ---------------------------------------------------------

test("decisionsView filters the sealed ledger by spec, path, and full text", () => {
  const world = freshWorld("decisions");
  try {
    world.decisions.append("decision.sealed", {
      id: "d-1",
      specId: "002-beta",
      scope: ["002-beta", "src/orchestrator/api/"],
      title: "Envelope shape",
      decision: "One envelope for every JSON route",
      rationale: "Clients branch on a stable token, never a status code alone",
    });
    world.decisions.append("decision.sealed", {
      id: "d-2",
      specId: "003-gamma",
      scope: ["003-gamma"],
      title: "Polling cadence",
      decision: "Poll the journal every 250 ms",
      rationale: "Cheap enough to be honest without a listener seam",
    });

    const records = world.decisions.fold().records;
    expect(decisionsView(records, {}, "alpha").total).toBe(2);
    // Newest first, consistent with spec 020's own ordering.
    expect(decisionsView(records, {}, "alpha").decisions[0]!.id).toBe("d-2");
    expect(decisionsView(records, { specId: "002-beta" }, "alpha").decisions.map((d) => d.id)).toEqual(["d-1"]);
    expect(decisionsView(records, { path: "src/orchestrator/api/" }, "alpha").decisions.map((d) => d.id)).toEqual(["d-1"]);
    expect(decisionsView(records, { query: "cadence" }, "alpha").decisions.map((d) => d.id)).toEqual(["d-2"]);
    expect(decisionsView(records, { query: "nothing matches this" }, "alpha").total).toBe(0);
  } finally {
    world.close();
  }
});

// --- /api/history -----------------------------------------------------------

test("historyView attributes PR, CI, verify verdict, and evidence to each spec execution", () => {
  const world = freshWorld("history");
  try {
    const seeded = seedRun(world);
    const view = historyView(world.journal.fold().records, "alpha");

    expect(view.entries.map((e) => e.specId)).toEqual(["002-beta", "003-gamma"]);

    const beta = view.entries.find((e) => e.specId === "002-beta")!;
    expect(beta.specExecId).toBe(seeded.betaSpecExecId);
    expect(beta.status).toBe("shipped");
    expect(beta.prNumber).toBe(7);
    expect(beta.mergeSha).toBe(seeded.mergeSha);
    expect(beta.ciConclusion).toBe("passed");
    expect(beta.verifyVerdict).toBe("passed");
    expect(beta.evidenceRefs).toEqual([seeded.evidenceHash]);
    expect(beta.stages.map((s) => s.stage)).toEqual(["build", "ship", "shepherd", "verify"]);
    expect(beta.stages.every((s) => s.status === "passed")).toBe(true);

    const gamma = view.entries.find((e) => e.specId === "003-gamma")!;
    expect(gamma.status).toBe("building");
    expect(gamma.prNumber).toBeNull();
    expect(gamma.verifyVerdict).toBeNull();
    expect(gamma.evidenceRefs).toEqual([]);
  } finally {
    world.close();
  }
});

test("historyView credits a retry's stage records to the retry, not the failed attempt", () => {
  const world = freshWorld("history-retry");
  try {
    seedRun(world);
    const state = foldOrchestratorState(world.journal.fold().records);
    const gamma = [...state.specExecs.values()].find((se) => se.specId === "003-gamma")!;

    // The first attempt fails; the daemon mints a fresh SpecExec for the
    // retry (spec 013 B-3), and the retry's own ship record must land there.
    transition(world.journal, gamma, "failed");
    const retry = createSpecExec(world.journal, gamma.runId, "003-gamma", gamma.pin);
    transition(world.journal, retry, "building");
    world.journal.append("stage.ship.result", { specId: "003-gamma", branch: "003-gamma", outcome: "passed", prNumber: 9, sessionIds: [] });

    const view = historyView(world.journal.fold().records, "alpha");
    const attempts = view.entries.filter((e) => e.specId === "003-gamma");
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.prNumber).toBeNull();
    expect(attempts[1]!.specExecId).toBe(retry.id);
    expect(attempts[1]!.prNumber).toBe(9);
  } finally {
    world.close();
  }
});

// --- evidence files ---------------------------------------------------------

test("seeded verify evidence is content-addressed on disk under its own hash", () => {
  const world = freshWorld("evidence");
  try {
    const seeded = seedRun(world);
    const path = join(world.evidenceDir, `${seeded.evidenceHash}.txt`);
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toContain("bun test");
  } finally {
    world.close();
  }
});
