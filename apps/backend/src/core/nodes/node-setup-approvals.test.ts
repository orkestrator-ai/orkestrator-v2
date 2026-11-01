import { expect, test } from "bun:test";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";

import { approveSetupCommandsOnNodes } from "./node-setup-approvals.js";

const HASH = "a".repeat(64);

function project(projectId: string, repositoryHint?: string) {
  return { ref: { projectId }, key: projectId, name: projectId, order: 0, repositoryHint };
}

function summaries(): NodeSummariesResult {
  return {
    selfId: "bk_command",
    self: {
      nodeId: "bk_command",
      displayName: "Desk",
      loadedAt: 0,
      truncated: false,
      projects: [project("cmd-p", "github.com/acme/app")],
      environments: [],
    },
    nodes: [
      {
        nodeId: "bk_leaf1",
        name: "Leaf 1",
        available: true,
        projects: [project("l1-p", "github.com/acme/app"), project("l1-q", "github.com/acme/app")],
      },
      {
        nodeId: "bk_leaf2",
        name: "Leaf 2",
        available: false,
        projects: [project("l2-p", "github.com/acme/app")],
      },
      {
        nodeId: "bk_leaf3",
        name: "Leaf 3",
        available: true,
        projects: [project("l3-x", "github.com/acme/other")],
      },
      {
        nodeId: "bk_leaf4",
        name: "Leaf 4",
        available: true,
        projects: [project("l4-p", "github.com/acme/app")],
      },
      {
        nodeId: "bk_leaf5",
        name: "Leaf 5",
        available: true,
        projects: [project("l5-p", "github.com/acme/app")],
      },
    ].map((node) => ({
      nodeId: node.nodeId,
      view: { displayName: node.name },
      available: node.available,
      freshness: "fresh",
      loadedAt: 0,
      truncated: false,
      lastError: null,
      projects: node.projects,
      environments: [],
    })),
  } as unknown as NodeSummariesResult;
}

test("approves the same commands on every machine with the project, each through its own node", async () => {
  const calls: Array<{ nodeId: string; command: string; args: Record<string, unknown> }> = [];
  const result = await approveSetupCommandsOnNodes(
    {
      summaries: async () => summaries(),
      invokerFor:
        (nodeId) =>
        async <T>(command: string, args: Record<string, unknown>) => {
          calls.push({ nodeId, command, args });
          if (nodeId === "bk_leaf4") {
            throw Object.assign(new Error("lost"), { code: "outcome-unknown" });
          }
          if (nodeId === "bk_leaf5")
            throw new Error(unknownBackendCommandMessage("approve_project_setup_commands"));
          return { approved: true } as T;
        },
    },
    { nodeId: "bk_leaf1", projectId: "l1-p", hash: HASH },
  );

  expect(
    result.nodes.map(({ nodeId, status, projectIds }) => ({ nodeId, status, projectIds })),
  ).toEqual([
    { nodeId: "bk_command", status: "approved", projectIds: ["cmd-p"] },
    { nodeId: "bk_leaf1", status: "approved", projectIds: ["l1-p", "l1-q"] },
    { nodeId: "bk_leaf2", status: "not-connected", projectIds: [] },
    { nodeId: "bk_leaf3", status: "no-project", projectIds: [] },
    { nodeId: "bk_leaf4", status: "outcome-unknown", projectIds: [] },
    { nodeId: "bk_leaf5", status: "needs-update", projectIds: [] },
  ]);
  expect(new Set(calls.map((call) => call.command))).toEqual(
    new Set(["approve_project_setup_commands"]),
  );
  expect(calls.every((call) => call.args.hash === HASH)).toBe(true);
  expect(calls.some((call) => call.nodeId === "bk_leaf2" || call.nodeId === "bk_leaf3")).toBe(
    false,
  );
});

test("a project with no repository identity cannot be matched elsewhere", async () => {
  const result = summaries();
  result.self!.projects = [project("cmd-local")] as never;
  await expect(
    approveSetupCommandsOnNodes(
      { summaries: async () => result, invokerFor: () => async () => undefined as never },
      { nodeId: "bk_command", projectId: "cmd-local", hash: HASH },
    ),
  ).rejects.toThrow("no repository remote");
});
