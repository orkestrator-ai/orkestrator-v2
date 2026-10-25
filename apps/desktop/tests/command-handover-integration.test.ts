import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { NodeImportEntry } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";
import {
  TestNodeNetwork,
  settle,
  type TestNode,
} from "../../backend/src/core/nodes/node-network-test-support";
import {
  handOverCommandNode,
  previewCommandHandover,
  type CommandHandoverDeps,
} from "../electron/command-handover";

import {
  PreviewPartitionRetention,
  nodePartitionKey,
} from "../electron/preview-partition-retention";
import {
  browserPreviewPartitionForWindow,
  browserPreviewServicePartition,
  connectionPartitionKey,
} from "../electron/desktop-window-lifecycle";

const id = (node: TestNode) => node.storage.instanceId as BackendId;
const routes = (node: TestNode) => [
  { id: "primary" as RouteId, kind: "https" as const, enabled: true, origin: node.origin },
];

function desktopDeps(
  network: TestNodeNetwork,
  source: TestNode,
  target: TestNode,
  others: TestNode[] = [],
): CommandHandoverDeps {
  const nodes = new Map([
    [source.name, source],
    [target.name, target],
    ...others.map((node) => [node.name, node] as const),
  ]);
  return {
    currentConnectionId: source.name,
    installationIdOf: (connection) => (nodes.has(connection) ? id(nodes.get(connection)!) : null),
    connectionIdOf: (nodeId) =>
      [...nodes.values()].find((node) => id(node) === nodeId)?.name ?? null,
    machineImportEntry: async (connection): Promise<NodeImportEntry | null> => {
      const node = nodes.get(connection);
      return node
        ? {
            importedFrom: `device:${connection}`,
            fallbackName: connection,
            verifiedNodeId: id(node),
            routes: routes(node),
            routeOrder: ["primary" as RouteId],
            token: node.token,
            enabled: true,
          }
        : null;
    },
    invokeOn: async <T>(
      connection: string,
      command: string,
      args: Record<string, unknown> = {},
    ) => {
      const node = nodes.get(connection)!;
      const response = await network.fetch(`${node.origin}/__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${node.token}` },
        body: JSON.stringify({ command, args }),
      });
      const body = (await response.json()) as { result?: T; error?: string };
      if (body.error) throw new Error(body.error);
      return body.result as T;
    },
  };
}

async function confirm(deps: CommandHandoverDeps, target: TestNode) {
  const plan = await previewCommandHandover(deps, target.name);
  expect(plan.kind).toBe("preview");
  if (plan.kind !== "preview") throw new Error("Expected a handover preview");
  const result = await handOverCommandNode(deps, {
    targetConnectionId: target.name,
    connectionIds: [],
    includeSelf: true,
    confirmation: {
      sourceNodeId: plan.preview.self.nodeId,
      targetNodeId: plan.preview.targetNodeId,
      repairs: plan.repairs ?? [],
      targetInspectionComplete: plan.targetInspectionComplete !== false,
    },
  });
  return { plan, result };
}

test("desktop repairs a refused two-node loop while the source is standalone", async () => {
  const network = new TestNodeNetwork();
  const source = await network.add("source", {
    forceRegistration: true,
    extra: {
      selfAccess: async () => ({ token: "token-source-secret", origins: ["https://source.test"] }),
    },
  });
  const target = await network.add("target", { forceRegistration: true });
  try {
    await source.service.addNode({ routes: routes(target), token: target.token });
    await target.service.detachController(id(source), { byUser: true });
    await target.service.addNode({ routes: routes(source), token: source.token });
    await source.service.reconnectNode(id(target));
    expect((await source.service.status()).mode).toBe("standalone");
    const { plan, result } = await confirm(desktopDeps(network, source, target), target);
    expect(plan.repairs).toEqual(["forget-source-on-target", "allow-source-on-target"]);
    expect(result?.selfIncluded).toBe(true);
    await settle(60);
    expect((await source.service.listNodes()).nodes).toEqual([]);
    expect((await target.service.listNodes()).nodes.map((node) => node.nodeId)).toEqual([
      id(source),
    ]);
    expect(
      (await source.service.status()).controllers.map((controller) => controller.controllerId),
    ).toEqual([id(target)]);
  } finally {
    await source.service.stop();
    await target.service.stop();
  }
});

test("desktop preserves target-only SSH access to a source with no selfAccess", async () => {
  const network = new TestNodeNetwork();
  const source = await network.add("source", { forceRegistration: true });
  const target = await network.add("target", {
    forceRegistration: true,
    extra: {
      createSsh: () => ({
        acquire: async () => ({
          localOrigin: source.origin,
          release: () => undefined,
          onClosed: () => () => undefined,
        }),
      }),
    },
  });
  try {
    await source.service.addNode({ routes: routes(target), token: target.token });
    const record = {
      nodeId: id(source),
      enabled: true,
      routes: [
        {
          id: "ssh" as RouteId,
          kind: "ssh" as const,
          enabled: true,
          destination: "user@source",
          identityFile: "/target/private-key",
          remoteGatewayPort: 4000,
        },
      ],
      routeOrder: ["ssh" as RouteId],
      credential: { token: source.token },
      fallbackName: "source",
      attachment: { status: "pending" as const },
      addedAt: "2026-10-23T00:00:00.000Z",
      source: "portal" as const,
    };
    await target.storage.mutateNodeRegistry((current) => ({
      next: { ...current, nodes: [record] },
      result: undefined,
    }));
    await target.service.stop();
    await target.service.start();
    const { plan, result } = await confirm(desktopDeps(network, source, target), target);
    expect(plan.preview.self.reachable).toBe(true);
    expect(plan.repairs ?? []).toEqual([]);
    expect(result?.selfIncluded).toBe(true);
    await settle(60);
    expect(target.storage.registry.nodes[0]?.routes).toEqual(record.routes);
    expect(target.storage.registry.nodes[0]?.credential).toEqual(record.credential);
    expect((await source.service.status()).mode).toBe("leaf");
    expect(
      (await source.service.status()).controllers.map((controller) => controller.controllerId),
    ).toEqual([id(target)]);
  } finally {
    await source.service.stop();
    await target.service.stop();
  }
});

test("leaf-window handover preserves registered previews across scheduled reconciliation and forgetting its controller", async () => {
  const network = new TestNodeNetwork();
  const source = await network.add("source", { forceRegistration: true });
  const target = await network.add("target", { forceRegistration: true });
  const leaf = await network.add("leaf", { forceRegistration: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "handover-retention-"));
  const pendingFile = path.join(directory, "pending.json");
  const partitionsDir = path.join(directory, "Partitions");
  const cleared: string[] = [];
  const retention = new PreviewPartitionRetention({
    partitionsDir,
    pendingFile,
    inUse: () => [],
    sessionFor: (partition) => ({
      clearStorageData: async () => {
        cleared.push(partition);
      },
    }),
  });
  try {
    await source.service.addNode({ routes: routes(target), token: target.token });
    await source.service.addNode({ routes: routes(leaf), token: leaf.token });
    await settle(40);
    expect((await leaf.service.status()).mode).toBe("leaf");
    const partitions = [
      browserPreviewPartitionForWindow(1, `node:${id(leaf)}`),
      browserPreviewServicePartition(2, `node:${id(leaf)}`, {
        backendInstanceId: id(leaf),
        serviceId: "svc_handover",
      }),
    ];
    for (const partition of partitions)
      await mkdir(path.join(partitionsDir, partition.replace(/^persist:/, "")), {
        recursive: true,
      });
    await retention.rememberNode(nodePartitionKey(id(leaf)), connectionPartitionKey(source.name));
    let releaseList!: () => void;
    let enteredList!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredList = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const stop = retention.schedule(
      connectionPartitionKey(source.name),
      {
        closed: false,
        listServices: async () => null,
        listNodes: async () => {
          enteredList();
          await release;
          return source.service.listNodes();
        },
      },
      { delayMs: 0, intervalMs: 60_000 },
    );
    await entered;
    const deps = desktopDeps(network, source, target, [leaf]);
    deps.currentConnectionId = leaf.name;
    const preview = await previewCommandHandover(deps, target.name);
    if (preview.kind !== "preview") throw new Error("Expected handover");
    let remoteStarted = false;
    const invoke = deps.invokeOn;
    deps.invokeOn = (connection, command, args) => {
      if (command === "hand_over_command") remoteStarted = true;
      return invoke(connection, command, args);
    };
    let queuedHandover!: () => void;
    const queued = new Promise<void>((resolve) => {
      queuedHandover = resolve;
    });
    const reserve = retention.handoverNodes.bind(retention);
    retention.handoverNodes = (...args) => {
      queuedHandover();
      return reserve(...args);
    };
    const handover = handOverCommandNode(
      deps,
      {
        targetConnectionId: target.name,
        connectionIds: [],
        nodeIds: [id(leaf)],
        includeSelf: false,
        confirmation: {
          sourceNodeId: preview.preview.self.nodeId,
          targetNodeId: preview.preview.targetNodeId,
          repairs: preview.repairs ?? [],
          targetInspectionComplete: preview.targetInspectionComplete !== false,
        },
      },
      retention,
    );
    await queued;
    expect(remoteStarted).toBe(false);
    releaseList();
    await handover;
    stop();
    await settle(40);
    await retention.reconcileNodes(connectionPartitionKey(source.name), {
      closed: false,
      listNodes: () => source.service.listNodes(),
    });
    await retention.forgetConnection(connectionPartitionKey(source.name), { includeShared: true });
    expect(cleared).toEqual([]);
    const journal = JSON.parse(await readFile(`${pendingFile}.nodes`, "utf8"));
    expect(journal).toEqual([
      { key: nodePartitionKey(id(leaf)), commands: [connectionPartitionKey(target.name)] },
    ]);
    expect((await target.service.listNodes()).nodes.some((node) => node.nodeId === id(leaf))).toBe(
      true,
    );
  } finally {
    retention.dispose();
    await Promise.all([source.service.stop(), target.service.stop(), leaf.service.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
});
