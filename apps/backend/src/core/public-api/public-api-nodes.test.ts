import { afterEach, describe, expect, test } from "bun:test";
import {
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import type {
  PublicAggregatePage,
  PublicNodeList,
  PublicProjectSummary,
} from "@orkestrator/protocol/public-api-resources";
import { call, cleanupNodeTopologies, topology } from "./node-test-support.js";
import { controlMcpAuthority } from "./operation-ledger.js";

/**
 * `request.node` end to end: a command node and a leaf, each with real
 * storage and the real `public_action`, joined by the in-memory node network.
 * The leaf is the test-provider harness, so it has a ready environment and a
 * project of its own.
 */

afterEach(cleanupNodeTopologies);

describe("node.list", () => {
  test("names this node and each leaf, and whether actions can be sent to it", async () => {
    const { command, leafId, commandId, leaf } = await topology();
    const listed = await call<PublicNodeList>(command, "node.list", {});
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.result.items.map((node) => [node.nodeId, node.self, node.publicActions])).toEqual(
      [
        [commandId, true, true],
        [leafId, false, true],
      ],
    );
    expect(listed.result.items[1]).toMatchObject({ available: true, state: "connected" });
    expect(JSON.stringify(listed)).not.toContain("token-leaf-secret");

    // The leaf is in leaf mode: it lists only itself and who controls it.
    const fromLeaf = await call<PublicNodeList>(leaf.harness, "node.list", {});
    if (!fromLeaf.ok) throw new Error(fromLeaf.error.message);
    expect(fromLeaf.result.mode).toBe("leaf");
    expect(fromLeaf.result.items).toHaveLength(1);
    expect(fromLeaf.result.controlledBy.map((entry) => entry.nodeId)).toEqual([commandId]);
  });

  test("always runs on the connected node", async () => {
    const { command, leafId } = await topology();
    const refused = await call(command, "node.list", {}, { node: leafId });
    expect(!refused.ok && refused.error.code).toBe("invalid-input");
  });
});

describe("request.node routes a public action to a leaf", () => {
  test("a read runs on the leaf and names it; the envelope stays the command node's", async () => {
    const { command, leaf, leafId } = await topology();
    const projects = await call<{ items: PublicProjectSummary[] }>(
      command,
      "project.list",
      {},
      { node: leafId },
    );
    if (!projects.ok) throw new Error(projects.error.message);
    expect(projects.result.items.map((project) => project.id)).toEqual([leaf.projectId]);
    expect(projects.node).toMatchObject({ nodeId: leafId, name: "leaf machine" });
    const own = await call(command, "capabilities", {});
    expect(projects.backend).toEqual(own.backend);
    // The command node's own projects are untouched.
    const local = await call<{ items: unknown[] }>(command, "project.list", {});
    expect(local.ok && local.result.items).toEqual([]);
  });

  test("this node's own ID runs locally", async () => {
    const { command, commandId } = await topology();
    const response = await call(command, "project.list", {}, { node: commandId });
    expect(response.ok).toBe(true);
    expect(response.node?.nodeId).toBe(commandId);
  });

  test("a mutation keeps its request key across the hop and replays", async () => {
    const { command, leaf, leafId } = await topology();
    const input = { projectId: leaf.projectId, title: "From the command node" };
    const first = await call(command, "ticket.create", input, {
      node: leafId,
      requestId: "ticket-1",
    });
    if (!first.ok) throw new Error(first.error.message);
    const again = await call(command, "ticket.create", input, {
      node: leafId,
      requestId: "ticket-1",
    });
    expect(again.receipt?.operationId).toBe(first.receipt!.operationId);
    expect(again.receipt?.replayed).toBe(true);
    // The leaf holds the operation; the command node holds none.
    const onCommand = await command.storage.getPublicOperation(first.receipt!.operationId);
    expect(onCommand.status).not.toBe("found");
    const onLeaf = await call(leaf.harness, "run.get", {
      operationId: first.receipt!.operationId,
    });
    expect(onLeaf.ok).toBe(true);
    const conflict = await call(
      command,
      "ticket.create",
      { ...input, title: "Something else" },
      { node: leafId, requestId: "ticket-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("a Control MCP credential's operations stay its own on the leaf", async () => {
    const { command, leaf, leafId, commandId } = await topology();
    const input = { projectId: leaf.projectId, title: "Scoped" };
    const alice = controlMcpAuthority("alice");
    const bob = controlMcpAuthority("bob");
    const byAlice = await call(command, "ticket.create", input, {
      node: leafId,
      requestId: "same-key",
      authority: alice,
    });
    const byBob = await call(command, "ticket.create", input, {
      node: leafId,
      requestId: "same-key",
      authority: bob,
    });
    if (!byAlice.ok || !byBob.ok) throw new Error("ticket.create failed");
    expect(byBob.receipt!.operationId).not.toBe(byAlice.receipt!.operationId);
    const record = await leaf.harness.storage.getPublicOperation(byAlice.receipt!.operationId);
    expect(record.status === "found" && record.record.authority).toBe(
      `node:${commandId}/control-mcp:alice`,
    );
    // Bob cannot read Alice's receipt there, nor can the leaf's operator replay into it.
    const peek = await call(
      command,
      "run.get",
      { operationId: byAlice.receipt!.operationId },
      { node: leafId, authority: bob },
    );
    expect(!peek.ok && peek.error.code).toBe("not-found");
    const own = await call(
      command,
      "run.get",
      { operationId: byAlice.receipt!.operationId },
      { node: leafId, authority: alice },
    );
    expect(own.ok).toBe(true);
  });

  test("the operator-only cascade stays operator-only on the leaf", async () => {
    const { command, leaf, leafId } = await topology();
    const refused = await call(
      command,
      "project.remove",
      { projectId: leaf.projectId, cascade: true },
      { node: leafId, requestId: "cascade", authority: controlMcpAuthority("alice") },
    );
    expect(!refused.ok && refused.error.code).toBe("capability-unavailable");
  });

  test("a leaf refuses a relayed credential from a command node it is not attached to", async () => {
    const { leaf, leafId } = await topology();
    const response = (await leaf.harness.commands.get("public_action")!(
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: "project.list",
        actionVersion: 1,
        input: {},
        relayedAuthority: { controllerId: "bk_stranger", authority: "control-mcp:alice" },
      },
      leaf.harness.context,
    )) as PublicActionResponse;
    expect(!response.ok && response.error.code).toBe("capability-unavailable");
    expect(leafId).toBeTruthy();
  });
});

describe("node errors", () => {
  test("an unknown node is node-not-found", async () => {
    const { command } = await topology();
    const response = await call(command, "project.list", {}, { node: "bk_nobody" });
    expect(!response.ok && response.error.code).toBe("node-not-found");
    expect(!response.ok && response.error.exitCode).toBe(3);
  });

  test("an offline leaf: reads are node-unavailable, a lost mutation is node-outcome-unknown", async () => {
    const { command, leaf, leafNode, leafId } = await topology();
    leafNode.online = false;
    const read = await call(command, "project.list", {}, { node: leafId });
    expect(!read.ok && read.error.code).toBe("node-unavailable");
    const write = await call(
      command,
      "ticket.create",
      { projectId: leaf.projectId, title: "Lost" },
      { node: leafId, requestId: "lost-1" },
    );
    expect(!write.ok && write.error.code).toBe("node-outcome-unknown");
    expect(!write.ok && write.error.retryable).toBe(true);
    expect(!write.ok && write.error.details?.requestId).toBe("lost-1");
    // Back online, the same key settles it exactly once.
    leafNode.online = true;
    const retried = await call(
      command,
      "ticket.create",
      { projectId: leaf.projectId, title: "Lost" },
      { node: leafId, requestId: "lost-1" },
    );
    expect(retried.ok).toBe(true);
  });

  test("a leaf too old for node routing is node-unsupported and receives nothing", async () => {
    const { command, leafNode, leafId } = await topology({ leafRelay: false });
    const before = leafNode.received.filter((entry) => entry.command === "public_action").length;
    const response = await call(command, "project.list", {}, { node: leafId });
    expect(!response.ok && response.error.code).toBe("node-unsupported");
    expect(leafNode.received.filter((entry) => entry.command === "public_action").length).toBe(
      before,
    );
    const listed = await call<PublicNodeList>(command, "node.list", {});
    expect(listed.ok && listed.result.items[1]!.publicActions).toBe(false);
  });

  test("a leaf cannot route onward: its own registry is suspended", async () => {
    const { leaf, commandId } = await topology();
    const response = await call(leaf.harness, "project.list", {}, { node: commandId });
    expect(!response.ok && response.error.code).toBe("node-unsupported");
  });
});

describe("node all", () => {
  test("aggregate reads tag every item with its node and report each node", async () => {
    const { command, leaf, leafId, commandId } = await topology();
    const page = await call<PublicAggregatePage<PublicProjectSummary>>(
      command,
      "project.list",
      {},
      { node: "all" },
    );
    if (!page.ok) throw new Error(page.error.message);
    expect(page.result.items.map((item) => [item.nodeId, item.id])).toEqual([
      [leafId, leaf.projectId],
    ]);
    expect(page.result.items[0]!.nodeName).toBe("leaf machine");
    expect(page.result.nodes.map((node) => [node.nodeId, node.ok, node.total])).toEqual([
      [commandId, true, 0],
      [leafId, true, 1],
    ]);
    const environments = await call<PublicAggregatePage<{ id: string }>>(
      command,
      "environment.list",
      {},
      { node: "all" },
    );
    expect(environments.ok && environments.result.items.map((item) => item.id)).toEqual(["env-1"]);
    const attention = await call<{ nodes: Array<{ nodeId: string; cursor?: string }> }>(
      command,
      "attention.list",
      {},
      { node: "all" },
    );
    expect(attention.ok && attention.result.nodes.every((node) => node.cursor)).toBe(true);
  });

  test("an offline leaf is reported, not fatal", async () => {
    const { command, leafNode, leafId } = await topology();
    leafNode.online = false;
    const page = await call<PublicAggregatePage<unknown>>(
      command,
      "project.list",
      {},
      {
        node: "all",
      },
    );
    if (!page.ok) throw new Error(page.error.message);
    const leafResult = page.result.nodes.find((node) => node.nodeId === leafId);
    expect(leafResult).toMatchObject({ ok: false, error: { code: "node-unavailable" } });
    expect(page.warnings?.length).toBe(1);
  });

  test("only aggregate reads take all, and their cursors are per node", async () => {
    const { command, leaf } = await topology();
    const mutation = await call(
      command,
      "ticket.create",
      { projectId: leaf.projectId, title: "x" },
      { node: "all", requestId: "all-1" },
    );
    expect(!mutation.ok && mutation.error.code).toBe("invalid-input");
    const paged = await call(command, "project.list", { cursor: "abc" }, { node: "all" });
    expect(!paged.ok && paged.error.code).toBe("invalid-input");
    const scoped = await call(
      command,
      "environment.list",
      { projectId: leaf.projectId },
      { node: "all" },
    );
    expect(!scoped.ok && scoped.error.code).toBe("invalid-input");
  });
});
