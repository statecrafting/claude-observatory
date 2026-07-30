// Static serving (spec 024 B-1), tested where it matters: that the SPA is
// reachable at `/`, that nothing under `/api` can ever be answered from disk,
// that no path can escape the build directory, and that a daemon whose UI was
// never built says so rather than serving a blank page.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStaticHandler, defaultWebDistDir } from "./static";
import { createApiServer, type ApiServer } from "./server";
import { freshWorld, seedRun, type FixtureWorld } from "./fixtures";
import { API_ROUTES } from "./types";

function get(path: string, distDir?: string): Response | null {
  const handler = createStaticHandler(distDir === undefined ? {} : { distDir });
  return handler(new Request(`http://127.0.0.1${path}`), new URL(`http://127.0.0.1${path}`).pathname);
}

let distDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), "web-dist-"));
  fs.mkdirSync(join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(join(distDir, "index.html"), "<!doctype html><title>shell</title>");
  fs.writeFileSync(join(distDir, "assets", "index-abc123.js"), "console.log(1)\n");
  fs.writeFileSync(join(distDir, "assets", "index-abc123.css"), ".a{}\n");
});

afterEach(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

test("the SPA is served at / and its hashed assets are served by name", async () => {
  const shell = get("/", distDir);
  expect(shell?.status).toBe(200);
  expect(shell?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await shell!.text()).toContain("<title>shell</title>");
  // index.html must never be cached, or a rebuilt UI keeps serving the old
  // bundle reference.
  expect(shell?.headers.get("Cache-Control")).toBe("no-store");

  const script = get("/assets/index-abc123.js", distDir);
  expect(script?.status).toBe(200);
  expect(script?.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  expect(script?.headers.get("Cache-Control")).toContain("immutable");

  const style = get("/assets/index-abc123.css", distDir);
  expect(style?.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
});

test("a client route falls back to the shell, a missing asset does not", async () => {
  const route = get("/dag", distDir);
  expect(route?.status).toBe(200);
  expect(await route!.text()).toContain("<title>shell</title>");

  // A path that named a file and did not get one is a genuine miss: handing
  // it the HTML shell would turn a bad bundle reference into a syntax error.
  expect(get("/assets/missing-deadbeef.js", distDir)).toBeNull();
});

test("nothing under /api is ever answered from disk", () => {
  fs.writeFileSync(join(distDir, "api"), "not a route");
  expect(get("/api", distDir)).toBeNull();
  expect(get("/api/meta", distDir)).toBeNull();
  expect(get("/api/evidence/" + "a".repeat(64), distDir)).toBeNull();
});

test("no path escapes the build directory", () => {
  const secret = join(distDir, "..", "outside.txt");
  fs.writeFileSync(secret, "secret");
  try {
    expect(get("/../outside.txt", distDir)).toBeNull();
    expect(get("/%2e%2e/outside.txt", distDir)).toBeNull();
    expect(get("/assets/../../outside.txt", distDir)).toBeNull();
  } finally {
    fs.rmSync(secret, { force: true });
  }
});

test("only GET and HEAD are this module's to answer", () => {
  const handler = createStaticHandler({ distDir });
  const post = handler(new Request("http://127.0.0.1/", { method: "POST" }), "/");
  expect(post).toBeNull();
});

test("an unbuilt UI says so, and names the command that fixes it", async () => {
  const empty = mkdtempSync(join(tmpdir(), "web-dist-empty-"));
  try {
    const response = get("/", empty);
    expect(response?.status).toBe(503);
    const body = await response!.text();
    expect(body).toContain("bun run web:build");
    expect(body).toContain(empty);
    // The API beside it is healthy, and the page says which route proves it.
    expect(body).toContain("/api/meta");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the default build directory is the checkout's own web/dist", () => {
  expect(defaultWebDistDir().endsWith(join("web", "dist"))).toBe(true);
});

// --- wired into the daemon's one server (B-1) -------------------------------

let world: FixtureWorld;
let server: ApiServer;

test("the same server answers the SPA and the API, and unknown API paths still get the envelope", async () => {
  world = freshWorld("static");
  seedRun(world);
  server = createApiServer({
    journal: { records: () => world.journal.fold().records },
    decisions: { records: () => world.decisions.fold().records },
    dagReader: world.dagReader,
    repoDir: world.repoDir,
    evidenceDir: world.evidenceDir,
    staticDir: distDir,
    port: 0,
  });

  try {
    const shell = await fetch(`${server.url}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("<title>shell</title>");

    const meta = await fetch(`${server.url}${API_ROUTES.meta}`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { ok: boolean }).ok).toBe(true);

    // Spec 022 B-2's envelope survives the static fallthrough.
    const missing = await fetch(`${server.url}/api/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: { kind: "not-found", message: "no route for GET /api/nope" } });
  } finally {
    await server.stop();
    world.close();
  }
});

test("a server built with staticDir: null serves no assets at all", async () => {
  const bare = freshWorld("static-off");
  const off = createApiServer({
    journal: { records: () => bare.journal.fold().records },
    decisions: { records: () => bare.decisions.fold().records },
    dagReader: bare.dagReader,
    repoDir: bare.repoDir,
    evidenceDir: bare.evidenceDir,
    staticDir: null,
    port: 0,
  });

  try {
    const root = await fetch(`${off.url}/`);
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ ok: false, error: { kind: "not-found", message: "no route for GET /" } });
  } finally {
    await off.stop();
    bare.close();
  }
});
