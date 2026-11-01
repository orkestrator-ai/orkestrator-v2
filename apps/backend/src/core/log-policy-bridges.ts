import type { CommandContext } from "./commands-context.js";
import { dockerExec, getHostPort } from "./commands-container-exec.js";
import {
  CONTAINER_BRIDGE_PEEK,
  localRuntimeEnvironment,
  localServerPort,
} from "./commands-servers.js";
import { BRIDGE_TOKEN_PATTERN, type LocalServerKind } from "./local-server-runtime.js";
import type { BridgeLogPolicyTarget } from "./log-policy-service.js";

/** OpenCode has no bridge of ours to carry the route. */
const LOG_POLICY_BRIDGES: readonly LocalServerKind[] = ["claude", "codex", "cursor", "grok", "pi"];
const CONTAINER_LOOKUP_CONCURRENCY = 4;

async function localTargets(context: CommandContext): Promise<BridgeLogPolicyTarget[]> {
  const localServers = context.runtime.localServers;
  const targets: BridgeLogPolicyTarget[] = [];
  for (const key of localServers.processKeys()) {
    const separator = key.indexOf(":");
    if (separator <= 0) continue;
    const agent = key.slice(0, separator) as LocalServerKind;
    if (!LOG_POLICY_BRIDGES.includes(agent)) continue;
    const environmentId = key.slice(separator + 1);
    const authToken = localServers.bridgeToken(agent, environmentId);
    const port = localServerPort(await localRuntimeEnvironment(environmentId, context), agent);
    if (authToken && port) {
      targets.push({ agent, baseUrl: `http://127.0.0.1:${port}`, authToken });
    }
  }
  return targets;
}

async function containerTarget(
  containerId: string,
  agent: LocalServerKind,
): Promise<BridgeLogPolicyTarget | null> {
  const { containerPort, tokenFile } = CONTAINER_BRIDGE_PEEK[agent];
  const hostPort = await getHostPort(containerId, containerPort);
  if (!hostPort) return null;
  const authToken = (await dockerExec(containerId, `cat ${tokenFile} 2>/dev/null || true`)).trim();
  if (!BRIDGE_TOKEN_PATTERN.test(authToken)) return null;
  return { agent, baseUrl: `http://127.0.0.1:${hostPort}`, authToken };
}

/**
 * Every bridge running now, local and Docker, found the way the activity sweep
 * finds them: nothing is started, no session is touched. It deliberately skips
 * their health probes, which a bridge with a busy event loop can fail. That is
 * the bridge whose detail matters most, so it still gets the request, bounded
 * by a timeout and retried.
 */
export async function listRunningBridgeTargets(
  context: CommandContext,
): Promise<BridgeLogPolicyTarget[]> {
  const targets: BridgeLogPolicyTarget[] = await localTargets(context).catch(() => []);
  const environments = await context.storage.loadEnvironments();
  const containerIds = Array.from(
    new Set(
      environments.flatMap((environment) =>
        environment.environmentType !== "local" &&
        environment.status === "running" &&
        environment.containerId
          ? [environment.containerId]
          : [],
      ),
    ),
  );
  for (let index = 0; index < containerIds.length; index += CONTAINER_LOOKUP_CONCURRENCY) {
    const found = await Promise.all(
      containerIds
        .slice(index, index + CONTAINER_LOOKUP_CONCURRENCY)
        .flatMap((containerId) =>
          LOG_POLICY_BRIDGES.map((agent) => containerTarget(containerId, agent).catch(() => null)),
        ),
    );
    for (const target of found) if (target) targets.push(target);
  }
  return targets;
}
