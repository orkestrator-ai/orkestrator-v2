import { describe, expect, spyOn, test } from "bun:test";

import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";
import { NODE_SUMMARY_CHANGED_EVENT } from "@orkestrator/protocol/node-summaries";

import { ClientGrantService } from "./client-grants.js";
import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

/** A leaf with one project and its environments, answering the summary reads. */
function seed(
  leaf: TestNode,
  environments: Array<{
    id: string;
    name: string;
    status?: string;
    order?: number;
    projectHome?: boolean;
  }>,
) {
  const state = { environments: [...environments] };
  leaf.commands.set("get_projects", () => [
    {
      id: "p1",
      name: "Website",
      order: 0,
      gitUrl: "git@github.com:acme/site.git",
      path: "/srv/secret",
    },
  ]);
  leaf.commands.set("get_environment_snapshots", () =>
    state.environments.map((environment) => ({
      ...environment,
      projectId: "p1",
      status: environment.status ?? "running",
      agentActivityState: "working",
    })),
  );
  return state;
}

async function commandWithLeaf() {
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  seed(leaf, [{ id: "e1", name: "feature-a" }]);
  await command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
  await settle(40);
  return { network, command, leaf };
}

describe("PT-01/PT-02/UP-01 the portal read model", () => {
  test("each attached command node subscribes and reads node-qualified summaries", async () => {
    const network = new TestNodeNetwork();
    const first = await network.add("first", { forceRegistration: true });
    const second = await network.add("second", { forceRegistration: true });
    const leaf = await network.add("leaf");
    seed(leaf, [{ id: "e1", name: "feature-a" }]);
    await first.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
    await second.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
    await settle(40);
    // Both command nodes hold their own event stream to the leaf.
    expect(leaf.streams.size).toBe(2);
    for (const command of [first, second]) {
      const result = await command.portal.summaries();
      const node = result.nodes[0]!;
      expect(node.available).toBe(true);
      expect(node.freshness).toBe("current");
      expect(node.projects.map((project) => project.ref)).toEqual([
        { backendId: "bk_leaf", projectId: "p1" } as never,
      ]);
      expect(node.projects[0]!.repositoryHint).toBe("github.com/acme/site");
      expect(JSON.stringify(node)).not.toContain("/srv/secret");
      expect(node.environments.map((environment) => environment.ref)).toEqual([
        { backendId: "bk_leaf", environmentId: "e1" } as never,
      ]);
      expect(node.environments[0]!.activity).toBe("working");
    }
  });

  test("an environment change on the leaf reaches the portal through the stream", async () => {
    const { command, leaf } = await commandWithLeaf();
    const state = seed(leaf, [
      { id: "e1", name: "feature-a" },
      { id: "e2", name: "feature-b" },
    ]);
    expect(state.environments).toHaveLength(2);
    leaf.emit("resource-changed", {
      resource: "environment",
      id: "e2",
      projectId: "p1",
      revision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const names = (await command.portal.summaries()).nodes[0]!.environments.map((e) => e.name);
    expect(names.sort()).toEqual(["feature-a", "feature-b"]);
    expect(command.events.some((entry) => entry.event === NODE_SUMMARY_CHANGED_EVENT)).toBe(true);
  });

  test("a client on a leaf's workspace can ask for the command node's own summary", async () => {
    const { command } = await commandWithLeaf();
    seed(command, [{ id: "c1", name: "home-env" }]);

    expect((await command.portal.summaries()).self).toBeUndefined();
    const self = (await command.portal.summaries(undefined, true)).self!;
    expect(self.nodeId).toBe("bk_command" as never);
    expect(self.displayName).toBe("command machine");
    expect(self.environments.map((environment) => environment.ref)).toEqual([
      { backendId: "bk_command", environmentId: "c1" } as never,
    ]);
    expect(JSON.stringify(self)).not.toContain("/srv/secret");

    // A local change is announced while a client watches the self summary.
    const state = seed(command, [
      { id: "c1", name: "home-env" },
      { id: "c2", name: "second" },
    ]);
    expect(state.environments).toHaveLength(2);
    command.events.length = 0;
    command.portal.readModel.noteLocalEvent("resource-changed", {
      resource: "environment",
      id: "c2",
      projectId: "p1",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(command.events).toContainEqual({
      event: NODE_SUMMARY_CHANGED_EVENT,
      payload: { nodeId: "bk_command", epoch: 0 },
    });
    const names = (await command.portal.summaries(undefined, true)).self!.environments.map(
      (environment) => environment.name,
    );
    expect(names.sort()).toEqual(["home-env", "second"]);
  });

  test("local changes are not announced when nobody watches the self summary", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    seed(command, [{ id: "c1", name: "home-env" }]);
    command.events.length = 0;
    command.portal.readModel.noteLocalEvent("resource-changed", {
      resource: "environment",
      id: "c1",
      projectId: "p1",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(command.events.some((entry) => entry.event === NODE_SUMMARY_CHANGED_EVENT)).toBe(false);
  });

  test("owner order survives hydration and per-project refresh, including home rows and fallback", async () => {
    const { network, command, leaf } = await commandWithLeaf();
    try {
      const state = seed(leaf, [
        { id: "last", name: "last", order: 4 },
        { id: "fallback", name: "fallback" },
        { id: "home", name: "home", order: 0, projectHome: true },
        { id: "first", name: "first", order: -1 },
      ]);
      await command.portal.readModel.requestHydrate("bk_leaf" as never);
      const rows = async () => (await command.portal.summaries()).nodes[0]!.environments;
      expect((await rows()).map((row) => [row.ref.environmentId, row.order])).toEqual([
        ["first", -1],
        ["home", 0],
        ["fallback", 1],
        ["last", 4],
      ]);
      expect((await rows())[1]!.isProjectHome).toBe(true);
      state.environments[0]!.order = -2;
      const reads = leaf.received.filter((entry) => entry.command === "get_projects").length;
      leaf.emit("resource-changed", {
        resource: "environment",
        id: "last",
        projectId: "p1",
        revision: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await rows()).map((row) => row.ref.environmentId)).toEqual([
        "last",
        "first",
        "home",
        "fallback",
      ]);
      expect(leaf.received.filter((entry) => entry.command === "get_projects")).toHaveLength(reads);
    } finally {
      for (const node of network.nodes.values()) node.portal.stop();
    }
  });

  test("the summary cap selects the first 500 owner positions, even from the storage tail", async () => {
    const { network, command, leaf } = await commandWithLeaf();
    try {
      seed(
        leaf,
        Array.from({ length: 502 }, (_, index) => ({
          id: `e${index}`,
          name: `Environment ${index}`,
          order: 501 - index,
        })),
      );
      await command.portal.readModel.requestHydrate("bk_leaf" as never);
      const node = (await command.portal.summaries()).nodes[0]!;
      expect(node.truncated).toBe(true);
      expect(node.environments).toHaveLength(500);
      expect(node.environments.map((row) => row.ref.environmentId)).toEqual(
        Array.from({ length: 500 }, (_, index) => `e${501 - index}`),
      );
    } finally {
      for (const node of network.nodes.values()) node.portal.stop();
    }
  });

  test("PT-04: an unavailable node keeps labelled last-known state and refuses writes", async () => {
    const { command, leaf } = await commandWithLeaf();
    leaf.online = false;
    leaf.dropStreams();
    await command.service.reconnectNode("bk_leaf");
    await settle(40);
    const node = (await command.portal.summaries()).nodes[0]!;
    expect(node.available).toBe(false);
    expect(node.freshness).toBe("stale");
    expect(node.environments.map((environment) => environment.name)).toEqual(["feature-a"]);
    await expect(
      command.portal.invokeOnNode({
        nodeId: "bk_leaf",
        command: "stop_environment",
        args: { environmentId: "e1" },
      }),
    ).rejects.toThrow("changes to it are disabled");
  });

  test("RM-04: a command node in leaf mode exposes only its own state to its controller", async () => {
    const network = new TestNodeNetwork();
    const top = await network.add("top", { forceRegistration: true });
    const middle = await network.add("middle", { forceRegistration: true });
    const bottom = await network.add("bottom");
    seed(bottom, [{ id: "b1", name: "bottom-env" }]);
    await middle.service.addNode({ routes: [httpsRoute(bottom)], token: bottom.token });
    await top.service.addNode({ routes: [httpsRoute(middle)], token: middle.token });
    await settle(40);
    // The controller cannot reach `bottom` through `middle`.
    await expect(
      top.portal.invokeOnNode({ nodeId: "bk_middle", command: "get_node_summaries", args: {} }),
    ).rejects.toThrow("cannot be run on another node");
    await expect(
      top.portal.invokeOnNode({ nodeId: "bk_middle", command: "list_nodes", args: {} }),
    ).rejects.toThrow("cannot be run on another node");
    // And middle, in leaf mode, routes nothing itself.
    expect(middle.portal.relayTarget("bk_bottom" as never)).toBeNull();
    await expect(
      middle.portal.invokeOnNode({ nodeId: "bk_bottom", command: "get_projects", args: {} }),
    ).rejects.toThrow();
  });
});

describe("PT-02/PT-05 node-qualified routing", () => {
  test("routes a command to its owner with the controller identity", async () => {
    const { command, leaf } = await commandWithLeaf();
    leaf.commands.set("stop_environment", (args) => ({ stopped: args.environmentId }));
    const result = await command.portal.invokeOnNode({
      nodeId: "bk_leaf",
      command: "stop_environment",
      args: { environmentId: "e1" },
    });
    expect(result).toEqual({ outcome: "ok", result: { stopped: "e1" } });
    expect(leaf.received.find((entry) => entry.command === "stop_environment")).toEqual({
      command: "stop_environment",
      controller: "bk_command",
    });
  });

  test("a write whose answer is lost is recorded as outcome-unknown and never resent", async () => {
    const { command, leaf } = await commandWithLeaf();
    void leaf;
    let calls = 0;
    // Simulate an answer lost after the request was sent.
    const link = command.service.link("bk_leaf" as never)!;
    const invoke = link.invoke.bind(link);
    (link as unknown as { invoke: typeof link.invoke }).invoke = async (name, args) => {
      if (name === "start_environment_background") {
        calls += 1;
        const { NodeOutcomeUnknownError } = await import("./node-link.js");
        throw new NodeOutcomeUnknownError("lost");
      }
      return invoke(name, args);
    };
    const result = await command.portal.invokeOnNode({
      nodeId: "bk_leaf",
      command: "start_environment_background",
      args: { environmentId: "e1" },
      requestKey: "req-1",
    });
    expect(result).toMatchObject({ outcome: "unknown", requestKey: "req-1" });
    expect(calls).toBe(1);
    const recorded = command.portal.outcomes.list("bk_leaf");
    expect(recorded.map((entry) => entry.command)).toEqual(["start_environment_background"]);
    expect(await command.portal.outcomes.dismiss(recorded[0]!.outcomeId)).toBe(true);
  });
});

describe("DP-01/DP-02 leaf workspaces and client grants", () => {
  test("opening a workspace returns a short-lived grant (never the leaf token), direct origins and the relay base", async () => {
    const { command, leaf } = await commandWithLeaf();
    const opened = await command.portal.openWorkspace("bk_leaf");
    expect(opened.grant.token).not.toBe(leaf.token);
    expect(opened.grant.token.startsWith("okg_")).toBe(true);
    expect(opened.grant.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(opened.directOrigins).toEqual([leaf.origin]);
    expect(opened.relayBase).toBe("/__orkestrator/nodes/bk_leaf");
    expect(opened.commandRouteKind).toBe("https");
    // The leaf accepts the grant.
    expect(leaf.portal.grants.authenticate(opened.grant.token)?.controllerId).toBe(
      "bk_command" as never,
    );
    // Renewal extends it; closing revokes it.
    await command.portal.renewWorkspace(opened.workspaceId);
    expect(await command.portal.closeWorkspace(opened.workspaceId)).toEqual({ closed: true });
    expect(leaf.portal.grants.authenticate(opened.grant.token)).toBeNull();
  });

  test("detaching a command node revokes every grant it obtained", async () => {
    const { command, leaf } = await commandWithLeaf();
    const opened = await command.portal.openWorkspace("bk_leaf");
    await command.service.forgetNode({ nodeId: "bk_leaf" });
    expect(leaf.portal.grants.authenticate(opened.grant.token)).toBeNull();
  });

  test("only an attached command node can obtain grants", async () => {
    const network = new TestNodeNetwork();
    const leaf = await network.add("leaf");
    expect(() =>
      leaf.portal.createClientGrant({ controllerId: "bk_stranger", ttlSeconds: 60 }),
    ).toThrow("Only an attached command node");
  });

  test("grants expire, are capped at 15 minutes and are kept as hashes only", () => {
    let now = 1_000_000;
    const grants = new ClientGrantService(() => now);
    const { grant, token } = grants.issue({
      controllerId: "bk_c" as never,
      label: "workspace",
      ttlMs: 60 * 60_000,
    });
    expect(grant.expiresAt - now).toBe(15 * 60_000);
    expect(JSON.stringify(grants)).not.toContain(token.split(".")[1]);
    expect(grants.authenticate(token)?.grantId).toBe(grant.grantId);
    expect(grants.authenticate(`${token}x`)).toBeNull();
    expect(grants.authenticate("not-a-grant")).toBeNull();
    now += 15 * 60_000;
    expect(grants.authenticate(token)).toBeNull();
  });
});

test("maintenance polling does not hydrate project/environment summaries; writes still do", async () => {
  const { command, leaf } = await commandWithLeaf();
  leaf.commands.set("get_host_maintenance", () => ({ revision: 1 }));
  leaf.commands.set("repair_host_toolchain", () => ({ id: "repair" }));
  const hydrate = spyOn(command.portal.readModel, "requestHydrate");
  leaf.received.length = 0;
  try {
    for (let i = 0; i < 3; i++) {
      expect(
        await command.portal.invokeOnNode({
          nodeId: "bk_leaf",
          command: "get_host_maintenance",
          args: { detail: false },
        }),
      ).toMatchObject({ outcome: "ok" });
    }
    await settle(40);
    expect(hydrate).not.toHaveBeenCalled();
    expect(
      leaf.received.some((entry) =>
        ["get_projects", "get_environment_snapshots"].includes(entry.command),
      ),
    ).toBe(false);
    await command.portal.invokeOnNode({ nodeId: "bk_leaf", command: "repair_host_toolchain" });
    expect(hydrate).toHaveBeenCalledWith("bk_leaf");
  } finally {
    hydrate.mockRestore();
  }
});
