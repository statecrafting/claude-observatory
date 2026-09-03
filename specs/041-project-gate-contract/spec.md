---
id: "041-project-gate-contract"
title: "Project gate contract: per-project language gates as registry state"
status: approved
created: "2026-09-03"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "016-stage-build"
  - "025-project-registry"
  - "032-execution-profiles"
summary: >
  The post-session gate a driven target is judged by is hardcoded to this
  repo's conventions: four spec-spine commands plus `bun run typecheck`
  and `bun test`, with the Bun pair dropped whenever the target has no
  root tsconfig.json (016 D-10). A Rust target therefore passes the build
  stage on governance alone; cargo correctness reaches the pipeline only
  through whatever the session ran for itself and through CI in the
  shepherd stage. With two Rust targets about to be armed (rahi, then
  aicortex and hqgit on top of it), that gap is a claim the orchestrator
  makes without evidence. This spec makes the language gate per-project
  registry state, like the execution profile: a journaled gate contract
  (an ordered command list run after the universal spec-spine four),
  folded from the projects chain, probed to a default at registration
  (Makefile `ci` target, root tsconfig.json, or governance-only), derived
  into the stage's gate suite by one pure function every stage uses, and
  displayed wherever the project is named.
establishes:
  - "src/orchestrator/gate-contract.ts"
  - "src/orchestrator/gate-contract.test.ts"
extends:
  # New record kind, fold field, and mutation helper on the projects chain
  # (the 032 pattern for `profile`, applied to `gate`).
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.ts", nature: additive }
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.test.ts", nature: additive }
  # `gateCommandsFor(runner)` and its tsconfig probe are replaced by the
  # contract-derived suite; the exported constant stays as the universal
  # governance floor.
  - { spec: "016-stage-build", unit: "src/orchestrator/stages/build.ts", nature: superseding }
  - { spec: "016-stage-build", unit: "src/orchestrator/stages/build.test.ts", nature: additive }
  # Shepherd's remediation prompt lists the gate; it must list the
  # project's, not the repo's.
  - { spec: "018-stage-shepherd", unit: "src/orchestrator/stages/shepherd.ts", nature: additive }
  # The daemon threads the owning project's contract into every stage run.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  # The CLI and API surfaces that name a project render its gate. B-6 puts
  # the contract on the served project payload and B-7's write verb on the
  # registry route table, so the wire contract, the typed client the CLI
  # verb calls through, and the fixture registry the route tests drive all
  # take the same additive field (the 032 and 033 builds' own reasoning,
  # holding here unchanged).
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/state.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/types.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/api-client.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/fixtures.ts", nature: additive }
  # The colocated tests of extended units take the same additive edits:
  # FR-004 lives in the stage fixture worlds, FR-005 in the route and CLI
  # tests, and the web fixtures carry the served payload's new field so the
  # dashboard's own typecheck stays green without the UI rendering the gate
  # (deferred; see Out of scope). Tests move with the code they pin.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.test.ts", nature: additive }
  - { spec: "018-stage-shepherd", unit: "src/orchestrator/stages/shepherd.test.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.test.ts", nature: additive }
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.test.ts", nature: additive }
  - { spec: "029-ui-projects", unit: "web/test/fixtures.ts", nature: additive }
  - { spec: "029-ui-projects", unit: "web/test/store.test.tsx", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 041: Project gate contract

## 1. Purpose

Spec 016 B-5 says the build stage passes only when the gate commands exit 0
on the branch after the session ends, and that the session saying "done" is
not evidence. That sentence is only as strong as the command list behind it.
Today that list is this repo's: the four spec-spine commands and two Bun
commands, and 016 D-10 drops the Bun pair on any target without a root
tsconfig.json. For a Rust workspace the orchestrator's post-session verdict
is therefore "governance green", which says nothing about whether the crate
compiles or its tests pass. The first driven family repo (tenant-tail) found
this; rahi records it as its spec 001 D-1 and works around it by having the
session run `make ci` itself, which is precisely the self-authored evidence
016 exists to refuse.

The fix follows 032 exactly. The execution profile made session posture a
chosen, journaled, displayed fact instead of a hardcoded flag. This spec does
the same for the language gate: what commands a target is judged by is a
registry record, derived into the stage by one pure function, and visible
on every surface that names the project.

## 2. Territory

Owned: `src/orchestrator/gate-contract.ts` (the contract type, the
registration-time probe, the one derivation) and its tests. Extended, each
additively unless marked: the projects chain (a new record kind and fold
field), the build stage (the derivation replaces `gateCommandsFor`; the
exported `GATE_COMMANDS` constant remains as the universal floor), the
shepherd stage (remediation prompt lists the project's gate), the daemon
(threads the contract into each stage), and the CLI and API project
surfaces (render it).

Not claimed: the verify stage's `verify:cli` blocks (019), which are per-spec
assertions, not the per-project gate; the execution profile (032); CI
workflow content inside any target.

## 3. Behavior

- **B-1 (model).** A gate contract is `{commands: string[][], source:
  "probe" | "cli" | "api" | "ui"}`. `commands` is an ordered list of argv
  arrays run in the target's root after the universal governance floor
  (the four `spec-spine` entries of `GATE_COMMANDS`), each required to
  exit 0. An empty list is a legal contract meaning governance-only and
  is displayed as such; it is never the silent default for a target that
  has a language gate to run.
- **B-2 (probe at registration).** Registration appends a
  `project.gate.set` record whose commands come from a read-only probe of
  the target, in this order: a root `Makefile` with a `ci` target yields
  `[["make", "ci"]]`; else a root `tsconfig.json` yields `[["bun", "run",
  "typecheck"], ["bun", "test"]]` (today's D-10 behavior, now recorded);
  else a root `Cargo.toml` yields `[["cargo", "test", "--locked"]]`; else
  the empty list. The probe's verdict and which rule fired are part of
  the record, so a registration whose gate is governance-only says why.
  Requalification (025) re-runs the probe and appends a new record only
  when the derived commands differ from the current fold.
- **B-3 (chain, not table).** The contract is folded from the projects
  chain exactly as `profile` is (032 B-2). A chain with no gate record
  folds to the D-10 derivation (tsconfig probe at fold time is not
  possible without the tree, so: the Bun pair if the registration record
  carries `hasTsconfig`, else empty) flagged `legacy: true`, so pre-041
  registrations behave as before and every surface says so.
- **B-4 (one derivation).** `gateSuiteFor(contract)` in `gate-contract.ts`
  is a pure function returning the floor followed by the contract's
  commands, and is the only source of the stage gate list. `build.ts`'s
  preflight "gate green at base" (016 B-1), its post-session evidence
  (016 B-5), and shepherd's remediation prompt all consume its output; no
  caller composes a gate list by hand and `gateCommandsFor(runner)` is
  removed.
- **B-5 (journaled evidence).** The stage intent record carries the
  contract the stage was judged under (commands verbatim, source, legacy
  flag). Each command's exit code and bounded output are journaled as
  today (016 B-5); what list produced them is thereafter a journal fact.
- **B-6 (visible gate).** The gate appears wherever the project does: the
  `projects` list line (compact: `make ci`, `bun`, `cargo`, or
  `governance-only`), the project detail view, the API project payload,
  and the registration output. A legacy-derived gate renders
  distinguishably from a probed or operator-set one.
- **B-7 (operator override).** `projects gate <name> -- <argv>...` (CLI)
  and the matching API verb append a `project.gate.set` record with
  source `cli` or `api`. An override that would drop a command the probe
  found is allowed and journaled; the orchestrator records the choice, it
  does not second-guess it.

## 4. Functional requirements

- **FR-001.** Fold tests cover: no gate record (legacy, with and without
  `hasTsconfig`), a probed record, an operator override, a requalification
  that changes the probe, and interleaving with profile and arm records;
  chain verification passes over every fixture history.
- **FR-002.** Probe tests run against fixture directories: a Makefile with
  a `ci` target, a Makefile without one plus a tsconfig.json, a Cargo-only
  workspace, and an empty directory; each yields the B-2 commands and
  names the rule that fired.
- **FR-003.** Derivation tests: the suite always begins with the four
  spec-spine floor commands in `GATE_COMMANDS` order; a contract's
  commands follow verbatim; an empty contract yields exactly the floor.
- **FR-004.** A stage test drives the build stage's preflight and
  post-session gate through a fixture Runner recording the commands it
  was asked to run, under a `make ci` contract, and asserts `make ci`
  ran in both places; the same fixture under a legacy empty contract runs
  exactly today's spec-spine-only list.
- **FR-005.** Surface tests: CLI list and detail render the gate (legacy
  marked), and the API project payload carries the contract.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/gate-contract.test.ts` passes.
- **AC-2.** The FR-004 stage assertions pass inside the existing build
  stage fixture world.
- **AC-3.** `observatory orchestrator projects` renders a gate for every
  project, including `governance-only (legacy)` for a chain with no gate
  record and no `hasTsconfig`.
- **AC-4.** `grep -n gateCommandsFor src/` finds no production call site.

## Verification

```verify:cli
bun test src/orchestrator/gate-contract.test.ts
```

```verify:cli
bun test src/orchestrator/stages/build.test.ts
```

```verify:cli
test -z "$(grep -rn 'gateCommandsFor' src --include='*.ts' | grep -v '\.test\.ts')"
```

## 6. Out of scope

Running the gate inside a container or with a resource ceiling (033 owns
economics, 032 owns posture); per-spec gate overrides; treating a target's
CI as the gate (shepherd already watches it; this spec makes the local
verdict honest, it does not replace CI); parsing `make` or `cargo` output
beyond exit codes; and any change to the universal spec-spine floor, which
stays 016's.

The dashboard is also out. B-6's surfaces are the CLI and the API, which is
what FR-005 and AC-3 pin; the web project views keep rendering what they
render today, and the two `web/test/` edges above exist only so the served
payload's new field does not break the dashboard's typecheck. Rendering the
gate in the UI is a later spec's, the way 030 left its panel to 038.

## 7. Resolved decisions

D-1. `make ci` outranks a tsconfig or Cargo probe. A repo that publishes a
`ci` target has stated its gate in one place for humans, CI, and the
orchestrator alike; guessing a language command under it would create a
second, weaker definition of green. The Cargo fallback exists for targets
that have not written the target yet, and `--locked` is part of it because
a lockfile drift is a gate failure, not a build step.

D-2. The legacy fold does not re-probe the tree. Folding is a pure function
over the chain (025), and reaching into the filesystem during a fold would
make the same history fold differently on two machines. The registration
record gains a `hasTsconfig` boolean so the pre-041 behavior is reproducible
from the chain alone; a requalification appends a real gate record and ends
the legacy state.
