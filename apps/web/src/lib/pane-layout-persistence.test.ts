import { beforeEach, describe, expect, mock, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PersistedPaneLayout } from "@/types/paneLayout";
import {
  adoptPersistedPaneLayout,
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  startPaneLayoutPersistence,
} from "./pane-layout-persistence";
import { reconcilePersistedLayout } from "./pane-layout-restore";

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
      agentHandoffId: "handoff-1",
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
    expect(JSON.stringify(persisted)).toContain('"agentHandoffId":"handoff-1"');
    expect(JSON.stringify(persisted)).toContain('"initialAgentModel":"gpt-5.6-sol"');
    expect(JSON.stringify(persisted)).toContain('"initialReasoningEffort":"xhigh"');
    expect(JSON.stringify(persisted)).not.toContain("initialCommands");
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(JSON.stringify(persisted)).toContain("session-1");

    // Persisting is only half the contract — the restore side has to read them
    // back, or the write is dead weight and the one-shot choice is lost on the
    // reload it exists for. Round-trip the real payload through the real
    // restorer rather than trusting the write alone.
    const rehydrated = reconcilePersistedLayout(
      createSaved("env-1", persisted!),
      { environmentId: "env-1", containerId: "container-1", isLocal: false },
    );
    const rehydratedTab = (rehydrated?.root as unknown as { tabs: Array<Record<string, unknown>> })
      .tabs.find((tab) => tab.id === "native");
    expect(rehydratedTab?.initialAgentModel).toBe("gpt-5.6-sol");
    expect(rehydratedTab?.initialReasoningEffort).toBe("xhigh");
    expect(rehydratedTab?.initialPrompt).toBeUndefined();
    expect(rehydratedTab?.agentHandoffId).toBe("handoff-1");

    store.clearTabInitialAgentOptions("native", "env-1");
    await waitForTimers();
    const consumed = save.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(consumed)).not.toContain("initialAgentModel");
    expect(JSON.stringify(consumed)).not.toContain("initialReasoningEffort");
    stop();
  });

  test("debounces changes and retries a failed snapshot after the next shared change", async () => {
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

    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "tab-3", type: "plain" },
      "env-1",
    );
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  test("keeps active pane and tab selection out of the shared snapshot", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input)
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    store.addTab("default", { id: "tab-2", type: "plain" }, "env-1");
    store.beginHydration("env-1");
    store.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    usePaneLayoutStore.getState().setActiveTab("default", "tab-1", "env-1");
    await waitForTimers();

    expect(save).not.toHaveBeenCalled();
    const input = createPersistedPaneLayoutInput(
      usePaneLayoutStore.getState().environments.get("env-1")!,
    );
    expect(input.activePaneId).toBe("default");
    expect((input.root as { activeTabId: string }).activeTabId).toBe("tab-1");
    stop();
  });

  test("does not adopt an older snapshot over a queued local tab change", () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input)
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 60_000 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "new-local-tab", type: "plain" }, "env-1");

    const olderSnapshot = {
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf" as const,
        id: "default",
        tabs: [{ id: "older-tab", type: "plain" as const }],
        activeTabId: "older-tab",
      },
    };

    expect(adoptPersistedPaneLayout("env-1", olderSnapshot)).toBe(false);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["new-local-tab"]);
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

  test("flushPaneLayoutNow orders its write behind an in-flight debounced write", async () => {
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

    // A direct write issued while the older write is still in flight must not
    // overtake it — otherwise the older payload lands last and discards the tab
    // this write exists to record.
    usePaneLayoutStore.getState().addTab("default", { id: "agent", type: "codex-native" }, "env-1");
    const flushed = flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
    );
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flushed;
    await waitForTimers();

    const order = save.mock.calls.map(
      ([, input]) => (input.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    );
    expect(order[0]).toEqual(["tab-1"]);
    expect(order[1]).toEqual(["tab-1", "agent"]);
    // The debounced writer must not then echo the identical layout back.
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  test("flushPaneLayoutNow resolves after the layout is durably saved", async () => {
    const saved: string[] = [];
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      saved.push(environmentId);
      return createSaved(environmentId, input);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 60_000 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "agent", type: "claude-native" }, "env-1");

    await flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
    );
    expect(saved).toEqual(["env-1"]);
    stop();
  });

  test("flushPaneLayoutNow falls back to a direct save when no persistence loop is running", async () => {
    const directSave = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout)
    );
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");

    // No startPaneLayoutPersistence() in this test, so there is no write chain to
    // join; the layout must still be written rather than silently dropped.
    await flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
      directSave,
    );
    expect(directSave).toHaveBeenCalledTimes(1);
    expect(directSave.mock.calls[0]?.[0]).toBe("env-1");
  });

  test("flushPaneLayoutNow prefers the active write chain over the direct save", async () => {
    const chainSave = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const directSave = mock(async (environmentId: string, input: LayoutInput) => createSaved(environmentId, input));
    const stop = startPaneLayoutPersistence({ save: chainSave, debounceMs: 60_000 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");

    await flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
      directSave,
    );
    expect(chainSave).toHaveBeenCalledTimes(1);
    expect(directSave).not.toHaveBeenCalled();
    stop();

    // After teardown the chain is deregistered and the fallback applies again.
    await flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
      directSave,
    );
    expect(directSave).toHaveBeenCalledTimes(1);
  });
});
