---
id: "023-orchestrator-cli"
title: "Orchestrator CLI: the primary control plane"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
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

## 7. Resolved decisions

D-1. `status` is the one composite read: it fetches `/api/run` and
`/api/quota` and renders them together, and `--json` prints
`{ok: true, data: {run, quota}}` composed from the two served envelopes,
whose payloads are the `RunView` and `QuotaView` types verbatim from spec
022's `types.ts`. Every other API-backed command maps to exactly one route
and prints that route's envelope unchanged. B-3 requires human output to
call an estimated quota horizon an estimate, and a run view alone cannot do
that (a parked run reads as idle); composing two already-shared shapes adds
no third declaration of the contract.

D-2. The group gains a fourth daemon verb, `daemon run`: the foreground
process that composes `createProductionDaemonDeps`, `Daemon.start()` (spec
021 B-2's lock, journals, recovery, loop) and `createApiServer` (spec 022),
and the thing `daemon start` spawns detached with its log at
`data/orchestrator/daemon.log`. B-2 names start, stop, and status, but
nothing in the repository composed a daemon with its API, so those three
verbs would have had no process to manage. Shutdown is composed here rather
than delegated to `installShutdownSignalHandler`: SIGTERM stops the HTTP
server first, then calls the daemon's own `shutdown()`, so no client can
reach a daemon that has already released its journals.

D-3. That hosted API reads both chains from their files
(`journalViewFromDir`), not from the daemon's handle. Spec 022's
`journalViewFromHandle` hands the API a view over the live handle, but that
handle is a private field of the `Daemon` class and spec 011's per-chain lock
refuses a second writer, so an in-process API can obtain neither. The file view re-parses only when size or
mtime changes and stops at the first line that does not parse or does not
continue the sequence, which is the torn tail journal.ts's own open-time
recovery drops as well. It can only report what the daemon has already
fsynced, and it can never append. The cleaner alternative (a read accessor
on `Daemon`) sits in spec 021's territory.

D-4. Only `unreachable` maps to exit 2; every other error kind,
`malformed-response` included, is an operational failure and exits 1, since
a daemon that answered off-contract is running and broken, not absent.
Usage errors (no command, unknown command, unknown flag, a flag missing its
value, an unknown verb, a trailing argument) print the reason and the usage
block to stderr and exit 3. `daemon status` also exits 2 when no live lock
holder exists, so one code answers "there is no daemon" whether the question
went over HTTP or to the lock file.

D-5. The offline commands (B-4's `journal verify`, and the daemon lifecycle)
answer in the same envelope under `--json`, always `ok: true`, with the
verdict inside `data` (`verified`, `running`, `staleLock`, `ready`) and the
outcome in the exit code. A tampered chain is
`{ok: true, data: {verified: false, ...}}` with exit 1, and a missing anchor
is reported the same way rather than thrown. The error kinds are the API's
vocabulary for what a request did, and no request was made.

D-6. One `--url` base address serves both halves: it tells a client where to
look and tells `daemon run|start` where to bind, resolved as `--url`, then
`OBSERVATORY_ORCHESTRATOR_URL`, then `http://127.0.0.1:4519`. Separate bind
and client knobs are how an operator starts a daemon on one port and queries
another with no error anywhere. Unknown flags are refused rather than
ignored: spec 005 records silent flag-swallowing as a defect, and in a
control plane whose verbs journal irreversible facts, `--jsonn` quietly
executing the verb in human mode is worse than an annoyance.

D-7. The CLI's spec verbs are aliases over the API's (`retry` ->
`retry-stage`, `force-gate` -> `force-human-gate`, with the long forms
accepted too), so B-2's grammar and spec 022 B-5's routes are one set of
verbs under two names. Every control the CLI issues carries
`X-Control-Source: cli`, so the record the daemon journals names the
terminal rather than defaulting to `api`, which is what lets the ledger
distinguish an operator's action from the web UI's.

## Verification

```verify:cli
bun test src/commands/orchestrator.test.ts
```

```verify:cli
# With no daemon serving HTTP, the client must exit 2 (unreachable), the
# documented honest outcome, never a crash.
bun src/index.ts orchestrator status --json > /dev/null 2>&1; test $? -eq 2
```
