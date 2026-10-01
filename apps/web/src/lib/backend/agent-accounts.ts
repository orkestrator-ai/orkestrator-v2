import { invoke } from "@/lib/native/backend";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
  AgentAccountsSnapshot,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

/**
 * Additional Claude and Codex logins. The backend owns every decision —
 * account directories, the CLI sign-in, which account launches use — and
 * never returns a credential.
 */
export async function listAgentAccounts(): Promise<AgentAccountsSnapshot> {
  return invoke<AgentAccountsSnapshot>("list_agent_accounts", {});
}

export async function setActiveAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<AgentAccountsSnapshot> {
  return invoke<AgentAccountsSnapshot>("set_active_agent_account", { platform, accountId });
}

export async function renameAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
  label: string,
): Promise<AgentAccountsSnapshot> {
  return invoke<AgentAccountsSnapshot>("rename_agent_account", { platform, accountId, label });
}

export async function removeAgentAccount(
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<AgentAccountsSnapshot> {
  return invoke<AgentAccountsSnapshot>("remove_agent_account", { platform, accountId });
}

export async function getAgentAccountUsage(
  platform: AgentAccountPlatform,
  accountId: string,
  options: { force?: boolean } = {},
): Promise<PlanUsageSnapshot> {
  return invoke<PlanUsageSnapshot>("get_agent_account_usage", {
    platform,
    accountId,
    ...(options.force ? { force: true } : {}),
  });
}

/**
 * Start a sign-in. By default it adds an account; with `reauthenticate` it
 * signs the platform's active account in again (Claude only).
 */
export async function startAgentAccountLogin(
  platform: AgentAccountPlatform,
  options: { reauthenticate?: boolean } = {},
): Promise<AgentAccountLoginProgress> {
  return invoke<AgentAccountLoginProgress>("start_agent_account_login", {
    platform,
    ...(options.reauthenticate ? { reauthenticate: true } : {}),
  });
}

export async function getAgentAccountLogin(): Promise<AgentAccountLoginProgress> {
  return invoke<AgentAccountLoginProgress>("get_agent_account_login", {});
}

export async function submitAgentAccountLoginCode(
  code: string,
): Promise<AgentAccountLoginProgress> {
  return invoke<AgentAccountLoginProgress>("submit_agent_account_login_code", { code });
}

export async function cancelAgentAccountLogin(): Promise<AgentAccountLoginProgress> {
  return invoke<AgentAccountLoginProgress>("cancel_agent_account_login", {});
}
