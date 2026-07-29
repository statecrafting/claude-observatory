import { homedir } from "os";
import { join, resolve } from "path";

// The tree under observation. Read-only: nothing in this project may write here.
export const WATCH_ROOT = join(homedir(), ".claude");

// The primary runtime state file, a sibling of the watch root.
export const STATE_FILE = join(homedir(), ".claude.json");

// Everything we produce lives here, outside the watched tree.
export const PROJECT_DIR = resolve(import.meta.dir, "..");
export const DATA_DIR = join(PROJECT_DIR, "data");
export const DB_PATH = join(DATA_DIR, "observatory.db");
export const DAEMON_LOG = join(DATA_DIR, "daemon.log");
export const DAEMON_PID = join(DATA_DIR, "daemon.pid");

// Names we never report on: our own noise and editor litter.
export const IGNORED_BASENAMES = new Set([".DS_Store"]);
export const IGNORED_SUFFIXES = [".swp", ".swo", "~"];

export function assertLayout(): void {
  if (PROJECT_DIR.startsWith(WATCH_ROOT + "/") || PROJECT_DIR === WATCH_ROOT) {
    throw new Error(
      `refusing to run: project dir ${PROJECT_DIR} is inside watch root ${WATCH_ROOT}`
    );
  }
}

export function isIgnored(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (IGNORED_BASENAMES.has(base)) return true;
  return IGNORED_SUFFIXES.some((s) => base.endsWith(s));
}

// Display helper: ~/.claude-relative where possible.
export function rel(path: string): string {
  if (path === STATE_FILE) return "~/.claude.json";
  if (path.startsWith(WATCH_ROOT + "/")) return path.slice(WATCH_ROOT.length + 1);
  if (path === WATCH_ROOT) return ".";
  return path;
}
