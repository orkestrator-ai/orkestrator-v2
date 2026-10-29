import { nativeAgentWithholdsGitHubCredential } from "@orkestrator/protocol/native-agent";
import type { EngineTurnConfig } from "./engine/types.js";
import { codexNetworkDeniedConfig } from "./codex-config.js";

/** Absolute thread settings, independent of subsequent durable policy changes. */
export function promptThreadConfig(config: EngineTurnConfig): string {
  return JSON.stringify([
    ...(config.agentMcp
      ? [
          config.approvalPolicy ?? "never",
          config.approvalsReviewer ?? "user",
          config.policy?.approvals,
          config.sandbox,
          config.permissionProfile,
          config.workflowResultTool,
        ]
      : []),
    config.policy?.projectResources,
    config.cwd,
    codexNetworkDeniedConfig(config.policy),
    // The command environment (item 209): a loaded thread keeps the one it
    // started with, so a change needs a reload.
    ...(nativeAgentWithholdsGitHubCredential(config.policy) ? ["withhold-github"] : []),
  ]);
}
