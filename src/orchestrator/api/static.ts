// Same-origin serving of the built web UI (spec 024 B-1). The daemon has
// exactly one interface (spec 022), so the SPA is answered by the same
// Bun.serve that answers `/api`: one origin, no CORS, no second port, and
// nothing for the page to fetch from anywhere else.
//
// This module is the entire server half of spec 024. It holds no state, reads
// only from the Vite build output directory, and never touches the journal:
// the UI's data arrives through the API routes like any other client's. The
// `/api` namespace is refused here before anything is resolved, so a built
// asset can never shadow a route and an unknown API path keeps answering in
// spec 022 B-2's envelope rather than being handed an HTML page.
import * as fs from "fs";
import { extname, join, resolve, sep } from "path";

// Vite's output directory (web/vite.config.ts writes here), resolved from
// this file rather than from the working directory: the daemon is started
// from wherever an operator happens to be standing, and the assets are a
// fixed part of the checkout.
export function defaultWebDistDir(): string {
  return resolve(import.meta.dir, "..", "..", "..", "web", "dist");
}

// Everything spec 022 serves lives under this prefix; nothing below may be
// resolved from disk.
const API_PATH_PREFIX = "/api";

const INDEX_FILE = "index.html";

// Vite emits content-hashed filenames into this subdirectory, so those are
// safe to cache forever. Everything else (index.html above all) must not be,
// or a rebuilt UI would keep serving the previous bundle.
const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticHandlerOptions {
  // Defaults to `defaultWebDistDir()`.
  readonly distDir?: string;
}

// Returns null when the request is not this module's to answer, which leaves
// the API router to produce its own envelope response.
export type StaticHandler = (request: Request, pathname: string) => Response | null;

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

// Resolves a URL path inside the build directory, or null when it escapes it.
// The containment check is on the resolved absolute path, so `..` segments,
// percent-encoded or not, cannot reach a file outside `distDir`.
function resolveAsset(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  const candidate = resolve(distDir, relative);
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) return null;
  return candidate;
}

function fileResponse(path: string, urlPath: string): Response {
  const bytes = fs.readFileSync(path);
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mediaType,
      "Cache-Control": urlPath.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE_CACHE : NO_STORE,
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// B-7's honesty rule applied to the server: a daemon whose UI was never built
// says so, in the response, with the command that fixes it. A blank page or a
// bare 404 would read as "the daemon is broken" when the API beside it is
// perfectly healthy.
function notBuilt(distDir: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>web ui not built</title></head>
<body style="font: 14px ui-monospace, monospace; padding: 2rem; line-height: 1.6">
<h1 style="font-size: 1rem">The web UI has not been built.</h1>
<p>Run <code>bun run web:build</code>, then reload.</p>
<p>Expected assets in <code>${escapeHtml(distDir)}</code>.</p>
<p>The API is unaffected: <code>/api/meta</code> still answers.</p>
</body>
</html>
`;
  return new Response(body, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

export function createStaticHandler(options: StaticHandlerOptions = {}): StaticHandler {
  const distDir = resolve(options.distDir ?? defaultWebDistDir());
  const indexPath = join(distDir, INDEX_FILE);

  return (request: Request, pathname: string): Response | null => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    if (pathname === API_PATH_PREFIX || pathname.startsWith(`${API_PATH_PREFIX}/`)) return null;

    const target = resolveAsset(distDir, pathname);
    if (target === null) return null;
    if (target !== distDir && isFile(target)) return fileResponse(target, pathname);

    // The SPA fallback (B-1: the UI is served at `/`). A path that names a
    // file extension asked for a specific asset and did not get one, so it is
    // a genuine miss; a path without one is a client-side route and gets the
    // shell. Handing index.html to a missing `/assets/x.js` would turn a bad
    // bundle reference into an inscrutable syntax error in the console.
    if (extname(pathname) !== "") return null;
    if (!isFile(indexPath)) return notBuilt(distDir);
    return fileResponse(indexPath, `/${INDEX_FILE}`);
  };
}
