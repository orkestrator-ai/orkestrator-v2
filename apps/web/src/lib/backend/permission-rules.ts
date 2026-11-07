import type { AgentInteractionApplyOutcome } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  ExternalPermissionRulesSnapshot,
  NativeAgentPermissionRule,
  PermissionRuleScope,
  PermissionRulesSnapshot,
} from "@orkestrator/protocol/permission-rules";
import { type AccountMachine } from "./agent-accounts";
import { config as configDomain } from "@/lib/node-scope/domains/config";
import {
  commandBackendClient,
  type BackendClient,
  machineBackendClient,
  withArgumentsObject,
} from "./client";

/**
 * Orkestrator's own permission rules (todo 0723). The backend owns and applies
 * them; the UI lists them, removes them, and creates one only from a person's
 * click on an approval card. Rules are per machine: `machine` picks the node
 * Settings is looking at (see `machineInvoke`); a card's own command reaches
 * the machine its session runs on.
 */

export interface PermissionRuleChoiceInput {
  pattern: string;
  scope: PermissionRuleScope;
  anyProvider: boolean;
  expiresInMs?: number;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createPermissionRulesApi(client: BackendClient) {
  // The `config` domain (plan item 7005). The machine-aware functions were sent
  // through `machineInvoke`, which always passes an arguments object; their
  // calls keep that shape.
  const rules = configDomain(client);
  const ownMachineRules = configDomain(withArgumentsObject(client));
  const rulesOn = (machine: AccountMachine | undefined) =>
    machine === undefined
      ? ownMachineRules()
      : configDomain(machineBackendClient(client, machine))();

  function listPermissionRules(
    filter: {
      projectId?: string;
      environmentId?: string;
      agent?: AgentPlatform;
      logicalSessionKey?: string;
    } = {},
    machine?: AccountMachine,
  ): Promise<PermissionRulesSnapshot> {
    return rulesOn(machine).list_permission_rules(filter);
  }

  function deletePermissionRule(
    id: string,
    machine?: AccountMachine,
  ): Promise<{ deleted: boolean }> {
    return rulesOn(machine).delete_permission_rule({ id });
  }

  function deleteProjectPermissionRules(
    projectId: string,
    machine?: AccountMachine,
  ): Promise<{ deleted: number }> {
    return rulesOn(machine).delete_project_permission_rules({ projectId });
  }

  /** "Approve and remember": answers the request once and saves the chosen rule. */
  function approveNativeAgentInteractionAndRemember(
    input: {
      environmentId: string;
      agent: AgentPlatform;
      logicalSessionKey: string;
      interactionId: string;
    } & PermissionRuleChoiceInput,
  ): Promise<{
    outcome: AgentInteractionApplyOutcome;
    rule?: NativeAgentPermissionRule;
    ruleSaveWarning?: string;
  }> {
    return rules().approve_native_agent_interaction_and_remember({ ...input }) as Promise<{
      outcome: AgentInteractionApplyOutcome;
      rule?: NativeAgentPermissionRule;
      ruleSaveWarning?: string;
    }>;
  }

  /** Rules the providers keep in their own files, read-only. */
  function listExternalPermissionRules(
    projectId?: string,
    machine?: AccountMachine,
  ): Promise<ExternalPermissionRulesSnapshot> {
    return rulesOn(machine).list_external_permission_rules(projectId ? { projectId } : {});
  }

  return {
    listPermissionRules,
    deletePermissionRule,
    deleteProjectPermissionRules,
    approveNativeAgentInteractionAndRemember,
    listExternalPermissionRules,
  };
}

export type PermissionRulesApi = ReturnType<typeof createPermissionRulesApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listPermissionRules,
  deletePermissionRule,
  deleteProjectPermissionRules,
  approveNativeAgentInteractionAndRemember,
  listExternalPermissionRules,
} = createPermissionRulesApi(commandBackendClient);
