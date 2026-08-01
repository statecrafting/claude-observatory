---
id: "025-project-registry"
title: "Project registry: governed targets for a general orchestrator"
status: approved
created: "2026-08-01"
authors: ["Bartek Kus"]
kind: kernel
implementation: complete
risk: medium
depends_on:
  - "011-work-journal"
  - "012-spec-dag-readiness"
summary: >
  The registry of target repositories the orchestrator may drive: a third
  hash-linked chain (the spec 011 envelope under a caller-chosen basename)
  living in the daemon home, folded into the current set of projects. A
  project is a named, absolute repo path with an armed flag and a recorded
  qualification verdict. Qualification is a read-only preflight (git repo
  with an origin remote, spec-spine compile green in the target, specs
  present); unqualified projects stay visible with their reasons and are
  never scheduled. Per-project orchestrator state lives inside each target
  at data/orchestrator/, byte-compatible with the self-hosted layout.
establishes:
  - "src/orchestrator/projects.ts"
  - "src/orchestrator/projects.test.ts"
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 025: Project registry

## 1. Purpose

Generalizing the orchestrator (010 A-1) starts with an honest answer to
"what may this daemon touch, and why". The registry is that answer: every
target is registered, qualified, and journaled before a single session is
driven against it.

## 2. Territory

`src/orchestrator/projects.ts` and its colocated tests. Storage is a third
chain in the daemon home, `data/orchestrator/projects.jsonl` (with its
anchor), reusing spec 011's `openJournal(dir, basename)` seam exactly as
the decision ledger (020) does.

## 3. Behavior

- **B-1 (model).** A project is `{name, repoDir, armed, qualification}`:
  `name` a unique slug (the registry's key and the API path segment),
  `repoDir` an absolute path, `armed` per 010 D14, `qualification` the
  latest recorded verdict with reasons. The self-hosted checkout is not
  special: it is simply the first registered project.
- **B-2 (chain, not table).** Registry state is derived by folding the
  projects chain; register, arm, disarm, requalify, and remove are each an
  appended record carrying its source (cli, api, ui), never an in-place
  mutation. The chain verifies with spec 011's `verifyChain`.
- **B-3 (two roots).** The daemon home (this checkout's
  `data/orchestrator/`: lock, log, projects chain) is where the daemon
  lives. A project's state root (`<repoDir>/data/orchestrator/`: work
  journal, decision ledger, evidence) is where facts about that project
  live, in exactly today's self-hosted layout, so spec 011/020 machinery
  and offline `journal verify` work unchanged when pointed at any project.
- **B-4 (qualification).** A read-only preflight against the target
  records a verdict with per-check reasons: it is a git repository with an
  `origin` remote and a resolvable default branch; `spec-spine compile`
  exits green run inside it; its specs directory exists and is non-empty.
  A failing target registers as unqualified (visible, reasons served),
  never silently dropped. Qualification also warns, without fixing, when
  the target does not gitignore `data/`: the orchestrator never edits a
  target's authored files itself.
- **B-5 (write discipline).** Outside driven sessions, the orchestrator
  process writes nothing in a target except its state root. `~/.claude`
  stays read-only for every code path (spec 001 B-7, inherited unchanged).

## 4. Functional requirements

- **FR-001.** Fold tests cover register, arm/disarm, requalify, remove,
  and re-register; chain verification passes over every fixture history.
- **FR-002.** Qualification tests run against fixture directories: a
  governed repo, a repo without origin, a non-repo, and a governed repo
  whose `data/` is not gitignored (qualifies, with the warning recorded).

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/projects.test.ts` passes.
- **AC-2.** `verifyChain` passes over the projects chain produced by
  AC-1's histories.

## 6. Out of scope

Scheduling (spec 026 owns which project runs), API and UI surfaces (027,
029), cross-project dependency edges, and any mutation of a target's
authored files.

## 7. Resolved decisions

D-1. `name` is a lowercase slug (`[a-z0-9][a-z0-9-]*`), chosen at
registration (defaulting to the repoDir basename, slugified) and unique
among non-removed projects. Slugs keep the name safe as an API path
segment with no escaping (027 relies on this).

D-2. Remove is a tombstone: the chain is append-only, so removal appends a
record and the fold drops the project. Re-registering the same name later
resumes the same state root in the target; the project's journal history
is the target's property and is never deleted by the orchestrator.
