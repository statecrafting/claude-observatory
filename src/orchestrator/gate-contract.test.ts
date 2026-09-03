import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GATE_COMMANDS,
  LEGACY_GATE_CONTRACT,
  gatePayload,
  gateRefusal,
  gateSuiteFor,
  parseGateContract,
  probeGate,
  probeGateContract,
  renderGate,
  renderGateDetail,
  resolveGateBinding,
  sameGateCommands,
  type GateContract,
} from "./gate-contract";
import {
  PROJECT_KINDS,
  foldProjects,
  migrateProjectGate,
  openProjectsChain,
  projectsFromChain,
  registerProject,
  removeProject,
  requalifyProject,
  setProjectArmed,
  setProjectGate,
  verifyProjectsChain,
  type QualificationVerdict,
} from "./projects";
import { setProjectProfile } from "./projects";

// --- fixtures ---------------------------------------------------------------

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "gate-home-"));
}

// A target tree, described by the files it holds. The probe is a read of the
// root and nothing else, so a fixture directory with the right manifests is
// the whole world it needs (FR-002).
function targetDir(prefix: string, files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `gate-target-${prefix}-`));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function verdict(qualified: boolean): QualificationVerdict {
  return {
    qualified,
    checks: [{ id: "git-repo", ok: qualified, detail: qualified ? "git work tree root" : "not a git work tree" }],
    warnings: [],
  };
}

const MAKEFILE_WITH_CI = `.PHONY: ci build

build:
\tcargo build

ci: build
\tcargo test
`;

const MAKEFILE_WITHOUT_CI = `.PHONY: build

build:
\tbun run build
`;

// --- FR-002: the probe, one test per B-2 rule plus the precedence cases ------

test("FR-002 rule 1: a Makefile with a ci target yields `make ci` and names the rule", () => {
  const dir = targetDir("make-ci", { Makefile: MAKEFILE_WITH_CI });
  expect(probeGate(dir)).toEqual({ rule: "make-ci", commands: [["make", "ci"]] });
});

test("FR-002 rule 1: a `ci` assignment is a variable, not a target, and does not fire the rule", () => {
  // Every colon-flavored assignment make understands, none of which publishes
  // a gate: a repo that sets a `ci` variable has said nothing about how it is
  // verified.
  for (const line of ["ci := nothing", "ci ::= nothing", "ci:::= nothing", "ci:=nothing"]) {
    const dir = targetDir("make-ci-var", { Makefile: `${line}\n\nbuild:\n\techo hi\n` });
    expect({ line, rule: probeGate(dir).rule }).toEqual({ line, rule: "none" });
  }
});

test("FR-002 rule 1: a double-colon `ci::` rule still counts as a published gate", () => {
  for (const line of ["ci::", "ci:: build", "ci:", "ci : build"]) {
    const dir = targetDir("make-ci-double", { Makefile: `${line}\n\techo ci\n` });
    expect({ line, probed: probeGate(dir) }).toEqual({ line, probed: { rule: "make-ci", commands: [["make", "ci"]] } });
  }
});

test("FR-002 rule 2: a tsconfig.json yields the Bun pair", () => {
  const dir = targetDir("ts", { "tsconfig.json": "{}\n" });
  expect(probeGate(dir)).toEqual({
    rule: "typescript",
    commands: [
      ["bun", "run", "typecheck"],
      ["bun", "test"],
    ],
  });
});

test("FR-002 rule 3: a Cargo workspace yields the full lint-and-test gate (D-3)", () => {
  const dir = targetDir("rust", { "Cargo.toml": "[workspace]\n" });
  expect(probeGate(dir)).toEqual({
    rule: "rust",
    commands: [
      ["cargo", "fmt", "--all", "--check"],
      ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ["cargo", "test", "--workspace", "--locked"],
    ],
  });
});

test("FR-002 rule 4: a Go module yields build, vet and test (D-3)", () => {
  const dir = targetDir("go", { "go.mod": "module example.com/x\n" });
  expect(probeGate(dir)).toEqual({
    rule: "go",
    commands: [
      ["go", "build", "./..."],
      ["go", "vet", "./..."],
      ["go", "test", "./..."],
    ],
  });
});

test("FR-002 rule 5: a pyproject declaring ruff and pytest yields exactly those two (D-4)", () => {
  const dir = targetDir("py-declared", {
    "pyproject.toml": `[project]
name = "x"

[tool.ruff.lint]
select = ["E"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
  });
  expect(probeGate(dir)).toEqual({ rule: "python", commands: [["ruff", "check", "."], ["pytest"]] });
});

test("FR-002 rule 5: a pyproject declaring neither yields an empty list with the rule recorded (D-4)", () => {
  const dir = targetDir("py-bare", { "pyproject.toml": '[project]\nname = "x"\n' });
  const probed = probeGate(dir);
  expect(probed).toEqual({ rule: "python", commands: [] });
  // The reason survives to the surface: "python, no declared gate" rather
  // than "governance-only" with nothing said about why.
  expect(renderGate({ ...probed, source: "probe", legacy: false })).toBe("python, no declared gate");
});

test("FR-002 rule 6: an empty directory yields the empty list, rule `none`", () => {
  expect(probeGate(targetDir("empty"))).toEqual({ rule: "none", commands: [] });
});

test("FR-002 precedence: a target matching two rules at once takes the earlier (D-1)", () => {
  const both = targetDir("make-and-ts", { Makefile: MAKEFILE_WITH_CI, "tsconfig.json": "{}\n" });
  expect(probeGate(both).rule).toBe("make-ci");

  const rustAndGo = targetDir("rust-and-go", { "Cargo.toml": "[workspace]\n", "go.mod": "module x\n" });
  expect(probeGate(rustAndGo).rule).toBe("rust");
});

test("FR-002 precedence: a Makefile without a ci target beside a tsconfig falls through to rule 2", () => {
  const dir = targetDir("make-no-ci-ts", { Makefile: MAKEFILE_WITHOUT_CI, "tsconfig.json": "{}\n" });
  expect(probeGate(dir).rule).toBe("typescript");
});

test("the probe tolerates a target that does not exist yet, which is a legal registration", () => {
  expect(probeGate("/nonexistent/target/that/was/never/cloned")).toEqual({ rule: "none", commands: [] });
});

test("probeGateContract records the probe as the contract's source", () => {
  const dir = targetDir("probe-source", { "Cargo.toml": "[workspace]\n" });
  const contract = probeGateContract(dir);
  expect(contract.source).toBe("probe");
  expect(contract.rule).toBe("rust");
});

// --- FR-003: the one derivation ---------------------------------------------

test("FR-003: the suite always begins with the four spec-spine floor commands, in order", () => {
  const contract: GateContract = { commands: [["make", "ci"]], source: "probe", rule: "make-ci" };
  const suite = gateSuiteFor(contract);
  expect(suite.slice(0, GATE_COMMANDS.length)).toEqual(GATE_COMMANDS as string[][]);
  expect(GATE_COMMANDS.every((cmd) => cmd[0] === "spec-spine")).toBe(true);
  expect(GATE_COMMANDS.length).toBe(4);
});

test("FR-003: the contract's commands follow the floor verbatim, in order", () => {
  const contract: GateContract = {
    commands: [
      ["cargo", "fmt", "--all", "--check"],
      ["cargo", "test", "--workspace", "--locked"],
    ],
    source: "cli",
    rule: null,
  };
  expect(gateSuiteFor(contract).slice(GATE_COMMANDS.length)).toEqual([
    ["cargo", "fmt", "--all", "--check"],
    ["cargo", "test", "--workspace", "--locked"],
  ]);
});

test("FR-003: an empty contract yields exactly the floor", () => {
  expect(gateSuiteFor({ commands: [], source: "cli", rule: null })).toEqual(GATE_COMMANDS as string[][]);
  expect(gateSuiteFor(LEGACY_GATE_CONTRACT)).toEqual(GATE_COMMANDS as string[][]);
});

test("resolveGateBinding reads a late-bound contract at the moment it is asked", () => {
  let current: GateContract = { commands: [["make", "ci"]], source: "cli", rule: null };
  const binding = (): GateContract => current;
  expect(resolveGateBinding(binding).commands).toEqual([["make", "ci"]]);
  current = { commands: [], source: "cli", rule: null };
  expect(resolveGateBinding(binding).commands).toEqual([]);
  // Absent is the legacy fold, never a fabricated language gate.
  expect(resolveGateBinding(undefined)).toEqual(LEGACY_GATE_CONTRACT);
});

// --- the payload codec ------------------------------------------------------

test("a contract round-trips through its payload, rule and source included", () => {
  const contract: GateContract = { commands: [["make", "ci"]], source: "probe", rule: "make-ci" };
  expect(parseGateContract(gatePayload(contract), "test")).toEqual(contract);
});

test("a malformed gate payload throws rather than degrading to a default", () => {
  expect(() => parseGateContract({ commands: "make ci", source: "cli", rule: null }, "x")).toThrow(/commands/);
  expect(() => parseGateContract({ commands: [["make", 1]], source: "cli", rule: null }, "x")).toThrow(/argv arrays/);
  expect(() => parseGateContract({ commands: [], source: "operator", rule: null }, "x")).toThrow(/source/);
  expect(() => parseGateContract({ commands: [], source: "cli", rule: "haskell" }, "x")).toThrow(/rule/);
  expect(() => parseGateContract("not an object", "x")).toThrow(/JSON object/);
});

test("gateRefusal refuses a command that could never be executed, and nothing else", () => {
  expect(gateRefusal({ commands: [], source: "cli", rule: null })).toBeNull();
  // B-7: an override that drops what the probe found is the operator's right.
  expect(gateRefusal({ commands: [["make", "ci"]], source: "cli", rule: null })).toBeNull();
  expect(gateRefusal({ commands: [[]], source: "cli", rule: null })).toMatch(/program name/);
  expect(gateRefusal({ commands: [["  "]], source: "cli", rule: null })).toMatch(/blank/);
});

test("sameGateCommands compares argv element by element, ignoring provenance", () => {
  const a: GateContract = { commands: [["make", "ci"]], source: "probe", rule: "make-ci" };
  const b: GateContract = { commands: [["make", "ci"]], source: "cli", rule: null };
  expect(sameGateCommands(a, b)).toBe(true);
  expect(sameGateCommands(a, { commands: [["make", "test"]], source: "cli", rule: null })).toBe(false);
  expect(sameGateCommands(a, { commands: [], source: "cli", rule: null })).toBe(false);
});

// --- B-6: rendering ---------------------------------------------------------

test("B-6: no surface renders a blank, even for an argv array only a hand-edited chain could hold", () => {
  expect(renderGate({ commands: [[]], source: "cli", rule: null, legacy: false })).toBe("?");
});

test("B-6: the compact cell names the gate, and a legacy one reads distinguishably", () => {
  expect(renderGate(LEGACY_GATE_CONTRACT)).toBe("governance-only (legacy)");
  expect(renderGate({ commands: [], source: "probe", rule: "none", legacy: false })).toBe("governance-only");
  expect(renderGate({ commands: [["make", "ci"]], source: "probe", rule: "make-ci", legacy: false })).toBe("make ci");
  expect(
    renderGate({
      commands: [
        ["bun", "run", "typecheck"],
        ["bun", "test"],
      ],
      source: "probe",
      rule: "typescript",
      legacy: false,
    })
  ).toBe("bun");
  expect(
    renderGate({
      commands: [
        ["cargo", "fmt", "--all", "--check"],
        ["cargo", "test", "--workspace", "--locked"],
      ],
      source: "probe",
      rule: "rust",
      legacy: false,
    })
  ).toBe("cargo");
});

test("B-6: the detail spells out every command and where the list came from", () => {
  const probed = renderGateDetail({
    commands: [["make", "ci"]],
    source: "probe",
    rule: "make-ci",
    legacy: false,
  });
  expect(probed.join("\n")).toContain("probed (make-ci)");
  expect(probed.join("\n")).toContain("make ci");

  const operator = renderGateDetail({ commands: [["just", "test"]], source: "cli", rule: null, legacy: false });
  expect(operator.join("\n")).toContain("set by cli");

  const legacy = renderGateDetail(LEGACY_GATE_CONTRACT);
  expect(legacy.join("\n")).toContain("no gate record on the chain");
});

// --- FR-001: the fold -------------------------------------------------------

test("FR-001: a chain with no gate record folds to the empty contract flagged legacy (B-3)", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    // The pre-041 registry's records, appended straight to the chain: a
    // registration that never heard of gates is exactly what B-3 is about.
    chain.append(PROJECT_KINDS.registered, {
      name: "legacy-target",
      repoDir: "/targets/legacy-target",
      armed: true,
      qualification: { qualified: true, checks: [], warnings: [], adoptable: false },
      source: "cli",
    });
    const project = projectsFromChain(chain.fold()).get("legacy-target")!;
    expect(project.gate).toEqual(LEGACY_GATE_CONTRACT);
    expect(project.gate.legacy).toBe(true);
    expect(gateSuiteFor(project.gate)).toEqual(GATE_COMMANDS as string[][]);
  } finally {
    chain.close();
  }
});

test("FR-001: registration probes the target and folds to that contract, never legacy (B-2)", () => {
  const home = freshHome();
  const repoDir = targetDir("registered-rust", { "Cargo.toml": "[workspace]\n" });
  const chain = openProjectsChain(home);
  try {
    const registered = registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "cli" });
    expect(registered.project!.gate.legacy).toBe(false);
    expect(registered.project!.gate.source).toBe("probe");
    expect(registered.project!.gate.rule).toBe("rust");
    expect(registered.project!.gate.commands[0]).toEqual(["cargo", "fmt", "--all", "--check"]);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("FR-001: an operator override supersedes the probe and is journaled with its source (B-7)", () => {
  const home = freshHome();
  const repoDir = targetDir("override", { "Cargo.toml": "[workspace]\n" });
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "cli" });
    // Dropping two of the three commands the probe found is allowed and
    // journaled: the orchestrator records the choice, it does not argue.
    const set = setProjectGate({
      chain,
      name: "target",
      gate: { commands: [["cargo", "test", "--workspace"]], source: "cli", rule: null },
    });
    expect(set.record.kind).toBe(PROJECT_KINDS.gateSet);
    expect(set.record.payload).toMatchObject({ name: "target", source: "cli", rule: null });
    expect(set.project!.gate).toEqual({
      commands: [["cargo", "test", "--workspace"]],
      source: "cli",
      rule: null,
      legacy: false,
    });
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("FR-001: a requalification appends a gate record only when the probe's answer changed (B-2)", () => {
  const home = freshHome();
  const repoDir = targetDir("requalified", { "tsconfig.json": "{}\n" });
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "cli" });
    const afterRegistration = chain.fold().records.length;

    // Nothing about the tree moved: no gate record.
    requalifyProject({ chain, name: "target", qualification: verdict(true), source: "cli" });
    const gateRecords = (): number =>
      chain.fold().records.filter((r) => r.kind === PROJECT_KINDS.gateSet).length;
    expect(chain.fold().records.length).toBe(afterRegistration + 1);
    expect(gateRecords()).toBe(1);

    // The target publishes a `ci` target; the next requalification is judged
    // by it (D-1's precedence, arrived at after the fact).
    writeFileSync(join(repoDir, "Makefile"), MAKEFILE_WITH_CI);
    const requalified = requalifyProject({ chain, name: "target", qualification: verdict(true), source: "cli" });
    expect(gateRecords()).toBe(2);
    expect(requalified.project!.gate.rule).toBe("make-ci");
    expect(requalified.project!.gate.commands).toEqual([["make", "ci"]]);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("FR-001: gate records interleave with profile, arm and removal records without confusing the fold", () => {
  const home = freshHome();
  const repoDir = targetDir("interleaved", { "tsconfig.json": "{}\n" });
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "cli" });
    setProjectProfile({ chain, name: "target", profile: { mode: "guarded" }, source: "api" });
    setProjectGate({ chain, name: "target", gate: { commands: [["make", "ci"]], source: "ui", rule: null } });
    setProjectArmed({ chain, name: "target", armed: false, source: "cli" });

    const project = projectsFromChain(chain.fold()).get("target")!;
    expect(project.armed).toBe(false);
    expect(project.profile.mode).toBe("guarded");
    expect(project.gate.commands).toEqual([["make", "ci"]]);
    expect(project.gate.source).toBe("ui");

    // 025 D-5: a gate record naming a project that is no longer live is inert,
    // and only a fresh registration brings the name back, with a fresh probe.
    removeProject({ chain, name: "target", source: "cli" });
    chain.append(PROJECT_KINDS.gateSet, { name: "target", commands: [["make", "nope"]], source: "cli", rule: null });
    expect(projectsFromChain(chain.fold()).has("target")).toBe(false);

    registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "cli" });
    const reborn = projectsFromChain(chain.fold()).get("target")!;
    expect(reborn.gate.rule).toBe("typescript");
    expect(reborn.gate.commands).toEqual([
      ["bun", "run", "typecheck"],
      ["bun", "test"],
    ]);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

// --- FR-006: the migration (B-8) --------------------------------------------

// A pre-041 chain: the registration and its posture, no gate record. This is
// the history every project registered before this spec actually carries.
function legacyChain(chain: ReturnType<typeof openProjectsChain>, name: string, repoDir: string): void {
  chain.append(PROJECT_KINDS.registered, {
    name,
    repoDir,
    armed: true,
    qualification: { qualified: true, checks: [], warnings: [], adoptable: false },
    source: "cli",
  });
  chain.append(PROJECT_KINDS.profileSet, {
    name,
    profile: { mode: "bypass", allowedTools: null, disallowedTools: null, models: null },
    source: "cli",
  });
}

test("FR-006: a chain with no gate record gains exactly one probed record on first service", () => {
  const home = freshHome();
  const repoDir = targetDir("migrate-ts", { "tsconfig.json": "{}\n" });
  const chain = openProjectsChain(home);
  try {
    legacyChain(chain, "target", repoDir);
    expect(projectsFromChain(chain.fold()).get("target")!.gate.legacy).toBe(true);

    const migrated = migrateProjectGate(chain, "target");
    expect(migrated).not.toBeNull();
    expect(migrated!.record.kind).toBe(PROJECT_KINDS.gateSet);
    expect(migrated!.record.payload).toMatchObject({ name: "target", source: "probe", rule: "typescript" });

    // What B-2 would have derived at registration, arrived at late.
    expect(migrated!.project!.gate).toEqual({ ...probeGateContract(repoDir), legacy: false });
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("FR-006: a second service appends nothing; the record's existence is the guard", () => {
  const home = freshHome();
  const repoDir = targetDir("migrate-once", { "Cargo.toml": "[workspace]\n" });
  const chain = openProjectsChain(home);
  try {
    legacyChain(chain, "target", repoDir);
    expect(migrateProjectGate(chain, "target")).not.toBeNull();
    const after = chain.fold().records.length;

    expect(migrateProjectGate(chain, "target")).toBeNull();
    expect(migrateProjectGate(chain, "target")).toBeNull();
    expect(chain.fold().records.length).toBe(after);
  } finally {
    chain.close();
  }
});

test("FR-006: a project whose probe finds nothing migrates to an explicit empty contract", () => {
  const home = freshHome();
  const repoDir = targetDir("migrate-bare");
  const chain = openProjectsChain(home);
  try {
    legacyChain(chain, "target", repoDir);
    const migrated = migrateProjectGate(chain, "target");
    expect(migrated).not.toBeNull();
    const gate = migrated!.project!.gate;
    // The difference between "nothing to run" and "never asked".
    expect(gate.commands).toEqual([]);
    expect(gate.legacy).toBe(false);
    expect(gate.rule).toBe("none");
    expect(renderGate(gate)).toBe("governance-only");
  } finally {
    chain.close();
  }
});

test("FR-006: migrating an unknown or removed project is a no-op, never a throw", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    expect(migrateProjectGate(chain, "never-registered")).toBeNull();
    legacyChain(chain, "target", targetDir("migrate-removed"));
    removeProject({ chain, name: "target", source: "cli" });
    expect(migrateProjectGate(chain, "target")).toBeNull();
  } finally {
    chain.close();
  }
});

test("FR-006: a registration made after this spec never enters the legacy state at all", () => {
  const home = freshHome();
  const repoDir = targetDir("born-with-a-gate", { Makefile: MAKEFILE_WITH_CI });
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir, name: "target", qualification: verdict(true), source: "api" });
    expect(foldProjects(chain.fold().records).get("target")!.gate.legacy).toBe(false);
    // And so B-8 has nothing to do for it, on this or any later service.
    expect(migrateProjectGate(chain, "target")).toBeNull();
  } finally {
    chain.close();
  }
});
