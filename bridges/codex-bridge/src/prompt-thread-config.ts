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
  ]);
}
