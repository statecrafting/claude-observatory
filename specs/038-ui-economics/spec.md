---
id: "038-ui-economics"
title: "Web UI: the economics panel"
status: approved
created: "2026-08-06"
authors: ["Bartek Kus"]
kind: surface
implementation: in-progress
risk: low
depends_on:
  - "029-ui-projects"
  - "030-run-economics"
summary: >
  The dashboard grows the panel spec 030 deliberately left out: a
  per-project economics view over the served rollup, per-spec cost and
  rework beside run totals, every number carrying its denominator and
  every unknown shown as unknown. No new API surface and no new
  capability the CLI lacks: the panel renders exactly what
  /api/projects/<name>/economics already serves, under the same honesty
  rules the rest of the SPA lives by (029: never-loaded is null, an
  unreachable daemon is a named state, estimates say estimate).
extends:
  # One new view in the v2 SPA; routing and the switcher are untouched.
  - { spec: "029-ui-projects", unit: "web/", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 038: The economics panel

## 1. Purpose

Spec 030 made cost and yield a served fact and named the dashboard panel
a later spec's territory. This is that spec. An operator deciding
whether to arm a project, raise a ceiling, or stop retrying a spec is
doing economics; the dashboard should answer without a terminal.

## 2. Behavior

- **B-1 (one panel per project).** The selected project gains an
  Economics view beside the existing five, rendering the served rollup:
  run totals first, then one row per spec with known cost, session
  count, cost-unknown session count, and rework (attempts beyond the
  first), sorted by known cost descending.
- **B-2 (denominators and unknowns).** Every aggregate names its
  denominator ("12 sessions, 3 with no reported cost"), and a spec
  whose whole cost is unreported renders "unknown", never 0.00. The
  panel invents no number the envelope does not carry.
- **B-3 (degradation).** An unreachable daemon and a never-loaded
  project degrade exactly as the other views do (029 B-5's states);
  an empty journal renders the empty state with the reason, not an
  empty table.

## 3. Functional requirements

- **FR-001.** Component tests cover: a rollup with mixed known and
  unknown costs (denominators rendered), the empty journal state, and
  the sort order.
- **FR-002.** The view reads only the existing typed client route; the
  test proves no new fetch path was added.

## 4. Acceptance criteria

- **AC-1.** `bun test web` passes with the new view's tests.
- **AC-2.** A Verification-declared browser assertion shows the panel
  rendering a seeded project's economics with its denominators.

## 5. Out of scope

New API routes or rollup changes (030 owns the numbers); cost charts or
trends (a table first; visualization is a later conversation);
cross-project aggregation.

## 6. Resolved decisions

D-1. A table, not a chart, in v1: the rollup is small (one row per
spec), the honesty rules are about denominators and unknowns, and a
chart would spend its pixels hiding exactly those.

## Verification

```verify:cli
bun install --frozen-lockfile && bun run web:build
```

```verify:browser
url: http://127.0.0.1:4519
The economics view for the selected project shows run totals and a per-spec table row that carries a known cost beside a denominator sentence naming how many sessions reported no cost.
```
