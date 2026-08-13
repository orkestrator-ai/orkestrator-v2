import { promises as fs } from "node:fs";
import path from "node:path";
import {
  LEGACY_ENABLED_AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";

const SELECTION_FILE = "agent-platforms.json";

type StoredSelection = {
  version: 1;
  enabled: AgentPlatform[];
};

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * Resolve the pre-backend selection used to decide which large toolchains are
 * downloaded. A sidecar exists because this decision has to happen before the
 * backend (and therefore config storage) starts.
 */
export async function loadAgentPlatformSelection(dataDir: string): Promise<{
  enabled: AgentPlatform[];
  needsFirstRunChoice: boolean;
}> {
  const config = await readJson(path.join(dataDir, "config.json"));
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const global = (config as { global?: unknown }).global;
    if (global && typeof global === "object" && !Array.isArray(global)) {
      const explicit = (global as { enabledAgentPlatforms?: unknown })
        .enabledAgentPlatforms;
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

  const sidecar = await readJson(path.join(dataDir, SELECTION_FILE));
  if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    const enabled = normalizeAgentPlatforms(
      (sidecar as { enabled?: unknown }).enabled,
      [],
    );
    if (enabled.length > 0) return { enabled, needsFirstRunChoice: false };
  }

  return { enabled: [], needsFirstRunChoice: true };
}

export async function saveAgentPlatformSelection(
  dataDir: string,
  enabledValue: readonly AgentPlatform[],
): Promise<void> {
  const enabled = normalizeAgentPlatforms(enabledValue, []);
  if (enabled.length === 0) throw new Error("Select at least one agent platform");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, SELECTION_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  const payload: StoredSelection = { version: 1, enabled };
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}
