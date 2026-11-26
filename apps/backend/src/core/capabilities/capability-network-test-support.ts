/**
 * Test-only: Agent Capabilities on the in-memory node network
 * (`nodes/node-network-test-support.ts`). Each node runs the real
 * `NodeService`, `NodeLink` and node commands, plus a real
 * `CapabilityService` over its own SQLite store, artifact cache and provider
 * homes. The capability executor, handover and launch-answer commands are
 * answered by each node's own service over the link, so handovers, epochs and
 * leaf launches go through the same code as in production; only HTTP is a
 * fake `fetch`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import { UNRESTRICTED_CAPABILITY_CEILING } from "@orkestrator/protocol/capability-resources-resolve";
import {
  CAPABILITY_LAUNCH_REQUESTED_EVENT,
  CAPABILITY_LEAF_REQUESTED_EVENT,
} from "@orkestrator/protocol/contract/domains/capabilities";

import { StorageService } from "../storage/service.js";
import type { TestNode, TestNodeNetwork } from "../nodes/node-network-test-support.js";
import type { NodeServiceOptions } from "../nodes/node-service.js";
import { CapabilityEnvironmentAuthority } from "./environment-authority.js";
import type { InventoryPluginListing } from "./inventory.js";
import { testCapabilityHomes, type CapabilityHomes } from "./native-ownership.js";
import type {
  ContainerDeliveryEvidence,
  ScopedEnvironment,
  ScopedAccount,
  ScopedTargetSources,
} from "./scoped-delivery.js";
import { CapabilityService } from "./service.js";

export interface CapabilityNode {
  name: string;
  id: string;
  node: TestNode;
  cap: CapabilityService;
  /** Container staging and environment cards under the command node (`environment-authority.ts`). */
  environmentsAuthority: CapabilityEnvironmentAuthority;
  storage: StorageService;
  dir: string;
  home: string;
  /** Plan targets this machine's executor received, in order. */
  applyCalls: Array<{ key: string; action: string; digest?: string }>;
  /** Answer `false` to make the leaf believe its command node is away. */
  reachable: boolean;
  sessionEvidence?: import("@orkestrator/protocol/capability-evidence").CapabilitySessionEvidenceRead;
  busyWorktrees?: ReadonlySet<string>;
  /** Fail the next handover stage call of this part (a dropped transfer). */
  failNextStage?: "artifact" | "state";
  /** This machine's own environments (its environment store). */
  environments: ScopedEnvironment[];
  accounts: ScopedAccount[];
  /** Its containers' staged records (label and inputs revision), by environment. */
  containers: Map<string, ContainerDeliveryEvidence>;
  /** Answer `false` to drop this machine's container-record reads for its command node. */
  answersContainerReads: boolean;
  /** Other machines' environments, as this node's read model reports them. */
  remoteEnvironments: Map<string, ScopedEnvironment[]>;
  /** Scoped plans this machine's executor received for its worktrees, in order. */
  environmentApplyCalls: Array<{ environmentId: string; keys: string[] }>;
  /** Apply the next worktree plan, then lose its answer (the outcome is unknown). */
  loseNextEnvironmentAnswer?: boolean;
}

const cleanups: Array<() => Promise<void>> = [];

/** Disposes every capability node a test created (call from `afterEach`). */
export async function disposeCapabilityNodes(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
}

export async function addCapabilityNode(
  network: TestNodeNetwork,
  name: string,
  options: {
    forceRegistration?: boolean;
    commandable?: boolean;
    launchAnswerTimeoutMs?: number;
    leafRequestTimeoutMs?: number;
    extra?: Partial<NodeServiceOptions>;
    /** The provider plugin listings this machine's inventory reads (`inventory-plugins.ts`). */
    inventoryPlugins?: () => Promise<InventoryPluginListing>;
    claudePlugins?: (
      homes: CapabilityHomes,
    ) => Pick<import("./service.js").CapabilityServiceDeps, "claudePlugins" | "claudeInventory">;
  } = {},
): Promise<CapabilityNode> {
  const node = await network.add(name, {
    forceRegistration: options.forceRegistration ?? false,
    extra: {
      ...(options.commandable
        ? {
            selfAccess: async () => ({
              token: `token-${name}-secret`,
              origins: [`https://${name}.test`],
            }),
          }
        : {}),
      ...options.extra,
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `capabilities-net-${name}-`));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const entry = {
    name,
    id: node.storage.instanceId,
    node,
    storage,
    dir,
    home,
    applyCalls: [],
    reachable: true,
    environments: [],
    accounts: [],
    containers: new Map(),
    answersContainerReads: true,
    remoteEnvironments: new Map(),
    environmentApplyCalls: [],
  } as unknown as CapabilityNode;
  const service = node.service;
  const scoped: ScopedTargetSources = {
    writeHeld: async ({ environmentId }) => entry.busyWorktrees?.has(environmentId ?? "") ?? false,
    environments: async () => entry.environments,
    accounts: async () => entry.accounts,
    containerDelivery: async (environmentId) => entry.containers.get(environmentId) ?? null,
  };
  const machines = async () =>
    (await service.listNodes()).nodes.map((view) => ({
      nodeId: view.nodeId,
      name: view.displayName || view.fallbackName,
      connected: view.connection.state === "connected",
    }));
  const controllerReachable = async () =>
    entry.reachable && (await service.status()).controllers.length > 0;
  entry.cap = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => node.storage.instanceId,
    selfName: async () => name,
    machines,
    link: (nodeId) => service.link(nodeId as never),
    isAuthority: () => !service.isLeaf(),
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
      ...(options.inventoryPlugins ? { plugins: options.inventoryPlugins } : {}),
    },
    ...options.claudePlugins?.(testCapabilityHomes(home)),
    requestLaunch: (payload) => node.emit(CAPABILITY_LAUNCH_REQUESTED_EVENT, payload),
    controllerReachable,
    sessionEvidence: async () => entry.sessionEvidence ?? { state: "none" },
    scoped,
    remoteEnvironments: async (nodeId) => entry.remoteEnvironments.get(nodeId) ?? null,
  });
  // Built from the service's public parts, as `createCapabilityEnvironmentAuthority` does.
  entry.environmentsAuthority = new CapabilityEnvironmentAuthority({
    storage: { capabilities: storage.capabilities },
    artifacts: entry.cap.artifacts,
    selfId: async () => node.storage.instanceId,
    isLeaf: () => service.isLeaf(),
    link: (nodeId) => service.link(nodeId as never),
    admitEpoch: (controllerId, epoch) => entry.cap.executor.admitEpoch(controllerId, epoch),
    controllerReachable,
    request: (payload) => node.emit(CAPABILITY_LEAF_REQUESTED_EVENT, payload),
    resolve: (state, target) =>
      entry.cap.resolveFor(state, { target, ceiling: UNRESTRICTED_CAPABILITY_CEILING }),
    sources: scoped,
    machines,
    remoteEnvironments: async (nodeId) => entry.remoteEnvironments.get(nodeId) ?? null,
    now: () => new Date().toISOString(),
  });
  if (options.leafRequestTimeoutMs !== undefined) {
    entry.environmentsAuthority.containerAnswerTimeoutMs = options.leafRequestTimeoutMs;
    entry.environmentsAuthority.cardAnswerTimeoutMs = options.leafRequestTimeoutMs;
  }
  if (options.launchAnswerTimeoutMs !== undefined)
    entry.cap.leafLaunch.answerTimeoutMs = options.launchAnswerTimeoutMs;
  await entry.cap.init();
  service.setCapabilityHandover(entry.cap.handoverHooks());
  node.portal.readModel.onNodeEvent((event, payload, nodeId) => {
    if (event === CAPABILITY_LAUNCH_REQUESTED_EVENT)
      void entry.cap.answerLeafLaunch(nodeId, payload);
    if (event === CAPABILITY_LEAF_REQUESTED_EVENT)
      void entry.environmentsAuthority.answerLeafRequest(nodeId, payload);
  });
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    get_capability_node_observation: (args) => entry.cap.executorObserve(args),
    stage_capability_node_artifact: (args) => entry.cap.executorStage(args),
    apply_capability_node_plan: (args) => {
      for (const target of (args.targets ?? []) as Array<Record<string, string>>) {
        entry.applyCalls.push({
          key: target.key!,
          action: target.action!,
          ...(target.artifactDigest ? { digest: target.artifactDigest } : {}),
        });
      }
      return entry.cap.executorApply(args);
    },
    get_capability_node_environment_observation: (args) =>
      entry.cap.executorObserveEnvironments(args),
    apply_capability_node_environment_plan: async (args) => {
      entry.environmentApplyCalls.push({
        environmentId: String(args.environmentId),
        keys: ((args.targets ?? []) as Array<Record<string, string>>).map((target) => target.key!),
      });
      const answer = await entry.cap.executorApplyEnvironmentPlan(args);
      if (entry.loseNextEnvironmentAnswer) {
        entry.loseNextEnvironmentAnswer = false;
        throw new Error("The connection dropped before the answer arrived.");
      }
      return answer;
    },
    export_capability_node_item: (args) => entry.cap.executorExportItem(args),
    stage_capability_node_handover: (args) => {
      if (entry.failNextStage && args.part === entry.failNextStage) {
        entry.failNextStage = undefined;
        throw Object.assign(new Error("The transfer was interrupted."), { code: "interrupted" });
      }
      return entry.cap.executorStageHandover(args);
    },
    answer_capability_node_launch: (args) => entry.cap.executorLaunchAnswer(args),
    answer_capability_node_request: (args) => entry.environmentsAuthority.receiveAnswer(args),
    get_capability_node_container_delivery: (args) => {
      if (!entry.answersContainerReads) throw new Error("The connection dropped.");
      return entry.environmentsAuthority.containerDeliveryForController(args);
    },
  };
  for (const [command, handler] of Object.entries(handlers)) node.commands.set(command, handler);
  cleanups.push(async () => {
    entry.cap.dispose();
    storage.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return entry;
}

/** Authors a skill on the command node and adds it to My setup (or `setupId`). */
export async function addSkill(
  command: CapabilityNode,
  name: string,
  body: string,
  options: { required?: boolean; managedId?: string; setupId?: string } = {},
) {
  const inspection = await command.cap.authorPackage({
    kind: "skill",
    name,
    ...(options.managedId ? { managedId: options.managedId } : {}),
    description: `${name} skill`,
    content: body,
  });
  const preview = await command.cap.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: options.setupId ?? MY_SETUP_ID,
      ...(options.required ? { required: true } : {}),
    },
  });
  const applied = await command.cap.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await command.cap.reconciler.idle();
  return { inspection, preview, applied };
}

export function skillFile(node: CapabilityNode, root: string, name: string): string {
  return path.join(node.home, root, "skills", name, "SKILL.md");
}
