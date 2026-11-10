import { accountsOn, commandNodeAccounts } from "@/lib/node-scope/domains/accounts";
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
import {
  GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
  type CoordinatorAccountSwitchGrantState,
} from "@orkestrator/protocol/coordinator-account-switch-grant";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { NativeAgentAuthStatus } from "@orkestrator/protocol/native-agent";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  commandBackendClient,
  machineInvoker,
  type BackendClient,
  type AccountMachine,
  type MachineInvoke,
} from "./client";

/**
 * Additional Claude and Codex logins. The backend owns every decision —
 * account directories, the CLI sign-in, which account launches use — and
 * never returns a credential.
 *
 * Every machine keeps its own accounts. `machine` names the node to ask,
 * through the command node. `null` selects the command node; `undefined`
 * selects this view's backend (the leaf, inside a leaf's workspace).
 */
export type { AccountMachine } from "./client";

/**
 * Ask `machine` through the command node, or this view's own backend without
 * one. The command-scope binding of `machineInvoker` (`./client`).
 */
export const machineInvoke: MachineInvoke = machineInvoker(commandBackendClient);

/** Every machine's accounts, collected by the command node. */
export async function listMachineAgentAccounts(): Promise<MachineAgentAccountsResult> {
  return commandNodeAccounts().list_machine_agent_accounts({});
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
  return commandNodeAccounts().set_preferred_agent_identity({ platform, email });
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createAgentAccountsApi(client: BackendClient) {
  // The `accounts` domain (plan item 7008), on this client's node or another machine.
  const on = accountsOn(client);

  async function listAgentAccounts(machine?: AccountMachine): Promise<AgentAccountsSnapshot> {
    return on(machine).list_agent_accounts({});
  }

  /**
   * A platform's sign-in state for the settings pane, read on the host without a
   * session: the active account for Claude and Codex, the stored credential or
   * provider logins for the rest.
   */
  async function getAgentSignInStatus(
    platform: AgentPlatform,
    machine?: AccountMachine,
  ): Promise<NativeAgentAuthStatus> {
    return on(machine).get_agent_sign_in_status({ platform });
  }

  async function setActiveAgentAccount(
    platform: AgentAccountPlatform,
    accountId: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountsSnapshot> {
    return on(machine).set_active_agent_account({ platform, accountId });
  }

  /**
   * The main automatic-switching tick, and what `machine` shows afterwards.
   *
   * The tick belongs to the command node, which hands it to its machines. Ticking it
   * is also what ends a pin, and a pin belongs to the machine it was set on, so only
   * `machine`'s ends. A machine that predates this never reports a pin to end.
   */
  async function setAgentAccountAutoSwitchEnabled(
    platform: AgentAccountPlatform,
    enabled: boolean,
    pinned: boolean,
    machine?: AccountMachine,
  ): Promise<AgentAccountsSnapshot> {
    await commandNodeAccounts().set_agent_account_auto_switch({ platform, enabled });
    if (enabled && pinned) {
      await on(machine).resume_agent_account_auto_switch({ platform });
    }
    return listAgentAccounts(machine);
  }

  /**
   * One account's automatic-switching tick. By email it travels from the command
   * node. An account with no email cannot be matched on another machine, so its tick
   * stays on `machine`.
   */
  async function setAgentAccountAutoSwitchIncluded(
    platform: AgentAccountPlatform,
    accountId: string,
    email: string | undefined,
    included: boolean,
    machine?: AccountMachine,
  ): Promise<AgentAccountsSnapshot> {
    if (email) {
      await commandNodeAccounts().set_agent_account_auto_switch({ platform, email, included });
    } else {
      await on(machine).set_agent_account_auto_switch({ platform, accountId, included });
    }
    return listAgentAccounts(machine);
  }

  /**
   * The standing permission for `machine`'s coordinators to switch accounts
   * without asking, and the switches it allowed. Each machine holds its own,
   * for the switches its coordinators make on it and on the machines it
   * controls. `null` from a machine that predates it, which keeps asking.
   */
  async function getCoordinatorAccountSwitchGrant(
    platform: AgentAccountPlatform,
    machine?: AccountMachine,
  ): Promise<CoordinatorAccountSwitchGrantState | null> {
    try {
      return await on(machine).get_coordinator_account_switch_grant({ platform });
    } catch (error) {
      if (
        incompatibility(error, GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND)?.code ===
        "unknown-command"
      )
        return null;
      throw error;
    }
  }

  async function setCoordinatorAccountSwitchGrant(
    platform: AgentAccountPlatform,
    enabled: boolean,
    machine?: AccountMachine,
  ): Promise<CoordinatorAccountSwitchGrantState> {
    return on(machine).set_coordinator_account_switch_grant({ platform, enabled });
  }

  async function renameAgentAccount(
    platform: AgentAccountPlatform,
    accountId: string,
    label: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountsSnapshot> {
    return on(machine).rename_agent_account({ platform, accountId, label });
  }

  async function removeAgentAccount(
    platform: AgentAccountPlatform,
    accountId: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountsSnapshot> {
    return on(machine).remove_agent_account({ platform, accountId });
  }

  async function getAgentAccountUsage(
    platform: AgentAccountPlatform,
    accountId: string,
    options: { force?: boolean; cacheOnly?: boolean } = {},
    machine?: AccountMachine,
  ): Promise<PlanUsageSnapshot> {
    return on(machine).get_agent_account_usage({
      platform,
      accountId,
      ...(options.force ? { force: true } : {}),
      ...(options.cacheOnly ? { cacheOnly: true } : {}),
    });
  }

  /**
   * Start a sign-in. By default it adds an account; with `reauthenticate` it
   * signs the platform's active account in again (Claude only). The CLI runs on
   * the machine named; its link opens in this client's browser.
   */
  async function startAgentAccountLogin(
    platform: AgentAccountPlatform,
    options: { reauthenticate?: boolean } = {},
    machine?: AccountMachine,
  ): Promise<AgentAccountLoginProgress> {
    return on(machine).start_agent_account_login({
      platform,
      ...(options.reauthenticate ? { reauthenticate: true } : {}),
    });
  }

  /**
   * Sign one existing Claude account in again by id, without making it the
   * active account. A machine that predates the command is told to update.
   */
  async function reauthenticateAgentAccount(
    platform: AgentAccountPlatform,
    accountId: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountLoginProgress> {
    try {
      return await on(machine).reauthenticate_agent_account({ platform, accountId });
    } catch (error) {
      if (incompatibility(error, "reauthenticate_agent_account")?.code === "unknown-command") {
        throw new Error(
          "This machine's Orkestrator is too old to sign an account in from here. Update it, or switch to the account and sign in from its agent tab.",
        );
      }
      throw error;
    }
  }

  async function getAgentAccountLogin(
    machine?: AccountMachine,
  ): Promise<AgentAccountLoginProgress> {
    return on(machine).get_agent_account_login({});
  }

  async function submitAgentAccountLoginCode(
    code: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountLoginProgress> {
    return on(machine).submit_agent_account_login_code({ code });
  }

  async function cancelAgentAccountLogin(
    operationId?: string,
    machine?: AccountMachine,
  ): Promise<AgentAccountLoginProgress> {
    return on(machine).cancel_agent_account_login(operationId ? { operationId } : {});
  }

  /** Which of its machine's accounts one session's bridge uses. Asked of the session's own backend. */
  async function getNativeAgentSessionAccount(
    environmentId: string,
    agent: string,
  ): Promise<AgentSessionAccount | null> {
    return on().get_native_agent_session_account({ environmentId, agent });
  }

  /** Grok's and Pi's login on `machine`, read without a session. Older machines reject it. */
  async function readHostAgentSignIns(machine?: AccountMachine): Promise<HostAgentSignIns> {
    return on(machine).read_host_agent_sign_ins({});
  }

  /**
   * Open a terminal tab on `machine` running the platform's fixed login command,
   * in one of its running local environments (`environmentId` when it is one).
   */
  async function openAgentSignInTerminal(
    platform: HostSignInPlatform,
    machine?: AccountMachine,
    environmentId?: string,
  ): Promise<AgentSignInTerminal> {
    return on(machine).open_agent_sign_in_terminal({
      platform,
      ...(environmentId ? { environmentId } : {}),
    });
  }

  return {
    listAgentAccounts,
    getAgentSignInStatus,
    setActiveAgentAccount,
    setAgentAccountAutoSwitchEnabled,
    setAgentAccountAutoSwitchIncluded,
    getCoordinatorAccountSwitchGrant,
    setCoordinatorAccountSwitchGrant,
    renameAgentAccount,
    removeAgentAccount,
    getAgentAccountUsage,
    startAgentAccountLogin,
    reauthenticateAgentAccount,
    getAgentAccountLogin,
    submitAgentAccountLoginCode,
    cancelAgentAccountLogin,
    getNativeAgentSessionAccount,
    readHostAgentSignIns,
    openAgentSignInTerminal,
  };
}

export type AgentAccountsApi = ReturnType<typeof createAgentAccountsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listAgentAccounts,
  getAgentSignInStatus,
  setActiveAgentAccount,
  setAgentAccountAutoSwitchEnabled,
  setAgentAccountAutoSwitchIncluded,
  getCoordinatorAccountSwitchGrant,
  setCoordinatorAccountSwitchGrant,
  renameAgentAccount,
  removeAgentAccount,
  getAgentAccountUsage,
  startAgentAccountLogin,
  reauthenticateAgentAccount,
  getAgentAccountLogin,
  submitAgentAccountLoginCode,
  cancelAgentAccountLogin,
  getNativeAgentSessionAccount,
  readHostAgentSignIns,
  openAgentSignInTerminal,
} = createAgentAccountsApi(commandBackendClient);
