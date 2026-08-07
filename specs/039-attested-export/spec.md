---
id: "039-attested-export"
title: "Attested export: the bundle carries a corpus attestation"
status: approved
created: "2026-08-06"
authors: ["Bartek Kus"]
kind: feature
implementation: complete
risk: low
depends_on:
  - "031-journal-export"
summary: >
  The integration spec 031 deliberately deferred: at export time the
  bundle gains a spec-spine corpus attestation, so the evidence a
  skeptic verifies offline binds not only the journal chains but the
  exact corpus content the gate was adjudicating when the export was
  cut. The attestation is spec-spine's own reproducible document
  (attest --with-coupling), embedded verbatim with its hash; offline
  verification reports it as carried provenance with its internal hash
  recomputed, and never claims corpus verification it cannot perform
  without the repository. Ed25519 sealing stays out of scope: key
  custody is an operator decision no export path should default.
extends:
  # The bundle envelope grows the attestation block.
  - { spec: "031-journal-export", unit: "src/orchestrator/export.ts", nature: additive }
  # Its tests ride in 031's colocated surface.
  - { spec: "031-journal-export", unit: "src/orchestrator/export.test.ts", nature: additive }
  # journal export runs the attest and prints the hash.
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.ts", nature: additive }
  - { spec: "028-cli-projects", unit: "src/commands/orchestrator.test.ts", nature: additive }
references:
  - { unit: { kind: file, path: "docs/design/00-ecosystem-analysis.md" }, role: context }
---

# 039: Attested export

## 1. Purpose

The bundle proves the journals were not rewritten; it says nothing
about which corpus those journals were adjudicating. `spec-spine
attest` already emits a reproducible attestation of corpus content and
the coupling verdict; wiring it into export closes the loop the README
promises: done adjudicated by a gate over a corpus, both exportable.

## 2. Behavior

- **B-1 (attest at export).** `journal export` runs `spec-spine attest
  --with-coupling` against the exporting checkout and embeds the
  emitted attestation document verbatim in the bundle, beside its
  attestation hash. An attest that fails or is unavailable does not
  block the export: the bundle records the absence with the reason
  (the journals are still evidence without it).
- **B-2 (carried, not laundered).** Offline verification recomputes the
  attestation document's hash and reports the attestation as carried
  provenance: "attested corpus <hash>, document intact" or "no
  attestation carried (<reason>)". It never reports corpus
  verification, which would need the repository the skeptic does not
  have.
- **B-3 (surface).** The export report and `journal verify --bundle`
  output each gain one line for the attestation state. `--json`
  carries the block verbatim.

## 3. Functional requirements

- **FR-001.** Export tests cover: an attestation embedded with a
  matching hash; a failed attest recorded as absence with the reason;
  determinism (the bundle is byte-identical for identical inputs and
  attestation).
- **FR-002.** Verify tests cover: an intact carried attestation, a
  tampered attestation document (hash mismatch reported, chains still
  verified independently), and a bundle with none.

## 4. Acceptance criteria

- **AC-1.** `bun test src/orchestrator/export.test.ts` passes with the
  new cases.
- **AC-2.** `journal export` against this repo's own journals embeds a
  real attestation, and `journal verify --bundle` on the result reports
  it intact offline.

## 5. Out of scope

Ed25519 sealing (`attest --sign`: key custody is the operator's, a
later decision); re-running attest at verify time; attesting foreign
corpora (the export attests the checkout it runs in).

## 6. Resolved decisions

D-1. The attestation rides inside the existing single-file bundle
(031 D-1's shape) rather than as a sidecar: one artifact stays one
artifact, and a sidecar is exactly the detachable provenance B-2
refuses to launder.
