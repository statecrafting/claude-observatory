// The watcher core. FSEvents (via recursive fs.watch) reports coalesced
// rename/change notifications with a path and nothing else, so we keep our own
// state table (size, mtime, inode per path) and diff against it on each event
// to produce created / modified / replaced / deleted with size deltas.
import { watch, readdirSync, type FSWatcher } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { WATCH_ROOT, isIgnored, rel } from "./paths";
import { statEntry, walkTree, walkUniverse, type Entry } from "./walker";
import { classify } from "./classify";

export interface RawNote {
  ts: number;
  type: string; // "rename" | "change" as reported by fs.watch
}

export interface ObservedEvent {
  ts: number;
  path: string; // absolute
  relPath: string;
  action: "created" | "modified" | "replaced" | "deleted";
  entryKind: string;
  sizeBefore: number | null;
  sizeAfter: number | null;
  delta: number | null;
  inode: number | null;
  kind: string; // semantic category
  label: string;
  raw: RawNote[];
}

export type EventSink = (ev: ObservedEvent) => void;

export interface WatcherOptions {
  debounceMs: number;
}

export class Observatory {
  private state = new Map<string, Entry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingRaw = new Map<string, RawNote[]>();
  private watchers: FSWatcher[] = [];

  constructor(
    private sink: EventSink,
    private opts: WatcherOptions = { debounceMs: 200 }
  ) {}

  start(): { tracked: number } {
    for (const e of walkUniverse()) this.state.set(e.path, e);

    const wRoot = watch(WATCH_ROOT, { recursive: true }, (type, filename) => {
      if (!filename) return this.schedule(WATCH_ROOT, type);
      const p = join(WATCH_ROOT, filename.toString());
      if (isIgnored(p)) return;
      this.schedule(p, type);
    });

    // ~/.claude.json lives in the home dir. Watch home non-recursively and
    // filter, so atomic rename-replace (write temp, rename over) is visible.
    const home = homedir();
    const wHome = watch(home, (type, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.startsWith(".claude.json")) return;
      this.schedule(join(home, name), type);
    });

    this.watchers.push(wRoot, wHome);
    return { tracked: this.state.size };
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private schedule(path: string, rawType: string): void {
    const notes = this.pendingRaw.get(path) ?? [];
    notes.push({ ts: Date.now(), type: rawType });
    this.pendingRaw.set(path, notes);
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    this.timers.set(
      path,
      setTimeout(() => this.flush(path), this.opts.debounceMs)
    );
  }

  private flush(path: string): void {
    this.timers.delete(path);
    const raw = this.pendingRaw.get(path) ?? [];
    this.pendingRaw.delete(path);
    const prev = this.state.get(path) ?? null;
    const cur = statEntry(path);
    this.emitDiff(path, prev, cur, raw);
    // Safety net for coalesced events: when the reported path is a directory,
    // reconcile its immediate children against the state table.
    if (cur?.kind === "dir") this.reconcileDir(path);
  }

  private emitDiff(path: string, prev: Entry | null, cur: Entry | null, raw: RawNote[]): void {
    if (!prev && !cur) return;

    if (prev && !cur) {
      // Deleted. If it was a dir, everything below it went too.
      const sub = this.forgetSubtree(path);
      for (const e of sub) this.emit(e.path, "deleted", e, null, []);
      this.emit(path, "deleted", prev, null, raw);
      return;
    }

    if (!prev && cur) {
      this.state.set(path, cur);
      this.emit(path, "created", null, cur, raw);
      if (cur.kind === "dir") this.adoptSubtree(path);
      return;
    }

    if (prev && cur) {
      const inodeChanged = prev.inode !== cur.inode;
      const sizeChanged = prev.size !== cur.size;
      const mtimeChanged = Math.round(prev.mtimeMs) !== Math.round(cur.mtimeMs);
      if (!inodeChanged && !sizeChanged && !mtimeChanged) return; // no visible change
      this.state.set(path, cur);
      this.emit(path, inodeChanged ? "replaced" : "modified", prev, cur, raw);
    }
  }

  private adoptSubtree(dir: string): void {
    for (const e of walkTree(dir)) {
      if (e.path === dir || this.state.has(e.path)) continue;
      this.state.set(e.path, e);
      this.emit(e.path, "created", null, e, []);
    }
  }

  private forgetSubtree(dir: string): Entry[] {
    const prefix = dir + "/";
    const removed: Entry[] = [];
    for (const key of [...this.state.keys()]) {
      if (key.startsWith(prefix)) {
        removed.push(this.state.get(key)!);
        this.state.delete(key);
      }
    }
    this.state.delete(dir);
    return removed;
  }

  private reconcileDir(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const present = new Set(
      names.map((n) => join(dir, n)).filter((p) => !isIgnored(p))
    );
    // Known children that vanished
    for (const key of [...this.state.keys()]) {
      if (dirname(key) === dir && !present.has(key) && !this.timers.has(key)) {
        this.emitDiff(key, this.state.get(key) ?? null, null, []);
      }
    }
    // New children we have not seen
    for (const p of present) {
      if (!this.state.has(p) && !this.timers.has(p)) {
        this.emitDiff(p, null, statEntry(p), []);
      }
    }
  }

  private emit(
    path: string,
    action: ObservedEvent["action"],
    prev: Entry | null,
    cur: Entry | null,
    raw: RawNote[]
  ): void {
    const relPath = rel(path);
    const sizeBefore = prev?.kind === "file" ? prev.size : prev ? 0 : null;
    const sizeAfter = cur?.kind === "file" ? cur.size : cur ? 0 : null;
    const delta =
      sizeBefore != null && sizeAfter != null
        ? sizeAfter - sizeBefore
        : action === "created"
          ? sizeAfter
          : action === "deleted"
            ? sizeBefore != null
              ? -sizeBefore
              : null
            : null;
    const entryKind = (cur ?? prev)?.kind ?? "other";
    const { kind, label } = classify({ relPath, action, entryKind, delta });
    this.sink({
      ts: Date.now(),
      path,
      relPath,
      action,
      entryKind,
      sizeBefore,
      sizeAfter,
      delta,
      inode: (cur ?? prev)?.inode ?? null,
      kind,
      label,
      raw,
    });
  }
}
