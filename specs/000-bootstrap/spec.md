---
id: "000-bootstrap"
title: "Bootstrap spec system for claude-observatory"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
summary: >
  Foundational contract for this repository: authored truth lives only in
  markdown (+ YAML frontmatter); machine-consumable truth is compiler-emitted
  JSON only; every artifact is a deterministic function of (config, file
  contents); a typed authority graph governs who-owns-what. claude-observatory
  adopted spec-spine retroactively on 2026-07-29: the code under src/ and
  scripts/ predates this corpus, and specs 001-008 record its behavior as
  found, defects included, rather than blessing them as contract.
origin:
  retroactive: true   # authority held since before the graph existed
unamendable:
  - "markdown-truth-boundary"
  - "json-truth-boundary"
  - "determinism-requirement"
  - "directory-name-equals-id"
  - "typed-authority-graph"
  - "refusal-rule"
---

# 000: Bootstrap spec system

This is the spec that defines what a spec *is* for claude-observatory. Each
compilation unit links back here (or to a more specific spec) via the
`"spec-spine"` key in `package.json`, a `// Spec:` comment header, or a
spec's ownership edge.

## 1. The authoring / derived boundary

Humans author markdown; the compiler owns the JSON. Never hand-edit a derived
artifact. Derived shards under `.derived/` are committed (except
`build-meta.json` and `attestation/`), and are read only through `spec-spine`
subcommands.

## 2. The typed authority graph

Specs declare typed edges (`establishes`, `extends`, `refines`, `supersedes`,
`amends`, `co_authority`, `constrains`, `references`) and the units they own
(file / section / symbol / directory / crate / module). Authority is derived
by walking the graph.

## 3. Retroactive adoption

The observatory tool (specs 001 through 008) was hand-built before this corpus
existed. Those specs carry `origin.retroactive: true` and real `establishes`
edges so the coupling gate holds from the first governed commit. Where the
implementation has known defects, the owning spec records them in a
"Known defects" section instead of silently normalizing them; fixing a
recorded defect is a code change coupled to that spec.

## 4. Corpus conventions

- Spec bodies follow the template: Purpose, Territory, Behavior (MUST/SHOULD/
  MAY), Out of scope; larger specs add Functional requirements (FR-nnn),
  Acceptance criteria (AC-n), and Resolved decisions (D-n) sections.
- Design analysis lives under `docs/design/` and is cited from specs with
  non-owning `references` edges.
- `depends_on` expresses build order for the backlog protocol in `AGENTS.md`;
  spec-spine itself attaches no mechanics to it. Orchestration semantics over
  `depends_on` (readiness, pinning, invalidation) are product behavior owned
  by the orchestrator specs (010+), not by this bootstrap.
