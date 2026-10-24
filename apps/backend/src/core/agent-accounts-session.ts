import {
  DEFAULT_AGENT_ACCOUNT_ID,
  isAgentAccountPlatform,
  type AgentAccountPlatform,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";

import { CLAUDE_BRIDGE_PORT, CODEX_BRIDGE_PORT } from "./constants.js";
import { getHostPort } from "./commands-container-exec.js";
import { checkHttpHealth } from "./commands-server-health.js";

import type { CommandContext } from "./commands-context.js";
import { listAgentAccounts } from "./agent-accounts.js";
import { readContainerAgentAccountId } from "./agent-accounts-containers.js";

async function containerBridgeRunning(
  containerId: string,
  platform: AgentAccountPlatform,
): Promise<boolean> {
  const port = await getHostPort(
    containerId,
    platform === "claude" ? CLAUDE_BRIDGE_PORT : CODEX_BRIDGE_PORT,
  );
  return port ? checkHttpHealth(port) : false;
}

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
  readContainerRunning: typeof containerBridgeRunning = containerBridgeRunning,
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
    running =
      environment.status === "running" &&
      (await readContainerRunning(environment.containerId, platform));
    if (platform === "claude") {
      const { global } = await context.storage.loadConfig();
      // An isolated container is signed in from a terminal inside it.
      if (global.useHostClaudeCredentials === false) {
        return { platform, source: "container", running };
      }
    }
    if (running) {
      launchedId = await readContainerAccount(environment.containerId, platform).catch(
        () => undefined,
      );
      if (!launchedId) return { platform, source: "unknown", running };
    }
  } else {
    const key = `${platform}:${environmentId}`;
    const child = context.runtime.localServers.process(key);
    running = Boolean(child && child.exitCode === null && child.signalCode === null);
    if (running)
      launchedId = context.runtime.localServers.launchedAccountId(key) ?? DEFAULT_AGENT_ACCOUNT_ID;
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
