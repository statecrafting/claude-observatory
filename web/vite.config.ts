// The SPA's build (spec 024 FR-001). `bun run web:build` writes `web/dist`,
// which src/orchestrator/api/static.ts serves same-origin from the daemon.
//
// Two settings are load-bearing rather than taste. `base: "/"` makes the
// emitted asset URLs absolute, which is what the daemon serves them at.
// `assetsInlineLimit: 0` keeps every asset a real file rather than a data
// URL, so what the page loads is exactly what is on disk under `dist/assets`
// and nothing is smuggled into the HTML.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // Sourcemaps stay out of the shipped bundle: they would be the only
    // artifact here that quietly references paths outside the checkout.
    sourcemap: false,
  },
  // Development only, and still same-origin from the browser's point of view:
  // the dev server forwards `/api` (reads, controls, and the SSE stream) to a
  // loopback daemon, so the app never learns a second origin exists.
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4519", changeOrigin: false },
    },
  },
});
