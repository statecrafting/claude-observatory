# Findings: how Claude Code stores and mutates state under ~/.claude

Observed 2026-07-28 on macOS (Darwin 25.5.0), Claude Code 2.1.220 (CLI) with a
2.1.219 build bundled inside Claude Desktop also active. Instrument:
`claude-observatory` (this repo), a state-diffing FSEvents watcher persisting
classified events to `data/observatory.db`. Times below are local. Every claim
is tagged by how it was established:

- **[observed]**: directly captured in the event log or verified on disk
- **[decoded]**: read from existing artifacts (transcript archaeology, schema
  inspection through the redacting `peek` command)
- **[inferred]**: consistent with observations but not directly witnessed
- **OPEN**: unknown; do not treat surrounding text as an answer

Section headings are path patterns; `observatory explain <path>` matches a path
against them and appends the live event history from the database.

---

## The session lifecycle (master timeline)

Cold start of a fresh headless session in a new directory, captured end to end
[observed], t=0 at process spawn:

| t | event |
|---|---|
| +0.67s | `session-env/<session-uuid>/` created (empty dir) |
| +0.72s | `sessions/<pid>.json` created (live-session registry entry) |
| +0.72s | `plugins/cache/<marketplace>/<plugin>/<ver>/.in_use/<pid>` lease files created |
| +0.85s | `~/.claude.json` atomically replaced (inode change) |
| +1.5s | `projects/<slug>/` created, then `<session-uuid>.jsonl` (first ~10 KB at once), then `memory/` dir |
| per message | transcript `.jsonl` appended, one burst per message/tool result |
| first Bash use | `shell-snapshots/snapshot-zsh-<epoch-ms>-<rand>.sh` created (+191 KB) |
| clean exit | `sessions/<pid>.json`, the shell snapshot, and all `.in_use/<pid>` leases **deleted** |

What survives a clean exit: the transcript, the project dir with `memory/`, the
empty `session-env/` dir, and any `~/.claude.json` changes. What a SIGKILL
leaves behind additionally [observed]: the `sessions/<pid>.json` entry and the
`.in_use/<pid>` leases are orphaned (and the shell snapshot, if one existed).

Resuming a session with `--resume` [observed]: appends to the *same* transcript
file, creates **no** new `session-env/` dir and no new transcript; it does
create a fresh `sessions/<pid>.json` for the new process and rewrites
`~/.claude.json` (with backup rotation, see `backups/`).

## The config/state boundary

`settings.json` is user-intent configuration: hooks, env, model, effort,
`cleanupPeriodDays` (30 here), enabled plugins. It changes only when the user
(or a settings-editing flow) changes it. `~/.claude.json` is machine-written
runtime state, rewritten constantly. Nothing observed ever rewrote
`settings.json`. [observed over the session; boundary confirmed by write
patterns]

---

## `~/.claude.json`

Primary runtime state file (~200 KB, mode 600, lives in `$HOME`, not in the
tree). Rewritten by atomic replace: every change shows as an inode change
[observed]. Rewrites observed at: session start, session resume, subagent
spawn, and at points mid-session with no obvious trigger; frequency during one
busy hour was roughly one rewrite per few minutes.

Schema [decoded, key names only]: 90 top-level keys. Three groups:

- **Caches**: `cachedGrowthBookFeatures`, `cachedExperimentData`,
  `modelAccessCache`, `orgModelDefaultCache`, `changelogLastFetched`, etc.
- **Lifetime counters and flags**: `numStartups`, `firstStartTime`,
  `tipsHistory`, `tipLifetimeShownCounts`, `promptQueueUseCount`, onboarding
  and upsell markers, migration flags (`opus45MigrationComplete`, ...).
- **`projects`**: a map of 60 absolute paths to per-project state:
  `hasTrustDialogAccepted`, `allowedTools`, `mcpServers`,
  `enabled/disabledMcpjsonServers`, and detailed last-session metrics
  (`lastCost`, `lastTotalInputTokens`, `lastSessionId`,
  `lastGracefulShutdown`, even `lastFpsAverage`). This is where "trust this
  folder" and per-project MCP config live.

Also `oauthAccount` and `userID` live here, which is why it is mode 600 and
why its backups are too.

## `backups/.claude.json.backup.<epoch-ms>`

Rotating copies of `~/.claude.json`, keep-5 [observed: every creation of a new
backup was paired with deletion of the oldest]. Created immediately *before*
some state-file rewrites: observed at session starts and once mid-session; not
on every rewrite. Exact trigger/min-interval: OPEN. Filename timestamp is the
rotation moment. Note the files are dotfiles; plain `ls` hides them.

## `settings.json`

User configuration (mode 600 because `env` can hold secrets). Contains hooks
(the em-dash and session-url guards live in `hooks/` and are wired here),
model/effort, `cleanupPeriodDays: 30`, plugin enablement. Never written by the
runtime during observation.

## `CLAUDE.md`

The user's global instructions, injected into every session's context. Static
during observation; changed only by the user (mtime Jul 2).

---

## `projects/<slug>/<session-uuid>.jsonl`

Per-session transcript, the highest-volume write path in the tree. Slug is the
session cwd with `/` replaced by `-` (confirmed; note this is lossy: `Dev/x`
and `Dev-x` would collide). Created at session start with an initial ~10 KB
burst, then appended once per message or tool result; observed append sizes
1-15 KB at sub-second to few-second intervals during active work [observed].

Not only messages [decoded]: record types include `last-prompt`,
`custom-title`, `agent-name`, `file-history-snapshot` (see `file-history/`),
and `summary` records. Transcripts contain full tool outputs and file
contents; they are the biggest privacy surface here (527 MB at baseline).

A transcript **shrinking** was never observed; compaction's on-disk footprint
is OPEN.

## `projects/<slug>/memory/`

Persistent memory store for the project. Created automatically, empty, the
moment the project dir is first created [observed at cold start]. The daily
cleanup deletes memory dirs that are still empty [observed: this project's own
empty memory dir was removed by the 13:15 cleanup]. So: provisioned eagerly,
reaped if unused.

## `projects/<slug>/<session-uuid>/subagents/agent-<hex17>.jsonl`

Subagent transcripts. Spawning an agent creates
`projects/<slug>/<parent-session-uuid>/` (a directory named after the parent
session, sibling of its `.jsonl`), then `subagents/agent-<17 hex>.jsonl`
(the subagent's own transcript, ~10 KB initial burst) plus
`agent-<17 hex>.meta.json` (~150 B) [observed, 5 s after spawning a probe
agent]. The subagent transcript is appended as the agent works. Spawning also
triggered a `~/.claude.json` rewrite [observed].

## `projects/<slug>/<session-uuid>/tool-results/`

Large tool outputs spilled out of the main transcript as individual `.txt`
files [decoded from cleanup-deleted paths; creation not directly observed:
no oversized tool result occurred during the observation window].

---

## `file-history/<session-uuid>/<pathhash16>@v<N>`

Pre-edit file backups powering rewind/checkpointing. The mechanism, decoded
from transcripts and confirmed by absence/presence experiments:

- Transcripts of **interactive** sessions contain `file-history-snapshot`
  records, one per user message, carrying a `trackedFileBackups` map:
  absolute-or-relative file path to `{backupFileName: "<16hex>@v<N>",
  version, backupTime}` [decoded].
- Backup files are written in a **burst at a user-message boundary**, backing
  up files the conversation edited in earlier turns: one session showed 25
  files tracked in a single snapshot record written 36 ms after a user
  message, matching the bucket's single mtime [decoded].
- **Headless (`claude -p`) sessions write neither snapshot records nor backup
  files**, even when they Write and Edit files, and even on resume [observed:
  lab session transcript has zero `file-history-snapshot` records; no bucket
  ever appeared].
- This session (interactive, one long autonomous turn) has checkpoint records
  from before its edits, all with empty `trackedFileBackups`, and no bucket
  yet. Prediction: a `file-history/<this-session>/` bucket appears when the
  user sends their next message. If that happens, this model is confirmed
  end to end.

On the starting map's question "Edit vs Write vs MultiEdit": the backup
mechanism is keyed by *file and checkpoint*, not by which editing tool made
the change; tracked sets observed include files edited by ordinary Edits.
Whether Write-created (vs pre-existing) files enter the tracked set is OPEN.

The `<16hex>` filename component is a hash of the file path [inferred from
stable name across `@v1..@v4` of the same path]; `@vN` increments per
checkpointed change. Cleanup deletes whole buckets with their session
[observed].

## `session-env/<session-uuid>/`

Created empty at every cold session start [observed], never populated: 0 files
across 232 accumulated dirs, and not cleaned on session exit, only by the
daily cleanup with the rest of the session's artifacts [observed]. Purpose:
OPEN (reserved for per-session env/scratch; nothing in this install's usage
ever wrote into one).

## `sessions/<pid>.json`

**Live-session registry, keyed by OS process id.** This resolves the starting
map's "numeric key unexplained": it is the PID [observed: this session's own
entry matches its pid and session uuid]. Content [decoded]: `pid`,
`sessionId`, `cwd`, `startedAt`, `procStart` (human-readable process start,
usable to detect PID reuse), `version`, `peerProtocol`, `kind`
("interactive"), `entrypoint` (`"cli"` or `"claude-desktop"`), derived
display `name` (e.g. `<dirname>-<2hex>`), `status` (`busy`/`idle`) with
`updatedAt`/`statusUpdatedAt`, and a bridge session identifier for remote
control.

Lifecycle: created ~0.7 s after spawn, deleted on clean exit [observed].
Entries whose process died uncleanly stay behind [observed via SIGKILL]; at
observation time 5 of 7 entries corresponded to *live* idle sessions, so the
registry is trustworthy while processes run. `status` flips are event-driven
(an idle session's file keeps its old mtime for days) [observed].

## `tasks/<session-uuid>/`

The structured task list (TaskCreate/TaskUpdate) for a session: `<n>.json`
per task plus a `.lock` file [observed: this session's own TaskCreate calls
created `tasks/<this-session>/1.json`..`4.json` within seconds; TaskUpdate
rewrote the corresponding file]. Note: background-shell and subagent *outputs*
do not live here; they go to the session's scratch area under
`/private/tmp/claude-<uid>/<slug>/<session-uuid>/tasks/` [observed].

## `paste-cache/<sha256-prefix16>.txt`

Content-addressed paste storage: filename is the first 16 hex chars of the
SHA-256 of the content [observed: recomputed hash matches exactly]. Written at
the moment of paste [observed: the mission prompt for this very session was
pasted at 13:08 and its cache file carries that mtime]. Referenced from
`history.jsonl` entries via `pastedContents: {n: {id, type, contentHash}}`
[decoded], and presumably from transcripts as well [inferred]. Files are mode
600. Retention policy: OPEN (202 files accumulated).

## `shell-snapshots/snapshot-<shell>-<epoch-ms>-<rand>.sh`

A dump of the user's shell environment (functions, aliases, options; ~191 KB
for this zsh setup), created when a session's Bash tool first initializes
[observed: appeared 5.4 s into a session, right before its first Bash result]
and **deleted on clean exit** [observed]. Snapshots present on disk therefore
belong to live or killed sessions. The filename epoch is the snapshot moment;
suffix is random. These can embed exported environment variables, hence the
starting map's secrets concern is justified.

## `history.jsonl`

Global prompt history (append-only, mode 600). One JSON line per
*interactively submitted* prompt: `{display, pastedContents, timestamp,
project, sessionId}` [decoded]. Slash commands appear verbatim (`"/model"`);
pastes appear as `[Pasted text #n +N lines]` with content in `paste-cache/`.
Headless `-p` prompts are **not** recorded [observed: nothing appended during
four lab runs].

---

## `jobs/`

Background-job supervisor state. `jobs/<8hex>/` is keyed by the first 8 chars
of the session uuid it supervises [decoded: a job's `linkScanPath` points at
the matching `projects/.../<full-uuid>.jsonl`]. Contains `state.json` (job
status: `state`, `tempo`, `needs`, `suggestedReply`, `output.result`,
`children` PR/issue links, `respawnFlags`, `template: "bg"`), optionally
`timeline.jsonl`, and `tmp/`. `jobs/pins.json` is `[]` here: pinned jobs
[decoded]. Nothing wrote to `jobs/` during observation (entries date May
30-Jun 10); which feature writes these is OPEN (consistent with a background
"babysitter" job runner).

## `daemon/`

IPC control plane for a background daemon: `control.key` (32 B, mode 600,
deliberately not read), `dispatch/` (empty, mode 700). Untouched during
observation. Top-level siblings `daemon-auth-status.json`
(`{"status":"auth_required","since":<epoch>}`, since Jun 13) and
`daemon-auth-cooldown` (a bare epoch-ms) [decoded]. The daemon appears
present-but-unauthenticated on this machine; what it does when healthy is
OPEN.

## `plugins/`

Plugin registry and cache: `installed_plugins.json`, `known_marketplaces.json`,
`blocklist.json`, `install-counts-cache.json`, `marketplaces/`, `data/`, and
`cache/<marketplace>/<plugin>/<version>/` holding plugin code. Live behavior
[observed]: every session start creates `.in_use/<pid>` lease files (~50 B)
inside each enabled plugin's cache dir, deleted on clean exit, orphaned on
kill. This is a per-PID refcount protecting the cache from being pruned while
in use [inferred from shape; content not examined beyond size].

## `hooks/`

User hook scripts (`no-em-dash.py`, `no-session-url.py`), executed by the
runtime, wired via `settings.json`. Key negative result [observed]: a hook
firing and *blocking* a Write leaves **no trace anywhere in the tree**; the
only artifact is the normal transcript append recording the failed tool call.
Hook execution state is not persisted.

## `cache/`

Assorted fetch caches: `changelog.md` (477 KB, the published changelog,
refreshed around updates; `changelogLastFetched` in the state file),
`my-closed-issues.json`. Siblings at top level: `stats-cache.json` (mode 600,
usage stats; stale since Jun 4) and `gh-pr-status-cache.json` (Jun 13).
Write cadence: OPEN (none changed during observation).

## `chrome/chrome-native-host`

A generated 173-byte shell wrapper that `exec`s the current versioned binary
(`~/.local/share/claude/versions/2.1.220 --chrome-native-host`) [decoded].
This is the Chrome native-messaging entry point for the Claude-in-Chrome
extension; regenerated on update (mtime matches update day). Note the actual
program lives *outside* the tree in `~/.local/share/claude/versions/`.

## `.last-cleanup`

A single ISO-8601 timestamp: the last run of the retention sweep. The sweep
ran at 13:15 during observation [observed] and, per the baseline-vs-after
diff, deleted: transcripts older than `cleanupPeriodDays` (30 here), each
dead session's `projects/<slug>/<uuid>/` extras dir (subagents,
tool-results), its `file-history/<uuid>/` bucket and `session-env/<uuid>/`
dir, empty `memory/` dirs, and the then-empty `telemetry/` dir. Cleanup is
keyed by session uuid across all four trees [observed: the same uuid vanished
from all of them in one sweep].

## `.last-update-result.json`

Auto-updater outcome: `{timestamp, path: "native", outcome, status,
version_from, version_to, error_code}` [decoded]: 2.1.219 to 2.1.220 on Jul
24. Binaries land in `~/.local/share/claude/versions/<version>`.

## `telemetry/`

Existed empty at baseline; **deleted by the 13:15 cleanup** [observed]; never
recreated during observation. What creates and fills it: OPEN.

## `downloads/`

Empty (mtime Mar 29). Never touched during observation. Filler: OPEN
(plausibly the auto-updater or file downloads; no evidence).

## `agents/`

Empty (mtime Feb 20). Reserved for user-defined agent definitions
(`.claude/agents/*.md` per product docs); this user has none. No writes
observed.

## `skills/`

Empty (mtime Feb 20). Reserved for user-defined skills; this user's skills
come from plugins instead. No writes observed.

---

## Corrections to the starting map

1. **`sessions/<n>.json`: n is the PID**, and the registry tracks *live*
   processes; most entries that looked stale were live idle sessions.
2. **`tasks/<uuid>/` is the session's structured task list**, not
   subagent/background-task state; uuid is the *session* id. Subagent state
   lives under `projects/<slug>/<session>/subagents/`; background-command
   output lives outside the tree in the session's `/private/tmp` scratch.
3. **`file-history` is not written per-edit.** It is written in bursts at
   user-message checkpoints, and never by headless sessions. "Pre-edit
   snapshot saved on every edit" would have been a confident wrong answer.
4. **`shell-snapshots` are per-session, deleted on clean exit**, not an
   accumulating log; survivors imply killed sessions or live ones.
5. **`paste-cache` names are SHA-256 prefixes** (verified), not arbitrary
   16-hex ids.
6. `projects/<slug>/` contains more than transcripts: per-session extras dirs
   (`subagents/`, `tool-results/`) and an auto-provisioned `memory/`.
7. `telemetry/` is not merely "empty, find what fills it": the cleanup
   actively deletes it when empty.
8. The starting map missed `chrome/` (native-messaging shim), top-level
   `CLAUDE.md`, and `cache/changelog.md`.

## Open questions

- What triggers the keep-5 backup rotation on some `~/.claude.json` rewrites
  but not others.
- What compaction and `/clear` do on disk (transcript shrink? summary
  records? new file?). Requires driving an interactive TUI session.
- What fills `telemetry/`, `downloads/`, and `session-env/<uuid>/`.
- Whether Write-created files join the file-history tracked set, and the
  hashing function behind `<pathhash16>` (path hash assumed, algorithm
  unverified).
- `paste-cache` retention (202 files, oldest untouched by cleanup).
- What writes `jobs/` (feature not exercised during observation) and what the
  `daemon/` control plane does when authenticated.
- `stats-cache.json` and `gh-pr-status-cache.json` refresh triggers.
- Whether the `file-history/<this-session>/` bucket appears at the user's
  next message (stated prediction; check `observatory log --kind
  file-history` after replying to this session).

## Evidence

The raw event log behind every [observed] claim is in `data/observatory.db`
(`events` table, 160+ classified events during the observation window), with
full-tree snapshots #1 (post-build), #2 (baseline import, 13:10) and #3
(pre-findings) in `snapshots`/`snapshot_entries`. `data/baseline-*.jsonl` is
the immutable Phase 1 baseline. Reproduce any timeline with
`observatory log --since ...` or SQL against the db.
