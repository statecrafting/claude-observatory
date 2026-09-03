// Project gate contracts (spec 041): what a driven target is actually judged
// by after its session ends, as per-project registry state.
//
// Spec 016 B-5 says the build stage passes only when the gate commands exit 0
// on the branch after the session ends, and that the session saying "done" is
// not evidence. That sentence was only as strong as the command list behind
// it, and the list was this repo's: four spec-spine commands plus two Bun
// commands, with the Bun pair dropped on any target without a root
// tsconfig.json (016 D-10). A Rust workspace therefore passed the build stage
// on governance alone, which says nothing about whether the crate compiles.
//
// This module is spec 032's shape applied to that gap. The execution profile
// made session posture a chosen, journaled, displayed fact instead of a
// hardcoded flag; a gate contract does the same for the language gate:
//
//   B-1: a contract is an ordered list of argv arrays plus who set it. An
//   empty list is a legal contract meaning governance-only, displayed as
//   such, and never the silent default for a target that has a gate to run.
//
//   B-2: registration probes the target read-only, first matching rule wins,
//   and the rule that fired is part of the record, so a governance-only
//   registration says why.
//
//   B-4: gateSuiteFor() is the only source of a stage's gate list. Nothing
//   composes one by hand, and 016 D-10's per-run tsconfig probe is gone.
//
// Every filesystem read here is read-only, and every one of them happens at
// write time (a registration, a requalification, B-8's migration), never
// inside a fold: 025's fold is a pure function of the chain, and a fold that
// reached into a tree would make one history fold two ways on two machines
// (D-2).
import * as fs from "fs";
import { join } from "path";
import type { JsonValue } from "./journal";

// --- the model (B-1) --------------------------------------------------------

// Who set a contract. Spec 025's three control surfaces, plus the one author
// that is not a surface at all: the probe, which is what registration and
// B-8's migration record themselves as.
export const GATE_SOURCES = ["probe", "cli", "api", "ui"] as const;

export type GateSource = (typeof GATE_SOURCES)[number];

export function isGateSource(value: string): value is GateSource {
  return (GATE_SOURCES as readonly string[]).includes(value);
}

// Which B-2 rule produced a probed contract. Journaled with the commands, so
// an empty gate can say "python, no declared gate" rather than
// "governance-only" with no reason (D-4).
export const GATE_PROBE_RULES = ["make-ci", "typescript", "rust", "go", "python", "none"] as const;

export type GateProbeRule = (typeof GATE_PROBE_RULES)[number];

export function isGateProbeRule(value: string): value is GateProbeRule {
  return (GATE_PROBE_RULES as readonly string[]).includes(value);
}

export interface GateContract {
  // Run in the target's root after the universal governance floor, in order,
  // each required to exit 0. Empty means governance-only.
  readonly commands: readonly (readonly string[])[];
  readonly source: GateSource;
  // The rule that produced these commands, on a probed contract; null on an
  // operator-set one, which answers to no rule table.
  readonly rule: GateProbeRule | null;
}

// A contract as read back off the projects chain. `legacy` is the honest
// difference between an empty gate somebody chose and one nobody ever spoke
// about (B-3); `source` is null in exactly that case, because a record that
// does not exist has no author. Derived by the fold, never journaled, so it
// can only ever describe pre-041 history.
export interface RecordedGateContract extends Omit<GateContract, "source"> {
  readonly source: GateSource | null;
  readonly legacy: boolean;
}

// Anything a stage can be judged under: a contract straight off a write verb,
// or one folded back off the chain.
export type AnyGateContract = GateContract | RecordedGateContract;

// What a chain with no gate record folds to (B-3). Weaker than 016 D-10's
// live probe on purpose: a pre-041 registration carries nothing to
// reconstruct a language gate from, so the honest fold is governance-only and
// every surface says `legacy`. B-8 closes that window by writing the missing
// record; the fold does not, because a fold may not touch the tree (D-2).
export const LEGACY_GATE_CONTRACT: RecordedGateContract = {
  commands: [],
  source: null,
  rule: null,
  legacy: true,
};

// --- threading a contract to a stage (B-4) ----------------------------------

// What a stage is handed: the owning project's contract, or a late-bound read
// of it. The daemon passes a reader for the reason 032 B-4 passes one for the
// profile: its per-project seams are built once and reused for the process's
// life, while a gate can be set at any moment through a control surface, and
// a gate an operator corrected that quietly does not apply until the daemon
// restarts is the failure this seam exists to prevent.
export type GateBinding = AnyGateContract | (() => AnyGateContract);

export function resolveGateBinding(binding: GateBinding | undefined): AnyGateContract {
  if (binding === undefined) return LEGACY_GATE_CONTRACT;
  return typeof binding === "function" ? binding() : binding;
}

// --- the one derivation (B-4) -----------------------------------------------

// The universal governance floor: spec 016's four spec-spine commands, in
// 016's order, unchanged and out of this spec's scope. The two Bun commands
// 016 carried here are this repo's own language gate and now reach the suite
// through claude-observatory's own contract, probed by rule 2, like every
// other target's.
export const GATE_COMMANDS: readonly (readonly string[])[] = [
  ["spec-spine", "compile"],
  ["spec-spine", "index", "check"],
  ["spec-spine", "lint", "--fail-on-warn"],
  ["spec-spine", "couple", "--base", "origin/main", "--head", "HEAD"],
];

// The gate list a stage runs: the floor, then the contract's commands
// verbatim. The only source of that list anywhere in this codebase (B-4);
// the preflight's "gate green at base" (016 B-1), the post-session evidence
// (016 B-5), and shepherd's remediation prompt all consume this output.
export function gateSuiteFor(contract: AnyGateContract): readonly (readonly string[])[] {
  return [...GATE_COMMANDS, ...contract.commands.map((cmd) => [...cmd])];
}

// --- the probe (B-2) --------------------------------------------------------

export interface GateProbeResult {
  readonly rule: GateProbeRule;
  readonly commands: readonly (readonly string[])[];
}

// D-3: `cargo` and `go` are the toolchain rather than a package choice, so
// fmt, clippy and vet are present wherever the manifest is, and this family
// already treats them as gate conditions. A generous guess is affordable
// because a wrong one is caught before it can drive anything: 016 B-1 refuses
// to start a build when the gate is not green at the base commit, and B-7 is
// the operator's one-line correction.
const RUST_GATE: readonly (readonly string[])[] = [
  ["cargo", "fmt", "--all", "--check"],
  ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
  ["cargo", "test", "--workspace", "--locked"],
];

const GO_GATE: readonly (readonly string[])[] = [
  ["go", "build", "./..."],
  ["go", "vet", "./..."],
  ["go", "test", "./..."],
];

const TYPESCRIPT_GATE: readonly (readonly string[])[] = [
  ["bun", "run", "typecheck"],
  ["bun", "test"],
];

const MAKE_CI_GATE: readonly (readonly string[])[] = [["make", "ci"]];

// A `ci` rule at the start of a line, single- or double-colon, and none of
// make's colon-flavored assignments (`ci :=`, `ci ::=`, `ci :::=`), which
// would otherwise read as one. `.PHONY: ci` does not start with `ci`, so it
// never matches: a repo that only declares the target phony without defining
// it has not published a gate.
const MAKE_CI_TARGET = /^ci[ \t]*:(?!:*=)/m;

// A declared Python tool table, per D-4. `[tool.ruff]` and `[tool.ruff.lint]`
// both count; `[tool.ruffian]` does not.
function declaresTomlTable(text: string, table: string): boolean {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[${escaped}(\\.[^\\]]+)?\\]`, "m").test(text);
}

function readIfPresent(repoDir: string, name: string): string | null {
  try {
    return fs.readFileSync(join(repoDir, name), "utf8");
  } catch {
    return null;
  }
}

function exists(repoDir: string, name: string): boolean {
  try {
    return fs.statSync(join(repoDir, name)).isFile();
  } catch {
    return false;
  }
}

// The B-2 rule table, tried in order, first match wins. Read-only: it opens
// four files at most and writes nothing, so probing a target is safe at any
// moment, including against a repoDir that does not exist yet (which is a
// legal registration: it qualifies as unqualified).
//
// D-1: `make ci` outranks every language rule. A repo that publishes a `ci`
// target has stated its gate in one place for humans, CI, and the
// orchestrator alike; guessing a language command under it would create a
// second, weaker definition of green.
export function probeGate(repoDir: string): GateProbeResult {
  const makefile = readIfPresent(repoDir, "Makefile");
  if (makefile !== null && MAKE_CI_TARGET.test(makefile)) {
    return { rule: "make-ci", commands: MAKE_CI_GATE };
  }
  if (exists(repoDir, "tsconfig.json")) return { rule: "typescript", commands: TYPESCRIPT_GATE };
  if (exists(repoDir, "Cargo.toml")) return { rule: "rust", commands: RUST_GATE };
  if (exists(repoDir, "go.mod")) return { rule: "go", commands: GO_GATE };

  // D-4: Python is probed by declaration, not by inference. `pyproject.toml`
  // implies no test runner and no linter, and guessing `pytest` where it is
  // not installed is exit 127, which is indistinguishable at the gate from a
  // real failure. So this reads what the file declares and emits only that;
  // a target declaring neither yields an empty list with the rule recorded,
  // so the surfaces say "python, no declared gate".
  const pyproject = readIfPresent(repoDir, "pyproject.toml");
  if (pyproject !== null) {
    const commands: string[][] = [];
    if (declaresTomlTable(pyproject, "tool.ruff")) commands.push(["ruff", "check", "."]);
    if (declaresTomlTable(pyproject, "tool.pytest.ini_options")) commands.push(["pytest"]);
    return { rule: "python", commands };
  }

  return { rule: "none", commands: [] };
}

// The probe as a recordable contract: what registration, requalification and
// B-8's migration append.
export function probeGateContract(repoDir: string): GateContract {
  const probed = probeGate(repoDir);
  return { commands: probed.commands, source: "probe", rule: probed.rule };
}

// --- write-verb validation (B-7) --------------------------------------------

// What a control surface refuses before appending: an argv array that could
// never be executed. An override that drops a command the probe found is not
// refused, and is not meant to be (B-7: the orchestrator records the choice,
// it does not second-guess it). Returns null when the contract is recordable,
// the operator-facing reason when it is not.
export function gateRefusal(contract: AnyGateContract): string | null {
  for (const cmd of contract.commands) {
    if (cmd.length === 0) return "a gate command needs at least a program name; an empty argv array runs nothing";
    if (cmd.some((arg) => typeof arg !== "string")) return "a gate command is an array of strings";
    if (cmd[0]!.trim().length === 0) return "a gate command's program name cannot be blank";
  }
  return null;
}

// --- payload codec (B-2, B-5) -----------------------------------------------

// Flat rather than nested under a "gate" key: every record on the projects
// chain carries a top-level `source` naming who wrote it (025 B-2), and B-2,
// B-7 and B-8 each speak of "a `project.gate.set` record with source probe /
// cli / api". One field answers both, so there is no second source to
// disagree with the first.
export function gatePayload(contract: AnyGateContract): Record<string, JsonValue> {
  return {
    commands: contract.commands.map((cmd) => [...cmd]),
    source: contract.source,
    rule: contract.rule,
  };
}

// Reads a contract back out of a payload. A malformed one throws a typed
// error rather than degrading to a default: a gate that cannot be read is not
// a gate anything should be judged by.
export function parseGateContract(value: JsonValue | undefined, label: string): GateContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`gate: ${label} expected a JSON object`);
  }
  const o = value as Record<string, JsonValue>;

  const rawCommands = o.commands;
  if (!Array.isArray(rawCommands)) {
    throw new Error(`gate: ${label} expected an array field "commands"`);
  }
  const commands = rawCommands.map((raw) => {
    if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === "string")) {
      throw new Error(`gate: ${label} expected "commands" to hold argv arrays of strings`);
    }
    return raw as string[];
  });

  const source = o.source;
  if (typeof source !== "string" || !isGateSource(source)) {
    throw new Error(`gate: ${label} expected source one of ${GATE_SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
  }

  // A rule is optional in the payload only in the sense that null is a legal
  // value (an operator-set contract has none); a string that is not a known
  // rule is a malformed record, not a rule this reader has yet to learn.
  const rawRule = o.rule;
  let rule: GateProbeRule | null = null;
  if (typeof rawRule === "string") {
    if (!isGateProbeRule(rawRule)) {
      throw new Error(`gate: ${label} expected rule one of ${GATE_PROBE_RULES.join(", ")}, got ${JSON.stringify(rawRule)}`);
    }
    rule = rawRule;
  } else if (rawRule !== null && rawRule !== undefined) {
    throw new Error(`gate: ${label} expected a string-or-null field "rule"`);
  }

  return { commands, source, rule };
}

// Whether two contracts name the same program, in the same order (B-2's
// requalification test: a new record is appended only when the derived
// commands differ from the current fold).
export function sameGateCommands(a: AnyGateContract, b: AnyGateContract): boolean {
  if (a.commands.length !== b.commands.length) return false;
  return a.commands.every((cmd, i) => {
    const other = b.commands[i]!;
    return cmd.length === other.length && cmd.every((arg, j) => arg === other[j]);
  });
}

// --- rendering (B-6) --------------------------------------------------------

// The gate as one short cell, for every surface that names the project. A
// legacy-derived gate reads distinguishably from a probed or operator-set
// one, and no surface ever renders a blank: an absent contract is impossible
// by construction, because the fold always produces one.
export function renderGate(gate: RecordedGateContract): string {
  if (gate.legacy) return "governance-only (legacy)";
  if (gate.commands.length === 0) {
    return gate.rule === "python" ? "python, no declared gate" : "governance-only";
  }
  const first = gate.commands[0]!;
  // "make" alone says nothing; the whole `make ci` is the compact form B-6
  // names, and it is two words.
  if (first[0] === "make") return first.slice(0, 2).join(" ");
  // `?` rather than nothing for an argv array with no program name: the write
  // verbs refuse one, so only a hand-edited chain can produce it, and B-6's
  // "no surface ever renders a blank" has to hold even then.
  const programs = [...new Set(gate.commands.map((cmd) => cmd[0] ?? "?"))];
  return programs.join("+");
}

// The gate spelled out, for the detail surfaces: one line per command, plus
// where the list came from, because a gate is a thing you check item by item
// and "cargo" is a summary.
export function renderGateDetail(gate: RecordedGateContract): string[] {
  const lines = [`gate:    ${renderGate(gate)}`];
  if (gate.legacy) {
    lines.push("         no gate record on the chain; only the spec-spine floor runs (pre-041 default)");
    return lines;
  }
  const origin = gate.rule === null ? `set by ${gate.source}` : `probed (${gate.rule}), source ${gate.source}`;
  lines.push(`         ${origin}`);
  if (gate.commands.length === 0) {
    lines.push("         no commands beyond the spec-spine floor");
    return lines;
  }
  for (const cmd of gate.commands) lines.push(`         ${cmd.join(" ")}`);
  return lines;
}
