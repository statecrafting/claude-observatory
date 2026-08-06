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
  # D-2: the repo's one gate makes a breaking API change and its in-repo
  # clients a single atomic landing; these edges cover the mechanical
  # adaptation only. The client feature surfaces stay with 028/029.
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "024-web-ui", unit: "web/", nature: additive }
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

D-2 (operator, 2026-08-01). Found by this spec's own ship: the repository
has one gate (`bun run typecheck` spans the CLI and `web/tsconfig.json`,
one test suite, one coupling check), so a breaking API cannot land alone;
its in-repo clients must move in the same commit or nothing compiles.
The build session held at the waiver checkpoint and the operator ruled:
this spec's territory gains additive extends edges on spec 023's and 024's
units covering the mechanical adaptation to the v2 shapes (route paths,
type names, envelope fields) only. The client feature surfaces (the CLI
projects group and --project grammar, the UI switcher and standby view)
remain 028's and 029's territory, built by their own sessions on top of
this landing. A waiver was deliberately not used: the coupling now states
the truth instead of being excused from it.

D-3 (operator, 2026-08-01). The reverify route alone may wake a daemon
when no controls are attached: `ProjectApi` gains an optional
`wakeControls` seam (composed from the scheduler's `openForControl`, 026
D-5), and the reverify handler awaits it before giving up. The response
contract is unchanged: the woken daemon journals the control record
synchronously, so the diffed-record rule (022 D-2) holds. All other
control verbs keep answering `unavailable` for a project with no live
run, which remains the honest answer for verbs that need one.

D-6 (2026-08-02, operator-directed fix wave). Found live after the 023/026
requalifications: the API's `shippedMapFromJournal` fold lacked two of the
scheduler's own sources, 021 D-16's merge-sha pin resolution and 021
D-18's `spec.requalified` replay, so the dag/state views rendered
"invalidated (pin drift)" blockers the scheduler had already resolved:
exactly the cached-status disagreement 022 B-6 forbids, reproduced by the
recomputed-fold path this time. The fold now takes an optional
`readSpecFileAtSha` (production: dag.ts's shared process reader, wired at
the dag route) and replays `spec.requalified` last, latest wins, pipeline
entries only. Absent reader (fixtures) falls back to exec creation pins,
which can only over-invalidate, never under-invalidate.

D-7 (2026-08-02, operator-directed fix wave). The dag view's per-node
blocker reasons gate on 012 D-3 exactly like the resolver: an unapproved
spec's node leads its reasons with "status <s> is not approved" so the UI
never renders a draft as merely dependency-blocked, and nextReady's own
blocker (computed by dag.ts) surfaces the same wording. No shape change;
reasons only.

D-8 (2026-08-02, spec 030's build, per its granted authority). Spec 030
adds one scoped read route additively: `GET
/api/projects/<name>/economics`, served by state.ts's
servedEconomicsView (030's pure fold plus `generatedAt` from the
daemon's clock), recomputed per request like every other read (B-6) and
listed in the meta route table with GET-only enforcement. The suffix
constant and the view shapes live in spec 030's own unit
(`src/orchestrator/economics.ts`) rather than PROJECT_ROUTES, so this
spec's contract files (types.ts, api-client.ts) are unchanged.

D-9 (2026-08-06, operator). The run view's blockers are scoped to the
run that stopped on them: a `run.blocked` record surfaces only while
its `runId` is the latest run's, where the unscoped fold surfaced a
dead run's verdict as if it were news (found live: a "status draft is
not approved" list from a run two restarts gone, shown beside a
current pause that said something else entirely). The pause reason
already had this scoping; the blockers now match it.
