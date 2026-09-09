// The member contract (spec 042): what a member is to the thing that calls it.
//
// A member is a binary built from this repository that answers one reserved
// flag, `--member-manifest`, with a machine-readable description of itself,
// and whose stdout the umbrella (statecraft-cli 008) can render without
// knowing which member produced it. This module holds the manifest type, the
// three declarations, the serializer, and the one entry each member binary
// runs. No verb moves between layers here; the entrypoints reuse the spec 005
// dispatcher (D-4) so a verb behaves identically through `observatory` and
// through its member binary.
import { dispatch, type DispatchScope } from "../index";
import pkg from "../../package.json";
import { EXIT_USAGE } from "../commands/orchestrator";

// B-3: `contract` is the id of this spec, so a member states which version of
// the member contract it implements rather than leaving the umbrella to infer
// it from a version number.
export const MEMBER_CONTRACT = "042";
export const MANIFEST_SCHEMA_VERSION = "1";

export type CapabilityTier = "reference" | "basic";

export interface MemberManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  // The dispatch key (B-3): the umbrella reaches a member as
  // `statecraft <name-suffix> ...`, never by one of its verbs.
  readonly name: string;
  readonly version: string;
  readonly contract: typeof MEMBER_CONTRACT;
  // The subverb set the member accepts under its own name. Two members may
  // both offer a `status`; the name is what keeps them apart.
  readonly verbs: readonly string[];
  readonly capabilityTier: CapabilityTier;
  // B-6: declared, never remapped. The umbrella reports a member's taxonomy
  // rather than guessing it, and returns the code verbatim.
  readonly exitCodes: Readonly<Record<string, string>>;
  readonly envelope: "ok-data";
}

// The dispatch layer's failures live at 64 and above (B-6, 008); no member
// may reach them, and FR-001 asserts the declarations stay below the line.
export const UMBRELLA_EXIT_FLOOR = 64;

// 023 D-4's taxonomy, carried verbatim by the engine and driver members (B-6).
const ENGINE_EXIT_CODES: Readonly<Record<string, string>> = {
  "0": "ok",
  "1": "operational",
  "2": "unreachable",
  "3": "usage",
};

// The sensor's dispatcher (005) has always answered an unknown verb with
// exit 1, the same code its verbs use for an operational failure. Declared
// as it is rather than as one would like it: the manifest exists so the
// umbrella reports the truth, and changing the code would change shipped
// behavior this spec promises not to touch.
const SENSOR_EXIT_CODES: Readonly<Record<string, string>> = {
  "0": "ok",
  "1": "operational or usage",
};

// B-1 fixes the binary names: they are the umbrella's discovery keys (008),
// so they are declared here and the build scripts follow them, not the
// other way round.
export const SENSOR_MANIFEST: MemberManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  name: "statecraft-sensor-claude",
  version: pkg.version,
  contract: MEMBER_CONTRACT,
  verbs: ["watch", "log", "stats", "snapshot", "diff", "explain", "peek", "daemon"],
  capabilityTier: "basic",
  exitCodes: SENSOR_EXIT_CODES,
  envelope: "ok-data",
};

// D-7: the engine keeps the `orchestrator` prefix it has today, so the
// umbrella path to an engine verb is `statecraft engine orchestrator status`.
export const ENGINE_MANIFEST: MemberManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  name: "statecraft-engine",
  version: pkg.version,
  contract: MEMBER_CONTRACT,
  verbs: ["orchestrator"],
  capabilityTier: "basic",
  exitCodes: ENGINE_EXIT_CODES,
  envelope: "ok-data",
};

// D-8: the driver's one verb. Nothing under `observatory` was driver-owned
// before this spec, and FR-001 requires a non-empty set, so the driver
// claims `models`, the read-only view of spec 040's per-stage model choice.
export const DRIVER_MANIFEST: MemberManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  name: "statecraft-driver-claude",
  version: pkg.version,
  contract: MEMBER_CONTRACT,
  verbs: ["models"],
  capabilityTier: "reference",
  exitCodes: ENGINE_EXIT_CODES,
  envelope: "ok-data",
};

export const MEMBER_MANIFESTS: readonly MemberManifest[] = [SENSOR_MANIFEST, ENGINE_MANIFEST, DRIVER_MANIFEST];

// B-1's output paths, keyed by the manifest name so a test can walk from a
// declaration to the binary that must answer for it.
export function memberBinaryPath(manifest: MemberManifest): string {
  return `dist/${manifest.name}`;
}

// One JSON object, one trailing newline (B-5). Key order is the declaration
// order above, which is stable across the three.
export function serializeManifest(manifest: MemberManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

export const MANIFEST_FLAG = "--member-manifest";

// The reserved flag wins wherever it appears on argv (D-1), before any other
// flag is interpreted, including ones the dispatcher would reject. It is the
// one thing a member answers that needs no layout check and no verb.
export function scopeOf(manifest: MemberManifest): DispatchScope {
  const usageExit = Object.entries(manifest.exitCodes).find(([, meaning]) => meaning.includes("usage"))?.[0];
  return {
    verbs: new Set(manifest.verbs),
    usageExit: usageExit === undefined ? EXIT_USAGE : Number(usageExit),
  };
}

export async function runMember(manifest: MemberManifest, argv: readonly string[]): Promise<void> {
  if (argv.includes(MANIFEST_FLAG)) {
    process.stdout.write(serializeManifest(manifest));
    process.exit(0);
  }
  await dispatch(argv, scopeOf(manifest));
}
