---
name: commit
description: Create a git commit with an impact-focused conventional commit message.
allowed-tools: Bash
---

# Commit

Create a git commit following these steps.

## 1. Survey the changes

```
git status
git diff --cached
git diff
git log --oneline -5
```

Identify what is staged vs unstaged, the nature of each change (feature,
fix, refactor, docs, test, chore), and the user-visible impact. Match the
scoping conventions visible in recent history.

## 2. Gates green before committing

Never commit with the gates red. Run:

```
spec-spine compile && spec-spine index && \
  spec-spine lint --fail-on-warn && spec-spine index check
```

After spec 002 lands, code changes also need the chassis gates green:
`npm run typecheck && npm test`.

If any `specs/*/spec.md` or hashed input (manifests, `standards/**`,
workflows, `.claude/**`) changed, `compile`/`index` regenerate the
committed `.derived/` shards: stage them with the change that produced
them, never as a separate follow-up commit.

## 3. Draft a conventional-commit message

Format: `type(scope): subject`

**Type (required):** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
Use the spec id as the scope when the work belongs to a backlog spec, e.g.
`feat(004): ...` (the AGENTS.md convention); otherwise a clarifying area
scope, e.g. `docs(standards):`, `chore(claude):`.

**Subject line:**
- 72 characters maximum (hard limit; count them).
- Lead with the impact or problem solved, not the technique used.
- No trailing period. No emojis.

**Good vs bad:**
- BAD: `refactor: extract helper for diagnostic formatting`
- GOOD: `fix(005): factory no longer stalls on an empty template.toml`
- BAD: `feat: add new endpoint handler`
- GOOD: `feat(004): tenant creation keyed off installation_id`

**Body (optional):** separate from the subject with a blank line. Use
dash-prefixed bullets only for multiple distinct changes. Keep lines
under 72 characters. Explain how only when it is non-obvious; the subject
already covers what and why.

**Issue linking:** `Fixes #NNN` or `Closes #NNN` on its own line after
the body, when applicable.

## 4. Stage the relevant files

Use `git add` with specific paths. Do not use `git add -A` or `git add .`
unless every changed file belongs in this commit. Include the regenerated
`.derived/` shards when a hashed input changed. Never stage files that
look like secrets (`.env`, credentials, tokens, `keys/`).

## 5. Create the commit

Pass the message via heredoc:

```
git commit -m "$(cat <<'EOF'
type(scope): subject line here

Optional body with details.
EOF
)"
```

## 6. Verify

Run `git status` to confirm the commit succeeded and the tree is in the
expected state.

## Banned content

- No `Co-Authored-By` or any AI/Claude attribution line.
- No marketing taglines, links, or promotional text.
- No emojis anywhere in the message.
- No padding about what was not changed. Be direct and factual.

$ARGUMENTS
