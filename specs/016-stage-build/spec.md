---
id: "016-stage-build"
title: "Build stage: implement one spec in one fresh session"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: stage
implementation: complete
risk: high
depends_on:
  - "012-spec-dag-readiness"
  - "014-session-driver"
  - "020-decision-ledger"
summary: >
  The first pipeline stage: assemble the context a fresh session needs (the
  target spec verbatim, the backlog protocol, relevant decision-ledger
  entries, dependency pins), flip the spec to in-progress on a fresh
  feature branch, drive one session to implement exactly that spec's
  territory, and judge completion from evidence (gate commands green, spec
  acceptance criteria addressed, working tree state) rather than the
  session's own claim.
establishes:
  - "src/orchestrator/stages/build.ts"
  - "src/orchestrator/stages/build.test.ts"
extends:
  # D-13: the stall signal is produced here and consumed by the daemon's
  # stage-retry loop, which is spec 021's unit. One predicate and one early
  # pause, additive to the existing failure branch.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.test.ts", nature: additive }
  # The standby fixture builds a BuildEvidence, which gained the field.
  - { spec: "026-standby-daemon", unit: "src/orchestrator/standby.test.ts", nature: additive }
---

# 016: Build stage

## 1. Purpose

Turn "the next ready spec" into a branch where the spec's territory exists
and the governed gate is green, using one fresh session, with every choice
the session makes recorded.

## 2. Territory

`src/orchestrator/stages/build.ts` and tests.

## 3. Behavior

- **B-1 (preflight refusals).** Before spawning: target repo tree must be
  clean, on the default branch, gate green at base, spec ready (spec 012).
  Violations are Refusals (the stage does not start), distinct from a
  started-then-failed stage, after the statecraft-cli pattern.
- **B-2 (branch first).** Create `NNN-slug` branch before the session, so a
  failed build leaves an inspectable branch, then flip the spec frontmatter
  to `implementation: in-progress`, recompile, reindex, commit. This
  bracket is orchestrator-owned, not session-owned, and the commit it
  leaves must be self-consistent: every derived artifact the flip touches
  (registry and codebase-index shards alike) is regenerated inside the
  bracket, never left for the session's final commit to absorb (D-8).
- **B-3 (prompt).** The prompt contains: the spec body verbatim, the repo's
  AGENTS.md backlog step for one spec, the decision-ledger entries whose
  scope matches the spec or its dependencies (spec 020 injection), and the
  instruction to record new decisions via the ledger drop-box (spec 020
  B-3). The prompt template is a versioned file, and its version is
  journaled with each use.
- **B-4 (drive).** One session (spec 014) with the build deadline and turn
  cap. Remediation for a red gate at the end is at most one follow-up
  session with the failure evidence in the prompt; a second failure fails
  the stage honestly.
- **B-5 (completion evidence).** The stage passes only when, run by the
  orchestrator itself after the session ends: `spec-spine compile`, `index
  check`, `lint --fail-on-warn`, `couple --base origin/main --head HEAD`,
  and the repo's typecheck/test commands all exit 0 on the branch, and the
  spec's frontmatter is `implementation: complete`. The session saying
  "done" is not evidence.
- **B-6 (decision capture).** Ledger drop-box entries written by the session
  are validated and sealed into the decision ledger at stage end (spec 020),
  journaled with the stage evidence.

## 4. Functional requirements

- **FR-001.** All git effects go through a Runner seam so tests drive the
  stage against a temp repo without a real session (fake claude).
- **FR-002.** Stage evidence journaled: branch, head sha, gate outputs
  (exit codes plus tails), session ids, cost.
- **FR-003.** A crash mid-stage resumes to a reconcile step that inspects
  the branch state and either continues to evidence evaluation or retries
  cleanly (no duplicate branches, idempotent by branch name).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/stages/build.test.ts` passes.
- **AC-2.** Against a fixture repo with a one-file spec, a scripted fake
  session that writes the file yields `passed` with all evidence present;
  the same fixture with a failing lint yields `failed` with the lint tail
  in evidence.

## 6. Out of scope

Committing to the default branch, pushing (ship's job), and multi-spec
batching.

## 7. Resolved decisions

D-1. B-3 calls the prompt template "a versioned file", but
`src/orchestrator/stages/build-prompt.ts` is not in this spec's
`establishes` list, so a second file would only be an out-of-territory
addition with nothing else in the corpus to couple it to. Resolved: the
template lives inside `build.ts` itself as an exported constant
(`BUILD_PROMPT_VERSION`) and an exported pure function (`buildPrompt`); the
version is still journaled with every use (the `stage.build.prompt` record),
which is what B-3 actually requires, without a second file.

D-2. The stage outcome type is one flat shape,
`{outcome: "passed" | "failed" | "refused" | "blocked", evidence: BuildEvidence}`,
shared by every outcome, rather than a discriminated union with a different
evidence shape per outcome. A refusal fills `evidence.refusal` and leaves
`branch`/`headSha`/`sessions`/`gates`/`frontmatterComplete`/`decisions` at
their null-or-empty defaults; every other outcome leaves `refusal: null` and
fills the rest. One shape keeps journal payload construction and every
caller's field access uniform, at the cost of a few nullable fields that are
simply absent on a refusal, distinguishing a Refusal from a
started-then-failed stage by outcome value rather than by a different
evidence shape.

D-3. The Runner's git methods are exactly the seven this spec's own text
names (`statusClean, currentBranch, createBranch, add, commit, headSha,
checkout`); there is no separate `branchExists`. FR-003's reconcile
("idempotent: if it exists already... reuse it") is folded into
`createBranch` itself: it checks existence and either creates-and-checks-out
or just checks out the existing branch, returning a boolean (`true` when
reused) so the bracket step can journal which happened without adding a
method to the seam.

D-4. B-3's decision-ledger injection needs `dependsOnClosure` and
`territoryPaths` (spec 020's `decisionsFor` parameters), but this spec's
territory does not include dag.ts or the registry. Resolved: both are
parsed directly from the target spec's own frontmatter (`depends_on:` and
`establishes:` list fields, via `parseFrontmatterListField`), the same file
already read for the frontmatter flip, rather than shelling out to
spec-spine a second time or reaching into spec 012's territory for a
transitive closure this stage does not otherwise need.

D-5. B-4's "gate commands" and B-5's completion gate are the same six
commands (`spec-spine compile`, `spec-spine index check`, `spec-spine lint
--fail-on-warn`, `spec-spine couple --base origin/main --head HEAD`, `bun
run typecheck`, `bun test`), exported once as `GATE_COMMANDS` and reused for
the B-1 "gate green at base" preflight check, the B-2 bracket's own compile
call (its first element), and every post-session evaluation, rather than
three independently maintained copies.

D-6. Found by the third live relaunch: a fresh attempt on a branch whose
prior attempt finished (frontmatter already complete) crashed the bracket,
because flipImplementation treated complete as an unexpected state.
Complete-toward-in-progress is now a no-op: the attempt proceeds straight
to evidence evaluation. Genuinely unexpected states (deferred, missing)
still throw.

D-7. Found live when spec 024's build refused on spec 023's leftover
branch: ship and shepherd act remotely, so nothing returned the local
checkout to the default branch between specs. B-1's wrong-branch check is
now a normalization: a clean tree on another branch checks out the default
branch and fast-forwards it (no upstream is a no-op); only a dirty tree,
or a failed normalization, refuses. The Runner gains pullFfOnly.

D-8 (2026-08-02, operator-directed fix wave). Found when a 029 build
session crashed early: the bracket ran only `spec-spine compile` before
its flip commit, so the commit carried the pre-flip codebase-index shard
(verified: flip-commit shard == pre-flip main shard). Normally the
session's own final commit regenerates the index and absorbs it; on an
early crash the next `spec-spine index` run dirties the tree, and a dirty
tree is exactly what makes 021 D-17's checkout normalization refuse to
act, stranding the checkout on the spec branch. The bracket now runs
`spec-spine index` after compile and commits both regenerated artifact
sets; either command failing fails the bracket (same honest path the
compile failure already took), and the bracket journal record carries
`indexExitCode` beside `compileExitCode`.

D-9 (2026-08-05, operator). The turn budget doubles to 160. Found live
twice in one afternoon: the 032 and 033 builds each ran their session
and their remediation session into the 80-turn cap while one type error
or one fixture line short of green, so every attempt cost two full
max-turns sessions and still needed an operator completion (their D-8
and D-7 provenance notes). The cap was set before spec-sized territory
existed in the backlog. Wall clock stays bounded by the unchanged
deadline, and spend is now bounded by spec 033's ceilings, which is the
guard that was actually being asked of the turn cap; a turn budget
whose main observed effect is doubling the cost of finishing is not a
guard.

D-10 (2026-08-06, operator). The gate's language half is conditional on
the target sharing it. D-5's six commands split: the four spec-spine
commands are the universal governance gate and always run; `bun run
typecheck` and `bun test` are this repo's Bun + TypeScript conventions
and run only where a readable root tsconfig.json says the target shares
them (`gateCommandsFor(runner)`, probed through the Runner's own
readFile so fixtures and production answer alike). Found live on the
first driven family-repo build: tenant-tail is a Rust workspace whose
package.json exists only for spec-spine scripts, so "bun run typecheck"
exited 1 at a clean base and B-1 refused a target whose language
verification lives in its own CI, which shepherd (018) already watches
per PR. The session prompts carry the computed program rather than the
constant, so a session is never promised a command the evaluation will
not run; the earlier family corpus (tenant-emit) never noticed because
it was wholly adopted, never built.

D-11 (2026-09-02, operator). B-3's drop-box instruction states the record's
field types, not just its field names. The prompt named the shape as
`{id, specId, scope, title, decision, rationale, alternatives?,
supersedes?}` and left every type to be guessed; spec 020 B-1 defines
`scope` as a list, and `validateDecisionRecord` enforces `string[]`. Found
live on butler-ai: 25 of 25 decisions written across four sessions and two
stages used `"scope": "reducer"`, every one was rejected, and the project's
`decisions.jsonl` was still 0 bytes after a full spec had been built. The
loss is silent to the session and compounding, because B-4's injection then
has nothing to inject: a later session cannot read what an earlier one
decided, and rediscovers the same wall at full session cost (four sessions
and $17.44 spent re-deriving one unresolvable coupling violation that the
first session had already recorded correctly). The prompt now gives the
type of every field, states that `scope` is an array and never a bare
string, says that a rejected record reaches neither the ledger nor a later
session, and carries a complete copyable example built from the spec's own
id, which is why `buildPrompt` now takes `specId`. `BUILD_PROMPT_VERSION`
goes to 2 in the same change: the version is journaled with every use, so
holding it at 1 across a changed template would leave
`stage.build.prompt` unable to answer which text a session actually saw.

D-12 (2026-09-02, operator). B-3's prompt tells the session which gate
commands must exit 0 and never tells it how to satisfy the one that most
often cannot be satisfied by writing code. `couple` requires every changed
path to carry an authoring edit to an owning spec; when a spec's territory
legitimately needs a change to a unit another spec owns, the corpus
mechanism is an `extends:` entry in the frontmatter of the spec being
built, which is an authoring edit to that spec and amends nobody else's.
The prompt now says so, and says what the two forbidden or unavailable
answers are: amending the owning spec is the coherence guard's own
prohibition, and a `Spec-Drift-Waiver:` line is read only from a PR body,
which does not exist during build. Found live on butler-ai, where spec 009
needed a five-line `proptest` pin in the root `Cargo.toml` that spec 001
section 3.1 positively requires, and the sessions correctly refused to
amend 001, correctly ruled out a commit-message waiver by experiment, and
then concluded that no branch-side fix existed. They were wrong, and the
gap was this prompt: a single declared `extends` entry took `couple` from
1 to 0 with no waiver and no amendment to any other spec. Four sessions and
$17.44 were spent proving a wall that one line of prompt would have
avoided. The prompt also states the case where `extends` is the wrong
answer, so this never becomes a way to declare away a real contradiction:
if the owning spec actually contradicts the change, the session stops and
reports, exactly as before.

D-13 (2026-09-02, operator). A stage that cannot move says so, instead of
being retried blind. B-4 already bounds the work inside one attempt (one
session, at most one remediation), but nothing carried that attempt's
answer outward, so the daemon's retry budget spent a second full attempt
whenever the first failed, whatever it failed on. When the remediation
session leaves the branch head untouched and the gate answers identically,
tails included, the stage has asked the same question twice and got the
same answer against unchanged inputs; a third and fourth session cannot
change it. `BuildEvidence.stalled` carries that judgment (null when no
remediation session ran, so "not asked" is never read as "not stalled"),
`stage.build.result` journals it, and the daemon pauses on it instead of
retrying. The comparison includes the gate tails deliberately: two
different coupling violations both exit 1 on the same command, and only
one of them is the same wall. Found live on butler-ai, where attempt 2 of
009's build spent $3.16 and two sessions re-deriving one coupling
violation verbatim, and the remediation session had already reported that
no branch-side fix existed. This narrows what the retry budget is for: a
flaky or partial failure, not a deterministic one.
