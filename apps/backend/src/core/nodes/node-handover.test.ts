import { describe, expect, test } from "bun:test";

import { parseNodeRefusal, type NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

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
