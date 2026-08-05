---
id: "034-adoption-preflight"
title: "Adoption preflight: read-only cartography of an ungoverned target"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "025-project-registry"
summary: >
  The first stage of corpus adoption (010 A-2, D16) and the only one an
  operator can run against any repository with zero commitment: a
  read-only preflight that maps an ungoverned target and produces a
  written proposal, never a change. It detects language, build, and
  test surfaces; extracts a change-coupling map from the target's own
  merge history (files that change together, churn-weighted); and
  proposes candidate spec territories at change level, each with its
  file set and the evidence behind it, with the ungoverned remainder
  explicit. Registering an ungoverned repository stops being a bare
  qualification failure: the verdict gains an "ungoverned, adoptable"
  reading so such targets stay visible with reasons, never scheduled
  for build, and never silently dropped.
establishes:
  - "src/orchestrator/adopt/preflight.ts"
  - "src/orchestrator/adopt/preflight.test.ts"
extends:
  # Qualification vocabulary: an ungoverned target registers visibly as
  # adoptable instead of only failing.
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.ts", nature: additive }
  # One read verb producing and rendering the proposal.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 034: Adoption preflight

## 1. Purpose

Everything downstream of adoption (synthesis, scoring, ratification)
depends on where the territory boundaries fall, and boundaries drawn
from a directory listing are guesses. The target's own merge history is
the one witness of how the code actually cleaves: files that ship
together belong together. The preflight turns that history into a
proposal an operator can read, argue with, and hand to synthesis, while
committing to nothing.

## 2. Territory

`src/orchestrator/adopt/preflight.ts` and its colocated tests: surface
detection, history extraction, the partition proposal, and its
serialization. Extensions as declared in `extends`: the qualification
vocabulary in `projects.ts` and the CLI verb. The build session is
granted authority to record additive D-n notes in specs 025 and 028 for
those mechanical additions, per the coherence guard's explicit-authority
clause; it does not amend their B-level contracts.

## 3. Behavior

- **B-1 (read-only, proposal out).** The preflight writes nothing inside
  the target: no branch, no file, no state root growth beyond the
  journal record of the preflight itself. Its output is one
  deterministic proposal document written to an operator-chosen `--out`
  path (defaulting under the daemon home), carrying every claim with
  its evidence.
- **B-2 (surface detection).** Language, build command, and test
  command are detected from manifest evidence (package.json, Cargo.toml,
  pyproject.toml, Makefile, and peers). A surface the evidence does not
  determine is reported unknown, with the candidates found and why each
  is unconfirmed; the preflight never silently guesses (010 B-4
  extended to cartography).
- **B-3 (change-coupling).** From the last N first-parent merges
  (default 200, bounded by what the clone holds, the shortfall named),
  the preflight extracts per-commit changed path sets and computes
  churn per path and co-change affinity between paths. Vendored,
  generated, and lockfile paths are excluded by a reviewable, exported
  default list; every exclusion is visible in the proposal.
- **B-4 (candidate territories).** The proposal ranks candidate
  territories at change level (010 D16): clusters of paths with high
  internal co-change and a live churn signal, each carrying its file
  set, its churn share, and sample commits as evidence. Paths in no
  candidate are listed as the explicit ungoverned remainder. The
  proposal proposes; it never claims the partition is correct, and its
  wording says which specs 036's replay would score it against.
- **B-5 (adoptable, visibly).** Registering a target that fails
  governed qualification (025 B-4) because it has no corpus now records
  the failure with an `adoptable` reading when the target is otherwise
  sound (git repo, origin remote, resolvable default branch): the
  project stays visible in every surface with its reasons, is never
  schedulable for build work, and `adoptable` is a recorded fact about
  the target, never a consent (arming an adoptable project schedules
  nothing; there is nothing schedulable in it).
- **B-6 (journaled).** Running a preflight against a registered project
  appends a journal record naming the target's HEAD sha, the history
  window actually used, and the proposal's content hash, so a later
  ratification (036) can cite exactly which cartography it trusted.

## 4. Functional requirements

- **FR-001.** Extraction and clustering are pure over (commit list,
  path sets) and tested against fixture histories: a repo with two
  clearly separate subsystems, a repo with one hot subsystem and a cold
  remainder, a shallow history (window shortfall named), and an empty
  history (proposal says so, proposes nothing).
- **FR-002.** Surface detection tests cover a Bun/TypeScript fixture, a
  Cargo fixture, a fixture with both (both reported, neither chosen),
  and a fixture with none (unknown, candidates empty).
- **FR-003.** Proposal serialization is deterministic (constitution:
  same inputs, byte-identical output) and carries evidence for every
  candidate: file set, churn share, sample commits.
- **FR-004.** Qualification tests: an ungoverned-but-sound fixture
  records `adoptable` with reasons; a non-repo still fails plainly; a
  governed repo is untouched by this spec's vocabulary.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/adopt/preflight.test.ts` passes.
- **AC-2.** `observatory orchestrator adopt preflight <fixture> --out
  <path>` writes a proposal for an ungoverned fixture repo and prints
  its candidate count, remainder size, and unknowns; running it twice
  produces byte-identical proposals.
- **AC-3.** `observatory orchestrator projects` renders an
  ungoverned-but-sound registered fixture as adoptable with reasons,
  and `dag`/`next` refuse it with the reason named, not an empty
  answer.

## 6. Out of scope

Writing anything into the target (035's synthesis sessions own that,
behind their own consent); replay scoring (036); defect capture rules
(037); semantic code analysis beyond path-level history (an import
graph is a later refinement, named here so its absence is a choice);
API and UI surfaces for adoption (a later spec consumes the CLI's
shapes).

## 7. Resolved decisions

D-1. History extraction walks first-parent merges so the unit of
evidence is the reviewed change (the PR), not the intermediate commit;
a repo whose default branch has no merge commits falls back to plain
first-parent history, and the proposal names which mode it read.

D-2. The exclusion list (vendored, generated, lockfiles) is exported,
reviewable data with tests (031 FR-002's precedent), because a wrong
exclusion silently deletes evidence; the CLI accepts additions, never
removals, of exclusions per run, so the floor is the audited constant.

D-3. Clustering is deterministic greedy agglomeration over co-change
affinity with an exported threshold, not an optimizer: the proposal's
job is a defensible starting point an operator can read, and 036's
replay, not the clustering objective, is the arbiter of whether the
boundaries hold. A fancier partitioner may replace it later without
changing this contract.
