import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { DATA_DIR, DB_PATH, rel } from "./paths";
import { walkUniverse } from "./walker";
import type { ObservedEvent } from "./watcher";

export function openDb(): Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      entry_kind TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      size_before INTEGER,
      size_after INTEGER,
      delta INTEGER,
      inode INTEGER,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_path ON events(path);
    CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      taken_at INTEGER NOT NULL,
      entry_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshot_entries (
      snapshot_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT,
      size INTEGER,
      mtime_ms INTEGER,
      mode INTEGER,
      inode INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snap_entries ON snapshot_entries(snapshot_id, path);
  `);
  return db;
}

export function insertEvent(db: Database, ev: ObservedEvent): void {
  db.query(
    `INSERT INTO events (ts, path, action, entry_kind, kind, label, size_before, size_after, delta, inode, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ev.ts,
    ev.relPath,
    ev.action,
    ev.entryKind,
    ev.kind,
    ev.label,
    ev.sizeBefore,
    ev.sizeAfter,
    ev.delta,
    ev.inode,
    ev.raw.length ? JSON.stringify(ev.raw) : null
  );
}

export function takeSnapshot(db: Database, label: string): { id: number; count: number } {
  const entries = walkUniverse();
  const takenAt = Date.now();
  const res = db
    .query(`INSERT INTO snapshots (label, taken_at, entry_count) VALUES (?, ?, ?)`)
    .run(label, takenAt, entries.length);
  const id = Number(res.lastInsertRowid);
  const ins = db.query(
    `INSERT INTO snapshot_entries (snapshot_id, path, kind, size, mtime_ms, mode, inode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: typeof entries) => {
    for (const e of rows) {
      ins.run(id, rel(e.path), e.kind, e.size, Math.round(e.mtimeMs), e.mode & 0o7777, e.inode);
    }
  });
  tx(entries);
  return { id, count: entries.length };
}

export function parseSince(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) throw new Error(`bad --since value: ${s} (use e.g. 30s, 15m, 2h, 1d)`);
  const mult: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return Date.now() - Number(m[1]) * mult[m[2]];
}

export function globToLike(glob: string): string {
  return glob.replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*+/g, "%").replace(/\?/g, "_");
}
