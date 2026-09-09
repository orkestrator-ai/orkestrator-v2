import webPackage from "../../package.json";

const packagedVersion =
  typeof webPackage.version === "string" ? webPackage.version.trim() : "";

/** Version baked into this web bundle from `apps/web/package.json`. */
export const BUNDLED_APP_VERSION = packagedVersion || "0.0.0";

/**
 * Prefer the running backend version. Fall back to the bundled package
 * version when the backend is unreachable or still reporting the unset
 * placeholder (`0.0.0`).
 */
export function resolveDisplayedAppVersion(runtimeVersion: string | null | undefined): string {
  const trimmed = runtimeVersion?.trim() ?? "";
  if (trimmed && trimmed !== "0.0.0") return trimmed;
  return BUNDLED_APP_VERSION;
}
