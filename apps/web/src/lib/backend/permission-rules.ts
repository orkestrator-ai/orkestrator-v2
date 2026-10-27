import type { AgentInteractionApplyOutcome } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  ExternalPermissionRulesSnapshot,
  NativeAgentPermissionRule,
  PermissionRuleScope,
  PermissionRulesSnapshot,
} from "@orkestrator/protocol/permission-rules";
import { invoke } from "@/lib/native/backend";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * Orkestrator's own permission rules (todo 0723). The backend owns and applies
 * them; the UI lists them, removes them, and creates one only from a person's
 * click on an approval card. Rules are per machine: `machine` picks the node
 * Settings is looking at (see `machineInvoke`); a card's own command reaches
 * the machine its session runs on.
 */

export function listPermissionRules(
  filter: {
    projectId?: string;
    environmentId?: string;
    agent?: AgentPlatform;
    logicalSessionKey?: string;
  } = {},
  machine?: AccountMachine,
): Promise<PermissionRulesSnapshot> {
  return machineInvoke(machine, "list_permission_rules", filter);
}

export function deletePermissionRule(
  id: string,
  machine?: AccountMachine,
): Promise<{ deleted: boolean }> {
  return machineInvoke(machine, "delete_permission_rule", { id });
}

export function deleteProjectPermissionRules(
  projectId: string,
  machine?: AccountMachine,
): Promise<{ deleted: number }> {
  return machineInvoke(machine, "delete_project_permission_rules", { projectId });
}

export interface PermissionRuleChoiceInput {
  pattern: string;
  scope: PermissionRuleScope;
  anyProvider: boolean;
  expiresInMs?: number;
}

/** "Approve and remember": answers the request once and saves the chosen rule. */
export function approveNativeAgentInteractionAndRemember(
  input: {
    environmentId: string;
    agent: AgentPlatform;
    logicalSessionKey: string;
    interactionId: string;
  } & PermissionRuleChoiceInput,
): Promise<{ outcome: AgentInteractionApplyOutcome; rule?: NativeAgentPermissionRule }> {
  return invoke("approve_native_agent_interaction_and_remember", { ...input });
}

/** Rules the providers keep in their own files, read-only. */
export function listExternalPermissionRules(
  projectId?: string,
  machine?: AccountMachine,
): Promise<ExternalPermissionRulesSnapshot> {
  return machineInvoke(machine, "list_external_permission_rules", projectId ? { projectId } : {});
}
