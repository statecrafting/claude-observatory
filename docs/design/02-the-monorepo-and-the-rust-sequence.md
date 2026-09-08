# The monorepo and the Rust sequence: statecraft-cli absorbs the members

Date: 2026-09-07. Input: direct reads of `~/DevWork/statecraft-cli`
(`Cargo.toml`, `src/`, `specs/`), this repository's `src/` tree and
`package.json`, `~/DevWork/rahi` (`crates/`, corpus status),
`~/DevWork/spec-spine` (specs 017, 030, 036, 053 and the 0.15.0 binary's
`--help`), and the git history of both governed repositories. This document
succeeds `01-umbrella-cli-and-member-seams.md` and supersedes the parts of it
named in §7. Claims cited here were measured on disk on the date above; §9
lists what was not.

Decision numbering continues the sequence: 00 owns D1-D12, 01 owns D13-D23,
this document owns D24 onward.

## 1. What changed since 01

One thing, and it is the host.

Doc 01 D14 said the three members are built from this repository and this
spec corpus, that a member becoming its own repository is a later and
separately-decided move, and that splitting repos and splitting binaries are
independent decisions taken independently. That reasoning stands. What has
happened is that the repo decision has now been taken, and it runs the other
way: `statecraft-cli` becomes the single codebase for the family's tooling,
daemons and CLI packages, and this repository's parts move into it.

Everything else doc 01 decided survives. The three-member split (D13), the
dispatch contract (D15-D21), capability tiers over a lowest common
denominator (D22), and the verify verb as the acceptance runner (D23) are
unchanged. So is the property underneath all of it: done is not
self-authored.

A governance defect found while confirming that state is worth recording,
because it is the reason this document can exist at all. Design doc 01 and
spec 042 were merged as PRs #71 and #72 with `chore-spec-spine-0-15-0` as
their base branch. That branch had already landed on `main` as #70, so both
merges succeeded into a dead branch and `main` received neither file for a
day. They were recovered by cherry-pick in #73. The lesson is mechanical, not
conceptual: a PR's base branch is part of its review surface, and neither the
coupling gate nor CI can see that a green PR landed somewhere that no longer
leads anywhere.

## 2. The monorepo, and the boundary around it

- **D24 (the host, amending 01 D14):** `statecraft-cli` is the monorepo for
  the family's tooling, daemons and CLI packages. This repository's three
  members move into it rather than being built from here. D14's substance is
  retained and its direction is reversed: the two decisions are still
  independent, and this is the repo one being taken.

The boundary matters more than the decision, because a monorepo with no stated
edge absorbs everything eventually.

In scope: the umbrella CLI, the engine, the sensors, the drivers, the daemons
they run as, the web UI the daemon serves, and the shared contract crates
those pieces need.

Out of scope, and each for its own reason: `statecraft` (the hosted control
plane, AGPL, a deployed service rather than a tool); `rahi` (the chassis that
plane is built on, consumed as a dependency); `spec-spine` (the governance
substrate, which governs this repository and cannot live inside something it
adjudicates); and the four substrate crates already published and frozen at
0.1.0 (`canonical-keysort-json`, `attest-ledger`, `action-gate`,
`trust-window`), which are consumed from crates.io.

- **D25 (the process boundary survives the merge):** members remain separate
  processes with separate build targets inside the monorepo. They are not
  collapsed into one statically-linked binary with subcommands, even though
  one repository makes that easy.

The temptation is real and the reasons to refuse it are three. A process
boundary lets the members be written in different languages at the same time,
which is the mechanism that turns §6's Rust question from one decision into a
sequence of small ones. It is what allows a driver written by someone else to
exist at all. And it is what specs 042 and statecraft-cli 008 already
specify: exit codes passing through verbatim (042 B-6) and unbuffered
streaming output (008 D-5) are properties of a spawned process, not of a
function call.

What the merge does buy is narrower and better. Today the member contract is
prose in two corpora, and both specs say in as many words that a divergence
between them is a defect in both, detectable at runtime through the manifest's
`contract` field. In one workspace that contract becomes a crate both sides
depend on, and the divergence becomes a compile error. That is the concrete
payment for the merge, and it is worth more than collapsing the binaries would
have been.

## 3. The provider axis

Doc 01 names three members. For N providers the count is 2N+1, and the split
has to run through the sensor and driver families rather than only between
them. Doc 01 does not state this, and stating it is the difference between a
second driver costing a table and costing a rewrite.

| Layer | Provider-neutral | Per-provider |
|---|---|---|
| Sensor | walker, event store, snapshot and diff, redaction, daemon plumbing | the observed root path and the classification table |
| Driver | spawn without a shell, stream-parse abstraction, termination interface, tier declaration | invocation flags, stream format, termination signals, model selection |
| Engine | all of it (01 D13) | none |

The sensor half is cheaper than it looks: `src/classify.ts` is already a
pattern-to-semantic-event table over an observed root. A Codex or Cursor
sensor needs its own table and its own root, not its own watcher, event store
or redaction path.

- **D26 (core and provider crates within each family):** the sensor and
  driver families each split into a provider-neutral core and a thin
  per-provider crate. A new provider adds two small crates and no engine
  change. The engine never gains a provider-specific contract, which is 01
  D13 restated as a structural rule rather than an aspiration.

## 4. Naming

The complaint that started this document is that `claude-observatory` is a bad
name. It is, and the reason it is bad is the reason it does not need a
replacement: it denotes a repository holding two unrelated layers under a
provider name that is wrong for both of them. After the split there is no unit
called "the observatory". There is a sensor family and an engine.

- **D27 (naming):** the user-facing binary stays `statecraft`, fixed by
  statecraft-cli spec 001 and not reopened. The member binaries keep the names
  042 B-1 and 008 §3 already fixed, because those are the umbrella's discovery
  keys and not free variables: `statecraft-engine`, `statecraft-sensor-claude`,
  `statecraft-driver-claude`. Internal crates take the `statecraft-` prefix,
  matching rahi's `rahi-` convention and the crates.io namespace. The word
  "observatory" retires with the repository; "sensor" is its replacement and
  doc 01 already uses it.

Two naming questions are deliberately left open rather than settled here. The
verb surface stays `statecraft engine orchestrator status` at three levels,
because 042 D-7 defers flattening on the grounds that renaming verbs in the
change that first packages them forfeits AC-3 and AC-4, which are that spec's
only evidence it moved nothing; the deferral is still correct and outlives the
move. And `statecraft-cli` becomes an inaccurate name for a repository holding
an engine, sensors, drivers and a web UI, but the umbrella crate inside it is
still exactly a CLI. A repository rename is cheap after the transition and
costly during it, while PR and spec cross-references are in flight, so it
waits.

## 5. The corpus merge

Two governed corpora become one, and the ids collide. Measured: exactly one
literal id collision (`000-bootstrap`, present in both) and nine ordinal
collisions (000 through 008). spec-spine does not refuse duplicate ordinals;
spec 053's `L-007` monotonicity lint is opt-in and defaults off. So the
collision would compile, and that is precisely why it has to be decided rather
than discovered.

- **D28 (renumber the umbrella's nine):** statecraft-cli's specs renumber into
  a reserved band at 101-108, its `000-bootstrap` is superseded into the
  monorepo's single bootstrap rather than deleted, and this repository's
  000-042 import unchanged. 043-099 stays free for the merged corpus to grow
  into.

The direction is not chosen by counting specs. It is chosen because this
repository's spec ids are load-bearing outside its corpus: they are written
into the work journal, the decision ledger, and `docs/evidence/journal-bundle.json`,
which held 1038 work records and 52 decision records at export. Renumbering
those either invalidates chains that are the product's central claim, or
leaves an exported bundle whose ids name nothing. statecraft-cli's ids appear
only in its own specs, commits and prose, where a rename is a sweep. The
smaller corpus also happens to be the cheaper one, but that is a coincidence
rather than the argument: if the counts were reversed the direction would be
the same.

The renumber carries a reference sweep with it, since 042 cites
"statecraft-cli 008" and 008 cites "claude-observatory spec 042". Both
citations are prose and both must move in the same change that moves the
directories.

## 6. Rust as a sequence, not a rewrite

The question put was whether to rewrite this repository in Rust so the rest of
the family can be Rust too. The measured shape of that port:

- 22,026 lines of production TypeScript, 18,423 lines of tests, and 3,770
  lines of React that do not move at all because the daemon serves them as
  static files either way.
- Bun coupling is thin and each piece has an obvious counterpart: `Bun.spawn`
  in 12 non-test files, `Bun.serve` in 2, `bun:sqlite` in 1, `Bun.*` in 15
  files total. The watcher uses node's recursive `fs.watch` rather than a Bun
  API. There are no runtime npm dependencies at all, only devDependencies.

Five things argue for Rust, and one of them is much stronger than the others.

The strong one: `src/orchestrator/journal.ts:9` states that it implements "the
attest-ledger record chain (canonical key-sorted JSON, sha256, prevHash)".
`attest-ledger` and `canonical-keysort-json` are published Rust crates. So
underneath a product whose entire claim is offline-verifiable tamper-evident
chains sit two independent implementations of canonical JSON, one of which
exists only here. That is a correctness liability located exactly where
credibility lives, and it is the one thing a Rust port deletes rather than
merely tidies.

The others: the contract crate of D25 only pays in a single language;
statecraft-cli spec 007 already ships tag-gated binaries with SBOMs and SLSA
attestations that a Rust member joins unchanged, where `bun build --compile`
would ship three large binaries with no provenance story; spec-spine is more
expressive over Rust, with `crate` and `module` unit kinds (spec 017) and a
cargo dependency auto-waiver (spec 030) that have no TypeScript equivalent;
and feasibility is evidenced rather than assumed, since this repository's own
orchestrator built rahi's six crates and 22,021 lines of Rust, and spec 041
already gives it a Rust language gate.

Against, honestly: roughly 40k lines move, and the 18k of tests are the
expensive half because they do not port mechanically. A half-ported engine
means the tool driving the port is the tool being ported. A Rust journal must
reproduce the existing chain byte for byte or the exported bundle stops
verifying. `cargo test --workspace` is slower than `bun test`, paid once per
driven session. And nothing about adding a Codex or Cursor driver requires
Rust at all: the member split delivers provider expansion, the rewrite
delivers uniformity, and confusing the two would make the rewrite look urgent
when it is not.

- **D29 (Rust per member, never as a rewrite):** Rust is adopted one member at
  a time, each port its own spec with its own justification, each landing
  behind the 042 contract and proved by 042 AC-4's byte-identical output
  requirement against the implementation it replaces. There is no spec called
  "rewrite in Rust" and there is no flag day.
- **D30 (the order, and what gates it):** the contract crate first, because it
  is new code and it is what the merge is for. Then the sensor, as the first
  port: smallest, most self-contained, no chain-compatibility constraint, and
  a clear Rust story in `notify` and `rusqlite`. Then the journal, ledger and
  export, because that is where the substrate crates delete the duplicate
  implementation, gated on re-verifying the existing bundle byte for byte
  before the TypeScript writer is retired. The engine last, and only if the
  first two prove the ergonomics, because it is the largest and its stall
  would stop the machine that does the work. The Claude driver may stay
  TypeScript indefinitely: it is the thinnest member, and a polyglot driver
  family is the strongest available evidence that the seam is real rather than
  nominal.

### The canonicalization check, run

This document first listed the check as open. It has since been run, and the
result changes what D30's journal gate has to cover.

On the corpus that exists, the two implementations agree completely. All 1,696
work records and 70 decision records were recomputed from the original `.jsonl`
bytes, with no JavaScript in the path: parsed with `serde_json`, canonicalized
through `canonical-keysort-json`, hashed with sha256, and compared to the stored
`recordHash`. All 1,766 reproduced, zero mismatches. Comparing canonical output
directly, 695,206 bytes are byte-identical between `stableStringify` and
`to_canonical_string`. The committed evidence bundle also still verifies under
the shipped verifier: both chains intact, 1038 work and 52 decision records.

So the journal port is mechanical for every record written so far. Four
divergences exist outside that corpus, and one of them is a defect in this
repository today rather than a property of the port.

**The defect.** `canonicalizeValue` sorts keys lexicographically and then
inserts them into a plain object, but JavaScript enumerates array-index-like
keys (the canonical decimal form of an integer in `[0, 2**32-2]`) first, in
ascending numeric order, regardless of insertion order. For those keys the sort
is silently discarded, so `{"9": _, "10": _}` canonicalizes in numeric order
rather than lexicographic order, and the function's own contract, stated in its
header comment as a "recursive lexicographic key-sort", does not hold. The
existing chain is unaffected because the writer and the verifier share the same
behavior, which is exactly why it has gone unnoticed: it is invisible to
everything except a second implementation. `canonical-keysort-json` sorts by
UTF-8 bytes and has no such carve-out. A scan of all 1,810 available records,
the bundle included, finds zero objects that would trigger it.

**Three narrower ones.** A lone surrogate, which `JSON.stringify` emits as a
`\udXXX` escape and `serde_json` refuses to parse at all; this one is more
plausible here than it looks, because the journal carries agent output and a
truncated stream can split a surrogate pair. An integer above `2**53`, which
JavaScript parses lossily and silently, since `Number.isInteger` passes after
the precision is already gone. And number-shape differences in the other
direction, where the Rust crate accepts floats that `journal.ts` rejects by
design and re-emits exponent form and negative zero as `100.0` and `-0.0`;
these are only reachable through foreign input, since `JSON.stringify` never
writes those forms.

The consequence for D30 is that the journal gate is not only "reproduce the
stored hashes", which is now known to pass. It is also "decide which
lexicographic order is the canonical one" before a second implementation
exists, because the two currently define different canonical forms for a class
of input the corpus does not yet contain. Changing `journal.ts` is a change to
shipped behavior owned by spec 011 and has to be coupled there rather than
fixed in passing.

## 7. Decisions from 01 that this document supersedes

- **D14 (modularize in place, split repos later)** is amended by D24. Its
  reasoning is retained: the two splits are independent decisions. The repo
  decision is now taken, and the host is statecraft-cli rather than this
  repository.

No other decision in 01 changes. D17 was already amended by 042 D-2 and that
amendment is ratified; it is recorded here only so a later reader does not
have to reconstruct it from two corpora.

## 8. The spec plan

The order is chosen so the contract is proved by a running implementation
before the large file move, not after it.

| Corpus | Spec | Territory |
|---|---|---|
| claude-observatory | 042 (approved, pending) | The member contract: three build targets, manifests, envelope, exit codes |
| statecraft-cli | 008 (approved, pending) | Umbrella dispatch: discovery, the managed member directory, `members list`, the account-less face |
| claude-observatory | 043 | The driver seam: the engine loses its provider-specific contract (01 D13, D22) |
| statecraft-cli | new | The merge itself: the file move, the corpus renumber and reference sweep, one gate over the result (D24, D28) |
| monorepo | new | The contract crate in Rust (D25, D29) |
| monorepo | new, then per member | Each Rust port, in D30's order |

042 and 008 are both approved with `implementation: pending`, and either can be
built first. Implementing them in the current two repositories before the merge
is deliberate rather than wasted: 042's AC-4 requires a member binary's output
to be byte-identical to the same verb reached through the existing dispatcher,
and that assertion is the harness every later Rust port is measured against.
Building the harness in the language it already has is the cheapest way to
obtain it.

043 is placed before the merge because it is a refactor of this repository's
own internals, and a refactor is easier to review against a corpus that has not
just been renumbered.

## 9. Not verified

- Whether spec-spine's coupling gate behaves correctly when `--repo` points at
  a subdirectory of a git repository rather than its root. The plan in §8 does
  not depend on it, since D28 merges the corpora into one root, but a future
  per-member corpus would.
- What `statecrafting/fleet-native` contains. Carried forward unverified from
  doc 01 §8 and from the September survey before it.
- Whether the orchestrator's rahi run is currently live, parked or disarmed.
  What is verified is that rahi's corpus holds 22 approved specs and its
  `crates/` holds 22,021 lines of Rust across six crates.

## 10. Sources

Measured on disk 2026-09-07: this repository (`src/` line counts and Bun API
census, `package.json`, `src/orchestrator/journal.ts`, `src/classify.ts`,
`docs/evidence/journal-bundle.json` counts as reported in `README.md`,
`spec-spine.toml`, the `specs/` listing); `~/DevWork/statecraft-cli`
(`Cargo.toml`, `src/` listing and line count, `specs/` listing,
`specs/008-member-dispatch/spec.md`, `spec-spine.toml`, README);
`~/DevWork/rahi` (`crates/` listing and line count, corpus status report);
`~/DevWork/spec-spine` (`specs/017`, `specs/030`, `specs/036`, `specs/053`,
`crates/spec-spine-core/src/lint.rs`, and `spec-spine --help` at 0.15.0). The
corpus collision counts in §5 were computed by comparing the two `specs/`
listings directly. The base-branch defect in §1 was confirmed through the
GitHub API for PRs #70, #71 and #72.
