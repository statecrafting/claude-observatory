// statecraft-driver-claude (spec 042 B-1): the Claude driver member's
// entrypoint, and the one verb it claims (D-8).
//
// `models` renders spec 040's default session model pair and the tier each
// stage spawns under. Read-only, daemon-free, and owned by the driver because
// the model a driven session runs on is the driver's knowledge, not the
// engine's (doc 01 D13). Under `--json` it emits the family envelope (B-4).
import { DEFAULT_SESSION_MODELS, renderSessionModels, STAGE_MODEL_TIERS } from "../orchestrator/models";
import { DRIVER_MANIFEST, runMember } from "./manifest";

export function cmdModels(args: readonly string[]): void {
  const json = args.includes("--json");
  const stray = args.find((a) => a !== "--json");
  if (stray !== undefined) {
    console.error(`usage: observatory models [--json] (unexpected argument "${stray}")`);
    process.exit(3);
  }
  if (json) {
    const data = {
      strong: DEFAULT_SESSION_MODELS.strong,
      fast: DEFAULT_SESSION_MODELS.fast,
      stages: STAGE_MODEL_TIERS,
    };
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  console.log(`models:  ${renderSessionModels(undefined)}`);
  for (const [stage, tier] of Object.entries(STAGE_MODEL_TIERS)) {
    console.log(`  ${stage.padEnd(9)}${tier}`);
  }
}

if (import.meta.main) await runMember(DRIVER_MANIFEST, process.argv.slice(2));
