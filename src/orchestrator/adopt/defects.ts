// Spec 037: defect capture. The corpus-shape checker adoption's honesty rule
// hangs on: a reverse-engineered spec records what the code does, and
// known-wrong behavior is written down as a defect, never blessed as
// contract. This module owns the checker and its violation vocabulary; it
// schedules nothing and writes nothing (B-2). Synthesis (035) invokes it
// after every session through its shape-checker seam and journals whatever
// comes back verbatim (FR-002).
//
// The checker deliberately duplicates a slice of 035's own minimum (the
// retroactive marker, the confinement read): the two guards report in their
// own words, and a corpus that trips both journals both. Defense in depth is
// the point; deduplication would couple the modules for cosmetics.

import type { AuthoredSpecFile, CorpusPathRule, CorpusShapeChecker, ShapeViolation } from "./synthesis";

// D-1: the section heading match is exact, mirroring specs 000-008 verbatim:
// the value of a mechanical shape is that greps, humans, and future tooling
// find one spelling.
export const KNOWN_DEFECTS_HEADING = "## Known defects";

function frontmatterOf(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? null : content.slice(4, end + 1);
}

function bodyOf(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? "" : content.slice(end + 4);
}

// The spec's territory as its frontmatter declares it: every path named in an
// establishes edge, either form (035's claimedPaths reads the same two).
function territoryOf(frontmatter: string): readonly string[] {
  const paths: string[] = [];
  for (const match of frontmatter.matchAll(/path:\s*"([^"]+)"/g)) paths.push(match[1]!);
  for (const match of frontmatter.matchAll(/^\s+-\s+"([^"]+)"\s*$/gm)) paths.push(match[1]!);
  return [...new Set(paths)];
}

function insideTerritory(token: string, territory: readonly string[]): boolean {
  return territory.some(
    (path) => path === token || path.startsWith(`${token}/`) || token.startsWith(`${path}/`)
  );
}

// B-4's mechanical subset, deliberately narrow (D-2): backtick-quoted,
// whitespace-free tokens containing a path separator, found under an
// acceptance-criteria heading. No NLP over "should"; the human read at
// ratification is the real reviewer of descriptive-vs-wishful.
function criteriaSection(body: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s/.test(line) && /acceptance criteria/i.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function criteriaPathTokens(body: string): readonly string[] {
  const section = criteriaSection(body);
  if (section === null) return [];
  const tokens: string[] = [];
  for (const match of section.matchAll(/`([^`\s]+)`/g)) {
    if (match[1]!.includes("/")) tokens.push(match[1]!);
  }
  return [...new Set(tokens)];
}

function ruleCovers(rule: CorpusPathRule, path: string): boolean {
  if (rule.kind === "file") return path === rule.path;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

// B-2: pure over (specs, changed paths, corpus set); named violations per
// spec, all at once, never a bare boolean. The strings are journal-stable:
// 035's failure records carry them verbatim (FR-002).
export function checkAdoptedCorpus(
  specs: readonly AuthoredSpecFile[],
  changedPaths: readonly string[],
  corpusSet: readonly CorpusPathRule[]
): readonly ShapeViolation[] {
  const violations: ShapeViolation[] = [];

  for (const spec of specs) {
    const frontmatter = frontmatterOf(spec.content);
    if (frontmatter === null) {
      violations.push({ path: spec.path, reason: "no frontmatter block (037 B-1)" });
      continue;
    }
    if (!/retroactive:\s*true/.test(frontmatter)) {
      violations.push({ path: spec.path, reason: "frontmatter does not carry origin.retroactive: true (037 B-1)" });
    }
    const body = bodyOf(spec.content);
    // Present even when empty: an empty section is the recorded claim "none
    // found during adoption", where an absent section is silence (B-1).
    const hasSection = body.split("\n").some((line) => line.trim() === KNOWN_DEFECTS_HEADING);
    if (!hasSection) {
      violations.push({ path: spec.path, reason: `no "${KNOWN_DEFECTS_HEADING}" section (037 B-1: present even when empty)` });
    }
    const territory = territoryOf(frontmatter);
    for (const token of criteriaPathTokens(body)) {
      if (!insideTerritory(token, territory)) {
        violations.push({
          path: spec.path,
          reason: `acceptance criterion references ${token}, outside this spec's territory (037 B-4)`,
        });
      }
    }
  }

  // 035 B-2's confinement, re-read here as this checker's own evidence (B-3):
  // the tempting case, a session that found a bug and fixed it, surfaces as a
  // changed path no corpus rule covers.
  for (const path of [...changedPaths].sort()) {
    if (!corpusSet.some((rule) => ruleCovers(rule, path))) {
      violations.push({ path, reason: `changed path outside the corpus set (037 B-3: record, never fix)` });
    }
  }

  return violations;
}

// The seam adapter 035 consumes (its CorpusShapeChecker signature), and the
// default it wires when no test injects one (035 D-10).
export const synthesisShapeChecker: CorpusShapeChecker = ({ specs, changedPaths, corpusSet }) =>
  checkAdoptedCorpus(specs, changedPaths, corpusSet);
