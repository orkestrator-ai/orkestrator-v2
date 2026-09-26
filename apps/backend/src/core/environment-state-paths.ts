import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Data-directory roots that hold one child per environment, named by
 * {@link environmentStateKey}. Bridges write their session and checkpoint
 * state here, so the spawn path and every cleanup path must agree on the
 * scheme: a drift strands state that nothing else references.
 */
export const ENVIRONMENT_STATE_ROOTS = [
  "pi-bridge-sessions",
  "pi-bridge-state",
  "cursor-bridge-state",
  "acp-bridge-state",
] as const;

export type EnvironmentStateRoot = (typeof ENVIRONMENT_STATE_ROOTS)[number];

const ENVIRONMENT_STATE_KEY_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The opaque per-environment directory name. Hashing keeps environment IDs out
 * of paths that bridges may log, at the cost of making ownership provable only
 * by recomputing the hash for a known environment.
 */
export function environmentStateKey(environmentId: string): string {
  return createHash("sha256").update(environmentId).digest("hex").slice(0, 32);
}

export function isEnvironmentStateKey(name: string): boolean {
  return ENVIRONMENT_STATE_KEY_PATTERN.test(name);
}

export function environmentStateDirectory(
  dataDir: string,
  root: EnvironmentStateRoot,
  environmentId: string,
): string {
  return path.join(dataDir, root, environmentStateKey(environmentId));
}

/** Every per-environment state directory, whether or not it exists yet. */
export function environmentStateDirectories(dataDir: string, environmentId: string): string[] {
  return ENVIRONMENT_STATE_ROOTS.map((root) =>
    environmentStateDirectory(dataDir, root, environmentId),
  );
}
