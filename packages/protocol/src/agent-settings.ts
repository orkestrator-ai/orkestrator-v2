/**
 * The one agent configuration shape, resolved identically at three tiers.
 *
 * Application, repository and environment each store the *same* structure, and
 * every field is optional at every tier: present means "this tier decides",
 * absent means "ask the tier above". Nothing here is a sentinel — an explicit
 * `undefined` and a missing key are the same answer, because the settings UI
 * has to be able to express "inherit" by simply not writing a value.
 *
 * This module exists for the same reason {@link ./startup-launch.ts} does, and
 * that module now delegates to it. Agent, mode and Claude backend already had a
 * single resolver; model and reasoning level did not, and the four places that
 * resolved them by hand disagreed. `native-agent-service-reconciliation.ts`
 * applied a repository's model to *whatever* agent launched, while
 * `build-pipeline-service-helpers.ts` applied it only when the agent was the
 * repository's own default. The same stored value meant two different things
 * depending on which code path reached it first, which is invisible until a
 * user pins a model for one platform and launches another. The `owns` rule
 * below is that second reading, promoted here so both sides share it.
 */
import { AGENT_PLATFORMS, isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import {
  ACTION_DEFAULT_KEYS,
  normalizeActionDefaults,
  type ActionDefaults,
} from "./action-defaults.js";

export type AgentLaunchMode = "terminal" | "native";
export type ClaudeNativeBackend = "sdk" | "tmux";

/** One platform's settings at one tier. */
export interface AgentPlatformSettings {
  mode?: AgentLaunchMode;
  /** A model id from this platform's own catalogue. */
  model?: string;
  reasoningEffort?: string;
  /**
   * Fast vs normal speed for platforms that expose a toggle.
   *
   * Absent means inherit / provider default. `false` is an explicit Normal
   * choice, not "unset" — the same three-state the model picker uses.
   */
  fastMode?: boolean;
  /** Claude only; meaningful when the resolved mode is `native`. */
  claudeNativeBackend?: ClaudeNativeBackend;
}

/**
 * One tier's whole agent configuration.
 *
 * There is deliberately no tier-level "default model" beside `defaultAgent`.
 * The Defaults page's picker binds to `defaultAgent` plus *that agent's own*
 * `platforms[agent]` block, so the model shown there and the model on that
 * platform's tab are one value edited from two places rather than two values
 * with a precedence rule between them. A model id is only meaningful inside its
 * own platform's catalogue, so there is nowhere else it could correctly live —
 * and switching agent on the Defaults page therefore reveals that agent's model
 * instead of carrying the previous agent's id across, which is what the old
 * repository-level `defaultModel` did wrong.
 */
export interface AgentSettingsTier {
  defaultAgent?: AgentPlatform;
  actionDefaults?: ActionDefaults;
  platforms?: Partial<Record<AgentPlatform, AgentPlatformSettings>>;
}

/** Lowest priority first is *not* the order here: environment wins. */
export interface AgentSettingsTiers {
  environment?: AgentSettingsTier | null;
  repository?: AgentSettingsTier | null;
  global?: AgentSettingsTier | null;
}

export interface ResolvedAgentPlatformSettings {
  mode: AgentLaunchMode;
  model?: string;
  reasoningEffort?: string;
  /** Absent when no tier named a speed; `false` is an explicit Normal choice. */
  fastMode?: boolean;
  /** Only meaningful when `platform` is `claude` and `mode` is `native`. */
  claudeNativeBackend: ClaudeNativeBackend;
}

export const DEFAULT_AGENT_PLATFORM: AgentPlatform = "claude";
export const DEFAULT_CLAUDE_NATIVE_BACKEND: ClaudeNativeBackend = "sdk";

/**
 * What each platform does when no tier has an opinion.
 *
 * Cursor is SDK-only and therefore always native. Claude also ships native;
 * the remaining CLI-backed platforms default to terminal mode.
 */
export const SHIPPED_PLATFORM_MODES: Readonly<Record<AgentPlatform, AgentLaunchMode>> =
  Object.freeze({
    claude: "native",
    codex: "terminal",
    cursor: "native",
    grok: "terminal",
    opencode: "terminal",
    pi: "terminal",
  });

function tierPlatform(
  tier: AgentSettingsTier | null | undefined,
  platform: AgentPlatform,
): AgentPlatformSettings | undefined {
  return tier?.platforms?.[platform];
}

/** The agent used when nothing narrower named one. */
export function resolveDefaultAgent(tiers: AgentSettingsTiers): AgentPlatform {
  return (
    tiers.environment?.defaultAgent ??
    tiers.repository?.defaultAgent ??
    tiers.global?.defaultAgent ??
    DEFAULT_AGENT_PLATFORM
  );
}

/**
 * One platform's effective settings across the three tiers.
 *
 * Every field resolves independently, so a repository that pins only a model
 * still inherits the application's mode rather than dragging the whole block
 * down with it. That is the behaviour the settings UI promises when it shows
 * "Inherit" on one control and a concrete value on its neighbour.
 */
export function resolveAgentPlatformSettings(
  tiers: AgentSettingsTiers,
  platform: AgentPlatform,
): ResolvedAgentPlatformSettings {
  const environment = tierPlatform(tiers.environment, platform);
  const repository = tierPlatform(tiers.repository, platform);
  const global = tierPlatform(tiers.global, platform);

  const mode =
    platform === "cursor"
      ? "native"
      : (environment?.mode ?? repository?.mode ?? global?.mode ?? SHIPPED_PLATFORM_MODES[platform]);

  // A model id belongs to one platform's catalogue, so it only ever travels
  // down its own column. This is the rule the old repository `defaultModel`
  // broke: `native-agent-service-reconciliation.ts` handed it to whatever agent
  // launched, so a Claude model id could reach a Codex run.
  const model = environment?.model ?? repository?.model ?? global?.model;

  const reasoningEffort =
    environment?.reasoningEffort ?? repository?.reasoningEffort ?? global?.reasoningEffort;

  // `false` is a stored Normal choice, so this cannot use truthiness.
  const fastMode = environment?.fastMode ?? repository?.fastMode ?? global?.fastMode;

  const claudeNativeBackend =
    environment?.claudeNativeBackend ??
    repository?.claudeNativeBackend ??
    global?.claudeNativeBackend ??
    DEFAULT_CLAUDE_NATIVE_BACKEND;

  return {
    mode,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    claudeNativeBackend,
  };
}

/** Action defaults resolved independently, so an unset action keeps inheriting. */
export function resolveActionDefaults(tiers: AgentSettingsTiers): ActionDefaults {
  const resolved: ActionDefaults = {};
  for (const key of ACTION_DEFAULT_KEYS) {
    const entry =
      tiers.environment?.actionDefaults?.[key] ??
      tiers.repository?.actionDefaults?.[key] ??
      tiers.global?.actionDefaults?.[key];
    if (entry) resolved[key] = entry;
  }
  return resolved;
}

function normalizePlatformSettings(
  value: unknown,
  platform: AgentPlatform,
): AgentPlatformSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mode =
    platform !== "cursor" && (record.mode === "terminal" || record.mode === "native")
      ? record.mode
      : undefined;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const reasoningEffort =
    typeof record.reasoningEffort === "string" ? record.reasoningEffort.trim() : "";
  const fastMode = typeof record.fastMode === "boolean" ? record.fastMode : undefined;
  const claudeNativeBackend =
    record.claudeNativeBackend === "sdk" || record.claudeNativeBackend === "tmux"
      ? record.claudeNativeBackend
      : undefined;
  const normalized: AgentPlatformSettings = {
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(claudeNativeBackend ? { claudeNativeBackend } : {}),
  };
  // An all-empty block is "inherit everything", which is what absence already
  // means. Dropping it keeps persisted config free of blocks the UI wrote on
  // its way back to inheriting.
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Keep only well-formed values. Every settings dialog writes this object
 * wholesale, so an unknown platform key or a half-filled block must not reach
 * persisted config.
 */
export function normalizeAgentSettings(value: unknown): AgentSettingsTier {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const defaultAgent = isAgentPlatform(record.defaultAgent) ? record.defaultAgent : undefined;
  const actionDefaults = normalizeActionDefaults(record.actionDefaults);

  const platforms: Partial<Record<AgentPlatform, AgentPlatformSettings>> = {};
  const rawPlatforms =
    record.platforms && typeof record.platforms === "object" && !Array.isArray(record.platforms)
      ? (record.platforms as Record<string, unknown>)
      : {};
  for (const platform of AGENT_PLATFORMS) {
    const settings = normalizePlatformSettings(rawPlatforms[platform], platform);
    if (settings) platforms[platform] = settings;
  }

  return {
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(Object.keys(actionDefaults).length > 0 ? { actionDefaults } : {}),
    ...(Object.keys(platforms).length > 0 ? { platforms } : {}),
  };
}

/** True when this tier expresses no opinion at all, i.e. inherits everything. */
export function isEmptyAgentSettings(tier: AgentSettingsTier | null | undefined): boolean {
  if (!tier) return true;
  return (
    !tier.defaultAgent &&
    Object.keys(tier.actionDefaults ?? {}).length === 0 &&
    Object.keys(tier.platforms ?? {}).length === 0
  );
}
