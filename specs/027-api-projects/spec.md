---
id: "027-api-projects"
title: "API v2: project-scoped routes"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: medium
depends_on:
  - "022-http-api-and-events"
  - "026-standby-daemon"
summary: >
  The breaking apiVersion 2 (010 D15): every project-scoped fact moves
  under /api/projects/<name>/, the project collection gains registration
  and arm/disarm controls, and genuinely global facts (daemon meta with
  standby state, account quota, the SSE stream) stay global with a
  project field on every event. v1 routes are retired, not aliased; the
  corpus's own pin-invalidation absorbs the break. Envelope, honesty,
  bounded-event, and route-table-driven client rules from 022 carry over
  verbatim.
extends:
  - { spec: "022-http-api-and-events", unit: "src/orchestrator/api/", nature: superseding }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 027: API v2, project-scoped

## 1. Purpose

One daemon now answers for many projects; a route that silently means
"the one repo" would misstate scope on every response. v2 makes the
project explicit in the path and keeps global facts global, which is what
B-6 honesty requires of a multi-project server.

## 2. Territory

`src/orchestrator/api/` (spec 022's unit, superseded as declared). The
build session amends spec 022 §3 (the B-3 and B-5 route tables) and D-8's
version-gating language in place to the v2 contract; that authority is
granted here. Spec 024's static fall-through (`static.ts`, the non-`/api`
handler) is untouched.

## 3. Behavior

- **B-1 (version).** `apiVersion` becomes 2, served at `/api/meta`. A
  request declaring `X-Api-Version: 1` is refused with the
  version-mismatch envelope (a v1 client must fail loudly, not receive
  shapes it cannot parse); a request declaring nothing is served on the
  v2 assumption, keeping plain curl the first-class client.
- **B-2 (project collection).** `GET /api/projects` lists the folded
  registry: name, repoDir, armed, qualification with reasons, and a
  current-run summary per project. `POST /api/projects` registers
  `{path, name?}`; `POST /api/projects/<name>/arm|disarm|requalify|remove`
  are controls. Control responses are the diffed-out-of-the-chain record,
  spec 022 D-2's pattern applied to the projects chain.
- **B-3 (scoped reads).** `/api/projects/<name>/dag|run|decisions|history`
  and `/api/projects/<name>/evidence/<hash>` serve the v1 payload shapes
  scoped to that project's journals and registry, each with the project
  name in the payload. Spec 022's D-5 masking and D-6 pin-error rules
  apply per project.
- **B-4 (global reads).** `/api/meta` gains the daemon state (standby,
  driving, parked) and the flight-slot holder; `/api/quota` stays global
  (the account's quota is one pool, 026 B-5); `/api/events` stays one SSE
  stream with every event carrying its project (null for daemon-scoped
  events), an optional `?project=<name>` server-side filter, and the
  single 256-event ring with `Last-Event-ID` replay unchanged.
- **B-5 (scoped controls).**
  `POST /api/projects/<name>/run/start|pause|resume` and
  `/api/projects/<name>/spec/<id>/skip|retry-stage|reverify|force-human-gate|approve`,
  with spec 022 D-1's start semantics applied within the named project's
  run. An unknown project name answers `not-found`, never an empty
  success.
- **B-6 (carried rules).** The envelope (022 B-2), honesty (B-6), bounded
  events (D-4), pump-not-listener SSE sourcing (D-7), and the
  route-table-driven client (D-8, regenerated for v2) carry over
  unchanged in spirit and letter.

## 4. Functional requirements

- **FR-001.** Route tests run against an in-process v2 server with a
  fixture registry and two fixture project journals; SSE tests assert the
  project field, the filter, and replay.
- **FR-002.** The regenerated `api-client.ts` covers every v2 route from
  the shared route table; no v1 path survives in the table.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/api/` passes.
- **AC-2.** `curl` of every v2 read route against a fixture daemon
  returns the documented envelope, and a request declaring
  `X-Api-Version: 1` receives the version-mismatch envelope.

## 6. Out of scope

Authentication, TLS, remote binding (022 B-1 governs, unchanged), v1
compatibility aliases, and per-project event rings.

## 7. Resolved decisions

D-1. Project names appear in paths raw: spec 025 D-1's slug grammar
guarantees no character that needs URL escaping, so the router matches on
plain string segments and nothing ambiguous can be addressed.
