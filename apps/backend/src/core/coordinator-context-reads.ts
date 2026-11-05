/**
 * The reads behind the coordinator context block. The block itself is the pure
 * `buildCoordinatorContext` in `@orkestrator/protocol/coordinator-context`.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_WAITING_ON_NAMES,
  coordinatorOpenWorkers,
  type CoordinatorWaitingOn,
} from "@orkestrator/protocol/coordinator-context";
import { coordinatorProviderQualification } from "./coordinator-providers.js";
import type { StorageService } from "./storage.js";

export async function agentMessagingEnabled(
  storage: Pick<StorageService, "loadConfig">,
): Promise<boolean> {
  return (await storage.loadConfig()).global.agentMessaging?.enabled === true;
}

/**
 * Whether a main coordinator on this platform can delegate: launch a worker
 * and be woken when it finishes. Launching goes out over Control MCP on a
 * platform qualified for it, and every wake comes back as agent mail, so with
 * messaging off a coordinator would wait for a wake that cannot arrive.
 */
export async function coordinatorDelegationAvailable(
  platform: AgentPlatform,
  deps: { controlMcpRunning: () => boolean; storage: Pick<StorageService, "loadConfig"> },
): Promise<boolean> {
  return (
    deps.controlMcpRunning() &&
    coordinatorProviderQualification(platform).delegation &&
    (await agentMessagingEnabled(deps.storage))
  );
}

/**
 * The open work a main coordinator is told about on every turn, or null when
 * there is none. Reads one environment for each name it spells out, however
 * many are open. Advisory: a failed read costs the line or a name, never the
 * turn, and an unreadable worker is named by its id.
 */
export async function readCoordinatorWaitingOn(
  storage: Pick<StorageService, "getEnvironment"> & {
    coordinators: Pick<StorageService["coordinators"], "listOpenCoordinatorDelegations">;
  },
  coordinatorId: string,
): Promise<CoordinatorWaitingOn | null> {
  const open = await storage.coordinators.listOpenCoordinatorDelegations().catch(() => []);
  const workers = coordinatorOpenWorkers(open, coordinatorId);
  if (workers.length === 0) return null;
  const names = await Promise.all(
    workers.slice(0, COORDINATOR_WAITING_ON_NAMES).map(async (worker) => {
      // A worker on another node has no record here to read.
      const environment = worker.nodeId
        ? null
        : await storage.getEnvironment(worker.resourceId).catch(() => null);
      return environment?.name || worker.recordedName || worker.resourceId;
    }),
  );
  return { names, total: workers.length };
}
