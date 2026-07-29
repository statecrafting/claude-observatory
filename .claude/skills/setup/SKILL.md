---
name: setup
description: One-time contributor setup. Install spec-spine and verify the governed loop (compile, index check, lint, couple) so /init can report lifecycle and structural counts.
allowed-tools: Bash, Read
---

# Setup

Get a fresh clone operational. After this completes, `/init` can report
lifecycle and structural counts through the `spec-spine` binary, never by
ad-hoc parsing of `.derived/**/*.json` (see
`.claude/rules/governed-artifact-reads.md`).

## Process

### 1. Install spec-spine

```bash
cargo install spec-spine-cli            # from crates.io (needs a Rust toolchain)
```

No Rust toolchain: use the prebuilt installer CI uses
(`.github/workflows/spec-spine.yml` pins the version; match it):

```bash
curl -fsSL https://raw.githubusercontent.com/statecrafting/spec-spine/main/install.sh | \
  SPEC_SPINE_VERSION=v0.10.0 SPEC_SPINE_BIN_DIR="$HOME/.local/bin" sh
```

Verify with `spec-spine --version`. Halt on a non-zero exit and surface the
failing step verbatim.

### 2. Compile a fresh registry

```bash
spec-spine compile
```

`.derived/` shards are committed in this repo, and `compile` is
deterministic: a no-op on a clean tree. Run it before any read so the
registry reflects the working tree, and commit the regenerated registry
whenever `specs/*/spec.md` changes.

### 3. Verify the governed loop

Smoke-test the gates `/init` and CI depend on. Passing here means the loop works
on this clone:

```bash
spec-spine index check       # codebase index staleness gate
spec-spine lint --fail-on-warn                     # corpus conformance
spec-spine couple --base origin/main --head HEAD   # PR-time coupling gate
```

If `index check` exits non-zero the committed index is stale against current
inputs. Run `spec-spine index`, re-commit the regenerated index, then re-check.
Do not parse `.derived/**/*.json` directly to "verify" success.

### 4. Post-002 prerequisites (application tooling)

The repo is pre-code until spec 002 (app shell) lands; the spine loop above
is the whole setup. Once spec 002 imports the EnRaHiTu chassis, contributor
setup additionally needs Node and the chassis install/build steps from that
spec's Acceptance section:

```bash
npm ci && npm --prefix frontend ci
npm run build:runtime && npm run build:app
npm run typecheck && npm test    # the chassis gates
```

### 5. Emit summary

Report exactly:

```
## setup: statecraft

**Install:** {ok / failed at <step>}
**Governed loop:**
  - compile: {fresh registry / failed}
  - index check: {fresh / stale}
  - lint: {clean / N diagnostics}
  - couple: {clean / drift surfaced}
**Lifecycle:** {N specs across <statuses>}  (from registry status-report)
**Chassis gates:** {green / not applicable (pre-002)}

Next: run `/init` to load full session context.
```

Do not invent counts. Only report values that came back from a `spec-spine`
subcommand.

## Rules

- The loop runs through the installed `spec-spine` binary on your `PATH`.
- Halt on first failure. Do not silently continue past a missing prerequisite
  or a failing gate.
- Never parse `.derived/**/*.json` directly in any verification step. Use the
  `spec-spine` subcommands.
- Idempotent: safe to re-run.
