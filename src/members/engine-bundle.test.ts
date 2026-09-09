// Spec 043 FR-005: the compiled engine carries no Claude invocation string,
// and the compiled driver carries all of them, so a string that moves fails
// this test rather than letting it pass vacuously.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DRIVER_MANIFEST, ENGINE_MANIFEST, memberBinaryPath } from "./manifest";

const ROOT = join(import.meta.dir, "..", "..");

const PROVIDER_STRINGS = [
  "stream-json",
  "--dangerously-skip-permissions",
  "--permission-mode",
  "claude-opus",
  "claude-sonnet",
  "ANTHROPIC_API_KEY",
];

async function ensureBuilt(script: string, path: string): Promise<void> {
  if (existsSync(path)) return;
  const proc = Bun.spawn(["bun", "run", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
}

test("FR-005: the engine bundle names no provider; the driver bundle names every one", async () => {
  const engine = join(ROOT, memberBinaryPath(ENGINE_MANIFEST));
  const driver = join(ROOT, memberBinaryPath(DRIVER_MANIFEST));
  await ensureBuilt("build:member:engine", engine);
  await ensureBuilt("build:member:driver", driver);
  const engineBytes = readFileSync(engine).toString("latin1");
  const driverBytes = readFileSync(driver).toString("latin1");
  for (const needle of PROVIDER_STRINGS) {
    expect(engineBytes.includes(needle)).toBe(false);
    expect(driverBytes.includes(needle)).toBe(true);
  }
}, 120_000);
