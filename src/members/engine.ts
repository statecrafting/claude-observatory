// statecraft-engine (spec 042 B-1): the engine member's entrypoint. The
// engine stays internally Claude-aware until 043; here it only gains a name.
import { ENGINE_MANIFEST, runMember } from "./manifest";

if (import.meta.main) await runMember(ENGINE_MANIFEST, process.argv.slice(2));
