/**
 * Package registries (docs/architecture/agent-capabilities-management.md,
 * "Updates and rollback", "Package registries").
 *
 * A registry is an administrator-configured HTTPS index (see
 * `@orkestrator/protocol/capability-registry`). Resolving a registry package:
 *
 * 1. fetch the index with bounded size and time, https only on every
 *    redirect hop, and check its signature when the registry pins a key;
 * 2. pick the requested (or latest) version;
 * 3. fetch its immutable content: a Git commit through the same safe Git
 *    path every Git source uses, or an HTTPS tarball whose SHA-256 is checked
 *    before a byte of it is unpacked, and whose entries are refused when they
 *    are links, devices, absolute or escaping paths;
 * 4. inspect the tree like any other source.
 *
 * `forbiddenSources` applies before anything is fetched: to the registry
 * (`registry:<id>/`), to the package, and to the Git repository a version
 * points at.
 */
import { promises as fs } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  CAPABILITY_REGISTRY_LIMITS,
  capabilityRegistrySigningPayload,
  isCapabilityRegistryForbidden,
  isCapabilityRegistryUrl,
  isCapabilitySourceForbidden,
  validateCapabilityRegistryIndex,
  type CapabilityRegistry,
  type CapabilityRegistryIndex,
  type CapabilityRegistryPackage,
  type CapabilityRegistryVersion,
} from "@orkestrator/protocol/capability-registry";
import {
  CAPABILITY_LIMITS,
  capabilityPackageId,
  type CapabilityPackage,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import { graphSharingKeyId } from "@orkestrator/protocol/graphs/sharing";

import { verifyGraphBundleSignature } from "../graph-template-signing.js";
import {
  CapabilityError,
  readPackageTree,
  sha256Hex,
  validatePackageFiles,
  type PackageFile,
} from "./security.js";
import {
  fetchGitSource,
  inspectFiles,
  type GitFetchOptions,
  type InspectedPackage,
} from "./source-inspection.js";

export type RegistryFetch = (
  input: string,
  init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface RegistryContext {
  registries: readonly CapabilityRegistry[];
  forbiddenSources: readonly string[];
  workRoot: string;
  fetch?: RegistryFetch;
  gitRun?: GitFetchOptions["run"];
  /** One fetch of each index per pass (an update check asks twice per package). */
  indexCache?: Map<string, Promise<CapabilityRegistryIndex>>;
}

type RegistrySource = Extract<PackageSource, { kind: "registry" }>;

// --- Bounded HTTPS ------------------------------------------------------------

/**
 * GETs `url` and returns at most `maxBytes`. Every hop must be https without
 * credentials; redirects are followed by hand (at most three) so none can
 * downgrade to http or reach a `file:` URL. The whole exchange, body
 * included, is bounded by `timeoutMs`.
 */
export async function boundedHttpsGet(
  url: string,
  options: { fetch?: RegistryFetch; maxBytes: number; timeoutMs: number; what: string },
): Promise<Buffer> {
  const fetchImpl = options.fetch ?? (fetch as unknown as RegistryFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (!isCapabilityRegistryUrl(current)) {
        throw new CapabilityError(
          "invalid-request",
          `The ${options.what} address must be https:// without credentials.`,
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "application/json, application/gzip, application/octet-stream" },
        });
      } catch {
        throw new CapabilityError(
          "source-unavailable",
          controller.signal.aborted
            ? `The ${options.what} did not answer in time.`
            : `Could not reach the ${options.what}. Check the address and that this machine can reach it.`,
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || hop >= CAPABILITY_REGISTRY_LIMITS.maxRedirects) {
          throw new CapabilityError(
            "source-unavailable",
            `The ${options.what} redirected too often.`,
          );
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CapabilityError(
          "source-unavailable",
          `The ${options.what} answered HTTP ${response.status}.`,
        );
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new CapabilityError("too-large", `The ${options.what} is larger than the limit.`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > options.maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new CapabilityError(
                "too-large",
                `The ${options.what} is larger than the limit.`,
              );
            }
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          if (error instanceof CapabilityError) throw error;
          throw new CapabilityError(
            "source-unavailable",
            controller.signal.aborted
              ? `The ${options.what} did not answer in time.`
              : `The ${options.what} download was interrupted.`,
          );
        }
      }
      return Buffer.concat(chunks, total);
    }
  } finally {
    clearTimeout(timer);
  }
}

// --- Tarballs -------------------------------------------------------------------

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end >= 0 ? slice.subarray(0, end) : slice).toString("utf8");
}

function tarNumber(block: Buffer, start: number, length: number): number {
  if ((block[start]! & 0x80) !== 0) {
    throw new CapabilityError("too-large", "A tarball entry is larger than the limit.");
  }
  const text = tarString(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new CapabilityError("unsafe-content", "The tarball has a malformed header.");
  }
  return Number.parseInt(text, 8);
}

function headerChecksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : block[index]!;
  }
  return sum === tarNumber(block, 148, 8);
}

/** A pax extended header's `path` record, if any. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  const text = data.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** The entry's path, normalised; refuses absolute, escaping and Windows-shaped names. */
function safeEntryPath(raw: string): string {
  let value = raw;
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new CapabilityError(
      "unsafe-content",
      "The tarball has an absolute or escaping path; nothing was unpacked.",
    );
  }
  return value;
}

/**
 * Unpacks a (gzip-compressed) tar archive in memory and returns the files
 * under `subpath`, relative to it. Refuses symbolic and hard links, devices,
 * FIFOs, absolute or escaping paths and anything past the package limits;
 * nothing is written to disk and nothing in the archive is run.
 */
export function extractPackageTarball(archive: Buffer, subpath = ""): PackageFile[] {
  let data = archive;
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      data = gunzipSync(archive, { maxOutputLength: CAPABILITY_REGISTRY_LIMITS.maxUnpackedBytes });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new CapabilityError("too-large", "The tarball unpacks to more than the limit.");
      }
      throw new CapabilityError("unsafe-content", "The tarball is not valid gzip.");
    }
  }
  if (data.length > CAPABILITY_REGISTRY_LIMITS.maxUnpackedBytes) {
    throw new CapabilityError("too-large", "The tarball unpacks to more than the limit.");
  }
  const prefix = subpath
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
  const files: Array<{ path: string; content: Buffer; executable: boolean }> = [];
  let offset = 0;
  let entries = 0;
  let longName: string | undefined;
  let paxName: string | undefined;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (!headerChecksumOk(header)) {
      throw new CapabilityError("unsafe-content", "The tarball has a malformed header.");
    }
    entries += 1;
    if (entries > CAPABILITY_LIMITS.maxPackageFiles * 2) {
      throw new CapabilityError("too-large", "The tarball has too many entries.");
    }
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > data.length) {
      throw new CapabilityError("unsafe-content", "The tarball is truncated.");
    }
    const body = data.subarray(bodyStart, bodyEnd);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxName = paxPath(body);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = tarString(body, 0, body.length);
      continue;
    }
    const ustarPrefix =
      header.subarray(257, 262).toString("latin1") === "ustar" ? tarString(header, 345, 155) : "";
    const headerName = tarString(header, 0, 100);
    const rawName =
      paxName ?? longName ?? (ustarPrefix ? `${ustarPrefix}/${headerName}` : headerName);
    paxName = undefined;
    longName = undefined;
    if (type === "1" || type === "2") {
      throw new CapabilityError(
        "unsafe-content",
        "The tarball contains a link; registry packages must be plain files.",
      );
    }
    if (type === "3" || type === "4" || type === "6") {
      throw new CapabilityError(
        "unsafe-content",
        "The tarball contains a device or FIFO; registry packages must be plain files.",
      );
    }
    const entryPath = safeEntryPath(rawName);
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new CapabilityError("unsafe-content", "The tarball contains an unsupported entry.");
    }
    if (size > CAPABILITY_LIMITS.maxFileBytes) {
      throw new CapabilityError("too-large", `${entryPath} is larger than the per-file limit.`);
    }
    if (prefix && !entryPath.startsWith(`${prefix}/`)) continue;
    const relative = prefix ? entryPath.slice(prefix.length + 1) : entryPath;
    if (!relative) continue;
    const mode = tarNumber(header, 100, 8);
    files.push({ path: relative, content: Buffer.from(body), executable: (mode & 0o111) !== 0 });
  }
  if (files.length === 0) {
    throw new CapabilityError(
      "not-found",
      prefix ? "The tarball has nothing under that subpath." : "The tarball is empty.",
    );
  }
  return validatePackageFiles(files);
}

// --- Index -------------------------------------------------------------------

export function findRegistry(context: RegistryContext, registryId: string): CapabilityRegistry {
  const registry = context.registries.find((entry) => entry.id === registryId);
  if (!registry) {
    throw new CapabilityError(
      "not-found",
      `No package registry named ${registryId} is configured. Add it in Capabilities → Setups → Registries.`,
    );
  }
  return registry;
}

function assertRegistryAllowed(context: RegistryContext, registryId: string): void {
  if (isCapabilityRegistryForbidden(context.forbiddenSources, registryId)) {
    throw new CapabilityError(
      "unsupported",
      "Your organisation's policy forbids packages from this registry.",
    );
  }
}

/** Fetches, validates and (for a pinned key) verifies a registry's index. */
export async function fetchRegistryIndex(
  registry: CapabilityRegistry,
  context: Pick<RegistryContext, "fetch">,
): Promise<CapabilityRegistryIndex> {
  const bytes = await boundedHttpsGet(registry.indexUrl, {
    ...(context.fetch ? { fetch: context.fetch } : {}),
    maxBytes: CAPABILITY_REGISTRY_LIMITS.maxIndexBytes,
    timeoutMs: CAPABILITY_REGISTRY_LIMITS.indexTimeoutMs,
    what: "registry index",
  });
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CapabilityError("invalid-request", "The registry index is not valid JSON.");
  }
  const { index, issues } = validateCapabilityRegistryIndex(document);
  if (!index) {
    throw new CapabilityError(
      "invalid-request",
      `The registry index is not valid: ${issues[0]?.message ?? "unknown format"}`,
    );
  }
  if (registry.signingKey) {
    const signature = index.signature;
    const verified =
      signature !== undefined &&
      signature.keyId === graphSharingKeyId(registry.signingKey) &&
      verifyGraphBundleSignature(
        registry.signingKey,
        capabilityRegistrySigningPayload(document as Record<string, unknown>),
        signature.value,
      );
    if (!verified) {
      throw new CapabilityError(
        "unsafe-content",
        "The registry index is not signed by the registry's pinned key; nothing from it was used.",
      );
    }
  }
  return index;
}

function cachedIndex(
  context: RegistryContext,
  registry: CapabilityRegistry,
): Promise<CapabilityRegistryIndex> {
  if (!context.indexCache) return fetchRegistryIndex(registry, context);
  let pending = context.indexCache.get(registry.id);
  if (!pending) {
    pending = fetchRegistryIndex(registry, context);
    context.indexCache.set(registry.id, pending);
  }
  return pending;
}

function registryPackage(
  index: CapabilityRegistryIndex,
  source: RegistrySource,
): CapabilityRegistryPackage {
  const entry = index.packages[source.qualifiedId];
  if (!entry) {
    throw new CapabilityError(
      "not-found",
      `${source.qualifiedId} is not in the ${source.registryId} registry.`,
    );
  }
  return entry;
}

function registryVersion(
  entry: CapabilityRegistryPackage,
  version: string | undefined,
): CapabilityRegistryVersion {
  const wanted = version ?? entry.latest;
  const found = entry.versions.find((candidate) => candidate.version === wanted);
  if (!found) {
    throw new CapabilityError(
      "not-found",
      `Version ${wanted} of ${entry.qualifiedId} is no longer in the registry.`,
    );
  }
  return found;
}

/** Fetches one version's immutable content. */
export async function fetchRegistryArtifact(
  version: CapabilityRegistryVersion,
  context: RegistryContext,
): Promise<PackageFile[]> {
  const artifact = version.artifact;
  if (artifact.kind === "git") {
    const gitSource = {
      kind: "git" as const,
      repo: artifact.repo,
      subpath: artifact.subpath,
      channel: artifact.commit,
    };
    if (isCapabilitySourceForbidden(context.forbiddenSources, capabilityPackageId(gitSource))) {
      throw new CapabilityError(
        "unsupported",
        "Your organisation's policy forbids the repository this registry version points at.",
      );
    }
    const fetched = await fetchGitSource(gitSource, {
      workRoot: context.workRoot,
      ...(context.gitRun ? { run: context.gitRun } : {}),
    });
    try {
      if (fetched.commit !== artifact.commit) {
        throw new CapabilityError(
          "unsafe-content",
          "The repository did not resolve to the commit the registry published.",
        );
      }
      const exists = await fs.stat(fetched.directory).catch(() => null);
      if (!exists?.isDirectory()) {
        throw new CapabilityError("not-found", "The subdirectory does not exist at that commit.");
      }
      return await readPackageTree(fetched.directory);
    } finally {
      await fs.rm(fetched.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const archive = await boundedHttpsGet(artifact.url, {
    ...(context.fetch ? { fetch: context.fetch } : {}),
    maxBytes: CAPABILITY_REGISTRY_LIMITS.maxTarballBytes,
    timeoutMs: CAPABILITY_REGISTRY_LIMITS.tarballTimeoutMs,
    what: "package tarball",
  });
  // Nothing is unpacked until the bytes are the ones the registry published.
  if (sha256Hex(archive) !== artifact.sha256) {
    throw new CapabilityError(
      "unsafe-content",
      "The tarball does not match the SHA-256 the registry published.",
    );
  }
  return extractPackageTarball(archive, artifact.subpath);
}

/**
 * Inspects a registry package at `version` (the index's latest when absent).
 * The revision is the registry version; the artifact digest is the tree's.
 */
export async function inspectRegistrySource(
  source: RegistrySource,
  context: RegistryContext,
  version?: string,
): Promise<InspectedPackage> {
  assertRegistryAllowed(context, source.registryId);
  const packageId = capabilityPackageId(source);
  if (isCapabilitySourceForbidden(context.forbiddenSources, packageId)) {
    throw new CapabilityError("unsupported", "Your organisation's policy forbids this package.");
  }
  const registry = findRegistry(context, source.registryId);
  const index = await cachedIndex(context, registry);
  const entry = registryPackage(index, source);
  const selected = registryVersion(entry, version);
  const files = await fetchRegistryArtifact(selected, context);
  const inspected = inspectFiles(source, files, {
    revision: selected.version,
    fallbackName: entry.displayName ?? source.qualifiedId.split("/").pop() ?? source.qualifiedId,
  });
  return {
    ...inspected,
    ...(inspected.description || !entry.description ? {} : { description: entry.description }),
  };
}

/** The index's latest version of a registry package; `null` when it cannot be checked. */
export async function registryLatestVersion(
  pkg: Pick<CapabilityPackage, "source">,
  context: RegistryContext,
): Promise<string | null> {
  if (pkg.source.kind !== "registry") return null;
  try {
    assertRegistryAllowed(context, pkg.source.registryId);
    const registry = findRegistry(context, pkg.source.registryId);
    const index = await cachedIndex(context, registry);
    return index.packages[pkg.source.qualifiedId]?.latest ?? null;
  } catch {
    return null;
  }
}

/** A bounded listing of a registry's packages, for the Add dialog. */
export async function listRegistryPackages(
  registryId: string,
  context: RegistryContext,
  query = "",
): Promise<{
  registryId: string;
  packages: Array<{
    qualifiedId: string;
    displayName?: string;
    description?: string;
    latest: string;
    versions: string[];
  }>;
  truncated: number;
}> {
  assertRegistryAllowed(context, registryId);
  const registry = findRegistry(context, registryId);
  const index = await cachedIndex(context, registry);
  const needle = query.trim().toLowerCase();
  const matches = Object.values(index.packages)
    .filter(
      (entry) =>
        !needle ||
        entry.qualifiedId.toLowerCase().includes(needle) ||
        (entry.displayName ?? "").toLowerCase().includes(needle),
    )
    .sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  const limit = 200;
  return {
    registryId,
    packages: matches.slice(0, limit).map((entry) => ({
      qualifiedId: entry.qualifiedId,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.description ? { description: entry.description.slice(0, 300) } : {}),
      latest: entry.latest,
      versions: entry.versions.map((candidate) => candidate.version).slice(0, 20),
    })),
    truncated: Math.max(0, matches.length - limit),
  };
}
