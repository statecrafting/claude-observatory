// Spec 035: corpus synthesis. Given a preflight proposal (034) the operator
// chose to synthesize, driven sessions author a spec-spine corpus for the
// target on a feature branch: the scaffold, then one draft spec per proposed
// territory. Every rule that matters is enforced by code after each session
// (the diff confinement, the draft-born shape), never merely requested by
// prompt text (B-2, B-3). The corpus-shape vocabulary itself is spec 037's
// territory and arrives through an injected checker seam; this module owns
// the confinement set, the prompts, the session bracketing, and the report.

import * as fs from "fs";
import { join } from "path";
import type { JournalHandle, JsonValue } from "../journal";
import type { SessionResult } from "../session";
import { evaluateBudget, type CeilingScope, type CostCeiling } from "../budget";
import { proposalHash } from "./preflight";

// --- the corpus set (B-2, D-2) ----------------------------------------------

// What a synthesis session may touch, as exported, reviewable data rather
// than an opinion inside a prompt (D-2). The set mirrors what `spec-spine
// init` actually scaffolds plus D-3's committed derived artifacts: the specs
// directory, the config, the standards seeds, the rule seeds init writes
// under .claude/rules, and .derived. Everything else in the target is source
// or tests, and touching it is the failure mode B-3 exists to catch.
export interface CorpusPathRule {
  readonly kind: "dir" | "file";
  readonly path: string;
}

export const CORPUS_SET: readonly CorpusPathRule[] = [
  { kind: "dir", path: "specs" },
  { kind: "file", path: "spec-spine.toml" },
  { kind: "dir", path: "standards" },
  { kind: "dir", path: ".derived" },
  { kind: "dir", path: ".claude/rules" },
  // The two ignores every governed target needs (found live twice: the
  // orchestrator's own state root under data/, and compile's
  // non-deterministic build-meta.json) live in the root .gitignore, so that
  // one file is corpus; the scaffold prompt bounds what goes into it.
  { kind: "file", path: ".gitignore" },
];

function ruleCovers(rule: CorpusPathRule, path: string): boolean {
  if (rule.kind === "file") return path === rule.path;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

// FR-002: pure over (changed paths, corpus set). Returns every offending
// path, sorted, so a violating session is reported whole rather than
// first-failure-only.
export function confinementViolations(
  changedPaths: readonly string[],
  corpusSet: readonly CorpusPathRule[] = CORPUS_SET
): readonly string[] {
  return [...changedPaths].filter((path) => !corpusSet.some((rule) => ruleCovers(rule, path))).sort();
}

// --- reading the proposal back (B-1) ----------------------------------------

// The synthesis input is 034's rendered proposal document, resolved by path
// or by content hash and re-parsed here. The document is deterministic markdown
// (034 FR-003), so the parse targets exactly renderProposal's shape; anything
// that does not parse refuses with the reason named rather than guessing at
// territories the operator never saw.
export interface ParsedTerritory {
  readonly index: number;
  readonly label: string;
  readonly files: readonly string[];
}

export interface ParsedProposal {
  readonly target: string;
  readonly headSha: string | null;
  readonly territories: readonly ParsedTerritory[];
  readonly remainder: readonly string[];
}

export function parseProposalDocument(document: string): ParsedProposal | string {
  const lines = document.split("\n");
  const title = lines[0] ?? "";
  const titleMatch = /^# Adoption preflight: (.+)$/.exec(title);
  if (!titleMatch) return "not a preflight proposal: the first line does not name a target (034 FR-003 shape)";
  const target = titleMatch[1]!;

  const headLine = lines.find((line) => line.startsWith("- head: "));
  const headRaw = headLine ? headLine.slice("- head: ".length) : null;
  const headSha = headRaw === null || headRaw === "(no commits)" ? null : headRaw;

  const territories: ParsedTerritory[] = [];
  const remainder: string[] = [];
  let inCandidates = false;
  let inRemainder = false;
  let current: { index: number; label: string; files: string[] } | null = null;
  let collecting: "files" | "commits" | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) territories.push(current);
      current = null;
      collecting = null;
      inCandidates = line === "## Candidate territories";
      inRemainder = line === "## Ungoverned remainder";
      continue;
    }
    if (inCandidates) {
      const heading = /^### (\d+)\. (.+) \(\d+ files?, [^)]+\)$/.exec(line);
      if (heading) {
        if (current) territories.push(current);
        current = { index: Number(heading[1]!), label: heading[2]!, files: [] };
        collecting = null;
        continue;
      }
      if (current && line === "files:") {
        collecting = "files";
        continue;
      }
      if (current && line === "sample commits:") {
        collecting = "commits";
        continue;
      }
      if (current && collecting === "files" && line.startsWith("- ")) {
        current.files.push(line.slice(2));
        continue;
      }
      if (line === "") collecting = collecting === "files" ? null : collecting;
      continue;
    }
    if (inRemainder) {
      const entry = /^- (.+) \(touched \d+x\)$/.exec(line);
      if (entry) remainder.push(entry[1]!);
    }
  }
  if (current) territories.push(current);

  if (territories.length === 0) {
    return "the proposal holds no candidate territories: nothing to synthesize (run adopt preflight against a target with more history, or author the corpus by hand)";
  }
  for (const territory of territories) {
    if (territory.files.length === 0) {
      return `territory ${territory.index} (${territory.label}) lists no files: the proposal does not parse as 034 FR-003 markdown`;
    }
  }
  return { target, headSha, territories, remainder };
}

// --- spec ids and prompts (FR-001) ------------------------------------------

// 001..NNN in the proposal's own churn-rank order; 000 stays the bootstrap
// spec the scaffold session customizes. The slug is the territory label
// (its common directory) flattened to spec-spine's directory-name charset.
export function territorySpecId(index: number, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${String(index).padStart(3, "0")}-${slug.length > 0 ? slug : "territory"}`;
}

// The retroactive posture, restated verbatim in every prompt (FR-001). These
// sentences are the prompt-side face of spec 037's corpus shape; the checker
// that enforces them mechanically is 037's module, injected below.
export const RETROACTIVE_RULES = [
  "This is a retroactive adoption: record what the code does, never what it should do.",
  "Every spec you author must carry `origin.retroactive: true` in frontmatter.",
  "Every spec you author must carry `status: draft`. Never write `status: approved`: ratification is a human act that happens later, in the target, after reading.",
  "Every spec you author must contain a `## Known defects` section, present even when empty: an empty section is the recorded claim \"none found during adoption\".",
  "If you find a bug, do not fix it. Record it as a Known defects entry naming the observed behavior, the expectation it violates, and the evidence.",
  "Acceptance criteria assert currently observable behavior only (commands that exit zero today, outputs the code produces today). Desired-but-absent behavior belongs in Known defects, not in acceptance criteria.",
  "Touch only the corpus: the specs directory, spec-spine.toml, standards/, .claude/rules/, and .derived/. Any edit to the target's source or tests fails this session.",
] as const;

function rulesBlock(): string {
  return RETROACTIVE_RULES.map((rule) => `- ${rule}`).join("\n");
}

// Pure over the parsed proposal (FR-001): same proposal, same prompt.
export function scaffoldPrompt(proposal: ParsedProposal): string {
  return [
    `You are initializing a spec-spine corpus for the repository at ${proposal.target}, adopting it retroactively.`,
    "",
    "Steps:",
    "1. Run `spec-spine init` at the repository root (it writes spec-spine.toml, standards seeds, specs/000-bootstrap/spec.md, and .claude/rules seeds; skip files that already exist).",
    "2. Ensure the repository's .gitignore carries a `/data/` line (the build orchestrator's state root) and a `.derived/**/build-meta.json` line (non-deterministic build metadata); append whichever is missing. These two lines are the only edit you may make to .gitignore.",
    "3. Customize specs/000-bootstrap/spec.md: name this repository, set `status: draft` (the init template says approved; flip it), keep `origin.retroactive: true`, and add a `## Known defects` section (empty is fine).",
    "4. Run `spec-spine compile` and `spec-spine lint` and fix any diagnostics they report, editing only corpus files.",
    "",
    "Rules:",
    rulesBlock(),
    "",
    "Do not author territory specs yet: later sessions do that one territory at a time.",
  ].join("\n");
}

// Pure over (proposal, territory) (FR-001): the prompt carries the territory's
// full file list, the retroactive posture, and the draft-status requirement.
export function territoryPrompt(proposal: ParsedProposal, territory: ParsedTerritory, specId: string): string {
  return [
    `You are authoring one spec of a retroactive spec-spine corpus for the repository at ${proposal.target}.`,
    "",
    `Author exactly one spec: specs/${specId}/spec.md, covering this territory (files that ship together in the target's own history):`,
    "",
    ...territory.files.map((file) => `- ${file}`),
    "",
    "Requirements:",
    `- Frontmatter: id "${specId}", a real title, \`status: draft\`, \`origin.retroactive: true\`, and \`establishes\` edges enumerating every territory file listed above.`,
    "- Body: describe what this code observably does today, section by section, with a `## Known defects` section (present even when empty).",
    "- Read the territory's files before writing; every claim in the spec must be checkable against them.",
    "- Run `spec-spine compile` and `spec-spine lint` before finishing and fix any diagnostics, editing only corpus files.",
    "",
    "Rules:",
    rulesBlock(),
  ].join("\n");
}

// --- the draft-born guard (B-3) ---------------------------------------------

export interface AuthoredSpecFile {
  readonly path: string;
  readonly content: string;
}

export interface ShapeViolation {
  readonly path: string;
  readonly reason: string;
}

// Spec 037's checker seam (FR-002 there): synthesis invokes it after every
// session once 037 ships, in addition to the B-3 minimum below. The input is
// everything a shape rule could need; the strings come back journal-stable.
export type CorpusShapeChecker = (input: {
  readonly specs: readonly AuthoredSpecFile[];
  readonly changedPaths: readonly string[];
  readonly corpusSet: readonly CorpusPathRule[];
}) => readonly ShapeViolation[];

function frontmatterOf(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? null : content.slice(4, end + 1);
}

// B-3's own minimum, independent of 037: draft status and the retroactive
// marker, checked mechanically on every authored spec file. Violations are
// per spec and all at once.
export function draftShapeViolations(specs: readonly AuthoredSpecFile[]): readonly ShapeViolation[] {
  const violations: ShapeViolation[] = [];
  for (const spec of specs) {
    const frontmatter = frontmatterOf(spec.content);
    if (frontmatter === null) {
      violations.push({ path: spec.path, reason: "no frontmatter block" });
      continue;
    }
    const status = /^status:\s*"?([A-Za-z-]+)"?\s*$/m.exec(frontmatter)?.[1] ?? null;
    if (status !== "draft") {
      violations.push({
        path: spec.path,
        reason: status === null ? "frontmatter carries no status" : `status is "${status}", synthesized specs are born draft (B-3)`,
      });
    }
    if (!/retroactive:\s*true/.test(frontmatter)) {
      violations.push({ path: spec.path, reason: "frontmatter does not carry origin.retroactive: true (B-3)" });
    }
  }
  return violations;
}

// The territory spec must claim its whole file list (B-3: real establishes
// edges enumerating the territory's files). Extra claims are not flagged
// here; the B-5 report is where over- and under-claiming becomes visible.
export function establishesViolations(spec: AuthoredSpecFile, territoryFiles: readonly string[]): readonly ShapeViolation[] {
  const frontmatter = frontmatterOf(spec.content) ?? "";
  const missing = territoryFiles.filter((file) => !frontmatter.includes(file));
  if (missing.length === 0) return [];
  return [
    {
      path: spec.path,
      reason: `establishes does not enumerate the territory's files: missing ${missing.join(", ")}`,
    },
  ];
}

// What the authored specs claim, for the B-5 report: every path that appears
// in an establishes edge of any spec file on the branch. A structural read
// (path strings), not a compile: the compile gate has its own step.
export function claimedPaths(specs: readonly AuthoredSpecFile[]): ReadonlyMap<string, readonly string[]> {
  const bySpec = new Map<string, readonly string[]>();
  for (const spec of specs) {
    const frontmatter = frontmatterOf(spec.content) ?? "";
    const claims: string[] = [];
    for (const match of frontmatter.matchAll(/path:\s*"([^"]+)"/g)) claims.push(match[1]!);
    for (const match of frontmatter.matchAll(/^\s+-\s+"([^"]+)"\s*$/gm)) claims.push(match[1]!);
    bySpec.set(spec.path, [...new Set(claims)].sort());
  }
  return bySpec;
}

// --- seams (B-2) -------------------------------------------------------------

export interface SynthesisSessionRequest {
  // "scaffold", or the territory's spec id: what this session exists to write.
  readonly purpose: string;
  readonly prompt: string;
}

export type SynthesisSessionFn = (request: SynthesisSessionRequest) => Promise<SessionResult>;

export interface SynthesisGit {
  statusClean(): boolean;
  currentBranch(): string | null;
  headSha(): string | null;
  createBranch(name: string): void;
  // Committed plus staged plus untracked, relative to `sha`: the whole delta
  // a session left, however it chose to leave it.
  changedPathsSince(sha: string): readonly string[];
  // Stage everything and commit; the caller only asks after the guard passed,
  // so what lands is corpus by construction (D-5).
  commitAll(message: string): void;
  // Return the tree to `sha` exactly, untracked files included: a violating
  // session's writes must not poison the next session's delta (D-5).
  discardTo(sha: string): void;
  readSpecFiles(): readonly AuthoredSpecFile[];
}

export interface SynthesisGateResult {
  readonly exitCode: number;
  readonly outputTail: string;
}

export type SynthesisGateFn = (args: readonly string[]) => SynthesisGateResult;

// --- process-backed seams (production wiring; tests inject their own) --------

function spawnGit(repoDir: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd: repoDir });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function gitLines(repoDir: string, args: readonly string[]): readonly string[] {
  const result = spawnGit(repoDir, args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

export function createProcessSynthesisGit(repoDir: string): SynthesisGit {
  return {
    statusClean: () => gitLines(repoDir, ["status", "--porcelain"]).length === 0,
    currentBranch: () => {
      const result = spawnGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
    headSha: () => {
      const result = spawnGit(repoDir, ["rev-parse", "HEAD"]);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
    createBranch: (name) => {
      const result = spawnGit(repoDir, ["checkout", "-b", name]);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git checkout -b exited ${result.exitCode}`);
    },
    changedPathsSince: (sha) => {
      const tracked = gitLines(repoDir, ["diff", "--name-only", sha]);
      const untracked = gitLines(repoDir, ["ls-files", "--others", "--exclude-standard"]);
      return [...new Set([...tracked, ...untracked])].sort();
    },
    commitAll: (message) => {
      const add = spawnGit(repoDir, ["add", "-A"]);
      if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "git add -A failed");
      const commit = spawnGit(repoDir, ["commit", "-qm", message]);
      if (commit.exitCode !== 0) throw new Error(commit.stderr.trim() || "git commit failed");
    },
    discardTo: (sha) => {
      const reset = spawnGit(repoDir, ["reset", "--hard", "-q", sha]);
      if (reset.exitCode !== 0) throw new Error(reset.stderr.trim() || "git reset --hard failed");
      const clean = spawnGit(repoDir, ["clean", "-fdq"]);
      if (clean.exitCode !== 0) throw new Error(clean.stderr.trim() || "git clean failed");
    },
    readSpecFiles: () => {
      const specsDir = join(repoDir, "specs");
      let entries: string[];
      try {
        entries = fs.readdirSync(specsDir);
      } catch {
        return [];
      }
      const specs: AuthoredSpecFile[] = [];
      for (const entry of entries.sort()) {
        const specPath = join(specsDir, entry, "spec.md");
        try {
          specs.push({ path: `specs/${entry}/spec.md`, content: fs.readFileSync(specPath, "utf8") });
        } catch {
          // a directory without spec.md is the compile gate's diagnostic, not ours
        }
      }
      return specs;
    },
  };
}

const GATE_TAIL_BYTES = 4 * 1024;

export function createProcessSynthesisGate(repoDir: string): SynthesisGateFn {
  return (args) => {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync(["spec-spine", ...args, "--repo", repoDir]);
    } catch (err) {
      return { exitCode: 127, outputTail: `spec-spine could not be spawned: ${(err as Error).message}` };
    }
    const text = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`.trim();
    return { exitCode: result.exitCode, outputTail: text.slice(-GATE_TAIL_BYTES) };
  };
}

// --- the run (B-2, B-4, B-5) -------------------------------------------------

export const SYNTHESIS_KINDS = {
  started: "adopt.synthesis.started",
  session: "adopt.synthesis.session",
  violation: "adopt.synthesis.violation",
  result: "adopt.synthesis",
} as const;

export interface SynthesisTerritoryReport {
  readonly specId: string;
  readonly label: string;
  readonly files: readonly string[];
  readonly outcome: "authored" | "session-failed" | "guard-failed" | "not-run";
  readonly detail: string | null;
}

export interface SynthesisSessionReport {
  readonly purpose: string;
  readonly classification: string;
  readonly costMicroUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number;
}

export interface SynthesisReport {
  readonly project: string;
  readonly branch: string | null;
  readonly proposalHash: string;
  readonly outcome: "completed" | "failed";
  readonly failure: string | null;
  readonly territories: readonly SynthesisTerritoryReport[];
  readonly claimed: ReadonlyMap<string, readonly string[]>;
  // Proposal files no authored spec claims, carried forward explicitly (B-5:
  // never silently absorbed).
  readonly unclaimed: readonly string[];
  readonly sessions: readonly SynthesisSessionReport[];
  readonly gate: { readonly compile: SynthesisGateResult | null; readonly lint: SynthesisGateResult | null };
}

export interface SynthesisParams {
  readonly projectName: string;
  readonly proposalDocument: string;
  readonly journal: JournalHandle;
  readonly session: SynthesisSessionFn;
  readonly git: SynthesisGit;
  readonly gate: SynthesisGateFn;
  readonly clock: { now(): number };
  readonly source: string;
  readonly ceiling: CostCeiling | null;
  readonly shapeChecker?: CorpusShapeChecker;
  readonly branchName?: string;
}

// The branch carries its provenance: a re-synthesis from an amended proposal
// lands on a different branch by construction (D-8).
export function synthesisBranchName(hash: string): string {
  return `corpus/synthesis-${hash.slice(0, 12)}`;
}

interface SessionOutcome {
  readonly ok: boolean;
  readonly kind: "authored" | "ceiling" | "session" | "guard";
  readonly detail: string | null;
}

export async function runSynthesis(params: SynthesisParams): Promise<SynthesisReport> {
  const hash = proposalHash(params.proposalDocument);
  const sessions: SynthesisSessionReport[] = [];
  const journal = params.journal;

  const failed = (failure: string, territories: readonly SynthesisTerritoryReport[], branch: string | null, gate: SynthesisReport["gate"] = { compile: null, lint: null }): SynthesisReport => {
    const report: SynthesisReport = {
      project: params.projectName,
      branch,
      proposalHash: hash,
      outcome: "failed",
      failure,
      territories,
      claimed: new Map(),
      unclaimed: [],
      sessions,
      gate,
    };
    journal.append(SYNTHESIS_KINDS.result, resultPayload(report));
    return report;
  };

  const parsed = parseProposalDocument(params.proposalDocument);
  if (typeof parsed === "string") return failed(parsed, [], null);

  const pending: SynthesisTerritoryReport[] = parsed.territories.map((territory) => ({
    specId: territorySpecId(territory.index, territory.label),
    label: territory.label,
    files: territory.files,
    outcome: "not-run",
    detail: null,
  }));

  // The same dirty-tree stance the build stage takes: a tree with unrelated
  // edits cannot be bracketed, so it refuses rather than absorbing them. The
  // hint names the one dirt every adoptable target grows on first contact
  // (found live 2026-08-05: the orchestrator's own state root under data/).
  if (!params.git.statusClean()) {
    return failed(
      "the target's working tree is dirty; synthesis brackets every session by diff and cannot start over unrelated edits (a target that does not gitignore /data/ is permanently dirty from the orchestrator's own state root)",
      pending,
      null
    );
  }
  const baseSha = params.git.headSha();
  if (baseSha === null) return failed("the target has no readable HEAD; synthesis needs a commit to branch from", pending, null);

  const branch = params.branchName ?? synthesisBranchName(hash);
  try {
    params.git.createBranch(branch);
  } catch (err) {
    return failed(`could not create branch ${branch}: ${(err as Error).message}`, pending, null);
  }

  journal.append(SYNTHESIS_KINDS.started, {
    project: params.projectName,
    proposalHash: hash,
    branch,
    baseSha,
    territories: pending.map((t) => t.specId) as unknown as JsonValue,
    source: params.source,
  });

  // 033's ceilings apply unchanged (B-2): the day scope folds this project's
  // journal exactly as a driven run would; the run scope reads as this
  // invocation, floored on its own journaled session costs (D-7). Checked at
  // spawn boundaries, so overshoot stays 033's one-session bound.
  const ceilingTrip = (): { scope: CeilingScope; floorMicroUsd: number } | null => {
    const ceiling = params.ceiling;
    if (ceiling === null) return null;
    const invocationFloor = sessions.reduce((sum, s) => sum + (s.costMicroUsd ?? 0), 0);
    if (ceiling.perRunMicroUsd !== undefined && invocationFloor > ceiling.perRunMicroUsd) {
      return { scope: "run", floorMicroUsd: invocationFloor };
    }
    if (ceiling.perDayMicroUsd !== undefined) {
      const evaluation = evaluateBudget({
        records: journal.fold().records,
        ceiling: { perDayMicroUsd: ceiling.perDayMicroUsd },
        nowMs: params.clock.now(),
      });
      if (evaluation.over === "day") return { scope: "day", floorMicroUsd: evaluation.spend.day.knownMicroUsd };
    }
    return null;
  };

  let pinnedSha = baseSha;
  const runOne = async (purpose: string, prompt: string, territoryFiles: readonly string[] | null): Promise<SessionOutcome> => {
    const trip = ceilingTrip();
    if (trip !== null) {
      const detail = `cost ceiling (${trip.scope}): known spend ${trip.floorMicroUsd} microUSD is over the configured ceiling; no further session spawns (033 B-2)`;
      journal.append(SYNTHESIS_KINDS.violation, { purpose, violations: [detail] as unknown as JsonValue });
      return { ok: false, kind: "ceiling", detail };
    }

    let result: SessionResult;
    try {
      result = await params.session({ purpose, prompt });
    } catch (err) {
      const detail = `session error: ${(err as Error).message}`;
      journal.append(SYNTHESIS_KINDS.session, { purpose, classification: "crashed", detail });
      return { ok: false, kind: "session", detail };
    }
    const kind = result.classification.kind;
    const sessionReport: SynthesisSessionReport = {
      purpose,
      classification: kind,
      costMicroUsd: result.costMicroUsd,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
    };
    sessions.push(sessionReport);
    journal.append(SYNTHESIS_KINDS.session, {
      purpose,
      classification: kind,
      detail: result.classification.detail,
      sessionId: result.sessionId,
      costMicroUsd: result.costMicroUsd,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
    });
    if (kind !== "completed") {
      params.git.discardTo(pinnedSha);
      return { ok: false, kind: "session", detail: `session ${kind}: ${result.classification.detail}` };
    }

    const delta = params.git.changedPathsSince(pinnedSha);
    const offending = confinementViolations(delta);
    const specFiles = params.git.readSpecFiles();
    const shape: ShapeViolation[] = [...draftShapeViolations(specFiles)];
    if (territoryFiles !== null) {
      const specFile = specFiles.find((spec) => spec.path.includes(`/${purpose}/`)) ?? null;
      if (specFile === null) {
        shape.push({ path: `specs/${purpose}/spec.md`, reason: "the session did not author this territory's spec file" });
      } else {
        shape.push(...establishesViolations(specFile, territoryFiles));
      }
    }
    if (params.shapeChecker) {
      shape.push(...params.shapeChecker({ specs: specFiles, changedPaths: delta, corpusSet: CORPUS_SET }));
    }

    if (offending.length > 0 || shape.length > 0) {
      const violations = [
        ...offending.map((path) => `outside the corpus set: ${path}`),
        ...shape.map((violation) => `${violation.path}: ${violation.reason}`),
      ];
      journal.append(SYNTHESIS_KINDS.violation, { purpose, violations: violations as unknown as JsonValue });
      params.git.discardTo(pinnedSha);
      return { ok: false, kind: "guard", detail: violations.join("; ") };
    }

    if (delta.length > 0) {
      params.git.commitAll(`synthesis: ${purpose}`);
      const head = params.git.headSha();
      if (head !== null) pinnedSha = head;
    }
    return { ok: true, kind: "authored", detail: null };
  };

  // The scaffold session first (B-2), then one session per territory in the
  // proposal's own order, serially (D-1). A failed territory is recorded and
  // the rest still run: each retries alone, and the report below refuses to
  // call any partial result a success (D-6, B-4).
  const scaffold = await runOne("scaffold", scaffoldPrompt(parsed), null);
  if (!scaffold.ok) {
    return failed(`scaffold session failed: ${scaffold.detail}`, pending, branch);
  }

  const territories: SynthesisTerritoryReport[] = [];
  for (const [position, territory] of parsed.territories.entries()) {
    const specId = pending[position]!.specId;
    const outcome = await runOne(specId, territoryPrompt(parsed, territory, specId), territory.files);
    territories.push({
      specId,
      label: territory.label,
      files: territory.files,
      outcome: outcome.kind === "authored" ? "authored" : outcome.kind === "session" ? "session-failed" : outcome.kind === "guard" ? "guard-failed" : "not-run",
      detail: outcome.detail,
    });
  }

  // B-4: compile-clean or say why. The gate runs inside the target, and its
  // derived artifacts are corpus (D-3), committed as the closing move.
  const compile = params.gate(["compile"]);
  const lint = compile.exitCode === 0 ? params.gate(["lint"]) : null;
  const gate = { compile, lint };
  if (compile.exitCode !== 0 || (lint !== null && lint.exitCode !== 0)) {
    const which = compile.exitCode !== 0 ? "compile" : "lint";
    const tail = compile.exitCode !== 0 ? compile.outputTail : lint!.outputTail;
    return failed(`the synthesized corpus does not pass spec-spine ${which}: ${tail}`, territories, branch, gate);
  }
  const derivedDelta = params.git.changedPathsSince(pinnedSha);
  if (derivedDelta.length > 0) params.git.commitAll("synthesis: derived artifacts");

  const specFiles = params.git.readSpecFiles();
  const claimed = claimedPaths(specFiles);
  const claimedAll = new Set([...claimed.values()].flat());
  const proposalFiles = parsed.territories.flatMap((territory) => territory.files);
  const unclaimed = [...new Set([...proposalFiles.filter((file) => !claimedAll.has(file)), ...parsed.remainder])].sort();

  const everyTerritoryAuthored = territories.every((territory) => territory.outcome === "authored");
  const report: SynthesisReport = {
    project: params.projectName,
    branch,
    proposalHash: hash,
    outcome: everyTerritoryAuthored ? "completed" : "failed",
    failure: everyTerritoryAuthored ? null : "one or more territories were not authored; the branch carries what passed, and this is not a success (B-4)",
    territories,
    claimed,
    unclaimed,
    sessions,
    gate,
  };
  journal.append(SYNTHESIS_KINDS.result, resultPayload(report));
  return report;
}

function resultPayload(report: SynthesisReport): Record<string, JsonValue> {
  return {
    project: report.project,
    branch: report.branch,
    proposalHash: report.proposalHash,
    outcome: report.outcome,
    failure: report.failure,
    territories: report.territories.map((territory) => ({
      specId: territory.specId,
      outcome: territory.outcome,
      detail: territory.detail,
      files: territory.files.length,
    })) as unknown as JsonValue,
    unclaimed: report.unclaimed as unknown as JsonValue,
    sessions: report.sessions.map((session) => ({
      purpose: session.purpose,
      classification: session.classification,
      costMicroUsd: session.costMicroUsd,
      numTurns: session.numTurns,
      durationMs: session.durationMs,
    })) as unknown as JsonValue,
  };
}

// --- the report, rendered (B-5) ----------------------------------------------

export function renderSynthesisReport(report: SynthesisReport): readonly string[] {
  const lines: string[] = [];
  lines.push(`synthesis: ${report.outcome}${report.failure === null ? "" : `: ${report.failure}`}`);
  lines.push(`proposal: sha256 ${report.proposalHash}`);
  lines.push(`branch:   ${report.branch ?? "(none created)"}`);
  lines.push(`territories: ${report.territories.length}`);
  for (const territory of report.territories) {
    const claims = report.claimed.get(`specs/${territory.specId}/spec.md`);
    const claimsCell = claims === undefined ? `${territory.files.length} proposed` : `${claims.length} claimed`;
    lines.push(`  ${territory.specId}  ${territory.outcome}  ${claimsCell}${territory.detail === null ? "" : `  (${territory.detail})`}`);
  }
  if (report.unclaimed.length === 0) {
    lines.push("unclaimed: none");
  } else {
    lines.push(`unclaimed: ${report.unclaimed.length} path(s) no authored spec claims (carried forward, never absorbed)`);
    for (const path of report.unclaimed) lines.push(`  - ${path}`);
  }
  const spent = report.sessions.reduce((sum, session) => sum + (session.costMicroUsd ?? 0), 0);
  const unknownCosts = report.sessions.filter((session) => session.costMicroUsd === null).length;
  lines.push(
    `sessions: ${report.sessions.length}, known cost ${(spent / 1e6).toFixed(2)} USD${unknownCosts > 0 ? ` (${unknownCosts} session(s) reported no cost)` : ""}`
  );
  for (const session of report.sessions) {
    lines.push(
      `  ${session.purpose}: ${session.classification}, ${session.numTurns ?? "?"} turn(s), ${session.costMicroUsd === null ? "cost unknown" : `${(session.costMicroUsd / 1e6).toFixed(2)} USD`}`
    );
  }
  return lines;
}
