import { openDb, parseSince, globToLike } from "../db";
import { fmtBytes, fmtTime } from "../format";

function opt(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

interface EventRow {
  id: number;
  ts: number;
  path: string;
  action: string;
  entry_kind: string;
  kind: string;
  label: string;
  size_before: number | null;
  size_after: number | null;
  delta: number | null;
  inode: number | null;
  raw: string | null;
}

function fmtRow(r: EventRow, showRaw: boolean): string {
  const d = new Date(r.ts);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const delta = r.delta != null && r.action !== "created" && r.action !== "deleted" ? fmtBytes(r.delta) : "";
  let line = `${day} ${fmtTime(r.ts)}  ${delta.padStart(8)}  ${r.kind.padEnd(16)}  ${r.label}  [${r.path}]`;
  if (showRaw && r.raw) line += `\n    raw: ${r.raw}`;
  return line;
}

export function cmdLog(args: string[]): void {
  const db = openDb();
  const conds: string[] = [];
  const params: (string | number)[] = [];
  const since = opt(args, "--since");
  if (since) {
    conds.push("ts >= ?");
    params.push(parseSince(since));
  }
  const pathGlob = opt(args, "--path");
  if (pathGlob) {
    conds.push("path LIKE ? ESCAPE '\\'");
    params.push(globToLike(pathGlob));
  }
  const kind = opt(args, "--kind");
  if (kind) {
    conds.push("kind = ?");
    params.push(kind);
  }
  const action = opt(args, "--action");
  if (action) {
    conds.push("action = ?");
    params.push(action);
  }
  const limit = Number(opt(args, "--limit") ?? 200);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...params, limit) as EventRow[];
  rows.reverse();
  const showRaw = args.includes("--raw");
  for (const r of rows) console.log(fmtRow(r, showRaw));
  console.log(`(${rows.length} events${rows.length === limit ? ", limit reached" : ""})`);
}

export function cmdStats(args: string[]): void {
  const db = openDb();
  const since = opt(args, "--since");
  const cutoff = since ? parseSince(since) : 0;

  const range = db
    .query(`SELECT COUNT(*) n, MIN(ts) lo, MAX(ts) hi FROM events WHERE ts >= ?`)
    .get(cutoff) as { n: number; lo: number | null; hi: number | null };
  if (!range.n) {
    console.log("no events recorded" + (since ? ` in the last ${since}` : ""));
    return;
  }
  console.log(
    `${range.n} events between ${new Date(range.lo!).toLocaleString()} and ${new Date(range.hi!).toLocaleString()}\n`
  );

  console.log("by kind:");
  const byKind = db
    .query(
      `SELECT kind, COUNT(*) n, SUM(COALESCE(ABS(delta),0)) churn FROM events WHERE ts >= ? GROUP BY kind ORDER BY n DESC`
    )
    .all(cutoff) as { kind: string; n: number; churn: number }[];
  for (const r of byKind) {
    console.log(`  ${r.kind.padEnd(18)} ${String(r.n).padStart(6)} events  ${fmtBytes(r.churn).padStart(10)} churn`);
  }

  console.log("\nhottest paths (by event count):");
  const hot = db
    .query(
      `SELECT path, COUNT(*) n, SUM(COALESCE(ABS(delta),0)) churn FROM events WHERE ts >= ? GROUP BY path ORDER BY n DESC LIMIT 15`
    )
    .all(cutoff) as { path: string; n: number; churn: number }[];
  for (const r of hot) {
    console.log(`  ${String(r.n).padStart(5)}x  ${fmtBytes(r.churn).padStart(10)}  ${r.path}`);
  }

  console.log("\nbiggest churn (by |bytes|):");
  const churny = db
    .query(
      `SELECT path, COUNT(*) n, SUM(COALESCE(ABS(delta),0)) churn FROM events WHERE ts >= ? GROUP BY path ORDER BY churn DESC LIMIT 10`
    )
    .all(cutoff) as { path: string; n: number; churn: number }[];
  for (const r of churny) {
    console.log(`  ${fmtBytes(r.churn).padStart(10)}  ${String(r.n).padStart(5)}x  ${r.path}`);
  }
}
