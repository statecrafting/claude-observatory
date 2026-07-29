# Contract: normative summary

- Specs live under the configured specs directory, one `NNN-slug/spec.md` each;
the directory name equals the frontmatter `id`.
- `spec-spine compile` emits the registry; `spec-spine index` emits the codebase
index; `spec-spine lint` checks corpus conformance; `spec-spine couple` is the
PR-time gate.
- A changed code path must be accompanied by an authoring edit to a spec that
owns it, or a `Spec-Drift-Waiver:` line in the PR body.
- Read derived artifacts only through `spec-spine` subcommands; never parse the
JSON ad hoc.
