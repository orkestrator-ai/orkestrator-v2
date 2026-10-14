import type { StoreLayout } from "./storage-database.js";

/**
 * Database store holding native-agent display tails, one row per session key.
 * Imported by the store registry (storage-stores.ts), so keep this module free
 * of other imports.
 */
export const NATIVE_AGENT_DISPLAY_TAIL_STORE = "native-agent-display-tail-records";

/** The tail's environment: the indexed row owner `deleteByEnvironment` uses. */
export function nativeAgentDisplayTailOwner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const environmentId = (value as Record<string, unknown>).environmentId;
  return typeof environmentId === "string" && environmentId ? environmentId : undefined;
}

export const NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [NATIVE_AGENT_DISPLAY_TAIL_STORE]: { kind: "record", owner: nativeAgentDisplayTailOwner },
};
