import { openDb, takeSnapshot } from "../db";
import { fmtBytes } from "../format";

export function cmdSnapshot(args: string[]): void {
  const db = openDb();
  if (args.includes("--list")) {
    const rows = db
      .query(`SELECT id, label, taken_at, entry_count FROM snapshots ORDER BY id`)
      .all() as { id: number; label: string; taken_at: number; entry_count: number }[];
    for (const r of rows) {
      console.log(`  #${r.id}  ${new Date(r.taken_at).toLocaleString()}  ${r.entry_count} entries  ${r.label ?? ""}`);
    }
    return;
  }
  const labelIdx = args.indexOf("--label");
  const label = labelIdx >= 0 ? args[labelIdx + 1] : "manual";
  const { id, count } = takeSnapshot(db, label);
  console.log(`snapshot #${id} taken (${count} entries, label: ${label})`);
}

interface SnapEntry {
  path: string;
  kind: string;
  size: number;
  mtime_ms: number;
  mode: number;
  inode: number;
}

export function cmdDiff(args: string[]): void {
  const [a, b] = args.filter((x) => /^\d+$/.test(x)).map(Number);
  if (!a || !b) {
    console.error("usage: observatory diff <snapshotIdA> <snapshotIdB>  (see: snapshot --list)");
    process.exit(1);
  }
  const db = openDb();
  const load = (id: number) => {
    const rows = db
      .query(`SELECT path, kind, size, mtime_ms, mode, inode FROM snapshot_entries WHERE snapshot_id = ?`)
      .all(id) as SnapEntry[];
    if (!rows.length) {
      console.error(`snapshot #${id} is empty or missing`);
      process.exit(1);
    }
    return new Map(rows.map((r) => [r.path, r]));
  };
  const mapA = load(a);
  const mapB = load(b);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [p, eb] of mapB) {
    const ea = mapA.get(p);
    if (!ea) {
      added.push(`  + ${p} (${fmtBytes(eb.size)})`);
    } else if (ea.size !== eb.size || ea.inode !== eb.inode || ea.mtime_ms !== eb.mtime_ms) {
      const note =
        ea.size !== eb.size
          ? fmtBytes(eb.size - ea.size)
          : ea.inode !== eb.inode
            ? "replaced"
            : "touched";
      changed.push(`  ~ ${p} (${note})`);
    }
  }
  for (const p of mapA.keys()) if (!mapB.has(p)) removed.push(`  - ${p}`);

  const cap = (list: string[], title: string) => {
    console.log(`${title}: ${list.length}`);
    for (const line of list.slice(0, 200)) console.log(line);
    if (list.length > 200) console.log(`  ... ${list.length - 200} more`);
  };
  cap(added, "added");
  cap(removed, "removed");
  cap(changed, "changed");
}
