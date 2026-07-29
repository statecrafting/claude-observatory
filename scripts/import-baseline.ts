// Import a data/baseline-<ts>.jsonl file into the snapshots table so it can be
// diffed with `observatory diff`.
import { readFileSync } from "fs";
import { openDb } from "../src/db";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/import-baseline.ts data/baseline-<ts>.jsonl");
  process.exit(1);
}
const takenAt = Number(file.match(/baseline-(\d+)\.jsonl/)?.[1] ?? Date.now());
const lines = readFileSync(file, "utf8").trim().split("\n");
const db = openDb();
const res = db
  .query(`INSERT INTO snapshots (label, taken_at, entry_count) VALUES (?, ?, ?)`)
  .run("baseline", takenAt, lines.length);
const id = Number(res.lastInsertRowid);
const ins = db.query(
  `INSERT INTO snapshot_entries (snapshot_id, path, kind, size, mtime_ms, mode, inode)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const tx = db.transaction(() => {
  for (const line of lines) {
    const e = JSON.parse(line);
    ins.run(id, e.path, e.kind, e.size, e.mtimeMs, parseInt(e.mode, 8), e.inode);
  }
});
tx();
console.log(`imported ${lines.length} entries as snapshot #${id} (baseline, taken ${new Date(takenAt).toLocaleString()})`);
