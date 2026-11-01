import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import { DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS } from "@orkestrator/protocol/claude-background-commands";
import type {
  CoordinatorResearchMcpServer,
  CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import type { MultiReviewEngine } from "@orkestrator/protocol/multi-review";
import {
  isShippedReviewLensPresetList,
  type ReviewLensPreset,
} from "@orkestrator/protocol/review-lens";
import {
  DEFAULT_SESSION_TITLE_GENERATION_POLICY,
  type SessionTitleGenerationPolicy,
} from "@orkestrator/protocol/session-title-generation";
import { deepEqualJson } from "@/lib/chat/message-identity";
import { DEFAULT_REVIEW_INSTRUCTION } from "@/prompts";
import type { GlobalConfig, PreferredEditor, TerminalAppearance } from "@/types";

/**
 * Every non-secret setting the shared form owns, normalized to the shape that is
 * actually persisted. Comparing a normalized local snapshot against the stored
 * config is what stops a save that changes nothing from re-arming the debounce.
 */
export interface CoreFieldsSnapshot {
  containerResources: { cpuCores: number; memoryGb: number };
  envFilePatterns: string[];
  allowedDomains: string[];
  useHostGitHubCredentials: boolean;
  sshAgentSocketPath: string;
  autoMergeRequireChecks: boolean;
  defaultProjectsDirectory: string;
  useHostClaudeCredentials: boolean;
  preferredEditor: PreferredEditor;
  enabledAgentPlatforms: AgentPlatform[];
  coordinatorProviderTiers: "enforced" | "provider-configured" | "advisory";
  coordinatorWebResearch: CoordinatorWebResearch;
  coordinatorResearchMcpServers: CoordinatorResearchMcpServer[];
  agentSettings: AgentSettingsTier;
  openCodeModelProviders: string[];
  codexMaxConcurrentThreads: number;
  claudeBackgroundCommandLimitHours: number;
  sessionTitleGeneration: SessionTitleGenerationPolicy;
  terminalAppearance: TerminalAppearance;
  terminalScrollback: number;
  terminalHistoryEnabled: boolean;
  terminalHistoryRetentionMb: number;
  terminalHistoryGlobalRetentionMb: number;
  terminalHistoryRetentionDays: number;
  experimentalCodexRawEventLogging: boolean;
  experimentalScheduling: boolean;
  experimentalGraphs: boolean;
  debugLogging: boolean;
  debugLogRetentionDays: number;
  webClientEnabled: boolean;
  reviewInstruction: string;
  /** Resolved: the shipped five when none are stored. */
  reviewLensPresets: ReviewLensPreset[];
  /** Which runtime runs new Multi Reviews (item 301); absent is bespoke. */
  multiReviewEngine: MultiReviewEngine;
}

/** Fields stored exactly as the form snapshot holds them. */
const STORED_AS_IS = [
  "containerResources",
  "envFilePatterns",
  "allowedDomains",
  "useHostGitHubCredentials",
  "autoMergeRequireChecks",
  "useHostClaudeCredentials",
  "preferredEditor",
  "enabledAgentPlatforms",
  "coordinatorProviderTiers",
  "coordinatorWebResearch",
  "coordinatorResearchMcpServers",
  "agentSettings",
  "openCodeModelProviders",
  "codexMaxConcurrentThreads",
  "terminalAppearance",
  "terminalScrollback",
  "terminalHistoryEnabled",
  "terminalHistoryRetentionMb",
  "terminalHistoryGlobalRetentionMb",
  "terminalHistoryRetentionDays",
  "experimentalCodexRawEventLogging",
  "experimentalScheduling",
  "experimentalGraphs",
  "debugLogging",
  "debugLogRetentionDays",
  "webClientEnabled",
  "multiReviewEngine",
] as const satisfies readonly (keyof CoreFieldsSnapshot & keyof GlobalConfig)[];

/**
 * Fields that are absent from storage when the form holds their default, so a
 * later change to the shipped default reaches users who never changed them.
 */
const ABSENT_WHEN: {
  [K in keyof CoreFieldsSnapshot & keyof GlobalConfig]?: (value: CoreFieldsSnapshot[K]) => boolean;
} = {
  sshAgentSocketPath: (value) => value === "",
  defaultProjectsDirectory: (value) => value === "",
  claudeBackgroundCommandLimitHours: (value) =>
    value === DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS,
  sessionTitleGeneration: (value) => value === DEFAULT_SESSION_TITLE_GENERATION_POLICY,
  reviewInstruction: (value) => value === DEFAULT_REVIEW_INSTRUCTION,
  reviewLensPresets: (value) => isShippedReviewLensPresetList(value),
};

export interface GlobalConfigPatch {
  patch: Partial<GlobalConfig>;
  unset: (keyof GlobalConfig)[];
}

/**
 * The settings the user changed relative to the values the form loaded.
 *
 * Only these travel to the backend, which merges them onto its current copy,
 * so a field this window never touched cannot overwrite another window's or
 * machine's newer value. Comparing normalized snapshots means a field that
 * merely round-trips through normalisation is not reported as changed.
 */
export function globalConfigPatchFromCoreFields(
  local: CoreFieldsSnapshot,
  baseline: CoreFieldsSnapshot,
  stored?: GlobalConfig,
): GlobalConfigPatch {
  const patch: Record<string, unknown> = {};
  const unset: (keyof GlobalConfig)[] = [];
  for (const key of STORED_AS_IS) {
    if (!deepEqualJson(local[key], baseline[key])) patch[key] = local[key];
  }
  for (const [key, isAbsent] of Object.entries(ABSENT_WHEN) as Array<
    [keyof CoreFieldsSnapshot & keyof GlobalConfig, (value: unknown) => boolean]
  >) {
    if (deepEqualJson(local[key], baseline[key])) {
      if (stored && Object.hasOwn(stored, key) && isAbsent(local[key])) unset.push(key);
      continue;
    }
    if (isAbsent(local[key])) unset.push(key);
    else patch[key] = local[key];
  }
  return { patch: patch as Partial<GlobalConfig>, unset };
}
