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
import { CAPABILITY_LAUNCH_REQUESTED_EVENT } from "@orkestrator/protocol/contract/domains/capabilities";

import { StorageService } from "../storage.js";
import type { TestNode, TestNodeNetwork } from "../nodes/node-network-test-support.js";
import type { NodeServiceOptions } from "../nodes/node-service.js";
import { testCapabilityHomes } from "./native-ownership.js";
import type { ScopedEnvironment } from "./scoped-delivery.js";
import { CapabilityService } from "./service.js";

export interface CapabilityNode {
  name: string;
  id: string;
  node: TestNode;
  cap: CapabilityService;
  storage: StorageService;
  dir: string;
  home: string;
  /** Plan targets this machine's executor received, in order. */
  applyCalls: Array<{ key: string; action: string; digest?: string }>;
  /** Answer `false` to make the leaf believe its command node is away. */
  reachable: boolean;
  /** Fail the next handover stage call of this part (a dropped transfer). */
  failNextStage?: "artifact" | "state";
  /** This machine's own environments (its environment store). */
  environments: ScopedEnvironment[];
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
    extra?: Partial<NodeServiceOptions>;
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
    remoteEnvironments: new Map(),
    environmentApplyCalls: [],
  } as unknown as CapabilityNode;
  const service = node.service;
  entry.cap = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => node.storage.instanceId,
    selfName: async () => name,
    machines: async () =>
      (await service.listNodes()).nodes.map((view) => ({
        nodeId: view.nodeId,
        name: view.displayName || view.fallbackName,
        connected: view.connection.state === "connected",
      })),
    link: (nodeId) => service.link(nodeId as never),
    isAuthority: () => !service.isLeaf(),
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
    requestLaunch: (payload) => node.emit(CAPABILITY_LAUNCH_REQUESTED_EVENT, payload),
    controllerReachable: async () =>
      entry.reachable && (await service.status()).controllers.length > 0,
    scoped: { environments: async () => entry.environments },
    remoteEnvironments: async (nodeId) => entry.remoteEnvironments.get(nodeId) ?? null,
  });
  if (options.launchAnswerTimeoutMs !== undefined)
    entry.cap.leafLaunch.answerTimeoutMs = options.launchAnswerTimeoutMs;
  await entry.cap.init();
  service.setCapabilityHandover(entry.cap.handoverHooks());
  node.portal.readModel.onNodeEvent((event, payload, nodeId) => {
    if (event === CAPABILITY_LAUNCH_REQUESTED_EVENT)
      void entry.cap.answerLeafLaunch(nodeId, payload);
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
