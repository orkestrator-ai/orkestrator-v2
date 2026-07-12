import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Creates a unique session key for agent sessions (Claude/OpenCode).
 * This ensures tab IDs (which may be reused across environments, e.g., "default")
 * don't collide when multiple environments are running.
 *
 * @param environmentId - The environment ID (always required)
 * @param tabId - The tab ID within the environment
 * @returns A unique session key in the format "env-{environmentId}:{tabId}"
 */
export function createSessionKey(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

/**
 * Extracts the environmentId from a session key produced by `createSessionKey`.
 * Returns null if the key does not match the expected format.
 */
export function getEnvironmentIdFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith("env-")) return null;
  const colonIndex = sessionKey.indexOf(":");
  if (colonIndex === -1) return null;
  const environmentId = sessionKey.slice("env-".length, colonIndex);
  return environmentId.length > 0 ? environmentId : null;
}
