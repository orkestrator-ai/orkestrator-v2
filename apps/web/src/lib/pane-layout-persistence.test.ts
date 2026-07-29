import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type EnvironmentPaneState,
  usePaneLayoutStore,
} from "@/stores/paneLayoutStore";
import type { PaneLeaf, PersistedPaneLayout } from "@/types/paneLayout";
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
    expect(save).toHaveBeenCalledWith(
      "env-1",
      expect.objectContaining({ activePaneId: "default" }),
      0,
    );
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
    const directSave = mock(async (
      environmentId: string,
      layout: LayoutInput,
      _expectedRevision: number,
    ) =>
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
      async () => null,
    );
    expect(directSave).toHaveBeenCalledTimes(1);
    expect(directSave.mock.calls[0]?.[0]).toBe("env-1");
    expect(directSave.mock.calls[0]?.[2]).toBe(0);
  });

  test("refuses a divergent direct flush without an authoritative merge base", async () => {
    const localRoot: PaneLeaf = {
      kind: "leaf",
      id: "default",
      tabs: [{ id: "local", type: "plain" }],
      activeTabId: "local",
    };
    const state: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "default",
      root: localRoot,
    };
    const input = createPersistedPaneLayoutInput(state);
    const remoteInput = createPersistedPaneLayoutInput({
      ...state,
      root: {
        ...localRoot,
        tabs: [
          ...localRoot.tabs,
          { id: "remote", type: "plain" },
        ],
      },
    });
    const directSave = mock(async (
      environmentId: string,
      layout: LayoutInput,
      _expectedRevision: number,
    ) => createSaved(environmentId, layout));

    await expect(flushPaneLayoutNow(
      "env-1",
      input,
      directSave,
      async () => ({
        ...remoteInput,
        environmentId: "env-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 2,
      }),
    )).rejects.toThrow("authoritative merge base");
    expect(directSave).not.toHaveBeenCalled();
  });

  test("seeds a pre-hydrated environment as the first write's CAS base", async () => {
    const hydrated: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 5,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "remote-existing", type: "plain" }],
        activeTabId: "remote-existing",
      },
    };
    usePaneLayoutStore.setState({
      environments: new Map([["env-1", hydrated]]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });
    const load = mock(async () => {
      throw new Error("the pre-hydrated base should avoid a fresh read");
    });
    const save = mock(async (
      environmentId: string,
      layout: LayoutInput,
      _expectedRevision: number,
    ) => ({
      ...layout,
      environmentId,
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 6,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });

    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "local-new", type: "plain" },
      "env-1",
    );
    await waitForTimers();

    expect(load).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2]).toBe(5);
    expect(save.mock.calls[0]?.[1].root).toMatchObject({
      tabs: [{ id: "remote-existing" }, { id: "local-new" }],
    });
    stop();
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
      async () => null,
    );
    expect(directSave).toHaveBeenCalledTimes(1);
  });

  test("canonicalizes every split selection and strips every native host port", () => {
    const state = {
      containerId: "container-1",
      activePaneId: "right",
      root: {
        kind: "split" as const,
        id: "split",
        direction: "horizontal" as const,
        sizes: [40, 60] as [number, number],
        depth: 1,
        children: [
          {
            kind: "leaf" as const,
            id: "left",
            tabs: [
              {
                id: "claude",
                type: "claude-native" as const,
                claudeNativeData: { environmentId: "env-1", hostPort: 1 },
              },
              {
                id: "codex",
                type: "codex-native" as const,
                codexNativeData: { environmentId: "env-1", hostPort: 2 },
              },
            ],
            activeTabId: "codex",
          },
          {
            kind: "leaf" as const,
            id: "right",
            tabs: [{
              id: "opencode",
              type: "opencode-native" as const,
              openCodeNativeData: { environmentId: "env-1", hostPort: 3 },
            }],
            activeTabId: "opencode",
          },
        ],
      },
    } satisfies EnvironmentPaneState;

    const persisted = createPersistedPaneLayoutInput(state);

    expect(persisted.activePaneId).toBe("left");
    expect(persisted.root).toMatchObject({
      children: [
        { activeTabId: "claude" },
        { activeTabId: "opencode" },
      ],
    });
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(state.activePaneId).toBe("right");
    expect(state.root.children[0].activeTabId).toBe("codex");
  });

  test("rebases a conflicting local addition over a remote addition", async () => {
    const baseState = {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 1,
      root: {
        kind: "leaf" as const,
        id: "default",
        tabs: [{ id: "base", type: "plain" as const }],
        activeTabId: "base",
      },
    };
    const remoteInput = createPersistedPaneLayoutInput({
      ...baseState,
      root: {
        ...baseState.root,
        tabs: [
          ...baseState.root.tabs,
          { id: "remote", type: "plain" as const },
        ],
      },
    });
    const save = mock(async (
      environmentId: string,
      layout: LayoutInput,
      expectedRevision: number,
    ) => {
      if (save.mock.calls.length === 1) {
        throw new Error(
          `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
        );
      }
      return {
        ...layout,
        environmentId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 3,
      };
    });
    const load = mock(async () => ({
      ...remoteInput,
      environmentId: "env-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", baseState);
    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "local", type: "plain" },
      "env-1",
    );

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> })
        .tabs.map(({ id }) => id),
    ).toEqual(["base", "remote", "local"]);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base", "remote", "local"]);

    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "later-local", type: "plain" },
      "env-1",
    );
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2]?.[2]).toBe(3);
    expect(save.mock.calls[2]?.[1].root).toMatchObject({
      tabs: [
        { id: "base" },
        { id: "remote" },
        { id: "local" },
        { id: "later-local" },
      ],
    });
    stop();
  });

  test("treats a revision-zero hydrated layout as unsaved on conflict", async () => {
    const localState: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 0,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "setup", type: "plain" }],
        activeTabId: "setup",
      },
    };
    const remoteInput = createPersistedPaneLayoutInput({
      ...localState,
      backendRevision: 2,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "remote", type: "plain" }],
        activeTabId: "remote",
      },
    });
    const save = mock(async (
      environmentId: string,
      layout: LayoutInput,
      expectedRevision: number,
    ) => {
      if (save.mock.calls.length === 1) {
        throw new Error(
          `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
        );
      }
      return {
        ...layout,
        environmentId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 3,
      };
    });
    const load = mock(async () => ({
      ...remoteInput,
      environmentId: "env-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
    }));
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", localState);
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });

    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "new-local", type: "plain" },
      "env-1",
    );
    await waitForTimers();

    expect(save.mock.calls.map((call) => call[2])).toEqual([0, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> })
        .tabs.map(({ id }) => id),
    ).toEqual(["remote", "setup", "new-local"]);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["remote", "setup", "new-local"]);
    stop();
  });

  test("recognizes and retries a revision conflict wrapped by Electron IPC", async () => {
    const baseRoot = {
      kind: "leaf" as const,
      id: "default",
      tabs: [{ id: "base", type: "plain" as const }],
      activeTabId: "base",
    };
    const baseState: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 1,
      root: baseRoot,
    };
    const remoteInput = createPersistedPaneLayoutInput({
      ...baseState,
      root: {
        ...baseRoot,
        tabs: [
          ...baseRoot.tabs,
          { id: "remote", type: "plain" as const },
        ],
      },
    });
    const save = mock(async (
      environmentId: string,
      layout: LayoutInput,
      expectedRevision: number,
    ) => {
      if (save.mock.calls.length === 1) {
        throw new Error(
          "Error invoking remote method 'orkestrator:invoke': Error: "
            + `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
        );
      }
      return {
        ...createSaved(environmentId, layout),
        revision: 3,
      };
    });
    const load = mock(async () => ({
      ...remoteInput,
      environmentId: "env-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", baseState);
    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "local", type: "plain" },
      "env-1",
    );

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> })
        .tabs.map(({ id }) => id),
    ).toEqual(["base", "remote", "local"]);
    stop();
  });

  test("replaces a conflicting layout from an older container generation", async () => {
    const oldState = {
      containerId: "container-old",
      activePaneId: "default",
      backendRevision: 1,
      root: {
        kind: "leaf" as const,
        id: "default",
        tabs: [{ id: "old-session", type: "claude-native" as const }],
        activeTabId: "old-session",
      },
    };
    const remoteOldInput = createPersistedPaneLayoutInput({
      ...oldState,
      root: {
        ...oldState.root,
        tabs: [
          ...oldState.root.tabs,
          { id: "remote-old-session", type: "plain" as const },
        ],
      },
    });
    const save = mock(async (
      environmentId: string,
      layout: LayoutInput,
      expectedRevision: number,
    ) => {
      if (save.mock.calls.length === 1) {
        throw new Error(
          `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
        );
      }
      return {
        ...layout,
        environmentId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 3,
      };
    });
    const load = mock(async () => ({
      ...remoteOldInput,
      environmentId: "env-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-old", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", oldState);

    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-1", {
        containerId: "container-new",
        activePaneId: "default",
        backendRevision: 0,
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "new-session", type: "plain" }],
          activeTabId: "new-session",
        },
      }),
    }));
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    const retried = save.mock.calls[1]![1];
    expect(retried.containerId).toBe("container-new");
    expect(
      (retried.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    ).toEqual(["new-session"]);
    stop();
  });

  test("bounds repeated conflict retries", async () => {
    let remoteRevision = 1;
    const save = mock(async () => {
      throw new Error(
        `Pane layout revision conflict: expected ${remoteRevision - 1}, current ${remoteRevision}`,
      );
    });
    const load = mock(async () => {
      const input = createPersistedPaneLayoutInput(
        usePaneLayoutStore.getState().environments.get("env-1")!,
      );
      return {
        ...input,
        environmentId: "env-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: remoteRevision++,
      };
    });
    const stop = startPaneLayoutPersistence({
      save,
      load,
      debounceMs: 5,
      maxConflictRetries: 1,
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  test("accepts an idle authoritative revision without echoing it", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      ({ ...createSaved(environmentId, input), revision: 3 })
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    const authoritative = {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 2,
      root: {
        kind: "leaf" as const,
        id: "default",
        tabs: [{ id: "remote", type: "plain" as const }],
        activeTabId: "remote",
      },
    };

    expect(adoptPersistedPaneLayout("env-1", authoritative)).toBe(true);
    usePaneLayoutStore.getState().applyAuthoritativeLayout(
      "env-1",
      authoritative,
    );
    await waitForTimers();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  test("rejects adoption while a save is already in flight", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      await blocked;
      return createSaved(environmentId, input);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");
    await waitForTimers();

    expect(adoptPersistedPaneLayout("env-1", {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 2,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "remote", type: "plain" }],
        activeTabId: "remote",
      },
    })).toBe(false);
    release();
    await waitForTimers();
    stop();
  });

  test("flushes pending writes on pagehide and hidden visibility", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input)
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 60_000 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "pagehide", type: "plain" }, "env-1");
    window.dispatchEvent(new Event("pagehide"));
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "hidden", type: "plain" },
      "env-1",
    );
    const originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(2);
    if (originalVisibility) {
      Object.defineProperty(document, "visibilityState", originalVisibility);
    }
    stop();
  });

  test("propagates direct and chained immediate save failures", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [],
        activeTabId: null,
      },
    });
    await expect(flushPaneLayoutNow(
      "env-1",
      input,
      async () => {
        throw new Error("direct offline");
      },
      async () => null,
    )).rejects.toThrow("direct offline");

    const stop = startPaneLayoutPersistence({
      save: async () => {
        throw new Error("chain offline");
      },
      debounceMs: 60_000,
    });
    await expect(flushPaneLayoutNow("env-1", input)).rejects.toThrow(
      "chain offline",
    );
    stop();
  });
});
