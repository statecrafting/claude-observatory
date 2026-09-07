# Umbrella CLI and member seams: claude-observatory becomes a family of binaries

Date: 2026-09-07. Input: direct reads of `~/DevWork/statecraft-cli` (`src/cli.rs`,
`src/main.rs`, `src/verbs/`, specs 001-007), `~/DevWork/rahi` (README, `specs/`),
this repo's `src/` tree, and spec-spine 0.15.0's published binary. This document
succeeds `00-ecosystem-analysis.md` and supersedes the parts of it named in §7.
Claims cited here were verified on disk on the date above; §8 lists what was not.

Decision numbering continues 00's sequence: 00 owns D1-D12, this document owns
D13 onward.

## 1. What changed since 00

Three premises of 00 no longer hold.

- **statecraft's base is rahi, not enrahitu.** `~/DevWork/rahi` is "the Rust
  chassis for governed cells", and its README states the lineage directly:
  "enrahitu was Encore, Rauthy, Hiqlite, Turso. Drop Encore and Turso and what
  remains is what this is." rahi supplies identity (rauthy behind the app's own
  origin), replicated state (hiqlite in-process), a hash-chained decision ledger,
  a deny-by-default capability kernel, and an axum edge. statecraft will most
  likely be rewritten from the ground up on it rather than migrated. This is a
  firmer footing than it sounds: rahi is not a plan. Six crates carrying 18,427
  lines of Rust exist, ten of its ordinary specs are complete and one is in
  flight, and this repository's orchestrator is what built them.
- **The hosted track is deprioritized.** 00 and the September pivot both put the
  control plane early. It moves behind the local product.
- **The product is not one repo named claude-observatory.** 00's D11 kept the
  name and treated the orchestrator as a capability of the observatory. The
  direction now is a single umbrella CLI, `statecraft`, orchestrating a family
  of member binaries, of which today's claude-observatory supplies three.

One premise is unchanged and load-bearing: done is not self-authored. Everything
below preserves it.

## 2. The umbrella that already exists

`~/DevWork/statecraft-cli` is at milestone M4 and is further along than 00 credits:
a clap command tree (`login`, `whoami`, `tenants`, `stamp`, `fleet`, `template`,
`mcp`, `config`, `completions`, `version`), an MCP stdio face over the same verbs,
a JSON error envelope with an exit-code taxonomy (`src/error.rs`), and tag-gated
binary releases carrying SBOMs and attestations with an `install.sh` (spec 007).
Its own spec 001 fixes the constraints: binary named `statecraft`, Rust, stdio
MCP, Apache-2.0, no TUI.

The gap is precise, and it is the whole transition:

> Every verb it has is a client of a hosted control plane, through `src/api.rs`
> and `src/auth.rs`. There is no local-execution verb, and no notion of a member.

So the umbrella does not need to be built. It needs a second face: a local,
account-less dispatch path that stands beside the remote client path without
inheriting its auth.

## 3. The member split, per seam

The chosen decomposition is three members, not one, so that a second driver drops
in beside the first rather than being retrofitted into it.

| Member | Territory in this repo today | Owning specs |
|---|---|---|
| `statecraft-sensor-claude` | `src/watcher.ts`, `classify.ts`, `db.ts`, `walker.ts`, `redact.ts`, `paths.ts`, and `commands/{watch,query,snapshot,explain,daemon}.ts` | 001-008 |
| `statecraft-engine` | `src/orchestrator/` minus the driver files: journal, dag, state, quota, budget, economics, decisions, export, projects, profile, gate-contract, standby, daemon, api, adopt, and the provider-neutral half of `stages/` | 010-013, 015-039, 041 |
| `statecraft-driver-claude` | `src/orchestrator/session.ts`, `classify-termination.ts`, `models.ts`, and the Claude-specific half of `stages/` | 014, 040 |

Two measured facts make this split cheap rather than speculative.

**The driver boundary is already a process boundary.** `src/orchestrator/session.ts`
spawns a configurable `claudeBin` (defaulting to `claude`) with
`-p --output-format stream-json --verbose`, delivers the prompt on stdin, and
never places it on argv or through a shell. The engine already talks to the agent
across a process boundary and parses a JSON stream off its stdout. Promoting that
to a member formalizes a seam that exists; it does not invent one.

**The coupling to extract is small and concentrated.** The string `claude` appears
in 14 non-test files under `src/orchestrator/`, and four of them hold 47 of the
mentions: `session.ts` (17), `stages/verify.ts` (12), `stages/ship.ts` (9),
`stages/build.ts` (9). The other ten carry one to five each, mostly naming rather
than behavior. The extraction is a bounded, spec-sized job, not a rewrite.

- **D13 (member split):** the sensor, the engine, and the Claude driver are three
  members with three build targets. The engine holds no provider-specific
  contract; provider knowledge lives in a driver or a sensor.
- **D14 (modularize in place first):** the three members are built from this
  repository and this spec corpus before any repo split. A member becoming its own
  repository is a later, separately-decided move, justified by the driver family
  growing, not by the split itself. Splitting repos and splitting binaries are
  independent decisions and are taken independently.

## 4. The dispatch contract

- **D15 (discovery):** git-style. A verb the umbrella's own clap tree does not
  know is resolved to `statecraft-<verb>` on `PATH`, then in a managed member
  directory the umbrella owns. Resolution order is fixed and reported by
  `statecraft members list`, so a shadowed member is visible rather than silent.
- **D16 (no shell):** members are spawned with argv, never through a shell, and
  never with untrusted content interpolated into a command line. This is the
  invariant `session.ts` already holds for the agent process; the umbrella
  inherits it rather than relaxing it.
- **D17 (envelope):** a member reports on stdout as a spec-spine 037 verdict
  envelope (spec-spine's 037, not this corpus's defect-capture 037),
  the same shape spec-spine 0.15.0 emits from `index check --json` and
  `verify --json`. The umbrella renders it; it does not reinterpret it.
- **D18 (exit codes are shared, not remapped):** the umbrella passes a member's
  exit code through unchanged. A caller scripting against `statecraft engine ...`
  sees what it would see calling the member directly. The umbrella's existing
  taxonomy is three values (`EXIT_OK` 0, `EXIT_OPERATIONAL` 1, `EXIT_USAGE` 2 in
  `src/error.rs`), so dispatch failures (member not found, manifest refused,
  version skew) take codes above them rather than overloading 1 or 2, and a
  member's own 1 or 2 stays distinguishable from the umbrella's.
- **D19 (manifest):** each member declares name, version, the verbs it claims, and
  its capability tier, and the umbrella reads that declaration rather than probing
  behavior. A member the umbrella cannot parse is refused by name, with the reason
  stated.
- **D20 (account-less local face):** the dispatch path never requires
  `statecraft login`. The existing verbs are control-plane clients and stay that
  way; members are not, and the umbrella must not couple the two. A user with no
  account runs the entire local loop.
- **D21 (version skew is stated, not absorbed):** the umbrella declares the member
  version range it supports and refuses outside it with a message naming both
  versions. It does not silently degrade, and it does not auto-upgrade a member
  during a run.

## 5. Capability tiers, not a lowest common denominator

Carried forward from the September pivot and unchanged by this document: the
driver protocol is a superset, not an intersection. Drivers advertise a capability
tier; the engine degrades named features per driver rather than refusing to use
what a richer driver offers. Vendor-specific extensions pass through to the
journal verbatim rather than being normalized away. The Claude driver is the
reference implementation and the richest, and that asymmetry is intended.

- **D22 (degradation is journaled):** when the engine drops a feature because the
  active driver's tier does not carry it, that degradation is a journaled fact of
  the run, not an implicit default. A bundle reader can see which capabilities
  were in play when a spec was adjudicated.

## 6. What spec-spine 0.15.0 changes for this plan

`spec-spine verify <id>` now runs a spec's `## Verification` block as its declared
acceptance and returns a verdict envelope. 00's D5 defines shipped partly as
"where the spec declares observable behavior, verify has recorded a pass", and
this repo's verify stage (spec 019) implements that. The verb makes the same
adjudication available to a member, to CI, and to a human at a prompt, with one
parse owned by the substrate. Five specs here (022, 023, 024, 038, 041) already
parse into runnable plans; spec 019 carries `verify:cli` fences under a heading
the verb does not read, so it does not.

- **D23 (verify verb as the acceptance runner):** the engine's verify stage moves
  onto `spec-spine verify` rather than keeping a private parse of the same
  markdown. Adopting it is its own spec, and it includes bringing this corpus's
  fences under the `## Verification` heading the verb reads.

## 7. Decisions from 00 that this document supersedes

Each needs a recorded human amendment in its owning spec before code moves.

- **D6 (session driving)** is now the contract of `statecraft-driver-claude`
  rather than of the engine. The mechanics it names (fresh process per attempt,
  stream-json, prompt on stdin, OAuth only with `ANTHROPIC_API_KEY` unset) are
  correct and survive intact; they simply stop being universal.
- **D9 (ship/shepherd reuse)** assumed the target repo's `/ship` discipline and
  Claude Code's hook exit-2 semantics. Hook-blocked stays a terminal stage
  outcome, but the mechanism that produces it becomes driver-reported rather than
  engine-known.
- **D10 (verify by Claude in Chrome)** is a driver capability at the richest tier,
  not an engine requirement. A driver without it degrades under D22.
- **D11 (naming)** is superseded outright. The user-facing name is `statecraft`;
  claude-observatory's parts become members behind it.

## 8. Not verified

Stated as open rather than assumed, because the phase plan below should not rest
on them:

- What `statecrafting/fleet-native` actually contains. Carried over unverified
  from the September survey.
- Whether statecraft's current deployment is green. Largely moot if statecraft is
  rewritten on rahi, but the rewrite decision itself is not yet recorded in any
  corpus.
- Whether the orchestrator's rahi run is currently live, parked, or disarmed.
  What is verified: rahi is roughly half built, not the "specified, not yet
  built" its own README still claims. Ten ordinary specs are
  `implementation: complete`, 016 is `in-progress`, nine are pending, and
  `crates/` holds 18,427 lines of Rust across six crates (`rahi-types`,
  `rahi-store`, `rahi-ledger`, `rahi-kernel`, `rahi-edge`, `rahi-idp`), with a
  commit landed on 2026-09-07. So the builder is working, and the sequencing
  question is whether the member split disturbs an active run, not whether one
  exists.

## 9. The spec plan

Four specs across two governed corpora, each bounded to one driven session.

| Repo | Spec | Territory |
|---|---|---|
| claude-observatory | 042 | The member contract: three build targets, the manifest each emits, the verdict envelope on stdout, and the exit-code taxonomy (D13, D14, D16, D17, D18, D19) |
| claude-observatory | 043 | The driver seam: the engine loses its provider-specific contract and `statecraft-driver-claude` becomes the only member that knows Claude (D13, D22) |
| statecraft-cli | 008 | Umbrella dispatch: discovery order, the managed member directory, `members list`, and the account-less local face (D15, D20, D21) |
| statecraft-cli | 009 | The engine and sensor verbs as first-class umbrella surface, including the MCP face over dispatched members |

The line between 042 and 043 is deliberate. 042 is packaging and protocol: it
adds entrypoints, manifests and an output contract without moving a function
between layers, so it is mechanically testable and safe to land while the engine
is still internally Claude-aware. 043 is the refactor that split buys. Putting
both in one spec would exceed a single driven session's territory, which is the
bound this corpus holds every spec to.

Sequencing note: 042 and 008 are the pair that must agree, and they live in
different corpora with different coupling gates. They are written together and
land in either order; neither is shippable while the other's contract is only
prose. 008 states the contract from the umbrella side and 042 from the member
side, and each cites the other by id so a later reader can tell that the two
halves were authored as one decision.

## 10. Sources

Verified on disk 2026-09-07: `~/DevWork/statecraft-cli` (`src/cli.rs`,
`src/main.rs`, `src/verbs/`, `specs/001-cli-mcp-thesis/spec.md`, `specs/` listing,
README), `~/DevWork/rahi` (README, `specs/` listing, `git log`),
`~/DevWork/spec-spine` (tag `v0.15.0`, `specs/045`-`specs/050`, `--help` of the
published npm binary), and this repository (`src/orchestrator/session.ts`,
`src/orchestrator/` listing, the `claude` mention census, `docs/design/00-ecosystem-analysis.md`).
Package versions confirmed live on crates.io, npm, and PyPI at 0.15.0.
