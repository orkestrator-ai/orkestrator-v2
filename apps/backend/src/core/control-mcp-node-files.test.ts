import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "@orkestrator/protocol/command-nodes";

import { NODE_FILE_TOOL_CAPABILITIES, registerNodeFileTools } from "./control-mcp-node-files.js";

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

function harness(status: NodeStatus = commandStatus, leafHasProject = true) {
  const tools = new Map<string, Handler>();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    switch (command) {
      case "get_node_status":
        return status as T;
      case "get_projects":
        return [{ id: "p-self", name: "Site", gitUrl: "git@github.com:acme/site.git" }] as T;
      case "get_environment":
        return {
          id: args.environmentId,
          projectId: args.environmentId === "other" ? "other" : "p-self",
          projectHome: args.environmentId === "home",
        } as T;
      case "get_project_coordinator":
        return { workspace: { conversations: [{ id: "conv-1", tabId: "coord-tab" }] } } as T;
      case "get_node_summaries":
        return {
          selfId: "bk_self",
          nodes: [
            {
              nodeId: "bk_leaf",
              view: { displayName: "Build box" },
              available: true,
              environments: [
                { ref: { environmentId: "e-leaf" }, projectId: "p-leaf" },
                { ref: { environmentId: "other" }, projectId: "p-other" },
                { ref: { environmentId: "home" }, projectId: "p-leaf", isProjectHome: true },
              ],
              projects: leafHasProject
                ? [
                    {
                      ref: { backendId: "bk_leaf", projectId: "p-leaf" },
                      repositoryHint: "github.com/acme/site",
                    },
                  ]
                : [],
            },
          ],
        } as T;
      case "transfer_node_files":
        return { transferId: "t1", status: "completed", bytes: 10, files: [] } as T;
      case "compare_project_files":
        return { files: [".env"], nodes: [] } as T;
      case "create_node_action_request":
        return { requestId: "req-1" } as T;
      default:
        return undefined as T;
    }
  };
  registerNodeFileTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
    } as never,
    invoke,
    { projectId: "p-self", coordinatorId: "c1", conversationId: "conv-1" },
  );
  const call = async (name: string, input: Record<string, unknown>) =>
    (await tools.get(name)!(input)).structuredContent;
  return { tools, calls, call };
}

describe("CO-07/FL-01 transfer_files", () => {
  test("resolves each side's project root by repository and returns only a receipt", async () => {
    const { call, calls } = harness();
    const output = await call("transfer_files", {
      from: { nodeId: "bk_self", projectRoot: true },
      to: { nodeId: "bk_leaf", environmentId: "e-leaf" },
      files: ["fixtures/data.json"],
      overwrite: false,
    });
    expect(output).toEqual({
      receipt: { transferId: "t1", status: "completed", bytes: 10, files: [] },
    });
    expect(calls.find((entry) => entry.command === "transfer_node_files")!.args).toMatchObject({
      from: { nodeId: "bk_self", scope: { projectId: "p-self" } },
      to: { nodeId: "bk_leaf", scope: { environmentId: "e-leaf" } },
      files: ["fixtures/data.json"],
      overwrite: false,
    });
  });

  test("every file tool refuses in leaf mode", async () => {
    const { tools } = harness({
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
    });
    expect([...tools.keys()].sort()).toEqual(
      NODE_FILE_TOOL_CAPABILITIES.map(([name]) => name).sort(),
    );
    for (const handler of tools.values()) {
      await expect(
        handler({
          from: { nodeId: "bk_self", projectRoot: true },
          to: { nodeId: "bk_leaf", projectRoot: true },
          files: ["a"],
          nodeIds: ["bk_leaf"],
          nodeId: "bk_leaf",
          file: ".env",
          keys: ["A"],
          location: "/srv/site",
          reason: "asked",
        }),
      ).rejects.toThrow(/leaf mode/);
    }
  });
});

describe("FL-02/FL-07/FL-08 file requests wait for the user", () => {
  test("creating a project on a node is a request naming the node, remote and location", async () => {
    const { call, calls } = harness(commandStatus, false);
    await call("request_project_on_node", {
      nodeId: "bk_leaf",
      location: "/srv/site",
      reason: "The user asked.",
    });
    expect(
      calls.find((entry) => entry.command === "create_node_action_request")!.args,
    ).toMatchObject({
      kind: "create-project",
      targets: [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          gitRemote: "git@github.com:acme/site.git",
          location: "/srv/site",
        },
      ],
    });
    await expect(
      call("request_project_on_node", {
        nodeId: "bk_leaf",
        location: "relative/path",
        reason: "x",
      }),
    ).rejects.toThrow("absolute path");
  });

  test("updates and reveals are requests; nothing is written or read until approved", async () => {
    const { call, calls } = harness();
    await call("request_project_file_update", {
      nodeIds: ["bk_leaf"],
      files: [".env"],
      keys: ["API_KEY"],
      reason: "Rotate the key everywhere.",
    });
    await call("request_env_value_reveal", {
      nodeId: "bk_leaf",
      file: ".env",
      keys: ["API_KEY"],
      reason: "The user asked to see it.",
    });
    const requests = calls.filter((entry) => entry.command === "create_node_action_request");
    expect(requests.map((entry) => entry.args.kind)).toEqual([
      "update-project-files",
      "reveal-env-value",
    ]);
    expect(requests[0]!.args.targets).toEqual([
      {
        nodeId: "bk_leaf",
        nodeName: "Build box",
        projectId: "p-leaf",
        files: [".env"],
        keys: ["API_KEY"],
      },
    ]);
    expect(
      calls.some((entry) =>
        ["apply_env_keys", "read_env_values", "invoke_on_node"].includes(entry.command),
      ),
    ).toBe(false);
  });
});

test("nested transfer scopes refuse cross-project and home endpoints before transfer admission", async () => {
  for (const side of ["from", "to"])
    for (const nodeId of ["bk_self", "bk_leaf"])
      for (const environmentId of ["other", "home"]) {
        const { call, calls } = harness();
        await expect(
          call("transfer_files", {
            from: { nodeId: "bk_self", environmentId: "e-self" },
            to: { nodeId: "bk_leaf", environmentId: "e-leaf" },
            [side]: { nodeId, environmentId },
            files: ["x"],
          }),
        ).rejects.toThrow(/cannot access/);
        expect(calls.some((entry) => entry.command === "transfer_node_files")).toBe(false);
      }
  const { call, calls } = harness();
  await expect(
    call("transfer_files", {
      from: { nodeId: "bk_self", projectRoot: true },
      to: { nodeId: "bk_leaf", projectRoot: true },
      files: ["x"],
    }),
  ).rejects.toThrow(/approval/);
  expect(calls.some((entry) => entry.command === "transfer_node_files")).toBe(false);
});
