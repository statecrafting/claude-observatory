---
id: "006-explain-and-redacted-peek"
title: "explain (FINDINGS join) and peek (redacted content viewing)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: high
depends_on:
  - "001-observed-universe"
  - "004-event-store"
origin:
  retroactive: true
summary: >
  The two knowledge commands. explain joins a path against FINDINGS.md
  research sections (backticked path-pattern headings with <placeholder>
  segments) plus the path's observed event history. peek is the single
  content-viewing path in the tool: read-only, size-capped, contained to the
  observed universe, and unconditionally redacted (secret-shaped JSON fields,
  env assignments, known token formats, long hex and base64 runs). There is
  no unredacted read path and no bypass flag, by design.
establishes:
  - "src/commands/explain.ts"
  - "src/redact.ts"
references:
  - { unit: { kind: file, path: "FINDINGS.md" }, role: context }
---

# 006: explain and redacted peek

## 1. Purpose

`explain` answers "what is this path and what has it done"; `peek` exists so
an analyst can inspect content without ever creating an unredacted disclosure
path through the tool. Risk is rated high because this is the only surface
that touches file content.

## 2. Territory

`src/commands/explain.ts` (both commands, FINDINGS section loader, path
normalization, containment guard) and `src/redact.ts` (the redaction
pipeline). `FINDINGS.md` is consumed as data but owned editorially by the
research process, not by this spec (non-owning reference; it sits on the
coupling bypass list).

## 3. Behavior

- **B-1 (explain matching).** FINDINGS sections are `##` headings that begin
  with a backticked path pattern; `<placeholder>` matches one path segment;
  a trailing `/` extends the match to the subtree. The longest matching
  pattern wins; a miss prints the honest line
  `no FINDINGS.md entry matches this path yet: that makes it interesting.`
  A missing FINDINGS.md degrades to history-only output.
- **B-2 (explain history).** Event history matches the path exactly or as a
  prefix (`path/%`), reporting count, first/last timestamps, total churn,
  and the last 10 events oldest-first.
- **B-3 (peek containment).** The resolved absolute target MUST be the state
  file, the watch root, or a descendant of the watch root; anything else
  refuses with `refusing: <path> is outside the observed universe` and exit
  1. Relative arguments resolve against the watch root, not cwd.
- **B-4 (peek read).** Read-only open; default cap 8192 bytes, hard ceiling
  65536; `--tail` reads the final window instead of the head; a single
  positioned read, then close. The header line reports total size, window,
  and the word `redacted`.
- **B-5 (redaction always on).** Output MUST pass through `redact()`. The
  pipeline, in order: secret-named JSON fields (token/key/secret/password/
  passwd/credential/auth, value >= 4 chars); uppercase env-style assignments
  of secret-named variables; known token shapes (Anthropic keys, GitHub
  tokens and PATs, JWTs, bearer tokens, AWS access key ids, Slack tokens);
  hex runs >= 32 chars (tagged with length); base64 runs >= 48 chars (tagged
  with length). Over-redaction is the accepted failure mode. There MUST be
  no flag or code path that bypasses redaction.

## 4. Out of scope

Writing anything (spec 001 B-7), streaming reads, structured (JSON) output,
and redaction of query outputs (labels and paths carry no content; path
privacy is handled by keeping `data/` untracked).

## 5. Known defects (recorded, not blessed)

- Target selection takes the first non-`--` argument, so a flag value can be
  swallowed as the target (`peek --bytes 100 foo` peeks `100`).
- The history query's LIKE has no ESCAPE clause, so `_` in a path acts as a
  wildcard.
- A missing target file surfaces as an uncaught stat error, and a
  non-numeric `--bytes` throws on Buffer.alloc(NaN).
- `~/` expansion uses `process.env.HOME` (spec 001 defect list).
- Dashed UUIDs survive the hex-run rule by design (word boundaries), which
  is wanted for session ids but means dashed secrets of that shape survive
  too; over-redaction stance accepts the reverse trade, not this one.
