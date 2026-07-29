import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { PROJECT_DIR, STATE_FILE, WATCH_ROOT, rel } from "../paths";
import { openDb } from "../db";
import { fmtBytes } from "../format";
import { redact } from "../redact";

const FINDINGS = join(PROJECT_DIR, "FINDINGS.md");

interface Section {
  pattern: string;
  re: RegExp;
  body: string;
}

// FINDINGS.md sections start with a heading of the form:  ## `path/pattern`
// Placeholders like <slug> or <uuid> match one path segment.
function loadSections(): Section[] {
  if (!existsSync(FINDINGS)) return [];
  const text = readFileSync(FINDINGS, "utf8");
  const sections: Section[] = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = part.slice(0, nl).trim();
    const m = heading.match(/^`([^`]+)`/);
    if (!m) continue;
    const pattern = m[1];
    let reSrc = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/<[^>]+>/g, "[^/]+");
    // A pattern for a directory also matches everything beneath it.
    if (pattern.endsWith("/")) reSrc = reSrc + ".*";
    sections.push({ pattern, re: new RegExp(`^${reSrc}$`), body: part.slice(nl + 1).trim() });
  }
  return sections;
}

function normalize(input: string): string {
  if (input === "~/.claude.json" || input.startsWith("~/.claude.json.")) return input;
  if (input.startsWith("~/")) return rel(join(process.env.HOME ?? "", input.slice(2)));
  if (isAbsolute(input)) return rel(resolve(input));
  return input.replace(/\/+$/, (m) => m); // keep as tree-relative
}

export function cmdExplain(args: string[]): void {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: observatory explain <path>");
    process.exit(1);
  }
  const relPath = normalize(target);
  console.log(`path: ${relPath}\n`);

  const sections = loadSections();
  const matches = sections
    .filter((s) => s.re.test(relPath) || (s.pattern.endsWith("/") && (relPath + "/").startsWith(s.pattern.replace(/<[^>]+>/g, "?")) && s.re.test(relPath + "/x")))
    .sort((x, y) => y.pattern.length - x.pattern.length);
  const best = sections.filter((s) => s.re.test(relPath)).sort((x, y) => y.pattern.length - x.pattern.length)[0] ?? matches[0];
  if (best) {
    console.log(`FINDINGS.md: \`${best.pattern}\`\n`);
    console.log(best.body.split("\n### ")[0].trim());
  } else {
    console.log("no FINDINGS.md entry matches this path yet: that makes it interesting.");
  }

  const db = openDb();
  const stats = db
    .query(
      `SELECT COUNT(*) n, MIN(ts) lo, MAX(ts) hi, SUM(COALESCE(ABS(delta),0)) churn
       FROM events WHERE path = ? OR path LIKE ?`
    )
    .get(relPath, relPath + "/%") as { n: number; lo: number; hi: number; churn: number };
  console.log(`\nobserved history: ${stats.n} events`);
  if (stats.n) {
    console.log(
      `  first ${new Date(stats.lo).toLocaleString()}, last ${new Date(stats.hi).toLocaleString()}, churn ${fmtBytes(stats.churn)}`
    );
    const recent = db
      .query(
        `SELECT ts, action, label, delta FROM events WHERE path = ? OR path LIKE ? ORDER BY ts DESC LIMIT 10`
      )
      .all(relPath, relPath + "/%") as { ts: number; action: string; label: string; delta: number | null }[];
    console.log("  recent:");
    for (const r of recent.reverse()) {
      console.log(`    ${new Date(r.ts).toLocaleString()}  ${r.action.padEnd(9)} ${r.label}`);
    }
  }
}

// Opt-in, per-invocation content inspection. Everything goes through redact().
export function cmdPeek(args: string[]): void {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: observatory peek <path> [--bytes N] [--tail]");
    process.exit(1);
  }
  const abs = target === "~/.claude.json"
    ? STATE_FILE
    : isAbsolute(target)
      ? resolve(target)
      : join(WATCH_ROOT, target);
  if (!(abs === STATE_FILE || abs === WATCH_ROOT || abs.startsWith(WATCH_ROOT + "/"))) {
    console.error(`refusing: ${abs} is outside the observed universe`);
    process.exit(1);
  }
  const bytesIdx = args.indexOf("--bytes");
  const maxBytes = Math.min(bytesIdx >= 0 ? Number(args[bytesIdx + 1]) : 8192, 65536);
  const st = statSync(abs);
  const fd = openSync(abs, "r"); // read-only
  const start = args.includes("--tail") ? Math.max(0, st.size - maxBytes) : 0;
  const buf = Buffer.alloc(Math.min(maxBytes, st.size));
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  console.log(
    `# ${rel(abs)} (${fmtBytes(st.size)} total, showing ${buf.length} bytes from offset ${start}, redacted)`
  );
  console.log(redact(buf.toString("utf8")));
}
