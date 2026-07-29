// Phase 1 baseline: one-shot metadata snapshot of ~/.claude plus ~/.claude.json.
// Paths, sizes, mtimes, modes, inodes. Never content.
import { mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR, assertLayout, rel } from "../src/paths";
import { walkUniverse } from "../src/walker";

assertLayout();
mkdirSync(DATA_DIR, { recursive: true });

const takenAt = Date.now();
const entries = walkUniverse();
const outPath = join(DATA_DIR, `baseline-${takenAt}.jsonl`);
const lines = entries.map((e) =>
  JSON.stringify({
    path: rel(e.path),
    kind: e.kind,
    size: e.size,
    mtimeMs: Math.round(e.mtimeMs),
    mode: (e.mode & 0o7777).toString(8),
    inode: e.inode,
  })
);
await Bun.write(outPath, lines.join("\n") + "\n");

const files = entries.filter((e) => e.kind === "file");
const totalBytes = files.reduce((a, e) => a + e.size, 0);
console.log(`baseline written: ${outPath}`);
console.log(
  `${entries.length} entries (${files.length} files, ${entries.length - files.length} dirs/other), ${(totalBytes / 1e6).toFixed(1)} MB total file bytes`
);
