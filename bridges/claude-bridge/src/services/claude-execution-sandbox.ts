import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import {
  coordinatorCommandSandboxFromEnv,
  type CoordinatorCommandSandbox,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeWorkspaceCwd } from "./claude-query-config.js";
import { claudeReadOnlySandbox, isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";

/**
 * The paths a read-only turn's commands may not write: the checkout as named
 * and as resolved, since a symlinked path and its target are one directory.
 */
export function claudeReadOnlyWorkspaces(cwd: string): string[] {
  let resolved: string | undefined;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = undefined;
  }
  return [...new Set([cwd, ...(resolved ? [resolved] : [])])];
}

/** The sandbox block passed to the SDK for a real turn. */
export function claudeExecutionSandbox(
  policy: NativeAgentExecutionPolicy | undefined,
  asksForApproval: boolean,
  readOnly: { cwd?: string; commandSandbox?: CoordinatorCommandSandbox } = {},
): Options["sandbox"] {
  if (policy && isCoordinatorReadOnlyPolicy(policy)) {
    return claudeReadOnlySandbox(policy, {
      workspaces: claudeReadOnlyWorkspaces(readOnly.cwd ?? claudeWorkspaceCwd()),
      commandSandbox: readOnly.commandSandbox ?? coordinatorCommandSandboxFromEnv(process.env),
    });
  }
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
