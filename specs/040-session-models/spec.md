---
id: "040-session-models"
title: "Session models: the model a driven session runs on is chosen per stage, not inherited"
status: approved
created: "2026-09-02"
authors: ["Bartek Kus"]
kind: feature
implementation: complete
risk: medium
depends_on:
  - "014-session-driver"
  - "032-execution-profiles"
summary: >
  Spec 014 accepts an optional model and appends `--model` when one is
  given; nothing has ever given one. Every driven session therefore
  runs on whatever the CLI's own default resolves to at spawn time, a
  value the orchestrator neither chooses, records, nor can reproduce:
  the journal's `model` field has been null for all 44 sessions it has
  written, while the transcripts of the butler-ai run show 548
  assistant turns on a model nobody selected. This spec makes the model
  the same kind of thing 032 made the permission posture: derived by
  one pure function from reviewable data, carried on the project's
  execution profile, journaled with every session, and shown wherever
  the posture is. Stages are tiered, because they are not equally hard:
  build and ship take the strong model, shepherd and verify take the
  fast one.
establishes:
  - "src/orchestrator/models.ts"
  - "src/orchestrator/models.test.ts"
extends:
  # The profile carries the tier pair: one record already answers "under
  # what posture does this project's session run", and this is part of that
  # answer (D-2).
  - { spec: "032-execution-profiles", unit: "src/orchestrator/profile.ts", nature: additive }
  - { spec: "032-execution-profiles", unit: "src/orchestrator/profile.test.ts", nature: additive }
  # callStage is the one place that knows which stage is about to spawn, so
  # it is where the tier becomes a model id.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.test.ts", nature: additive }
  # D-6: the verify stage spawns no session of its own, so the verify tier is
  # resolved where its only model session is, at the browser verifier seam.
  - { spec: "019-stage-verify", unit: "src/orchestrator/stages/verify.ts", nature: additive }
  # The profile verb and the project detail view grow the pair.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.test.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 040: Session models

## 1. Purpose

An orchestrator that adjudicates completion deterministically should not
be indifferent to the single largest variable in what it costs and how
well it works. Today it is: `--model` is never passed, so the model is
whatever the CLI resolves by default in whatever environment the daemon
happens to have been started from. That is not a choice, it is an
inheritance, and it is invisible: the one field that would have recorded
it has been null since 014 shipped.

The fix is the shape 032 already established for the other thing a spawn
inherits. Posture stopped being a hardcoded flag and became journaled
registry state derived by one function. The model becomes the same, with
one addition posture did not need: stages differ enough in difficulty
that one model for all four is either wasteful at the bottom or weak at
the top (D-1).

## 2. Behavior

- **B-1 (one derivation).** `modelForStage(stage, models)` is the only
  place a `--model` value is produced in this codebase, exactly as
  `sessionArgsForProfile` is the only place a permission flag is
  (032 B-3). No spawn path composes a model by hand, and no spawn path
  omits one: after this spec, every driven session's argv carries an
  explicit `--model`.
- **B-2 (tiers as data).** The stage-to-tier map is reviewable, tested
  data rather than branching: `build` and `ship` take `strong`,
  `shepherd` and `verify` take `fast`. A tier is a role, not a model id;
  the ids sit behind it so an operator can move a project without
  touching the map.
- **B-3 (the default pair).** Absent an override the tiers resolve to
  `claude-opus-5` (strong) and `claude-sonnet-5` (fast). Neither is a
  long-context variant: a 1M-context id costs more per token for a
  window a stage session has never needed, and choosing it is an
  operator decision this spec will not make silently (D-4).
- **B-4 (override on the profile).** A project may carry its own pair on
  its execution profile, journaled on the projects chain and folded like
  every other field of it. Both halves travel together: a profile
  carries a complete pair or none at all, and a half-set pair is refused
  by the same validation that refuses an empty guarded allowlist
  (D-3). No new record kind, no second verb, no second fold.
- **B-5 (journaled, finally).** `session.init`'s `model` field stops
  being null. What a session ran on becomes a journal fact for the same
  reason 032 B-5 made the posture one: it is the difference between
  reproducing a run and guessing at it.
- **B-6 (surface).** Every surface that renders the posture renders the
  pair beside it. A project on the defaults says so rather than showing
  a blank, because "nobody chose" is precisely the state this spec
  exists to end.

## 3. Functional requirements

- **FR-001.** `modelForStage` is total over `Stage` and returns a
  non-empty id for every one of the four.
- **FR-002.** The stage-to-tier map is exhaustive over `Stage` at the
  type level: adding a stage without assigning it a tier does not
  compile.
- **FR-003.** A profile payload round-trips its pair: written, folded
  back off the chain, and rendered without loss.
- **FR-004.** A payload carrying one half of the pair throws the typed
  parse error rather than defaulting the other half.
- **FR-005.** The refusal text names which half is missing.

## 4. Acceptance criteria

- **AC-1.** A test drives the pipeline through the daemon with recording
  stage functions and asserts each stage spawn carried its tier's model
  id: build and ship on strong, shepherd on fast. Verify's tier is
  asserted at the browser verifier, which is the only session that
  stage spawns (D-6).
- **AC-2.** A session driven end to end journals a non-null `model` in
  `session.init`, and the value equals the one the argv carried.
- **AC-3.** The project detail every control verb prints carries the
  pair, marked as the default when the profile holds none.
- **AC-4.** `orchestrator projects profile <name> <mode>
  --model-strong <id> --model-fast <id>` records the pair, and a
  subsequent read folds it back identically.
- **AC-5.** `bun run typecheck` and `bun test` pass.

## 5. Out of scope

- Per-spec or per-attempt model choice. The tier is a property of the
  stage and the project, not of the work item; a spec that needs a
  stronger model than its project's pair is a signal about the project.
- Automatic escalation on failure (retry the same stage on a stronger
  model). It is an attractive policy and a separate spec: it changes
  what a stage retry means, which 013's state machine owns.
- Model availability checking. An id the CLI rejects fails the spawn
  with the CLI's own error, which is a better message than any
  precheck this repo could write.

## 6. Resolved decisions

- **D-1 (tiered rather than uniform).** Three shapes were considered:
  one model everywhere, a tier per stage, and a per-spec choice. One
  model everywhere is either the strong model on stages that mostly
  poll CI and read assertion output, or the fast model on the two
  stages that write code and argue with a governance gate. The last 43
  journaled sessions were 33 verify and shepherd against 10 build and
  ship, so the cheap tier covers most of the volume without touching
  the two stages where quality is load-bearing. Per-spec choice is
  out of scope above.
- **D-2 (on the profile, not a new record).** A model tier is the same
  category of fact as the permission posture: operator-owned,
  per-project, consulted at spawn, and meaningless outside a spawn. It
  folds where the posture folds, is set by the verb that sets the
  posture, and is displayed where the posture is displayed. A second
  chain record for it would duplicate 032's fold, verb, payload codec
  and rendering to say something the same record already has room for.
- **D-3 (both halves or neither).** A half-set pair would have to mix
  an operator's id with a default, which makes the effective model of a
  stage a function of two sources and defeats the predictability that
  motivated the spec. Refusing it costs an operator one extra flag and
  buys a profile that can be read as written.
- **D-4 (no long-context ids by default).** `claude-opus-5[1m]` is the
  interactive default on this machine, and inheriting it is how the
  driven sessions were paying long-context rates. The default pair is
  the plain ids; an operator who wants a 1M window for a project sets
  it explicitly, which is the whole point of B-4.
- **D-5 (the map is data, the ids are policy).** `STAGE_MODEL_TIERS`
  changes only when the set of stages changes, which is 013's business.
  `DEFAULT_SESSION_MODELS` changes when the model lineup does, which is
  nobody's business but a version bump. Keeping them separate means the
  common change touches one line of data and no logic.
- **D-6 (the verify tier resolves at the browser verifier).** The other
  three stages spawn a session directly and take the model as a stage
  option. The verify stage spawns none: its only model session belongs
  to the browser verifier it is handed, which already resolves the
  project's profile at spawn time for 032's sake. The tier is resolved
  in the same place, for the same reason, rather than threaded through
  a stage option the stage would only forward. B-1 still holds, and it
  is the reason this is written down: the derivation has one home, but
  it has two callers, and a reader counting three stage options would
  otherwise conclude verify was missed.
