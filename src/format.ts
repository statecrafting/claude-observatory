import type { ObservedEvent } from "./watcher";

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  invRed: "\x1b[41m\x1b[97m",
};

const KIND_COLOR: Record<string, string> = {
  transcript: C.cyan,
  memory: C.magenta,
  "file-history": C.blue,
  "session-env": C.green,
  task: C.green,
  "session-registry": C.yellow,
  paste: C.magenta,
  "shell-snapshot": C.blue,
  "prompt-history": C.cyan,
  "state-backup": C.yellow,
  "state-file": C.yellow,
  config: C.red,
  "first-fill": C.invRed,
  unclassified: C.invRed,
};

export function fmtBytes(n: number | null): string {
  if (n == null) return "";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}GB`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}MB`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}KB`;
  return `${sign}${abs}B`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function formatEvent(ev: ObservedEvent, opts: { raw?: boolean; color?: boolean } = {}): string {
  const color = opts.color ?? useColor();
  const paint = (s: string, code: string) => (color ? `${code}${s}${C.reset}` : s);
  const kindCol = KIND_COLOR[ev.kind] ?? "";
  const delta =
    ev.action === "modified" || ev.action === "replaced" ? fmtBytes(ev.delta) : "";
  const parts = [
    paint(fmtTime(ev.ts), C.dim),
    (delta || "").padStart(8),
    paint(ev.kind.padEnd(16), kindCol || C.dim),
    ev.label,
    paint(ev.relPath, C.dim),
  ];
  let line = parts.join("  ");
  if (opts.raw && ev.raw.length) {
    const rawDesc = ev.raw.map((r) => `${r.type}@${fmtTime(r.ts)}`).join(", ");
    line += "\n" + paint(`    raw: [${rawDesc}] action=${ev.action} inode=${ev.inode ?? "?"}`, C.dim);
  }
  return line;
}
