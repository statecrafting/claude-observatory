#!/usr/bin/env bun
import { assertLayout } from "./paths";
import { cmdWatch } from "./commands/watch";
import { cmdLog, cmdStats } from "./commands/query";
import { cmdDiff, cmdSnapshot } from "./commands/snapshot";
import { cmdExplain, cmdPeek } from "./commands/explain";
import { cmdDaemon } from "./commands/daemon";
import { cmdOrchestrator } from "./commands/orchestrator";
import { cmdModels } from "./members/driver";

export const USAGE = `claude-observatory: filesystem observability for ~/.claude

usage: observatory <command> [options]

  watch [--raw] [--no-db] [--quiet]   live watch; semantic view, sqlite log
  log [--since 1h] [--path <glob>] [--kind <k>] [--action <a>] [--limit N] [--raw]
  stats [--since 1h]                  write frequency, hottest paths, churn
  snapshot [--label <s>] [--list]     record full tree state to the db
  diff <a> <b>                        compare two snapshots by id
  explain <path>                      FINDINGS.md entry plus observed history
  peek <path> [--bytes N] [--tail]    redacted content view (opt-in, read-only)
  daemon start|stop|status|plist      background watcher management
  orchestrator <command>              orchestrator control plane (status, dag, daemon, ...)
  models [--json]                     the session model each stage runs on (spec 040)
`;

// Spec 042 B-2: a member entrypoint hands the dispatcher the verb set it
// claims, and a verb outside that set is reported as unknown in the usual
// usage form with the member's own usage exit code. No scope means the
// `observatory` binary, which claims everything and keeps its exit 1.
export interface DispatchScope {
  readonly verbs: ReadonlySet<string>;
  readonly usageExit: number;
}

export async function dispatch(argv: readonly string[], scope?: DispatchScope): Promise<void> {
  assertLayout();
  const [cmd, ...args] = argv;
  if (scope !== undefined && cmd !== undefined && !scope.verbs.has(cmd)) {
    console.log(USAGE);
    process.exit(scope.usageExit);
  }
  switch (cmd) {
    case "watch":
      cmdWatch(args);
      break;
    case "log":
      cmdLog(args);
      break;
    case "stats":
      cmdStats(args);
      break;
    case "snapshot":
      cmdSnapshot(args);
      break;
    case "diff":
      cmdDiff(args);
      break;
    case "explain":
      cmdExplain(args);
      break;
    case "peek":
      cmdPeek(args);
      break;
    case "daemon":
      cmdDaemon(args);
      break;
    case "orchestrator":
      await cmdOrchestrator(args);
      break;
    case "models":
      cmdModels(args);
      break;
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) await dispatch(process.argv.slice(2));
