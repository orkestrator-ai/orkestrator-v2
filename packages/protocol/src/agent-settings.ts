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
  type AgentActionDefault,
  type ActionDefaults,
} from "./action-defaults.js";
import { REVIEW_FANOUT_MAX_REVIEWERS, REVIEW_FANOUT_MIN_REVIEWERS } from "./review-fanout.js";
import type { NativeAgentExecutionPolicyOverride } from "./native-agent.js";

export type AgentLaunchMode = "terminal" | "native";
export type ClaudeNativeBackend = "sdk" | "tmux";
export type ClaudeThinkingMode = "adaptive" | "budget-8192" | "budget-16384" | "disabled";

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
  /** Claude Agent SDK thinking configuration for new native sessions. */
  claudeThinkingMode?: ClaudeThinkingMode;
  /** Whether new Claude Agent SDK sessions opt into the 1M-context beta. */
  claudeContext1m?: boolean;
}

export const DEFAULT_MULTI_REVIEW_REVIEWER_COUNT = 2;

/** App-wide Multi Review choices beyond the two action defaults shown on Defaults. */
export interface MultiReviewAgentSettings {
  /** Number of reviewer sessions a plain Multi Review click starts. */
  reviewerCount?: number;
  /** Reviewer 3 onward. Null means use the first reviewer's resolved default. */
  additionalReviewers?: Array<AgentActionDefault | null>;
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
  multiReview?: MultiReviewAgentSettings;
  platforms?: Partial<Record<AgentPlatform, AgentPlatformSettings>>;
  /** Environment-origin execution axes. Every absent field inherits the backend default. */
  executionPolicy?: NativeAgentExecutionPolicyOverride;
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
  /** Claude Agent SDK thinking configuration; absent means its adaptive default. */
  claudeThinkingMode?: ClaudeThinkingMode;
  /** Claude Agent SDK 1M-context beta; absent means its disabled default. */
  claudeContext1m?: boolean;
}

export const DEFAULT_AGENT_PLATFORM: AgentPlatform = "claude";
export const DEFAULT_CLAUDE_NATIVE_BACKEND: ClaudeNativeBackend = "sdk";
export const DEFAULT_CLAUDE_THINKING_MODE: ClaudeThinkingMode = "adaptive";
export const DEFAULT_CLAUDE_CONTEXT_1M = false;

/** Translate persisted Claude defaults to the bridge's generic parameter ids. */
export function claudeNativeParameterValues(
  settings: Pick<ResolvedAgentPlatformSettings, "claudeThinkingMode" | "claudeContext1m">,
): Record<string, string | boolean> {
  return {
    thinking: settings.claudeThinkingMode ?? DEFAULT_CLAUDE_THINKING_MODE,
    context1m: settings.claudeContext1m ?? DEFAULT_CLAUDE_CONTEXT_1M,
  };
}

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

  const claudeThinkingMode =
    environment?.claudeThinkingMode ?? repository?.claudeThinkingMode ?? global?.claudeThinkingMode;
  const claudeContext1m =
    environment?.claudeContext1m ?? repository?.claudeContext1m ?? global?.claudeContext1m;

  return {
    mode,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    claudeNativeBackend,
    ...(claudeThinkingMode ? { claudeThinkingMode } : {}),
    ...(claudeContext1m !== undefined ? { claudeContext1m } : {}),
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
  const claudeThinkingMode =
    platform === "claude" &&
    (record.claudeThinkingMode === "adaptive" ||
      record.claudeThinkingMode === "budget-8192" ||
      record.claudeThinkingMode === "budget-16384" ||
      record.claudeThinkingMode === "disabled")
      ? record.claudeThinkingMode
      : undefined;
  const claudeContext1m =
    platform === "claude" && typeof record.claudeContext1m === "boolean"
      ? record.claudeContext1m
      : undefined;
  const normalized: AgentPlatformSettings = {
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(claudeNativeBackend ? { claudeNativeBackend } : {}),
    ...(claudeThinkingMode ? { claudeThinkingMode } : {}),
    ...(claudeContext1m !== undefined ? { claudeContext1m } : {}),
  };
  // An all-empty block is "inherit everything", which is what absence already
  // means. Dropping it keeps persisted config free of blocks the UI wrote on
  // its way back to inheriting.
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMultiReviewSettings(value: unknown): MultiReviewAgentSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawAdditional = Array.isArray(record.additionalReviewers) ? record.additionalReviewers : [];
  const storedCount = record.reviewerCount;
  const reviewerCount =
    typeof storedCount === "number" &&
    Number.isInteger(storedCount) &&
    storedCount >= REVIEW_FANOUT_MIN_REVIEWERS &&
    storedCount <= REVIEW_FANOUT_MAX_REVIEWERS
      ? storedCount
      : DEFAULT_MULTI_REVIEW_REVIEWER_COUNT;
  const additionalCount = Math.max(0, reviewerCount - DEFAULT_MULTI_REVIEW_REVIEWER_COUNT);
  const additionalReviewers = rawAdditional.slice(0, additionalCount).map((entry) => {
    if (entry === null) return null;
    return normalizeActionDefaults({ review: entry }).review ?? null;
  });
  while (additionalReviewers.at(-1) === null) additionalReviewers.pop();

  const normalized: MultiReviewAgentSettings = {
    ...(reviewerCount !== DEFAULT_MULTI_REVIEW_REVIEWER_COUNT ? { reviewerCount } : {}),
    ...(additionalReviewers.length > 0 ? { additionalReviewers } : {}),
  };
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
  const multiReview = normalizeMultiReviewSettings(record.multiReview);
  const executionPolicy = normalizeExecutionPolicyOverride(record.executionPolicy);

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
    ...(multiReview ? { multiReview } : {}),
    ...(Object.keys(platforms).length > 0 ? { platforms } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
  };
}

function normalizeExecutionPolicyOverride(
  value: unknown,
): NativeAgentExecutionPolicyOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sandbox =
    record.sandbox === "provider" || record.sandbox === "container" || record.sandbox === "none"
      ? record.sandbox
      : undefined;
  const approvals =
    record.approvals === "ask" || record.approvals === "auto-approve" || record.approvals === "deny"
      ? record.approvals
      : undefined;
  const networkAccess =
    record.networkAccess === "restricted" || record.networkAccess === "full"
      ? record.networkAccess
      : undefined;
  const stringList = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    const values = candidate
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 128);
    return values.length > 0 ? [...new Set(values)] : undefined;
  };
  const rawTools =
    record.toolPolicy && typeof record.toolPolicy === "object" && !Array.isArray(record.toolPolicy)
      ? (record.toolPolicy as Record<string, unknown>)
      : undefined;
  const allow = stringList(rawTools?.allow);
  const deny = stringList(rawTools?.deny);
  const normalized: NativeAgentExecutionPolicyOverride = {
    ...(sandbox ? { sandbox } : {}),
    ...(approvals ? { approvals } : {}),
    ...(typeof record.projectResources === "boolean"
      ? { projectResources: record.projectResources }
      : {}),
    ...(allow || deny
      ? { toolPolicy: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } }
      : {}),
    ...(networkAccess ? { networkAccess } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** True when this tier expresses no opinion at all, i.e. inherits everything. */
export function isEmptyAgentSettings(tier: AgentSettingsTier | null | undefined): boolean {
  if (!tier) return true;
  return (
    !tier.defaultAgent &&
    Object.keys(tier.actionDefaults ?? {}).length === 0 &&
    !tier.multiReview &&
    !tier.executionPolicy &&
    Object.keys(tier.platforms ?? {}).length === 0
  );
}
