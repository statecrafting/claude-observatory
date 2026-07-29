---
id: "NNN-slug"                 # must equal the directory name
title: ""
status: draft                  # draft | approved | superseded | retired
created: "YYYY-MM-DD"
summary: >
  One paragraph: what this spec governs and why.
# Ownership edges (declare the units this spec owns):
establishes:
  - "path/to/file.rs"                              # a file unit
  # - { kind: section, file: "Makefile", anchor: "build" }
  # - { kind: symbol, id: "my_crate::my_fn" }
  # - { kind: directory, path: "crates/my-crate/" }
  # - { kind: crate, id: "my-crate" }
  # - { kind: module, id: "my_crate::serialization" }
# depends_on:
#   - "000-bootstrap"
---

# NNN: Title

Link a compilation unit to this spec via `[package.metadata.spec-spine].spec`
in its manifest, a `// Spec:` header, or the edges above.

## 1. Purpose
## 2. Territory
## 3. Behavior
## 4. Out of scope
