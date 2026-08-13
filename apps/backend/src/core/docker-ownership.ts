import { createHash } from "node:crypto";
import path from "node:path";

/** Stable, non-reversible identity for one backend registry. */
export function dockerOwnerNamespace(dataDir: string): string {
  return createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 16);
}

/** Docker names are daemon-global, so display names are not safe runtime ids. */
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
