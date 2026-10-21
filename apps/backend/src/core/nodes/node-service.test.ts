import { describe, expect, test } from "bun:test";

import {
  NODE_STATUS_CHANGED_EVENT,
  NODES_CHANGED_EVENT,
  parseNodeRefusal,
  type NodeRoute,
} from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";

import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";

function httpsRoute(node: TestNode, id = "primary"): NodeRoute {
  return { id: id as RouteId, kind: "https", enabled: true, origin: node.origin };
}

async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return parseNodeRefusal(error instanceof Error ? error.message : String(error))?.code ?? null;
  }
}

async function attach(command: TestNode, leaf: TestNode) {
  return command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
}

describe("RM-01/RM-02 node mode and the command-node setting", () => {
  test("a node is standalone until it commands an attached node, and registration needs the setting", async () => {
    const network = new TestNodeNetwork();
    const vps = await network.add("vps");
    const leaf = await network.add("leaf");
    expect((await vps.service.status()).mode).toBe("standalone");
    expect((await vps.service.status()).registrationEnabled).toBe(false);
    expect(await refusalOf(attach(vps, leaf))).toBe("registration-disabled");

    await vps.service.setRegistrationEnabled(true);
    const view = await attach(vps, leaf);
    expect(view.attachment.status).toBe("attached");
    expect(view.connection.state).toBe("connected");
    expect((await vps.service.status()).mode).toBe("command");
    expect(vps.events.some((entry) => entry.event === NODE_STATUS_CHANGED_EVENT)).toBe(true);
  });

  test("the desktop's local backend (--command-node) can always register and cannot turn it off", async () => {
    const network = new TestNodeNetwork();
    const desktop = await network.add("desktop", { forceRegistration: true });
    expect((await desktop.service.status()).registrationEnabled).toBe(true);
    await expect(desktop.service.setRegistrationEnabled(false)).rejects.toThrow(
      "registration stays enabled",
    );
  });
});

describe("AT-01/AT-04/RM-05 attachment records on the leaf", () => {
  test("the leaf records each command node's identity, name and time, and the most recent contact", async () => {
    const network = new TestNodeNetwork();
    const first = await network.add("first", { forceRegistration: true });
    const second = await network.add("second", { forceRegistration: true });
    const leaf = await network.add("leaf");

    await attach(first, leaf);
    await attach(second, leaf);
    const controllers = leaf.service.listControllers();
    expect(controllers.map((entry) => String(entry.controllerId)).sort()).toEqual([
      "bk_first",
      "bk_second",
    ]);
    expect(controllers.find((entry) => entry.controllerId === "bk_first")?.displayName).toBe(
      "first machine",
    );
    expect(Date.parse(controllers[0]!.attachedAt)).not.toBeNaN();
    expect((await leaf.service.status()).mode).toBe("leaf");

    // Every request from a command node carries its identity.
    expect(leaf.received.every((entry) => entry.controller !== null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.service.link(leaf.storage.instanceId as never)!.invoke("list_controllers");
    expect(leaf.service.mostRecentControllerId()).toBe("bk_first" as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await second.service.link(leaf.storage.instanceId as never)!.invoke("list_controllers");
    expect(leaf.service.mostRecentControllerId()).toBe("bk_second" as never);
  });

  test("a contact header from an unattached node is ignored", async () => {
    const network = new TestNodeNetwork();
    const leaf = await network.add("leaf");
    leaf.service.noteControllerContact("bk_stranger");
    expect(leaf.service.listControllers()).toEqual([]);
    expect(leaf.service.mostRecentControllerId()).toBeUndefined();
  });
});

describe("AT-03 portal origins", () => {
  test("attaching registers the command node's portal origins on the leaf; detaching removes them", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    expect(leaf.service.isPortalOriginAllowed("https://command.test")).toBe(false);
    await attach(command, leaf);
    expect(leaf.service.isPortalOriginAllowed("https://command.test")).toBe(true);
    expect(leaf.service.isPortalOriginAllowed("https://other.test")).toBe(false);
    await command.service.forgetNode({ nodeId: "bk_leaf" });
    expect(leaf.service.isPortalOriginAllowed("https://command.test")).toBe(false);
  });
});

describe("RM-03/RM-04/LM-05/MG-02 leaf mode", () => {
  test("a command node attached to another suspends its own links and resumes when detached", async () => {
    const network = new TestNodeNetwork();
    const top = await network.add("top", { forceRegistration: true });
    const middle = await network.add("middle", { forceRegistration: true });
    const bottom = await network.add("bottom");

    await attach(middle, bottom);
    expect((await middle.service.status()).mode).toBe("command");
    expect(middle.service.link("bk_bottom" as never)!.connected).toBe(true);

    const view = await attach(top, middle);
    expect(view.connection.remoteMode).toBe("leaf");
    const status = await middle.service.status();
    expect(status.mode).toBe("leaf");
    expect(status.suspendedSubordinateCount).toBe(1);
    expect(status.controllers.map((entry) => entry.controllerId)).toEqual(["bk_top" as never]);
    // The registry is kept, but no link runs.
    const listed = await middle.service.listNodes();
    expect(listed.suspended).toBe(true);
    expect(listed.nodes.map((node) => node.connection.state)).toEqual(["suspended"]);
    expect(middle.service.link("bk_bottom" as never)!.connected).toBe(false);
    // The controller sees only the middle node's own state: the registry
    // commands it could use to reach `bottom` are refused in leaf mode.
    expect(
      await refusalOf(middle.service.addNode({ routes: [httpsRoute(bottom)], token: "x" })),
    ).toBe("node-is-subordinate");
    expect(await refusalOf(middle.service.reconnectNode("bk_bottom"))).toBe("node-is-subordinate");

    await top.service.forgetNode({ nodeId: "bk_middle" });
    await settle();
    expect((await middle.service.status()).mode).toBe("command");
    expect(middle.service.link("bk_bottom" as never)!.connected).toBe(true);
  });
});

describe("RM-07 two levels only", () => {
  test("a leaf-mode node cannot register nodes, and a controller cannot be attached under its own leaf", async () => {
    const network = new TestNodeNetwork();
    const top = await network.add("top", { forceRegistration: true });
    const leaf = await network.add("leaf", { forceRegistration: true });
    const other = await network.add("other");
    await attach(top, leaf);

    expect(await refusalOf(attach(leaf, other))).toBe("node-is-subordinate");
    // Leaf trying to attach its own controller: refused before anything is stored.
    expect(await refusalOf(attach(leaf, top))).toBe("node-is-subordinate");
    expect((await leaf.service.listNodes()).nodes).toEqual([]);
  });

  test("attach_controller refuses a controller that is this node's own subordinate", async () => {
    const network = new TestNodeNetwork();
    const a = await network.add("a", { forceRegistration: true });
    const b = await network.add("b", { forceRegistration: true });
    await attach(a, b);
    // b is a leaf of a; a asking b to become its controller would be a cycle.
    expect(
      await refusalOf(
        b.service
          .attachController({ controllerId: "bk_a", displayName: "a" })
          .then(() => a.service.attachController({ controllerId: "bk_b", displayName: "b" })),
      ),
    ).toBe("controller-is-subordinate");
    expect(
      await refusalOf(a.service.attachController({ controllerId: "bk_a", displayName: "a" })),
    ).toBe("self-attach");
  });

  test("a route that reaches this node itself is refused", async () => {
    const network = new TestNodeNetwork();
    const node = await network.add("self", { forceRegistration: true });
    expect(await refusalOf(attach(node, node))).toBe("self-attach");
  });
});

describe("RG-01/RG-02 the registry and credential handling", () => {
  test("stores identity, profile, routes, credential and state; no view or event carries the token", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);

    const stored = command.storage.registry.nodes[0]!;
    expect(stored.nodeId).toBe("bk_leaf" as never);
    expect(stored.credential).toEqual({ token: leaf.token });
    expect(stored.profileCache?.displayName).toBe("leaf machine");
    expect(stored.routes).toEqual([httpsRoute(leaf)]);
    expect(stored.enabled).toBe(true);

    const listed = await command.service.listNodes();
    const serialized = JSON.stringify([listed, await command.service.status(), command.events]);
    expect(serialized).not.toContain(leaf.token);
    expect(listed.nodes[0]!.hasCredential).toBe(true);
    expect(listed.nodes[0]!.displayName).toBe("leaf machine");
    expect(command.events.some((entry) => entry.event === NODES_CHANGED_EVENT)).toBe(true);
    // The leaf never stores the command node's credential (it has none to store).
    expect(JSON.stringify(leaf.storage.attachments)).not.toContain(leaf.token);
  });

  test("a live profile change updates the cached name and colour; an older revision does not", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    const updatedAt = "2026-10-21T01:00:00.000Z";

    await command.service.recordProfile("bk_leaf" as never, {
      revision: 2,
      displayName: "renamed",
      colorToken: "rose",
      updatedAt,
    });
    let view = (await command.service.listNodes()).nodes[0]!;
    expect(view.colorToken).toBe("rose");
    expect(view.displayName).toBe("renamed");

    await command.service.recordProfile("bk_leaf" as never, {
      revision: 1,
      displayName: "stale",
      colorToken: "amber",
      updatedAt,
    });
    view = (await command.service.listNodes()).nodes[0]!;
    expect(view.colorToken).toBe("rose");
  });

  test("disabling a node stops its link without touching the node", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    const before = leaf.received.length;
    const view = await command.service.updateNode({ nodeId: "bk_leaf", enabled: false });
    expect(view.connection.state).toBe("disabled");
    expect(leaf.received.length).toBe(before);
  });
});

describe("RG-03 route verification", () => {
  test("falls back to the next route only for ordinary network failures", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    const view = await command.service.addNode({
      routes: [
        { id: "dead", kind: "https", enabled: true, origin: "https://unreachable.test" },
        httpsRoute(leaf, "live"),
      ],
      token: leaf.token,
    });
    expect(view.connection.state).toBe("connected");
    expect(view.connection.activeRouteId).toBe("live" as never);
  });

  test("an identity mismatch quarantines the link and no other route is tried", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    const twin = await network.add("twin");
    twin.token = leaf.token;
    await attach(command, leaf);
    await command.service.updateNode({
      nodeId: "bk_leaf",
      routes: [httpsRoute(twin, "wrong"), httpsRoute(leaf, "right")],
    });
    await settle();
    const node = (await command.service.listNodes()).nodes[0]!;
    expect(node.connection.state).toBe("quarantined");
    expect(node.connection.lastError?.code).toBe("identity-mismatch");
    // The second (correct) route was not used to get around the mismatch.
    expect(leaf.received.filter((entry) => entry.command === "attach_controller")).toHaveLength(1);
  });

  test("a rejected gateway token stops the link instead of trying other routes", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    leaf.token = "rotated";
    await command.service.reconnectNode("bk_leaf");
    const node = (await command.service.listNodes()).nodes[0]!;
    expect(node.connection.state).toBe("needs-credential");
  });

  test("an unreachable node keeps its record and retries in the background", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    leaf.online = false;
    await command.service.reconnectNode("bk_leaf");
    expect((await command.service.listNodes()).nodes[0]!.connection.state).toBe("unavailable");
    leaf.online = true;
    network.timers.runAll();
    await settle();
    expect((await command.service.listNodes()).nodes[0]!.connection.state).toBe("connected");
  });
});

describe("AT-05 older nodes", () => {
  test("a node without the node-attachment capability is refused as needing an update", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const old = await network.add("old");
    old.legacy = true;
    expect(await refusalOf(attach(command, old))).toBe("needs-update");
  });
});

describe("AT-02/RG-07/SC-03 forgetting and detaching", () => {
  test("forgetting detaches the leaf and calls nothing else on it", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    const before = leaf.received.length;
    expect(await command.service.forgetNode({ nodeId: "bk_leaf" })).toEqual({
      forgotten: true,
      detached: true,
    });
    expect(leaf.received.slice(before).map((entry) => entry.command)).toEqual([
      "detach_controller",
    ]);
    expect(leaf.service.listControllers()).toEqual([]);
    expect((await command.service.listNodes()).pendingDetaches).toEqual([]);
  });

  test("an offline leaf keeps a pending detach until it can confirm, or the user drops it", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    leaf.online = false;
    expect(await command.service.forgetNode({ nodeId: "bk_leaf" })).toEqual({
      forgotten: true,
      detached: false,
    });
    const pending = (await command.service.listNodes()).pendingDetaches;
    expect(pending.map((entry) => entry.nodeId)).toEqual(["bk_leaf" as never]);
    expect(JSON.stringify(pending)).not.toContain(leaf.token);
    expect((await leaf.service.status()).mode).toBe("leaf");

    await command.service.discardPendingDetach("bk_leaf");
    expect((await command.service.listNodes()).pendingDetaches).toEqual([]);
  });

  test("the user can detach a command node on the leaf itself, and it stays detached until allowed", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", {
      forceRegistration: true,
      extra: { heartbeatMs: 1 },
    });
    const leaf = await network.add("leaf");
    await attach(command, leaf);
    const before = leaf.received.length;
    expect(await leaf.service.detachController("bk_command", { byUser: true })).toEqual({
      detached: true,
    });
    const status = await leaf.service.status();
    expect(status.mode).toBe("standalone");
    expect(status.detachedControllers.map((entry) => String(entry.controllerId))).toEqual([
      "bk_command",
    ]);

    // The command node's next heartbeat notices, and its re-attach is refused.
    network.timers.runAll();
    await settle();
    const node = (await command.service.listNodes()).nodes[0]!;
    expect(node.attachment.status).toBe("refused");
    expect(node.attachment.reason).toBe("detached-on-node");
    expect(node.connection.state).toBe("unavailable");
    expect(leaf.service.listControllers()).toEqual([]);
    // Detaching never stopped anything: only node commands reached the leaf.
    expect(
      leaf.received
        .slice(before)
        .every((entry) =>
          [
            "list_controllers",
            "attach_controller",
            "get_projects",
            "get_environment_snapshots",
          ].includes(entry.command),
        ),
    ).toBe(true);

    await leaf.service.allowController("bk_command");
    await command.service.reconnectNode("bk_leaf");
    expect((await command.service.listNodes()).nodes[0]!.attachment.status).toBe("attached");
  });
});

describe("MG-01/MG-03 importing the desktop's saved machines", () => {
  test("imports once per catalogue entry, attaches verified machines and marks missing credentials", async () => {
    const network = new TestNodeNetwork();
    const desktop = await network.add("desktop", { forceRegistration: true });
    const leaf = await network.add("leaf");
    const unverified = await network.add("unverified");

    const entries = [
      {
        importedFrom: "saved-1",
        fallbackName: "leaf",
        verifiedNodeId: "bk_leaf" as never,
        routes: [httpsRoute(leaf)],
        routeOrder: ["primary" as RouteId],
        token: leaf.token,
        enabled: true,
      },
      {
        importedFrom: "saved-2",
        fallbackName: "never verified",
        routes: [httpsRoute(unverified)],
        routeOrder: ["primary" as RouteId],
        token: unverified.token,
        enabled: true,
      },
      {
        importedFrom: "saved-3",
        fallbackName: "no token",
        routes: [
          {
            id: "x" as RouteId,
            kind: "https" as const,
            enabled: true,
            origin: "https://gone.test",
          },
        ],
        routeOrder: [],
        token: null,
        enabled: true,
      },
    ];
    expect(await desktop.service.importDesktopConnections(entries)).toEqual({
      imported: 3,
      skipped: 0,
      needsCredential: 1,
    });
    await settle();
    const nodes = (await desktop.service.listNodes()).nodes;
    const byName = new Map(nodes.map((node) => [node.fallbackName, node]));
    expect(byName.get("leaf")!.connection.state).toBe("connected");
    expect(byName.get("leaf")!.source).toBe("desktop-migration");
    // The unverified entry adopted the identity its hello proved.
    expect(byName.get("never verified")!.nodeId).toBe("bk_unverified" as never);
    expect(byName.get("no token")!.connection.state).toBe("needs-credential");
    expect(leaf.service.listControllers().map((entry) => entry.controllerId)).toEqual([
      "bk_desktop" as never,
    ]);

    // A second run imports nothing, and a forgotten node is not re-imported.
    await desktop.service.forgetNode({ nodeId: "bk_leaf" });
    expect(await desktop.service.importDesktopConnections(entries)).toEqual({
      imported: 0,
      skipped: 3,
      needsCredential: 0,
    });
    expect(
      (await desktop.service.listNodes()).nodes.map((node) => node.fallbackName).sort(),
    ).toEqual(["never verified", "no token"]);
  });

  test("a migrated machine that commands its own leaves switches to leaf mode", async () => {
    const network = new TestNodeNetwork();
    const desktop = await network.add("desktop", { forceRegistration: true });
    const server = await network.add("server", { forceRegistration: true });
    const worker = await network.add("worker");
    await attach(server, worker);
    expect((await server.service.status()).mode).toBe("command");
    await desktop.service.importDesktopConnections([
      {
        importedFrom: "saved-server",
        fallbackName: "server",
        verifiedNodeId: "bk_server" as never,
        routes: [httpsRoute(server)],
        routeOrder: [],
        token: server.token,
        enabled: true,
      },
    ]);
    await settle();
    expect((await server.service.status()).mode).toBe("leaf");
    expect(server.service.link("bk_worker" as never)!.connected).toBe(false);
  });
});

describe("RG-04/RG-05 SSH routes from the command node's backend", () => {
  function fakeSsh(origin: () => string, fail?: () => Error | null) {
    const calls: Array<{ routeId: string; interactive: boolean }> = [];
    let prompt: ((p: never) => Promise<string | null>) | null = null;
    const provider = {
      acquire: async (spec: { routeId: string }, options: { interactive: boolean }) => {
        calls.push({ routeId: spec.routeId, interactive: options.interactive });
        const error = fail?.();
        if (error) throw error;
        return { localOrigin: origin(), release: () => undefined, onClosed: () => () => undefined };
      },
    };
    return {
      calls,
      createSsh: (handler: (p: never) => Promise<string | null>) => {
        prompt = handler;
        return provider;
      },
      prompt: () => prompt,
    };
  }

  test("provisional identity adoption retains an interactive SSH lease through attachment", async () => {
    const network = new TestNodeNetwork();
    const leaf = await network.add("adopted");
    let releases = 0;
    const interactive: boolean[] = [];
    const command = await network.add("command", {
      forceRegistration: true,
      extra: {
        createSsh: (() => ({
          acquire: async (_spec: unknown, options: { interactive: boolean }) => {
            interactive.push(options.interactive);
            if (!options.interactive) throw new Error("Interactive auth required");
            return {
              localOrigin: leaf.origin,
              release: () => {
                releases++;
              },
              onClosed: () => () => {},
            };
          },
        })) as never,
      },
    });
    await command.service.importDesktopConnections([
      {
        importedFrom: "ssh-unverified",
        fallbackName: "SSH",
        routes: [
          {
            id: "ssh" as never,
            kind: "ssh",
            enabled: true,
            destination: "leaf-host",
            remoteGatewayPort: 34122,
          },
        ],
        routeOrder: [],
        token: leaf.token,
        enabled: true,
      },
    ]);
    const imported = (await command.service.listNodes()).nodes[0]!;
    await command.service.reconnectNode(imported.nodeId);
    await settle();
    const adopted = (await command.service.listNodes()).nodes[0]!;
    expect(adopted.nodeId).toBe("bk_adopted" as never);
    expect(adopted.connection.state).toBe("connected");
    expect(interactive.at(-1)).toBe(true);
    expect(releases).toBe(0);
    expect(
      leaf.service.listControllers().some((entry) => entry.controllerId === "bk_command"),
    ).toBe(true);
  });

  test("a user-initiated add may prompt; background reconnects run in batch mode", async () => {
    const network = new TestNodeNetwork();
    const leaf = await network.add("leaf");
    const ssh = fakeSsh(() => leaf.origin);
    const command = await network.add("command", {
      forceRegistration: true,
      extra: { createSsh: ssh.createSsh as never },
    });
    const view = await command.service.addNode({
      routes: [
        {
          id: "ssh",
          kind: "ssh",
          enabled: true,
          destination: "leaf-host",
          remoteGatewayPort: 34122,
        },
      ],
      token: leaf.token,
    });
    expect(view.connection.state).toBe("connected");
    expect(view.connection.activeRouteKind).toBe("ssh");
    expect(ssh.calls.every((call) => call.interactive)).toBe(true);

    leaf.online = false;
    network.timers.runAll(); // heartbeat fails → background reconnect
    await settle();
    leaf.online = true;
    network.timers.runAll();
    await settle();
    expect(ssh.calls.at(-1)?.interactive).toBe(false);
  });

  test("a changed host key quarantines the node and no other route is tried", async () => {
    const network = new TestNodeNetwork();
    const leaf = await network.add("leaf");
    const error = Object.assign(new Error("Host key changed"), { code: "host-key-changed" });
    const ssh = fakeSsh(
      () => leaf.origin,
      () => error,
    );
    const command = await network.add("command", {
      forceRegistration: true,
      extra: { createSsh: ssh.createSsh as never },
    });
    await attach(command, leaf);
    await command.service.updateNode({
      nodeId: "bk_leaf",
      routes: [
        {
          id: "ssh",
          kind: "ssh",
          enabled: true,
          destination: "leaf-host",
          remoteGatewayPort: 34122,
        },
        httpsRoute(leaf, "https"),
      ],
    });
    await settle();
    const node = (await command.service.listNodes()).nodes[0]!;
    expect(node.connection.state).toBe("quarantined");
    expect(node.connection.lastError?.code).toBe("host-key-changed");
  });

  test("SSH prompts are relayed as events without the answer, and answered once", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const abort = new AbortController();
    const answer = command.service.prompts.ask("bk_leaf" as never, {
      kind: "passphrase",
      message: "Enter passphrase for key",
      signal: abort.signal,
    });
    const open = command.events.find((entry) => entry.event === "node-ssh-prompt")!.payload as {
      promptId: string;
      state: string;
    };
    expect(open.state).toBe("open");
    expect(command.service.answerSshPrompt({ promptId: open.promptId, answer: "hunter2" })).toEqual(
      {
        answered: true,
      },
    );
    expect(await answer).toBe("hunter2");
    expect(command.service.answerSshPrompt({ promptId: open.promptId, answer: "again" })).toEqual({
      answered: false,
    });
    expect(JSON.stringify(command.events)).not.toContain("hunter2");

    const cancelled = command.service.prompts.ask("bk_leaf" as never, {
      kind: "password",
      message: "Password",
      signal: abort.signal,
    });
    abort.abort();
    expect(await cancelled).toBeNull();
  });
});
