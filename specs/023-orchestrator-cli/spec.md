---
id: "023-orchestrator-cli"
title: "Orchestrator CLI: the primary control plane"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: pending
risk: low
depends_on:
  - "022-http-api-and-events"
summary: >
  The observatory binary gains an `orchestrator` command group that is a
  pure client of the HTTP API: status, dag, next, start/pause/resume, spec
  controls (skip, retry-stage, reverify, force-gate, approve), decisions
  search, history, journal verify (offline, direct), and daemon
  start/stop/status with the identity-checked lock. Anything the UI can
  do, the CLI can do; several things (journal verify, daemon lifecycle)
  only the CLI does.
establishes:
  - "src/commands/orchestrator.ts"
extends:
  - { spec: "005-cli-surface", unit: "src/index.ts", nature: additive }
---

# 023: Orchestrator CLI

## 1. Purpose

CLI-first control keeps the orchestrator scriptable and honest: if a
capability exists, it is reachable from a terminal and therefore from
automation and tests.

## 2. Territory

`src/commands/orchestrator.ts`; one additive dispatch case in
`src/index.ts` (owned by spec 005, extended here).

## 3. Behavior

- **B-1 (client, not engine).** Every command except `journal verify` and
  `daemon start|stop|status` talks to the API through the generated typed
  client (spec 022 FR-002). No command re-derives state locally while a
  daemon is running.
- **B-2 (verbs).** `observatory orchestrator status | dag | next | start |
  pause | resume | history | decisions <query> | spec <id>
  skip|retry|reverify|force-gate|approve | journal verify | daemon
  start|stop|status`.
- **B-3 (output).** Human-readable by default, `--json` for the raw
  envelope; exit codes: 0 ok, 1 operational failure, 2 unreachable daemon,
  3 usage. Human output states estimates as estimates (quota).
- **B-4 (offline verify).** `journal verify` walks both chains (011, 020)
  directly and works with no daemon running; it is the operator's
  independent check, so it must not depend on the API.

## 4. Functional requirements

- **FR-001.** Command tests run against a fixture API server; usage errors
  are tested for exit code 3 and a usage line on stderr.
- **FR-002.** The spec 005 usage text gains one line for the group;
  existing commands are untouched.

## 5. Acceptance criteria

- **AC-1.** `bun test` for the CLI territory passes.
- **AC-2.** With the daemon from spec 021's fixture running,
  `observatory orchestrator status --json` returns the documented envelope.

## 6. Out of scope

Interactive TUI, shell completions, and configuration profiles.

## Verification

```verify:cli
bun test src/commands/orchestrator.test.ts
```

```verify:cli
# With no daemon serving HTTP, the client must exit 2 (unreachable), the
# documented honest outcome, never a crash.
bun src/index.ts orchestrator status --json > /dev/null 2>&1; test $? -eq 2
```
