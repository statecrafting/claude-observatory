---
id: "028-cli-projects"
title: "CLI v2: the projects group and project-scoped verbs"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: low
depends_on:
  - "023-orchestrator-cli"
  - "027-api-projects"
summary: >
  The orchestrator command group follows the API to v2: a projects
  subgroup (list, add, arm, disarm, requalify, remove), a --project flag
  scoping the existing verbs to a named project, a composite status that
  renders the daemon state plus one row per project, and an offline
  journal verify that resolves a project's state root through the daemon
  home's registry chain. Client-not-engine, exit codes, and the
  X-Control-Source discipline from 023 carry over unchanged.
establishes:
  # The v2 test surface (this spec's own FR coverage; §2 already said
  # "and its colocated tests", and 035/036's extends edges name this spec
  # as its owner; the graph now says what both always meant).
  - "src/commands/orchestrator.test.ts"
extends:
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: superseding }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 028: CLI v2, project-scoped

## 1. Purpose

If a capability exists it is reachable from a terminal (023's thesis);
the capabilities now include registering, arming, and observing many
projects, so the grammar grows to say which project it means.

## 2. Territory

`src/commands/orchestrator.ts` and its colocated tests (spec 023's unit,
superseded as declared). The build session amends spec 023 B-2's grammar
and D-1's composite-status description in place to the v2 contract; that
authority is granted here.

## 3. Behavior

- **B-1 (projects group).** `observatory orchestrator projects` lists the
  registry (name, armed, qualification, current run, one row each);
  `projects add <path> [--name <slug>] [--disarmed]`,
  `projects arm|disarm|requalify|remove <name>` issue the matching v2
  controls and print the journaled record, 023's control pattern.
- **B-2 (scoping flag).** `--project <name>` scopes dag, next, start,
  pause, resume, history, decisions, and the spec verbs to that project's
  v2 routes. `status` without `--project` is the new composite: daemon
  state (standby, driving, parked), global quota, and the per-project
  rows; with `--project` it renders that project's run and the global
  quota, the 023 D-1 composition against v2 shapes.
- **B-3 (offline verify).** `journal verify --project <name>` resolves
  the project's state root by folding the daemon home's projects chain
  directly (a file read, no API, exactly 023 B-4's stance), then walks
  both chains in that root; `journal verify --dir <path>` bypasses the
  registry for a bare state root. With neither flag it verifies the
  self-hosted root, today's behavior.
- **B-4 (carried rules).** Client-not-engine (023 B-1), human output with
  estimates named as estimates, `--json` printing served envelopes
  verbatim, exit codes 0/1/2/3 with 023 D-4's mapping, refused unknown
  flags, and `X-Control-Source: cli` all carry over. An unknown project
  name is an operational failure (exit 1): the daemon answered, the
  project does not exist.

## 4. Functional requirements

- **FR-001.** Command tests run against a fixture v2 API server; the
  projects group, the scoping flag, and the composite status are covered,
  and usage errors keep exit code 3 with a usage line on stderr.
- **FR-002.** Offline verify tests cover registry-resolved, explicit
  `--dir`, and default self-hosted roots with no daemon running.

## 5. Acceptance criteria

- **AC-1.** `bun test src/commands/orchestrator.test.ts` passes.
- **AC-2.** With the fixture daemon running,
  `observatory orchestrator status --json` returns the documented v2
  composite envelope.

## 6. Out of scope

Interactive TUI, shell completions, configuration profiles, and any
engine behavior (the daemon and API own it all).

## 7. Resolved decisions

D-1. `projects add --disarmed` is two controls, not one: `POST
/api/projects` registers (armed, because pointing the orchestrator at a
project is the consent, 010 D14) and `POST /api/projects/<name>/disarm`
holds it back, addressing the name the chain journaled rather than the one
the caller may not have passed. The v2 registration route carries no
`armed` field and the API is spec 027's territory, so the alternative was
widening a route this spec does not own. `--json` prints
`{ok: true, data: {registered, disarmed}}` composed from the two served
payloads, exactly 023 D-1's composition rule; without the flag the single
served envelope is printed verbatim. A registration that lands and a
disarm that then fails prints the served failure, exits 1, and says on
stderr that the project is registered and still armed: half-applied and
saying so beats a rollback this client has no right to perform.

D-2. `projects add <path>` resolves the path against the invoking shell's
working directory before it travels. The registry stores absolute paths
(025's `normalizeRepoDir` refuses anything else), and the daemon's own
working directory is not the operator's, so a relative path resolved
server-side would silently name a different repository than the one the
operator typed it in front of.

D-3. `journal verify` answers an unresolvable `--project` the way 023 D-5
answers a broken chain: `{ok: true, data: {verified: false, resolveError,
chains: []}}` with exit 1, and the reason on stderr in human mode. The
envelope gains `project` (which registry entry the root came from, null
for `--dir` and for the self-hosted default) and `resolveError`. The API's
error kinds are its vocabulary for what a request did, and no request was
made; the registry fold is a file read that either found the project or
did not.

D-4. Without `--project`, the verbs B-2 scopes keep resolving the sole
registered project, and refuse by name (a `conflict`, exit 1) when the
daemon holds several. The flag is how an operator says which project they
mean; guessing one out of several would journal an irreversible control
against a repository nobody named. Zero registered projects is a
`not-found` for the same reason.

D-5. A flag that is known but meaningless to the verb at hand is a usage
error, the same as an unknown one: `--project` on `daemon status`, or
`--name` on `projects arm`, exits 3 rather than being silently swallowed.
023 D-6 refuses `--jsonn` because silent flag-swallowing in a control
plane whose verbs journal irreversible facts is worse than an annoyance,
and a flag that parses but addresses nothing is the same defect wearing a
different hat. An unknown command is still reported as an unknown command
first, so a typo does not come back as a complaint about its flags.

D-6 (2026-08-02, spec 030's build, per its granted authority). Spec 030
adds one read verb additively: `economics [--project <name>]`, scoped
like the other read verbs (D-4's sole-project resolution and D-5's flag
discipline apply, and B-3's exit codes and `--json` verbatim-envelope
rule carry over). It fetches its single route directly, building the
path from the shared constants and mapping transport failure into the
envelope exactly as api-client.ts does, because that client is outside
030's declared territory.

D-7 (2026-08-02, recorded by the operator completing 031's build after
its session crashed mid-flight; authority granted in 031 §2). The
journal group gains `journal export --out <path> [--project <name>]`
and `journal verify --bundle <path>`. Export resolves its state root
exactly as B-3's offline verify does (registry fold, `--dir` bypass,
self-hosted default) and takes its own flag set as `projects add` does;
`--bundle` belongs to verify alone and is refused elsewhere. Exit codes
and flag discipline carry over unchanged.

D-8 (2026-08-05, spec 034's build, per its granted authority). The group
gains one offline read verb, `adopt preflight <path> [--out <path>]
[--exclude <rules>]`, dispatched before any client exists exactly like
`journal verify`: a preflight must work against a repository no daemon has
ever heard of, and 034 keeps API surfaces for a later spec. The target is
addressed by path, resolved shell-side (D-2's reasoning); when the
resolved path is a registered project's repoDir, the 034 B-6 record is
appended to that project's own state root through a short-lived writer
handle, and an append refused by a held lock is reported as the
operational failure it is, with the proposal already safely written.
`--out` defaults under the daemon home at `adoption/<name>.preflight.md`;
`--exclude` belongs to this verb alone (D-5) and accepts additions only
(034 D-2). Two rendering touches ride along: the qualification cell says
`adoptable (<failed checks>)` for a verdict recorded with 034 B-5's
reading, and `standbyProjects` swaps an adoptable project's DagReader for
034's refusing reader, which is what makes `dag` and `next` answer the
refusal by name (034 AC-3) while every other project's reader is
untouched.

D-9 (2026-08-06, spec 036's build, per its granted authority). The adopt
group gains its second offline verb, `adopt validate <project> --corpus
<ref-or-path>`, dispatched with no client exactly like preflight: it
folds the registry off disk to resolve the project (B-3's stance),
materializes the corpus per 036 D-5, prints the 036 B-2 report with a
denominator beside every number (036 FR-004), and appends the 036 B-3
record to the project's own state root through a short-lived writer
handle, a held lock reported as the operational failure it is. `--corpus`
belongs to this verb alone (D-5's flag discipline). Exit codes carry
over: usage is 3; an unknown project, an unusable corpus, or a history
too shallow to evaluate is 1; a completed replay is 0 whatever it
measured, because a low score is a finding, not a failure.
orchestrator.test.ts gains the verb's usage and AC-2 coverage.

D-10 (2026-08-06, spec 035's build, per its granted authority). The
adopt group gains `adopt synthesize <project> --proposal <path-or-hash>`,
offline of any daemon like its siblings but not free: it drives real
spec 014 sessions against the target under the project's execution
profile unless the test seam (`makeSynthesisSession` in the CLI deps)
injects scripted ones. The project resolves from the registry fold off
disk and must read adoptable (035 B-1); the proposal resolves by path,
or by sha256 through the project's journaled adopt.preflight records
with the document re-hashed on read (035 D-9). The project's work
journal is held open for the whole run (sessions journal into it, 033's
day floor folds it), so a live daemon driving the project refuses this
verb cleanly at the writer lock. `--proposal` belongs to this verb
alone (D-5's flag discipline). Exit codes: usage is 3; an unknown or
non-adoptable project, an unresolvable proposal, or a failed synthesis
is 1; a completed synthesis is 0. orchestrator.test.ts gains the verb's
usage and AC-2 coverage.

D-11 (2026-08-06, operator). A terminal run's row cell drops the
spec/stage suffix: `completed  033-cost-ceiling/build` read as work in
flight for a day on a settled project, and the last touched spec of a
finished run is history the detail views already carry. Live and
paused runs keep the suffix, because for them it is the answer to
"what is it doing".
