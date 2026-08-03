import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Environment } from "@/types";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { LoopedReviewSupervisor } from "./LoopedReviewSupervisor";

function environment(id: string): Environment {
  return {
    id,
    projectId: "project-1",
    name: id,
    branch: "feature",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: `/tmp/${id}`,
    setupScriptsComplete: true,
  };
}

beforeEach(() => {
  useEnvironmentStore.setState({ environments: [] });
});

afterEach(cleanup);

describe("LoopedReviewSupervisor snapshot hydration", () => {
  test("hydrates every environment without mounting a workflow controller", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-b"), environment("env-a")] });
    const hydrate = mock(async (_environmentId: string) => []);

    const view = render(<LoopedReviewSupervisor hydrateWorkflows={hydrate} />);

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
    expect(hydrate.mock.calls.map(([id]) => id)).toEqual(["env-a", "env-b"]);
    expect(view.container.childElementCount).toBe(0);
  });

  test("rehydrates when environments change, including with no review tab mounted", async () => {
    const hydrate = mock(async (_environmentId: string) => []);
    const view = render(<LoopedReviewSupervisor hydrateWorkflows={hydrate} />);
    expect(hydrate).not.toHaveBeenCalled();

    act(() => useEnvironmentStore.setState({ environments: [environment("env-review")] }));
    view.rerender(<LoopedReviewSupervisor hydrateWorkflows={hydrate} />);

    await waitFor(() => expect(hydrate).toHaveBeenCalledWith("env-review"));
    expect(view.container.childElementCount).toBe(0);
  });

  test("a hydration failure is contained so background supervision remains backend-owned", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-review")] });
    const failure = new Error("offline");
    const hydrate = mock(async () => { throw failure; });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      render(<LoopedReviewSupervisor hydrateWorkflows={hydrate} />);
      await waitFor(() => expect(warnings.length).toBe(1));
      expect(String(warnings[0]?.[0])).toContain("Failed to hydrate");
      expect(warnings[0]?.[1]).toBe(failure);
    } finally {
      console.warn = originalWarn;
    }
  });
});
