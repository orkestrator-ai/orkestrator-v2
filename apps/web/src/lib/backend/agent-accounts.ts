import { invoke } from "@/lib/native/backend";
import type { BackendId } from "@orkestrator/protocol/federation";
import { portalInvoke } from "@/lib/portal/portal-transport";
import { portalStore } from "@/lib/portal/portal-store";
import { invokeCommandNodeSetting } from "@/lib/portal/command-node-config";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentSessionAccount,
  MachineAgentAccountsResult,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

/**
 * Additional Claude and Codex logins. The backend owns every decision —
 * account directories, the CLI sign-in, which account launches use — and
 * never returns a credential.
 *
 * Every machine keeps its own accounts. `machine` names the node to ask,
 * through the command node. `null` selects the command node; `undefined`
 * selects this view's backend (the leaf, inside a leaf's workspace).
 */
export type AccountMachine = string | null | undefined;

/** `null` selects the command node; an omitted target selects this view's backend. */
export function machineInvoke<T>(
  machine: AccountMachine,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (machine === null) return portalInvoke<T>(command, args);
  return machine === undefined
    ? invoke<T>(command, args)
    : portalStore.invokeOnNode<T>(machine as BackendId, command, args);
}

export async function listAgentAccounts(machine?: AccountMachine): Promise<AgentAccountsSnapshot> {
  return machineInvoke<AgentAccountsSnapshot>(machine, "list_agent_accounts");
}

export async function setActiveAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
  machine?: AccountMachine,
): Promise<AgentAccountsSnapshot> {
  return machineInvoke<AgentAccountsSnapshot>(machine, "set_active_agent_account", {
    platform,
    accountId,
  });
}

export async function renameAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
  label: string,
  machine?: AccountMachine,
): Promise<AgentAccountsSnapshot> {
  return machineInvoke<AgentAccountsSnapshot>(machine, "rename_agent_account", {
    platform,
    accountId,
    label,
  });
}

export async function removeAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
  machine?: AccountMachine,
): Promise<AgentAccountsSnapshot> {
  return machineInvoke<AgentAccountsSnapshot>(machine, "remove_agent_account", {
    platform,
    accountId,
  });
}

export async function getAgentAccountUsage(
  platform: AgentAccountPlatform,
  accountId: string,
  options: { force?: boolean } = {},
  machine?: AccountMachine,
): Promise<PlanUsageSnapshot> {
  return machineInvoke<PlanUsageSnapshot>(machine, "get_agent_account_usage", {
    platform,
    accountId,
    ...(options.force ? { force: true } : {}),
  });
}

/**
 * Start a sign-in. By default it adds an account; with `reauthenticate` it
 * signs the platform's active account in again (Claude only). The CLI runs on
 * the machine named; its link opens in this client's browser.
 */
export async function startAgentAccountLogin(
  platform: AgentAccountPlatform,
  options: { reauthenticate?: boolean } = {},
  machine?: AccountMachine,
): Promise<AgentAccountLoginProgress> {
  return machineInvoke<AgentAccountLoginProgress>(machine, "start_agent_account_login", {
    platform,
    ...(options.reauthenticate ? { reauthenticate: true } : {}),
  });
}

export async function getAgentAccountLogin(
  machine?: AccountMachine,
): Promise<AgentAccountLoginProgress> {
  return machineInvoke<AgentAccountLoginProgress>(machine, "get_agent_account_login");
}

export async function submitAgentAccountLoginCode(
  code: string,
  machine?: AccountMachine,
): Promise<AgentAccountLoginProgress> {
  return machineInvoke<AgentAccountLoginProgress>(machine, "submit_agent_account_login_code", {
    code,
  });
}

export async function cancelAgentAccountLogin(
  operationId?: string,
  machine?: AccountMachine,
): Promise<AgentAccountLoginProgress> {
  return machineInvoke<AgentAccountLoginProgress>(
    machine,
    "cancel_agent_account_login",
    operationId ? { operationId } : {},
  );
}

/** Which of its machine's accounts one session's bridge uses. Asked of the session's own backend. */
export async function getNativeAgentSessionAccount(
  environmentId: string,
  agent: string,
): Promise<AgentSessionAccount | null> {
  return invoke<AgentSessionAccount | null>("get_native_agent_session_account", {
    environmentId,
    agent,
  });
}

/** Every machine's accounts, collected by the command node. */
export async function listMachineAgentAccounts(): Promise<MachineAgentAccountsResult> {
  return invokeCommandNodeSetting<MachineAgentAccountsResult>("list_machine_agent_accounts");
}
