import { promises as fs } from "node:fs";
import path from "node:path";
import {
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  AGENT_CONFIG_FILE,
  AGENT_PLATFORM_SELECTION_FILE,
  readJsonFile,
} from "@orkestrator/toolchain/platform-selection";

type StoredSelection = {
  version: 1;
  enabled: AgentPlatform[];
};

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
}

export async function saveAgentPlatformSelection(
  dataDir: string,
  enabledValue: readonly AgentPlatform[],
): Promise<void> {
  const enabled = normalizeAgentPlatforms(enabledValue, []);
  if (enabled.length === 0) throw new Error("Select at least one agent platform");
  const payload: StoredSelection = { version: 1, enabled };
  await writeJsonAtomically(path.join(dataDir, AGENT_PLATFORM_SELECTION_FILE), payload);
}

/**
 * Make a launcher-supplied selection the one an isolated agent-test profile
 * actually runs with.
 *
 * Provisioning the selected platform is only half of launchability: every agent picker
 * in the app reads `config.global.enabledAgentPlatforms`, which the backend
 * derives from this profile's own state. Writing the sidecar covers a fresh
 * profile, whose `config.json` does not exist yet. An existing `config.json`
 * takes precedence over the sidecar, so a profile that has saved settings once
 * would otherwise silently fall back to the legacy three and leave the freshly
 * selected platforms unofferable — hence the reconcile.
 *
 * Safe here and nowhere else: the caller has already established that this is an
 * `agent-test` profile, whose data directory is disposable and isolated from the
 * user's installation, and this runs before the backend starts, so nothing else
 * is writing either file.
 */
export async function applyAgentTestPlatformSelection(
  dataDir: string,
  enabledValue: readonly AgentPlatform[],
): Promise<void> {
  const enabled = normalizeAgentPlatforms(enabledValue, []);
  if (enabled.length === 0) return;
  await saveAgentPlatformSelection(dataDir, enabled);

  const configPath = path.join(dataDir, AGENT_CONFIG_FILE);
  const config = await readJsonFile(configPath);
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const record = config as { global?: unknown };
  const global =
    record.global && typeof record.global === "object" && !Array.isArray(record.global)
      ? (record.global as Record<string, unknown>)
      : {};
  const current = normalizeAgentPlatforms(global.enabledAgentPlatforms, []);
  if (
    current.length === enabled.length &&
    current.every((platform, index) => platform === enabled[index])
  )
    return;
  await writeJsonAtomically(configPath, {
    ...record,
    global: {
      ...global,
      enabledAgentPlatforms: enabled,
      // A default pointing at a platform this run did not provision would fail
      // at session creation instead of at the picker.
      defaultAgent: firstEnabledAgentPlatform(
        enabled,
        global.defaultAgent as AgentPlatform | undefined,
      ),
    },
  });
}
