---
id: "024-web-ui"
title: "Localhost web UI: the observability surface"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: pending
risk: medium
depends_on:
  - "022-http-api-and-events"
summary: >
  A read-mostly single-page app served same-origin by the daemon (built
  assets embedded, statecraft pattern): DAG view with status, readiness,
  blockers, and invalidation; live run view with current spec, stage, and
  streaming session output over SSE; quota state with time-to-reset
  (estimates marked); searchable decision-ledger browser; run history with
  the per-spec evidence trail (PR, CI result, verify verdict, costs); and
  the control verbs the API exposes, each with a confirmation that names
  what will be journaled. It is an observability surface, not a wizard:
  every number on screen is traceable to a journal record or an evidence
  file.
establishes:
  - "web/"
  - "src/orchestrator/api/static.ts"
  # Pre-authorized manifest touches for the build session: the SPA needs a
  # web:build script and frontend devDependencies. Section units keep the
  # claim narrow (the rest of package.json stays under the bootstrap floor).
  - { kind: section, file: "package.json", anchor: "scripts" }
  - { kind: section, file: "package.json", anchor: "devDependencies" }
---

# 024: Localhost web UI

## 1. Purpose

The at-a-glance answer to "what is it doing, why, and can I trust it",
without ssh-ing into a terminal. Honesty over polish.

## 2. Territory

`web/` (Vite + React SPA, no server-side code) and
`src/orchestrator/api/static.ts` (same-origin static serving of the built
assets by the daemon).

## 3. Behavior

- **B-1 (serving).** The daemon serves the built SPA at `/`; the SPA talks
  only to the same-origin API and SSE stream. No external network requests
  (fonts, CDNs, telemetry: none).
- **B-2 (DAG view).** Nodes show spec id, title, lifecycle +
  implementation, readiness or the blocker list verbatim from `/api/dag`,
  pin drift (invalidation) prominently. Edges are `depends_on`.
- **B-3 (live run).** Current spec, stage, attempt, elapsed, and a
  scrollback-bounded live tail of session events from SSE; disconnects
  reconnect with `Last-Event-ID` replay.
- **B-4 (quota).** Parked state shows the countdown target, the estimated
  flag when the horizon is inferred, and consecutive-park warnings.
- **B-5 (decisions and history).** Ledger browser with query passthrough
  to `/api/decisions`; history lists spec executions with links to PR, CI
  run, verify verdict, and evidence files served from `/api/evidence/`.
- **B-6 (controls).** Start, pause, resume, skip, retry stage, re-run
  verify, force human gate, approve. Each control shows the exact control
  record that will be journaled before confirming. Controls are the only
  writes; everything else is read-only.
- **B-7 (read-mostly and honest).** No optimistic UI: state changes render
  only after the SSE event or a refetch confirms them. Unknowns render as
  unknown, never as spinners that imply progress.

## 4. Functional requirements

- **FR-001.** The SPA builds with `bun run web:build` into assets the
  daemon embeds/serves; CI builds it.
- **FR-002.** Component tests cover the DAG readiness rendering and the
  control confirmation flow against a fixture API.

## 5. Acceptance criteria

- **AC-1.** With the fixture daemon running, the five views render real
  journal-derived data end to end.
- **AC-2.** Killing the daemon mid-view degrades to an explicit
  "daemon unreachable" state, not a stale-but-live-looking dashboard.

## 6. Out of scope

Authentication and remote access (spec 022 B-1 governs), historical
analytics/charts beyond the history list, and any spec-editing capability
(specs are authored in the repo, reviewed as code).

## Verification

```verify:cli
bun install --frozen-lockfile && bun run web:build
```
