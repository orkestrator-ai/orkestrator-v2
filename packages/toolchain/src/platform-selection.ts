import { promises as fs } from "node:fs";
import path from "node:path";
import {
  LEGACY_ENABLED_AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";

/** Written by the desktop launcher before the backend exists to own config. */
export const AGENT_PLATFORM_SELECTION_FILE = "agent-platforms.json";
/** The backend's own config; its `global.enabledAgentPlatforms` wins once present. */
export const AGENT_CONFIG_FILE = "config.json";

/** `undefined` for a missing or unreadable file: callers treat both as "not chosen". */
export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the pre-backend platform selection. CLI-backed platforms use it to
 * decide which toolchains are downloaded; SDK-only platforms still use it for
 * product availability. A sidecar exists because this decision happens before
 * the backend (and therefore config storage) starts.
 */
export async function loadAgentPlatformSelection(dataDir: string): Promise<{
  enabled: AgentPlatform[];
  needsFirstRunChoice: boolean;
}> {
  const config = await readJsonFile(path.join(dataDir, AGENT_CONFIG_FILE));
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const global = (config as { global?: unknown }).global;
    if (global && typeof global === "object" && !Array.isArray(global)) {
      const explicit = (global as { enabledAgentPlatforms?: unknown }).enabledAgentPlatforms;
      if (explicit !== undefined) {
        const enabled = normalizeAgentPlatforms(explicit, []);
        if (enabled.length > 0) return { enabled, needsFirstRunChoice: false };
      }
    }
    // An installation that predates platform selection keeps exactly the
    // systems it previously had instead of unexpectedly downloading two more.
    return {
      enabled: [...LEGACY_ENABLED_AGENT_PLATFORMS],
      needsFirstRunChoice: false,
    };
  }

  const sidecar = await readJsonFile(path.join(dataDir, AGENT_PLATFORM_SELECTION_FILE));
  if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    const enabled = normalizeAgentPlatforms((sidecar as { enabled?: unknown }).enabled, []);
    if (enabled.length > 0) return { enabled, needsFirstRunChoice: false };
  }

  return { enabled: [], needsFirstRunChoice: true };
}
