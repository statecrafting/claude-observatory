---
id: "014-session-driver"
title: "Claude Code session driver (fresh process, stream-json, classified outcomes)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
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
  retry), timeout, killed (daemon shutdown, spec 021 B-6), max-turns
  (the CLI's own turn-cap verdict), crashed.
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
  timeoutMs?, mcpConfigPath?})` spawns `claude -p --output-format
  stream-json --verbose --dangerously-skip-permissions` (plus
  `--mcp-config <path> --strict-mcp-config` when `mcpConfigPath` is given,
  D-10) with cwd = repo, prompt written to stdin then closed. No prompt
  content ever reaches argv or a shell.
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
  SIGTERM-then-SIGKILL), `killed` (the daemon's shutdown path severed the
  child through `killLiveSession()`, spec 021 B-6/D-19; same
  SIGTERM-then-SIGKILL shape, distinct kind because operator intent is not
  a deadline), `max-turns` (the result event's own `error_max_turns`
  subtype, checked before the regex table because the CLI's verdict is not
  prose to pattern-match, D-8), `crashed` (anything else). The rule table
  is data, exported, and unit-tested against captured fixtures.
- **B-5 (bounds).** Every session carries a wall-clock deadline and a
  max-turns cap; both configurable per stage with safe defaults. The
  SIGTERM-to-SIGKILL grace at the deadline is likewise configurable
  (default 5000 ms), and the escalation decision keys on whether the child
  actually exited, never on whether a signal was merely sent. A severed
  session journals its kind (`timeout` at the deadline, `killed` at daemon
  shutdown) with partial cost if a result never arrived.
- **B-6 (evidence).** Session end journals: classification, exit code,
  duration, num_turns, total_cost_usd and usage when reported, session id,
  the transcript path under `~/.claude/projects/` when derivable (via
  the observatory's own knowledge of the layout), as observational
  references only, and the result event's own text, tail-bounded
  (`resultTextTail`, D-9), so an unmatched termination leaves the exact
  haystack the classifier failed on in the durable record.

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

## 7. Resolved decisions

D-1. `--model` and `--max-turns` are only added to the `claude` invocation
when the caller supplies them; an omitted `maxTurns` leaves claude's own
default in effect rather than the driver inventing a number to put on the
command line. `timeoutMs` is different: it is never a CLI flag (claude has
none), always has a driver-side default (`DEFAULT_TIMEOUT_MS`, 30 minutes),
and is always enforced by the driver's own deadline timer, satisfying B-5's
"every session carries a wall-clock deadline... with safe defaults" without
conflating it with B-1's "only when given" flag rule.

D-2. `claudeVersion(claudeBin)` is exposed as a standalone primitive rather
than invoked automatically inside `runSession`, per this spec's own
implementation notes ("the caller journals `--version` once per run").
Spawning `claude --version` on every single session would re-read the same
string every time; the caller (a future daemon, spec 021) decides what
"once per run" means at its own lifetime scope and journals it itself.
`runSession`'s own `session.init` journal record still carries `claudeBin`
(the binary path used), which is the half of B-2's "binary path and
--version output are journaled" that belongs to this module.

D-3. Reset-time extraction (FR-002) checks patterns in order from least to
most guess-prone: an absolute ISO instant, then a relative duration
("resets in N minutes/hours", computed against the driver's own clock),
then a bare epoch number (10 digits read as seconds, 13 as milliseconds),
then a bare clock time ("resets at HH:MM[am/pm]"). Only the last pattern
has to assume anything: no timezone or date ever accompanies a bare clock
hint, so it is read as UTC on the current UTC day, rolling to the next day
when that time has already passed. The first pattern that matches wins;
no match returns null, never a guess.

D-4. `session.result`'s journal payload records the overflow buffer as two
integer counts (`overflowLineCount`, `overflowTruncatedCount`) rather than
the raw unparseable lines themselves, so the durable evidence record stays
small regardless of how noisy a run's stdout got. The full bounded lines
array (capped at `OVERFLOW_LINE_CAP`) is still returned on the in-memory
`SessionResult` per B-6's "overflow info"; only the journal copy is
summarized.

D-5. Mutable per-session state (session id, the captured result event, the
overflow buffer, the deadline/grace timers, the timed-out flag) is grouped
on one object rather than kept as separate closured `let` bindings.
TypeScript's control-flow narrowing otherwise mis-narrows a `let` that is
only ever reassigned from inside a nested closure to `never` at a later
read site (reproduced independently of this module); grouping the state on
an object sidesteps the false positive. This is purely a code-shape
decision with no behavioral effect.

D-6. CI exposed two timing defects the first landing shipped: the SIGKILL
escalation guarded on the runtime's "a signal was sent" flag (which our own
SIGTERM sets, so escalation could never fire exactly when the child ignored
SIGTERM), and the timeout tests relied on the 5000 ms default grace fitting
inside the test runner's own 5000 ms default deadline. Resolution: the
escalation keys on an explicit exited flag, the grace is configurable
(killGraceMs, default unchanged), and the tests pin a short grace with
explicit test deadlines. Recorded because it changed B-5's wording.
The same CI round exposed a third defect: the driver waited for stdout and
stderr EOF, but a killed child's orphaned grandchild inherits those pipe
descriptors and can hold them open indefinitely (Linux showed this; macOS
timing masked it). Process exit is now the authoritative boundary; streams
are captured incrementally and drained for at most a bounded grace
(PIPE_DRAIN_GRACE_MS) after exit.

D-7 (2026-08-02, operator-directed fix wave). B-4 gains the `killed` kind:
true only when the daemon's shutdown path severed the live child through
the driver's exported `killLiveSession()` (spec 021 B-6/D-19). Like
`timedOut`, it is a driver-set flag, never inferred from text, and it is
checked after `completed` (a result that raced the kill and reported
success still wins) but before `timeout` (a shutdown landing after the
deadline fired still records the operator's intent). The kill closure is
module-global and registered per session, which the serial invariant
(FR-003) makes safe: only one child can ever be live in the process. It
registers synchronously with the spawn, before the prompt write's first
await, so a shutdown landing in the spawn's own tick still finds the
child; a prompt-delivery failure on a pipe the kill already closed is
tolerated (the result path classifies and journals `killed` normally),
while any other stdin failure still throws.

D-8 (2026-08-02, operator-directed fix wave). B-4 gains the `max-turns`
kind. A session that hits its turn cap ends with a result event whose
subtype is `error_max_turns`; before this entry that fell through the rule
table to `crashed` (observed live), and worse, its prose could in
principle match the quota patterns and park the run for hours on a
mis-read. The subtype is the CLI's own verdict, so it is checked ahead of
the regex table, after the driver flags: a turn-capped session is neither
a crash nor a quota event, and the right response upstream (a remediation
session) is exactly what the stages already do with a failed attempt.

D-9 (2026-08-02, operator-directed fix wave). `session.result` journals
`resultTextTail`: the result event's subtype and text, tail-bounded to the
same cap as `stderrTail`, null when no result event arrived. The
classifier's rule table (B-4) is regex over observed text, and it is
load-bearing: a false negative burns a run, a false positive parks it for
hours. Growth of that table has to come from real unmatched haystacks
preserved at the moment they failed to match, not from recollections;
`stderrTail` was already journaled, and this closes the other half.

D-10 (2026-08-03, operator). B-1 gains an optional `mcpConfigPath`: when
present, the spawn appends `--mcp-config <path> --strict-mcp-config` to
the argv. The strict flag is the point: a daemon-driven session sees
exactly the MCP server set its caller declared, never whatever user- or
project-level MCP configuration happens to exist on the host. Absent, the
argv is unchanged, so build, ship, and shepherd sessions are untouched.
The first consumer is spec 019's browser verifier (its D-10): headless
`claude -p` sessions have no Claude-in-Chrome pairing, so browser
verification needs a server the driver can declare explicitly.
