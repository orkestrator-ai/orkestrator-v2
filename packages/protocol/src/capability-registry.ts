/**
 * Capability package registries (docs/architecture/agent-capabilities-management.md,
 * "Updates and rollback", "Package registries").
 *
 * A registry is a trusted, administrator-configured HTTPS index. The index is
 * a bounded JSON document that maps a package's qualified id to its published
 * versions; each version names immutable content: a Git repository, subpath
 * and full commit, or an HTTPS tarball with its SHA-256. A registry package's
 * identity is `registry:<registryId>/<qualifiedId>`, so an administrator can
 * forbid a whole registry with the `forbiddenSources` prefix
 * `registry:<registryId>/`.
 *
 * When the registry is configured with a pinned Ed25519 signing key, the index
 * must carry that key's signature over {@link capabilityRegistrySigningPayload}.
 *
 * Browser-safe: this module validates parsed values; fetching, signature
 * checks and extraction live in the backend.
 */
import { canonicalCapabilityJson } from "./capability-resources-resolve.js";
import {
  CAPABILITY_LIMITS,
  isCapabilityRegistryId,
  isCapabilityRegistryQualifiedId,
  isSafeCapabilityRelativePath,
} from "./capability-resources.js";

export const CAPABILITY_REGISTRY_INDEX_FORMAT = "orkestrator-capability-registry";
export const CAPABILITY_REGISTRY_INDEX_VERSION = 1;

export const CAPABILITY_REGISTRY_LIMITS = Object.freeze({
  maxRegistries: 16,
  /** The index document. */
  maxIndexBytes: 2 * 1024 * 1024,
  indexTimeoutMs: 15_000,
  maxPackagesPerIndex: CAPABILITY_LIMITS.maxPackages,
  maxVersionsPerPackage: 100,
  /** A compressed tarball. */
  maxTarballBytes: CAPABILITY_LIMITS.maxPackageBytes,
  /** A tarball once decompressed: the package limit plus tar headers and padding. */
  maxUnpackedBytes: CAPABILITY_LIMITS.maxPackageBytes + 8 * 1024 * 1024,
  tarballTimeoutMs: 60_000,
  maxRedirects: 3,
  maxLabelChars: 80,
  maxUrlChars: 2_048,
});

/** One configured registry, as stored and listed. Never holds a credential. */
export interface CapabilityRegistry {
  /** Lower-case slug; part of every package identity from this registry. */
  id: string;
  label: string;
  /** `https://` address of the index document. */
  indexUrl: string;
  /** Pinned Ed25519 public key (raw, base64url): the index must be signed by it. */
  signingKey?: string;
  /** The pinned key's id (first 16 bytes of SHA-256, hex). */
  signingKeyId?: string;
  addedAt: string;
  updatedAt: string;
  lastFetchedAt?: string;
  /** How many packages the last fetched index listed. */
  packageCount?: number;
  /** The last fetch failure, as a user-facing sentence. */
  lastError?: string;
}

export interface CapabilityRegistryList {
  revision: number;
  registries: CapabilityRegistry[];
  /** Imports refuse unsigned manifests and manifests signed by an untrusted key. */
  requireSignedManifests: boolean;
  /** This installation's manifest signing key, when one exists. */
  signingKey: { keyId: string; fingerprint: string } | null;
}

export type CapabilityRegistryArtifact =
  | { kind: "git"; repo: string; subpath: string; commit: string }
  | { kind: "tarball"; url: string; sha256: string; subpath: string };

export interface CapabilityRegistryVersion {
  version: string;
  artifact: CapabilityRegistryArtifact;
}

export interface CapabilityRegistryPackage {
  qualifiedId: string;
  displayName?: string;
  description?: string;
  latest: string;
  versions: CapabilityRegistryVersion[];
}

export interface CapabilityRegistryIndex {
  packages: Record<string, CapabilityRegistryPackage>;
  signature?: { algorithm: "ed25519"; keyId: string; value: string };
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isCapabilityRegistryVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** An `https://` URL without credentials or a fragment, bounded. */
export function isCapabilityRegistryUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > CAPABILITY_REGISTRY_LIMITS.maxUrlChars) {
    return false;
  }
  const url = URL.parse(value.trim());
  return Boolean(
    url && url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed).slice(0, max).join("") : undefined;
}

function parseArtifact(value: Record<string, unknown>): CapabilityRegistryArtifact | string {
  if (isRecord(value.git)) {
    const git = value.git;
    const repo = typeof git.repo === "string" ? git.repo.trim() : "";
    const subpath = typeof git.subpath === "string" ? git.subpath.trim() : "";
    if (
      !repo ||
      repo.length > CAPABILITY_LIMITS.maxIdChars ||
      !/^(?:https:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@)/.test(repo)
    ) {
      return "git.repo must be an https or SSH repository address.";
    }
    if (subpath !== "" && !isSafeCapabilityRelativePath(subpath)) {
      return "git.subpath must be a relative path inside the repository.";
    }
    if (typeof git.commit !== "string" || !COMMIT.test(git.commit)) {
      return "git.commit must be a full commit id.";
    }
    return { kind: "git", repo, subpath, commit: git.commit };
  }
  if (isRecord(value.tarball)) {
    const tarball = value.tarball;
    const subpath = typeof tarball.subpath === "string" ? tarball.subpath.trim() : "";
    if (!isCapabilityRegistryUrl(tarball.url)) {
      return "tarball.url must be an https address without credentials.";
    }
    const sha256 = typeof tarball.sha256 === "string" ? tarball.sha256.replace(/^sha256:/, "") : "";
    if (!SHA256.test(sha256)) return "tarball.sha256 must be a hex SHA-256 digest.";
    if (subpath !== "" && !isSafeCapabilityRelativePath(subpath)) {
      return "tarball.subpath must be a relative path inside the archive.";
    }
    return { kind: "tarball", url: tarball.url.trim(), sha256, subpath };
  }
  return "Each version names a git or a tarball artifact.";
}

export interface CapabilityRegistryIndexIssue {
  path: string;
  message: string;
}

/**
 * Validates a parsed index. Entries with an issue are dropped (and reported);
 * a document that is not an index at all yields `index: null`.
 */
export function validateCapabilityRegistryIndex(value: unknown): {
  index: CapabilityRegistryIndex | null;
  issues: CapabilityRegistryIndexIssue[];
} {
  const issues: CapabilityRegistryIndexIssue[] = [];
  if (!isRecord(value)) {
    return { index: null, issues: [{ path: "$", message: "The index must be an object." }] };
  }
  if (value.format !== CAPABILITY_REGISTRY_INDEX_FORMAT) {
    return {
      index: null,
      issues: [{ path: "$.format", message: `Expected "${CAPABILITY_REGISTRY_INDEX_FORMAT}".` }],
    };
  }
  if (value.version !== CAPABILITY_REGISTRY_INDEX_VERSION) {
    return {
      index: null,
      issues: [
        {
          path: "$.version",
          message: `Expected index version ${CAPABILITY_REGISTRY_INDEX_VERSION}.`,
        },
      ],
    };
  }
  if (!isRecord(value.packages)) {
    return { index: null, issues: [{ path: "$.packages", message: "Expected a mapping." }] };
  }
  const entries = Object.entries(value.packages);
  if (entries.length > CAPABILITY_REGISTRY_LIMITS.maxPackagesPerIndex) {
    return {
      index: null,
      issues: [{ path: "$.packages", message: "The index lists too many packages." }],
    };
  }
  const packages: Record<string, CapabilityRegistryPackage> = {};
  for (const [qualifiedId, raw] of entries) {
    const at = `$.packages.${qualifiedId}`;
    if (!isCapabilityRegistryQualifiedId(qualifiedId)) {
      issues.push({ path: at, message: "Not a valid package name." });
      continue;
    }
    if (!isRecord(raw) || !Array.isArray(raw.versions)) {
      issues.push({ path: at, message: "Expected a mapping with a versions list." });
      continue;
    }
    if (
      raw.versions.length === 0 ||
      raw.versions.length > CAPABILITY_REGISTRY_LIMITS.maxVersionsPerPackage
    ) {
      issues.push({ path: `${at}.versions`, message: "Expected 1 to 100 versions." });
      continue;
    }
    const versions: CapabilityRegistryVersion[] = [];
    const seen = new Set<string>();
    raw.versions.forEach((entry: unknown, position: number) => {
      const where = `${at}.versions[${position}]`;
      if (!isRecord(entry) || !isCapabilityRegistryVersion(entry.version)) {
        issues.push({ path: where, message: "Expected a version name." });
        return;
      }
      if (seen.has(entry.version)) {
        issues.push({ path: where, message: "The version is listed twice." });
        return;
      }
      const artifact = parseArtifact(entry);
      if (typeof artifact === "string") {
        issues.push({ path: where, message: artifact });
        return;
      }
      seen.add(entry.version);
      versions.push({ version: entry.version, artifact });
    });
    if (versions.length === 0) continue;
    const latest =
      raw.latest === undefined
        ? versions[0]!.version
        : typeof raw.latest === "string" && seen.has(raw.latest)
          ? raw.latest
          : undefined;
    if (!latest) {
      issues.push({ path: `${at}.latest`, message: "latest must name a listed version." });
      continue;
    }
    const displayName = boundedText(raw.displayName, CAPABILITY_LIMITS.maxNameChars);
    const description = boundedText(raw.description, CAPABILITY_LIMITS.maxDescriptionChars);
    packages[qualifiedId] = {
      qualifiedId,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      latest,
      versions,
    };
  }
  const signature = isRecord(value.signature)
    ? value.signature.algorithm === "ed25519" &&
      typeof value.signature.keyId === "string" &&
      typeof value.signature.value === "string" &&
      value.signature.value.length <= 200
      ? {
          algorithm: "ed25519" as const,
          keyId: value.signature.keyId.slice(0, 64),
          value: value.signature.value,
        }
      : undefined
    : undefined;
  if (value.signature !== undefined && !signature) {
    issues.push({ path: "$.signature", message: "The signature is malformed." });
  }
  return { index: { packages, ...(signature ? { signature } : {}) }, issues };
}

/**
 * The text a registry signs: the parsed index document without its
 * `signature` member, as canonical JSON (object keys sorted at every level,
 * no whitespace). Publishers sign the same text with their Ed25519 key.
 */
export function capabilityRegistrySigningPayload(document: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = document;
  return canonicalCapabilityJson(rest);
}

/** The settings form's registry, validated; `null` with a reason when invalid. */
export function parseCapabilityRegistryInput(
  value: unknown,
):
  | { registry: Pick<CapabilityRegistry, "id" | "label" | "indexUrl" | "signingKey"> }
  | { error: string } {
  if (!isRecord(value)) return { error: "Describe the registry." };
  if (!isCapabilityRegistryId(value.id)) {
    return { error: "The registry id is lower-case letters, digits and dashes." };
  }
  if (!isCapabilityRegistryUrl(value.indexUrl)) {
    return { error: "The index address must be https:// without credentials or a fragment." };
  }
  const label = boundedText(value.label, CAPABILITY_REGISTRY_LIMITS.maxLabelChars) ?? value.id;
  const signingKey =
    typeof value.signingKey === "string" && value.signingKey.trim() !== ""
      ? value.signingKey.trim()
      : undefined;
  if (signingKey !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(signingKey)) {
    return { error: "The signing key is a 43-character base64url Ed25519 public key." };
  }
  return {
    registry: {
      id: value.id,
      label,
      indexUrl: value.indexUrl.trim(),
      ...(signingKey ? { signingKey } : {}),
    },
  };
}

/** The `forbiddenSources` prefix that forbids every package of a registry. */
export function capabilityRegistrySourcePrefix(registryId: string): string {
  return `registry:${registryId}/`;
}

/** Whether `forbiddenSources` forbids the registry as a whole or `packageId` in it. */
export function isCapabilitySourceForbidden(
  forbiddenSources: readonly string[],
  packageId: string,
): boolean {
  return forbiddenSources.some((prefix) => prefix.length > 0 && packageId.startsWith(prefix));
}

/** Whether `forbiddenSources` forbids a whole registry (`registry:<id>/`, `registry:<id>` or a shorter prefix). */
export function isCapabilityRegistryForbidden(
  forbiddenSources: readonly string[],
  registryId: string,
): boolean {
  const prefix = capabilityRegistrySourcePrefix(registryId);
  return forbiddenSources.some(
    (entry) => entry.length > 0 && (prefix.startsWith(entry) || entry === prefix.slice(0, -1)),
  );
}
