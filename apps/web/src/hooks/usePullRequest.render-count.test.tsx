import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { usePullRequest } from "./usePullRequest";
import { appCommandStore } from "@/test/app-command-store";

// WEB-7: the hook used to call `useEnvironmentStore()` with no selector, so
// every write to the store re-rendered the action bar that consumes it.

function environment(id: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    projectId: "project-1",
    name: id,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    ...overrides,
  } as Environment;
}

const INITIAL = appCommandStore(environmentStore).getState();

beforeEach(() => {
  appCommandStore(environmentStore).setState({
    environments: [
      environment("environment-1", {
        prUrl: "https://github.com/acme/app/pull/1",
        prState: "open",
        hasMergeConflicts: false,
      }),
      environment("environment-2"),
    ],
  });
});

afterEach(() => {
  cleanup();
  appCommandStore(environmentStore).setState(INITIAL, true);
});

describe("usePullRequest subscriptions", () => {
  test("does not re-render for a change to another environment", () => {
    let renders = 0;
    const { result } = renderHookInAppCommandScope(() => {
      renders += 1;
      return usePullRequest({ environmentId: "environment-1" });
    });
    expect(result.current.prUrl).toBe("https://github.com/acme/app/pull/1");
    expect(result.current.prState).toBe("open");
    expect(result.current.hasMergeConflicts).toBe(false);

    const before = renders;
    act(() => {
      const store = appCommandStore(environmentStore).getState();
      store.updateEnvironmentStatus("environment-2", "stopped");
      store.setEnvironmentPR("environment-2", "https://github.com/acme/app/pull/2", "open");
      store.setDeleting("environment-2", true);
    });
    expect(renders).toBe(before);

    // A change to this environment's PR fields still reaches the consumer.
    act(() => {
      appCommandStore(environmentStore)
        .getState()
        .setEnvironmentPR("environment-1", "https://github.com/acme/app/pull/1", "merged", true);
    });
    expect(renders).toBeGreaterThan(before);
    expect(result.current.prState).toBe("merged");
    expect(result.current.hasMergeConflicts).toBe(true);
  });

  test("returns empty PR fields without an environment", () => {
    const { result } = renderHookInAppCommandScope(() => usePullRequest({ environmentId: null }));
    expect(result.current.prUrl).toBeNull();
    expect(result.current.prState).toBeNull();
    expect(result.current.hasMergeConflicts).toBeNull();
  });
});
