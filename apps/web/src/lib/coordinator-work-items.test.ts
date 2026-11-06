import { describe, expect, test } from "bun:test";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { workerTabTarget } from "./coordinator-work-items";

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("workerTabTarget", () => {
  const environments = [{ id: "local", projectId: "project-1" }];
  const remoteNode = {
    nodeId: "bk_leaf" as NodeSummary["nodeId"],
    available: true,
    environments: [
      {
        ref: { backendId: "bk_leaf", environmentId: "leaf-env" },
        projectId: "leaf-project",
        deleting: false,
      },
    ] as NodeSummary["environments"],
  };
  const lookup = { environments, nodes: [remoteNode] };

  test("a worker here opens its tab", () => {
    expect(workerTabTarget({ environmentId: "local", tabId: "t", title: "w" }, lookup)).toEqual({
      type: "worker-tab",
      projectId: "project-1",
      environmentId: "local",
      tabId: "t",
    });
  });

  test("a worker on a node opens through that node, with its project", () => {
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", tabId: "t", nodeId: "bk_leaf", title: "w" },
        lookup,
      ),
    ).toEqual({
      type: "remote",
      nodeId: "bk_leaf",
      projectId: "leaf-project",
      environmentId: "leaf-env",
      title: "w",
      workTarget: {
        type: "worker-tab",
        projectId: "leaf-project",
        environmentId: "leaf-env",
        tabId: "t",
      },
    });
  });

  test("anything it cannot reach is null", () => {
    // A remote id with no node named (an older notice) is not a local worker.
    expect(workerTabTarget({ environmentId: "leaf-env", title: "w" }, lookup)).toBeNull();
    expect(
      workerTabTarget({ environmentId: "gone", nodeId: "bk_leaf", title: "w" }, lookup),
    ).toBeNull();
    expect(
      workerTabTarget({ environmentId: "leaf-env", nodeId: "bk_other", title: "w" }, lookup),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", nodeId: "bk_leaf", title: "w" },
        { environments, nodes: [{ ...remoteNode, available: false }] },
      ),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", nodeId: "bk_leaf", title: "w" },
        {
          environments,
          nodes: [
            {
              ...remoteNode,
              environments: [{ ...remoteNode.environments[0]!, deleting: true }],
            },
          ],
        },
      ),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "local", title: "w" },
        { environments: [{ ...environments[0]!, deletionRequestedAt: at(-1) }], nodes: [] },
      ),
    ).toBeNull();
  });
});
