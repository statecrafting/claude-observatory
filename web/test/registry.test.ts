// The registry-control preview (spec 029 B-3, FR-002).
//
// Two things are being tested. The first is the preview itself: what a click
// will append to the daemon's projects chain, including the parts the daemon
// computes, which are marked rather than guessed. The second matters more over
// time: web/src/registry.ts re-declares the chain's record kinds, its source
// value, and its name grammar, because projects.ts opens journals and cannot be
// bundled for a browser. Re-declared contracts drift silently, so they are
// pinned here against the modules that own them; this file is what makes the
// duplication safe rather than merely convenient.
import { expect, test } from "bun:test";
import { planRegistryControl, isRegistryName, REGISTRY_CONTROL_SOURCE, REGISTRY_VERBS } from "../src/registry";
import { WEB_UI_CONTROL_SOURCE } from "../src/api";
import { fixtureProjectView, FIXTURE_UNQUALIFIED } from "./fixtures";
import { PROJECT_KINDS, isValidProjectName } from "../../src/orchestrator/projects";
import { projectSourceOf } from "../../src/orchestrator/api/server";

// --- the contract pins ------------------------------------------------------

test("every previewed kind is the kind the registry chain actually appends", () => {
  const kindOf = (verb: (typeof REGISTRY_VERBS)[number]): string | null =>
    planRegistryControl(verb, {
      project: fixtureProjectView("alpha", { armed: verb === "disarm" }),
      registration: { path: "/repo/alpha", name: "alpha" },
    }).record?.kind ?? null;

  expect(kindOf("register")).toBe(PROJECT_KINDS.registered);
  expect(kindOf("arm")).toBe(PROJECT_KINDS.armed);
  expect(kindOf("disarm")).toBe(PROJECT_KINDS.disarmed);
  expect(kindOf("requalify")).toBe(PROJECT_KINDS.requalified);
});

test("the previewed source is what the server folds this client's header down to", () => {
  // The header says "web-ui"; spec 025's chain only records cli/api/ui, and the
  // preview has to show the value an operator will read back out of the chain.
  expect(projectSourceOf(WEB_UI_CONTROL_SOURCE)).toBe(REGISTRY_CONTROL_SOURCE);
});

test("the name grammar the form checks is the one the registry enforces", () => {
  for (const name of ["alpha", "a", "claude-observatory", "x9-2", "Alpha", "-alpha", "alpha_beta", "", "a b"]) {
    expect(isRegistryName(name)).toBe(isValidProjectName(name));
  }
});

// --- the previews -----------------------------------------------------------

test("arming previews the exact record, naming the project and this UI as its source", () => {
  const plan = planRegistryControl("arm", { project: fixtureProjectView("beta", { armed: false }) });

  expect(plan.effect).toBe("journals");
  expect(plan.project).toBe("beta");
  expect(plan.record).toEqual({ kind: "project.armed", payload: { name: "beta", source: "ui" } });
  expect(plan.note).toContain("projects chain");
});

test("arming an already-armed project still journals, and the note says why", () => {
  const plan = planRegistryControl("arm", { project: fixtureProjectView("beta", { armed: true }) });

  // 025 B-2: this chain records what was asked and by whom, so unlike the run
  // controls there is no idempotent no-op to report.
  expect(plan.effect).toBe("journals");
  expect(plan.note).toContain("already reads as armed");
  expect(plan.note).toContain("records the request");
});

test("arming an unqualified project says arming will not make it schedulable", () => {
  const plan = planRegistryControl("arm", {
    project: fixtureProjectView("gamma", { armed: false, qualification: FIXTURE_UNQUALIFIED }),
  });

  expect(plan.note).toContain("not qualified");
});

test("requalifying previews the verdict as the daemon's to compute, not this page's", () => {
  const plan = planRegistryControl("requalify", { project: fixtureProjectView("alpha") });

  expect(plan.record?.kind).toBe("project.requalified");
  expect(plan.record?.payload.name).toBe("alpha");
  // B-7: an unknown is rendered as an unknown, in the preview as well.
  expect(String(plan.record?.payload.qualification)).toContain("qualification probe");
  expect(plan.note).toContain("can flip");
});

test("registering without a name previews the derivation rather than inventing one", () => {
  const plan = planRegistryControl("register", { registration: { path: "/repo/enrahitu", name: "" } });

  expect(plan.effect).toBe("journals");
  expect(plan.project).toBeNull();
  expect(plan.record?.kind).toBe("project.registered");
  expect(plan.record?.payload.repoDir).toBe("/repo/enrahitu");
  expect(String(plan.record?.payload.name)).toContain("derived from the path");
  // 010 D14: pointing the orchestrator at a target is the consent.
  expect(plan.record?.payload.armed).toBe(true);
  expect(plan.note).toContain("qualification probe");
});

test("a registration with no path is reported as the refusal it will be", () => {
  const plan = planRegistryControl("register", { registration: { path: "  ", name: "" } });

  expect(plan.effect).toBe("refused");
  expect(plan.record).toBeNull();
  expect(plan.note).toContain("bad-request");
});

test("a registration with an invalid name is refused before the registry is touched", () => {
  const plan = planRegistryControl("register", { registration: { path: "/repo/x", name: "Not A Slug" } });

  expect(plan.effect).toBe("refused");
  expect(plan.note).toContain("is not a valid project name");
});

test("a verb with no project to address is refused rather than sent at a guess", () => {
  const plan = planRegistryControl("disarm", {});

  expect(plan.effect).toBe("refused");
  expect(plan.record).toBeNull();
});
