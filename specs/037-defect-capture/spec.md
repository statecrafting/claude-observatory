---
id: "037-defect-capture"
title: "Defect capture: adopted specs record behavior, never bless it"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "035-corpus-synthesis"
summary: >
  The rule that keeps adoption honest (010 A-2, D19), made mechanical:
  a reverse-engineered spec records what the code does, and known-wrong
  behavior is written down as a defect, never blessed as contract. Get
  this wrong and adoption launders every bug in the target into
  governed truth. This spec establishes the corpus-shape checker that
  synthesis must pass: every synthesized spec carries
  origin.retroactive true and a Known defects section that is present
  even when empty (no known defects is a recorded claim, not an
  omission), and a synthesis diff may touch only the corpus set, so
  "record, never fix" is enforced by code rather than requested by
  prompt. The shape is this corpus's own: specs 000-008 carry exactly
  these markers and sections for the observatory code that predates
  the graph.
establishes:
  - "src/orchestrator/adopt/defects.ts"
  - "src/orchestrator/adopt/defects.test.ts"
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 037: Defect capture

## 1. Purpose

An adopted corpus is retrospective authority: it asserts ownership over
code whose behavior nobody re-decided. The only honest way to hold that
authority is to separate "what it does" from "what it should do" at
authoring time, in the artifact itself, in a shape a checker can
enforce. The alternative is subtle and corrosive: acceptance criteria
that quietly promote today's accidents into tomorrow's contract, which
the coupling gate would then defend forever.

## 2. Territory

`src/orchestrator/adopt/defects.ts` and its colocated tests: the
corpus-shape checker and its violation vocabulary. No surface of its
own: synthesis (035) invokes the checker and journals its violations;
this spec extends nothing and owns the one module.

## 3. Behavior

- **B-1 (the shape).** A synthesized spec must carry
  `origin.retroactive: true` in frontmatter and a `## Known defects`
  section in the body. The section is present even when empty: an
  empty section is the recorded claim "none found during adoption",
  which is falsifiable evidence, where an absent section is silence.
  Recorded defects name the observed behavior, the expectation it
  violates, and the evidence (a test run, a doc contradiction, an
  error message), each as prose a human can dispute at ratification.
- **B-2 (the checker).** `checkAdoptedCorpus(specs, changedPaths,
  corpusSet)` is a pure function verifying B-1's shape for every
  synthesized spec and B-2 of 035's confinement (changed paths within
  the corpus set), returning named violations per spec, never a bare
  boolean. Synthesis (035) invokes it after every session and fails
  the stage on any violation; the checker itself schedules nothing and
  writes nothing.
- **B-3 (record, never fix).** A synthesis session that changes target
  source or tests is failed by confinement (035 B-2, this checker's
  evidence), including the tempting case: a session that found a bug
  and fixed it. The fix is recorded as a Known defects entry instead;
  fixing a recorded defect later is a normal governed change coupled
  to the owning spec, exactly this repo's standing rule for specs
  001-008.
- **B-4 (acceptance criteria stay descriptive).** Synthesized
  acceptance criteria assert currently observable behavior (commands
  that exit zero today, outputs the code produces today), so the
  corpus compiles into a gate that holds on day one. A criterion
  expressing desired-but-absent behavior belongs in a Known defects
  entry or a future authored spec, and the prompt contract (035
  FR-001) says so; the checker flags the mechanical subset it can
  detect (criteria referencing paths outside the spec's territory).

## 4. Functional requirements

- **FR-001.** Checker tests cover: a conforming corpus; a spec missing
  the retroactive marker; a spec missing the Known defects section; a
  spec with the section present and empty (conforming); a diff
  touching target source (violation naming the path); and violations
  reported per spec, all at once, not first-failure-only.
- **FR-002.** The checker is consumed by synthesis through an injected
  seam so 035's fixtures exercise real enforcement, and its violation
  strings are stable enough to journal (they appear in 035's failure
  records verbatim).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/adopt/defects.test.ts` passes.
- **AC-2.** 035's FR-004 fixtures fail through this checker with the
  violations journaled, demonstrating the enforcement path end to end.

## 6. Out of scope

Deciding what is a defect (the sessions observe and record; humans
adjudicate at ratification); auto-filing issues in the target's
tracker; semantic diffing of spec prose against code behavior beyond
B-4's mechanical subset; and any retroactive audit of this repo's own
000-008 sections, which predate this spec and are its precedent, not
its subjects.

## 7. Resolved decisions

D-1. The checker's section heading match is exact (`## Known defects`),
mirroring specs 000-008 verbatim rather than accepting variants: the
value of a mechanical shape is that greps, humans, and future tooling
find one spelling. A target corpus wanting a different convention is a
hand adoption (035 D-3's clause) and opts out of this checker with its
eyes open.

D-2. B-4's mechanical subset is deliberately narrow (criteria naming
paths outside the spec's territory) rather than attempting NLP over
"should": a checker that pretends to judge intent would convert an
honesty rule into a false-confidence machine. The human read at
ratification (010 D18) is the real reviewer of descriptive-vs-wishful;
the checker just removes the excuses.
