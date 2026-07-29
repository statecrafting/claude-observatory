# Constitution (tier 2)

Durable principles, subordinate to the bootstrap spec (`000`) where they differ.

1. **Markdown-authored truth.** All authored truth lives in markdown with YAML
frontmatter. Derived JSON is compiler-owned and never hand-edited.
2. **Determinism.** Every artifact is a pure function of (config, file
contents). Same inputs ⇒ byte-identical output.
3. **Spec-first.** Code changes are accompanied by the spec that owns the code.
4. **Legacy-as-evidence.** Pre-graph authority is declared with
`origin.retroactive: true`, never as a fresh `establishes` claim.
