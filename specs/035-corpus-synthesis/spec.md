---
id: "035-corpus-synthesis"
title: "Corpus synthesis: driven sessions author a draft corpus for a target"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: complete
risk: high
depends_on:
  - "014-session-driver"
  - "032-execution-profiles"
  - "033-cost-ceiling"
  - "034-adoption-preflight"
summary: >
  The writing stage of adoption (010 A-2): given a preflight proposal
  the operator chose to synthesize, driven sessions author a spec-spine
  corpus for the target on a feature branch: the corpus scaffolding and
  one spec per proposed territory, every spec carrying
  origin.retroactive true, real establishes edges over its territory's
  files, defect capture per 037, and status draft. Drafts are never
  schedulable (012 D-3), so synthesis can never hand the builder work a
  human has not ratified. The reference implementation is this repo's
  own retroactive adoption of 2026-07-29 (spec 000, D12): specs record
  the code as found; synthesis blesses nothing and fixes nothing. A
  synthesis session's diff is mechanically confined to the corpus:
  touching target source or tests fails the stage.
establishes:
  - "src/orchestrator/adopt/synthesis.ts"
  - "src/orchestrator/adopt/synthesis.test.ts"
extends:
  # One verb: adopt synthesize, driving the sessions and reporting.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  # The verb's usage and AC-2 coverage ride in 028's test surface (028 D-10).
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.test.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 035: Corpus synthesis

## 1. Purpose

Generating prose specs from code is an afternoon; generating a corpus
the coupling gate can hold is the actual requirement. Synthesis exists
to produce the second thing: specs whose declared edges cover their
territory's real files, born draft so that every claim in them passes
under human eyes before anything schedules against them, and scored by
036's replay before anyone is asked to trust the boundaries.

## 2. Territory

`src/orchestrator/adopt/synthesis.ts` and its colocated tests: session
prompt assembly from a proposal, the corpus-confinement diff guard's
enforcement point, per-territory session orchestration, and reporting.
The CLI verb as declared in `extends`; the build session is granted
authority to record an additive D-n note in spec 028 for it, per the
coherence guard's explicit-authority clause. The corpus-shape rules
themselves (markers, defect sections) are 037's territory; synthesis
invokes its checker, never redefines it.

## 3. Behavior

- **B-1 (operator-initiated).** Synthesis runs only on an explicit
  operator verb naming a registered, adoptable target and a preflight
  proposal (by path or content hash); the choice is journaled with the
  proposal hash (034 B-6), so what the corpus was synthesized from is
  a matter of record. Nothing wakes synthesis automatically: an
  adoptable project at rest stays at rest (034 B-5).
- **B-2 (branch, sessions, corpus only).** Synthesis works on a fresh
  feature branch in the target, driven through the session driver (014)
  under the project's execution profile (032) with costs journaled
  (033's ceilings apply unchanged). Sessions scaffold the corpus
  (specs directory, spec-spine config, standards seeds) and author one
  spec per proposed territory. After every session, the branch diff is
  checked: paths outside the corpus set (the specs directory, the
  spec-spine config and standards, and their derived artifacts) fail
  the stage with the offending paths named (010 D19). The guard is
  code, not prompt text.
- **B-3 (born draft).** Every synthesized spec has `status: draft` and
  `origin.retroactive: true`, real `establishes` edges enumerating its
  territory's files from the proposal, and the 037 defect-capture
  shape. Synthesis never writes `status: approved`, and the guard
  fails a session that does (D18: ratification is the operator's own
  act, in the target, after reading).
- **B-4 (compile-clean or say why).** A synthesized corpus must leave
  `spec-spine compile` and `lint` green inside the target before the
  stage reports success; a corpus that cannot get green in the
  session budget reports failed with the diagnostics, never a partial
  success.
- **B-5 (honest reporting).** The synthesis report names: territories
  authored, files claimed per spec, files the proposal listed that no
  spec claimed (carried forward as remainder, never silently absorbed),
  sessions consumed and their journaled costs, and the branch name.
  Pushing, PRing, or merging the branch is the operator's decision and
  out of scope here.

## 4. Functional requirements

- **FR-001.** Prompt assembly is pure over (proposal, territory) and
  tested: the prompt carries the territory's file list, the retroactive
  posture (record, never fix: 037's rules restated verbatim), and the
  draft-status requirement.
- **FR-002.** The diff guard is pure over (changed paths, corpus set)
  and tested: corpus-only diffs pass; a source file, a test file, and a
  dotfile outside the corpus each fail with the path named.
- **FR-003.** An end-to-end fixture run with a fake session (scripted
  file writes) produces a compiling draft corpus in a fixture target,
  and the run's journal carries the proposal hash, per-session costs,
  and the report.
- **FR-004.** A fake session that writes `status: approved`, omits the
  retroactive marker, or edits a source file is failed by the guard,
  with the reason journaled.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/adopt/synthesis.test.ts` passes,
  including FR-003 and FR-004.
- **AC-2.** `observatory orchestrator adopt synthesize <project>
  --proposal <path>` against a fixture target drives the fixture
  sessions, leaves a compiling draft corpus on a feature branch, and
  prints the B-5 report.

## 6. Out of scope

Ratification and any status flip (D18: the operator's, informed by
036); pushing or merging the synthesis branch; replay scoring (036);
the corpus-shape rules themselves (037); incremental re-synthesis of
an already-adopted target; and any modification of target source or
tests, which is not a scope line but a failure mode (B-2).

## 7. Resolved decisions

D-1. One session per territory, serially, rather than one session for
the whole corpus: territory file lists keep each prompt bounded, a
failed territory retries alone, and the serial invariant (010 B-5)
holds unchanged. Cross-territory `depends_on` edges are proposed by the
sessions but validated only by compile plus 036; synthesis does not
referee dependency truth.

D-2. The corpus set (B-2's allowed paths) is exported, reviewable data
in `synthesis.ts`, tested path by path (031 FR-002's precedent), so
what synthesis may touch is an audited constant, not an opinion inside
a prompt.

D-3. Synthesis targets a corpus layout mirroring this repo's own
(specs/NNN-slug/spec.md, standards seeds, committed .derived), because
the reference implementation (spec 000, D12) is the one worked example
with a year of gate history behind it; a target wanting a different
layout adopts by hand and still gets 036's replay, which reads any
compiling corpus.

D-4 (build session). The corpus set includes `.claude/rules/`,
`.derived/`, and the root `.gitignore` alongside B-2's named three (the
specs directory, the spec-spine config, standards). `spec-spine init`
writes the rule seeds as part of the scaffold, so a set without them
would fail every scaffold session on the reference layout (D-3);
`.derived/` is D-3's committed artifacts; and `.gitignore` is there for
the two ignores every governed target needs, found live twice
(tenant-tail's permanently dirty tree from the orchestrator's own
state root under `data/`, 2026-08-05; and compile's non-deterministic
`build-meta.json` dirtying this spec's own AC-2 fixture). The scaffold
prompt bounds the .gitignore edit to exactly those two lines; a
session that rewrites it further still passes confinement, and the
ratification read is where a hostile ignore list would be caught (the
same trust boundary every authored spec body already crosses). The set
is exported data, tested path by path (D-2), and prefix-matching is
directory-exact: `specs.md` is not inside `specs/`.

D-5 (build session). Session bracketing. Each session's delta is
computed against the last pinned sha, not the branch base; a passing
session's delta is committed by the harness (never by the session), so
every commit on the branch is a guard-passed corpus state, and a
violating session's writes are discarded back to the pin, untracked
files included, so one bad session cannot poison the next session's
diff. The branch therefore carries only corpus that passed the guard,
and a failed run's branch remains inspectable.

D-6 (build session). Territory independence. A territory whose session
died or whose guard refused is recorded and the remaining territories
still run (D-1's "a failed territory retries alone"); the report is
`failed` unless every territory authored and the B-4 gate is green, so
a partial corpus is never reported as success. Re-running the verb
starts over from the proposal; the failed run's branch keeps what
passed, for inspection rather than resumption, in v1.

D-7 (build session). Ceilings (B-2's "033 unchanged") map as: the day
scope folds the project's work journal through 033's own
`evaluateBudget`, exactly as a driven run would (production sessions
journal `session.result` through the 014 driver into the same journal);
the run scope reads as this synthesis invocation, floored on its own
journaled synthesis session costs. Both are checked at spawn
boundaries, so overshoot keeps 033's one-session bound. A trip journals
a violation record naming the scope and stops spawning; territories
after it report `not-run`.

D-8 (build session). The branch is `corpus/synthesis-<hash12>`, the
first twelve hex of the proposal's content hash: provenance in the
name, and a re-synthesis from an amended proposal lands on a different
branch by construction. A branch that already exists refuses (the
operator deletes or renames it deliberately; synthesis never force
moves a ref).

D-9 (build session). Proposal resolution. `--proposal` takes a document
path, or a 64-hex sha256 resolved through the project's journaled
adopt.preflight records (034 B-6) to the recorded out path, with the
document re-hashed on read: a proposal that moved or was edited since
the operator chose it refuses rather than synthesizing from something
nobody read. The parse targets 034 FR-003's deterministic markdown
exactly, and a document that does not parse refuses with the reason
named.
