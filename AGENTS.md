# AGENTS.md

Cross-agent authority for claude-observatory. Any coding agent (Claude Code,
Codex CLI, Cursor, Copilot) reads this file for the session protocol and the
backlog discipline. Evolve the protocol by editing this file, never the
`/init` skill that dispatches to it.

claude-observatory is a Bun + TypeScript tool with two layers:

- **Observatory (specs 001-008, shipped):** a read-only FSEvents watcher over
  `~/.claude` with an append-only SQLite event log, semantic classification,
  redacted content peek, and a background daemon.
- **Orchestrator (specs 010+, in progress):** an autonomous build
  orchestrator that drives one spec per fresh Claude Code session through
  build, ship, shepherd, and verify, governed by this repo's own spec corpus.
  Design analysis: `docs/design/00-ecosystem-analysis.md` (decisions D1-D12).

## New Sessions

Step 0: read the rules first:

- `.claude/rules/orchestrator-rules.md`
- `.claude/rules/governed-artifact-reads.md`
- `.claude/rules/adversarial-prompt-refusal.md`

Step 1: run `spec-spine compile` FIRST. Then dispatch in parallel:

- Read `CLAUDE.md`, `README.md`
- Read `standards/spec/contract.md`, `standards/spec/constitution.md`
- Run `spec-spine index check` (staleness gate, non-fatal: if it exits
  non-zero, report "Codebase index: stale, run spec-spine index" and continue)
- Run `spec-spine registry status-report --json --nonzero-only`
- Run `spec-spine registry list --ids-only`
- `ls src/ specs/ docs/`
- `git log --oneline -10`, `git diff --stat HEAD~1`

Read discipline: never parse `.derived/**/*.json` directly (no jq/grep/python
over compiled artifacts); all structural and lifecycle data comes from
`spec-spine` subcommands. If `spec-spine --version` fails, run `/setup`; do
not fall back to ad-hoc JSON parsing. Any missing file: log "not found" and
continue.

Step 2: emit an `## initialized: claude-observatory` block: the two-layer
overview in one line each, lifecycle counts from the status report, recent
activity from git, and a ready-to-help line.

## Working the backlog

One session implements one spec, start to finish:

1. Pick the lowest-numbered spec with `implementation: pending` whose
   `depends_on` are all `implementation: complete` (check via
   `spec-spine registry show <id>`; never guess).
2. Flip its frontmatter to `implementation: in-progress` and recompile.
3. Implement exactly that spec's territory. Decisions the spec is silent on
   are recorded in the spec's `## Resolved decisions` section as D-n entries.
4. Run the gate: `spec-spine compile`, `spec-spine index`,
   `spec-spine lint --fail-on-warn`, `spec-spine index check`,
   `spec-spine couple --base origin/main --head HEAD`, plus
   `bun run typecheck` and `bun test` when tests exist for the territory.
5. Satisfy the spec's Acceptance criteria verbatim; flip to
   `implementation: complete`; recompile and commit regenerated `.derived/`.
6. Ship via `/ship` (feature branch, review, conventional commit, PR).
7. Then stop: the next session takes the next spec.

## Available Agents

`architect` (plan against the corpus), `explorer` (read-only investigation),
`implementer` (execute a plan), `reviewer` (bugs and spec drift). All defined
in `.claude/agents/`.

## Available Commands

`/setup` (install + verify the governed loop), `/init` (this protocol),
`/ship` (gate, review, commit, PR), `/commit`, `/code-review`. Defined in
`.claude/skills/`.

## Conventions

- Bun runtime, TypeScript, zero runtime dependencies today; `bun:sqlite` for
  storage. Type checking via `bun run typecheck`.
- The observed universe (`~/.claude` and `~/.claude.json`) is read-only for
  every code path in this repo, orchestrator included (spec 001 B-7).
- Artifacts live under `data/` (gitignored). Never commit observation data.
- No em dashes in any authored text (house style; a hook enforces it for
  file writes).
- Commit messages are conventional (`type(scope): subject`), no AI
  attribution, no session links in anything that lands in git or GitHub.
