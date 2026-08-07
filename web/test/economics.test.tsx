// The economics panel (spec 038 FR-001, FR-002).
//
// FR-001's three scenarios are the three ways this panel can lie: a rollup
// with some costs reported and some not (the denominators have to be on
// screen, and the unreported spec has to say unknown rather than 0.00), an
// empty journal (the reason, not an empty table), and the order (known cost
// descending, which is not the order the envelope arrives in).
//
// FR-002 is the seam. Spec 030 serves one route and this view adds none: the
// reader is driven with a recording fetch and the set of paths it asks for is
// asserted whole, at the reader and again through the mounted shell. The route
// suffix itself is pinned against spec 030's own constant, which is the drift
// this app cannot catch at typecheck (economics.ts says why it is re-declared).
import { expect, test } from "bun:test";
import { act } from "react";
import { flat, mount, useDom, type Mounted } from "./harness";
import { App } from "../src/App";
import { EconomicsPanel } from "../src/views/EconomicsPanel";
import {
  ECONOMICS_ROUTE,
  denominator,
  economicsPath,
  economicsReader,
  specsByKnownCost,
  type ServedEconomicsView,
  type SpecEconomics,
} from "../src/economics";
import { projectRoute, type ApiResponse, type FetchLike } from "../src/api";
import {
  ECONOMICS_ROUTE as SERVED_ECONOMICS_ROUTE,
  TERMINATION_KINDS,
} from "../../src/orchestrator/economics";
import type { TerminationKind } from "../../src/orchestrator/classify-termination";
import { FIXTURE_PROJECT, fixtureApiClient } from "./fixtures";

useDom();

const BASE_URL = "http://127.0.0.1:4519";
const GENERATED_AT = Date.parse("2026-08-06T12:00:00.000Z");

// Spec 014's whole kind set, zero-filled, with only the kinds a fixture is
// about set: the served shape carries every kind, so a fixture that carried
// fewer would be testing a payload the daemon does not send.
function endings(fired: Partial<Record<TerminationKind, number>>): Record<TerminationKind, number> {
  const all = {} as Record<TerminationKind, number>;
  for (const kind of TERMINATION_KINDS) all[kind] = fired[kind] ?? 0;
  return all;
}

function specRow(specId: string, overrides: Partial<SpecEconomics> = {}): SpecEconomics {
  return {
    specId,
    sessions: 0,
    sessionsByTermination: endings({}),
    remediationRounds: 0,
    hookBlockedStages: 0,
    costMicroUsd: null,
    costUnknownSessions: 0,
    wallClockMs: null,
    ...overrides,
  };
}

// Deliberately not in known-cost order: the fixture arrives the way the
// envelope does, in the journal's own creation order, so the sort test is
// testing a sort rather than a passthrough.
const MIXED: ServedEconomicsView = {
  project: FIXTURE_PROJECT,
  generatedAt: GENERATED_AT,
  specs: [
    specRow("003-gamma", {
      sessions: 3,
      sessionsByTermination: endings({ completed: 3 }),
      costMicroUsd: 1_500_000,
    }),
    // Every session this spec ran went unreported: unknown, never 0.00.
    specRow("004-delta", {
      sessions: 2,
      sessionsByTermination: endings({ completed: 1, crashed: 1 }),
      remediationRounds: 1,
      costUnknownSessions: 2,
    }),
    specRow("002-beta", {
      sessions: 7,
      sessionsByTermination: endings({ completed: 6, "hook-blocked": 1 }),
      remediationRounds: 2,
      hookBlockedStages: 1,
      costMicroUsd: 3_000_000,
      costUnknownSessions: 1,
      wallClockMs: 900_000,
    }),
  ],
  runs: [
    {
      runId: "run-1",
      status: "completed",
      sessions: 12,
      sessionsByTermination: endings({ completed: 10, "hook-blocked": 1, crashed: 1 }),
      remediationRounds: 3,
      hookBlockedStages: 1,
      costMicroUsd: 4_500_000,
      costUnknownSessions: 3,
      quotaParks: 1,
      parkedMs: 3_600_000,
      wallClockMs: 7_200_000,
    },
  ],
  totals: {
    sessions: 12,
    sessionsByTermination: endings({ completed: 10, "hook-blocked": 1, crashed: 1 }),
    remediationRounds: 3,
    hookBlockedStages: 1,
    costMicroUsd: 4_500_000,
    costUnknownSessions: 3,
    quotaParks: 1,
    parkedMs: 3_600_000,
  },
};

// B-2's other end: a journal with nothing in it. `totals: null` is what the
// fold serves for it (030 B-2), and it is the one case where a grid of zeros
// would be a claim rather than a reading.
const EMPTY: ServedEconomicsView = {
  project: FIXTURE_PROJECT,
  generatedAt: GENERATED_AT,
  specs: [],
  runs: [],
  totals: null,
};

function panel(economics: ServedEconomicsView | null, project: string | null = FIXTURE_PROJECT): Promise<Mounted> {
  return mount(<EconomicsPanel economics={economics} error={null} project={project} />);
}

// One table row, cell by cell, so an assertion names the column it is about
// rather than matching a substring of the whole row.
function cells(view: Mounted, testId: string): string[] {
  return [...view.find(testId).querySelectorAll("th, td")].map((cell) => flat(cell.textContent ?? ""));
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`economics: timed out waiting for ${what}`);
}

// --- FR-001: mixed known and unknown costs ----------------------------------

test("the rollup renders known cost beside the denominator it was summed over", async () => {
  const view = await panel(MIXED);
  try {
    // B-2's example sentence, on the aggregate that has the most to hide.
    expect(view.text("economics-totals-denominator")).toBe("12 sessions, 3 with no reported cost");

    const totals = view.text("economics-totals");
    expect(totals).toContain("$4.5000");
    // The parks and the rework the envelope carries, not a number of this
    // panel's own invention.
    expect(totals).toContain("1 park");
    expect(totals).toContain("3 attempts beyond the first");

    // Spec, known cost, the denominator it was summed over, and rework, which
    // is stage attempts beyond the first verbatim (030 D-4).
    expect(cells(view, "economics-spec-002-beta")).toEqual([
      "002-beta",
      "$3.0000",
      "7 sessions, 1 with no reported cost",
      "2",
    ]);

    const run = view.text("economics-run-run-1");
    expect(run).toContain("$4.5000");
    expect(run).toContain("12 sessions, 3 with no reported cost");
  } finally {
    view.unmount();
  }
});

test("a spec whose whole cost went unreported renders unknown, never 0.00", async () => {
  const view = await panel(MIXED);
  try {
    // The sessions still happened, and the row says how many; what it will not
    // say is that they were free.
    expect(cells(view, "economics-spec-004-delta")).toEqual([
      "004-delta",
      "unknown",
      "2 sessions, 2 with no reported cost",
      "1",
    ]);
    expect(view.text("economics-spec-004-delta")).not.toContain("0.00");
  } finally {
    view.unmount();
  }
});

test("a spec that reported every cost says so rather than leaving the denominator implied", async () => {
  const view = await panel(MIXED);
  try {
    expect(view.text("economics-spec-003-gamma")).toContain("3 sessions, all reporting cost");
  } finally {
    view.unmount();
  }
});

// --- FR-001: the empty journal ----------------------------------------------

test("an empty journal renders the reason, not an empty table", async () => {
  const view = await panel(EMPTY);
  try {
    const empty = view.text("economics-empty");
    expect(empty).toContain("journal is empty");
    expect(empty).toContain(FIXTURE_PROJECT);
    // No table at all, and above all no zeroed totals: a 0.00 here would be
    // this panel claiming the project ran for free.
    expect(view.query("economics-specs")).toBeNull();
    expect(view.query("economics-totals")).toBeNull();
    expect(flat(view.container.textContent ?? "")).not.toContain("$0.0000");
  } finally {
    view.unmount();
  }
});

// --- FR-001: the order ------------------------------------------------------

test("specs sort by known cost descending, with unreported cost last", async () => {
  const view = await panel(MIXED);
  try {
    const rows = [...view.find("economics-specs").querySelectorAll("tbody tr")].map((row) =>
      row.getAttribute("data-testid")
    );
    expect(rows).toEqual(["economics-spec-002-beta", "economics-spec-003-gamma", "economics-spec-004-delta"]);
  } finally {
    view.unmount();
  }
});

test("specsByKnownCost ranks an unknown below every known cost and breaks ties by spec id", () => {
  const ordered = specsByKnownCost([
    specRow("009-i", { costUnknownSessions: 1 }),
    specRow("002-b", { costMicroUsd: 10 }),
    specRow("001-a", { costMicroUsd: 10 }),
    specRow("003-c", { costMicroUsd: 0 }),
    specRow("004-d", { costUnknownSessions: 2 }),
  ]).map((spec) => spec.specId);
  // A known zero outranks an unknown: nothing was spent is a fact, and
  // nothing was reported is not.
  expect(ordered).toEqual(["001-a", "002-b", "003-c", "004-d", "009-i"]);
});

test("denominator always names both halves", () => {
  expect(denominator(12, 3)).toBe("12 sessions, 3 with no reported cost");
  expect(denominator(1, 0)).toBe("1 session, all reporting cost");
  expect(denominator(0, 0)).toBe("0 sessions, so nothing has been reported");
});

// --- B-3: degradation -------------------------------------------------------

test("a never-loaded rollup and an unselected project are named states, not empty tables", async () => {
  const unread = await panel(null);
  try {
    expect(unread.text("economics-unread")).toContain("No economics has been served yet.");
    expect(unread.query("economics-specs")).toBeNull();
  } finally {
    unread.unmount();
  }

  const unscoped = await mount(<EconomicsPanel economics={null} error={null} project={null} />);
  try {
    expect(unscoped.text("economics-unscoped")).toContain("none is selected");
  } finally {
    unscoped.unmount();
  }
});

test("an error keeps the last confirmed rollup on screen and says the daemon disagreed", async () => {
  const view = await mount(
    <EconomicsPanel
      economics={MIXED}
      error={{ kind: "unreachable", message: "connection refused" }}
      project={FIXTURE_PROJECT}
      stale
    />
  );
  try {
    const body = flat(view.container.textContent ?? "");
    expect(body).toContain("unreachable");
    expect(body).toContain("connection refused");
    // The last fold is still shown, marked stale, exactly as every other view
    // degrades (029 B-5).
    expect(view.query("economics-specs")).not.toBeNull();
    expect(view.container.querySelector(".panel-stale")).not.toBeNull();
  } finally {
    view.unmount();
  }
});

// --- FR-002: the one route --------------------------------------------------

test("the route suffix agrees with the one spec 030 serves", () => {
  expect(ECONOMICS_ROUTE).toBe(SERVED_ECONOMICS_ROUTE);
  expect(economicsPath(FIXTURE_PROJECT)).toBe(projectRoute(FIXTURE_PROJECT, SERVED_ECONOMICS_ROUTE));
});

// A fetch that records every path it is asked for and answers with one body.
function recordingFetch(paths: string[], body: string): FetchLike {
  return (input) => {
    paths.push(String(input));
    return Promise.resolve({ text: () => Promise.resolve(body) } as unknown as Response);
  };
}

test("the reader asks for the served route and nothing else", async () => {
  const paths: string[] = [];
  const read = economicsReader(BASE_URL, recordingFetch(paths, JSON.stringify({ ok: true, data: MIXED })));

  const answer = await read(FIXTURE_PROJECT);

  expect(paths).toEqual([`${BASE_URL}/api/projects/${FIXTURE_PROJECT}/${SERVED_ECONOMICS_ROUTE}`]);
  expect(answer.ok).toBe(true);
  expect(answer.ok ? answer.data.totals?.costMicroUsd : null).toBe(4_500_000);
});

test("a daemon that cannot be reached answers in the envelope rather than throwing", async () => {
  const read = economicsReader(BASE_URL, () => Promise.reject(new Error("connection refused")));
  const answer: ApiResponse<ServedEconomicsView> = await read(FIXTURE_PROJECT);
  expect(answer.ok).toBe(false);
  expect(answer.ok ? null : answer.error.kind).toBe("unreachable");
});

test("an answer that is not an envelope is reported as malformed, never coerced", async () => {
  const read = economicsReader(BASE_URL, recordingFetch([], "<html>proxy error</html>"));
  const answer: ApiResponse<ServedEconomicsView> = await read(FIXTURE_PROJECT);
  expect(answer.ok).toBe(false);
  expect(answer.ok ? null : answer.error.kind).toBe("malformed-response");
});

test("the mounted view adds no fetch path of its own", async () => {
  const paths: string[] = [];
  const client = fixtureApiClient();
  const read = economicsReader(BASE_URL, recordingFetch(paths, JSON.stringify({ ok: true, data: MIXED })));
  window.location.hash = "#/economics";
  const view = await mount(
    <App client={client} eventsUrl={`${BASE_URL}/api/events`} openStream={null} readEconomics={read} />
  );
  try {
    await waitFor(() => view.query("economics-totals") !== null, "the rollup to load");

    expect(view.text("economics-totals-denominator")).toBe("12 sessions, 3 with no reported cost");
    // The whole set of paths the rollup asked for, asserted whole: one route,
    // the one spec 030 already serves.
    expect([...new Set(paths)]).toEqual([`${BASE_URL}/api/projects/${FIXTURE_PROJECT}/${SERVED_ECONOMICS_ROUTE}`]);
    // And no control was issued to reach it: this view reads, like every other.
    expect(client.calls).toEqual([]);
  } finally {
    view.unmount();
  }
});
