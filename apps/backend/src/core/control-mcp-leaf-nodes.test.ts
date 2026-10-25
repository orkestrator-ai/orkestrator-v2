import { createProject } from "./storage.js";
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

describe("aggregate MCP regressions", () => {
  test("legacy and voice lists drain over 200 leaf projects and environments", async () => {
    const mcp = await open();
    const template = (await mcp.leaf.harness.storage.getEnvironment("env-1"))!;
    let finalProjectId = "";
    for (let index = 0; index < 201; index += 1) {
      const project = await mcp.leaf.harness.storage.addProject({
        ...createProject(`https://example.invalid/project-${index}.git`),
        name: `Project ${String(index).padStart(3, "0")}`,
        order: index + 1,
      });
      finalProjectId = project.id;
      await mcp.leaf.harness.storage.addEnvironment({
        ...template,
        id: `env-page-${index}`,
        projectId: project.id,
        name: `Environment ${String(index).padStart(3, "0")}`,
        status: "stopped",
        order: index + 1,
      });
    }
    const projects = content(await mcp.call(mcp.token, "list_projects", { nodeId: "all" })) as {
      projects: Array<{ id: string; nodeId: string }>;
      warnings: string[];
    };
    expect(projects.projects).toHaveLength(202);
    expect(projects.projects).toContainEqual(
      expect.objectContaining({ id: finalProjectId, nodeId: mcp.leafId }),
    );
    expect(projects.warnings).toEqual([]);
    const environments = content(
      await mcp.call(mcp.token, "list_environments", { nodeId: "all" }),
    ) as { environments: unknown[] };
    expect(environments.environments).toHaveLength(202);
    const voice = await mcp.credential("voice");
    const overview = content(await mcp.call(voice, "overview", { nodeId: "all" })) as {
      result: { counts: { projects: number; environments: { total: number } } };
    };
    expect(overview.result.counts).toMatchObject({ projects: 202, environments: { total: 202 } });
    for (const [kind, query, id] of [
      ["project", "Project 200", finalProjectId],
      ["environment", "Environment 200", "env-page-200"],
    ]) {
      const resolved = content(
        await mcp.call(voice, "resolve_target", { nodeId: "all", kind, query }),
      ) as { result: { target: object } };
      expect(resolved.result.target).toMatchObject({ id, nodeId: mcp.leafId });
    }
  });

  test("legacy projects retain unavailable nodes alongside healthy projects", async () => {
    const mcp = await open();
    const project = await mcp.command.storage.addProject(
      createProject("https://example.invalid/healthy.git"),
    );
    mcp.leafNode.online = false;
    const listed = content(await mcp.call(mcp.token, "list_projects", { nodeId: "all" })) as {
      projects: Array<{ id: string }>;
      unavailableNodes: Array<{ nodeId: string }>;
      warnings: string[];
    };
    expect(listed.projects.map((item) => item.id)).toEqual([project.id]);
    expect(listed.unavailableNodes).toContainEqual(expect.objectContaining({ nodeId: mcp.leafId }));
    expect(listed.warnings.join(" ")).toContain("leaf machine");
  });

  test("a disconnect between discovery and resolution preserves healthy environments", async () => {
    const mcp = await open();
    const environment = (await mcp.leaf.harness.storage.getEnvironment("env-1"))!;
    const project = await mcp.command.storage.addProject(
      createProject("https://example.invalid/local.git"),
    );
    await mcp.command.storage.addEnvironment({
      ...environment,
      id: "env-healthy",
      projectId: project.id,
    });
    const original = mcp.command.commands.get("public_action")!;
    let first = true;
    mcp.command.commands.set("public_action", async (args, context) => {
      const answer = await original(args, context);
      if (args.action === "node.list" && first) {
        first = false;
        await mcp.commandNode.service.updateNode({ nodeId: mcp.leafId, enabled: false });
      }
      return answer;
    });
    const listed = content(await mcp.call(mcp.token, "list_environments", { nodeId: "all" })) as {
      environments: Array<{ id: string }>;
      unavailableNodes: Array<{ nodeId: string }>;
    };
    expect(listed.environments.map((item) => item.id)).toEqual(["env-healthy"]);
    expect(listed.unavailableNodes).toContainEqual(expect.objectContaining({ nodeId: mcp.leafId }));
  });

  test("voice surfaces unavailable reads and refuses a project scoped to all nodes", async () => {
    const mcp = await open();
    const voice = await mcp.credential("voice");
    for (const tool of ["overview", "resolve_target"]) {
      const response = content(
        await mcp.call(voice, tool, {
          nodeId: "all",
          projectId: mcp.leaf.projectId,
          ...(tool === "resolve_target" ? { query: "sessions", kind: "environment" } : {}),
        }),
      ) as { ok: boolean; error: { code: string } };
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe("invalid-input");
    }
    mcp.leafNode.online = false;
    for (const [tool, args] of [
      ["overview", {}],
      ["resolve_target", { query: "sessions", kind: "environment" }],
      ["start_work", { environmentId: "env-1", prompt: "work", requestId: "offline-start" }],
    ] as const) {
      const response = content(await mcp.call(voice, tool, { ...args, nodeId: mcp.leafId })) as {
        ok: boolean;
        error: { code: string };
      };
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe("node-unavailable");
    }
    const aggregate = content(await mcp.call(voice, "overview", { nodeId: "all" })) as {
      ok: boolean;
      error: { code: string };
    };
    expect(aggregate.ok).toBe(false);
    expect(aggregate.error.code).toBe("node-unavailable");
  });
});
