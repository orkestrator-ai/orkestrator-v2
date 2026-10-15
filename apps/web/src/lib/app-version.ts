import webPackage from "../../package.json";

const packagedVersion = typeof webPackage.version === "string" ? webPackage.version.trim() : "";

/** Version baked into this web bundle from `apps/web/package.json`. */
export const BUNDLED_APP_VERSION = packagedVersion || "0.0.0";

/**
 * What a backend reports when it could not determine its own version. Current
 * backends fall back to their package version; older ones still send this.
 */
export const UNSET_APP_VERSION = "0.0.0";

/**
 * Normalize the version a backend reported. Returns null for a missing, blank
 * or placeholder answer so the caller never renders it as a real version.
 */
export function normalizeBackendVersion(runtimeVersion: string | null | undefined): string | null {
  const trimmed = runtimeVersion?.trim() ?? "";
  return trimmed && trimmed !== UNSET_APP_VERSION ? trimmed : null;
}

type ParsedAppVersion = { core: [number, number, number]; prerelease: string[] };

function parseAppVersion(version: string): ParsedAppVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  // Semver ranks numeric identifiers below alphanumeric ones.
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver ordering of two app versions: negative when `left` is older, positive
 * when it is newer, 0 when equal. Returns null when either is not a semver
 * version, so a caller never guesses which side is older.
 */
export function compareAppVersions(left: string, right: string): number | null {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  // A prerelease sorts before its release: 2.20.0-beta.1 < 2.20.0.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const order = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * How this client's bundled version relates to its backend's: `different` when
 * they differ but at least one is not a semver version.
 */
export type AppVersionSkew = "same" | "client-older" | "backend-older" | "different";

export function appVersionSkew(clientVersion: string, backendVersion: string): AppVersionSkew {
  if (clientVersion.trim() === backendVersion.trim()) return "same";
  const order = compareAppVersions(clientVersion, backendVersion);
  if (order === null) return "different";
  if (order === 0) return "same";
  return order < 0 ? "client-older" : "backend-older";
}
