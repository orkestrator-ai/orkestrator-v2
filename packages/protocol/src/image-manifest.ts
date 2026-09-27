/**
 * Container image manifest: what an image is and which container contracts it
 * implements.
 *
 * The image build generates `/usr/local/share/orkestrator/image-manifest.json`
 * from repository pins and probes each declared capability against the
 * scripts actually installed (`docker/image-manifest.ts`). The backend
 * reads it from a never-started container, caches it by immutable image id and
 * gates behavior on named capabilities rather than on a tag or version number.
 *
 * An image without a manifest is `legacy`: it keeps the guarded operations it
 * always had and never gains a capability through a default.
 */

export const IMAGE_MANIFEST_PATH = "/usr/local/share/orkestrator/image-manifest.json";
export const IMAGE_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_IMAGE_MANIFEST_BYTES = 64 * 1024;

/** Image label carrying the manifest schema version (informational). */
export const IMAGE_LABEL_MANIFEST_SCHEMA = "org.orkestrator.image.manifest-schema";
/** Image label with the compact `name=version,…` capability list (informational). */
export const IMAGE_LABEL_CAPABILITIES = "org.orkestrator.image.capabilities";

/**
 * Every capability a container contract can depend on, with the highest
 * version this code understands. An image declares the versions it
 * implements; a feature requires a minimum.
 */
export const IMAGE_CAPABILITIES = {
  /** `workspace-setup.sh --prepare-only` and its completion sentinel. */
  "workspace-prepare": 1,
  /** Per-boot status record with boot id and phases (step 04). */
  "boot-status": 1,
  /** Drain protocol for registered processes before stop (step 04). */
  "graceful-shutdown": 1,
  /** Workspace and provider state on owner-labelled named volumes (step 05). */
  "persistent-workspace": 1,
  /** Portable inputs staged by the backend instead of whole-home mounts (step 08). */
  "staged-inputs": 1,
  /** Per-environment network with explicit host service rules and IPv6 policy (step 09). */
  "network-policy": 2,
  /** Bridge diagnostic files rotated by a launch wrapper (step 11). */
  "bounded-logs": 1,
} as const;

export type ImageCapability = keyof typeof IMAGE_CAPABILITIES;

export function isImageCapability(value: unknown): value is ImageCapability {
  return typeof value === "string" && Object.hasOwn(IMAGE_CAPABILITIES, value);
}

/** Persistent-state formats an image can read and write, per storage role. */
export interface ImageStateFormatSupport {
  read: number[];
  write: number[];
}

export interface ImageManifest {
  schemaVersion: number;
  appVersion: string;
  sourceRevision: string | null;
  architecture: string;
  runtimes: Record<string, string>;
  agents: Record<string, string>;
  bridges: string[];
  capabilities: Partial<Record<ImageCapability, number>>;
  stateFormats: Record<string, ImageStateFormatSupport>;
}

export type ImageManifestParseResult =
  | { ok: true; manifest: ImageManifest }
  | { ok: false; reason: "oversized" | "malformed" | "unsupported-schema" };

const SAFE_VALUE = /^[A-Za-z0-9._+\-:@/]{1,128}$/;

function safeString(value: unknown): string | null {
  return typeof value === "string" && SAFE_VALUE.test(value) ? value : null;
}

function safeRecord(value: unknown, maxEntries = 32): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value).slice(0, maxEntries)) {
    const safeKey = safeString(key);
    const safeEntry = safeString(entry);
    if (safeKey && safeEntry) result[safeKey] = safeEntry;
  }
  return result;
}

function versionList(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is number => Number.isSafeInteger(entry) && entry > 0)
        .slice(0, 16)
    : [];
}

/**
 * Parses manifest text with fixed bounds. Unknown capabilities are dropped
 * (a newer image may declare contracts this backend does not use); a
 * capability version is kept as declared so requirement checks can compare.
 * No field may carry a host path or secret: values are restricted to a small
 * character set and length.
 */
export function parseImageManifest(text: string): ImageManifestParseResult {
  if (text.length > MAX_IMAGE_MANIFEST_BYTES) return { ok: false, reason: "oversized" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== IMAGE_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: typeof value.schemaVersion === "number" ? "unsupported-schema" : "malformed",
    };
  }
  const appVersion = safeString(value.appVersion);
  const architecture = safeString(value.architecture);
  if (!appVersion || !architecture) return { ok: false, reason: "malformed" };
  const capabilities: ImageManifest["capabilities"] = {};
  if (value.capabilities && typeof value.capabilities === "object") {
    for (const [name, version] of Object.entries(value.capabilities)) {
      if (isImageCapability(name) && Number.isSafeInteger(version) && (version as number) > 0) {
        capabilities[name] = version as number;
      }
    }
  }
  const stateFormats: ImageManifest["stateFormats"] = {};
  if (value.stateFormats && typeof value.stateFormats === "object") {
    for (const [role, support] of Object.entries(value.stateFormats).slice(0, 16)) {
      if (!safeString(role) || !support || typeof support !== "object") continue;
      const entry = support as Record<string, unknown>;
      stateFormats[role] = { read: versionList(entry.read), write: versionList(entry.write) };
    }
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: IMAGE_MANIFEST_SCHEMA_VERSION,
      appVersion,
      sourceRevision: safeString(value.sourceRevision),
      architecture,
      runtimes: safeRecord(value.runtimes),
      agents: safeRecord(value.agents),
      bridges: Array.isArray(value.bridges)
        ? value.bridges
            .flatMap((bridge) => (safeString(bridge) ? [bridge as string] : []))
            .slice(0, 16)
        : [],
      capabilities,
      stateFormats,
    },
  };
}

/** Capabilities that are missing or older than required. */
export function missingImageCapabilities(
  manifest: ImageManifest | null,
  required: Partial<Record<ImageCapability, number>>,
): ImageCapability[] {
  return (Object.entries(required) as [ImageCapability, number][])
    .filter(([name, version]) => (manifest?.capabilities[name] ?? 0) < version)
    .map(([name]) => name);
}

/** `name=version` pairs for the compact image label. */
export function formatCapabilityLabel(capabilities: ImageManifest["capabilities"]): string {
  return (Object.entries(capabilities) as [ImageCapability, number][])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}=${version}`)
    .join(",");
}

export type ImageCompatibilityState =
  /** The configured image is not present on the daemon. */
  | "missing"
  /** Manifest present and every capability this backend requires is declared. */
  | "compatible"
  /** No manifest: an image built before manifests existed. Guarded operations only. */
  | "legacy"
  /** Manifest present but missing required capabilities, or unreadable. */
  | "incompatible"
  /** Docker could not be asked. */
  | "unavailable";

/** Safe status for clients: no host paths, endpoints or raw daemon output. */
export interface ImageStatus {
  state: ImageCompatibilityState;
  imageRef: string;
  imageId: string | null;
  registryDigest: string | null;
  architecture: string | null;
  manifest: Pick<
    ImageManifest,
    "appVersion" | "sourceRevision" | "capabilities" | "agents" | "runtimes"
  > | null;
  missingCapabilities: ImageCapability[];
  /** Fixed remediation text. */
  remediation: string | null;
}

export type DockerTopologyKind =
  /** Engine on the backend host through a local socket. */
  | "local-engine"
  /** Docker Desktop's local integration (macOS, Windows or Linux). */
  | "desktop"
  /** A daemon on another host (tcp/ssh). Backend-local files and loopback ports do not reach it. */
  | "remote"
  /** The daemon answered but its endpoint could not be determined. Not assumed local or remote. */
  | "unknown"
  | "unavailable";

export interface DockerTopology {
  kind: DockerTopologyKind;
  rootless: boolean;
  osType: string | null;
  architecture: string | null;
  serverVersion: string | null;
  /** Whether operations needing backend-local bind mounts and loopback ports are supported. */
  supportsLocalResources: boolean;
  /** Fixed remediation text when unsupported. */
  remediation: string | null;
}
