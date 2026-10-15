/**
 * Toolchain artifacts from another release's requirements manifest: the
 * update pre-fetch downloads the target version's pinned binaries before the
 * restart, so the new version starts with everything already verified.
 *
 * The manifest arrives over the network. It was checked against the checksum
 * the channel index publishes (and a signature once keys are embedded), but
 * every field the installer reads is still validated here before a single
 * byte is fetched: the pinned SHA-256 decides what is installed, and these
 * checks decide where it may come from and where it may be written. A target
 * may pin a tool this build does not know; its name only has to be safe to use
 * as a directory and command name.
 */
import path from "node:path";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  ToolchainArchitecture,
  ToolchainArchive,
  ToolchainArtifact,
  ToolchainCompanion,
  ToolchainPlatform,
} from "./manifest.js";

export class ExternalToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalToolchainError";
  }
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** Entries of the toolchain root's own layout, which no tool may take over. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["bin", "current"]);
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_ARTIFACTS = 256;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

function fail(where: string, message: string): never {
  throw new ExternalToolchainError(`${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(where, "not an object");
  return value as Record<string, unknown>;
}

function size(value: unknown, where: string, max = MAX_ARCHIVE_BYTES): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(where, "is not a valid size");
  }
  return value;
}

function sha256(value: unknown, where: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(where, "is not a SHA-256");
  return value;
}

function plainFileName(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    value !== path.basename(value)
  ) {
    fail(where, "is not a plain file name");
  }
  return value;
}

function relativePath(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    fail(where, "is invalid");
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    fail(where, "escapes the archive");
  }
  return value;
}

function archive(value: unknown, where: string): ToolchainArchive {
  const source = record(value, where);
  const format = source.format;
  if (format !== "zip" && format !== "tar.gz" && format !== "raw")
    fail(`${where}.format`, "is unsupported");
  const allowedHosts = source.allowedHosts;
  if (
    !Array.isArray(allowedHosts) ||
    allowedHosts.length === 0 ||
    allowedHosts.length > 8 ||
    allowedHosts.some((host) => typeof host !== "string" || !HOST.test(host))
  ) {
    fail(`${where}.allowedHosts`, "must list lowercase host names");
  }
  if (typeof source.url !== "string") fail(`${where}.url`, "is missing");
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    fail(`${where}.url`, "is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    fail(`${where}.url`, "must be plain HTTPS");
  if (!(allowedHosts as string[]).includes(url.hostname)) {
    fail(`${where}.url`, `host ${url.hostname} is not in allowedHosts`);
  }
  const result: ToolchainArchive = {
    format,
    url: source.url,
    // A raw download is the executable itself; it has no entry inside an archive.
    entryPath:
      format === "raw" && source.entryPath === ""
        ? ""
        : relativePath(source.entryPath, `${where}.entryPath`),
    size: size(source.size, `${where}.size`),
    sha256: sha256(source.sha256, `${where}.sha256`),
    allowedHosts: [...(allowedHosts as string[])],
  };
  if (source.bundleRoot !== undefined) {
    if (typeof source.bundleRoot !== "string" || !source.bundleRoot.endsWith("/")) {
      fail(`${where}.bundleRoot`, "must end with /");
    }
    relativePath(source.bundleRoot.slice(0, -1) || ".", `${where}.bundleRoot`);
    result.bundleRoot = source.bundleRoot;
  }
  if (source.bundleFiles !== undefined) {
    if (!Array.isArray(source.bundleFiles) || source.bundleFiles.length > 1024) {
      fail(`${where}.bundleFiles`, "is invalid");
    }
    result.bundleFiles = source.bundleFiles.map((entry, index) => {
      const file = record(entry, `${where}.bundleFiles[${index}]`);
      return {
        path: relativePath(file.path, `${where}.bundleFiles[${index}].path`),
        size: size(file.size, `${where}.bundleFiles[${index}].size`),
        sha256: sha256(file.sha256, `${where}.bundleFiles[${index}].sha256`),
      };
    });
  }
  if (source.bundleIntegrity !== undefined) {
    const integrity = record(source.bundleIntegrity, `${where}.bundleIntegrity`);
    result.bundleIntegrity = {
      fileCount: size(integrity.fileCount, `${where}.bundleIntegrity.fileCount`, 1_000_000),
      totalSize: size(integrity.totalSize, `${where}.bundleIntegrity.totalSize`),
      sha256: sha256(integrity.sha256, `${where}.bundleIntegrity.sha256`),
    };
  }
  return result;
}

function companion(value: unknown, where: string): ToolchainCompanion {
  const source = record(value, where);
  const executable = record(source.executable, `${where}.executable`);
  return {
    fileName: plainFileName(source.fileName, `${where}.fileName`),
    archive: archive(source.archive, `${where}.archive`),
    executable: {
      size: size(executable.size, `${where}.executable.size`),
      sha256: sha256(executable.sha256, `${where}.executable.sha256`),
    },
  };
}

function artifact(value: unknown, where: string): ToolchainArtifact {
  const source = record(value, where);
  if (typeof source.name !== "string" || !NAME.test(source.name))
    fail(`${where}.name`, "is not a tool name");
  if (RESERVED_NAMES.has(source.name)) fail(`${where}.name`, "is reserved by the toolchain layout");
  if (typeof source.version !== "string" || !VERSION.test(source.version)) {
    fail(`${where}.version`, "is not a version");
  }
  if (source.platform !== "darwin" && source.platform !== "linux")
    fail(`${where}.platform`, "is unsupported");
  if (source.architecture !== "arm64" && source.architecture !== "x64") {
    fail(`${where}.architecture`, "is unsupported");
  }
  const executable = record(source.executable, `${where}.executable`);
  const hasInstalled =
    executable.installedSize !== undefined || executable.installedSha256 !== undefined;
  for (const flag of ["repairInvalidMacSignature", "skipMacSignatureVerification"] as const) {
    if (executable[flag] !== undefined && typeof executable[flag] !== "boolean") {
      fail(`${where}.executable.${flag}`, "must be a boolean");
    }
  }
  const aliases = source.activationAliases;
  if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 8)) {
    fail(`${where}.activationAliases`, "is invalid");
  }
  const companions = source.companions;
  if (companions !== undefined && (!Array.isArray(companions) || companions.length > 8)) {
    fail(`${where}.companions`, "is invalid");
  }
  return {
    name: source.name,
    version: source.version,
    platform: source.platform as ToolchainPlatform,
    architecture: source.architecture as ToolchainArchitecture,
    archive: archive(source.archive, `${where}.archive`),
    ...(aliases
      ? {
          activationAliases: (aliases as unknown[]).map((alias, index) =>
            plainFileName(alias, `${where}.activationAliases[${index}]`),
          ),
        }
      : {}),
    ...(companions
      ? {
          companions: (companions as unknown[]).map((entry, index) =>
            companion(entry, `${where}.companions[${index}]`),
          ),
        }
      : {}),
    executable: {
      fileName: plainFileName(executable.fileName, `${where}.executable.fileName`),
      size: size(executable.size, `${where}.executable.size`),
      sha256: sha256(executable.sha256, `${where}.executable.sha256`),
      ...(hasInstalled
        ? {
            installedSize: size(executable.installedSize, `${where}.executable.installedSize`),
            installedSha256: sha256(
              executable.installedSha256,
              `${where}.executable.installedSha256`,
            ),
          }
        : {}),
      ...(executable.repairInvalidMacSignature === true ? { repairInvalidMacSignature: true } : {}),
      ...(executable.skipMacSignatureVerification === true
        ? { skipMacSignatureVerification: true }
        : {}),
    },
    // The installer's type names known tools; a target may add one, and the
    // installer only ever uses the name as a directory and command name.
  } as unknown as ToolchainArtifact;
}

/** Validates a target manifest's `toolchain.artifacts`. Throws {@link ExternalToolchainError}. */
export function parseExternalToolchainArtifacts(value: unknown): ToolchainArtifact[] {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) {
    throw new ExternalToolchainError("toolchain.artifacts must be a bounded array");
  }
  return value.map((entry, index) => artifact(entry, `toolchain.artifacts[${index}]`));
}

/**
 * The target artifacts this machine needs: its platform and architecture, its
 * enabled agent platforms, and every non-agent tool (support tools like `gh`,
 * or a tool this build has never heard of).
 */
export function selectPrefetchArtifacts(
  artifacts: readonly ToolchainArtifact[],
  options: {
    platform: string;
    architecture: string;
    enabledAgentPlatforms: readonly AgentPlatform[];
  },
): ToolchainArtifact[] {
  const enabled = new Set<string>(options.enabledAgentPlatforms);
  const selected = artifacts.filter(
    (entry) =>
      entry.platform === options.platform &&
      entry.architecture === options.architecture &&
      (!isAgentPlatform(entry.name) || enabled.has(entry.name)),
  );
  const names = new Set<string>();
  for (const entry of selected) {
    if (names.has(entry.name)) {
      throw new ExternalToolchainError(
        `toolchain.artifacts pins ${entry.name} twice for this machine`,
      );
    }
    names.add(entry.name);
  }
  return selected;
}
