import { test, expect } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openJournal, type JsonValue } from "../journal";
import type { SessionResult } from "../session";
import { buildProposal, renderProposal, type CommitChange, type SurfaceReport } from "./preflight";
import {
  CORPUS_SET,
  createProcessSynthesisGate,
  createProcessSynthesisGit,
  runSynthesis,
  type AuthoredSpecFile,
} from "./synthesis";
import { KNOWN_DEFECTS_HEADING, checkAdoptedCorpus, synthesisShapeChecker } from "./defects";

// --- fixtures ----------------------------------------------------------------

function spec(path: string, overrides: { retroactive?: boolean; defects?: string | null; criteria?: string | null; establishes?: readonly string[] } = {}): AuthoredSpecFile {
  const establishes = (overrides.establishes ?? ["src/auth/login.ts", "src/auth/token.ts"])
    .map((file) => `  - { kind: file, path: "${file}" }`)
    .join("\n");
  const origin = overrides.retroactive === false ? "" : "origin:\n  retroactive: true\n";
  const defects = overrides.defects === null ? "" : `\n${KNOWN_DEFECTS_HEADING}\n\n${overrides.defects ?? "None found during adoption."}\n`;
  const criteria = overrides.criteria === undefined || overrides.criteria === null ? "" : `\n## Acceptance criteria\n\n${overrides.criteria}\n`;
  return {
    path,
    content: `---\nid: "001-auth"\nstatus: draft\n${origin}establishes:\n${establishes}\n---\n\n# 001\n\nRecords the code as found.\n${defects}${criteria}`,
  };
}

// --- the checker (FR-001) -----------------------------------------------------

test("a conforming corpus, empty defects section included, passes with no violations (FR-001)", () => {
  const specs = [
    spec("specs/001-auth/spec.md"),
    spec("specs/002-core/spec.md", { defects: "" }),
  ];
  expect(checkAdoptedCorpus(specs, ["specs/001-auth/spec.md", "spec-spine.toml"], CORPUS_SET)).toEqual([]);
});

test("a missing retroactive marker, a missing defects section, and a source diff report per spec, all at once (FR-001)", () => {
  const violations = checkAdoptedCorpus(
    [
      spec("specs/001-auth/spec.md", { retroactive: false }),
      spec("specs/002-core/spec.md", { defects: null }),
      spec("specs/003-util/spec.md", { retroactive: false, defects: null }),
    ],
    ["src/auth/login.ts", "specs/001-auth/spec.md"],
    CORPUS_SET
  );
  expect(violations).toEqual([
    { path: "specs/001-auth/spec.md", reason: "frontmatter does not carry origin.retroactive: true (037 B-1)" },
    { path: "specs/002-core/spec.md", reason: `no "${KNOWN_DEFECTS_HEADING}" section (037 B-1: present even when empty)` },
    { path: "specs/003-util/spec.md", reason: "frontmatter does not carry origin.retroactive: true (037 B-1)" },
    { path: "specs/003-util/spec.md", reason: `no "${KNOWN_DEFECTS_HEADING}" section (037 B-1: present even when empty)` },
    { path: "src/auth/login.ts", reason: "changed path outside the corpus set (037 B-3: record, never fix)" },
  ]);
});

test("the heading match is exact: variants are silence, not conformance (D-1)", () => {
  const variant = spec("specs/001-auth/spec.md", { defects: null });
  const withVariant = { ...variant, content: variant.content + "\n## Known Defects\n\nnone\n" };
  const violations = checkAdoptedCorpus([withVariant], [], CORPUS_SET);
  expect(violations.map((violation) => violation.reason)).toContain(
    `no "${KNOWN_DEFECTS_HEADING}" section (037 B-1: present even when empty)`
  );
});

test("an acceptance criterion referencing a path outside the territory is flagged; inside and non-path tokens are not (B-4, D-2)", () => {
  const clean = spec("specs/001-auth/spec.md", {
    criteria: "- `src/auth/login.ts` exits zero today.\n- `spec-spine compile` is green.\n- `bun test src/other/x.test.ts` stays prose (whitespace, not a token).",
  });
  expect(checkAdoptedCorpus([clean], [], CORPUS_SET)).toEqual([]);

  const wishful = spec("specs/001-auth/spec.md", {
    criteria: "- `src/core/db.ts` should also validate input.\n- `src/auth/login.ts` exits zero.",
  });
  const violations = checkAdoptedCorpus([wishful], [], CORPUS_SET);
  expect(violations).toEqual([
    {
      path: "specs/001-auth/spec.md",
      reason: "acceptance criterion references src/core/db.ts, outside this spec's territory (037 B-4)",
    },
  ]);
});

test("a directory establishes edge covers criteria referencing files under it (B-4)", () => {
  const dirOwned = spec("specs/001-auth/spec.md", {
    establishes: ["src/auth"],
    criteria: "- `src/auth/login.ts` exits zero today.",
  });
  expect(checkAdoptedCorpus([dirOwned], [], CORPUS_SET)).toEqual([]);
});

// --- the seam (FR-002, AC-2) --------------------------------------------------

const EMPTY_SURFACES: SurfaceReport = {
  language: { value: null, candidates: [] },
  build: { value: null, candidates: [] },
  test: { value: null, candidates: [] },
};

function gitFor(repoDir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoDir });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
}

function fixtureTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "defects-test-target-"));
  gitFor(dir, ["init", "-q", "-b", "main"]);
  gitFor(dir, ["config", "user.email", "test@example.com"]);
  gitFor(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(join(dir, "src", "auth"), { recursive: true });
  for (const file of ["src/auth/login.ts", "src/auth/token.ts"]) fs.writeFileSync(join(dir, file), "export {};\n");
  fs.writeFileSync(join(dir, ".gitignore"), "/data/\n.derived/**/build-meta.json\n");
  gitFor(dir, ["add", "-A"]);
  gitFor(dir, ["commit", "-qm", "init"]);
  return dir;
}

function fixtureProposal(target: string): string {
  const commits: CommitChange[] = [
    { sha: "c2c2c2c2c2c2", subject: "auth 2", paths: ["src/auth/login.ts", "src/auth/token.ts"] },
    { sha: "c1c1c1c1c1c1", subject: "auth 1", paths: ["src/auth/login.ts", "src/auth/token.ts"] },
  ];
  return renderProposal(
    buildProposal({ repoDir: target, headSha: "abcabcabcabc", surfaces: EMPTY_SURFACES, history: { mode: "commits", requested: 200, commits, shortfall: null } })
  );
}

function completedSession(): SessionResult {
  return {
    classification: { kind: "completed", resetAtMs: null, detail: "ok" },
    exitCode: 0,
    durationMs: 5,
    numTurns: 3,
    costMicroUsd: 100_000,
    usage: null,
    sessionId: "s-fixture",
    transcriptPath: null,
    overflow: { lines: [], truncatedCount: 0 },
    stderrTail: "",
  };
}

function writeSpecFile(repoDir: string, specId: string, content: string): void {
  fs.mkdirSync(join(repoDir, "specs", specId), { recursive: true });
  fs.writeFileSync(join(repoDir, "specs", specId, "spec.md"), content);
}

// 035's FR-004 shape, driven through this checker end to end: the violation
// strings appear in the journaled records verbatim (AC-2, FR-002).
test("a synthesized spec without the defects section fails 035's guard through this checker, journaled verbatim (AC-2)", async () => {
  const target = fixtureTarget();
  const stateRoot = mkdtempSync(join(tmpdir(), "defects-test-state-"));
  try {
    const scaffold = (repoDir: string): void => {
      const init = Bun.spawnSync(["spec-spine", "init"], { cwd: repoDir });
      if (init.exitCode !== 0) throw new Error(`spec-spine init failed: ${new TextDecoder().decode(init.stderr)}`);
      writeSpecFile(
        repoDir,
        "000-bootstrap",
        `---\nid: "000-bootstrap"\ntitle: "Bootstrap"\nstatus: draft\ncreated: "2026-08-06"\nsummary: >\n  Bootstrap.\norigin:\n  retroactive: true\nestablishes:\n---\n\n# 000\n\n${KNOWN_DEFECTS_HEADING}\n\nNone found during adoption.\n`
      );
    };
    const journal = openJournal(stateRoot);
    let report;
    try {
      report = await runSynthesis({
        projectName: "adoptee",
        proposalDocument: fixtureProposal(target),
        journal,
        session: async (request) => {
          if (request.purpose === "scaffold") scaffold(target);
          else {
            writeSpecFile(
              target,
              request.purpose,
              `---\nid: "${request.purpose}"\ntitle: "Auth"\nstatus: draft\ncreated: "2026-08-06"\nsummary: >\n  Auth.\norigin:\n  retroactive: true\nestablishes:\n  - { kind: file, path: "src/auth/login.ts" }\n  - { kind: file, path: "src/auth/token.ts" }\n---\n\n# Auth\n\nNo defects section here.\n`
            );
          }
          return completedSession();
        },
        git: createProcessSynthesisGit(target),
        gate: createProcessSynthesisGate(target),
        clock: { now: () => Date.now() },
        source: "test",
        ceiling: null,
      });
    } finally {
      journal.close();
    }

    expect(report.outcome).toBe("failed");
    const territory = report.territories[0]!;
    expect(territory.outcome).toBe("guard-failed");
    expect(territory.detail).toContain(`no "${KNOWN_DEFECTS_HEADING}" section (037 B-1: present even when empty)`);

    const reader = openJournal(stateRoot);
    try {
      const violations = reader.fold().records.filter((record) => record.kind === "adopt.synthesis.violation");
      expect(violations.length).toBeGreaterThan(0);
      const payloads = violations.map((record) => JSON.stringify(record.payload as JsonValue)).join("\n");
      expect(payloads).toContain(`no \\"${KNOWN_DEFECTS_HEADING}\\" section (037 B-1: present even when empty)`);
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the seam stays injectable: a stub replaces the default and the same corpus passes (FR-002)", async () => {
  const target = fixtureTarget();
  const stateRoot = mkdtempSync(join(tmpdir(), "defects-test-stub-"));
  try {
    const seen: number[] = [];
    const journal = openJournal(stateRoot);
    let report;
    try {
      report = await runSynthesis({
        projectName: "adoptee",
        proposalDocument: fixtureProposal(target),
        journal,
        session: async (request) => {
          if (request.purpose === "scaffold") {
            const init = Bun.spawnSync(["spec-spine", "init"], { cwd: target });
            if (init.exitCode !== 0) throw new Error(`spec-spine init failed: ${new TextDecoder().decode(init.stderr)}`);
            writeSpecFile(
              target,
              "000-bootstrap",
              `---\nid: "000-bootstrap"\ntitle: "Bootstrap"\nstatus: draft\ncreated: "2026-08-06"\nsummary: >\n  Bootstrap.\norigin:\n  retroactive: true\nestablishes:\n---\n\n# 000\n\nNo defects section anywhere.\n`
            );
          } else {
            writeSpecFile(
              target,
              request.purpose,
              `---\nid: "${request.purpose}"\ntitle: "Auth"\nstatus: draft\ncreated: "2026-08-06"\nsummary: >\n  Auth.\norigin:\n  retroactive: true\nestablishes:\n  - { kind: file, path: "src/auth/login.ts" }\n  - { kind: file, path: "src/auth/token.ts" }\n---\n\n# Auth\n\nNo defects section here either.\n`
            );
          }
          return completedSession();
        },
        git: createProcessSynthesisGit(target),
        gate: createProcessSynthesisGate(target),
        clock: { now: () => Date.now() },
        source: "test",
        ceiling: null,
        // The stub waves through a corpus the default checker (see the AC-2
        // test above) fails on the missing sections: proof it replaced it.
        shapeChecker: ({ specs }) => {
          seen.push(specs.length);
          return [];
        },
      });
    } finally {
      journal.close();
    }
    expect(report.outcome).toBe("completed");
    expect(seen.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the adapter feeds the seam's input through positionally (FR-002)", () => {
  const conforming = spec("specs/001-auth/spec.md");
  expect(synthesisShapeChecker({ specs: [conforming], changedPaths: ["src/evil.ts"], corpusSet: CORPUS_SET })).toEqual([
    { path: "src/evil.ts", reason: "changed path outside the corpus set (037 B-3: record, never fix)" },
  ]);
});
