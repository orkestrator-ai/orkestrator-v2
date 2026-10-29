import { afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import type { GraphDescribeJobView } from "@orkestrator/protocol/graphs/describe";
import { invoke } from "@/lib/native/backend";
import { useGraphDescribeStore } from "./graphDescribeStore";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

function job(overrides: Partial<GraphDescribeJobView> = {}): GraphDescribeJobView {
  return {
    id: "job-1",
    environmentId: "env-1",
    projectId: "project-1",
    status: "running",
    progress: "drafting",
    repairs: 0,
    agent: "codex",
    description: "A graph",
    modifying: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

const entry = () => useGraphDescribeStore.getState().entries.get("env-1");

beforeEach(() => useGraphDescribeStore.setState({ entries: new Map() }));
afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("graphDescribeStore", () => {
  test("mirrors the backend's job through the describe commands", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "graph_describe_status") return job();
      if (command === "graph_describe_cancel") return job({ status: "cancelled" });
      if (command === "graph_describe_dismiss") return { dismissed: true };
      throw new Error(`unexpected ${String(command)}`);
    });
    await useGraphDescribeStore.getState().refresh("env-1");
    expect(entry()).toMatchObject({ loaded: true, job: { status: "running" } });
    await useGraphDescribeStore.getState().cancel("env-1");
    expect(entry()?.job?.status).toBe("cancelled");
    await useGraphDescribeStore.getState().dismiss("env-1", "job-1");
    expect(entry()?.job).toBeNull();
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "graph_describe_status",
      "graph_describe_cancel",
      "graph_describe_dismiss",
    ]);
    expect(invokeMock.mock.calls[2]![1]).toEqual({ environmentId: "env-1", jobId: "job-1" });
  });

  test("keeps the backend's refusal of a start", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("Start the environment first");
    });
    await expect(
      useGraphDescribeStore
        .getState()
        .start({ environmentId: "env-1", description: "A graph", agent: "codex" }),
    ).rejects.toThrow("Start the environment first");
    expect(entry()).toMatchObject({ busy: null, error: "Start the environment first" });
  });

  test("a read that a start overtook is dropped", async () => {
    let answer: (value: GraphDescribeJobView | null) => void = () => undefined;
    invokeMock.mockImplementation(async (command) => {
      if (command === "graph_describe_status") {
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      return job({ id: "job-2", progress: "starting" });
    });
    const reading = useGraphDescribeStore.getState().refresh("env-1");
    await useGraphDescribeStore
      .getState()
      .start({ environmentId: "env-1", description: "A graph", agent: "codex" });
    answer(null);
    await reading;
    expect(entry()?.job?.id).toBe("job-2");
  });
});
