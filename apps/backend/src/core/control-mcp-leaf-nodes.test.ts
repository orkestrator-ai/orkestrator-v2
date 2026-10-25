import { afterEach, describe, expect, test } from "bun:test";
import { ControlMcpServer, readControlMcpDescriptor } from "./control-mcp-server.js";
import { rpc, type RpcResult } from "./control-mcp-test-support.js";
import { cleanupNodeTopologies, topology } from "./public-api/node-test-support.js";

/**
 * Control MCP on a command node acting on its leaf: discovery, `nodeId` on
 * the original, direct, gateway and voice tools, `nodeId: all` aggregates,
 * confirmations bound to the node, and credential rules applied before
 * anything crosses the node link.
 */

const servers: ControlMcpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  await cleanupNodeTopologies();
});

async function open() {
  const nodes = await topology();
  const server = new ControlMcpServer(
    nodes.command.dataDir,
    async <T>(command: string, args: Record<string, unknown> = {}) => {
      const handler = nodes.command.commands.get(command);
      if (!handler) throw new Error(`Unknown backend command: ${command}`);
      return (await handler(args, nodes.command.context)) as T;
    },
    { port: 0 },
  );
  servers.push(server);
  await server.start();
  const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
  const credential = async (profile: "voice" | "read-only" | "full") => {
    const settings = await server.createCredential({ label: `${profile} client`, profile });
    return settings.credentials.at(-1)!.token;
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc(descriptor.url, token, "tools/call", { name, arguments: args });
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    return body.result!;
  };
  const list = async (token: string) => {
    const { body } = await rpc(descriptor.url, token, "tools/list");
    return (body.result?.tools ?? []) as Array<{
      name: string;
      inputSchema: { properties?: object };
    }>;
  };
  return { ...nodes, token: descriptor.token, credential, call, list };
}

function content(result: RpcResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function publicActionsReceived(leaf: { received: Array<{ command: string }> }): number {
  return leaf.received.filter((entry) => entry.command === "public_action").length;
}

describe("Control MCP and leaf nodes", () => {
  test("lists the nodes and the node-aware tools, and find_actions finds them", async () => {
    const mcp = await open();
    const tools = await mcp.list(mcp.token);
    const names = tools.map((tool) => tool.name);
    for (const name of [
      "list_nodes",
      "node_list",
      "launch_multi_review",
      "start_multi_review",
      "get_multi_review",
      "create_pr",
      "resolve_conflicts",
      "review_launch",
      "pr_create",
      "pr_resolve",
    ]) {
      expect(names).toContain(name);
    }
    const schema = (name: string) =>
      Object.keys(tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {});
    expect(schema("project_list")).toContain("nodeId");
    expect(schema("session_prompt")).toContain("nodeId");
    expect(schema("node_list")).not.toContain("nodeId");
    expect(schema("run_action")).toContain("nodeId");
    expect(schema("get_tab_transcript")).toContain("nodeId");

    const listed = content(await mcp.call(mcp.token, "list_nodes"));
    expect(listed.self).toMatchObject({ nodeId: mcp.commandId });
    expect(listed.nodes).toEqual([
      expect.objectContaining({ nodeId: mcp.leafId, available: true, publicActions: true }),
    ]);
    for (const query of ["node", "leaf", "remote", "machine"]) {
      const found = content(await mcp.call(mcp.token, "find_actions", { query }));
      const items = (found.result as { items: Array<{ action: string }> }).items;
      expect(items.map((row) => row.action)).toContain("node.list");
    }
  });

  test("direct, gateway and original tools act on the leaf", async () => {
    const mcp = await open();
    const direct = content(await mcp.call(mcp.token, "project_list", { nodeId: mcp.leafId }));
    expect(direct.ok).toBe(true);
    expect(direct.node).toMatchObject({ nodeId: mcp.leafId });
    expect((direct.result as { items: Array<{ id: string }> }).items[0]!.id).toBe(
      mcp.leaf.projectId,
    );

    const gateway = content(
      await mcp.call(mcp.token, "run_action", {
        action: "environment.get",
        input: { environmentId: "env-1" },
        nodeId: mcp.leafId,
      }),
    );
    expect(gateway.ok).toBe(true);
    expect((gateway.result as { name: string }).name).toBe("sessions");

    const legacy = content(
      await mcp.call(mcp.token, "get_environment", { environmentId: "env-1", nodeId: mcp.leafId }),
    );
    expect(legacy.environment).toMatchObject({ id: "env-1", nodeId: mcp.leafId });
    const tabs = content(
      await mcp.call(mcp.token, "list_tabs", { environmentId: "env-1", nodeId: mcp.leafId }),
    );
    expect(tabs).toMatchObject({ environmentId: "env-1", nodeId: mcp.leafId });

    // Locally env-1 does not exist: omitting nodeId really means this node.
    const local = await mcp.call(mcp.token, "environment_get", { environmentId: "env-1" });
    expect(content(local).ok).toBe(false);
  });

  test("nodeId all aggregates the lists, tagged by node", async () => {
    const mcp = await open();
    const environments = content(
      await mcp.call(mcp.token, "list_environments", { nodeId: "all" }),
    ) as { environments: Array<{ id: string; nodeId: string }> };
    expect(environments.environments.map((entry) => [entry.id, entry.nodeId])).toEqual([
      ["env-1", mcp.leafId],
    ]);
    const projects = content(await mcp.call(mcp.token, "list_projects", { nodeId: "all" })) as {
      projects: Array<{ nodeId: string }>;
    };
    expect(projects.projects.map((entry) => entry.nodeId)).toEqual([mcp.leafId]);
    const refused = await mcp.call(mcp.token, "get_environment", {
      environmentId: "env-1",
      nodeId: "all",
    });
    expect(refused.isError).toBe(true);
  });

  test("a confirmation names the node and is bound to it", async () => {
    const mcp = await open();
    const first = content(
      await mcp.call(mcp.token, "environment_delete", {
        environmentId: "env-1",
        requestId: "delete-1",
        nodeId: mcp.leafId,
      }),
    ) as {
      ok: boolean;
      error: { code: string; message: string; details: { confirmToken: string } };
    };
    expect(first.error.code).toBe("confirmation-required");
    expect(first.error.message).toContain("on leaf machine");
    const before = publicActionsReceived(mcp.leafNode);
    // The same token cannot run the same deletion on another node.
    const elsewhere = content(
      await mcp.call(mcp.token, "environment_delete", {
        environmentId: "env-1",
        requestId: "delete-1",
        confirmToken: first.error.details.confirmToken,
      }),
    ) as { error: { code: string; details: { refused?: string } } };
    expect(elsewhere.error.code).toBe("confirmation-required");
    expect(elsewhere.error.details.refused).toBe("mismatch");
    expect(publicActionsReceived(mcp.leafNode)).toBe(before);
  });

  test("credential rules apply before anything crosses the node link", async () => {
    const mcp = await open();
    const readOnly = await mcp.credential("read-only");
    const before = publicActionsReceived(mcp.leafNode);
    const refused = content(
      await mcp.call(readOnly, "run_action", {
        action: "ticket.create",
        input: { projectId: mcp.leaf.projectId, title: "nope" },
        requestId: "ro-1",
        nodeId: mcp.leafId,
      }),
    ) as { error: { code: string } };
    expect(refused.error.code).toBe("capability-unavailable");
    expect(publicActionsReceived(mcp.leafNode)).toBe(before);
  });

  test("a leaf node error keeps its public code in the original tools", async () => {
    const mcp = await open();
    const unknown = await mcp.call(mcp.token, "get_environment", {
      environmentId: "env-1",
      nodeId: "bk_nobody",
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain("node-not-found");
    mcp.leafNode.online = false;
    const offline = content(await mcp.call(mcp.token, "project_list", { nodeId: mcp.leafId })) as {
      error: { code: string };
    };
    expect(offline.error.code).toBe("node-unavailable");
  });

  test("voice: overview and resolve_target span machines and hand back the nodeId", async () => {
    const mcp = await open();
    const voice = await mcp.credential("voice");
    const overview = content(await mcp.call(voice, "overview", { nodeId: "all" })) as {
      result: { counts: { environments: { total: number } }; nodes: Array<{ nodeId: string }> };
    };
    expect(overview.result.counts.environments.total).toBe(1);
    expect(overview.result.nodes.map((node) => node.nodeId)).toEqual([mcp.commandId, mcp.leafId]);
    const resolved = content(
      await mcp.call(voice, "resolve_target", {
        query: "the sessions environment",
        kind: "environment",
        nodeId: "all",
      }),
    ) as { result: { target: { id: string; nodeId: string } } };
    expect(resolved.result.target).toMatchObject({ id: "env-1", nodeId: mcp.leafId });
  });
});
