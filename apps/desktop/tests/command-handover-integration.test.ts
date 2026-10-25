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

const id = (node: TestNode) => node.storage.instanceId as BackendId;
const routes = (node: TestNode) => [
  { id: "primary" as RouteId, kind: "https" as const, enabled: true, origin: node.origin },
];

function desktopDeps(
  network: TestNodeNetwork,
  source: TestNode,
  target: TestNode,
): CommandHandoverDeps {
  const nodes = new Map([
    [source.name, source],
    [target.name, target],
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
