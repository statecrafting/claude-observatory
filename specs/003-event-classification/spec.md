---
id: "003-event-classification"
title: "Semantic classification of observed events"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: engine
implementation: complete
risk: low
origin:
  retroactive: true
summary: >
  The first-match-wins rule table that maps a relative path (plus action,
  entry kind, and delta) to a semantic kind and a human label: transcripts,
  subagent transcripts, memory, file-history buckets, session registry,
  paste cache, shell snapshots, state-file rewrites, config edits, and the
  rest of the ~/.claude taxonomy. Unclassified is a first-class outcome with
  a loud label, never an error.
establishes:
  - "src/classify.ts"
---

# 003: Semantic classification

## 1. Purpose

Raw path strings mean nothing in a live feed. Classification turns each event
into an analyst-readable statement ("transcript grew: session 6d8e1015",
"state file rewritten (atomic replace)") and a stable `kind` vocabulary that
queries, stats, and the future orchestrator's quota detection key on.

## 2. Territory

`src/classify.ts`: the ordered rule table, the `kind` vocabulary, label
helpers (`short()`, `grewOrShrank()`).

## 3. Behavior

- **B-1 (rule table).** Rules are evaluated in array order against the
  relative path; the first match wins. The current table is the 30-rule set
  covering: transcript, memory, subagent-transcript, tool-result,
  session-extras, project-dir, file-history, session-env, task,
  session-registry, paste, shell-snapshot, prompt-history, state-backup,
  state-file, jobs, daemon, plugin, hook-file, cache, config, housekeeping,
  todos, first-fill, chrome, and root.
- **B-2 (unclassified).** A path matching no rule MUST yield
  `kind: unclassified` with an all-caps `UNCLASSIFIED:` label and MUST be
  stored like any other event. Unclassified is signal (a new Claude Code
  behavior), not an error.
- **B-3 (first-fill).** Activity inside directories that were empty at
  baseline (`telemetry`, `downloads`, `agents`, `skills`) gets the loud
  `ACTIVITY IN PREVIOUSLY-EMPTY DIR` label, because it means a feature fired
  for the first time.
- **B-4 (labels are derived, kinds are contract).** Label wording MAY evolve
  freely; the `kind` vocabulary is a compatibility surface for queries and
  downstream consumers and changes to it are changes to this spec.
- **B-5 (session-id compression).** Labels shorten UUIDs to their first 8
  characters; PID-keyed registry entries keep the full PID.

## 4. Out of scope

Content inspection (classification sees paths and sizes only) and rule
configurability. New `~/.claude` surfaces discovered later are added here as
rule-table amendments.

## 5. Known defects (recorded, not blessed)

- Bare container dirs (`projects`, `file-history`, `session-env`, `tasks`,
  `paste-cache`, `shell-snapshots`) have no rule of their own and land in
  unclassified when they themselves change.
- `projects/<slug>/<non-uuid>` paths fall through to unclassified.
- Rule 17's state-file temp-sibling branch is dead code today: such paths
  arrive as absolute paths (spec 002 defect list) and cannot match the
  `~/.claude.json.*` pattern. The events are still captured, as unclassified.
- Known-but-unruled root entries observed live: `.oauth_refresh.lock`,
  `.credentials.json`, `ide/`, `statsig/`, `local/`, `versions/`, `mcp.json`.
