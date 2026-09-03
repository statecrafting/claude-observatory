// Spec 032's own tests: the derivation (FR-002), the fold contribution
// (FR-001), and the spawn path (FR-003).
//
// The derivation tests are the load-bearing ones. `sessionArgsForProfile` is
// the only place in this codebase that composes a permission flag, so B-1's
// mutual exclusion is a property of one function's output rather than of a
// convention every spawn site has to keep; these tests are what makes that
// worth relying on.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ALLOWED_TOOLS_FLAG,
  BYPASS_FLAG,
  DISALLOWED_TOOLS_FLAG,
  DEFAULT_REGISTRATION_PROFILE,
  GUARDED_BASELINE_ALLOWED_TOOLS,
  GUARDED_PERMISSION_MODE,
  LEGACY_BYPASS_PROFILE,
  PERMISSION_MODE_FLAG,
  allowedToolsFor,
  isExecutionMode,
  parseProfile,
  profilePayload,
  profileRefusal,
  renderProfile,
  resolveProfileSource,
  sessionArgsForProfile,
  type ExecutionProfile,
} from "./profile";
import {
  PROJECT_KINDS,
  foldProjects,
  openProjectsChain,
  projectsFromChain,
  registerProject,
  setProjectArmed,
  setProjectProfile,
  verifyProjectsChain,
  type QualificationVerdict,
} from "./projects";
import { createProductionDaemonDeps } from "./daemon";
import type { JournalRecord } from "./journal";

// --- fixtures ---------------------------------------------------------------

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "profile-home-"));
}

function verdict(qualified: boolean): QualificationVerdict {
  return {
    qualified,
    checks: [{ id: "git-repo", ok: qualified, detail: "git work tree root" }],
    warnings: [],
  };
}

const GUARDED: ExecutionProfile = { mode: "guarded", allowedTools: ["Read", "Bash(git:*)"] };

// --- the derivation (B-1, B-3, FR-002) --------------------------------------

test("profile: bypass derives exactly the flag spec 014 hardcoded", () => {
  expect(sessionArgsForProfile({ mode: "bypass" })).toEqual([BYPASS_FLAG]);
  // The registration default and the legacy fold both derive that same argv,
  // which is the whole of B-2's promise to targets registered before 032.
  expect(sessionArgsForProfile(DEFAULT_REGISTRATION_PROFILE)).toEqual([BYPASS_FLAG]);
  expect(sessionArgsForProfile(LEGACY_BYPASS_PROFILE)).toEqual([BYPASS_FLAG]);
});

test("profile: a guarded profile never derives the bypass flag, under any input", () => {
  const inputs: readonly ExecutionProfile[] = [
    { mode: "guarded" },
    { mode: "guarded", allowedTools: [] },
    { mode: "guarded", allowedTools: ["Read"] },
    { mode: "guarded", disallowedTools: ["Bash(rm:*)"] },
    { mode: "guarded", allowedTools: [], disallowedTools: [] },
    // The case B-1's "by construction" has to survive: an allowlist naming
    // the bypass flag itself. The tool flags are variadic in the real CLI, so
    // a space-separated value beginning with `--` would end the list and be
    // parsed as a flag of its own; joined with `=` it can only be a value.
    { mode: "guarded", allowedTools: [BYPASS_FLAG] },
    { mode: "guarded", disallowedTools: [BYPASS_FLAG] },
  ];
  for (const profile of inputs) {
    const args = sessionArgsForProfile(profile);
    expect(args).not.toContain(BYPASS_FLAG);
    // No argv element is the bypass flag, and none of them could become one:
    // every guarded element is one flag carrying its own value.
    expect(args.every((arg) => arg.startsWith("--") && !arg.startsWith(BYPASS_FLAG))).toBe(true);
    expect(args[0]).toBe(`${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`);
  }
});

test("profile: guarded passes the allowlist and disallowlist through verbatim", () => {
  const full: ExecutionProfile = {
    mode: "guarded",
    allowedTools: ["Read", "Bash(git status:*)"],
    disallowedTools: ["Bash(rm:*)", "WebFetch"],
  };
  expect(sessionArgsForProfile(full)).toEqual([
    `${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`,
    `${ALLOWED_TOOLS_FLAG}=Read,Bash(git status:*)`,
    `${DISALLOWED_TOOLS_FLAG}=Bash(rm:*),WebFetch`,
  ]);
  // One flag to one argv element: a tool pattern carrying a space cannot be
  // read as the start of the next flag.
  expect(sessionArgsForProfile(full).filter((arg) => arg.includes(" ")).length).toBe(1);
});

test("profile: the D-2 baseline stands in when a guarded profile names no allowlist", () => {
  expect(allowedToolsFor({ mode: "guarded" })).toEqual(GUARDED_BASELINE_ALLOWED_TOOLS);
  expect(sessionArgsForProfile({ mode: "guarded" })).toEqual([
    `${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`,
    `${ALLOWED_TOOLS_FLAG}=${GUARDED_BASELINE_ALLOWED_TOOLS.join(",")}`,
  ]);
  // The baseline is the governed loop's own commands (D-2): a guarded session
  // that cannot run the gate is a broken build, not a safe one.
  for (const tool of ["Bash(git:*)", "Bash(gh:*)", "Bash(bun:*)", "Bash(spec-spine:*)"]) {
    expect(GUARDED_BASELINE_ALLOWED_TOOLS).toContain(tool);
  }
  // An explicit list replaces the baseline rather than extending it.
  expect(allowedToolsFor(GUARDED)).toEqual(["Read", "Bash(git:*)"]);
  // A bypass profile has no effective allowlist at all: there is nothing for
  // one to constrain.
  expect(allowedToolsFor({ mode: "bypass" })).toEqual([]);
});

test("profile: an empty effective allowlist emits no flag rather than an empty value", () => {
  expect(sessionArgsForProfile({ mode: "guarded", allowedTools: [] })).toEqual([
    `${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`,
  ]);
  expect(sessionArgsForProfile({ mode: "guarded", allowedTools: ["Read"], disallowedTools: [] })).toEqual([
    `${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`,
    `${ALLOWED_TOOLS_FLAG}=Read`,
  ]);
});

// --- the payload codec (B-5) ------------------------------------------------

test("profile: a payload round-trips, and a malformed one throws rather than defaulting", () => {
  for (const profile of [{ mode: "bypass" } as const, GUARDED, { mode: "guarded", disallowedTools: ["X"] } as const]) {
    expect(parseProfile(profilePayload(profile), "test")).toEqual(profile);
  }
  // Absent lists travel as explicit nulls, so a reader never has to tell
  // "omitted" from "empty".
  // 040 B-4 adds the model pair to the same payload under the same rule: an
  // absent pair is an explicit null, not a missing key.
  expect(profilePayload({ mode: "bypass" })).toEqual({
    mode: "bypass",
    allowedTools: null,
    disallowedTools: null,
    models: null,
  });
  expect(parseProfile({ mode: "guarded", allowedTools: [] }, "test")).toEqual({ mode: "guarded", allowedTools: [] });

  expect(() => parseProfile(undefined, "test")).toThrow(/expected a JSON object/);
  expect(() => parseProfile("bypass", "test")).toThrow(/expected a JSON object/);
  expect(() => parseProfile({ mode: "yolo" }, "test")).toThrow(/expected mode "bypass" or "guarded"/);
  expect(() => parseProfile({ mode: "guarded", allowedTools: "Read" }, "test")).toThrow(/string array or null/);
  expect(() => parseProfile({ mode: "guarded", allowedTools: [1] }, "test")).toThrow(/string array or null/);

  expect(isExecutionMode("bypass")).toBe(true);
  expect(isExecutionMode("acceptEdits")).toBe(false);
});

test("profile: the write verbs refuse a posture that cannot mean what it says", () => {
  expect(profileRefusal({ mode: "bypass" })).toBeNull();
  expect(profileRefusal({ mode: "guarded" })).toBeNull();
  expect(profileRefusal(GUARDED)).toBeNull();
  // A bypass profile carrying tool lists it can never honor.
  expect(profileRefusal({ mode: "bypass", allowedTools: ["Read"] })).toMatch(/bypass profile carries no tool lists/);
  expect(profileRefusal({ mode: "bypass", disallowedTools: ["Read"] })).toMatch(/bypass profile carries no tool lists/);
  // An explicit empty allowlist derives an argv indistinguishable from "no
  // allowlist at all", so it is refused rather than journaled.
  expect(profileRefusal({ mode: "guarded", allowedTools: [] })).toMatch(/at least one allowed tool/);
});

// --- rendering (B-6) --------------------------------------------------------

test("profile: a legacy bypass renders distinguishably from an operator-set one", () => {
  expect(renderProfile({ mode: "bypass", legacy: true })).toBe("bypass (legacy)");
  expect(renderProfile({ mode: "bypass", legacy: false })).toBe("bypass");
  expect(renderProfile({ mode: "guarded", legacy: false })).toBe(
    `guarded (${GUARDED_BASELINE_ALLOWED_TOOLS.length} baseline tools)`
  );
  expect(renderProfile({ ...GUARDED, legacy: false })).toBe("guarded (2 tools)");
  expect(renderProfile({ ...GUARDED, disallowedTools: ["WebFetch"], legacy: false })).toBe("guarded (2 tools, 1 denied)");
  // No surface ever prints a blank for a posture.
  for (const rendered of [
    renderProfile({ mode: "bypass", legacy: true }),
    renderProfile({ mode: "guarded", legacy: false }),
  ]) {
    expect(rendered.trim().length).toBeGreaterThan(0);
  }
});

// --- the fold (B-2, FR-001) -------------------------------------------------

// A pre-032 chain: the registration record alone, exactly as registerProject
// wrote it before postures existed. registerProject cannot produce this
// history any more, which is precisely what makes it worth writing by hand.
function appendLegacyRegistration(chain: ReturnType<typeof openProjectsChain>, name: string, repoDir: string): JournalRecord {
  return chain.append(PROJECT_KINDS.registered, {
    name,
    repoDir,
    armed: true,
    qualification: { qualified: true, checks: [{ id: "git-repo", ok: true, detail: "git work tree root" }], warnings: [] },
    source: "cli",
  });
}

test("the fold: a chain with no profile record folds to bypass marked legacy", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    appendLegacyRegistration(chain, "enrahitu", "/Users/x/DevWork/enrahitu");
    const project = projectsFromChain(chain.fold()).get("enrahitu");
    expect(project?.profile).toEqual({ mode: "bypass", legacy: true });
    // Today's behavior, kept: the posture an existing registration runs under
    // does not move when 032 lands, only its silence does.
    expect(sessionArgsForProfile(project!.profile)).toEqual([BYPASS_FLAG]);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("the fold: registration records its posture beside itself, so legacy only describes pre-032 history", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    const registered = registerProject({
      chain,
      repoDir: "/Users/x/DevWork/enrahitu",
      qualification: verdict(true),
      source: "cli",
    });
    // Three records, and the posture is the second: a mutation only applies to
    // a project that is already live (025 D-5). The third is 041 B-2's probed
    // gate contract, appended beside the posture on the same reasoning.
    const records = chain.fold().records;
    expect(records.map((record) => record.kind)).toEqual([
      PROJECT_KINDS.registered,
      PROJECT_KINDS.profileSet,
      PROJECT_KINDS.gateSet,
    ]);
    expect(records[1]!.payload).toMatchObject({ name: "enrahitu", source: "cli" });
    // D-1: registration without an explicit posture records bypass, chosen
    // rather than inherited, so `legacy` is false from the first record on.
    expect(registered.project?.profile).toEqual({ mode: "bypass", legacy: false });

    // And a registration that names one records that instead.
    const guarded = registerProject({
      chain,
      repoDir: "/Users/x/DevWork/chancery",
      qualification: verdict(true),
      source: "ui",
      profile: GUARDED,
    });
    expect(guarded.project?.profile).toEqual({ ...GUARDED, legacy: false });
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("the fold: a posture is set, changed, and interleaved with arm and disarm", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  const fold = (): ReturnType<typeof foldProjects> => projectsFromChain(chain.fold());
  try {
    appendLegacyRegistration(chain, "enrahitu", "/Users/x/DevWork/enrahitu");
    expect(fold().get("enrahitu")?.profile).toEqual({ mode: "bypass", legacy: true });

    // An explicit set clears legacy: someone has now spoken about it.
    const set = setProjectProfile({ chain, name: "enrahitu", profile: GUARDED, source: "cli" });
    expect(set.record.kind).toBe(PROJECT_KINDS.profileSet);
    expect(set.project?.profile).toEqual({ ...GUARDED, legacy: false });

    // Disarming does not touch the posture, and setting the posture does not
    // arm anything: two consents, two records, neither implying the other.
    setProjectArmed({ chain, name: "enrahitu", armed: false, source: "api" });
    expect(fold().get("enrahitu")).toMatchObject({ armed: false, profile: { ...GUARDED, legacy: false } });

    const tightened: ExecutionProfile = { mode: "guarded", allowedTools: ["Read"], disallowedTools: ["Bash(rm:*)"] };
    setProjectProfile({ chain, name: "enrahitu", profile: tightened, source: "ui" });
    expect(fold().get("enrahitu")).toMatchObject({ armed: false, profile: { ...tightened, legacy: false } });

    setProjectArmed({ chain, name: "enrahitu", armed: true, source: "cli" });
    expect(fold().get("enrahitu")).toMatchObject({ armed: true, profile: { ...tightened, legacy: false } });

    // A change back to bypass is a change like any other, and it is not the
    // legacy bypass: an operator chose it.
    setProjectProfile({ chain, name: "enrahitu", profile: { mode: "bypass" }, source: "cli" });
    expect(fold().get("enrahitu")?.profile).toEqual({ mode: "bypass", legacy: false });

    // FR-001: chain verification passes over the whole history.
    const verified = verifyProjectsChain(home);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.count).toBe(6);
  } finally {
    chain.close();
  }
});

test("the fold: a profile record naming a project that is not live is inert (025 D-5)", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    chain.append(PROJECT_KINDS.profileSet, {
      name: "never-registered",
      profile: profilePayload(GUARDED),
      source: "cli",
    });
    expect(foldProjects(chain.fold().records).size).toBe(0);

    // A malformed payload of an owned kind still throws rather than folding
    // to something plausible: a posture that cannot be read is not a posture
    // anyone should be driven under.
    appendLegacyRegistration(chain, "enrahitu", "/Users/x/DevWork/enrahitu");
    chain.append(PROJECT_KINDS.profileSet, { name: "enrahitu", profile: { mode: "yolo" }, source: "cli" });
    expect(() => foldProjects(chain.fold().records)).toThrow(/expected mode "bypass" or "guarded"/);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

// --- threading (B-4) --------------------------------------------------------

test("profile: a late-bound source is read at spawn time, not at wiring time", () => {
  let current: ExecutionProfile = { mode: "bypass" };
  const source = (): ExecutionProfile => current;
  expect(resolveProfileSource(source)).toEqual({ mode: "bypass" });
  current = GUARDED;
  // The seam was built once; the posture an operator tightened applies to the
  // next spawn rather than to the next daemon.
  expect(resolveProfileSource(source)).toEqual(GUARDED);
  expect(resolveProfileSource(GUARDED)).toEqual(GUARDED);
  expect(resolveProfileSource(undefined)).toEqual(DEFAULT_REGISTRATION_PROFILE);
});

// --- the spawn path (B-4, FR-003, AC-2) -------------------------------------

// The fake `claude` every session test in this repo spawns instead of the
// real CLI, here recording the argv it was handed.
function writeArgvRecorder(dir: string): { readonly bin: string; readonly argv: () => string } {
  const dump = join(dir, "argv-dump.txt");
  const bin = join(dir, "fake-claude.sh");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `echo "$@" > "${dump}"`,
      // An init event as well as a result: the init boundary is what carries
      // the posture into the journal (B-5).
      `echo '{"type":"system","subtype":"init","session_id":"sess-profile"}'`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"DONE"}'`,
      "exit 0",
    ].join("\n") + "\n"
  );
  chmodSync(bin, 0o755);
  return { bin, argv: () => readFileSync(dump, "utf8") };
}

test("the spawn path: the daemon's own session seam derives argv from the project's profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-spawn-"));
  const recorder = writeArgvRecorder(dir);
  let profile: ExecutionProfile = { mode: "guarded", allowedTools: ["Read", "Bash(git:*)"] };

  // The daemon's own seam factory, wired exactly as `daemon run` wires it:
  // the profile reaches runSession through createProcessRunner, which is the
  // path the build, ship, and shepherd stages all drive.
  const deps = createProductionDaemonDeps({
    dataDir: dir,
    repoDir: dir,
    claudeBin: recorder.bin,
    profile: () => profile,
  });

  await deps.runner.runSession({ prompt: "hi" });
  const guarded = recorder.argv();
  expect(guarded).toContain(`${PERMISSION_MODE_FLAG}=${GUARDED_PERMISSION_MODE}`);
  expect(guarded).toContain(`${ALLOWED_TOOLS_FLAG}=Read,Bash(git:*)`);
  expect(guarded).not.toContain(BYPASS_FLAG);

  // The same fixture under bypass matches today's argv, and it is the live
  // profile that decides: the seam was built once, above, under a guarded one.
  profile = { mode: "bypass" };
  await deps.runner.runSession({ prompt: "hi" });
  const bypass = recorder.argv();
  expect(bypass).toContain(BYPASS_FLAG);
  expect(bypass).not.toContain(ALLOWED_TOOLS_FLAG);
  expect(bypass).toContain("-p --output-format stream-json --verbose --dangerously-skip-permissions");
}, 20_000);

test("the spawn path: the session records the posture it was spawned under (B-5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-journal-"));
  const recorder = writeArgvRecorder(dir);
  const { openJournal } = await import("./journal");
  const journal = openJournal(dir, "orchestrator");
  try {
    const deps = createProductionDaemonDeps({
      dataDir: dir,
      repoDir: dir,
      claudeBin: recorder.bin,
      profile: { mode: "guarded", allowedTools: ["Read"], disallowedTools: ["WebFetch"] },
    });
    await deps.runner.runSession({ prompt: "hi", journal });

    const init = journal.fold().records.find((record) => record.kind === "session.init");
    expect(init).toBeDefined();
    // Mode and lists verbatim: what a session was allowed to do is a journal
    // fact rather than an inference from registry history.
    expect((init!.payload as Record<string, unknown>).profile).toEqual({
      mode: "guarded",
      allowedTools: ["Read"],
      disallowedTools: ["WebFetch"],
      models: null,
    });
  } finally {
    journal.close();
  }
}, 20_000);
