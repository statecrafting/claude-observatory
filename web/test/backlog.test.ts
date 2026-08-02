// What a project's backlog is, and why it is or is not being driven
// (spec 029 B-2).
//
// The state this file exists for is "complete". A finished backlog and a dead
// daemon used to look the same (010 A-1), so "no spec is pending" has to be a
// value the view can render as a sentence, not the absence of one.
//
// The counting rule is the second load-bearing thing: pending is spelled the
// way spec 012's scheduler spells it, over the same fold, so this page cannot
// claim there is work when the daemon knows there is none.
import { expect, test } from "bun:test";
import { explainScheduling, summarizeBacklog } from "../src/backlog";
import type { DagView } from "../src/api";
import { fixtureDagFor, fixtureProjectView, metaWithDaemon, FIXTURE_UNQUALIFIED } from "./fixtures";

const ALPHA = fixtureProjectView("alpha");
const STANDBY = metaWithDaemon("standby", null);

test("a fold with nothing pending is complete, and says so", () => {
  const summary = summarizeBacklog(fixtureDagFor("alpha", "complete"));

  expect(summary.state).toBe("complete");
  expect(summary.pending).toEqual([]);
  expect(summary.headline).toBe("backlog complete: no spec is pending");
});

test("a fold with a ready pick names it", () => {
  const summary = summarizeBacklog(fixtureDagFor("alpha", "ready"));

  expect(summary.state).toBe("ready");
  expect(summary.pending).toEqual(["002-beta"]);
  expect(summary.nextReady).toBe("002-beta");
  expect(summary.headline).toBe("1 spec pending, 002-beta ready");
});

test("pending work with no pick is blocked, carrying the scheduler's own reasons", () => {
  const summary = summarizeBacklog(fixtureDagFor("alpha", "blocked"));

  expect(summary.state).toBe("blocked");
  expect(summary.blockers[0]?.reasons[0]).toContain("invalidated (pin drift)");
  expect(summary.invalidated).toEqual(["001-alpha"]);
});

test("a spec the registry still calls pending but the journal has shipped is not counted", () => {
  const dag = fixtureDagFor("alpha", "ready");
  const shipped: DagView = {
    ...dag,
    // The working snapshot the scheduler reads rewrites a shipped spec out of
    // the pending set (spec 012); counting it here would put this view a whole
    // spec ahead of the daemon.
    specs: dag.specs.map((spec) => (spec.id === "002-beta" ? { ...spec, shipped: true } : spec)),
    nextReady: null,
  };

  expect(summarizeBacklog(shipped).state).toBe("complete");
});

test("a spec skipped by an operator control is not counted as pending either", () => {
  const dag = fixtureDagFor("alpha", "ready");
  const skipped: DagView = {
    ...dag,
    specs: dag.specs.map((spec) => (spec.id === "002-beta" ? { ...spec, skipped: true } : spec)),
    nextReady: null,
  };

  expect(summarizeBacklog(skipped).state).toBe("complete");
});

test("a dependency cycle is reported as a refusal, not as an unexplained empty schedule", () => {
  const dag = fixtureDagFor("alpha", "ready");
  const cyclic: DagView = { ...dag, nextReady: null, blockers: [], cycle: ["002-beta", "003-gamma", "002-beta"] };

  const summary = summarizeBacklog(cyclic);
  expect(summary.state).toBe("refused");
  expect(summary.headline).toContain("dependency cycle");
});

test("an unfolded backlog is unknown rather than empty", () => {
  const summary = summarizeBacklog(null);

  expect(summary.state).toBe("unknown");
  expect(summary.headline).toContain("has not been folded");
  expect(explainScheduling(summary, ALPHA, STANDBY)).toContain("nothing is claimed");
});

// --- why it is or is not being taken ---------------------------------------

test("the flight-slot holder is named as such, and a parked slot is not idle", () => {
  const ready = summarizeBacklog(fixtureDagFor("alpha", "ready"));

  expect(explainScheduling(ready, ALPHA, metaWithDaemon("driving", "alpha"))).toContain("flight slot");
  expect(explainScheduling(ready, ALPHA, metaWithDaemon("parked", "alpha"))).toContain("parked on the quota horizon");
});

test("armed ready work says the scheduler will take it, without promising the next scan", () => {
  const ready = summarizeBacklog(fixtureDagFor("alpha", "ready"));
  const why = explainScheduling(ready, ALPHA, STANDBY);

  expect(why).toContain("armed and qualified");
  // 026 D-4's settled signature is scheduler state no route serves, so it is
  // named as a caveat rather than silently assumed away.
  expect(why).toContain("026 D-4");
});

test("disarmed ready work says it is observed and never driven", () => {
  const ready = summarizeBacklog(fixtureDagFor("beta", "ready"));
  const why = explainScheduling(ready, fixtureProjectView("beta", { armed: false }), STANDBY);

  expect(why).toContain("disarmed");
  expect(why).toContain("never driven");
});

test("an unqualified project's refusal outranks its armed flag", () => {
  const ready = summarizeBacklog(fixtureDagFor("gamma", "ready"));
  const why = explainScheduling(ready, fixtureProjectView("gamma", { qualification: FIXTURE_UNQUALIFIED }), STANDBY);

  expect(why).toContain("unqualified");
  expect(why).toContain("refuses to drive");
});

test("a finished backlog on an armed project says the daemon stays up", () => {
  const complete = summarizeBacklog(fixtureDagFor("alpha", "complete"));
  const why = explainScheduling(complete, ALPHA, STANDBY);

  expect(why).toContain("nothing pending");
  expect(why).toContain("standby");
});
