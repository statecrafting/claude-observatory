import { openDb, insertEvent } from "../db";
import { formatEvent } from "../format";
import { Observatory } from "../watcher";
import { WATCH_ROOT, STATE_FILE } from "../paths";

export function cmdWatch(args: string[]): void {
  const raw = args.includes("--raw");
  const noDb = args.includes("--no-db");
  const quiet = args.includes("--quiet");
  const db = noDb ? null : openDb();

  const obs = new Observatory((ev) => {
    if (!quiet) console.log(formatEvent(ev, { raw }));
    if (db) insertEvent(db, ev);
  });

  const { tracked } = obs.start();
  console.log(
    `observatory: watching ${WATCH_ROOT} and ${STATE_FILE} (${tracked} entries tracked, db=${db ? "on" : "off"}, raw=${raw})`
  );

  const shutdown = () => {
    obs.stop();
    db?.close();
    console.log("observatory: stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
