---
id: "028-cli-projects"
title: "CLI v2: the projects group and project-scoped verbs"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: surface
implementation: pending
risk: low
depends_on:
  - "023-orchestrator-cli"
  - "027-api-projects"
summary: >
  The orchestrator command group follows the API to v2: a projects
  subgroup (list, add, arm, disarm, requalify, remove), a --project flag
  scoping the existing verbs to a named project, a composite status that
  renders the daemon state plus one row per project, and an offline
  journal verify that resolves a project's state root through the daemon
  home's registry chain. Client-not-engine, exit codes, and the
  X-Control-Source discipline from 023 carry over unchanged.
extends:
  - { spec: "023-orchestrator-cli", unit: "src/commands/orchestrator.ts", nature: superseding }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 028: CLI v2, project-scoped

## 1. Purpose

If a capability exists it is reachable from a terminal (023's thesis);
the capabilities now include registering, arming, and observing many
projects, so the grammar grows to say which project it means.

## 2. Territory

`src/commands/orchestrator.ts` and its colocated tests (spec 023's unit,
superseded as declared). The build session amends spec 023 B-2's grammar
and D-1's composite-status description in place to the v2 contract; that
authority is granted here.

## 3. Behavior

- **B-1 (projects group).** `observatory orchestrator projects` lists the
  registry (name, armed, qualification, current run, one row each);
  `projects add <path> [--name <slug>] [--disarmed]`,
  `projects arm|disarm|requalify|remove <name>` issue the matching v2
  controls and print the journaled record, 023's control pattern.
- **B-2 (scoping flag).** `--project <name>` scopes dag, next, start,
  pause, resume, history, decisions, and the spec verbs to that project's
  v2 routes. `status` without `--project` is the new composite: daemon
  state (standby, driving, parked), global quota, and the per-project
  rows; with `--project` it renders that project's run and the global
  quota, the 023 D-1 composition against v2 shapes.
- **B-3 (offline verify).** `journal verify --project <name>` resolves
  the project's state root by folding the daemon home's projects chain
  directly (a file read, no API, exactly 023 B-4's stance), then walks
  both chains in that root; `journal verify --dir <path>` bypasses the
  registry for a bare state root. With neither flag it verifies the
  self-hosted root, today's behavior.
- **B-4 (carried rules).** Client-not-engine (023 B-1), human output with
  estimates named as estimates, `--json` printing served envelopes
  verbatim, exit codes 0/1/2/3 with 023 D-4's mapping, refused unknown
  flags, and `X-Control-Source: cli` all carry over. An unknown project
  name is an operational failure (exit 1): the daemon answered, the
  project does not exist.

## 4. Functional requirements

- **FR-001.** Command tests run against a fixture v2 API server; the
  projects group, the scoping flag, and the composite status are covered,
  and usage errors keep exit code 3 with a usage line on stderr.
- **FR-002.** Offline verify tests cover registry-resolved, explicit
  `--dir`, and default self-hosted roots with no daemon running.

## 5. Acceptance criteria

- **AC-1.** `bun test src/commands/orchestrator.test.ts` passes.
- **AC-2.** With the fixture daemon running,
  `observatory orchestrator status --json` returns the documented v2
  composite envelope.

## 6. Out of scope

Interactive TUI, shell completions, configuration profiles, and any
engine behavior (the daemon and API own it all).
