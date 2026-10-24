import {
  DEFAULT_AGENT_ACCOUNT_ID,
  isAgentAccountPlatform,
  type AgentAccountPlatform,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import { localServerProcesses } from "./commands-runtime-state.js";
import { localAgentAccountIds } from "./agent-account-bridge-state.js";
import { listAgentAccounts } from "./agent-accounts.js";
import { readContainerAgentAccountId } from "./agent-accounts-containers.js";

/**
 * Which of this machine's logins a session's bridge uses.
 *
 * A local bridge (coordinators included) is keyed `<platform>:<environmentId>`
 * and records the account it was launched on. A container records the login
 * it holds in its account marker. A bridge that is not running reports the
 * active account, because that is what its next start uses.
 */
export async function readSessionAgentAccount(
  context: CommandContext,
  environmentId: string,
  agent: string,
  readContainerAccount: typeof readContainerAgentAccountId = readContainerAgentAccountId,
): Promise<AgentSessionAccount | null> {
  if (!isAgentAccountPlatform(agent)) return null;
  const platform: AgentAccountPlatform = agent;
  const [snapshot, environment] = await Promise.all([
    listAgentAccounts(context),
    context.storage.getEnvironment(environmentId),
  ]);
  const activeId = snapshot.active[platform];
  const accountFor = (id: string) =>
    snapshot.accounts.find((account) => account.platform === platform && account.id === id);

  let launchedId: string | undefined;
  let running: boolean;
  if (environment?.containerId && environment.environmentType !== "local") {
    if (platform === "claude") {
      const { global } = await context.storage.loadConfig();
      // An isolated container is signed in from a terminal inside it.
      if (global.useHostClaudeCredentials === false) {
        return { platform, source: "container", running: environment.status === "running" };
      }
    }
    running = environment.status === "running";
    if (running) {
      launchedId = await readContainerAccount(environment.containerId, platform).catch(
        () => undefined,
      );
      if (!launchedId) return { platform, source: "unknown", running };
    }
  } else {
    const key = `${platform}:${environmentId}`;
    const child = localServerProcesses.get(key);
    running = Boolean(child && child.exitCode === null && child.signalCode === null);
    if (running) launchedId = localAgentAccountIds.get(key) ?? DEFAULT_AGENT_ACCOUNT_ID;
  }

  const account = accountFor(launchedId ?? activeId);
  // An account removed since launch is no longer listed.
  if (!account) return { platform, source: "unknown", running };
  const active = launchedId && launchedId !== activeId ? accountFor(activeId) : undefined;
  return {
    platform,
    source: "account",
    account,
    running,
    ...(active ? { pendingActive: active } : {}),
  };
}
