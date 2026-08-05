---
id: "035-corpus-synthesis"
title: "Corpus synthesis: driven sessions author a draft corpus for a target"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
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
