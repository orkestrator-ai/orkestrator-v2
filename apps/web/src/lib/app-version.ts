import webPackage from "../../package.json";

const packagedVersion = typeof webPackage.version === "string" ? webPackage.version.trim() : "";

/** Version baked into this web bundle from `apps/web/package.json`. */
export const BUNDLED_APP_VERSION = packagedVersion || "0.0.0";

/**
 * What the backend reports when `ORKESTRATOR_VERSION` is absent or malformed.
 * The desktop launcher deliberately omits it outside production builds.
 */
export const UNSET_APP_VERSION = "0.0.0";

export interface DisplayedAppVersion {
  /** The version string to render. */
  version: string;
  /** Where it came from, so a fallback is never shown as a backend answer. */
  source: "runtime" | "bundled";
}

/**
 * Prefer the running backend version. Fall back to the bundled package
 * version when the backend is unreachable or still reporting the unset
 * placeholder, and say which of the two the caller is looking at.
 */
export function resolveDisplayedAppVersion(
  runtimeVersion: string | null | undefined,
): DisplayedAppVersion {
  const trimmed = runtimeVersion?.trim() ?? "";
  if (trimmed && trimmed !== UNSET_APP_VERSION) return { version: trimmed, source: "runtime" };
  return { version: BUNDLED_APP_VERSION, source: "bundled" };
}
