---
id: "029-ui-projects"
title: "Web UI v2: project switcher and the standby view"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: medium
depends_on:
  - "024-web-ui"
  - "027-api-projects"
summary: >
  The SPA follows the API to v2: a project switcher over the registry, the
  five 024 views rendered per selected project, a standby view that makes
  "backlog complete, daemon alive" a first-class honest state, registry
  controls (register, arm, disarm, requalify) with the exact-record
  confirmation pattern, and a global banner for daemon state and account
  quota. Same-origin serving, no-optimistic-UI honesty, and the
  unreachable-daemon degradation from 024 carry over unchanged.
extends:
  - { spec: "024-web-ui", unit: "web/", nature: superseding }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 029: Web UI v2, project-scoped

## 1. Purpose

The user-facing point of 010 A-1: selecting, arming, and observing target
projects happens here, against the API, with no capability the CLI lacks
and none it bypasses (thesis B-3 unchanged).

## 2. Territory

`web/` (spec 024's unit, superseded as declared); `static.ts` and the
server fall-through are untouched. The build session amends spec 024 §3
in place where v2 shapes replace v1 ones; that authority is granted here.

## 3. Behavior

- **B-1 (switcher).** A project switcher lists every registered project
  with name, armed state, qualification (reasons on demand), and
  current-run summary, served from `GET /api/projects`. The five 024
  views (DAG, live run, quota, decisions, history) render for the
  selected project from its scoped routes.
- **B-2 (standby view).** The daemon state (standby, driving, parked) is
  always visible. Standby renders per-project backlog summaries honestly:
  complete, ready work waiting (with the armed flag explaining why it is
  or is not being taken), blocked with reasons, or driving. An empty
  backlog is a stated fact, never an empty-looking dashboard.
- **B-3 (registry controls).** Register, arm, disarm, and requalify from
  the UI, each showing the exact registry-chain record that will be
  journaled before confirming (024 B-6's pattern over the new controls).
  Run and spec controls carry over against the scoped v2 routes.
- **B-4 (global banner).** Account quota (global, estimates marked) and
  the flight-slot holder are rendered once, globally, never per project:
  scoping them to a project would misstate what they govern.
- **B-5 (carried rules).** Same-origin only (024 B-1), SSE live tail with
  `Last-Event-ID` replay now filtered to the selected project, no
  optimistic UI, unknowns as unknowns, and the explicit
  "daemon unreachable" degradation (024 AC-2) all carry over.

## 4. Functional requirements

- **FR-001.** The SPA builds with `bun run web:build` into assets the
  daemon serves; CI builds it (024 FR-001 unchanged).
- **FR-002.** Component tests cover the switcher, the standby view's
  armed-versus-waiting rendering, and the registry-control confirmation
  flow against a fixture v2 API.

## 5. Acceptance criteria

- **AC-1.** With a fixture daemon holding two projects (one armed and
  complete, one disarmed with ready work), the switcher, standby view,
  and per-project views render real journal-derived data end to end.
- **AC-2.** Killing the daemon mid-view degrades to the explicit
  "daemon unreachable" state (024 AC-2, re-asserted against v2).

## 6. Out of scope

Authentication and remote access (022 B-1 governs), spec editing,
historical analytics, and any orchestration behavior of its own.
