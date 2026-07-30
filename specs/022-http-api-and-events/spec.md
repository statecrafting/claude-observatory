---
id: "022-http-api-and-events"
title: "Typed HTTP API and event stream (the only interface)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: medium
depends_on:
  - "021-orchestrator-daemon"
summary: >
  The daemon's single interface: a typed localhost HTTP API (Bun.serve)
  plus a server-sent-events stream with heartbeat, after the statecraft
  admin-stream pattern. Read endpoints cover the DAG with readiness and
  blockers, run state, stage evidence, quota state, decision-ledger
  queries, and run history; control endpoints cover start, pause, resume,
  skip, retry-stage, re-run-verify, and force-human-gate. Every response
  shape is a versioned TypeScript type shared with the clients; errors use
  one envelope with stable kind tokens. Localhost-only binding in v1, but
  nothing in the shapes assumes single-user forever.
establishes:
  - "src/orchestrator/api/"
---

# 022: HTTP API and event stream

## 1. Purpose

Every surface (CLI, web UI, tests, future integrations) is a client of this
API. One interface means state honesty has one place to live.

## 2. Territory

`src/orchestrator/api/` (server, routes, types, SSE fan-out, tests).

## 3. Behavior

- **B-1 (binding).** `127.0.0.1` only, default port 4519, configurable;
  refuses non-loopback binds in v1. No auth in v1 (loopback trust),
  designed so an auth layer slots in front without shape changes.
- **B-2 (envelope).** Success: `{ok: true, data}`; failure: `{ok: false,
  error: {kind, message}}` with stable kind tokens
  (statecraft-cli output pattern). All shapes exported from
  `src/orchestrator/api/types.ts` with an `apiVersion` constant served at
  `/api/meta`.
- **B-3 (reads).** `/api/dag` (specs with status, readiness, blockers,
  pins, invalidation), `/api/run` (current run, spec, stage, attempt),
  `/api/quota` (state, target, estimated flag, consecutive parks),
  `/api/decisions?query=` (spec 020 B-5), `/api/history` (spec executions
  with evidence refs: PR, CI conclusion, verify verdict),
  `/api/evidence/<hash>` (content-addressed evidence files, read-only).
- **B-4 (events).** `/api/events`: SSE with `retry: 3000`, 15 s comment
  heartbeat, subscription to journal appends, state transitions, session
  stream summaries (bounded), and quota ticks; ring-buffered replay of the
  last 256 events via `Last-Event-ID`.
- **B-5 (controls).** POST `/api/run/start|pause|resume`,
  `/api/spec/<id>/skip|retry-stage|reverify|force-human-gate`,
  `/api/spec/<id>/approve` (releases a human gate). Controls return the
  journaled control record; idempotent where the verb implies it.
- **B-6 (honesty).** Read endpoints serve only journal-derived state; there
  is no cached status that can disagree with a fold. Unknowns serialize as
  explicit unknowns.

## 4. Functional requirements

- **FR-001.** Route tests run against an in-process server with a fixture
  journal; SSE tests assert heartbeat cadence and replay.
- **FR-002.** A generated `api-client.ts` (typed fetch wrapper over the
  shared types) is exported for the CLI and web UI to consume.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/api/` passes.
- **AC-2.** `curl` of every read endpoint against a fixture daemon returns
  the documented envelope and types round-trip through the client.

## 6. Out of scope

Authentication, TLS, remote binding, GraphQL-style querying, and API
stability guarantees beyond `apiVersion` gating.

## 7. Resolved decisions

D-1. `POST /api/run/start` (B-5) means "ensure the run is running", never
"boot a daemon". Spec 021 B-2 fixes the boot order (lock, journals,
recovery, then the loop *and* this API), so by the time an HTTP request can
arrive the process is already up, and process lifecycle belongs to spec 023's
`daemon start|stop|status`. Within a hosted daemon, start delegates to
`resume` when the run is `paused`, is an idempotent no-op returning
`applied: false` when the run is already `running`, and is refused with
`conflict` when the run is `parked` (the quota scheduler's own countdown owns
that state, spec 015 B-3), `completed`, or `failed` (terminal sinks in spec
013's transition table). A journal with no run at all is also a conflict.
The `ControlTarget` seam therefore has no `start` member; it is exactly spec
021 B-4's seven control methods, which the `Daemon` class satisfies with no
adapter (asserted at compile time in `server.test.ts`).

D-2. The control record B-5 promises is diffed out of the journal, never
written by the API: a handler snapshots the record count, invokes the
daemon's own control method, and returns the first record that call appended
whose kind starts with `control.`. This module appends nothing to either
chain, so the daemon stays the single author of the fact and the response is
literally a read of what was journaled. An idempotent no-op returns
`applied: false` with `record: null` rather than a synthesized record.

D-3. `/api/evidence/<hash>` answers in the same envelope as every other read
route (`{hash, mediaType, bytes, text, base64}`, the unused body field
explicitly null), since AC-2 requires the documented envelope from every read
endpoint and the typed client can only cover a route that speaks it. The same
URL with `?raw=1` additionally serves the bytes with their own content type,
which is what spec 024 B-5's `<img src>` needs. Both forms require a
64-lowercase-hex hash, so nothing outside the evidence directory is
reachable.

D-4. B-4's "bounded" is implemented by replacement, not truncation: an event
whose payload encodes to more than 4096 characters streams as
`{bounded: true, seq, kind, chars}` and the client refetches derived state
from the read routes. A `session.result` payload carries a 16 KB stderr tail
that would otherwise dominate the 256-event ring, and a silently shortened
tail reads as the whole tail, which is what B-6 forbids. Quota ticks are
synthesized on a 15 s cadence while the run is parked, computed from the
journaled target each time (spec 015 B-2's "derived, not stored ticking
state").

D-5. `/api/dag` applies spec 021 D-5's own mask before computing
`nextReady`: every spec the journal shows shipped, or an operator has
skipped through a control, is overridden to a non-pending sentinel. The
target repo's registry only flips `implementation` once the build session's
frontmatter edit is merged and re-read, so an unmasked answer would name a
spec the daemon has demonstrably finished. Each node still reports the
registry's raw `implementation` plus a `skipped` flag, so nothing is hidden.

D-6. A spec file that cannot be read is reported as a pin error
(`currentPin: null`, `pinError` filled), never as pin drift: the lookup
handed to `invalidatedSet`/`nextReady` falls back to the pin recorded when
that spec shipped, so spec 012 B-4's invalidation cascade never fires on the
strength of an I/O error, and one missing file does not take down the whole
view.

D-7. B-4's "subscription to journal appends" is a pump, not a listener:
journal.ts (spec 011's territory) exposes no append hook, and adding one from
here would edit an owning spec's file. The pump polls the same read-only
`JournalView` the GET routes fold, starting from the journal's current tail,
so a stream never replays a whole run as if it were happening now and nothing
can be announced over SSE that a later fold would deny.

D-8. FR-002's "generated" client is route-table driven rather than
code-generated: `api-client.ts` takes every path from the shared
`API_ROUTES` table and every payload type from `types.ts`, so neither can
drift without failing typecheck, and the repo keeps its no-build-step
convention. Control routes validate a spec id by shape only, not registry
membership, so a control never fails for a `spec-spine` subprocess's reasons.
`apiVersion` gating is opt-in: a request declaring `X-Api-Version` is held to
it, one declaring nothing is served on the v1 assumption, which is what keeps
plain `curl` the first-class client AC-2 makes it.

## Verification

```verify:cli
bun test src/orchestrator/api/
```
