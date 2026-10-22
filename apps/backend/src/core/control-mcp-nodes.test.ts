import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "@orkestrator/protocol/command-nodes";

import { NODE_TOOL_CAPABILITIES, registerNodeTools } from "./control-mcp-nodes.js";
import { coordinatorNodeContext } from "./nodes/node-context.js";
import { NodeMailCollector } from "./nodes/node-mail-collector.js";

type Handler = (
  input: Record<string, unknown>,
) => Promise<{ structuredContent: Record<string, unknown> }>;

const commandStatus: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

function harness(
  options: { status?: NodeStatus; leafProjects?: Array<Record<string, unknown>> } = {},
) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const routed: Array<{ nodeId: string; command: string; args: Record<string, unknown> }> = [];
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    switch (command) {
      case "get_node_status":
        return (options.status ?? commandStatus) as T;
      case "get_projects":
        return [{ id: "p-self", gitUrl: "git@github.com:acme/site.git" }] as T;
      case "get_project_coordinator":
        return { workspace: { conversations: [{ id: "conv-1", tabId: "coord-tab" }] } } as T;
      case "get_node_summaries":
        return {
          selfId: "bk_self",
          nodes: [
            {
              nodeId: "bk_leaf",
              view: {
                displayName: "Build box",
                connection: { state: "connected", remoteMode: "standalone" },
              },
              available: true,
              freshness: "current",
              projects: options.leafProjects ?? [
                {
                  ref: { backendId: "bk_leaf", projectId: "p-leaf" },
                  repositoryHint: "github.com/acme/site",
                },
              ],
              environments: [
                {
                  ref: { backendId: "bk_leaf", environmentId: "e1" },
                  projectId: "p-leaf",
                  name: "feature-a",
                  status: "running",
                  activity: "working",
                  isProjectHome: false,
                },
              ],
            },
          ],
        } as T;
      case "get_environment":
        return { id: args.environmentId, projectId: "p-self", name: "local-env" } as T;
      case "create_node_action_request":
        return { requestId: "req-1", state: "pending" } as T;
      case "invoke_on_node": {
        const inner = {
          nodeId: String(args.nodeId),
          command: String(args.command),
          args: args.args as Record<string, unknown>,
        };
        routed.push(inner);
        const answers: Record<string, unknown> = {
          get_environment: { id: inner.args.environmentId, projectId: "p-leaf", name: "feature-a" },
          create_environment: { id: "e-new", status: "stopped" },
          get_pane_layout: { tabs: [] },
          deliver_node_mail: { messageId: "m1" },
        };
        return { outcome: "ok", result: answers[inner.command] ?? { ok: true } } as T;
      }
      default:
        return undefined as T;
    }
  };
  registerNodeTools(server as never, invoke, {
    projectId: "p-self",
    coordinatorId: "c1",
    conversationId: "conv-1",
  });
  const call = async (name: string, input: Record<string, unknown> = {}) =>
    (await tools.get(name)!(input)).structuredContent;
  return { tools, calls, routed, call };
}

describe("CO-01/LM-02 node tools in leaf mode", () => {
  test("every cross-node tool refuses and names the controlling command node", async () => {
    const { tools } = harness({
      status: {
        ...commandStatus,
        mode: "leaf",
        controllers: [
          {
            controllerId: "bk_top" as never,
            displayName: "Office desktop",
            attachedAt: "",
            lastContactAt: "",
          },
        ],
      },
    });
    expect([...tools.keys()].sort()).toEqual(NODE_TOOL_CAPABILITIES.map(([name]) => name).sort());
    for (const [name, handler] of tools) {
      await expect(
        handler({
          nodeId: "bk_leaf",
          environmentId: "e1",
          requestId: "r",
          prompt: "x",
          body: "x",
          reason: "x",
          tabId: "t",
        }),
      ).rejects.toThrow(/leaf mode, controlled by Office desktop/);
      void name;
    }
  });
});

describe("CO-02/CO-06 interrogating and creating on connected nodes", () => {
  test("lists nodes and environments of this project only, matched by repository", async () => {
    const { call } = harness();
    expect(await call("list_nodes")).toMatchObject({
      self: { nodeId: "bk_self", mode: "command" },
      nodes: [{ nodeId: "bk_leaf", name: "Build box", hasProject: true, available: true }],
    });
    const listed = await call("list_node_environments");
    expect(listed.nodes).toEqual([
      expect.objectContaining({
        nodeId: "bk_leaf",
        environments: [expect.objectContaining({ environmentId: "e1", name: "feature-a" })],
      }),
    ]);
  });

  test("a node without this project refuses and points at asking the user", async () => {
    const { call } = harness({ leafProjects: [] });
    await expect(
      call("read_node_environment", { nodeId: "bk_leaf", environmentId: "e1", limit: 10 }),
    ).rejects.toThrow("has no copy of this project");
  });

  test("launching on a node creates in that node's project, records the origin and starts it", async () => {
    const { call, routed } = harness();
    const result = await call("launch_node_environment", {
      requestId: "launch-1",
      nodeId: "bk_leaf",
      environmentType: "local",
      agent: "codex",
      conversationMode: "build",
      prompt: "Fix the bug",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    });
    expect(result).toMatchObject({ nodeId: "bk_leaf", environmentId: "e-new", status: "accepted" });
    const create = routed.find((entry) => entry.command === "create_environment")!;
    expect(create.args.projectId).toBe("p-leaf");
    expect(String(create.args.initialPrompt)).toContain('toEnvironmentId "coordinator"');
    expect(
      routed.find((entry) => entry.command === "record_node_environment_origin")!.args,
    ).toEqual({
      environmentId: "e-new",
      controllerId: "bk_self",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
    });
    expect(routed.some((entry) => entry.command === "start_environment_background")).toBe(true);
  });

  test("reading another node's environment never routes a write", async () => {
    const { call, routed } = harness();
    await call("read_node_environment", { nodeId: "bk_leaf", environmentId: "e1", limit: 10 });
    expect(routed.map((entry) => entry.command)).toEqual(["get_environment", "get_pane_layout"]);
  });
});

describe("CO-05 messaging agents on connected nodes", () => {
  test("a coordinator message is delivered as leaf mail with the conversation's mailbox for replies", async () => {
    const { call, routed } = harness();
    await call("send_node_message", {
      requestId: "mail-1",
      nodeId: "bk_leaf",
      environmentId: "e1",
      body: "Status?",
    });
    expect(routed.find((entry) => entry.command === "deliver_node_mail")!.args).toEqual({
      controllerId: "bk_self",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
      requestId: "mail-1",
      toEnvironmentId: "e1",
      body: "Status?",
    });
  });
});

describe("CO-04 deletion is only ever requested", () => {
  test("request_environment_deletion creates a request naming node and environment and deletes nothing", async () => {
    const { call, calls, routed } = harness();
    const result = await call("request_environment_deletion", {
      nodeId: "bk_leaf",
      environmentId: "e1",
      reason: "The user asked to remove feature-a.",
    });
    expect(result.note).toContain(
      "Waiting for the user to confirm deleting “feature-a” on Build box",
    );
    const request = calls.find((entry) => entry.command === "create_node_action_request")!;
    expect(request.args).toMatchObject({
      kind: "delete-environment",
      targets: [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          environmentId: "e1",
          environmentName: "feature-a",
        },
      ],
    });
    expect(routed.some((entry) => entry.command === "delete_environment")).toBe(false);
    expect(calls.some((entry) => entry.command === "delete_environment")).toBe(false);
  });
});

describe("LM-01/LM-03 the coordinator's node context", () => {
  test("leaf mode names the controller and says to act as an agent on this node", () => {
    const line = coordinatorNodeContext(
      {
        ...commandStatus,
        mode: "leaf",
        controllers: [
          {
            controllerId: "bk_top" as never,
            displayName: "Office desktop",
            attachedAt: "",
            lastContactAt: "",
          },
        ],
      },
      0,
    )!;
    expect(line).toContain("Node mode: leaf. This node is controlled by Office desktop");
    expect(line).toContain("handle it as an agent on this node would");
  });

  test("a command node with nodes defaults to itself and deletes only on request", () => {
    const line = coordinatorNodeContext(commandStatus, 2)!;
    expect(line).toContain("2 connected nodes");
    expect(line).toContain("launch_environment unless the user names another node");
    expect(line).toContain("Never delete an environment on your own initiative");
    expect(coordinatorNodeContext({ ...commandStatus, mode: "standalone" }, 0)).toBeNull();
  });
});

describe("UP-02/UP-04 collecting leaf mail on the command node", () => {
  test("delivers each item, then acknowledges; a failed delivery leaves it on the leaf", async () => {
    const delivered: string[] = [];
    let failNext = false;
    const acks: number[] = [];
    const items = [
      {
        seq: 1,
        requestId: "r1",
        fromEnvironmentId: "e1",
        fromTabId: "t",
        body: "one",
        bytes: 3,
        createdAt: "",
      },
      {
        seq: 2,
        requestId: "r2",
        fromEnvironmentId: "e1",
        fromTabId: "t",
        body: "two",
        bytes: 3,
        createdAt: "",
      },
    ];
    const link = {
      connected: true,
      invoke: async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (command === "collect_node_outbox") {
          return {
            items: items.filter((item) => !acks.some((seq) => seq >= item.seq)),
            more: false,
          } as T;
        }
        if (command === "ack_node_outbox") acks.push(...(args.sequences as number[]));
        return {} as T;
      },
    };
    const collector = new NodeMailCollector({
      selfId: async () => "bk_self" as never,
      link: () => link,
      nodeName: async () => "Build box",
      deliver: async (input) => {
        if (failNext && input.body.endsWith("two")) throw new Error("no coordinator");
        delivered.push(input.body);
      },
    });
    failNext = true;
    await collector.collect("bk_leaf" as never);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("on node Build box (nodeId bk_leaf)");
    expect(acks).toEqual([1]);
    failNext = false;
    await collector.collect("bk_leaf" as never);
    expect(acks).toEqual([1, 2]);
    expect(delivered).toHaveLength(2);
  });
});
