/**
 * A command node and two leaves for local-changes tests (`drift.test.ts`):
 * each with its own SQLite store and provider homes, joined by fake node
 * links that call the leaves' own executor handlers.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";

import { StorageService } from "../storage/service.js";
import { testCapabilityHomes } from "./native-ownership.js";
import { CapabilityService } from "./service.js";

export interface FleetNode {
  id: string;
  dir: string;
  home: string;
  storage: StorageService;
  service: CapabilityService;
  connected: boolean;
}

const created: FleetNode[] = [];

/** Disposes every node made since the last call; use in `afterEach`. */
export async function disposeFleet(): Promise<void> {
  for (const node of created.splice(0)) {
    node.service.dispose();
    node.storage.close?.();
    await fs.rm(node.dir, { recursive: true, force: true });
  }
}

async function makeNode(
  id: string,
  others: () => FleetNode[],
  isCommand: boolean,
): Promise<FleetNode> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `capabilities-drift-${id}-`));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const node = { id, dir, home, storage, connected: true } as FleetNode;
  node.service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => id,
    selfName: async () => id,
    machines: async () =>
      isCommand
        ? others().map((other) => ({
            nodeId: other.id,
            name: other.id,
            connected: other.connected,
          }))
        : [],
    link: (nodeId) => {
      const leaf = others().find((other) => other.id === nodeId);
      if (!leaf) return null;
      return {
        get connected() {
          return leaf.connected;
        },
        invokeCommand: async (def: AnyCommandDef, args: unknown) => {
          if (!leaf.connected) throw new Error("link down");
          const record = args as Record<string, unknown>;
          switch (def.name) {
            case "get_capability_node_observation":
              return leaf.service.executorObserve(record) as never;
            case "stage_capability_node_artifact":
              return leaf.service.executorStage(record) as never;
            case "apply_capability_node_plan":
              return (await leaf.service.executorApply(record)) as never;
            case "export_capability_node_item":
              return leaf.service.executorExportItem(record) as never;
            default:
              throw new Error(`unexpected ${def.name}`);
          }
        },
      };
    },
    isAuthority: () => isCommand,
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
  });
  await node.service.init();
  created.push(node);
  return node;
}

export async function fleet() {
  const all: FleetNode[] = [];
  const command = await makeNode("bk_command", () => all.slice(1), true);
  const leafA = await makeNode("bk_leaf_a", () => [], false);
  const leafB = await makeNode("bk_leaf_b", () => [], false);
  all.push(command, leafA, leafB);
  return { command, leafA, leafB };
}

/** Previews and approves `change`, then waits for delivery. */
export async function previewAndApply(command: FleetNode, change: Record<string, unknown>) {
  const preview = await command.service.previewChange({ change });
  await command.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await command.service.reconciler.idle();
  return preview;
}

export async function addSkill(command: FleetNode, name: string, body: string, managedId?: string) {
  const inspection = await command.service.authorPackage({
    kind: "skill",
    name,
    ...(managedId ? { managedId } : {}),
    description: `${name} skill`,
    content: body,
  });
  await previewAndApply(command, {
    kind: "add-to-setup",
    inspectionId: inspection.inspectionId,
    setupId: MY_SETUP_ID,
  });
  return inspection;
}

export const skillFile = (node: FleetNode, root: string, name: string) =>
  path.join(node.home, root, "skills", name, "SKILL.md");

/** Re-observes `node` and returns its open local changes. */
export async function openDrift(command: FleetNode, node: FleetNode) {
  await command.service.reconciler.reconcileNode(node.id, "test");
  await command.service.reconciler.idle();
  return (await command.service.listDrift({})).drift.filter(
    (entry) => entry.nodeId === node.id && entry.state === "open",
  );
}
