---
id: "042-member-contract"
title: "The member contract: build targets, manifests, and the shape the umbrella dispatches to"
status: draft
created: "2026-09-07"
authors: ["Bartek Kus"]
kind: feature
implementation: pending
risk: medium
depends_on:
  - "005-cli-surface"
  - "023-orchestrator-cli"
summary: >
  Design doc 01 rules that this repository stops being a product and
  becomes three members behind one umbrella CLI named `statecraft`
  (D13, D14). This spec is the packaging and protocol half of that
  move, and deliberately not the refactor: it adds three build
  targets, the manifest each one declares itself with, and the
  output contract the umbrella dispatches against, without moving a
  single function between layers. The engine stays internally
  Claude-aware until 043 takes that up. Two collisions found while
  authoring are resolved here rather than papered over. The envelope
  is not spec-spine's verdict shape as doc 01 D17 assumed; both this
  repo and statecraft-cli already emit `{ok, data|error}` and
  `src/orchestrator/api/types.ts` says so in as many words, so the
  family dialect wins and D17 is amended. The exit-code taxonomies
  genuinely differ (023 D-4 reads 2 as an unreachable daemon, while
  the umbrella's clap hardcodes 2 as usage), and rather than remap at
  the boundary and break every script that calls a member directly,
  the manifest declares the member's taxonomy, the umbrella passes
  codes through verbatim, and umbrella-layer failures move to a
  reserved range no member uses.
establishes:
  - "src/members/manifest.ts"
  - "src/members/manifest.test.ts"
  - "src/members/entrypoints.test.ts"
  - "src/members/sensor.ts"
  - "src/members/engine.ts"
  - "src/members/driver.ts"
extends:
  # The three entrypoints reuse the existing dispatcher rather than
  # forking it; 005 owns it and gains an exported surface, no verb
  # of its own changes behavior.
  - { spec: "005-cli-surface", unit: "src/index.ts", nature: additive }
  # The build targets are npm scripts, which 024 owns as a section unit.
  - { spec: "024-web-ui", unit: { kind: section, file: "package.json", anchor: "scripts" }, nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/01-umbrella-cli-and-member-seams.md" }, role: context }
---

# 042: The member contract

## 1. Purpose

Design doc 01 D13 splits this repository into three members: the sensor
(specs 001-008), the engine (010-013, 015-039, 041) and the Claude driver
(014, 040). D14 says they are built in place, from this corpus, before any
repo split is considered. What the doc does not settle is what a member
*is* to the thing calling it, and that is the only part statecraft-cli 008
cannot write without.

This spec answers exactly that and stops. A member is a binary that can be
built from this repo, that answers one reserved flag with a machine-readable
description of itself, and whose output the umbrella can render without
knowing which member produced it. No function moves between layers here.
The engine still imports the Claude driver directly, `session.ts` is
untouched, and every existing verb behaves identically. That refactor is
043, and separating the two is what keeps each inside one driven session's
territory.

The reason to do packaging before surgery is that packaging is mechanically
falsifiable. A build target either produces a binary or it does not; a
manifest either parses or it does not. Landing that first gives 043 a place
to stand and gives statecraft-cli 008 a contract to code against while the
engine is still internally Claude-aware.

## 2. Territory

Owned: `src/members/manifest.ts` (the manifest type, the three declarations,
and the serializer), the three entrypoints `src/members/{sensor,engine,driver}.ts`,
and the tests `src/members/manifest.test.ts` and `src/members/entrypoints.test.ts`.

Extended, both additively: `src/index.ts` (005), which gains an exported
dispatch entry so the three entrypoints reuse it rather than forking the
argument parser, and the `scripts` section of `package.json` (024), which
gains the three build targets.

Not claimed: any change to what a verb does, to `session.ts`, or to the
Claude-specific halves of the stages (043 owns all three); the umbrella's
own discovery, member directory and dispatch (statecraft-cli 008); the
`observatory` binary and its `bin` entry, which stay exactly as they are so
nothing that exists today breaks.

## 3. Behavior

- **B-1 (three targets).** `package.json` gains `build:member:sensor`,
  `build:member:engine` and `build:member:driver`, each a
  `bun build --compile` of the matching entrypoint to
  `dist/statecraft-sensor-claude`, `dist/statecraft-engine` and
  `dist/statecraft-driver-claude`. `dist/` is gitignored like `web/dist`.
  The binary names are the umbrella's discovery names (008), so they are
  fixed here and not left to the build script's convenience.
- **B-2 (entrypoints reuse the dispatcher).** Each entrypoint imports the
  spec 005 dispatcher and hands it the verb set its member claims, so a
  verb behaves identically whether reached through `observatory <verb>` or
  through its member binary. An entrypoint that is handed a verb outside
  its member's set reports it as unknown in the usual usage form; it does
  not silently fall through to another member's verb.
- **B-3 (the manifest).** Every member answers `--member-manifest` by
  writing one JSON object to stdout and exiting 0, and answers it before
  any other flag is interpreted, including flags it would otherwise reject.
  The object is:

  ```
  {
    "schemaVersion": "1",
    "name": "statecraft-engine",
    "version": "<the package version>",
    "contract": "042",
    "verbs": ["status", "dag", "next", ...],
    "capabilityTier": "reference" | "basic",
    "exitCodes": {"0": "ok", "1": "operational", "2": "unreachable", "3": "usage"},
    "envelope": "ok-data"
  }
  ```

  `contract` is the id of this spec, so a member states which version of
  the member contract it implements rather than leaving the umbrella to
  infer it from a version number. `name` is the dispatch key: the umbrella
  reaches this member as `statecraft engine ...`, never by one of its
  verbs, so two members may both offer a `status` and neither shadows the
  other or an umbrella built-in. `verbs` is the subverb set the member
  accepts under its own name, which lets the umbrella refuse an unknown
  subverb before spawning a process and lets `members list` say what a
  member offers without running it.
- **B-4 (the envelope is the family's, not spec-spine's).** Under `--json`
  a member emits the `{ok: true, data}` / `{ok: false, error: {kind,
  message}}` envelope that 023 B-3 and statecraft-cli 004 §5.2 already
  share. This spec introduces no new envelope and changes no existing
  output. Doc 01 D17 said members emit spec-spine's 037 verdict envelope;
  that is amended by D-2 below.
- **B-5 (stdout is the contract).** The manifest and the envelope are the
  only things a member writes to stdout under `--json` or
  `--member-manifest`. Diagnostics, progress and log lines go to stderr.
  A member that has nothing to say writes nothing to stdout rather than a
  blank line, so the umbrella can parse stdout without stripping.
- **B-6 (exit codes pass through).** A member's exit code is its own and
  the umbrella returns it unchanged (doc 01 D18). Each member declares its
  taxonomy in `exitCodes` so the umbrella can report it rather than guess
  it. The engine and driver members carry 023 D-4's taxonomy verbatim
  (0 ok, 1 operational, 2 unreachable daemon, 3 usage) because that is what
  their verbs already return and 023's own verification asserts it. No
  member emits a code of 64 or above; that range belongs to the umbrella's
  dispatch layer (008).
- **B-7 (no shell, ever).** Nothing in a member's own process spawning is
  routed through a shell, and no caller-supplied value is interpolated into
  a command line. This is the invariant `session.ts` already holds for the
  agent process (its header states it), lifted to a member-wide rule so
  that 043 cannot quietly relax it while moving code.
- **B-8 (capability tier).** The Claude driver declares
  `capabilityTier: "reference"`; the sensor and engine declare `"basic"`.
  The tier is declared, never probed. Nothing consumes it yet: it exists so
  that 043 and the second driver have a field to fill rather than a schema
  change to negotiate.

## 4. Functional requirements

- **FR-001.** Manifest tests assert each of the three manifests parses,
  carries `contract: "042"`, names its binary exactly as B-1 builds it, and
  declares a non-empty `verbs` list. The three `name` values are asserted
  distinct across all three manifests at once, since the name is the
  dispatch key; the `verbs` lists are deliberately not required to be
  disjoint, because two members legitimately both offer a `status`.
- **FR-002.** An entrypoint test runs each entrypoint with
  `--member-manifest` and asserts: exit 0, stdout parses as JSON, stderr is
  empty, and the parsed object equals the declaration in `manifest.ts`. The
  same test asserts `--member-manifest` wins over a malformed flag placed
  before it.
- **FR-003.** A verb-routing test asserts that one verb from each member's
  set produces byte-identical stdout when invoked through its entrypoint and
  through `src/index.ts`, and that a verb belonging to another member is
  reported as unknown with the usage exit code, not executed. Byte-identical
  is the point: a verb that reads differently through a member binary than
  through `observatory` is the failure this spec exists to prevent.
- **FR-004.** A build test runs the three `build:member:*` scripts and
  asserts each produces an executable at the B-1 path that answers
  `--member-manifest` with the same object the unit test saw. This is the
  only test that shells out to `bun build`, and it is the one that would
  catch an entrypoint that type-checks but cannot be compiled standalone.
- **FR-005.** A stdout-hygiene test asserts that for one verb per member,
  `--json` writes exactly one JSON object to stdout and every human-readable
  line to stderr.
- **FR-006.** CI builds the three members. The `govern` workflow gains a
  step after the web build, on the same reasoning 024 FR-001 used for the
  SPA: a build target that only ever runs on the machine that wrote it is
  not a build target.

## 5. Acceptance criteria

- **AC-1.** `bun test src/members/` passes.
- **AC-2.** `bun run build:member:engine && ./dist/statecraft-engine --member-manifest`
  prints the engine manifest and exits 0, and the same holds for the sensor
  and driver targets.
- **AC-3.** `bun test` is green and `bun run typecheck` exits 0, with no
  existing test modified. The proof that this spec moved nothing is that
  every test written before it still passes unedited.
- **AC-4.** `observatory orchestrator status --json` and
  `./dist/statecraft-engine orchestrator status --json` produce byte-identical
  stdout against the same fixture daemon.
- **AC-5.** No file under `src/orchestrator/` and no file under `src/` outside
  `src/members/` and `src/index.ts` appears in this spec's diff. Mechanically:
  `git diff --name-only origin/main...HEAD -- src/ | grep -v '^src/members/' | grep -v '^src/index.ts$'` is empty.

## Verification

```verify:cli
bun test src/members/
```

```verify:cli
bun run typecheck
```

```verify:cli
bun run build:member:engine && ./dist/statecraft-engine --member-manifest > /dev/null
```

## 6. Out of scope

The driver seam (043 owns it: the engine keeps importing Claude-specific
code directly here). Umbrella-side discovery, the managed member directory,
`members list`, and the account-less local face (statecraft-cli 008). Any
repo split (doc 01 D14 defers it). Installing members as services, which
the September pivot names but no spec has yet claimed. Removing or renaming
the `observatory` binary: it stays, because breaking the surface a working
orchestrator is driven through, in the same change that introduces an
untested new one, is how a migration loses its escape hatch. Publishing
member binaries to a release channel, which is statecraft-cli 007's pattern
to extend once the members are real.

## 7. Resolved decisions

D-1. `--member-manifest` is a reserved flag, not a `manifest` verb. A verb
would occupy a name in each member's verb namespace and would collide the
moment a member wants its own `manifest` (the engine plausibly does, for a
project's spec manifest). A flag that is answered before any other parsing
also lets the umbrella interrogate a member whose verb set it does not yet
know, which is the situation discovery is always in.

D-2. **Amends doc 01 D17.** Members emit the family's `{ok, data|error}`
envelope, not spec-spine's 037 verdict envelope. D17 assumed a divergence
that does not exist: 023 B-3 and statecraft-cli 004 §5.2 already specify the
same shape, and `src/orchestrator/api/types.ts:8` states outright that the
envelope "follows statecraft-cli's own output pattern". spec-spine's 037
envelope is the shape its own gate verbs emit and stays that; it is not the
family's CLI dialect. This decision needs ratification with D-3 before the
spec leaves draft.

D-3. **The exit-code collision is declared, not remapped.** 023 D-4 reads
2 as an unreachable daemon and 3 as usage; the umbrella's clap reads 2 as
usage and cannot be moved off it without fighting the framework, and
statecraft-cli 004 already documents "a missing base URL is usage (exit 2)".
Three resolutions were weighed. Remapping at the dispatch boundary was
rejected because it makes `statecraft engine status` and
`statecraft-engine status` disagree, which breaks every script that calls a
member directly and contradicts doc 01 D18. Changing 023's taxonomy was
rejected because it is shipped, tested, and asserted by 023's own
verification block. What is adopted: codes pass through verbatim, each
member declares its taxonomy in the manifest so the umbrella can report it,
and the umbrella's dispatch-layer failures move to 64 and above where no
member reaches. The residue is honest and stated: exit 2 means usage from a
built-in umbrella verb and unreachable from the engine member, and the
manifest is what makes that discoverable instead of hidden. This decision
needs ratification with D-2 before the spec leaves draft.

D-4. The three entrypoints reuse the 005 dispatcher rather than each parsing
arguments. Forking the parser three ways would let the members drift in flag
handling, and the first symptom would be a flag that works through
`observatory` and not through a member binary, which is exactly the class of
difference FR-003 exists to refuse.

D-5. `dist/` is gitignored. Committed binaries would make the coupling gate
police artifacts rather than sources, and 024 already set the precedent that
a build output the daemon serves is still not committed.

D-7. Keeping every verb identical (B-2) means the umbrella path to an
engine verb is `statecraft engine orchestrator status`: three levels, because
the member still carries the `orchestrator` prefix it has today. Flattening
that prefix would be a nicer surface and is deliberately not done here, since
renaming verbs in the same change that first packages them would forfeit
AC-3 and AC-4, which are the only evidence this spec moved nothing. The
flattening belongs to a later spec, once a member binary is the primary way
these verbs are reached rather than the new one.

D-6. The spec is authored `status: draft` rather than `approved`, against
this corpus's habit of authoring straight to approved. D-2 and D-3 resolve
collisions between two shipped contracts, and the coherence guard in
`.claude/rules/adversarial-prompt-refusal.md` reserves that class of call for
a human. Ratification is a separate commit that flips the status, matching
the `chore(NNN): ratify` pattern the spec-spine corpus uses.
