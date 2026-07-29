---
id: "007-watcher-daemon"
title: "Background watcher daemon (pidfile lifecycle, plist print-only)"
status: approved
created: "2026-07-29"
authors: ["Bartek Kus"]
kind: surface
implementation: complete
risk: medium
depends_on:
  - "001-observed-universe"
  - "005-cli-surface"
origin:
  retroactive: true
summary: >
  daemon start|stop|status|plist: a detached child process running the watch
  command with db persistence and NO_COLOR, both stdio streams appended to
  data/daemon.log, a plain-decimal pidfile at data/daemon.pid, single-SIGTERM
  stop, kill(pid, 0) liveness probing with stale-pidfile detection, and a
  launchd plist that is printed to stdout and never installed (installing a
  launch agent is the user's call).
establishes:
  - "src/commands/daemon.ts"
---

# 007: Watcher daemon

## 1. Purpose

Continuous observation without a foreground terminal. The daemon is the
minimum viable supervisor for the watcher; it is NOT the orchestrator daemon
(specs 010+), which has its own lifecycle, journal, and API.

## 2. Territory

`src/commands/daemon.ts`.

## 3. Behavior

- **B-1 (start).** Idempotent against a live pid (reports and exits 0).
  Otherwise spawns `bun src/index.ts watch` detached, stdio to the appended
  daemon log, env `NO_COLOR=1`, unrefs, and writes the child pid to the
  pidfile. The child therefore always persists to the db with full event
  output in the log.
- **B-2 (stop).** Sends exactly one SIGTERM (the watch command's handler
  closes cleanly, spec 005 B-2), removes the pidfile, and does not wait for
  or verify death. Exit code 0 whether or not a daemon was running.
- **B-3 (status).** Pure `kill(pid, 0)` probe with three honest outputs:
  running (with pid and log path), not running, and not running with a stale
  pidfile.
- **B-4 (plist).** Prints a launchd plist (RunAtLoad, KeepAlive, both stdio
  paths at the daemon log) plus an instruction line; it MUST NOT write or
  install anything. Under launchd there is no pidfile, so status/stop do not
  manage a launchd-run instance; that asymmetry is accepted and documented.

## 4. Out of scope

Restart-on-crash, health checks, log rotation, and multi-instance locking.

## 5. Known defects (recorded, not blessed)

- The pidfile is written even if the child dies instantly, and status trusts
  pid liveness without verifying process identity (pid reuse is undetected).
  The `~/.claude/sessions` registry pattern (procStart alongside pid) is the
  known fix, deferred to the orchestrator daemon specs.
- Nothing prevents a daemon and a foreground watch running concurrently;
  WAL makes it survivable but events double-record.
- Stop does not escalate to SIGKILL if SIGTERM is ignored.
