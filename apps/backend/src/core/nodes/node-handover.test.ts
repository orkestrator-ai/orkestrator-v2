import { describe, expect, test } from "bun:test";

import {
  MAX_REGISTERED_NODES,
  parseNodeRefusal,
  type NodeImportEntry,
  type NodeRoute,
} from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import { readStoredNodeRegistry } from "./node-store-format.js";

import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

async function attach(command: TestNode, leaf: TestNode) {
  return command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
}

function id(node: TestNode): BackendId {
  return node.storage.instanceId as BackendId;
}

async function addCommandable(network: TestNodeNetwork, name: string): Promise<TestNode> {
  return network.add(name, {
    forceRegistration: name === "desktop",
    extra: {
      selfAccess: async () => ({
        token: `token-${name}-secret`,
        origins: [`https://${name}.test`, "http://127.0.0.1:4000"],
      }),
    },
  });
}

async function controllersOf(node: TestNode): Promise<string[]> {
  return (await node.service.status()).controllers.map((entry) => String(entry.controllerId));
}

async function registryOf(node: TestNode): Promise<string[]> {
  return (await node.service.listNodes()).nodes.map((entry) => String(entry.nodeId)).sort();
}

describe("handing command to another node", () => {
  test("the new command node takes the machines and the old one, and detaches its controllers", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCommandable(network, "desktop");
    const mini = await addCommandable(network, "mini");
    const gram = await network.add("gram");
    const hp = await network.add("hp");
    const other = await network.add("other", { forceRegistration: true });
    await attach(desktop, mini);
    await attach(desktop, gram);
    await attach(desktop, hp);
    await attach(other, mini);
    expect((await mini.service.status()).mode).toBe("leaf");

    const preview = await desktop.service.previewHandover(id(mini));
    expect(preview.targetName).toBe("mini machine");
    expect(preview.candidates.map((entry) => String(entry.nodeId)).sort()).toEqual([
      "bk_gram",
      "bk_hp",
    ]);
    expect(preview.self).toMatchObject({ nodeId: "bk_desktop", reachable: true });

    const result = await desktop.service.handOverCommand({
      nodeId: id(mini),
      includeSelf: true,
      entries: [],
    });
    expect(result).toMatchObject({
      targetNodeId: "bk_mini",
      transferred: 3,
      selfIncluded: true,
      detachedControllers: 2,
    });
    await settle(60);

    expect(await registryOf(mini)).toEqual(["bk_desktop", "bk_gram", "bk_hp"]);
    expect((await mini.service.status()).mode).toBe("command");
    expect(await controllersOf(mini)).toEqual([]);
    // The other command node was detached as by the user, so it does not come back by itself.
    expect(
      (await mini.service.status()).detachedControllers.map((entry) => entry.controllerId),
    ).toEqual(["bk_other" as BackendId]);

    // The old command node follows as a leaf, reached over its HTTPS address only.
    expect(await controllersOf(desktop)).toEqual(["bk_mini"]);
    expect((await desktop.service.status()).mode).toBe("leaf");
    expect(await registryOf(desktop)).toEqual([]);
    const desktopRecord = (await mini.service.listNodes()).nodes.find(
      (entry) => entry.nodeId === "bk_desktop",
    );
    expect(
      desktopRecord?.routes.map((route) => (route.kind === "https" ? route.origin : "")),
    ).toEqual(["https://desktop.test"]);

    // Each machine has one command node.
    expect(await controllersOf(gram)).toEqual(["bk_mini"]);
    expect(await controllersOf(hp)).toEqual(["bk_mini"]);
  });

  test("command can be handed back, and only the chosen machines move", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCommandable(network, "desktop");
    const mini = await addCommandable(network, "mini");
    const gram = await network.add("gram");
    const hp = await network.add("hp");
    await attach(desktop, mini);
    await attach(desktop, gram);
    await attach(desktop, hp);

    await desktop.service.handOverCommand({
      nodeId: id(mini),
      nodeIds: [id(gram)],
      includeSelf: true,
      entries: [],
    });
    await settle(60);
    expect(await registryOf(mini)).toEqual(["bk_desktop", "bk_gram"]);
    // A machine left behind stays registered, suspended while its command node is a leaf.
    expect(await registryOf(desktop)).toEqual(["bk_hp"]);
    expect((await desktop.service.listNodes()).suspended).toBe(true);

    await mini.service.handOverCommand({ nodeId: id(desktop), includeSelf: true, entries: [] });
    await settle(60);
    expect((await desktop.service.status()).mode).toBe("command");
    expect(await registryOf(desktop)).toEqual(["bk_gram", "bk_hp", "bk_mini"]);
    expect(await controllersOf(mini)).toEqual(["bk_desktop"]);
    expect(await controllersOf(gram)).toEqual(["bk_desktop"]);
    expect(await controllersOf(hp)).toEqual(["bk_desktop"]);
  });

  test("machines saved on the client arrive with the handover; a failed handover changes nothing", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCommandable(network, "desktop");
    const mini = await addCommandable(network, "mini");
    const saved = await network.add("saved");
    await attach(desktop, mini);

    mini.online = false;
    await expect(
      desktop.service.handOverCommand({ nodeId: id(mini), includeSelf: true, entries: [] }),
    ).rejects.toThrow();
    expect(await registryOf(desktop)).toEqual(["bk_mini"]);
    mini.online = true;
    await desktop.service.reconnectNode(id(mini));

    await desktop.service.handOverCommand({
      nodeId: id(mini),
      includeSelf: false,
      entries: [
        {
          importedFrom: "device:saved",
          fallbackName: "saved",
          verifiedNodeId: id(saved),
          routes: [httpsRoute(saved)],
          routeOrder: ["primary" as RouteId],
          token: saved.token,
          enabled: true,
        },
      ],
    });
    await settle(60);
    expect(await registryOf(mini)).toEqual(["bk_saved"]);
    expect(await controllersOf(saved)).toEqual(["bk_mini"]);
    // Not sent itself, the old command node is left on its own and cannot re-attach.
    expect(await controllersOf(desktop)).toEqual([]);
    expect(await controllersOf(mini)).toEqual([]);
  });

  test("the old command node, refused while registered under its leaf, attaches after the handover", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCommandable(network, "desktop");
    const mini = await addCommandable(network, "mini");
    await attach(desktop, mini);
    // Registered under mini while mini is desktop's leaf: desktop refused the attachment.
    // Leaving leaf mode restarts mini's suspended links, so it attaches now.
    await mini.storage.mutateNodeRegistry((current) => ({
      next: {
        ...current,
        registrationEnabled: true,
        nodes: [
          ...current.nodes,
          {
            nodeId: id(desktop),
            enabled: true,
            routes: [httpsRoute(desktop)],
            routeOrder: ["primary" as RouteId],
            credential: { token: desktop.token },
            fallbackName: "desktop",
            attachment: { status: "refused", reason: "controller-is-subordinate" },
            addedAt: "2026-10-22T00:00:00.000Z",
            source: "portal",
          },
        ],
      },
      result: undefined,
    }));
    await mini.service.stop();
    await mini.service.start();
    await settle(30);
    expect(await controllersOf(desktop)).toEqual([]);

    await desktop.service.handOverCommand({ nodeId: id(mini), includeSelf: true, entries: [] });
    await settle(60);
    expect(await controllersOf(desktop)).toEqual(["bk_mini"]);
    expect((await mini.service.status()).mode).toBe("command");
  });

  test("only an attached command node can hand command to a node", async () => {
    const network = new TestNodeNetwork();
    const mini = await addCommandable(network, "mini");
    const error = await mini.service.acceptHandover("bk_stranger", []).catch((caught) => caught);
    expect(parseNodeRefusal(String((error as Error).message))?.code).toBe("not-controller");
  });

  test("a leaf cannot hand over command it does not have", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCommandable(network, "desktop");
    const mini = await addCommandable(network, "mini");
    await attach(desktop, mini);
    const error = await mini.service
      .handOverCommand({ nodeId: id(desktop), includeSelf: true, entries: [] })
      .catch((caught) => caught);
    expect(parseNodeRefusal(String((error as Error).message))?.code).toBe("node-is-subordinate");
  });
});

describe("handover recovery and invariants", () => {
  for (const nodeIds of [[], ["bk_extra"]]) {
    test(`cleans up machines already controlled by target with explicit selection ${JSON.stringify(nodeIds)}`, async () => {
      const network = new TestNodeNetwork();
      const source = await addCommandable(network, "desktop");
      const target = await network.add("target", { forceRegistration: true });
      const overlap = await network.add("overlap");
      const extra = await network.add("extra");
      await attach(target, overlap);
      await attach(source, overlap);
      await attach(source, extra);
      await attach(source, target);
      expect(
        (await source.service.previewHandover(id(target))).candidates.map((entry) => entry.nodeId),
      ).toEqual([id(extra)]);
      await source.service.handOverCommand({
        nodeId: id(target),
        nodeIds,
        includeSelf: true,
        entries: [],
      });
      await settle(60);
      expect(await registryOf(source)).toEqual(nodeIds.length ? [] : [id(extra)]);
      expect(await controllersOf(overlap)).toEqual([id(target)]);
      expect((await source.service.listNodes()).pendingDetaches).toEqual([]);
    });
  }

  test("rejects target capacity atomically and retains every machine on the source", async () => {
    const network = new TestNodeNetwork();
    const source = await addCommandable(network, "desktop");
    const target = await network.add("target", { forceRegistration: true });
    const first = await network.add("first");
    const second = await network.add("second");
    await attach(target, await network.add("existing"));
    const record = target.storage.registry.nodes[0]!;
    target.storage.registry.nodes = Array.from(
      { length: MAX_REGISTERED_NODES - 1 },
      (_, index) => ({ ...record, nodeId: `bk_existing${index}` as BackendId, enabled: false }),
    );
    await target.service.stop();
    await target.service.start();
    await attach(source, target);
    await attach(source, first);
    await attach(source, second);
    const before = await registryOf(target);
    const error = await source.service
      .handOverCommand({ nodeId: id(target), includeSelf: true, entries: [] })
      .catch((caught) => caught);
    expect(parseNodeRefusal((error as Error).message)?.code).toBe("too-many-nodes");
    expect(await registryOf(source)).toEqual([id(first), id(second), id(target)].sort());
    expect(await registryOf(target)).toEqual(before);
    expect(await controllersOf(first)).toEqual([id(source)]);
    expect(await controllersOf(target)).toEqual([id(source)]);
    expect(source.storage.registry.pendingHandover).toBeUndefined();
  });

  test("a lost response after acceptance retries the same durable receipt", async () => {
    const network = new TestNodeNetwork();
    let loseResponse = true;
    let accepts = 0;
    const source = await network.add("desktop", {
      forceRegistration: true,
      extra: {
        selfAccess: async () => ({
          token: "token-desktop-secret",
          origins: ["https://desktop.test"],
        }),
        fetchImpl: (async (url, init) => {
          const response = await network.fetch(url, init);
          if (
            String(url).endsWith("/invoke") &&
            JSON.parse(String(init?.body)).command === "accept_command_handover"
          ) {
            accepts += 1;
            if (loseResponse) {
              loseResponse = false;
              throw new TypeError("response lost after commit");
            }
          }
          return response;
        }) as typeof fetch,
      },
    });
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    await attach(source, target);
    await attach(source, moved);
    const result = await source.service.handOverCommand({
      nodeId: id(target),
      includeSelf: true,
      entries: [],
    });
    await settle(60);
    expect(result.transferred).toBe(2);
    expect(accepts).toBe(2);
    expect(target.storage.registry.handoverReceipts).toHaveLength(1);
    expect(await registryOf(source)).toEqual([]);
    expect(await controllersOf(source)).toEqual([id(target)]);
    expect(await controllersOf(moved)).toEqual([id(target)]);
    expect(await controllersOf(target)).toEqual([]);
  });

  test("restart recovers a committed handover whose responses were all lost", async () => {
    const network = new TestNodeNetwork();
    let loseResponses = true;
    const source = await network.add("desktop", {
      forceRegistration: true,
      extra: {
        selfAccess: async () => ({
          token: "token-desktop-secret",
          origins: ["https://desktop.test"],
        }),
        fetchImpl: (async (url, init) => {
          const response = await network.fetch(url, init);
          if (
            loseResponses &&
            String(url).endsWith("/invoke") &&
            JSON.parse(String(init?.body)).command === "accept_command_handover"
          )
            throw new TypeError("response lost");
          return response;
        }) as typeof fetch,
      },
    });
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    await attach(source, target);
    await attach(source, moved);
    await expect(
      source.service.handOverCommand({ nodeId: id(target), includeSelf: true, entries: [] }),
    ).rejects.toThrow();
    await settle(40);
    expect(source.storage.registry.pendingHandover).toBeDefined();
    expect(await registryOf(source)).toEqual([id(moved)]);
    expect(await controllersOf(source)).toEqual([id(target)]);
    // Exercise the production stored-format reader on both sides of recovery.
    source.storage.registry = readStoredNodeRegistry(
      JSON.parse(JSON.stringify(source.storage.registry)),
    ).registry;
    target.storage.registry = readStoredNodeRegistry(
      JSON.parse(JSON.stringify(target.storage.registry)),
    ).registry;
    await source.service.stop();
    await target.service.stop();
    loseResponses = false;
    await target.service.start();
    await source.service.start();
    await settle(80);
    expect(source.storage.registry.pendingHandover).toBeUndefined();
    expect(await registryOf(source)).toEqual([]);
    expect(await controllersOf(moved)).toEqual([id(target)]);
    expect(target.storage.registry.handoverReceipts).toHaveLength(1);
  });

  test("partial acceptance resumes after adoption without losing its original counts", async () => {
    const network = new TestNodeNetwork();
    const source = await addCommandable(network, "desktop");
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    await attach(source, target);
    await attach(source, moved);
    const mutate = target.storage.mutateNodeAttachments.bind(target.storage);
    let fail = true;
    target.storage.mutateNodeAttachments = async (operation) => {
      if (fail) {
        fail = false;
        throw new Error("attachment write failed");
      }
      return mutate(operation);
    };
    const result = await source.service.handOverCommand({
      nodeId: id(target),
      includeSelf: false,
      entries: [],
    });
    await settle(60);
    expect(result.transferred).toBe(1);
    expect(await registryOf(source)).toEqual([]);
    expect(await controllersOf(moved)).toEqual([id(target)]);
    expect(await controllersOf(target)).toEqual([]);
  });

  test("retains the interactive SSH lease until acceptance finishes", async () => {
    const network = new TestNodeNetwork();
    let leases = 0;
    let acquisitions = 0;
    const source = await network.add("desktop", {
      forceRegistration: true,
      extra: {
        createSsh: () => ({
          acquire: async (_spec, options) => {
            if (!options.interactive) throw new Error("SSH password required");
            acquisitions += 1;
            leases += 1;
            return {
              localOrigin: "https://target.test",
              release: () => {
                leases -= 1;
              },
              onClosed: () => () => undefined,
            };
          },
        }),
      },
    });
    const target = await addCommandable(network, "target");
    await source.service.addNode({
      routes: [
        {
          id: "ssh",
          kind: "ssh",
          enabled: true,
          destination: "user@target",
          remoteGatewayPort: 4000,
        },
      ],
      token: target.token,
    });
    expect(leases).toBe(1);
    const before = acquisitions;
    target.commands.set("accept_command_handover", async (args) => {
      expect(leases).toBe(1);
      return target.service.acceptHandover(
        args.controllerId,
        args.entries as NodeImportEntry[],
        args.handoverId,
      );
    });
    await source.service.handOverCommand({ nodeId: id(target), includeSelf: false, entries: [] });
    expect(acquisitions).toBe(before);
    expect(leases).toBe(0);
  });

  test("offline detach tombstones retry even after the source becomes a leaf", async () => {
    const network = new TestNodeNetwork();
    const source = await addCommandable(network, "desktop");
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    await attach(source, target);
    await attach(source, moved);
    moved.online = false;
    await source.service.handOverCommand({ nodeId: id(target), includeSelf: true, entries: [] });
    await settle(40);
    expect((await source.service.status()).mode).toBe("leaf");
    expect((await source.service.listNodes()).pendingDetaches.map((entry) => entry.nodeId)).toEqual(
      [id(moved)],
    );
    moved.online = true;
    await source.service.stop();
    await source.service.start();
    await target.service.reconnectNode(id(moved));
    await settle(60);
    expect(await controllersOf(moved)).toEqual([id(target)]);
    expect((await source.service.listNodes()).pendingDetaches).toEqual([]);
  });

  test("unregistered target preview and unreachable self do not need a connection", async () => {
    const network = new TestNodeNetwork();
    const source = await network.add("desktop", {
      forceRegistration: true,
      extra: {
        selfAccess: async () => ({
          token: "token-desktop-secret",
          origins: ["http://127.0.0.1:4000", "https://localhost"],
        }),
      },
    });
    const target = await network.add("target");
    const moved = await network.add("moved");
    await attach(source, moved);
    const preview = await source.service.previewHandover(id(target));
    expect(preview).toMatchObject({
      targetRegistered: false,
      targetNodeIds: [],
      self: { reachable: false },
    });
    expect(preview.candidates.map((entry) => entry.nodeId)).toEqual([id(moved)]);
    expect(target.received).toEqual([]);
  });

  test("concurrent handovers and machine edits cannot race the pending selection", async () => {
    const network = new TestNodeNetwork();
    const source = await addCommandable(network, "desktop");
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    const extra = await network.add("extra");
    await attach(source, target);
    await attach(source, moved);
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    target.commands.set("accept_command_handover", async (args) => {
      entered();
      await gate;
      return target.service.acceptHandover(
        args.controllerId,
        args.entries as NodeImportEntry[],
        args.handoverId,
      );
    });
    const handover = source.service.handOverCommand({
      nodeId: id(target),
      nodeIds: [id(moved)],
      includeSelf: false,
      entries: [],
    });
    await paused;
    try {
      await expect(
        source.service.handOverCommand({ nodeId: id(target), includeSelf: true, entries: [] }),
      ).rejects.toThrow("already in progress");
      await expect(
        source.service.updateNode({ nodeId: id(moved), enabled: false }),
      ).rejects.toThrow("pending command handover");
      await expect(source.service.forgetNode({ nodeId: id(moved) })).rejects.toThrow(
        "pending command handover",
      );
      await attach(source, extra);
    } finally {
      resume();
    }
    await handover;
    await settle(50);
    expect(await registryOf(source)).toEqual([id(extra)]);
    expect(await controllersOf(moved)).toEqual([id(target)]);
    expect(await controllersOf(extra)).toEqual([id(source)]);
  });

  test("SSH handover routes omit source-local private key paths", async () => {
    const network = new TestNodeNetwork();
    const source = await network.add("desktop", {
      forceRegistration: true,
      extra: {
        createSsh: () => ({
          acquire: async () => ({
            localOrigin: "https://moved.test",
            release: () => undefined,
            onClosed: () => () => undefined,
          }),
        }),
      },
    });
    const target = await addCommandable(network, "target");
    const moved = await network.add("moved");
    await attach(source, target);
    await source.service.addNode({
      token: moved.token,
      routes: [
        {
          id: "ssh",
          kind: "ssh",
          enabled: true,
          destination: "user@moved",
          identityFile: "/source/private-key",
          remoteGatewayPort: 4000,
        },
      ],
    });
    await source.service.handOverCommand({ nodeId: id(target), includeSelf: false, entries: [] });
    const received = (await target.service.listNodes()).nodes.find(
      (entry) => entry.nodeId === id(moved),
    );
    expect(received?.routes[0]).toMatchObject({ kind: "ssh", destination: "user@moved" });
    expect(received?.routes[0]).not.toHaveProperty("identityFile");
  });
});

test("target capacity is checked again atomically if its registry changes after preview", async () => {
  const network = new TestNodeNetwork();
  const source = await addCommandable(network, "desktop");
  const target = await network.add("target", { forceRegistration: true });
  const moved = await network.add("moved");
  await attach(target, await network.add("existing"));
  await attach(source, target);
  await attach(source, moved);
  target.commands.set("accept_command_handover", async (args) => {
    const record = target.storage.registry.nodes[0]!;
    target.storage.registry.nodes = Array.from(
      { length: MAX_REGISTERED_NODES - 1 },
      (_, index) => ({ ...record, nodeId: `bk_existing${index}` as BackendId, enabled: false }),
    );
    await target.service.stop();
    await target.service.start();
    return target.service.acceptHandover(
      args.controllerId,
      args.entries as NodeImportEntry[],
      args.handoverId,
    );
  });
  const error = await source.service
    .handOverCommand({ nodeId: id(target), includeSelf: true, entries: [] })
    .catch((caught) => caught);
  expect(parseNodeRefusal((error as Error).message)?.code).toBe("too-many-nodes");
  expect(await registryOf(source)).toEqual([id(moved), id(target)]);
  expect(await controllersOf(moved)).toEqual([id(source)]);
  expect(await controllersOf(target)).toEqual([id(source)]);
  expect(target.storage.registry.nodes.some((node) => node.nodeId === id(moved))).toBe(false);
  expect(target.storage.registry.handoverReceipts).toBeUndefined();
  expect(source.storage.registry.pendingHandover).toBeUndefined();
});

test("overlap cleanup also gives the target a credential it was missing", async () => {
  const network = new TestNodeNetwork();
  const source = await addCommandable(network, "desktop");
  const target = await network.add("target", { forceRegistration: true });
  const overlap = await network.add("overlap");
  await attach(target, overlap);
  target.storage.registry.nodes[0]!.credential = null;
  await target.service.stop();
  await target.service.start();
  await attach(source, overlap);
  await attach(source, target);
  await source.service.handOverCommand({
    nodeId: id(target),
    nodeIds: [],
    includeSelf: false,
    entries: [],
  });
  await settle(60);
  expect((await target.storage.getNodeRegistry()).nodes[0]!.credential?.token).toBe(overlap.token);
  expect(await registryOf(source)).toEqual([]);
  expect(await controllersOf(overlap)).toEqual([id(target)]);
});

test("replaying a completed receipt cannot detach a controller attached afterwards", async () => {
  const network = new TestNodeNetwork();
  const source = await addCommandable(network, "desktop");
  const target = await network.add("target", { forceRegistration: true });
  await attach(source, target);
  await source.service.handOverCommand({ nodeId: id(target), includeSelf: false, entries: [] });
  const receipt = target.storage.registry.handoverReceipts![0]!;
  await target.service.allowController(id(source));
  await attach(source, target);
  await target.service.acceptHandover(id(source), [], receipt.id);
  expect(await controllersOf(target)).toEqual([id(source)]);
  expect(target.storage.registry.handoverReceipts).toHaveLength(1);
});
