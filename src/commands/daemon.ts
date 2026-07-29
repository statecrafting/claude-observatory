import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { DAEMON_LOG, DAEMON_PID, DATA_DIR, PROJECT_DIR } from "../paths";

function readPid(): number | null {
  if (!existsSync(DAEMON_PID)) return null;
  const pid = Number(readFileSync(DAEMON_PID, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cmdDaemon(args: string[]): void {
  const sub = args[0];
  const pid = readPid();

  if (sub === "status") {
    if (pid && alive(pid)) console.log(`daemon running (pid ${pid}), log: ${DAEMON_LOG}`);
    else console.log(`daemon not running${pid ? " (stale pidfile)" : ""}`);
    return;
  }

  if (sub === "start") {
    if (pid && alive(pid)) {
      console.log(`daemon already running (pid ${pid})`);
      return;
    }
    mkdirSync(DATA_DIR, { recursive: true });
    const logFd = openSync(DAEMON_LOG, "a");
    const child = spawn(process.execPath, [join(PROJECT_DIR, "src/index.ts"), "watch"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.unref();
    writeFileSync(DAEMON_PID, String(child.pid));
    console.log(`daemon started (pid ${child.pid}), events to sqlite, log: ${DAEMON_LOG}`);
    return;
  }

  if (sub === "stop") {
    if (!pid || !alive(pid)) {
      console.log("daemon not running");
      if (existsSync(DAEMON_PID)) unlinkSync(DAEMON_PID);
      return;
    }
    process.kill(pid, "SIGTERM");
    unlinkSync(DAEMON_PID);
    console.log(`daemon stopped (pid ${pid})`);
    return;
  }

  if (sub === "plist") {
    // Printed, never installed: installing a launchd agent is the user's call.
    console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bartekus.claude-observatory</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(PROJECT_DIR, "src/index.ts")}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key><string>${DAEMON_LOG}</string>
</dict>
</plist>
(save to ~/Library/LaunchAgents/com.bartekus.claude-observatory.plist and run: launchctl load <path>)`);
    return;
  }

  console.error("usage: observatory daemon start|stop|status|plist");
  process.exit(1);
}
