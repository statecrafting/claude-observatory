// Pure termination classifier for a `claude` session (spec 014 B-4). Takes
// only what the driver actually observed (exit code, the parsed result
// event if one arrived, the stderr tail, and whether the driver itself
// pulled the plug at a deadline) and returns one of a fixed set of outcome
// kinds, never a guess: absence of a signal is absence, not an inferred
// default.
//
// The rule table is exported data (statecraft's own pattern, see state.ts's
// transition tables) so the classification policy is unit-testable against
// fixtures independent of ever spawning a process.

export type TerminationKind =
  | "completed"
  | "auth"
  | "quota"
  | "hook-blocked"
  | "transient"
  | "timeout"
  | "killed"
  | "max-turns"
  | "crashed";

// The subset of a stream-json `result` event this module reads. session.ts
// owns the full event shape; this module only needs the fields that carry
// classification signal.
export interface ResultEventLike {
  readonly is_error?: boolean;
  readonly subtype?: string;
  readonly result?: string;
}

export interface ClassifyTerminationInput {
  readonly exitCode: number | null;
  readonly resultEvent: ResultEventLike | null;
  readonly stderrTail: string;
  // Set by the driver, never inferred here: true only when the driver
  // itself killed the child at its configured deadline (B-5).
  readonly timedOut?: boolean;
  // Set by the driver, never inferred here: true only when the daemon's
  // shutdown path severed the live child (spec 021 B-6, D-19).
  readonly shutdownKilled?: boolean;
}

export interface Classification {
  readonly kind: TerminationKind;
  // Epoch ms when a quota reset is expected, extracted from the text and
  // normalized; null when no reset hint was present (FR-002: never a
  // guess).
  readonly resetAtMs: number | null;
  readonly detail: string;
}

// --- rule table (B-4) ------------------------------------------------------

type RuleKind = Exclude<TerminationKind, "completed" | "timeout" | "crashed">;

export interface TerminationRule {
  readonly kind: RuleKind;
  readonly pattern: RegExp;
}

// Order is the priority: the first matching rule wins. auth is checked
// before quota so an expired OAuth token whose message also happens to
// mention rate limits still classifies as auth, not quota.
export const TERMINATION_RULES: readonly TerminationRule[] = [
  {
    kind: "auth",
    pattern:
      /authentication[_ ]error|permission[_ ]error|invalid[^a-z]*(x-)?api[^a-z]*key|unauthorized|forbidden|oauth.*(invalid|expired|revoked|missing)/i,
  },
  {
    kind: "quota",
    pattern: /usage limit|rate.?limit|limit reached|quota|too many requests|429/i,
  },
  {
    kind: "hook-blocked",
    pattern: /hook.*(blocked|denied|exit code 2)|PreToolUse.*blocked|\[pr-gate\] BLOCKED/i,
  },
  {
    kind: "transient",
    pattern: /overloaded|internal server error|5\d\d|network|ECONNRESET|ETIMEDOUT|timeout.*api/i,
  },
];

function resultText(resultEvent: ResultEventLike | null): string {
  if (!resultEvent) return "";
  return [resultEvent.subtype, resultEvent.result].filter((s): s is string => typeof s === "string").join("\n");
}

// --- reset-time extraction (FR-002) ----------------------------------------
//
// Checked in order of how unambiguous the hint is: an absolute ISO instant
// first, then a relative duration (both computable with no assumption about
// "today"), then a bare epoch number, then a bare clock time (the only
// pattern that has to assume a day, see D-2 below). The first pattern that
// matches wins; anything unmatched returns null rather than a guess.

const ISO_RESET_PATTERN =
  /resets?(?:\s+(?:at|on))?\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i;

const RELATIVE_RESET_PATTERN = /resets?\s+in\s+(\d+)\s*(hour|hr|minute|min)s?\b/i;

const EPOCH_RESET_PATTERN = /resets?(?:\s+at)?\s*[:=]?\s*(\d{10,13})\b/i;

const CLOCK_RESET_PATTERN = /resets?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i;

// nowMs is injectable so relative/clock extraction is deterministic under
// test; production callers rely on the default.
export function extractResetAtMs(text: string, nowMs: number = Date.now()): number | null {
  const iso = ISO_RESET_PATTERN.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[1]!);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const relative = RELATIVE_RESET_PATTERN.exec(text);
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unitMs = relative[2]!.toLowerCase().startsWith("h") ? 3_600_000 : 60_000;
    return nowMs + amount * unitMs;
  }

  const epoch = EPOCH_RESET_PATTERN.exec(text);
  if (epoch) {
    const digits = epoch[1]!;
    const value = Number.parseInt(digits, 10);
    // 10 digits is epoch seconds, 13 is epoch ms (the usual JS convention).
    return digits.length <= 10 ? value * 1000 : value;
  }

  const clock = CLOCK_RESET_PATTERN.exec(text);
  if (clock) {
    let hour = Number.parseInt(clock[1]!, 10);
    const minute = Number.parseInt(clock[2]!, 10);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    // No timezone is ever given with a bare clock time, so this reads it as
    // UTC on the current UTC day, rolling to the next day when that time has
    // already passed (D-2): the least-guessy reading of "resets at 3:00"
    // available without inventing a timezone.
    const reference = new Date(nowMs);
    const candidate = Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
      hour,
      minute,
      0,
      0
    );
    return candidate > nowMs ? candidate : candidate + 24 * 60 * 60 * 1000;
  }

  return null;
}

// --- classification (B-4) ---------------------------------------------------

// Order: completed, killed (driver flag), timeout (driver flag), max-turns
// (result subtype), auth, quota, hook-blocked, transient, crashed
// (fallback). completed and the two driver flags are checked ahead of the
// regex table: a result event that actually reports success wins even if
// the driver raced it with a kill, and a driver-confirmed kill or timeout
// with no result never gets second-guessed by stderr text. killed outranks
// timeout so a shutdown that lands after the deadline fired still records
// the operator's intent; max-turns outranks the regex table because the
// subtype is the CLI's own verdict, not prose to be pattern-matched.
export function classifyTermination(input: ClassifyTerminationInput): Classification {
  const { exitCode, resultEvent, stderrTail, timedOut, shutdownKilled } = input;

  if (resultEvent && !resultEvent.is_error) {
    return { kind: "completed", resetAtMs: null, detail: "result event reported is_error: false" };
  }

  if (shutdownKilled) {
    return {
      kind: "killed",
      resetAtMs: null,
      detail: "the daemon's shutdown path severed the live session child (021 B-6)",
    };
  }

  if (timedOut) {
    return {
      kind: "timeout",
      resetAtMs: null,
      detail: "driver killed the process after it exceeded its configured deadline",
    };
  }

  // D-8: the CLI names this outcome in the result event's own subtype, so it
  // is checked before the regex table: a max-turns result whose prose
  // happens to say "limit reached" must not read as quota and park the run.
  if (resultEvent?.subtype === "error_max_turns") {
    return {
      kind: "max-turns",
      resetAtMs: null,
      detail: "result event reported subtype error_max_turns (the session hit its turn cap)",
    };
  }

  const haystack = [resultText(resultEvent), stderrTail].filter((s) => s.length > 0).join("\n");

  for (const rule of TERMINATION_RULES) {
    const match = rule.pattern.exec(haystack);
    if (match) {
      const resetAtMs = rule.kind === "quota" ? extractResetAtMs(haystack) : null;
      return { kind: rule.kind, resetAtMs, detail: `matched ${rule.kind} pattern: "${match[0]}"` };
    }
  }

  const exitDetail =
    exitCode === null ? "the process ended with no recorded exit code" : `the process exited with code ${exitCode}`;
  return {
    kind: "crashed",
    resetAtMs: null,
    detail: `${exitDetail} and no result event or classifiable error text was seen`,
  };
}
