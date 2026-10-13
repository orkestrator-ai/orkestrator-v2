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
