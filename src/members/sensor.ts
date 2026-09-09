// statecraft-sensor-claude (spec 042 B-1): the sensor member's entrypoint.
// The verbs are specs 001-008's, reached through the spec 005 dispatcher.
import { cmdWatch } from "../commands/watch";
import { cmdLog, cmdStats } from "../commands/query";
import { cmdDiff, cmdSnapshot } from "../commands/snapshot";
import { cmdExplain, cmdPeek } from "../commands/explain";
import { cmdDaemon } from "../commands/daemon";
import { runMember, SENSOR_MANIFEST } from "./manifest";

if (import.meta.main) {
  await runMember(SENSOR_MANIFEST, process.argv.slice(2), {
    watch: cmdWatch,
    log: cmdLog,
    stats: cmdStats,
    snapshot: cmdSnapshot,
    diff: cmdDiff,
    explain: cmdExplain,
    peek: cmdPeek,
    daemon: cmdDaemon,
  });
}
