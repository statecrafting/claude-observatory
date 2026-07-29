# CLAUDE.md

Read `AGENTS.md` for the session protocol (`## New Sessions`) and the backlog
discipline (`## Working the backlog`). This file only carries what Claude
Code needs beyond it.

- Runtime is Bun (`bun src/index.ts <command>`); there is no build step.
- The spec corpus governs everything: `spec-spine compile | index | lint |
  couple` must stay green. Read derived artifacts only through `spec-spine`
  subcommands.
- Specs 001-008 describe shipped behavior of the observatory layer, defects
  included; do not "fix" a recorded defect without coupling the change to
  its owning spec.
- The orchestrator layer (specs 010+) is the active backlog. Its design
  ground truth is `docs/design/00-ecosystem-analysis.md`; substrate
  boundaries there (D1) are load-bearing.
- `~/.claude` is observed, never written. `data/` is never committed.
