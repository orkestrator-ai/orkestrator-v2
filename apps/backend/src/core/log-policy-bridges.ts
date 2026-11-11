import { createLogger } from "@orkestrator/protocol/logger";
import type { CommandContext } from "./commands-context.js";
import { getHostPort } from "./commands-container-exec.js";
import {
  CONTAINER_BRIDGE_PORTS,
  localRuntimeEnvironment,
  localServerPort,
} from "./commands-servers.js";
import {
  isContainerBridgeKind,
  readContainerBridgeToken,
  type ContainerBridgeKind,
} from "./container-bridge-credential.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import type { BridgeLogPolicyTarget } from "./log-policy-service.js";

/** OpenCode has no bridge of ours to carry the route. */
const LOG_POLICY_BRIDGES: readonly ContainerBridgeKind[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "pi",
];
const log = createLogger("logging");
const CONTAINER_LOOKUP_CONCURRENCY = 4;
const CONTAINER_LOOKUP_TIMEOUT_MS = 3_000;

type DiscoveryDependencies = Pick<typeof import("./commands-container-exec.js"), "getHostPort"> & {
  readToken: typeof readContainerBridgeToken;
};
const defaultDependencies: DiscoveryDependencies = {
  getHostPort,
  readToken: readContainerBridgeToken,
};

async function localTargets(context: CommandContext): Promise<BridgeLogPolicyTarget[]> {
  const localServers = context.runtime.localServers;
  const targets: BridgeLogPolicyTarget[] = [];
  for (const key of localServers.processKeys()) {
    const separator = key.indexOf(":");
    if (separator <= 0) continue;
    const agent = key.slice(0, separator) as LocalServerKind;
    if (!isContainerBridgeKind(agent) || !LOG_POLICY_BRIDGES.includes(agent)) continue;
    const environmentId = key.slice(separator + 1);
    const authToken = localServers.bridgeToken(agent, environmentId);
    // One environment that cannot be resolved must not cost the others their update.
    const environment = await localRuntimeEnvironment(environmentId, context).catch(() => null);
    const port = localServerPort(environment, agent);
    if (authToken && port) {
      targets.push({ agent, baseUrl: `http://127.0.0.1:${port}`, authToken });
    }
  }
  return targets;
}

async function containerTarget(
  containerId: string,
  agent: ContainerBridgeKind,
  dependencies: DiscoveryDependencies,
): Promise<BridgeLogPolicyTarget | null> {
  const signal = AbortSignal.timeout(CONTAINER_LOOKUP_TIMEOUT_MS);
  const hostPort = await dependencies.getHostPort(
    containerId,
    CONTAINER_BRIDGE_PORTS[agent],
    "tcp",
    signal,
    true,
  );
  if (!hostPort) return null;
  const authToken = await dependencies.readToken(containerId, agent, {
    timeoutMs: CONTAINER_LOOKUP_TIMEOUT_MS,
    signal,
  });
  if (!authToken) return null;
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
  onTarget?: (target: BridgeLogPolicyTarget) => void,
  dependencies: DiscoveryDependencies = defaultDependencies,
): Promise<BridgeLogPolicyTarget[]> {
  const targets = await localTargets(context);
  for (const target of targets) onTarget?.(target);
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
  const lookupCount = containerIds.length * LOG_POLICY_BRIDGES.length;
  let next = 0;
  let failedLookups = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONTAINER_LOOKUP_CONCURRENCY, lookupCount) }, async () => {
      while (next < lookupCount) {
        const index = next++;
        const containerId = containerIds[Math.floor(index / LOG_POLICY_BRIDGES.length)]!;
        const agent = LOG_POLICY_BRIDGES[index % LOG_POLICY_BRIDGES.length]!;
        let target: BridgeLogPolicyTarget | null = null;
        // Each retry gets a fresh deadline. A failed Docker read is not absence.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            target = await containerTarget(containerId, agent, dependencies);
            break;
          } catch {
            if (attempt === 2) failedLookups++;
          }
        }
        if (target) {
          targets.push(target);
          onTarget?.(target);
        }
      }
    }),
  );
  if (failedLookups > 0) {
    log.warn("policy.push-failed", { agent: "all", reason: "lookup-failed", count: failedLookups });
  }
  return targets;
}
