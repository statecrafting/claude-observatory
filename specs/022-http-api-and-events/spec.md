---
id: "022-http-api-and-events"
title: "Typed HTTP API and event stream (the only interface)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: pending
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
