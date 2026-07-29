import { lstatSync, readdirSync } from "fs";
import { join } from "path";
import { STATE_FILE, WATCH_ROOT, isIgnored } from "./paths";

export interface Entry {
  path: string; // absolute
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  inode: number;
}

export function statEntry(path: string): Entry | null {
  try {
    const st = lstatSync(path);
    const kind = st.isDirectory()
      ? "dir"
      : st.isFile()
        ? "file"
        : st.isSymbolicLink()
          ? "symlink"
          : "other";
    return {
      path,
      kind,
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      inode: st.ino,
    };
  } catch {
    return null; // vanished between event and stat, or unreadable
  }
}

export function walkTree(root: string, includeIgnored = false): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable dir: record nothing below it
    }
    for (const name of names) {
      const p = join(dir, name);
      if (!includeIgnored && isIgnored(p)) continue;
      const e = statEntry(p);
      if (!e) continue;
      out.push(e);
      if (e.kind === "dir") walk(p);
    }
  };
  const rootEntry = statEntry(root);
  if (rootEntry) {
    out.push(rootEntry);
    if (rootEntry.kind === "dir") walk(root);
  }
  return out;
}

// The full observed universe: the tree plus the sibling state file.
export function walkUniverse(): Entry[] {
  const entries = walkTree(WATCH_ROOT);
  const state = statEntry(STATE_FILE);
  if (state) entries.push(state);
  return entries;
}
