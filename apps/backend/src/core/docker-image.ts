import {
  IMAGE_MANIFEST_PATH,
  MAX_IMAGE_MANIFEST_BYTES,
  missingImageCapabilities,
  parseImageManifest,
  type DockerTopology,
  type ImageCapability,
  type ImageManifest,
  type ImageStatus,
} from "@orkestrator/protocol/image-manifest";
import {
  DOCKER_IMAGE,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RESOURCE_ROLE,
  dockerOwnerNamespace,
  runCommand,
  spawnCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";

/**
 * Image identity, manifest and daemon topology.
 *
 * A tag is mutable, so an operation resolves it once at admission and every
 * later step uses the immutable image id. The manifest is read from a
 * never-started container — the image's entrypoint does not run to answer
 * "what is this image?" — and cached by image id.
 */

/** Capabilities every image must declare to be `compatible` for new work. */
export const BACKEND_REQUIRED_IMAGE_CAPABILITIES: Partial<Record<ImageCapability, number>> = {
  "workspace-prepare": 1,
};

export const MANIFEST_PROBE_ROLE = "manifest-probe";

export type ResolvedImage =
  | {
      kind: "present";
      imageRef: string;
      imageId: string;
      registryDigest: string | null;
      architecture: string | null;
    }
  | { kind: "missing"; imageRef: string }
  | { kind: "unavailable"; imageRef: string };

export function configuredImageRef(context: Pick<CommandContext, "dockerImage">): string {
  return context.dockerImage ?? DOCKER_IMAGE;
}

/** Resolves a tag (or id) to its immutable local image id and registry digest. */
export async function resolveDockerImage(imageRef: string): Promise<ResolvedImage> {
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "image",
        "inspect",
        "--format",
        "{{.Id}}\t{{json .RepoDigests}}\t{{.Architecture}}",
        imageRef,
      ],
      { timeoutMs: 15_000 },
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such (image|object)|not found/i.test(message)) return { kind: "missing", imageRef };
    return { kind: "unavailable", imageRef };
  }
  const [imageId = "", digestsJson = "[]", architecture = ""] = stdout.trim().split("\t");
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) return { kind: "unavailable", imageRef };
  let registryDigest: string | null = null;
  try {
    const digests = JSON.parse(digestsJson) as unknown;
    if (Array.isArray(digests)) {
      // Only a repository qualified by a registry host names a registry
      // digest. The containerd image store also reports `name@sha256:…` for a
      // purely local build, which identifies nothing a registry can serve.
      const fromRegistry = digests.find(
        (entry): entry is string =>
          typeof entry === "string" && /^(localhost|[^/@]*[.:][^/@]*)\//.test(entry),
      );
      const digest = fromRegistry?.split("@")[1];
      if (digest && /^sha256:[0-9a-f]{64}$/.test(digest)) registryDigest = digest;
    }
  } catch {
    registryDigest = null;
  }
  return {
    kind: "present",
    imageRef,
    imageId,
    registryDigest,
    architecture: architecture.trim() || null,
  };
}

export type ManifestRead =
  | { kind: "manifest"; manifest: ImageManifest }
  /** The image predates manifests. */
  | { kind: "legacy" }
  /** A manifest exists but is oversized, malformed, not a regular file, or a newer schema. */
  | { kind: "invalid"; reason: string }
  | { kind: "unavailable" };

const manifestCache = new Map<string, ManifestRead>();
const MANIFEST_CACHE_LIMIT = 32;

/** Test seam. */
export function resetImageManifestCache(): void {
  manifestCache.clear();
}

/**
 * Extracts the single regular file from a `docker cp … -` tar stream. The tar
 * header carries the type and size, so a symlink, directory or oversized entry
 * is refused without trusting anything but the bytes Docker produced.
 */
export function extractSingleTarFile(
  tar: Buffer,
  maxBytes: number,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (tar.length < 512) return { ok: false, reason: "truncated" };
  const header = tar.subarray(0, 512);
  const type = String.fromCharCode(header[156] ?? 0);
  if (type !== "0" && type !== "\0") return { ok: false, reason: "not-a-regular-file" };
  const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
  const size = Number.parseInt(sizeField, 8);
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: "malformed" };
  if (size > maxBytes) return { ok: false, reason: "oversized" };
  if (tar.length < 512 + size) return { ok: false, reason: "truncated" };
  return { ok: true, content: tar.subarray(512, 512 + size).toString("utf8") };
}

async function copyOutBounded(
  containerId: string,
  filePath: string,
  maxBytes: number,
): Promise<
  { kind: "bytes"; tar: Buffer } | { kind: "absent" } | { kind: "failed" } | { kind: "oversized" }
> {
  // A tar stream of one small file is its content plus headers and padding.
  const limit = maxBytes + 4 * 1024;
  return new Promise((resolve) => {
    const child = spawnCommand("docker", ["cp", `${containerId}:${filePath}`, "-"]);
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const finish = (value: Awaited<ReturnType<typeof copyOutBounded>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "failed" });
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        child.kill("SIGKILL");
        finish({ kind: "oversized" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    child.on("error", () => finish({ kind: "failed" }));
    child.on("close", (code) => {
      if (code === 0) finish({ kind: "bytes", tar: Buffer.concat(chunks) });
      else if (/could not find the file|no such file|not found/i.test(stderr)) {
        finish({ kind: "absent" });
      } else finish({ kind: "failed" });
    });
  });
}

/**
 * Reads the manifest of an immutable image id. Creates one owned, labelled,
 * network-less container that is never started, copies the manifest out with a
 * byte bound, and removes the container again (a failed removal leaves a
 * labelled probe that `cleanupStaleManifestProbes` reclaims).
 */
export async function readImageManifest(
  imageId: string,
  context: Pick<CommandContext, "storage">,
): Promise<ManifestRead> {
  const cached = manifestCache.get(imageId);
  if (cached) return cached;
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let probeId: string;
  try {
    ({ stdout: probeId } = await runCommand(
      "docker",
      [
        "create",
        "--label",
        `${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--label",
        `${DOCKER_LABEL_OWNER}=${owner}`,
        "--label",
        `${DOCKER_LABEL_RESOURCE_ROLE}=${MANIFEST_PROBE_ROLE}`,
        "--network",
        "none",
        imageId,
      ],
      { timeoutMs: 30_000 },
    ));
    probeId = probeId.trim();
  } catch {
    return { kind: "unavailable" };
  }
  let result: ManifestRead;
  try {
    const copied = await copyOutBounded(probeId, IMAGE_MANIFEST_PATH, MAX_IMAGE_MANIFEST_BYTES);
    if (copied.kind === "absent") {
      result = { kind: "legacy" };
    } else if (copied.kind === "failed") {
      result = { kind: "unavailable" };
    } else if (copied.kind === "oversized") {
      result = { kind: "invalid", reason: "oversized" };
    } else {
      const file = extractSingleTarFile(copied.tar, MAX_IMAGE_MANIFEST_BYTES);
      if (!file.ok) {
        result = { kind: "invalid", reason: file.reason };
      } else {
        const parsed = parseImageManifest(file.content);
        result = parsed.ok
          ? { kind: "manifest", manifest: parsed.manifest }
          : { kind: "invalid", reason: parsed.reason };
      }
    }
  } finally {
    await runCommand("docker", ["rm", "-f", probeId], { timeoutMs: 30_000 }).catch(() => undefined);
  }
  if (result.kind !== "unavailable") {
    if (manifestCache.size >= MANIFEST_CACHE_LIMIT) manifestCache.clear();
    manifestCache.set(imageId, result);
  }
  return result;
}

/** Removes probe containers left behind by an interrupted manifest read. */
export async function cleanupStaleManifestProbes(
  context: Pick<CommandContext, "storage">,
): Promise<number> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--filter",
        `label=${DOCKER_LABEL_OWNER}=${owner}`,
        "--filter",
        `label=${DOCKER_LABEL_RESOURCE_ROLE}=${MANIFEST_PROBE_ROLE}`,
        "--filter",
        "status=created",
        "--format",
        "{{.ID}}",
      ],
      { timeoutMs: 15_000 },
    ));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 64)) {
    await runCommand("docker", ["rm", id], { timeoutMs: 30_000 }).then(
      () => {
        removed += 1;
      },
      () => undefined,
    );
  }
  return removed;
}

const REMEDIATION = {
  missing:
    "The environment image is not installed. Build it with `mise run docker:build` or pull the release image.",
  legacy:
    "The environment image predates image manifests. Existing environments keep working; rebuild or pull a current image for new features.",
  incompatible:
    "The environment image does not provide the contracts this version of Orkestrator needs. Rebuild or pull a current image, then rebuild affected environments.",
  unavailable: "Docker could not be reached. Start Docker and retry.",
} as const;

export async function getImageStatus(
  context: Pick<CommandContext, "storage" | "dockerImage">,
  required: Partial<Record<ImageCapability, number>> = BACKEND_REQUIRED_IMAGE_CAPABILITIES,
): Promise<ImageStatus> {
  const imageRef = configuredImageRef(context);
  const resolved = await resolveDockerImage(imageRef);
  const base = {
    imageRef,
    imageId: null,
    registryDigest: null,
    architecture: null,
    manifest: null,
    missingCapabilities: [],
  };
  if (resolved.kind === "missing") {
    return { ...base, state: "missing", remediation: REMEDIATION.missing };
  }
  if (resolved.kind === "unavailable") {
    return { ...base, state: "unavailable", remediation: REMEDIATION.unavailable };
  }
  const identity = {
    imageRef,
    imageId: resolved.imageId,
    registryDigest: resolved.registryDigest,
    architecture: resolved.architecture,
  };
  const read = await readImageManifest(resolved.imageId, context);
  if (read.kind === "unavailable") {
    return {
      ...base,
      ...identity,
      state: "unavailable",
      remediation: REMEDIATION.unavailable,
    };
  }
  if (read.kind === "legacy") {
    return {
      ...base,
      ...identity,
      state: "legacy",
      missingCapabilities: missingImageCapabilities(null, required),
      remediation: REMEDIATION.legacy,
    };
  }
  if (read.kind === "invalid") {
    return { ...base, ...identity, state: "incompatible", remediation: REMEDIATION.incompatible };
  }
  const missing = missingImageCapabilities(read.manifest, required);
  const { appVersion, sourceRevision, capabilities, agents, runtimes } = read.manifest;
  return {
    ...identity,
    state: missing.length === 0 ? "compatible" : "incompatible",
    manifest: { appVersion, sourceRevision, capabilities, agents, runtimes },
    missingCapabilities: missing,
    remediation: missing.length === 0 ? null : REMEDIATION.incompatible,
  };
}

/**
 * Capabilities of the image a runtime was created from, or `null` for a legacy
 * image (no manifest) or one that cannot be read. Never assumes a capability.
 */
export async function imageCapabilities(
  imageId: string | undefined,
  context: Pick<CommandContext, "storage">,
): Promise<ImageManifest["capabilities"] | null> {
  if (!imageId) return null;
  const read = await readImageManifest(imageId, context);
  return read.kind === "manifest" ? read.manifest.capabilities : null;
}

/** Persistent-state formats the image declares it reads and writes, or null. */
export async function imageStateFormats(
  imageId: string | undefined,
  context: Pick<CommandContext, "storage">,
): Promise<ImageManifest["stateFormats"] | null> {
  if (!imageId) return null;
  const read = await readImageManifest(imageId, context);
  return read.kind === "manifest" ? read.manifest.stateFormats : null;
}

/** Storage roles of `volume-v1` and the format version the backend writes. */
export const VOLUME_STORAGE_FORMAT = {
  version: 1,
  roles: ["workspace", "provider-state"],
} as const;

/**
 * Whether an image may be given `volume-v1` storage read-write: it must
 * declare that it writes the current version for every role. An older image
 * never gets newer state mounted into it; the environment stays on the image
 * that wrote it, or a newer one.
 */
export function imageWritesVolumeStorage(formats: ImageManifest["stateFormats"] | null): boolean {
  return VOLUME_STORAGE_FORMAT.roles.every(
    (role) => formats?.[role]?.write.includes(VOLUME_STORAGE_FORMAT.version) ?? false,
  );
}

// ---------------------------------------------------------------------------
// Daemon topology
// ---------------------------------------------------------------------------

let topologyCache: { value: DockerTopology; at: number } | null = null;
const TOPOLOGY_CACHE_MS = 60_000;

/** Test seam. */
export function resetDockerTopologyCache(): void {
  topologyCache = null;
}

function isLoopbackHost(host: string): boolean {
  return /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(host);
}

/**
 * Classifies an endpoint without retaining it: the raw endpoint can carry
 * usernames or hostnames and is never persisted or emitted.
 */
export function classifyDockerEndpoint(
  endpoint: string,
  operatingSystem: string,
): DockerTopology["kind"] {
  const desktop = /docker desktop/i.test(operatingSystem);
  if (/^(unix|npipe):\/\//i.test(endpoint)) return desktop ? "desktop" : "local-engine";
  const tcp = /^tcp:\/\/([^/:]+|\[[^\]]+\])(?::\d+)?/i.exec(endpoint);
  if (tcp && isLoopbackHost(tcp[1] ?? "")) return desktop ? "desktop" : "local-engine";
  return "remote";
}

const TOPOLOGY_REMEDIATION =
  "Orkestrator's backend must run beside its Docker daemon. Run the standalone backend on the Docker host and connect through the remote gateway.";

/**
 * Detects the effective Docker endpoint and daemon. The endpoint comes from
 * the current context (which reflects DOCKER_HOST and DOCKER_CONTEXT), so an
 * unset DOCKER_HOST is never taken to mean a local daemon.
 */
export async function detectDockerTopology(
  options: { refresh?: boolean } = {},
): Promise<DockerTopology> {
  if (!options.refresh && topologyCache && Date.now() - topologyCache.at < TOPOLOGY_CACHE_MS) {
    return topologyCache.value;
  }
  const unavailable: DockerTopology = {
    kind: "unavailable",
    rootless: false,
    osType: null,
    architecture: null,
    serverVersion: null,
    supportsLocalResources: false,
    remediation: "Docker could not be reached. Start Docker and retry.",
  };
  let endpoint = "";
  try {
    const { stdout } = await runCommand(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { timeoutMs: 10_000 },
    );
    endpoint = stdout.trim().split("\n")[0] ?? "";
  } catch {
    endpoint = "";
  }
  let info: Record<string, unknown>;
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "info",
        "--format",
        '{"OSType":{{json .OSType}},"OperatingSystem":{{json .OperatingSystem}},"Architecture":{{json .Architecture}},"ServerVersion":{{json .ServerVersion}},"SecurityOptions":{{json .SecurityOptions}}}',
      ],
      { timeoutMs: 10_000 },
    );
    info = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    topologyCache = { value: unavailable, at: Date.now() };
    return unavailable;
  }
  const text = (key: string) => (typeof info[key] === "string" ? (info[key] as string) : null);
  const operatingSystem = text("OperatingSystem") ?? "";
  // A context that cannot be inspected is evidence of neither a local nor a
  // remote daemon; only a positively remote endpoint is refused.
  const kind = endpoint ? classifyDockerEndpoint(endpoint, operatingSystem) : "unknown";
  const securityOptions = Array.isArray(info.SecurityOptions)
    ? (info.SecurityOptions as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const value: DockerTopology = {
    kind,
    rootless: securityOptions.some((entry) => /name=rootless/.test(entry)),
    osType: text("OSType"),
    architecture: text("Architecture"),
    serverVersion: text("ServerVersion")?.slice(0, 64) ?? null,
    supportsLocalResources: kind !== "remote",
    remediation: kind === "remote" ? TOPOLOGY_REMEDIATION : null,
  };
  topologyCache = { value, at: Date.now() };
  return value;
}
