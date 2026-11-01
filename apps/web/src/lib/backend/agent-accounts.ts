import { invoke } from "@/lib/native/backend";
import { portalInvoke } from "@/lib/portal/portal-transport";
import type { BackendId } from "@orkestrator/protocol/federation";
import { portalStore } from "@/lib/portal/portal-store";
import { invokeCommandNodeSetting } from "@/lib/portal/command-node-config";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentSessionAccount,
  AgentSignInTerminal,
  HostAgentSignIns,
  HostSignInPlatform,
  MachineAgentAccountsResult,
  PreferredAgentIdentities,
} from "@orkestrator/protocol/agent-accounts";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentAuthStatus } from "@orkestrator/protocol/native-agent";
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

/** Ask `machine` through the command node, or this view's own backend without one. */
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

/**
 * A platform's sign-in state for the settings pane, read on the host without a
 * session: the active account for Claude and Codex, the stored credential or
 * provider logins for the rest.
 */
export async function getAgentSignInStatus(
  platform: AgentPlatform,
  machine?: AccountMachine,
): Promise<NativeAgentAuthStatus> {
  return machineInvoke<NativeAgentAuthStatus>(machine, "get_agent_sign_in_status", { platform });
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

/**
 * The main automatic-switching tick, and what `machine` shows afterwards.
 *
 * The tick belongs to the command node, which hands it to its machines. Ticking it
 * is also what ends a pin, and a pin belongs to the machine it was set on, so only
 * `machine`'s ends. A machine that predates this never reports a pin to end.
 */
export async function setAgentAccountAutoSwitchEnabled(
  platform: AgentAccountPlatform,
  enabled: boolean,
  pinned: boolean,
  machine?: AccountMachine,
): Promise<AgentAccountsSnapshot> {
  await invokeCommandNodeSetting("set_agent_account_auto_switch", { platform, enabled });
  if (enabled && pinned) {
    await machineInvoke(machine, "resume_agent_account_auto_switch", { platform });
  }
  return listAgentAccounts(machine);
}

/**
 * One account's automatic-switching tick. By email it travels from the command
 * node. An account with no email cannot be matched on another machine, so its tick
 * stays on `machine`.
 */
export async function setAgentAccountAutoSwitchIncluded(
  platform: AgentAccountPlatform,
  accountId: string,
  email: string | undefined,
  included: boolean,
  machine?: AccountMachine,
): Promise<AgentAccountsSnapshot> {
  if (email) {
    await invokeCommandNodeSetting("set_agent_account_auto_switch", { platform, email, included });
  } else {
    await machineInvoke(machine, "set_agent_account_auto_switch", {
      platform,
      accountId,
      included,
    });
  }
  return listAgentAccounts(machine);
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

/**
 * Record (or clear, with `null`) the login the overview flags every machine
 * against. Kept by the same machine that answers the overview; it switches
 * nothing. Older machines reject the command.
 */
export async function setPreferredAgentIdentity(
  platform: AgentAccountPlatform,
  email: string | null,
): Promise<PreferredAgentIdentities> {
  return invokeCommandNodeSetting<PreferredAgentIdentities>("set_preferred_agent_identity", {
    platform,
    email,
  });
}

/** Grok's and Pi's login on `machine`, read without a session. Older machines reject it. */
export async function readHostAgentSignIns(machine?: AccountMachine): Promise<HostAgentSignIns> {
  return machineInvoke<HostAgentSignIns>(machine, "read_host_agent_sign_ins");
}

/**
 * Open a terminal tab on `machine` running the platform's fixed login command,
 * in one of its running local environments (`environmentId` when it is one).
 */
export async function openAgentSignInTerminal(
  platform: HostSignInPlatform,
  machine?: AccountMachine,
  environmentId?: string,
): Promise<AgentSignInTerminal> {
  return machineInvoke<AgentSignInTerminal>(machine, "open_agent_sign_in_terminal", {
    platform,
    ...(environmentId ? { environmentId } : {}),
  });
}
