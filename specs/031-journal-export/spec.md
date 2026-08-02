---
id: "031-journal-export"
title: "Journal export: a redacted, offline-verifiable evidence bundle"
status: approved
created: "2026-08-02"
authors: ["Bartek Kus"]
kind: feature
implementation: in-progress
risk: medium
depends_on:
  - "011-work-journal"
  - "020-decision-ledger"
  - "028-cli-projects"
summary: >
  The evidence that the orchestrator built and self-corrected this
  repository lives gitignored in data/: hash-linked, offline-verifiable,
  and visible to exactly one machine. Anyone else evaluating the claim
  has specs and commits, which is circumstantial. This spec adds
  `journal export`: a bundle that preserves both chains' link hashes
  verbatim, includes record payloads only under a default-deny redaction
  policy (kind allowlist plus per-field stripping), and verifies offline
  with no daemon and no access to the original: chain integrity for
  every record, payload-hash equality for every included payload, and
  an explicit annotation for every withheld one. The bundle is
  committable: it converts "it built itself" from a story into
  something a skeptic can check in a minute.
establishes:
  - "src/orchestrator/export.ts"
  - "src/orchestrator/export.test.ts"
extends:
  # Two verbs: journal export writes a bundle; journal verify --bundle
  # checks one offline.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 031: Journal export

## 1. Purpose

A hash-linked ledger that only its author can read proves nothing to
anyone else. The work journal and decision ledger already carry every
field needed to demonstrate the self-construction claim (and, framed for
a different audience, an audit trail for AI-generated code); what is
missing is a way to hand that record to a third party without also
handing them private paths, session text, and repository content the
record embeds as evidence tails.

## 2. Territory

`src/orchestrator/export.ts` and its tests: bundle assembly, the
redaction policy, and offline bundle verification. Additive extension as
declared in `extends`: the `journal export` and `journal verify
--bundle` verbs in the CLI. The build session is granted authority to
record an additive D-n note in spec 028 for the verb additions, per the
coherence guard's explicit-authority clause; 011's chain format and
verifyChain are consumed, never modified.

## 3. Behavior

- **B-1 (bundle shape).** An export covers both chains of one project
  (work journal, decision ledger). Every record appears in sequence
  with its link hashes exactly as journaled; a record whose payload the
  policy includes carries that payload verbatim, and a record whose
  payload the policy withholds carries instead an explicit redaction
  annotation naming what was withheld (the kind is always included).
  Nothing is silently dropped: record count in equals record count out.
- **B-2 (default-deny redaction).** Inclusion is an allowlist of record
  kinds (state transitions, stage results and brackets, session
  results, quota events, control records, adoption and requalification
  records, decision seals), and within an allowlisted kind, fields are
  stripped by name where they can carry free text or private paths
  (`stderrTail`, `resultTextTail`, `transcriptPath`, absolute paths in
  any field, evidence text). Costs, counts, classifications, exit
  codes, shas, pins, spec ids, and timestamps pass through. A kind the
  policy does not name is hash-only by default: growth of the journal's
  vocabulary can never leak by omission.
- **B-3 (offline verification).** `verifyBundle(bundle)` needs no
  daemon, no original journal, and no network: it checks link-hash
  continuity across every record of both chains, recomputes and
  compares the payload hash for every included payload, and reports
  withheld records as withheld (never as verified content). Its verdict
  distinguishes "chain intact, N payloads verified, M withheld" from
  any tamper, including a truncated tail.
- **B-4 (CLI).** `observatory orchestrator journal export --out <path>
  [--project <name>]` writes the bundle (a directory or single file,
  the build session's choice, recorded as a D-n) and prints what was
  included, withheld, and where; `journal verify --bundle <path>`
  runs B-3 and maps its verdict to 023's exit codes. Export is
  read-only with respect to both chains.
- **B-5 (determinism).** Two exports of the same journals with the same
  policy produce byte-identical bundles (constitution: same inputs,
  same output); the bundle embeds the policy version it was produced
  under.

## 4. Functional requirements

- **FR-001.** Export and verification are tested against fixture
  journals: a clean round-trip verifies; flipping one byte in an
  included payload, dropping a record, and truncating the tail each
  fail with a named reason; a withheld record's absence of payload does
  not fail verification.
- **FR-002.** The redaction policy is exported data (a reviewable
  constant), unit-tested field by field: no allowlisted kind's included
  fields contain an absolute path or a free-text tail in the fixture
  corpus.
- **FR-003.** A bundle produced from the self-hosted project's real
  journal verifies offline in a directory containing nothing but the
  bundle and the binary under test.

## 5. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/export.test.ts` passes.
- **AC-2.** `observatory orchestrator journal export --out /tmp/bundle`
  against the self-hosted project, then `journal verify --bundle
  /tmp/bundle`, reports the chains intact with the included/withheld
  counts printed, offline.

## 6. Out of scope

Publishing or uploading bundles anywhere, incremental or streaming
export, importing a bundle back into a journal, cross-project combined
bundles, spec-spine attest integration (a later spec wires sealing),
and any change to 011's chain format.

## 7. Resolved decisions

(none yet)
