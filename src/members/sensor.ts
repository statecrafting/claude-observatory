// statecraft-sensor-claude (spec 042 B-1): the sensor member's entrypoint.
// The verbs are specs 001-008's, reached through the spec 005 dispatcher.
import { runMember, SENSOR_MANIFEST } from "./manifest";

if (import.meta.main) await runMember(SENSOR_MANIFEST, process.argv.slice(2));
