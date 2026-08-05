---
id: "032-execution-profiles"
title: "Execution profiles: per-project session posture as registry state"
status: approved
created: "2026-08-05"
authors: ["Bartek Kus"]
kind: feature
implementation: complete
risk: high
depends_on:
  - "014-session-driver"
  - "025-project-registry"
summary: >
  Every driven session today runs with --dangerously-skip-permissions
  hardcoded at the one argv construction site, whatever the target. For
  the self-hosted checkout that was a defensible bootstrap; for a general
  builder it conflates two consents: arming a project consents to being
  driven, and nothing separately consents to the execution posture the
  drive runs under. This spec makes posture per-project registry state: a
  journaled execution profile (bypass or guarded with an explicit tool
  allowlist), folded from the projects chain like armed, derived into
  session argv by one pure function that every spawn path uses, recorded
  in the journal for every session, and displayed on every surface that
  names the project. A project with no profile record folds to bypass
  marked legacy, so existing registrations keep today's behavior while
  losing today's silence.
establishes:
  - "src/orchestrator/profile.ts"
  - "src/orchestrator/profile.test.ts"
extends:
  # New record kind, fold field, and mutation helper on the projects chain.
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.ts", nature: additive }
  # The hardcoded flag at the argv construction site is replaced by the
  # profile-derived argument list.
  - { spec: "014-session-driver", unit: "src/orchestrator/session.ts", nature: superseding }
  # The daemon threads each project's profile into every session spawn.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  # B-4 admits no spawn path with a hardcoded posture, and two production
  # session factories sit between the daemon and the driver: the build
  # stage's Runner (which ship and shepherd drive through) and the verify
  # stage's browser verifier (D-3 grants it no special case). Each takes the
  # profile as one more injected parameter; neither stage's contract moves.
  - { spec: "016-stage-build", unit: "src/orchestrator/stages/build.ts", nature: additive }
  - { spec: "019-stage-verify", unit: "src/orchestrator/stages/verify.ts", nature: additive }
  # One write verb and posture rendering in the projects surfaces.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/state.ts", nature: additive }
  # B-6 puts the posture in the served project payload and the write verb on
  # the registry route table, so the wire contract, the typed client the CLI
  # verb calls through, and the fixture registry the route tests drive all
  # take the same additive field. No served shape loses anything.
  - { spec: "027-api-projects", unit: "src/orchestrator/api/types.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/api-client.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/fixtures.ts", nature: additive }
  # The colocated tests of extended units take the same additive edits: the
  # registry fold tests grow posture cases, the route tests cover the profile
  # control, and the web fixtures carry the served payload's new field. Tests
  # move with the code they pin.
  - { spec: "025-project-registry", unit: "src/orchestrator/projects.test.ts", nature: additive }
  - { spec: "027-api-projects", unit: "src/orchestrator/api/server.test.ts", nature: additive }
  - { spec: "029-ui-projects", unit: "web/test/fixtures.ts", nature: additive }
  - { spec: "029-ui-projects", unit: "web/test/store.test.tsx", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 032: Execution profiles

## 1. Purpose

Consent to build is not consent to unsandboxed execution. 010 D14 made
pointing the orchestrator at a project the consent to drive it; this spec
splits off the second consent that D14 was silently carrying: what the
driven session is allowed to do on the operator's machine. The posture
becomes recorded, per-project, operator-owned state with the same
chain-not-table discipline as everything else in the registry, and the
sessions that ran under a posture carry it in the journal as evidence.

## 2. Territory

`src/orchestrator/profile.ts` and its colocated tests: the profile model,
the fold contribution, and the pure argv derivation. Extensions as
declared in `extends`: the new record kind and fold field in
`projects.ts`, the argv construction site in `session.ts`, profile
threading in `daemon.ts`, and the verb plus rendering in the CLI and API
surfaces. The build session is granted authority to record additive D-n
notes in specs 025, 021, 027, and 028 for those mechanical additions, per
the coherence guard's explicit-authority clause; it does not amend their
B-level contracts. 014's B-level session contract is amended only at the
argv construction site named here.

## 3. Behavior

- **B-1 (model).** A profile is `{mode, allowedTools?, disallowedTools?}`.
  `mode: "bypass"` reproduces today's posture exactly: the session argv
  carries `--dangerously-skip-permissions` and no allowlist flags.
  `mode: "guarded"` never emits the bypass flag: the argv carries
  `--permission-mode acceptEdits` plus the profile's tool allowlist (and
  disallowlist when present). The two modes are mutually exclusive by
  construction: no derivable argv contains both the bypass flag and an
  allowlist.
- **B-2 (chain, not table).** The profile is registry state: setting it
  appends a record (new kind, `project.profile.set`) carrying the full
  profile and its source (cli, api, ui), folded into the project exactly
  as `armed` is (025 B-2). A project whose chain holds no profile record
  folds to `{mode: "bypass"}` flagged `legacy: true`: existing
  registrations behave as before, and every surface says so out loud.
  Registration henceforth appends an explicit profile record alongside
  the registration record, so `legacy` can only describe pre-032 history.
- **B-3 (one derivation).** `sessionArgsForProfile(profile)` is a pure
  function in `profile.ts` and is the only source of permission-related
  argv. `session.ts` consumes its output; no caller composes permission
  flags by hand. For `bypass` the derived argv is byte-identical to
  today's hardcoded construction.
- **B-4 (every spawn path).** Every session the orchestrator spawns
  (build, ship, shepherd remediation, verify including its browser MCP
  sessions, and any recovery or probe drive) receives the owning
  project's profile through the same derivation. There is no spawn path
  with a hardcoded posture left.
- **B-5 (journaled evidence).** The session intent record carries the
  profile the session was spawned under (mode and the lists verbatim).
  What posture a session actually had is thereafter a journal fact, not
  an inference from registry history.
- **B-6 (visible posture).** The posture appears wherever the project
  does: the `projects` list line, the project detail view, the API
  project payload, and the registration output. A legacy-derived bypass
  renders distinguishably from an operator-set bypass. No surface ever
  omits the posture or prints a blank for it.

## 4. Functional requirements

- **FR-001.** Fold tests cover: no profile record (legacy bypass), an
  explicit set, a change, and interleaving with arm/disarm; chain
  verification passes over every fixture history.
- **FR-002.** Derivation tests: bypass yields exactly the current argv's
  permission portion; guarded yields no bypass flag under any input;
  allowlist and disallowlist pass through verbatim; the baseline
  allowlist constant (D-2) is included when the profile does not replace
  it.
- **FR-003.** A spawn-path test drives a fixture session (fake claude
  binary recording its argv) through the daemon with a guarded project
  and asserts the recorded argv contains the allowlist and not the
  bypass flag; the same fixture under bypass matches today's argv.
- **FR-004.** Surface tests: CLI list and detail render the posture
  (legacy marked), and the API project payload carries the profile.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/profile.test.ts` passes.
- **AC-2.** The FR-003 spawn-path assertions pass inside the existing
  daemon fixture world.
- **AC-3.** `observatory orchestrator projects` renders a posture for
  every project, including `bypass (legacy)` for a chain with no profile
  record.

## 6. Out of scope

Container, VM, or network isolation (an execution profile constrains the
session's tool surface, not the host); per-stage or per-spec profile
overrides; retroactive judgment of sessions journaled before this spec;
any change to hook semantics (hook-blocked stays a terminal stage outcome
per 016); and trust-ladder automation that would change a profile without
an operator record.

## 7. Resolved decisions

D-1. Registration without an explicit profile flag records `bypass`, not
`guarded`. A guarded default would need an allowlist chosen sight unseen,
and an empty or wrong one cannot run the governed gate, converting every
default registration into a broken build. The safety this spec adds is
that the posture is chosen, journaled, and displayed, never that a
default silently flips under operators who registered targets before it
existed. The consent split stands: `armed` consents to driving, the
profile consents to posture, and both are appended records with sources.

D-2. The guarded baseline allowlist is exported, reviewable data in
`profile.ts` (031 FR-002's precedent of policy as tested constants): the
governed loop's own commands (git, gh, bun, spec-spine, and the file
tools) so that a guarded session can still drive build, gate, and ship.
A profile may extend it or replace it entirely; replacing it with less
than the loop needs is an operator's right and their gate failure to
read.

D-3. Verify-stage browser sessions get no special case: they are spawned
through the same derivation (B-4). A guarded profile that omits the
browser MCP tools fails browser assertions honestly at the verify gate
rather than escalating itself.

D-4 (build session). Every guarded flag is emitted as one `flag=value`
argv element, never as a flag and a separate value. The real CLI's tool
flags are variadic, so a space-separated allowlist whose entry began
with `--` would end the list and be parsed as a flag in its own right;
an entry of the bypass flag itself would then derive exactly the argv
B-1 forbids. Joined with `=`, an operator's list can only ever be read
as a value, which is what makes B-1's mutual exclusion structural
rather than conventional.

D-5 (build session). Tool lists travel comma-joined, one flag to one
argv element, and an effective allowlist that is empty emits no flag at
all. The write verbs (CLI and API) refuse two profiles rather than
journaling ambiguity: a bypass profile carrying tool lists it can never
honor, and a guarded profile with an explicit empty allowlist, whose
derived argv would be indistinguishable from "no allowlist at all".

D-6 (build session). Seams receive the profile late-bound (a reader,
resolved at spawn time) rather than as a value captured at wiring time:
the scheduler builds a project's seam set once per process, so a
captured value would mean a posture an operator tightened does not
apply until the daemon restarts. The registration default doubles as
the absent-source derivation, byte-identical to the pre-032 argv.

D-7 (build session). B-6's surfaces grew one write path each: a
`projects profile` CLI verb and a project-scoped API control, both
carrying the whole profile, never a patch, so the journaled record is
the posture and not a diff against unstated state. Registration appends
the posture as its own record beside the registration record (one kind,
one consent), which is what keeps `legacy` capable of describing only
pre-032 history.

D-8 (operator, 2026-08-05). Provenance: build attempt 1 consumed two
sessions, both terminated `max-turns` (journaled, 14.08 USD combined),
leaving the implementation complete but for one type error and these
unrecorded decisions; attempt 2 refused on the dirty tree the dead
session left. The operator completed the build from the session's own
work (the 031 D-1 precedent): exported `qualificationPayload` so the
API fixtures' legacy-chain path encodes verdicts exactly as
`registerProject` does, and recorded D-4 through D-7 from the code and
its tests. The spec's turn budget being too small for its territory is
noted for the 033/034 build sessions to come.
