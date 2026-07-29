# Ecosystem analysis: growing claude-observatory into a governed build orchestrator

Date: 2026-07-29. Input: five parallel read-only surveys across ~/DevWork
(spec-spine, the statecraft family, the extracted governance primitives, the
open-agentic-platform archive, and this repo itself). This document is the
analysis the orchestrator spec DAG is derived from. It records conclusions and
decisions, not file dumps; paths cited here were verified on disk on the date
above.

## 1. Naming corrections (ground truth)

The environment's working-directory list predates a family-wide rename. The
live repos are:

| Stale name | Live repo |
|---|---|
| stagecraft | `~/DevWork/statecraft` (the control plane) |
| stagecraft-cli | `~/DevWork/statecraft-cli` |
| stagecraft.ing | `~/DevWork/statecraft.ing` (website/docs) |
| stagecraft-ing-profile | `~/DevWork/statecrafting-profile` (org profile) |
| ope-agentic-platform | `~/DevWork/open-agentic-platform` ("OAP", the archive) |
| spec-spine-skill-kit | does not exist; the kit is `~/DevWork/spec-spine/kit/` |

`~/DevWork/statecrafting` (the `@statecrafting/*` napi addons + Encore
toolchain) was not on the list at all and matters more than two entries that
were. "The Party" from the product brief is not an ecosystem term: the
codebase's word is `agent` (model layer) / `actor` (ledger layer), with a
declared, non-self-assertable autonomy grade called `posture`
(`none | assisted | autonomous`).

## 2. The family, one paragraph each

- **spec-spine** (Rust, 0.10.0, crates.io/npm/PyPI): a typed, hash-verifiable
  authority ledger over a markdown spec corpus. Verbs: `compile`, `registry`,
  `index`, `lint`, `couple` (the PR-time drift gate), `init`, `attest`,
  `verify-attestation`. Governs every repo in the family. The kit under
  `kit/` supplies AGENTS.md protocol, skills, agents, rules, hooks.
- **Four extracted primitives** (Apache-2.0, crates.io, frozen at 0.1.0):
  `canonical-keysort-json` (canonical bytes), `attest-ledger` (hash-linked,
  Ed25519-anchored append-only chains + independent verifier CLI),
  `action-gate` (pure deterministic Allow/Deny/Degrade gate with
  `config_hash()`), `trust-window` (rolling-window trust scorer with
  snapshot seam). All clock-free, persistence-free, golden-testable.
- **statecrafting** (napi addons): `kernel-native` (the pre-assembled runtime
  kernel: boot, adjudicate, ledger, trust as 8 pure JSON functions,
  fail-closed boot with nine enumerated refusals), `governance-native`,
  `hiqlite-native`, `fleet-native`, plus the Encore toolchain.
- **enrahitu** (Apache-2.0): the governed-cell template chassis and a real
  membership platform. Owns `app-model.json` (the capability-declaration
  contract, with first-class `agents[]`), the kernel reference implementation
  (`backend/kernel/`), and the Decision-chain-over-SQL persistence pattern.
- **statecraft** (AGPL-3.0): the governed delivery control plane, stamped from
  enrahitu. Has the factory pipeline (stage state machine as data, resumable
  by status), CI shepherding (`waitForVerify`), git/PR automation, SSE event
  stream + ring buffer, two same-origin SPAs, and CI workflows that drive
  Claude Code headlessly with a tuned auth-vs-transient failure classifier.
- **statecraft-cli** (Rust): human CLI + MCP stdio server over identical
  verbs; the `template upgrade` verb and `stamp watch_loop` are the family's
  best-worked local orchestration and polling loops.
- **open-agentic-platform** (AGPL, 1618 commits, 225 specs): the design
  archive everything above was extracted from. Its `crates/orchestrator` is a
  prior implementation of almost exactly this product brief (ClaudeCodeExecutor,
  workflow DAG manifests, budget/oscillation gates, circuit breakers, CAS
  artifact lineage, approval gates). Read for shapes; never link (license,
  pre-alpha, deliberately superseded).
- **claude-observatory** (this repo): standalone Bun/TS FSEvents watcher over
  `~/.claude` with SQLite event log, semantic classification, redacted peek,
  daemon. Zero coupling to the family in either direction today. It is the
  telemetry asset: the out-of-band evidence source for observing a Claude
  Code session from outside, and the quota/exhaustion watch surface.

## 3. Scorecard: brief requirement vs what exists

| Requirement | Status | Source of the existing piece |
|---|---|---|
| Stage state machine, resumable | exists, reuse pattern | `statecraft/backend/factory/{jobs,store}.ts` (transitions as data, transactional, single-flight) |
| CI shepherding | exists, reuse pattern | `statecraft/backend/factory/github.ts::waitForVerify` |
| Verify polling loop | exists, reuse pattern | `statecraft-cli/src/verbs/stamp.rs::watch_loop` (backoff, change-only emit, statusless abort) |
| git/PR automation | exists, reuse pattern | `statecraft/backend/factory/{git,github}.ts` |
| Ship stage gate | exists, hook-enforced | `/ship` skill + PreToolUse `gh pr create` hook |
| Typed HTTP API + client taxonomy | exists, reuse pattern | `statecraft-cli/src/api.rs`; statecraft endpoints |
| Event stream | exists, reuse pattern | `statecraft/backend/admin/stream.ts` + `obs/buffer.ts` (SSE, heartbeat, ring buffer) |
| Localhost web UI served in-process | exists, reuse pattern | statecraft's two Vite SPAs into `backend/web/dist` |
| Headless Claude Code driving | partial | `ai-pr-review.yml`: `claude -p`, stdin-piped, OAuth-token trap documented, auth-vs-transient stderr classifier |
| Append-only ledger / evidence | exists, depend on | `attest-ledger` + `canonical-keysort-json` crates |
| Decision gate | exists, depend on | `action-gate` (register domain checks) |
| Trust/autonomy ladder | exists, depend on | `trust-window`; chancery `autonomy.rs`/`ladder.rs` as the composition reference |
| Ledger persistence over SQL | exists, copy design | `enrahitu/backend/kernel/decisions.ts` (CAS on `prev_hash` unique index, dirty-flag crash bracket) |
| Spec DAG data | exists, depend on | spec-spine `depends_on` + registry shards, read via `spec-spine registry` |
| DAG executor / readiness | missing | ours to build |
| Session lifecycle management | missing | ours to build (nothing in the family manages sessions; only `claude -p --output-format text`) |
| Quota parking + resume | missing | ours to build (classifier regex is the seed) |
| Crash-consistent durable journal | missing | ours to build (`governance-native/ledger.rs` is tamper-evident but has no fsync and O(n^2) appends; keep the envelope, fix both) |
| Daemon / long-lived supervisor | missing, and deliberately absent in the family | ours to build |

The one-spec-per-fresh-session protocol already exists in prose:
`statecraft/AGENTS.md` § "Working the backlog" ("Then stop: the next session
takes the next spec"). This product is the executor for that protocol.

## 4. Layering ruling

Three tiers, dependency direction enforced downward only:

1. **Substrate (depend on, never fork):** spec-spine 0.10.0; the four
   primitive crates; `@statecrafting/kernel-native` if/when the orchestrator
   needs runtime adjudication. Substrate names are stable.
2. **Patterns (re-derive, cite the source):** stage-machine-as-data,
   resumable-by-status vs journal-replay, SSE + ring buffer, Refusal vs
   failed-report, exit-code taxonomy, idempotent-only retry, the
   auth-vs-transient classifier, OAP orchestrator shapes.
3. **Product (this repo):** the orchestrator daemon, DAG executor, session
   driver, quota scheduler, run journal, HTTP API + event stream, web UI,
   CLI. Product names may churn; the substrate must not notice.

## 5. Corrections to the brief's assumed model

- spec-spine has **no `shipped` lifecycle state**. Shipped, for readiness
  purposes, means `status: approved` AND `implementation: complete` AND the
  spec's PR merged with the coupling gate green.
- spec-spine has **no contract-hash pinning and no downstream invalidation**.
  `depends_on` is existence-checked data (`V-010` warning), with no cycle
  detection and no readiness semantics. The registry shard's `shardHash`
  (sha256 over the spec's own `spec.md`) is the natural contract hash for the
  orchestrator to pin at build time and to compare for invalidation.
- spec-spine has **no decision-ledger mechanism**. Body conventions exist
  (`## Resolved decisions`, `## Amendments received`); the sanctioned hook
  for structured frontmatter is `[frontmatter] extra_known_keys`. The
  orchestrator's runtime decision ledger is a separate, run-scoped artifact.
- The kit's `/ship`, hooks, and coupling gate assume `origin/main` exists;
  adoption therefore includes creating the GitHub remote.
- Driven sessions will hit the adopter hooks (PreToolUse blocks `gh pr create`
  on drift with exit 2). Hook blocks are first-class stage outcomes, not
  errors to retry blindly.

## 6. Decisions carried into the spec corpus

Recorded here for traceability; each is formalized in the owning spec.

- **D1 (layering):** substrate/pattern/product tiers as in §4. The
  orchestrator is a product on statecraft primitives; it never absorbs them.
- **D2 (contract hash):** a dependency is pinned by its registry `shardHash`.
  Amending a spec changes its shardHash and invalidates downstream pins;
  invalidated specs require re-verification before they count as shipped.
- **D3 (readiness):** ready(spec) = every `depends_on` target is shipped
  (D5 sense) and its pinned shardHash still matches. Cycle detection is the
  orchestrator's job because spec-spine deliberately has none.
- **D4 (journal before ledger):** the work journal is a durable, fsynced,
  hash-linked JSONL (attest-ledger record envelope) written before and after
  every state transition; state is derived by fold, never trusted from memory.
  The Decision ledger is a second chain with the same envelope.
- **D5 (shipped):** a spec is shipped when its PR is merged, CI green, and,
  where the spec declares observable behavior, verify has recorded a pass.
- **D6 (session driving):** fresh `claude` process per spec attempt,
  `-p --output-format stream-json`, prompt on stdin, never shell-interpolated;
  OAuth token only, `ANTHROPIC_API_KEY` explicitly unset (the documented
  precedence trap); observatory watch surface as out-of-band evidence.
- **D7 (quota):** stderr/stream classification splits auth-hard-fail from
  transient/quota; quota exhaustion parks the run at the spec boundary with a
  countdown from the detected reset horizon, then resumes automatically.
- **D8 (interface):** one typed localhost HTTP API + SSE stream served by the
  daemon; CLI and web UI are both clients of it; nothing bypasses it.
- **D9 (ship/shepherd reuse):** the ship stage drives the repo's own `/ship`
  discipline (gate, review, commit, PR) rather than reimplementing it; hook
  exit-2 blocks are classified stage outcomes.
- **D10 (verify):** verify drives Claude in Chrome against the deployed or
  locally-run artifact, asserts the spec's declared observable behavior, and
  records evidence (pass/fail + artifacts) in the run journal.
- **D11 (naming):** the repo keeps the name claude-observatory; the
  orchestrator is a capability of it, not a new substrate name.
- **D12 (retroactive adoption):** existing observatory behavior is specced
  with `origin.retroactive: true` markers and real `establishes` edges so the
  coupling gate holds from the first commit after adoption. Known defects are
  recorded as defects in the specs, not blessed as contract.

## 7. Sources

The five survey reports are conversation artifacts; their load-bearing claims
were spot-verified against: `~/DevWork/spec-spine` (specs 000, 004, 005, 013,
016, 022, 023, 024, 025, 029, 030; `kit/`), `~/DevWork/statecraft`
(`backend/factory/*`, `backend/admin/stream.ts`, `.claude/`, AGENTS.md),
`~/DevWork/statecraft-cli` (`src/api.rs`, `src/mcp.rs`, `src/verbs/*`),
`~/DevWork/statecrafting` (`addon/*`), `~/DevWork/enrahitu`
(`backend/kernel/*`, specs 012, 020, 024, 031), `~/DevWork/chancery`
(`kernel-addon/*`), `~/DevWork/attest-ledger`, `~/DevWork/action-gate`,
`~/DevWork/trust-window`, `~/DevWork/canonical-keysort-json`,
`~/DevWork/tenant-emit`, `~/DevWork/tenant-tail`,
`~/DevWork/open-agentic-platform` (`crates/orchestrator/*`), and this repo.
