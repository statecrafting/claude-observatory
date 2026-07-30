// Rendering helpers with one rule (spec 024 B-7): a value the daemon did not
// serve is never formatted into something that looks served. Every function
// here takes null seriously and hands back a marker the UI renders as an
// explicit unknown rather than as a dash, a zero, or an empty string.
export const UNKNOWN = "unknown";

export function formatDuration(ms: number): string {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const parts = hours > 0 ? [`${hours}h`, `${String(minutes).padStart(2, "0")}m`, `${String(seconds).padStart(2, "0")}s`] : minutes > 0 ? [`${minutes}m`, `${String(seconds).padStart(2, "0")}s`] : [`${seconds}s`];
  return `${negative ? "-" : ""}${parts.join(" ")}`;
}

export function formatElapsed(sinceMs: number | null, nowMs: number): string {
  if (sinceMs === null) return UNKNOWN;
  return formatDuration(nowMs - sinceMs);
}

export function formatAgo(atMs: number | null, nowMs: number): string {
  if (atMs === null) return UNKNOWN;
  return `${formatDuration(nowMs - atMs)} ago`;
}

// ISO 8601 in, local wall-clock out. An unparseable string is returned as it
// arrived rather than silently becoming "Invalid Date".
export function formatTimestamp(iso: string | null): string {
  if (iso === null || iso.length === 0) return UNKNOWN;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

export function parseTimestamp(iso: string | null): number | null {
  if (iso === null || iso.length === 0) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

// Pins and content hashes are sha256 hex; the first 12 characters are enough
// to compare two of them by eye, and the full value stays in the title.
export function shortHash(hash: string | null): string {
  if (hash === null || hash.length === 0) return UNKNOWN;
  return hash.length <= 12 ? hash : hash.slice(0, 12);
}

export function formatCount(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// The quota countdown ticks against the daemon's clock, not the browser's:
// `skewMs` is the offset measured from /api/quota's own `nowMs`.
export function countdownMs(targetMs: number | null, clientNowMs: number, skewMs: number | null): number | null {
  if (targetMs === null) return null;
  return targetMs - (clientNowMs + (skewMs ?? 0));
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// A one-line rendering of an event payload for the live tail, where a
// multi-line JSON blob per record would bury the sequence itself.
export function summarizePayload(value: unknown, maxChars: number = 240): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= maxChars ? flattened : `${flattened.slice(0, maxChars)}…`;
}
