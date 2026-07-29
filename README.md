# claude-observatory

Filesystem observability for `~/.claude`: a watcher daemon plus a CLI that
turns raw FSEvents into semantic, queryable activity, and `FINDINGS.md`, an
evidence-backed map of what every path in that tree is and when it changes.

The observed tree is treated as strictly read-only. Everything this project
produces (SQLite db, logs, baselines) lives here, under `data/`, which is
gitignored because it describes private activity.

## How it works

- `src/watcher.ts` keeps a state table (path, size, mtime, inode) for every
  entry under `~/.claude` plus `~/.claude.json`, watches recursively via
  FSEvents, debounces 200 ms per path, and diffs each event against the table
  to classify created / modified / replaced (inode change) / deleted with byte
  deltas. Directory events trigger a shallow reconcile to catch coalescing.
- `src/classify.ts` maps path patterns to semantic events (transcript grew,
  pre-edit snapshot saved, state backup rotated, ...). Unknown patterns are
  reported loudly as UNCLASSIFIED: those are discoveries.
- `src/db.ts` persists events and full-tree snapshots to `data/observatory.db`
  (bun:sqlite, WAL) so questions can be asked retrospectively.
- `src/redact.ts` guards the only content-viewing path (`peek`): key-like
  tokens, JWTs, secret-named fields, and long hex/base64 runs are masked.

## CLI

```
bun src/index.ts watch [--raw] [--no-db] [--quiet]
bun src/index.ts log [--since 1h] [--path <glob>] [--kind <k>] [--action <a>] [--limit N]
bun src/index.ts stats [--since 1h]
bun src/index.ts snapshot [--label <s>] [--list]
bun src/index.ts diff <a> <b>
bun src/index.ts explain <path>
bun src/index.ts peek <path> [--bytes N] [--tail]
bun src/index.ts daemon start|stop|status|plist
```

`explain` joins a path against the pattern-keyed sections of `FINDINGS.md` and
the observed event history in the db. `daemon plist` prints a launchd plist but
never installs it.

## Findings

See `FINDINGS.md` for the path-by-path map, with the observed evidence behind
each claim and open questions marked as such.
