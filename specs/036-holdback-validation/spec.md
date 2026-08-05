---
id: "036-holdback-validation"
title: "Holdback validation: score a candidate corpus against real history"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "025-project-registry"
  - "034-adoption-preflight"
summary: >
  The acceptance instrument for adoption (010 A-2, D17): replay the
  target's own merge history against a candidate corpus's declared
  ownership and report whether the boundaries would have held. For each
  of the last N first-parent merges: which changed paths the corpus
  covers, which are orphans no spec owns, and how many specs the change
  would have had to touch (dispersion). The rollup: commit coverage
  percentage, orphan file list, dispersion histogram, and a per-commit
  detail naming the specs each failing commit would have needed. Every
  number carries its denominator. The verdict is written into a
  journaled ratification-input record pinning the corpus content it
  scored, so an operator's later approval flip can cite exactly what
  was measured. Works against any compiling corpus, synthesized (035)
  or hand-authored; it is useful standing alone as a boundary audit
  even if the builder never drives the target.
establishes:
  - "src/orchestrator/adopt/holdback.ts"
  - "src/orchestrator/adopt/holdback.test.ts"
extends:
  # One verb: adopt validate, running the replay and rendering the score.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  # The ratification record: journaled verdict the arm path can cite.
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 036: Holdback validation

## 1. Purpose

"We generated some specs, hope they're good" is not a governance story.
The coupling gate's whole premise is that ownership boundaries are
checkable; this spec applies that premise to the boundaries themselves,
before anyone trusts them. The target's merge history is a free,
adversarial test set nobody can retrofit: every commit that would have
sprayed across six specs is a boundary drawn wrong, and every orphan
path is a claim of coverage the corpus does not make.

## 2. Territory

`src/orchestrator/adopt/holdback.ts` and its colocated tests: the
replay, the scoring, the report, and the ratification-input record.
Extensions as declared in `extends`: the CLI verb, and the record kind
in `projects.ts`. The build session is granted authority to record
additive D-n notes in specs 025 and 028 for those mechanical additions,
per the coherence guard's explicit-authority clause.

## 3. Behavior

- **B-1 (replay).** For each of the last N first-parent merges of the
  target's default branch (default 200; shortfall named, 034 B-3's
  window discipline), the changed path set is evaluated against the
  candidate corpus's declared ownership (establishes and extends
  edges, read through spec-spine against the corpus as compiled at the
  branch under test). A commit passes when every governed-territory
  path it touches is owned; a commit fails on orphans (paths no spec
  owns) or reports its dispersion (the count of distinct owning specs)
  when it passes. Paths in the corpus's explicit ungoverned remainder
  are excluded from coverage and said so, never counted as either.
- **B-2 (the score).** The rollup reports: commits fully covered over
  commits evaluated (the coverage percentage, with both integers
  printed), the orphan path list ranked by touch count, the dispersion
  histogram, and per-commit detail for every failure naming its
  uncovered paths. No single scalar stands in for the report; a
  percentage without its orphan list invites exactly the false
  confidence this spec exists to prevent.
- **B-3 (ratification input).** A completed replay appends a journaled
  record pinning: the corpus content hash (the compiled registry's own
  content hashing), the target HEAD and history window replayed, and
  the full score. The record is input evidence for the operator's
  ratification (010 D18); it grants nothing by itself, and re-running
  against a changed corpus appends a fresh record rather than mutating
  anything.
- **B-4 (standalone).** The replay requires a compiling corpus and a
  git history, nothing else: no run, no sessions, no arming, no
  synthesis provenance. Scoring a hand-authored corpus is a supported,
  documented use.
- **B-5 (honesty).** A history too shallow to evaluate says so and
  scores nothing; an evaluation error on one commit is reported per
  commit, never silently skipped; and the report states the one thing
  the replay cannot know: history measures where boundaries held, not
  whether the specs' prose is true. Prose truth is what D18's human
  read is for.

## 4. Functional requirements

- **FR-001.** The replay is pure over (commit path sets, ownership
  snapshot) and tested: full coverage, orphans, dispersion spread,
  ungoverned-remainder exclusion, shallow history, and the empty
  corpus (0 of N, all orphans, not an error).
- **FR-002.** Ownership reads go through spec-spine subprocess calls
  against the target corpus (012 B-1's discipline); subprocess failures
  surface as typed errors, never as an empty ownership map (012
  FR-001's rule restated for adoption).
- **FR-003.** The ratification-input record round-trips: appended with
  corpus pin, HEAD, window, and score; folded and rendered by the
  projects surfaces; chain verification passes.
- **FR-004.** Report rendering prints denominators everywhere a
  percentage appears, and the per-commit failure detail includes the
  uncovered paths verbatim.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/adopt/holdback.test.ts` passes.
- **AC-2.** `observatory orchestrator adopt validate <project>
  --corpus <branch-or-path>` against a fixture target with a fixture
  corpus prints the B-2 report and journals the B-3 record; running it
  on a corpus that deliberately omits one hot file shows that file at
  the top of the orphan list.

## 6. Out of scope

Hill-climbing or auto-repairing boundaries from the score (the report
informs the operator and 035's next synthesis, it edits nothing);
ratification itself and any status flip in the target (the operator's,
per D18); scheduling consequences (arming semantics stay 025/026's);
semantic verification of spec prose (B-5 names the limit); and CI
integration in the target.

## 7. Resolved decisions

D-1. Ownership is evaluated against the candidate corpus as it exists
at the branch under test, not reconstructed per historical commit: the
question is whether today's proposed boundaries would have held for
yesterday's changes, so the corpus is the constant and history is the
variable. Renamed paths are followed through git's rename detection,
and a path that existed in history but exists in no current territory
and no remainder is an orphan like any other: the corpus's map of the
present must still account for where the past happened.

D-2. Dispersion is reported, never thresholded into pass/fail by this
spec: a commit legitimately touching three specs' territories is three
coupled authoring edits under the gate, not a defect. The histogram is
evidence for the operator's judgment about boundary quality; hard
dispersion limits, if ever wanted, are ratification policy, not replay
mechanics.
