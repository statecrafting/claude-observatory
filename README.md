# claude-observatory

One Bun + TypeScript repo, two layers and a governance substrate:

- **The observatory (specs 001-008, shipped):** filesystem observability for
  `~/.claude`: a watcher daemon plus a CLI that turns raw FSEvents into
  semantic, queryable activity, and `FINDINGS.md`, an evidence-backed map of
  what every path in that tree is and when it changes.
- **The orchestrator (specs 010+):** an autonomous build system for
  spec-spine governed repositories. A standby daemon drives one spec per
  fresh Claude Code session through build, ship, shepherd, and verify, for
  any project registered with it; this repo was its first target and was
  largely built by it.
- **The governance substrate:** the spec corpus under `specs/`, compiled and
  gated by [`spec-spine`](https://www.npmjs.com/package/spec-spine). Every
  code change must be coupled to an authoring edit of the spec that owns it
  (or carry a cited `Spec-Drift-Waiver:` line); agents may not amend an
  owning spec to match code they just wrote. The orchestrator judges stage
  completion by re-running this gate, never by the session's own claim.

The load-bearing property, across both layers: **done is not
self-authored.** A session's claim that it finished is not an input
anywhere in the system. Completion is adjudicated by an external,
deterministic gate over a corpus the session is structurally forbidden to
amend in its own favor; the adjudication is journaled in hash-linked,
tamper-evident chains; and the chains export to a redacted bundle a
skeptic can verify offline (see Evidence below).

The observed `~/.claude` tree is treated as strictly read-only. Everything
this project produces (SQLite db, logs, baselines, the orchestrator's
journals) lives here under `data/`, which is gitignored because it describes
private activity.

## The observatory

- `src/watcher.ts` keeps a state table (path, size, mtime, inode) for every
  entry under `~/.claude` plus `~/.claude.json`, watches recursively via
  FSEvents, debounces 200 ms per path, and diffs each event against the table
  to classify created / modified / replaced (inode change) / deleted with byte
  deltas. Directory events trigger a shallow reconcile to catch coalescing.
- `src/classify.ts` maps path patterns to semantic events (transcript grew,
  pre-edit snapshot saved, state backup rotated, ...). Unknown patterns are
  reported loudly as UNCLASSIFIED: those are discoveries.
- `src/db.ts` persists events and full-tree snapshots to `data/observatory.db`
  (bun:sqlite, WAL) so questions can be asked retrospectively.
- `src/redact.ts` guards the only content-viewing path (`peek`): key-like
  tokens, JWTs, secret-named fields, and long hex/base64 runs are masked.

```
bun src/index.ts watch [--raw] [--no-db] [--quiet]
bun src/index.ts log [--since 1h] [--path <glob>] [--kind <k>] [--action <a>] [--limit N]
bun src/index.ts stats [--since 1h]
bun src/index.ts snapshot [--label <s>] [--list]
bun src/index.ts diff <a> <b>
bun src/index.ts explain <path>
bun src/index.ts peek <path> [--bytes N] [--tail]
bun src/index.ts daemon start|stop|status|plist
```

`explain` joins a path against the pattern-keyed sections of `FINDINGS.md` and
the observed event history in the db. `daemon plist` prints a launchd plist but
never installs it.

## The orchestrator

`src/orchestrator/` is the build system:

- **Work journal (011):** hash-linked, fsynced JSONL with intent/outcome
  bracketing around every state transition. Daemon state is rebuilt by
  folding the journal, so a resumed daemon and the process that crashed
  mid-move agree on what happened. `orchestrator journal verify` checks the
  chains offline, no daemon needed.
- **DAG readiness (012):** specs become schedulable when their dependencies
  are shipped at pinned contract hashes; post-ship spec amendments invalidate
  dependents until requalification re-pins them.
- **Stages (016-019):** build, ship, shepherd (CI-watching merge), verify.
  Stage completion is evaluated from gate exit codes and spec frontmatter
  after the session ends; the session's claim that it finished is not an
  input. Hook-blocked is a terminal stage outcome that is never
  self-resolved.
- **Quota scheduler (015):** quota exhaustion parks the run with a countdown
  and resumes at the next spec boundary; the daemon itself consumes no model
  quota.
- **Decision ledger (020):** sealed, queryable record of every D-n decision
  with provenance.
- **Standby daemon + project registry (021, 025-026):** the daemon idles in
  standby instead of exiting, serves the API and web UI, and schedules
  across every registered, armed project (one live stage session globally).
  `projects add` registers a target repo; arm/disarm is the consent toggle.

```
bun src/index.ts orchestrator status | dag | next | history
bun src/index.ts orchestrator projects [add <path>] [arm|disarm <name>] [requalify <name>]
bun src/index.ts orchestrator start | pause | resume
bun src/index.ts orchestrator decisions <query>
bun src/index.ts orchestrator spec <id> skip|retry|reverify|force-gate|approve
bun src/index.ts orchestrator journal verify
bun src/index.ts orchestrator daemon start|stop|status|run
```

The HTTP API (022, 027) is project-scoped under
`http://127.0.0.1:4519/api/projects/<name>/`, with one global SSE event
stream; the React dashboard (024, 029) is served by the same daemon and
mirrors the CLI's honesty rules (never-loaded is null, an unreachable daemon
is a named state, estimates say "estimate").

The approved backlog (specs 032-037) extends the same discipline to
driving repositories that are not this one: per-project execution
profiles (032; sessions run under a journaled posture instead of a
hardcoded permissions bypass), cost ceilings that park a run the way
quota exhaustion does (033), and a staged adoption path for ungoverned
repositories (034-037: read-only preflight cartography, draft-corpus
synthesis, holdback replay scoring against the target's own merge
history, and defect capture so adopted specs record behavior rather than
bless it).

## Operating

`./start.sh` boots the checkout: dependencies, the dashboard build, the
orchestrator daemon (API and web UI), and the `~/.claude` watcher; it ends
with both status views and the dashboard address. `./stop.sh` reverses it
with SIGTERM only and reports anything still alive. After a merge into
this repository the daemon announces code-stale and idles until it is
restarted (spec 026 D-7): `./start.sh --restart` is that restart.
`--skip-build` and `--no-watcher` skip those halves.

## Governance

`spec-spine compile | index | lint | couple` must stay green. Derived
artifacts under `.derived/` are read only through `spec-spine` subcommands.
The session protocol and backlog discipline live in `AGENTS.md`; the standing
rules, including the coherence guard, live under `.claude/rules/`.

## Evidence

"This repo was largely built by its own orchestrator" is not a story; it
is an exported record. `docs/evidence/journal-bundle.json` is a spec 031
bundle of the self-hosted project's two chains (work journal and decision
ledger): every record in sequence with its link hashes verbatim, payloads
included under a default-deny redaction policy, and an explicit
annotation for every withheld record. Verify it offline, with no daemon
and no access to the original journals:

```
bun src/index.ts orchestrator journal verify --bundle docs/evidence/journal-bundle.json
```

At export time it held 1038 work records (676 payloads verified verbatim,
97 redacted, 265 withheld) and 52 decision records, both chains intact.
"Redacted" and "withheld" are honesty classes, not verification: a
payload with even one field stripped can never re-bind to the chain and
is never reported as verified (031 D-2). The bundle is a point-in-time
export; the live journals keep growing, and a fresh export supersedes it.

## Findings

See `FINDINGS.md` for the path-by-path map of `~/.claude`, with the observed
evidence behind each claim and open questions marked as such.
