#!/usr/bin/env bun
import { assertLayout } from "./paths";
import { cmdWatch } from "./commands/watch";
import { cmdLog, cmdStats } from "./commands/query";
import { cmdDiff, cmdSnapshot } from "./commands/snapshot";
import { cmdExplain, cmdPeek } from "./commands/explain";
import { cmdDaemon } from "./commands/daemon";
import { cmdOrchestrator } from "./commands/orchestrator";

const USAGE = `claude-observatory: filesystem observability for ~/.claude

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
`;

assertLayout();

const [cmd, ...args] = process.argv.slice(2);
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
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
