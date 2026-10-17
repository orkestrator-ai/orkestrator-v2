import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeReadOnlySandbox, isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";

/** The sandbox block passed to the SDK for a real turn. */
export function claudeExecutionSandbox(
  policy: NativeAgentExecutionPolicy | undefined,
  asksForApproval: boolean,
): Options["sandbox"] {
  if (policy && isCoordinatorReadOnlyPolicy(policy)) return claudeReadOnlySandbox(policy);
  if (policy?.sandbox !== "provider") return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: policy.approvals === "auto-approve" && !asksForApproval,
    // Without a human, an escape request would be granted unseen.
    allowUnsandboxedCommands: asksForApproval,
    network: {
      allowLocalBinding: policy.networkAccess === "full",
      // Otherwise an unlisted domain becomes an auto-approved permission request.
      strictAllowlist: policy.networkAccess === "restricted",
    },
  };
}
