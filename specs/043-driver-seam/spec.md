---
id: "043-driver-seam"
title: "The driver seam: the engine loses its provider-specific contract"
status: approved
created: "2026-09-09"
authors: ["Bartek Kus"]
kind: feature
implementation: complete
risk: high
depends_on:
  - "014-session-driver"
  - "016-stage-build"
  - "019-stage-verify"
  - "021-orchestrator-daemon"
  - "032-execution-profiles"
  - "040-session-models"
  - "042-member-contract"
summary: >
  Spec 042 packaged three members without moving a function; the engine
  member still imports the Claude driver directly and its compiled binary
  carries every Claude invocation string session.ts knows. This spec is
  the surgery 042 deferred. The engine gains one provider-neutral seam,
  `src/orchestrator/driver.ts`: a request the engine writes, an event
  stream it reads, and a result it journals, none of which names a
  provider. The Claude driver member gains the `session run` verb that
  speaks that protocol over stdio, wrapping spec 014's runSession
  unchanged. Every engine path that drove a session (the build runner
  that ship and shepherd share, the verify stage's browser verifier, the
  synthesis sessions, the daemon's shutdown kill) drives it through the
  seam by spawning the driver member as a process, which is the boundary
  doc 02 D25 keeps. The proof is mechanical: the compiled
  statecraft-engine contains no Claude invocation string, and the
  session.init and session.result records the engine journals are
  byte-identical to the ones the in-process path wrote. A second driver
  is then two small files and no engine change (doc 02 D26), which is
  what "ready for a Codex driver" means.
establishes:
  - "src/orchestrator/driver.ts"
  - "src/orchestrator/driver.test.ts"
  - "src/members/dispatch.ts"
  - "src/members/driver-session.ts"
  - "src/members/driver-session.test.ts"
  - "src/members/engine-bundle.test.ts"
extends:
  # 042 owns the member entrypoints and manifest; the driver gains a verb
  # (`session`), the manifest's verbs list grows with it, and every
  # entrypoint hands the dispatcher its own verb table (D-8).
  - { spec: "042-member-contract", unit: "src/members/driver.ts", nature: additive }
  - { spec: "042-member-contract", unit: "src/members/manifest.ts", nature: additive }
  - { spec: "042-member-contract", unit: "src/members/sensor.ts", nature: additive }
  - { spec: "042-member-contract", unit: "src/members/engine.ts", nature: additive }
  # 005 owns the dispatcher; its switch becomes a verb table it still owns,
  # over a dispatch function that carries no verb imports (D-8).
  - { spec: "005-cli-surface", unit: "src/index.ts", nature: additive }
  # 040 owns the model choice; the default pair leaves for the driver (D-7).
  - { spec: "040-session-models", unit: "src/orchestrator/models.ts", nature: additive }
  # 016 owns the runner the three code-writing stages share.
  - { spec: "016-stage-build", unit: "src/orchestrator/stages/build.ts", nature: additive }
  # 019 owns the browser verifier.
  - { spec: "019-stage-verify", unit: "src/orchestrator/stages/verify.ts", nature: additive }
  # 021 owns the production daemon wiring, 026 the standby wiring.
  - { spec: "021-orchestrator-daemon", unit: "src/orchestrator/daemon.ts", nature: additive }
  - { spec: "026-standby-daemon", unit: "src/orchestrator/standby.ts", nature: additive }
  # 035 drives synthesis sessions through the same seam.
  - { spec: "035-corpus-synthesis", unit: "src/orchestrator/adopt/synthesis.ts", nature: additive }
  # 023 owns the CLI: the synthesis session it constructs drives through
  # the seam, and the shutdown kill reaches the seam's live session.
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: additive }
  # 017 and 018 own the two stages that spawn through the shared runner;
  # each gains the tier field it passes along (B-1).
  - { spec: "017-stage-ship", unit: "src/orchestrator/stages/ship.ts", nature: additive }
  - { spec: "018-stage-shepherd", unit: "src/orchestrator/stages/shepherd.ts", nature: additive }
  # The tests that asserted the engine names a model id now assert it names
  # a tier (D-7), and the spawn-path tests cross the process boundary.
  - { spec: "040-session-models", unit: "src/orchestrator/models.test.ts", nature: additive }
  - { spec: "040-session-models", unit: "src/orchestrator/daemon.test.ts", nature: additive }
  - { spec: "040-session-models", unit: "src/commands/orchestrator.test.ts", nature: additive }
  - { spec: "032-execution-profiles", unit: "src/orchestrator/profile.test.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/01-umbrella-cli-and-member-seams.md" }, role: context }
  - { unit: { kind: file, path: "docs/design/02-the-monorepo-and-the-rust-sequence.md" }, role: context }
---

# 043: The driver seam

## 1. Purpose

Doc 01 D13 says provider knowledge lives in a driver or a sensor and the
engine never gains a provider-specific contract. After 042 that is a
statement about intent, not about the binary: `statecraft-engine` is
compiled from an entrypoint whose import graph reaches `session.ts`,
`classify-termination.ts`, `models.ts` and the Claude half of `profile.ts`,
so the engine member knows how to spawn `claude`, what its stream-json
looks like, which of its error strings mean quota, and which model ids
exist. A Codex driver written against that engine would have to be a
second import into the same graph, and D26's "two small crates and no
engine change" would be false on day one.

This spec makes D13 true of the binary. The engine keeps exactly one seam
for driving a session, `driver.ts`, whose request, events and result are
provider-neutral, and it reaches a driver the only way a member reaches
another member: by spawning it as a process (doc 02 D25) and speaking a
line-delimited protocol on its stdio. The Claude driver member implements
that protocol by wrapping spec 014's `runSession` as it stands. Nothing
about how Claude is spawned, parsed or classified changes; what changes is
who is allowed to know it.

## 2. Territory

Owned: `src/orchestrator/driver.ts` (the `Driver` interface, the request,
event and result shapes, the process driver and its journaling), its test,
`src/members/dispatch.ts` (the verb dispatcher with no verb imports, D-8),
`src/members/driver-session.ts` (the driver member's `session run` verb:
stdin request, stdout events, spec 014 underneath, and the default model
pair) and its test, and `src/members/engine-bundle.test.ts` (the proof
that the compiled engine is provider-free).

Extended: the member entrypoints and manifest (042), the dispatcher
(005), `models.ts` (040), the build runner (016), the browser verifier
(019), the production daemon and standby wiring (021, 026), the synthesis
sessions (035) and the CLI (023). Every extension replaces an import of
`session.ts` with a call through the seam; none changes what a stage does
with the result. `session.ts` itself is untouched.

Not claimed: `classify-termination.ts`, `models.ts` and the argv half of
`profile.ts`, which stay exactly where they are and become reachable from
the driver member alone; the quota scheduler's transcript-activity probe
(015 B-5), which reads `~/.claude` and is sensor territory for a later
spec; any change to the manifest schema (042 B-3 is unchanged, the tier
field is what this spec consumes); the umbrella (statecraft-cli 008),
which dispatches to the driver member without knowing this verb exists.

## 3. Behavior

- **B-1 (one seam).** `driver.ts` exports `Driver`:

  ```
  interface Driver {
    readonly name: string;                 // "claude"
    readonly tier: "reference" | "basic";  // from the member manifest
    runSession(request: DriverSessionRequest): Promise<SessionResult>;
    killLiveSession(graceMs?: number): boolean;
  }
  ```

  `DriverSessionRequest` is `{repo, prompt, tier?, model?, maxTurns?,
  timeoutMs?, mcpConfigPath?, profile, killGraceMs?}` plus the two engine
  callbacks the process cannot carry, `journal?` and `sink?`. `tier` is a
  model tier (`"strong" | "fast"`, 040 B-2); `model` is an explicit id
  and wins when present, exactly as 040 B-1 resolves it today. Nothing in
  the request names a binary, a flag or a stream format.
- **B-2 (the protocol).** `statecraft-driver-claude session run` reads one
  JSON object from stdin until EOF, the request minus `journal` and `sink`,
  and writes line-delimited JSON to stdout:

  ```
  {"event":"journal","kind":"session.init","payload":{...}}    what 014 journals, forwarded
  {"event":"stream","raw":...}                                  every parsed provider event, verbatim
  {"event":"journal","kind":"session.result","payload":{...}}
  {"event":"result","result":{...}}                             once, last: the SessionResult
  ```

  A `journal` event is one append 014 would have made, kind and payload
  verbatim; `result` carries the `SessionResult` field for field.
  Diagnostics go to stderr. Exit is 0 when
  a `result` was written, whatever its classification: a quota park or a
  timeout is an answer, not a driver failure. Exit 3 is a request that
  does not parse (usage, 023 D-4); exit 1 is the driver failing to run the
  provider at all. The umbrella passes these through (008 §7).
- **B-3 (the engine journals, from the events).** `session.init` and
  `session.result` are written by the engine from the `journal` events,
  with payloads byte-identical to what `runSession` wrote when it held the
  journal itself. The chain shape does not change; a bundle
  exported after this spec verifies under the reader shipped before it.
  The driver member never receives a journal path and never writes one.
- **B-4 (spawn, kill, deadline).** The process driver spawns the member
  with argv only, no shell (042 B-7), writes the request, closes stdin, and
  reads until the member exits. `killLiveSession` sends SIGTERM to the
  member process; the member forwards it to the provider child through
  014's grace-then-SIGKILL path, so the daemon's shutdown (021 B-6) severs
  the same thing it severed before. The wall-clock deadline is enforced by
  the member (014 B-5); the engine additionally kills a member that has
  not written `result` within the deadline plus grace, and classifies that
  as `crashed` with the detail naming the driver.
- **B-5 (discovery).** The engine finds `statecraft-driver-<name>` the way
  the umbrella does (008 §2): `STATECRAFT_MEMBER_DIR`, else the platform
  managed directory, else `PATH`. An explicit `driverBin` (the CLI's
  `--driver-bin`, the daemon's `driverBin` param) wins over discovery and
  is what every test passes. When nothing is found and the engine is
  running from source (`import.meta.dir` is a real path), it falls back to
  `bun src/members/driver.ts` in this repository, so `observatory` keeps
  working in a checkout with no members built. A compiled engine with no
  discoverable driver fails the session as `crashed` with the detail
  naming the three locations searched.
- **B-6 (the tier is consumed).** The engine reads the driver's manifest
  once at construction (042 B-3, the same `--member-manifest` call the
  umbrella makes) and keeps its `capabilityTier`. A request carrying
  `mcpConfigPath` against a `basic` driver is not sent: the engine journals
  `driver.degraded` `{driver, tier, feature: "mcp-config"}` (doc 01 D22)
  and the caller receives a result classified `crashed` with the detail
  naming the missing feature. The browser verifier therefore records a
  degraded assertion as not passed, never as passed and never silently.
- **B-7 (nothing else knows).** After this spec the engine entrypoint's
  import graph does not reach `session.ts`, `classify-termination.ts` or
  `models.ts`. `profile.ts` stays shared because its posture, tool lists
  and model pair are engine data (032 B-2, 040 B-4); its argv derivation
  `sessionArgsForProfile` is consumed only under `src/members/` and
  `session.ts`. The synthesis sessions (035), which called `runSession`
  directly, go through the same `Driver`.
- **B-8 (the knobs).** `STATECRAFT_DRIVER_BIN` names the driver command
  and wins over discovery (B-5). `claudeBin` in `session.ts` is untouched:
  it is the driver's own knob, and the driver member reads
  `STATECRAFT_CLAUDE_BIN` for it. No CLI flag ever named the provider
  binary, so none is renamed.

## 4. Functional requirements

- **FR-001.** A unit test drives `createProcessDriver` against a fake
  driver script that echoes a scripted event stream, and asserts: the
  request arrives on stdin as one JSON object and stdin is closed; every
  `stream` event reaches the sink verbatim; the returned `SessionResult`
  equals the `result` event; `session.init` and `session.result` are journaled
  with the payload shapes `session.test.ts` asserts for the in-process
  path, compared field for field.
- **FR-002.** A member test runs `bun src/members/driver.ts session run`
  with a request naming a fake `claude` script (014's own fixture
  convention, through `STATECRAFT_CLAUDE_BIN`) and asserts the three event
  kinds appear in order on stdout, that stderr carries no event, that the
  exit code is 0 for a completed, a quota and a timed-out session alike,
  and 3 for a request that does not parse.
- **FR-003.** A kill test starts a session against a fake driver that
  sleeps, calls `killLiveSession`, and asserts the member received SIGTERM
  and the result is classified `killed`; a deadline test asserts a member
  that never writes `result` is killed at the deadline plus grace and
  classified `crashed`.
- **FR-004.** A degradation test constructs the process driver over a
  manifest declaring `basic`, sends a request with `mcpConfigPath`, and
  asserts the driver is never spawned, `driver.degraded` is journaled, and
  the browser verifier reports the assertion as not passed with the
  feature named.
- **FR-005.** `engine-bundle.test.ts` builds `statecraft-engine` and
  asserts the binary contains none of: `stream-json`,
  `--dangerously-skip-permissions`, `--permission-mode`, `claude-opus`,
  `claude-sonnet`, `ANTHROPIC_API_KEY`. It asserts the driver binary
  contains all of them, so the test fails loudly if the strings ever move
  rather than passing vacuously.
- **FR-006.** The three stages' tests keep passing with their fake
  sessions injected through the `Runner` and `BrowserVerifier` seams they
  already use; where a test constructed the production runner with a fake
  `claude`, it now passes a fake driver script through `driverBin`.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/driver.test.ts src/members/` passes.
- **AC-2.** `bun test` is green and `bun run typecheck` exits 0.
- **AC-3.** The engine bundle proof (FR-005) passes in CI, where the
  three members are already built (042 FR-006).
- **AC-4.** 042 AC-4 still holds: `observatory orchestrator status --json`
  and `./dist/statecraft-engine orchestrator status --json` are
  byte-identical against one fixture daemon.
- **AC-5.** A live smoke, run by hand and recorded in the status note: a
  session driven through the seam by the discovered
  `statecraft-driver-claude` against the real Claude CLI completes, and the
  chain it journals verifies.

## Verification

```verify:cli
bun test src/orchestrator/driver.test.ts src/members/
```

```verify:cli
bun run typecheck
```

```verify:cli
bun run build:member:engine && bun test src/members/engine-bundle.test.ts
```

## 6. Out of scope

A second driver: this spec makes one possible and builds none. The quota
scheduler's transcript-activity probe (015 B-5), which stays a `~/.claude`
read until a sensor spec claims it. Any manifest schema change; the tier
field 042 reserved is enough. Flattening the engine's verb tree (042 D-7).
The corpus merge and the Rust sequence (doc 02 §8), which this spec
precedes so the seam is proved in the language that has the tests.

## Status (2026-09-09)

Implemented. AC-5 ran on this date from the checkout: `createProcessDriver()`
discovered the member at `src/members/driver.ts` (B-5's source fallback),
read its manifest (`reference`), and drove one fast-tier turn of Claude Code
2.1.266 to completion (1 turn, 51827 micro-USD, session
3c8ca052-d556-458b-b253-f041df6f4ff6); the journal held `session.init` and
`session.result` and `verifyChain` reported both intact. The eleven
synthesis tests that fail on `main` under a local spec-spine 0.18.0 (its
`init` writes `AGENTS.md`, which 035's corpus-set guard refuses) fail
identically here and are a 035 defect, not this spec's.

## 7. Resolved decisions

D-1. The seam is a process, not an interface with two in-process
implementations. An in-process `Driver` with a Claude class behind it would
leave the Claude code in the engine bundle, and FR-005 would be false. The
process boundary is what D25 keeps and what the Rust port needs anyway: a
Rust engine and a TypeScript driver can only meet at a process.

D-2. Events are line-delimited JSON on stdout, one object per line, and the
provider's own events ride inside `stream` verbatim (doc 01 §5: vendor
extensions pass through to the journal rather than being normalized). The
engine journals only `init` and `result`, as 014 B-3 journaled only the
init and result boundaries; the rest feeds the SSE hub exactly as the sink
did.

D-3. The engine journals, the driver does not. The chain is the engine's
product (011); a driver holding a journal path would be a second writer to
a hash chain, and the tamper-evidence claim rests on there being one.
B-3's byte-identity requirement is what makes this a refactor rather than
a schema change.

D-4. The tier is read from the manifest once and consumed as a capability
declaration, not probed. 042 B-8 reserved the field for exactly this. The
one feature gated today is `mcp-config`; a driver that cannot host an MCP
server set cannot run the browser verifier, and the engine says so in the
journal rather than pretending the assertion ran.

D-5. `claude-bin` survives as an alias for one release. Operators and the
launchd plist name it; breaking them in the change that moves the driver
out of the engine would hide a real regression behind a flag rename.

D-6. Authored `status: approved`, this corpus's habit, on the authority of
doc 02 §8, which places this spec before the merge and names its territory.
It resolves no collision between shipped contracts (042 D-6's reason for
`draft`); it implements a decision the design record already took.

D-7 (recorded while building). Spec 040's default pair leaves `models.ts`
for `src/members/driver-session.ts`. The stage-to-tier map stays with the
engine (it is engine data, 040 B-2) and the engine passes a tier; the
driver resolves it against the project's pair or its own default. The one
visible change: `projects` renders a project with no pair as
`(driver default)` rather than naming ids the engine no longer knows, and
`statecraft driver-claude models` (042 D-8) prints the pair.

D-8 (recorded while building). The dispatcher leaves `src/index.ts` for
`src/members/dispatch.ts`, a function over a verb table with no verb
imports of its own. Without this, every member entrypoint that reused the
005 dispatcher bundled every verb it imports, and the engine binary carried
the driver's `models` verb with the default pair inside it (FR-005 found
this on the first build). `observatory` builds the full table in
`src/index.ts`, and each member builds its own from the same functions, so
042 FR-003's byte-identity holds unchanged. The driver's `session` verb is
answered by the driver entrypoint alone and never routed by `observatory`:
it exists for the engine to spawn, and putting it in `index.ts` would pull
`session.ts` back into every bundle.

D-9 (recorded while building). The engine bounds its drain of the member's
pipes after exit to two seconds, the bound 014 applies to the provider's
own orphans: a grandchild that inherited the pipes otherwise holds the
engine until it dies. AC-5 is a seam smoke rather than a full `daemon run`,
because a driven run proves the scheduler and costs a whole orchestrated
build; the daemon's own wiring is covered by the profile spawn tests, which
now cross the process boundary.
