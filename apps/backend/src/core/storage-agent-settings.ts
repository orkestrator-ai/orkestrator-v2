/**
 * One-way migration of the three legacy agent-settings shapes onto the shared
 * `AgentSettingsTier` in `@orkestrator/protocol/agent-settings`.
 *
 * Each tier used to store a different subset under different names: the global
 * block had `claudeMode`/`codexMode`/`opencodeMode` plus four model fields with
 * no UI at all, the repository had a single `agentStyle` that only Claude read
 * and a single `defaultModel` that two consumers disagreed about, and the
 * environment had per-platform modes but no models. This module folds all three
 * onto the same structure so one resolver can answer for every tier.
 *
 * Every function here is a pure projection so it can be tested without storage,
 * and every one preserves the *resolved* answer rather than the stored shape —
 * a migration that changed which agent or model a launch picks would be a
 * silent behaviour change on upgrade, which is exactly what the launch resolver
 * exists to prevent.
 */
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  normalizeAgentSettings,
  type AgentPlatformSettings,
  type AgentSettingsTier,
} from "@orkestrator/protocol/agent-settings";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function launchMode(value: unknown): "terminal" | "native" | undefined {
  return value === "terminal" || value === "native" ? value : undefined;
}

function claudeBackend(value: unknown): "sdk" | "tmux" | undefined {
  return value === "sdk" || value === "tmux" ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function block(settings: AgentPlatformSettings): AgentPlatformSettings | undefined {
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Merge a block into a platform slot without dropping what is already there. */
function mergeInto(
  platforms: Partial<Record<AgentPlatform, AgentPlatformSettings>>,
  platform: AgentPlatform,
  settings: AgentPlatformSettings,
): void {
  const merged = { ...platforms[platform], ...settings };
  const kept = block(merged);
  if (kept) platforms[platform] = kept;
}

/**
 * Cursor and Grok take the OpenCode mode.
 *
 * Not a design choice — it is what `resolveStartupLaunch` already did with
 * them. Neither platform had a mode of its own, so both fell into the `else`
 * branch of a ternary whose condition only distinguished Claude and Codex.
 * Seeding their blocks this way makes the coupling explicit and stored, so the
 * new per-platform tabs open showing the mode those agents were already using.
 */
const OPENCODE_MODE_FOLLOWERS: readonly AgentPlatform[] = ["opencode", "cursor", "grok"];

/** Global tier: per-platform modes, the four invisible model fields, and both defaults. */
export function migrateGlobalAgentSettings(global: JsonRecord): AgentSettingsTier {
  // An already-migrated config is authoritative. Re-reading the legacy fields
  // would resurrect values the user has since changed through the new panes.
  if (isRecord(global.agentSettings)) return normalizeAgentSettings(global.agentSettings);

  const platforms: Partial<Record<AgentPlatform, AgentPlatformSettings>> = {};
  mergeInto(platforms, "claude", {
    ...(launchMode(global.claudeMode) ? { mode: launchMode(global.claudeMode)! } : {}),
    ...(trimmed(global.claudeModel) ? { model: trimmed(global.claudeModel)! } : {}),
    ...(claudeBackend(global.claudeNativeBackend)
      ? { claudeNativeBackend: claudeBackend(global.claudeNativeBackend)! }
      : {}),
  });
  mergeInto(platforms, "codex", {
    ...(launchMode(global.codexMode) ? { mode: launchMode(global.codexMode)! } : {}),
    ...(trimmed(global.codexModel) ? { model: trimmed(global.codexModel)! } : {}),
    ...(trimmed(global.codexReasoningEffort)
      ? { reasoningEffort: trimmed(global.codexReasoningEffort)! }
      : {}),
  });

  const opencodeMode = launchMode(global.opencodeMode);
  for (const platform of OPENCODE_MODE_FOLLOWERS) {
    mergeInto(platforms, platform, {
      ...(opencodeMode ? { mode: opencodeMode } : {}),
      // Only OpenCode itself had a model field; Cursor and Grok never did.
      ...(platform === "opencode" && trimmed(global.opencodeModel)
        ? { model: trimmed(global.opencodeModel)! }
        : {}),
    });
  }

  return normalizeAgentSettings({
    ...(isAgentPlatform(global.defaultAgent) ? { defaultAgent: global.defaultAgent } : {}),
    ...(global.actionDefaults ? { actionDefaults: global.actionDefaults } : {}),
    platforms,
  });
}

/**
 * Repository tier.
 *
 * `agentStyle` becomes Claude's mode, because Claude is the only platform that
 * ever read it. `defaultModel`/`defaultEffort` move into the slot of the agent
 * they were *effectively* paired with — the repository's own default agent, or
 * the application's when the repository inherits one.
 *
 * That pairing is the fix for the defect where the same stored value meant two
 * things: `build-pipeline-service-helpers.ts` already applied it only to the
 * repository's own agent, while `native-agent-service-reconciliation.ts`
 * applied it to whatever agent launched. Pinning it to one platform column
 * makes the build pipeline's reading the only reading.
 */
export function migrateRepositoryAgentSettings(
  repository: JsonRecord,
  globalDefaultAgent: AgentPlatform,
): AgentSettingsTier {
  if (isRecord(repository.agentSettings)) return normalizeAgentSettings(repository.agentSettings);

  const platforms: Partial<Record<AgentPlatform, AgentPlatformSettings>> = {};
  mergeInto(platforms, "claude", {
    ...(launchMode(repository.agentStyle) ? { mode: launchMode(repository.agentStyle)! } : {}),
    ...(claudeBackend(repository.claudeNativeBackend)
      ? { claudeNativeBackend: claudeBackend(repository.claudeNativeBackend)! }
      : {}),
  });

  const effectiveAgent = isAgentPlatform(repository.defaultAgent)
    ? repository.defaultAgent
    : globalDefaultAgent;
  // `"default"` was the repository's "no override" sentinel — every consumer
  // skipped it and fell through to the application tier. Carrying it forward
  // would turn that into a real stored value that outranks the app default.
  const notSentinel = (value: unknown) => {
    const text = trimmed(value);
    return text && text !== "default" ? text : undefined;
  };
  mergeInto(platforms, effectiveAgent, {
    ...(notSentinel(repository.defaultModel)
      ? { model: notSentinel(repository.defaultModel)! }
      : {}),
    ...(notSentinel(repository.defaultEffort)
      ? { reasoningEffort: notSentinel(repository.defaultEffort)! }
      : {}),
  });

  return normalizeAgentSettings({
    ...(isAgentPlatform(repository.defaultAgent) ? { defaultAgent: repository.defaultAgent } : {}),
    ...(repository.actionDefaults ? { actionDefaults: repository.actionDefaults } : {}),
    platforms,
  });
}

/** Environment tier: already per-platform, so this is a straight rename. */
export function migrateEnvironmentAgentSettings(environment: JsonRecord): AgentSettingsTier {
  if (isRecord(environment.agentSettings)) {
    return normalizeAgentSettings(environment.agentSettings);
  }

  const platforms: Partial<Record<AgentPlatform, AgentPlatformSettings>> = {};
  mergeInto(platforms, "claude", {
    ...(launchMode(environment.claudeMode) ? { mode: launchMode(environment.claudeMode)! } : {}),
    ...(claudeBackend(environment.claudeNativeBackend)
      ? { claudeNativeBackend: claudeBackend(environment.claudeNativeBackend)! }
      : {}),
  });
  const codexMode = launchMode(environment.codexMode);
  if (codexMode) mergeInto(platforms, "codex", { mode: codexMode });

  const opencodeMode = launchMode(environment.opencodeMode);
  if (opencodeMode) {
    for (const platform of OPENCODE_MODE_FOLLOWERS) {
      mergeInto(platforms, platform, { mode: opencodeMode });
    }
  }

  return normalizeAgentSettings({
    ...(isAgentPlatform(environment.defaultAgent)
      ? { defaultAgent: environment.defaultAgent }
      : {}),
    ...(environment.actionDefaults ? { actionDefaults: environment.actionDefaults } : {}),
    platforms,
  });
}

/**
 * The legacy keys this migration consumes.
 *
 * They are deleted on write so a stale value cannot be read back by anything
 * that still remembers the old name, and so the two shapes cannot drift apart
 * while both are on disk.
 */
export const LEGACY_GLOBAL_AGENT_KEYS = Object.freeze([
  "defaultAgent",
  "claudeMode",
  "claudeModel",
  "claudeNativeBackend",
  "claudeNativeFastModeDefault",
  "codexMode",
  "codexModel",
  "codexReasoningEffort",
  "codexNativeFastModeDefault",
  "opencodeMode",
  "opencodeModel",
  "actionDefaults",
] as const);

export const LEGACY_REPOSITORY_AGENT_KEYS = Object.freeze([
  "defaultAgent",
  "agentStyle",
  "claudeNativeBackend",
  "defaultModel",
  "defaultEffort",
] as const);

export const LEGACY_ENVIRONMENT_AGENT_KEYS = Object.freeze([
  "defaultAgent",
  "claudeMode",
  "claudeNativeBackend",
  "codexMode",
  "opencodeMode",
] as const);
