#!/usr/bin/env bun
import { cmdWatch } from "./commands/watch";
import { cmdLog, cmdStats } from "./commands/query";
import { cmdDiff, cmdSnapshot } from "./commands/snapshot";
import { cmdExplain, cmdPeek } from "./commands/explain";
import { cmdDaemon } from "./commands/daemon";
import { cmdOrchestrator } from "./commands/orchestrator";
import { cmdModels } from "./members/driver";
import { dispatch as dispatchTable, USAGE, type DispatchScope, type VerbTable } from "./members/dispatch";

export { USAGE };
export type { DispatchScope };

// Every verb, as `observatory` offers them. The member entrypoints under
// src/members/ build their own tables from the same functions (042 B-2), so
// a verb is one function under one dispatcher wherever it is reached.
export const SENSOR_VERBS: VerbTable = {
  watch: cmdWatch,
  log: cmdLog,
  stats: cmdStats,
  snapshot: cmdSnapshot,
  diff: cmdDiff,
  explain: cmdExplain,
  peek: cmdPeek,
  daemon: cmdDaemon,
};

export const ALL_VERBS: VerbTable = {
  ...SENSOR_VERBS,
  orchestrator: cmdOrchestrator,
  models: cmdModels,
};

export async function dispatch(argv: readonly string[], scope?: DispatchScope): Promise<void> {
  await dispatchTable(argv, ALL_VERBS, scope);
}

if (import.meta.main) await dispatch(process.argv.slice(2));
