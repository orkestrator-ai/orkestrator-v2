import { beforeEach, describe, expect, mock, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PersistedPaneLayout } from "@/types/paneLayout";
import {
  createPersistedPaneLayoutInput,
  startPaneLayoutPersistence,
} from "./pane-layout-persistence";

const waitForTimers = () => new Promise((resolve) => setTimeout(resolve, 20));
type LayoutInput = ReturnType<typeof createPersistedPaneLayoutInput>;

function resetStore() {
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
}

function savedResult(
  environmentId: string,
  input: LayoutInput,
): PersistedPaneLayout {
  return {
    ...input,
    environmentId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

function createSaved(environmentId: string, input: LayoutInput) {
  return savedResult(environmentId, input);
}

describe("pane layout persistence", () => {
  beforeEach(resetStore);

  test("does not write before hydration and primes a restored snapshot without echoing it", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().beginHydration("env-1");
    usePaneLayoutStore.getState().finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    await waitForTimers();
    expect(save).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().addTab("default", {
      id: "native",
      type: "claude-native",
      initialPrompt: "do not persist",
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "xhigh",
      initialCommands: ["do not persist"],
      claudeNativeData: {
        environmentId: "env-1",
        containerId: "container-1",
        hostPort: 1234,
        sessionId: "session-1",
      },
    }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);
    const persisted = save.mock.calls[0]?.[1];
    expect(JSON.stringify(persisted)).not.toContain("initialPrompt");
    expect(JSON.stringify(persisted)).not.toContain("initialAgentModel");
    expect(JSON.stringify(persisted)).not.toContain("initialReasoningEffort");
    expect(JSON.stringify(persisted)).not.toContain("initialCommands");
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(JSON.stringify(persisted)).toContain("session-1");
    stop();
  });

  test("debounces changes and retries a failed snapshot after the next change", async () => {
    let attempts = 0;
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return createSaved(environmentId, input);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    store.addTab("default", { id: "tab-2", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    usePaneLayoutStore.getState().setActiveTab("default", "tab-1", "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  test("flushes a pending write when persistence is stopped", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 60_000 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");

    stop();
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("env-1", expect.objectContaining({ activePaneId: "default" }));
  });

  test("persists hydrated environments independently", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    for (const environmentId of ["env-1", "env-2"]) {
      store.initialize(`container-${environmentId}`, environmentId);
      store.beginHydration(environmentId);
      store.finishHydration(environmentId);
      store.addTab("default", { id: `tab-${environmentId}`, type: "plain" }, environmentId);
    }

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([environmentId]) => environmentId).sort()).toEqual(["env-1", "env-2"]);
    stop();
  });

  test("cancels a pending write when its environment is removed", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 10 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");

    usePaneLayoutStore.setState({ environments: new Map(), hydration: new Map() });
    await waitForTimers();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  test("does not write when a state update has an identical sanitized snapshot", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "tab-1", type: "plain", initialPrompt: "one shot" }, "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");

    usePaneLayoutStore.getState().clearTabInitialPrompt("tab-1", "env-1");
    await waitForTimers();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  test("serializes in-flight writes per environment in update order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      if (save.mock.calls.length === 1) await firstBlocked;
      return createSaved(environmentId, input);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    usePaneLayoutStore.getState().addTab("default", { id: "tab-2", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(2);
    const firstTabs = (save.mock.calls[0]?.[1].root as { tabs: Array<{ id: string }> }).tabs;
    const secondTabs = (save.mock.calls[1]?.[1].root as { tabs: Array<{ id: string }> }).tabs;
    expect(firstTabs.map(({ id }) => id)).toEqual(["tab-1"]);
    expect(secondTabs.map(({ id }) => id)).toEqual(["tab-1", "tab-2"]);
    stop();
  });
});
