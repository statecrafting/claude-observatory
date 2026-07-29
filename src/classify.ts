// Semantic classification: map raw filesystem events on ~/.claude paths to
// human-meaningful events. An unmatched path is a discovery, not an error, and
// is surfaced loudly as UNCLASSIFIED.

export interface ClassInput {
  relPath: string; // path relative to ~/.claude, or "~/.claude.json[...]"
  action: "created" | "modified" | "replaced" | "deleted";
  entryKind: string; // file | dir | symlink | other
  delta: number | null; // size change in bytes, when known
}

export interface Classification {
  kind: string; // stable category for querying
  label: string; // human-readable one-liner
}

const short = (uuid: string) => uuid.slice(0, 8);

interface Rule {
  kind: string;
  re: RegExp;
  label: (m: RegExpMatchArray, c: ClassInput) => string;
}

function grewOrShrank(c: ClassInput): string {
  if (c.delta == null || c.delta === 0) return c.action;
  return c.delta > 0 ? "grew" : "SHRANK";
}

const RULES: Rule[] = [
  {
    kind: "transcript",
    re: /^projects\/([^/]+)\/([0-9a-f-]{36})\.jsonl$/,
    label: (m, c) => {
      if (c.action === "created") return `new transcript for session ${short(m[2])} in ${m[1]}`;
      if (c.action === "deleted") return `transcript deleted: session ${short(m[2])} in ${m[1]}`;
      return `transcript ${grewOrShrank(c)}: session ${short(m[2])} (${m[1]})`;
    },
  },
  {
    kind: "memory",
    re: /^projects\/([^/]+)\/memory(\/(.*))?$/,
    label: (m, c) => `memory ${m[3] ?? "dir"} ${c.action} (project ${m[1]})`,
  },
  {
    kind: "subagent-transcript",
    re: /^projects\/([^/]+)\/([0-9a-f-]{36})\/subagents\/agent-([0-9a-f]+)\.(jsonl|meta\.json)$/,
    label: (m, c) =>
      m[4] === "jsonl"
        ? `subagent transcript ${grewOrShrank(c)}: agent ${m[3].slice(0, 8)} (session ${short(m[2])})`
        : `subagent metadata ${c.action}: agent ${m[3].slice(0, 8)} (session ${short(m[2])})`,
  },
  {
    kind: "tool-result",
    re: /^projects\/([^/]+)\/([0-9a-f-]{36})\/tool-results\/(.+)$/,
    label: (m, c) => `large tool result ${c.action}: ${m[3]} (session ${short(m[2])})`,
  },
  {
    kind: "session-extras",
    re: /^projects\/([^/]+)\/([0-9a-f-]{36})(\/(.*))?$/,
    label: (m, c) => `session dir ${c.action}: ${m[4] ?? "(root)"} (session ${short(m[2])})`,
  },
  {
    kind: "project-dir",
    re: /^projects\/([^/]+)$/,
    label: (m, c) => `project dir ${c.action}: ${m[1]}`,
  },
  {
    kind: "file-history",
    re: /^file-history\/([0-9a-f-]{36})(\/(.*))?$/,
    label: (m, c) =>
      m[3]
        ? `pre-edit file snapshot ${c.action}: ${m[3]} (session ${short(m[1])})`
        : `file-history bucket ${c.action} for session ${short(m[1])}`,
  },
  {
    kind: "session-env",
    re: /^session-env\/([0-9a-f-]{36})(\/(.*))?$/,
    label: (m, c) =>
      m[3]
        ? `session-env file ${c.action}: ${m[3]} (session ${short(m[1])})`
        : `session-env dir ${c.action} (session ${short(m[1])})`,
  },
  {
    kind: "task",
    re: /^tasks\/([0-9a-f-]{36})(\/(.*))?$/,
    label: (m, c) =>
      m[3]
        ? `task state ${c.action}: ${m[3]} (task ${short(m[1])})`
        : `task dir ${c.action} (task ${short(m[1])})`,
  },
  {
    kind: "session-registry",
    re: /^sessions\/(\d+)\.json$/,
    label: (m, c) => `session registry entry ${m[1]} ${c.action}`,
  },
  {
    kind: "session-registry",
    re: /^sessions(\/(.*))?$/,
    label: (m, c) => `sessions/${m[2] ?? ""} ${c.action}`,
  },
  {
    kind: "paste",
    re: /^paste-cache\/([0-9a-f]{8,32})\.txt$/,
    label: (m, c) =>
      c.action === "created" ? `pasted content stored (${m[1]})` : `paste ${m[1]} ${c.action}`,
  },
  {
    kind: "shell-snapshot",
    re: /^shell-snapshots\/snapshot-([a-z]+)-(\d+)-([a-z0-9]+)\.sh$/,
    label: (m, c) => `shell snapshot (${m[1]}) ${c.action}`,
  },
  {
    kind: "prompt-history",
    re: /^history\.jsonl$/,
    label: (_m, c) => `global prompt history ${grewOrShrank(c)}`,
  },
  {
    kind: "state-backup",
    re: /^backups\/\.claude\.json\.backup\.(\d+)$/,
    label: (_m, c) =>
      c.action === "created" ? "state file backup rotated in" : `state backup ${c.action}`,
  },
  {
    kind: "state-backup",
    re: /^backups$/,
    label: (_m, c) => `backups dir ${c.action}`,
  },
  {
    kind: "state-file",
    re: /^~\/\.claude\.json(\..+)?$/,
    label: (m, c) =>
      m[1]
        ? `state file temp sibling ${c.action}: ~/.claude.json${m[1]}`
        : c.action === "replaced"
          ? "state file rewritten (atomic replace)"
          : `state file ${c.action} in place`,
  },
  {
    kind: "jobs",
    re: /^jobs\/pins\.json$/,
    label: (_m, c) => `jobs pins.json ${c.action}`,
  },
  {
    kind: "jobs",
    re: /^jobs(\/(.*))?$/,
    label: (m, c) => `jobs/${m[2] ?? ""} ${c.action}`,
  },
  {
    kind: "daemon",
    re: /^(daemon(\/.*)?|daemon-auth-status\.json|daemon-auth-cooldown)$/,
    label: (m, c) => `daemon state ${c.action}: ${m[1]}`,
  },
  {
    kind: "plugin",
    re: /^plugins\/(.*)$/,
    label: (m, c) => `plugin data ${c.action}: ${m[1]}`,
  },
  {
    kind: "plugin",
    re: /^plugins$/,
    label: (_m, c) => `plugins dir ${c.action}`,
  },
  {
    kind: "hook-file",
    re: /^hooks(\/(.*))?$/,
    label: (m, c) => `hook file ${c.action}: ${m[2] ?? "hooks/"}`,
  },
  {
    kind: "cache",
    re: /^(cache(\/.*)?|stats-cache\.json|gh-pr-status-cache\.json)$/,
    label: (m, c) => `cache ${c.action}: ${m[1]}`,
  },
  {
    kind: "config",
    re: /^(settings\.json|settings\.local\.json|keybindings\.json|CLAUDE\.md)$/,
    label: (m, c) => `USER CONFIG ${c.action}: ${m[1]}`,
  },
  {
    kind: "housekeeping",
    re: /^(\.last-cleanup|\.last-update-result\.json)$/,
    label: (m, c) => `housekeeping marker ${c.action}: ${m[1]}`,
  },
  {
    kind: "todos",
    re: /^todos(\/(.*))?$/,
    label: (m, c) => `todos ${c.action}: ${m[2] ?? "todos/"}`,
  },
  // Previously-empty dirs: activity here is a discovery target, shout it.
  {
    kind: "first-fill",
    re: /^(telemetry|downloads|agents|skills)(\/(.*))?$/,
    label: (m, c) =>
      m[3]
        ? `ACTIVITY IN PREVIOUSLY-EMPTY DIR ${m[1]}/: ${m[3]} ${c.action}`
        : `${m[1]}/ dir ${c.action}`,
  },
  {
    kind: "chrome",
    re: /^chrome(\/(.*))?$/,
    label: (m, c) => `chrome extension data ${c.action}: ${m[2] ?? "chrome/"}`,
  },
  {
    kind: "root",
    re: /^\.$/,
    label: (_m, c) => `~/.claude root dir ${c.action}`,
  },
];

export function classify(c: ClassInput): Classification {
  for (const rule of RULES) {
    const m = c.relPath.match(rule.re);
    if (m) return { kind: rule.kind, label: rule.label(m, c) };
  }
  return {
    kind: "unclassified",
    label: `UNCLASSIFIED: ${c.relPath} ${c.action} (${c.entryKind})`,
  };
}
