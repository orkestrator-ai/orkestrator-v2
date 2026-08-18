/**
 * Plumbing for reading agent settings in the renderer. No rules live here.
 *
 * The tiering rule — environment over repository over application, field by
 * field — is defined once in `@orkestrator/protocol/agent-settings` and is
 * imported rather than reimplemented, for the same reason
 * `resolveStartupLaunch` is shared: the backend acts on the same answer, and a
 * second copy on this side would drift silently. Everything below is assembly
 * of the three stored tiers plus display helpers; nothing here decides
 * anything, and no launch, dispatch or persistence choice is made in the
 * renderer.
 */
import {
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentPlatformSettings,
  type AgentSettingsTier,
  type AgentSettingsTiers,
  type ResolvedAgentPlatformSettings,
} from "@orkestrator/protocol/agent-settings";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AppConfig, Environment } from "@/types";

/** Which tier an inherited value actually came from, for the "Inherit (…)" label. */
export type AgentSettingsTierName = "environment" | "repository" | "global" | "default";

/**
 * Assemble the three stored tiers for one environment.
 *
 * `environment` is optional because repository and application settings are
 * edited with no environment in scope.
 */
export function agentSettingsTiers(
  config: Pick<AppConfig, "global" | "repositories">,
  projectId: string | undefined,
  environment?: Pick<Environment, "agentSettings"> | null,
): AgentSettingsTiers {
  return {
    environment: environment?.agentSettings,
    repository: projectId ? config.repositories[projectId]?.agentSettings : undefined,
    global: config.global.agentSettings,
  };
}

/** The effective settings for one platform, resolved across the tiers. */
export function resolvedPlatformSettings(
  config: Pick<AppConfig, "global" | "repositories">,
  projectId: string | undefined,
  environment: Pick<Environment, "agentSettings"> | null | undefined,
  platform: AgentPlatform,
): ResolvedAgentPlatformSettings {
  return resolveAgentPlatformSettings(agentSettingsTiers(config, projectId, environment), platform);
}

/** The effective default agent, resolved across the tiers. */
export function resolvedDefaultAgent(
  config: Pick<AppConfig, "global" | "repositories">,
  projectId?: string,
  environment?: Pick<Environment, "agentSettings"> | null,
): AgentPlatform {
  return resolveDefaultAgent(agentSettingsTiers(config, projectId, environment));
}

/**
 * Which tier supplies a platform field, given the tiers *above* the one being
 * edited.
 *
 * The settings panes show "Inherit (Native — from repository)" rather than a
 * bare "Inherit", so the user can tell a deliberate parent choice from a
 * shipped default before they override it.
 */
export function inheritedFrom(
  tiers: AgentSettingsTiers,
  platform: AgentPlatform,
  field: keyof AgentPlatformSettings,
): AgentSettingsTierName {
  if (tiers.environment?.platforms?.[platform]?.[field] !== undefined) return "environment";
  if (tiers.repository?.platforms?.[platform]?.[field] !== undefined) return "repository";
  if (tiers.global?.platforms?.[platform]?.[field] !== undefined) return "global";
  return "default";
}

export const TIER_LABELS: Readonly<Record<AgentSettingsTierName, string>> = Object.freeze({
  environment: "this environment",
  repository: "the repository",
  global: "app settings",
  default: "the shipped default",
});

/** Write one platform field, or clear it when `value` is undefined (inherit). */
export function withPlatformField<K extends keyof AgentPlatformSettings>(
  tier: AgentSettingsTier | undefined,
  platform: AgentPlatform,
  field: K,
  value: AgentPlatformSettings[K] | undefined,
): AgentSettingsTier {
  const platforms = { ...tier?.platforms };
  const block = { ...platforms[platform] };
  if (value === undefined) delete block[field];
  else block[field] = value;
  // An empty block means "inherit everything", which absence already says.
  if (Object.keys(block).length === 0) delete platforms[platform];
  else platforms[platform] = block;
  return { ...tier, platforms };
}
