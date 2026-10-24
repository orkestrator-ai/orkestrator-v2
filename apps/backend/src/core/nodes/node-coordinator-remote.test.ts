import { describe, expect, test } from "bun:test";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";

import { bridgeRemoteCoordinatorEvents, NodeCoordinatorRemote } from "./node-coordinator-remote.js";

function remote(answers: Record<string, unknown | Error>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const access = new NodeCoordinatorRemote({
    invokeOnNode: async ({ command, args }) => {
      calls.push({ command, args });
      const answer = answers[command];
      if (answer instanceof Error) throw answer;
      return answer === "unknown" ? { outcome: "unknown" } : { outcome: "ok", result: answer };
    },
    summaries: async () =>
      ({
        selfId: "bk_cmd",
        nodes: [{ nodeId: "bk_leaf", view: { displayName: "Build box" } }],
      }) as never,
  });
  return { access, calls };
}

describe("NodeCoordinatorRemote", () => {
  test("reads a worker's environment and tab state through the node", async () => {
    const { access, calls } = remote({
      get_environment: { id: "e1", projectId: "p-leaf", name: "feature", status: "running" },
      get_agent_registry: {
        entries: [
          { environmentId: "e1", tabId: "startup-agent", state: "idle" },
          { environmentId: "e1", tabId: "other", state: "working" },
        ],
      },
    });

    expect(await access.workerState("bk_leaf", "e1", "startup-agent")).toEqual({
      environment: "running",
      tab: "idle",
      name: "feature",
      requestPending: false,
    });
    expect(calls.find((call) => call.command === "get_agent_registry")?.args).toEqual({
      projectId: "p-leaf",
      environmentId: "e1",
    });
    expect(calls.find((call) => call.command === "get_worker_request_state")?.args).toEqual({
      environmentId: "e1",
      tabId: "startup-agent",
    });
    expect(await access.nodeName("bk_leaf")).toBe("Build box");
  });

  test("a worker with a request it has not read is reported as such", async () => {
    const { access } = remote({
      get_environment: { projectId: "p-leaf", status: "stopped" },
      get_worker_request_state: { requestPending: true },
    });
    expect(await access.workerState("bk_leaf", "e1", "startup-agent")).toEqual({
      environment: "stopped",
      tab: "unknown",
      requestPending: true,
    });
  });

  test("maps lifecycle states and treats a missing node answer as unavailable", async () => {
    expect(
      await remote({ get_environment: null }).access.workerState("bk_leaf", "e1", "t"),
    ).toEqual({ environment: "missing", tab: "unknown" });
    expect(
      await remote({
        get_environment: { status: "running", deletionRequestedAt: "x" },
      }).access.workerState("bk_leaf", "e1", "t"),
    ).toMatchObject({ environment: "deleting" });
    expect(
      await remote({ get_environment: { status: "error" } }).access.workerState(
        "bk_leaf",
        "e",
        "t",
      ),
    ).toMatchObject({ environment: "error" });
    expect(
      await remote({ get_environment: new Error("not connected") }).access.workerState(
        "bk_leaf",
        "e1",
        "t",
      ),
    ).toBe("unavailable");
    expect(
      await remote({ get_build_pipeline: "unknown" }).access.workflow(
        "bk_leaf",
        "build-pipeline",
        "p1",
      ),
    ).toBe("unavailable");
    expect(
      await remote({
        get_multi_review_workflow: { snapshot: { id: "w" }, revision: 2, environmentId: "e1" },
      }).access.workflow("bk_leaf", "multi-review", "w"),
    ).toEqual({ snapshot: { id: "w" }, revision: 2, environmentId: "e1" });
  });
});

describe("bridgeRemoteCoordinatorEvents", () => {
  test("settles a remote worker once per burst and forwards workflow changes", async () => {
    let listener: ((event: string, payload: unknown, nodeId: string) => void) | null = null;
    const settled: string[] = [];
    const workflows: string[] = [];
    const due: Array<() => void> = [];
    bridgeRemoteCoordinatorEvents({
      onNodeEvent: (next) => {
        listener = next;
        return () => undefined;
      },
      settleRemoteWorker: async (nodeId, environmentId) => {
        settled.push(`${nodeId}/${environmentId}`);
      },
      noteRemoteWorkflowChange: (nodeId, kind, id) => workflows.push(`${nodeId}/${kind}/${id}`),
      timers: { setTimeout: (callback) => due.push(callback) },
    });
    const emit = (payload: unknown) => listener!(RESOURCE_CHANGED_EVENT, payload, "bk_leaf");

    emit({ resource: "environment", id: "e1" });
    emit({ resource: "environment", id: "e1" });
    emit({ resource: "build-pipeline", id: "p1" });
    emit({ resource: "kanban", id: "x" });
    listener!("node-outbox-ready", { resource: "environment", id: "e2" }, "bk_leaf");
    expect(due).toHaveLength(1);
    due.shift()!();
    await Promise.resolve();

    expect(settled).toEqual(["bk_leaf/e1"]);
    expect(workflows).toEqual(["bk_leaf/build-pipeline/p1"]);
    emit({ resource: "environment", id: "e1" });
    expect(due).toHaveLength(1);
  });
});
