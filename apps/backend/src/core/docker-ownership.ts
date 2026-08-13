import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Stable, non-reversible identifier for the backend registry that owns a
 * Docker resource. Development and packaged Electron instances use different
 * data directories, so this also separates their global Docker namespaces.
 */
export function dockerOwnerNamespace(dataDir: string): string {
  return createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Docker names are daemon-global. Use the registry owner and environment id
 * rather than the display name so equal names in two registries cannot race.
 */
export function dockerContainerRuntimeName(
  owner: string,
  environmentId: string,
): string {
  const safeEnvironmentId = environmentId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    || "environment";
  return `ork-${owner}-${safeEnvironmentId}`.slice(0, 128);
}
