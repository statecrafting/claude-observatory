---
id: "014-session-driver"
title: "Claude Code session driver (fresh process, stream-json, classified outcomes)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: pending
risk: critical
depends_on:
  - "013-run-state-machine"
summary: >
  The one place that spawns Claude Code. A fresh `claude` process per
  attempt: prompt piped on stdin (never shell-interpolated), -p with
  --output-format stream-json --verbose, cwd = target repo, pinned CLI
  version recorded, OAuth token auth with ANTHROPIC_API_KEY explicitly
  removed from the child env (the documented precedence trap). Streams
  events to subscribers, journals session start/end with cost and result,
  and classifies terminations: completed, auth-failure (hard stop),
  quota-exhausted (park, spec 015), hook-blocked, transient (bounded
  retry), timeout, crashed.
establishes:
  - "src/orchestrator/session.ts"
  - "src/orchestrator/session.test.ts"
  - "src/orchestrator/classify-termination.ts"
  - "src/orchestrator/classify-termination.test.ts"
---

# 014: Session driver

## 1. Purpose

Everything nondeterministic funnels through this seam. If the driver is
honest (about exit reasons, cost, and output), every layer above it can be
deterministic scaffolding.

## 2. Territory

`src/orchestrator/session.ts`, `src/orchestrator/classify-termination.ts`,
and their tests.

## 3. Behavior

- **B-1 (spawn).** `runSession({repo, prompt, model?, maxTurns?,
  timeoutMs?})` spawns `claude -p --output-format stream-json --verbose
  --dangerously-skip-permissions` with cwd = repo, prompt written to stdin
  then closed. No prompt content ever reaches argv or a shell.
- **B-2 (env hygiene).** Child env = parent env minus `ANTHROPIC_API_KEY`
  (an empty or unset API key must not shadow OAuth); `NO_COLOR=1`. The
  `claude` binary path and `--version` output are journaled once per run.
- **B-3 (stream).** stdout is parsed as newline-delimited JSON events
  (system/init, assistant, user, result). Events are forwarded to an
  injectable sink (the SSE fan-out, spec 022, and the journal for
  boundaries: init and result always journal; intermediate events do not).
  Unparseable lines are preserved verbatim in a bounded overflow buffer and
  counted, never dropped silently.
- **B-4 (classification).** Termination classification is a pure function
  over (exit code, result event, stderr tail): `completed` (result with
  is_error false), `auth` (the statecraft classifier regex family:
  authentication/permission/invalid key/unauthorized/forbidden/oauth
  invalid-expired-revoked-missing), `quota` (usage-limit/rate-limit shapes
  including reset-time hints, extracted when present), `hook-blocked`
  (result carrying a blocking-hook refusal), `transient` (5xx, overloaded,
  network), `timeout` (driver-enforced deadline, child killed
  SIGTERM-then-SIGKILL), `crashed` (anything else). The rule table is data,
  exported, and unit-tested against captured fixtures.
- **B-5 (bounds).** Every session carries a wall-clock deadline and a
  max-turns cap; both configurable per stage with safe defaults. A killed
  session journals `timeout` with partial cost if a result never arrived.
- **B-6 (evidence).** Session end journals: classification, exit code,
  duration, num_turns, total_cost_usd and usage when reported, session id,
  and the transcript path under `~/.claude/projects/` when derivable (via
  the observatory's own knowledge of the layout), as observational
  references only.

## 4. Functional requirements

- **FR-001.** The driver works against a fake `claude` (a test script
  emitting recorded stream-json) for all classifications without network.
- **FR-002.** Reset-time extraction: when a quota message carries a reset
  hint (absolute time or duration), the classifier returns it normalized to
  epoch ms; absence returns null, never a guess.
- **FR-003.** Two sessions cannot run concurrently in one daemon (serial v1
  invariant enforced here with a held lock, not only by scheduling
  discipline).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/session.test.ts
  src/orchestrator/classify-termination.test.ts` passes.
- **AC-2.** A live smoke session against this repo with a trivial prompt
  (`claude -p "reply DONE"`) classifies `completed` and journals cost.

## 6. Out of scope

Prompt construction (stages own their prompts, specs 016-019), PTY/TUI
driving, resuming sessions with --resume (fresh sessions are the model;
remediation is a new session with context injected).
