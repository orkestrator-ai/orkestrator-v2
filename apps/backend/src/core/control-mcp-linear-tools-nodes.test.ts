import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";

import { registerLinearTools } from "./control-mcp-linear-tools.js";
import { createNodeTargets } from "./control-mcp-nodes.js";

/**
 * A coordinator's Linear tools with `nodeId` (`control-mcp-linear-tools.ts`):
 * routed through `invoke_on_node` to the coordinator's own project on that
 * machine, and refused before any issue read or write on a machine that
 * cannot prove it scopes them to the project's board.
 */

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
}>;

const commandStatus: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

const LINK = {
  link: {
    key: "repo:github.com/acme/site",
    teamId: "team-1",
    teamKey: "ENG",
    teamName: "Engineering",
    updatedAt: "2026-11-11T00:00:00.000Z",
  },
};

const ISSUE = { id: "issue-1", identifier: "ENG-1", title: "Header", comments: [] };

/**
 * `leaf` answers the commands routed to the leaf; a missing one there is an
 * unknown command, as on a machine from before Linear boards.
 */
function harness(leaf: Record<string, (args: Record<string, unknown>) => unknown>) {
  const tools = new Map<string, Handler>();
  const routed: Array<{ command: string; args: Record<string, unknown>; requestKey?: string }> = [];
  const local: string[] = [];
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    switch (command) {
      case "get_node_status":
        return commandStatus as T;
      case "get_projects":
        return [{ id: "p-self", name: "Site", gitUrl: "git@github.com:acme/site.git" }] as T;
      case "get_node_summaries":
        return {
          selfId: "bk_self",
          nodes: [
            {
              nodeId: "bk_leaf",
              view: { displayName: "Build box" },
              available: true,
              environments: [],
              projects: [
                {
                  ref: { backendId: "bk_leaf", projectId: "p-leaf" },
                  repositoryHint: "github.com/acme/site",
                },
              ],
            },
          ],
        } as T;
      case "invoke_on_node": {
        const inner = String(args.command);
        const innerArgs = args.args as Record<string, unknown>;
        routed.push({
          command: inner,
          args: innerArgs,
          ...(typeof args.requestKey === "string" ? { requestKey: args.requestKey } : {}),
        });
        const answer = leaf[inner];
        if (!answer) throw unknownCommand(inner);
        return { outcome: "ok", result: await answer(innerArgs) } as T;
      }
      default:
        local.push(command);
        throw new Error(`unexpected local ${command}`);
    }
  };
  const nodes = createNodeTargets(invoke, {
    projectId: "p-self",
    coordinatorId: "c1",
    conversationId: "conv-1",
  });
  registerLinearTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
    } as never,
    {
      invoke,
      coordinatorScope: {
        role: "coordinator",
        projectId: "p-self",
        coordinatorId: "c1",
        conversationId: "conv-1",
        mailboxIncarnationId: "m1",
        capabilities: ["tickets"],
      },
      onNode: async (nodeId: string | undefined) => (nodeId ? nodes.targetOrSelf(nodeId) : null),
      onNodeResult: (target: { nodeId: string; nodeName: string } | null) =>
        target ? { nodeId: target.nodeId, node: target.nodeName } : {},
    } as never,
  );
  const call = async (name: string, input: Record<string, unknown>) =>
    (await tools.get(name)!(input)).structuredContent;
  return { call, routed, local };
}

describe("Control MCP Linear tools with nodeId", () => {
  test("route to the node's copy of the project, with the request key", async () => {
    const { call, routed, local } = harness({
      get_linear_board_link: () => LINK,
      get_linear_issues: () => [ISSUE],
      get_linear_issue: () => ISSUE,
      post_linear_issue_comment: (args) => ({ id: "c-1", body: args.body }),
      create_linear_issue: () => ISSUE,
    });

    expect(
      await call("list_linear_issues", { projectId: "p-self", nodeId: "bk_leaf", limit: 10 }),
    ).toMatchObject({
      board: { teamKey: "ENG" },
      issues: [{ identifier: "ENG-1" }],
      nodeId: "bk_leaf",
      node: "Build box",
    });
    expect(
      await call("get_linear_issue", { projectId: "p-self", issueId: "ENG-1", nodeId: "bk_leaf" }),
    ).toMatchObject({ issue: { identifier: "ENG-1" }, nodeId: "bk_leaf" });
    await call("add_linear_comment", {
      requestId: "req-c",
      projectId: "p-self",
      issueId: "ENG-1",
      text: "Done",
      nodeId: "bk_leaf",
    });
    await call("create_linear_issue", {
      requestId: "req-n",
      projectId: "p-self",
      title: "New",
      nodeId: "bk_leaf",
    });

    // Each issue command names the leaf's own project, after the board check.
    expect(routed.map(({ command }) => command)).toEqual([
      "get_linear_board_link",
      "get_linear_issues",
      "get_linear_board_link",
      "get_linear_issue",
      "get_linear_board_link",
      "post_linear_issue_comment",
      "create_linear_issue",
    ]);
    for (const { command, args } of routed) {
      expect({ command, projectId: args.projectId }).toEqual({ command, projectId: "p-leaf" });
    }
    expect(routed.find(({ command }) => command === "post_linear_issue_comment")).toMatchObject({
      requestKey: "req-c",
      args: { issueId: "ENG-1", body: "Done" },
    });
    expect(routed.find(({ command }) => command === "create_linear_issue")).toMatchObject({
      requestKey: "req-n",
      args: { requestKey: "req-n", title: "New" },
    });
    expect(local).toEqual([]);
  });

  test("refuse another project with nodeId", async () => {
    const { call, routed } = harness({ get_linear_board_link: () => LINK });
    await expect(
      call("list_linear_issues", { projectId: "p-other", nodeId: "bk_leaf", limit: 10 }),
    ).rejects.toThrow("A coordinator's Linear tools with nodeId act on its own project.");
    expect(routed).toEqual([]);
  });

  test("an older node that ignores projectId is refused before any issue read or comment", async () => {
    // A machine from before Linear boards: no board link command, and issue
    // reads and comments that would act on any issue its key can see.
    const reads: string[] = [];
    const { call, routed } = harness({
      get_linear_issue: () => {
        reads.push("get_linear_issue");
        return ISSUE;
      },
      get_linear_issues: () => {
        reads.push("get_linear_issues");
        return [ISSUE];
      },
      post_linear_issue_comment: () => {
        reads.push("post_linear_issue_comment");
        return { id: "c" };
      },
    });
    const refusal = "runs an Orkestrator from before Linear boards";
    await expect(
      call("get_linear_issue", { projectId: "p-self", issueId: "OPS-9", nodeId: "bk_leaf" }),
    ).rejects.toThrow(refusal);
    await expect(
      call("add_linear_comment", {
        requestId: "req-x",
        projectId: "p-self",
        issueId: "OPS-9",
        text: "hi",
        nodeId: "bk_leaf",
      }),
    ).rejects.toThrow(refusal);
    await expect(
      call("list_linear_issues", { projectId: "p-self", nodeId: "bk_leaf", limit: 10 }),
    ).rejects.toThrow(refusal);
    expect(reads).toEqual([]);
    expect(routed.map(({ command }) => command)).toEqual([
      "get_linear_board_link",
      "get_linear_board_link",
      "get_linear_board_link",
    ]);
  });

  test("a node whose project has no board linked is refused before the read", async () => {
    const reads: string[] = [];
    const { call } = harness({
      get_linear_board_link: () => ({}),
      get_linear_issue: () => {
        reads.push("get_linear_issue");
        return ISSUE;
      },
    });
    await expect(
      call("get_linear_issue", { projectId: "p-self", issueId: "ENG-1", nodeId: "bk_leaf" }),
    ).rejects.toThrow("This project has no Linear board linked on Build box.");
    expect(reads).toEqual([]);
  });
});
