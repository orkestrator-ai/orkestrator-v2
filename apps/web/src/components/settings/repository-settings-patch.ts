import { normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { RepositoryConfig } from "@/types";

/** The repository settings the dialog edits; everything else is backend-owned. */
const EDITABLE_KEYS = [
  "defaultBranch",
  "prBaseBranch",
  "defaultPortMappings",
  "filesToCopy",
  "entryPort",
  "agentSettings",
] as const satisfies readonly (keyof RepositoryConfig)[];

/** A stored record in the exact shape the dialog would save it. */
export function editableRepositorySettings(config: RepositoryConfig): RepositoryConfig {
  const filesToCopy = (config.filesToCopy ?? []).filter((file) => file.trim() !== "");
  const entryPort = config.entryPort;
  return {
    defaultBranch: config.defaultBranch,
    prBaseBranch: config.prBaseBranch,
    defaultPortMappings:
      config.defaultPortMappings && config.defaultPortMappings.length > 0
        ? config.defaultPortMappings
        : undefined,
    filesToCopy: filesToCopy.length > 0 ? filesToCopy : undefined,
    entryPort:
      entryPort !== undefined && entryPort >= 1 && entryPort <= 65535 ? entryPort : undefined,
    agentSettings: normalizeAgentSettings(config.agentSettings),
  };
}

export interface RepositorySettingsPatch {
  updates: Partial<RepositoryConfig>;
  unset: (keyof RepositoryConfig)[];
}

/**
 * The fields the user changed since the dialog loaded `baseline`. Only these
 * are sent, so a field another window changed meanwhile is not reverted.
 */
export function repositorySettingsPatch(
  next: RepositoryConfig,
  baseline: RepositoryConfig,
): RepositorySettingsPatch {
  const from = editableRepositorySettings(baseline);
  const to = editableRepositorySettings(next);
  const updates: Record<string, unknown> = {};
  const unset: (keyof RepositoryConfig)[] = [];
  for (const key of EDITABLE_KEYS) {
    if (deepEqualJson(to[key], from[key])) continue;
    if (to[key] === undefined) unset.push(key);
    else updates[key] = to[key];
  }
  return { updates: updates as Partial<RepositoryConfig>, unset };
}
