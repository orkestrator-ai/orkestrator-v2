/**
 * The agent settings vocabulary of the `config` domain (plan items 7005 and
 * 7010): the platform and launch-mode literals and `AgentSettingsTier`, the
 * one shape of the application, repository and environment tiers. Its own
 * module because the environment model (`environments/models.ts`) embeds the
 * tier and `config/models.ts` embeds environment parts (port mappings,
 * resource limits), so neither can import the other's module without a cycle.
 *
 * `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` take
 * `DefaultAgent`, the `*Mode` aliases and `ClaudeNativeBackend` from here.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { ActionDefaults } from "../../../action-defaults.js";
import { AGENT_PLATFORMS, type AgentPlatform } from "../../../agent-platforms.js";
import type { AgentPlatformSettings, MultiReviewAgentSettings } from "../../../agent-settings.js";
import type { NativeAgentExecutionPolicyOverride } from "../../../native-agent.js";
import { openRecord, ownedObject } from "../../model-schema.js";

export const AgentPlatformSchema = Schema.Literals(
  AGENT_PLATFORMS as unknown as readonly [AgentPlatform, ...AgentPlatform[]],
);

/** `AgentLaunchMode` (`agent-settings.ts`): a terminal CLI or the native chat. */
export const AgentLaunchModeSchema = Schema.Literals(["terminal", "native"]);
export type AgentLaunchMode = typeof AgentLaunchModeSchema.Type;

/** `ClaudeNativeBackend` (`agent-settings.ts`): the Agent SDK, or the `claude` CLI under tmux. */
export const ClaudeNativeBackendSchema = Schema.Literals(["sdk", "tmux"]);
export type ClaudeNativeBackend = typeof ClaudeNativeBackendSchema.Type;

/**
 * `AgentSettingsTier` (`agent-settings.ts`): one tier's agent configuration,
 * the same shape at the application, repository and environment tiers. Every
 * field is optional ("inherit"). The nested parts are typed objects:
 * `normalizeAgentSettings` reads them leniently, as before.
 */
export const AgentSettingsTierSchema = openRecord({
  defaultAgent: Schema.optional(AgentPlatformSchema),
  actionDefaults: Schema.optional(ownedObject<ActionDefaults>()),
  multiReview: Schema.optional(ownedObject<MultiReviewAgentSettings>()),
  platforms: Schema.optional(ownedObject<Partial<Record<AgentPlatform, AgentPlatformSettings>>>()),
  executionPolicy: Schema.optional(ownedObject<NativeAgentExecutionPolicyOverride>()),
});
export type AgentSettingsTier = typeof AgentSettingsTierSchema.Type;
