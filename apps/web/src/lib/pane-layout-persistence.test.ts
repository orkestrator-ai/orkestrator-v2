import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { type EnvironmentPaneState, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type { PaneLeaf, PersistedPaneLayout, TabInfo } from "@/types/paneLayout";
import {
  adoptPersistedPaneLayout,
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  onPaneLayoutWriteSettled,
  startPaneLayoutPersistence,
} from "./pane-layout-persistence";
import { reconcilePersistedLayout } from "./pane-layout-restore";
import { mockToastError } from "../../../../tests/mocks/sonner";

const waitForTimers = () => new Promise((resolve) => setTimeout(resolve, 20));
type LayoutInput = ReturnType<typeof createPersistedPaneLayoutInput>;

/**
 * The post-save install reconciles against the environment record, exactly as
 * the change-feed refresh does, so a layout can never be installed for an
 * environment this client no longer has.
 */
function seedEnvironment(containerId: string | null, environmentId = "env-1"): void {
  useEnvironmentStore.setState({
    environments: [
      {
        id: environmentId,
        name: environmentId,
        projectId: "project-1",
        status: "running",
        environmentType: containerId === null ? "local" : "docker",
        containerId,
        branch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as Environment,
    ],
  });
}

function resetStore() {
  useEnvironmentStore.setState({ environments: [] });
  seedEnvironment("container-1");
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
}

function savedResult(environmentId: string, input: LayoutInput): PersistedPaneLayout {
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
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().beginHydration("env-1");
    usePaneLayoutStore
      .getState()
      .finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    await waitForTimers();
    expect(save).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "native",
        type: "agent-native",
        initialPrompt: "do not persist",
        agentHandoffId: "handoff-1",
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "xhigh",
        initialExecutionProfileId: "plan",
        initialCommands: ["do not persist"],
        nativeAgentData: {
          environmentId: "env-1",
          containerId: "container-1",
          hostPort: 1234,
          sessionId: "session-1",
        },
      },
      "env-1",
    );
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);
    const persisted = save.mock.calls[0]?.[1];
    expect(JSON.stringify(persisted)).not.toContain("initialPrompt");
    expect(JSON.stringify(persisted)).toContain('"agentHandoffId":"handoff-1"');
    expect(JSON.stringify(persisted)).toContain('"initialAgentModel":"gpt-5.6-sol"');
    expect(JSON.stringify(persisted)).toContain('"initialReasoningEffort":"xhigh"');
    expect(JSON.stringify(persisted)).toContain('"initialExecutionProfileId":"plan"');
    expect(JSON.stringify(persisted)).not.toContain("initialCommands");
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(JSON.stringify(persisted)).toContain("session-1");

    // Persisting is only half the contract — the restore side has to read them
    // back, or the write is dead weight and the one-shot choice is lost on the
    // reload it exists for. Round-trip the real payload through the real
    // restorer rather than trusting the write alone.
    const rehydrated = reconcilePersistedLayout(createSaved("env-1", persisted!), {
      environmentId: "env-1",
      containerId: "container-1",
      isLocal: false,
    });
    const rehydratedTab = (
      rehydrated!.root as unknown as { tabs: Array<Record<string, unknown>> }
    ).tabs.find((tab) => tab.id === "native");
    expect(rehydratedTab?.initialAgentModel).toBe("gpt-5.6-sol");
    expect(rehydratedTab?.initialReasoningEffort).toBe("xhigh");
    expect(rehydratedTab?.initialExecutionProfileId).toBe("plan");
    expect(rehydratedTab?.initialPrompt).toBeUndefined();
    expect(rehydratedTab?.agentHandoffId).toBe("handoff-1");

    store.clearTabInitialAgentOptions("native", "env-1");
    await waitForTimers();
    const consumed = save.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(consumed)).not.toContain("initialAgentModel");
    expect(JSON.stringify(consumed)).not.toContain("initialReasoningEffort");
    expect(JSON.stringify(consumed)).not.toContain("initialExecutionProfileId");
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

    usePaneLayoutStore.getState().addTab("default", { id: "tab-3", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  test("persists active pane and tab selection immediately", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
    store.addTab("default", { id: "tab-2", type: "plain" }, "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));

    usePaneLayoutStore.getState().setActiveTab("default", "tab-1", "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      activePaneId: "default",
      root: { activeTabId: "tab-1" },
    });
    const input = createPersistedPaneLayoutInput(
      usePaneLayoutStore.getState().environments.get("env-1")!,
    );
    expect(input.activePaneId).toBe("default");
    expect((input.root as { activeTabId: string }).activeTabId).toBe("tab-1");
    stop();
  });

  test("persists an active-pane-only change immediately", async () => {
    const splitState: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "left",
      backendRevision: 4,
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "left-tab", type: "plain" }],
            activeTabId: "left-tab",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [{ id: "right-tab", type: "plain" }],
            activeTabId: "right-tab",
          },
        ],
      },
    };
    usePaneLayoutStore.setState({
      environments: new Map([["env-1", splitState]]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });
    const save = mock(async (environmentId: string, input: LayoutInput) => ({
      ...createSaved(environmentId, input),
      revision: 5,
    }));
    const stop = startPaneLayoutPersistence({
      save,
      debounceMs: 60_000,
      selectionDebounceMs: 5,
    });

    usePaneLayoutStore.getState().setActivePane("right", "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].activePaneId).toBe("right");
    stop();
  });

  test("keeps the latest focus when it returns to the original tab in flight", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let revision = 0;
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      if (save.mock.calls.length === 1) await firstBlocked;
      revision += 1;
      return { ...createSaved(environmentId, input), revision };
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.addTab("default", { id: "b", type: "plain" }, "env-1");
    store.setActiveTab("default", "a", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });

    usePaneLayoutStore.getState().setActiveTab("default", "b", "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);
    usePaneLayoutStore.getState().setActiveTab("default", "a", "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitForTimers();
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect((save.mock.calls.at(-1)![1].root as PaneLeaf).activeTabId).toBe("a");
    expect(usePaneLayoutStore.getState().getPane("default", "env-1")?.activeTabId).toBe("a");
    stop();
  });

  test("an immediate flush consumes a parked selection without reverting it", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let revision = 0;
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      if (save.mock.calls.length === 1) await firstBlocked;
      revision += 1;
      return { ...createSaved(environmentId, input), revision };
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.addTab("default", { id: "b", type: "plain" }, "env-1");
    store.setActiveTab("default", "a", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });

    store.setActiveTab("default", "b", "env-1");
    await waitForTimers();
    store.setActiveTab("default", "a", "env-1");
    const flushed = flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
    );
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flushed;
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([, layout]) => (layout.root as PaneLeaf).activeTabId)).toEqual([
      "b",
      "a",
    ]);
    expect(store.getPane("default", "env-1")?.activeTabId).toBe("a");
    stop();
  });

  test("coalesces a rapid focus burst to one bounded successor write", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let revision = 0;
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      if (save.mock.calls.length === 1) await firstBlocked;
      revision += 1;
      return { ...createSaved(environmentId, input), revision };
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.addTab("default", { id: "b", type: "plain" }, "env-1");
    store.setActiveTab("default", "a", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });

    usePaneLayoutStore.getState().setActiveTab("default", "b", "env-1");
    await waitForTimers();
    for (let index = 0; index < 500; index += 1) {
      usePaneLayoutStore.getState().setActiveTab("default", index % 2 === 0 ? "b" : "a", "env-1");
    }
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitForTimers();
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect((save.mock.calls[1]![1].root as PaneLeaf).activeTabId).toBe("a");
    stop();
  });

  test("debounces a rapid focus cycle into one backend write", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.addTab("default", { id: "b", type: "plain" }, "env-1");
    store.setActiveTab("default", "a", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({
      save,
      debounceMs: 60_000,
      selectionDebounceMs: 25,
    });

    for (let index = 0; index < 10; index += 1) {
      store.setActiveTab("default", index % 2 === 0 ? "b" : "a", "env-1");
    }
    expect(save).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![1].root as PaneLeaf).activeTabId).toBe("a");
    stop();
  });

  test("promotes a pending structural edit together with its latest focus", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({
      save,
      debounceMs: 60_000,
      selectionDebounceMs: 5,
    });

    usePaneLayoutStore.getState().addTab("default", { id: "b", type: "plain" }, "env-1");
    usePaneLayoutStore.getState().setActiveTab("default", "a", "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].root).toMatchObject({
      tabs: [{ id: "a" }, { id: "b" }],
      activeTabId: "a",
    });
    stop();
  });

  test("does not adopt an older snapshot over a queued local tab change", () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
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
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-1")
        .map(({ id }) => id),
    ).toEqual(["new-local-tab"]);
    stop();
  });

  test("flushes a pending write when persistence is stopped", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
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
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
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
    expect(save.mock.calls.map(([environmentId]) => environmentId).sort()).toEqual([
      "env-1",
      "env-2",
    ]);
    stop();
  });

  test("cancels a pending write when its environment is removed", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
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
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
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
    const firstTabs = (save.mock.calls[0]![1].root as { tabs: Array<{ id: string }> }).tabs;
    const secondTabs = (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs;
    expect(firstTabs.map(({ id }) => id)).toEqual(["tab-1"]);
    expect(secondTabs.map(({ id }) => id)).toEqual(["tab-1", "tab-2"]);
    stop();
  });

  test("retains a failed structural write when a later focus snapshot retries it", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let revision = 0;
    const save = mock(async (environmentId: string, input: LayoutInput) => {
      if (save.mock.calls.length === 1) {
        await firstBlocked;
        throw new Error("offline");
      }
      revision += 1;
      return { ...createSaved(environmentId, input), revision };
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });

    usePaneLayoutStore.getState().addTab("default", { id: "structural", type: "plain" }, "env-1");
    await waitForTimers();
    usePaneLayoutStore.getState().setActiveTab("default", "a", "env-1");
    releaseFirst();
    await waitForTimers();
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[1].root).toMatchObject({
      tabs: [{ id: "a" }, { id: "structural" }],
      activeTabId: "a",
    });
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
    usePaneLayoutStore.getState().addTab("default", { id: "agent", type: "agent-native" }, "env-1");
    const flushed = flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
    );
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flushed;
    await waitForTimers();

    const order = save.mock.calls.map(([, input]) =>
      (input.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
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
    store.addTab("default", { id: "agent", type: "agent-native" }, "env-1");

    await flushPaneLayoutNow(
      "env-1",
      createPersistedPaneLayoutInput(usePaneLayoutStore.getState().environments.get("env-1")!),
    );
    expect(saved).toEqual(["env-1"]);
    stop();
  });

  test("flushPaneLayoutNow falls back to a direct save when no persistence loop is running", async () => {
    const directSave = mock(
      async (environmentId: string, layout: LayoutInput, _expectedRevision: number) =>
        createSaved(environmentId, layout),
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

  test("flushPaneLayoutNow directly upgrades a reconciled legacy record", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "a", type: "plain" },
          { id: "b", type: "plain" },
        ],
        activeTabId: "b",
      },
    });
    const save = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout),
    );

    await flushPaneLayoutNow("env-1", input, save, async () => ({
      ...createSaved("env-1", {
        ...input,
        version: 1,
        activePaneId: "default",
        root: { ...(input.root as PaneLeaf), activeTabId: "a" },
      }),
      revision: 7,
    }));

    expect(save).toHaveBeenCalledWith("env-1", input, 7);
  });

  test("flushPaneLayoutNow refuses to overwrite a future record", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "local", type: "plain" }],
        activeTabId: "local",
      },
    });
    const save = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout),
    );

    await expect(
      flushPaneLayoutNow("env-1", input, save, async () => ({
        ...createSaved("env-1", { ...input, version: 4 }),
        revision: 9,
      })),
    ).rejects.toThrow("Unsupported pane layout version: 4");
    expect(save).not.toHaveBeenCalled();
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
        tabs: [...localRoot.tabs, { id: "remote", type: "plain" }],
      },
    });
    const directSave = mock(
      async (environmentId: string, layout: LayoutInput, _expectedRevision: number) =>
        createSaved(environmentId, layout),
    );

    await expect(
      flushPaneLayoutNow("env-1", input, directSave, async () => ({
        ...remoteInput,
        environmentId: "env-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 2,
      })),
    ).rejects.toThrow("authoritative merge base");
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
    const save = mock(
      async (environmentId: string, layout: LayoutInput, _expectedRevision: number) => ({
        ...layout,
        environmentId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 6,
      }),
    );
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });

    usePaneLayoutStore.getState().addTab("default", { id: "local-new", type: "plain" }, "env-1");
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
    const chainSave = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const directSave = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
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

  test("persists every split selection and strips every native host port", () => {
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
                type: "agent-native" as const,
                nativeAgentData: { environmentId: "env-1", hostPort: 1 },
              },
              {
                id: "codex",
                type: "agent-native" as const,
                nativeAgentData: { environmentId: "env-1", hostPort: 2 },
              },
            ],
            activeTabId: "codex",
          },
          {
            kind: "leaf" as const,
            id: "right",
            tabs: [
              {
                id: "opencode",
                type: "agent-native" as const,
                nativeAgentData: { environmentId: "env-1", hostPort: 3 },
              },
            ],
            activeTabId: "opencode",
          },
        ],
      },
    } satisfies EnvironmentPaneState;

    const persisted = createPersistedPaneLayoutInput(state);

    expect(persisted.activePaneId).toBe("right");
    expect(persisted.root).toMatchObject({
      children: [{ activeTabId: "codex" }, { activeTabId: "opencode" }],
    });
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(state.activePaneId).toBe("right");
    expect(state.root.children[0].activeTabId).toBe("codex");
  });

  test("writes assigned canonical identities and strips live ports", () => {
    const state = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [
          {
            id: "claude",
            type: "agent-native" as const,
            nativeAgentData: {
              platform: "claude" as const,
              environmentId: "env-1",
              sessionId: "claude-session",
              hostPort: 4101,
              isLocal: true,
            },
          },
          {
            id: "cursor",
            type: "agent-native" as const,
            nativeAgentData: {
              platform: "cursor" as const,
              environmentId: "env-1",
              sessionId: "cursor-session",
              hostPort: 4104,
            },
          },
        ],
        activeTabId: "claude",
      },
    } satisfies EnvironmentPaneState;

    const persisted = createPersistedPaneLayoutInput(state);
    const [claudeTab, cursorTab] = (persisted.root as { tabs: TabInfo[] }).tabs;

    expect(claudeTab?.nativeAgentData).toEqual({
      platform: "claude",
      environmentId: "env-1",
      sessionId: "claude-session",
      isLocal: true,
    });
    expect(cursorTab?.nativeAgentData).toEqual({
      platform: "cursor",
      environmentId: "env-1",
      sessionId: "cursor-session",
    });
    // The renderer-local port is stripped from both projections, not just the
    // provider one.
    expect(JSON.stringify(persisted)).not.toContain("hostPort");
    expect(JSON.stringify(persisted)).not.toContain("4101");
    expect(JSON.stringify(persisted)).not.toContain("4104");
  });

  test("persists the canonical platform lock", () => {
    const state = {
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [
          {
            id: "codex",
            type: "agent-native" as const,
            nativeAgentData: {
              platform: "codex" as const,
              environmentId: "env-1",
              sessionId: "thread-1",
            },
          },
        ],
        activeTabId: "codex",
      },
    } satisfies EnvironmentPaneState;

    const [tab] = (createPersistedPaneLayoutInput(state).root as { tabs: TabInfo[] }).tabs;

    expect(tab?.nativeAgentData).toEqual({
      platform: "codex",
      environmentId: "env-1",
      sessionId: "thread-1",
    });
  });

  test("leaves a non-native tab without a canonical identity", () => {
    const state = {
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [
          {
            id: "tmux",
            type: "claude-tmux" as const,
            claudeTmuxData: { environmentId: "env-1", isLocal: true },
          },
        ],
        activeTabId: "tmux",
      },
    } satisfies EnvironmentPaneState;

    const [tab] = (createPersistedPaneLayoutInput(state).root as { tabs: TabInfo[] }).tabs;

    expect(tab?.nativeAgentData).toBeUndefined();
  });

  test("recursively sanitizes durable browser history without changing current URLs", () => {
    const sensitive = "https://alice:secret@example.com/path?token=secret#private";
    const state = {
      containerId: "container-1",
      activePaneId: "right",
      root: {
        kind: "split" as const,
        id: "split",
        direction: "horizontal" as const,
        sizes: [50, 50] as [number, number],
        depth: 1,
        children: [
          {
            kind: "leaf" as const,
            id: "left",
            tabs: [
              {
                id: "browser-left",
                type: "browser" as const,
                browserData: { url: sensitive, history: [sensitive], historyIndex: 0 },
              },
            ],
            activeTabId: "browser-left",
          },
          {
            kind: "leaf" as const,
            id: "right",
            tabs: [
              {
                id: "browser-right",
                type: "browser" as const,
                browserData: { url: sensitive, history: [sensitive], historyIndex: 0 },
              },
            ],
            activeTabId: "browser-right",
          },
        ],
      },
    } satisfies EnvironmentPaneState;

    const persisted = createPersistedPaneLayoutInput(state);
    expect(persisted.root.kind).toBe("split");
    if (persisted.root.kind !== "split") throw new Error("expected split");
    for (const child of persisted.root.children) {
      expect(child.kind).toBe("leaf");
      if (child.kind !== "leaf") throw new Error("expected leaf");
      expect(child.tabs[0]?.browserData).toEqual({
        url: sensitive,
        history: ["https://example.com/path"],
        historyIndex: 0,
      });
    }
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
        tabs: [...baseState.root.tabs, { id: "remote", type: "plain" as const }],
      },
    });
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 2`);
        }
        return {
          ...layout,
          environmentId,
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 3,
        };
      },
    );
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
    usePaneLayoutStore.getState().addTab("default", { id: "local", type: "plain" }, "env-1");

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    ).toEqual(["base", "remote", "local"]);
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-1")
        .map(({ id }) => id),
    ).toEqual(["base", "remote", "local"]);

    usePaneLayoutStore.getState().addTab("default", { id: "later-local", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2]?.[2]).toBe(3);
    expect(save.mock.calls[2]?.[1].root).toMatchObject({
      tabs: [{ id: "base" }, { id: "remote" }, { id: "local" }, { id: "later-local" }],
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
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 2`);
        }
        return {
          ...layout,
          environmentId,
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 3,
        };
      },
    );
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

    usePaneLayoutStore.getState().addTab("default", { id: "new-local", type: "plain" }, "env-1");
    await waitForTimers();

    expect(save.mock.calls.map((call) => call[2])).toEqual([0, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    ).toEqual(["remote", "setup", "new-local"]);
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-1")
        .map(({ id }) => id),
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
        tabs: [...baseRoot.tabs, { id: "remote", type: "plain" as const }],
      },
    });
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(
            "Error invoking remote method 'orkestrator:invoke': Error: " +
              `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
          );
        }
        return {
          ...createSaved(environmentId, layout),
          revision: 3,
        };
      },
    );
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
    usePaneLayoutStore.getState().addTab("default", { id: "local", type: "plain" }, "env-1");

    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
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
        tabs: [{ id: "old-session", type: "agent-native" as const }],
        activeTabId: "old-session",
      },
    };
    const remoteOldInput = createPersistedPaneLayoutInput({
      ...oldState,
      root: {
        ...oldState.root,
        tabs: [...oldState.root.tabs, { id: "remote-old-session", type: "plain" as const }],
      },
    });
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 2`);
        }
        return {
          ...layout,
          environmentId,
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 3,
        };
      },
    );
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
    expect((retried.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id)).toEqual([
      "new-session",
    ]);
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
    const save = mock(async (environmentId: string, input: LayoutInput) => ({
      ...createSaved(environmentId, input),
      revision: 3,
    }));
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
    usePaneLayoutStore.getState().applyAuthoritativeLayout("env-1", authoritative);
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

    expect(
      adoptPersistedPaneLayout("env-1", {
        containerId: "container-1",
        activePaneId: "default",
        backendRevision: 2,
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "remote", type: "plain" }],
          activeTabId: "remote",
        },
      }),
    ).toBe(false);
    release();
    await waitForTimers();
    stop();
  });

  test("flushes pending writes on pagehide and hidden visibility", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
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

    usePaneLayoutStore.getState().addTab("default", { id: "hidden", type: "plain" }, "env-1");
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
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

  test("pagehide flushes a selection still parked in its debounce", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      createSaved(environmentId, input),
    );
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.addTab("default", { id: "a", type: "plain" }, "env-1");
    store.addTab("default", { id: "b", type: "plain" }, "env-1");
    store.setActiveTab("default", "a", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", usePaneLayoutStore.getState().environments.get("env-1"));
    const stop = startPaneLayoutPersistence({
      save,
      debounceMs: 60_000,
      selectionDebounceMs: 60_000,
    });

    store.setActiveTab("default", "b", "env-1");
    expect(save).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![1].root as PaneLeaf).activeTabId).toBe("b");
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
    await expect(
      flushPaneLayoutNow(
        "env-1",
        input,
        async () => {
          throw new Error("direct offline");
        },
        async () => null,
      ),
    ).rejects.toThrow("direct offline");

    const stop = startPaneLayoutPersistence({
      save: async () => {
        throw new Error("chain offline");
      },
      debounceMs: 60_000,
    });
    await expect(flushPaneLayoutNow("env-1", input)).rejects.toThrow("chain offline");
    stop();
  });

  test("flushPaneLayoutNow accepts an already-durable record without rewriting it", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "tab-1", type: "plain" }],
        activeTabId: "tab-1",
      },
    });
    const save = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout),
    );
    const load = mock(async () => savedResult("env-1", input));

    // Identical content means the caller's durability requirement is already
    // met; a write here would burn a revision for nothing.
    await expect(flushPaneLayoutNow("env-1", input, save, load)).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  test("flushPaneLayoutNow refuses a stored record it cannot even parse", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "tab-1", type: "plain" }],
        activeTabId: "tab-1",
      },
    });
    const save = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout),
    );
    const load = mock(async () => ({
      ...savedResult("env-1", input),
      root: { kind: "leaf" } as never,
    }));

    // A record that fails validation cannot be compared, so it cannot be
    // declared already-durable either.
    await expect(flushPaneLayoutNow("env-1", input, save, load)).rejects.toThrow(
      "authoritative merge base",
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("refuses a chained write for an environment that never hydrated", async () => {
    const save = mock(async (environmentId: string, layout: LayoutInput) =>
      createSaved(environmentId, layout),
    );
    const divergent = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "remote-only", type: "plain" }],
        activeTabId: "remote-only",
      },
    });
    const load = mock(async () => savedResult("env-1", divergent));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 60_000 });

    // Nothing hydrated this environment, so the mirror holds no common base and
    // the stored record disagrees. Blessing it with a freshly read revision
    // would silently drop whatever the other client wrote.
    await expect(
      flushPaneLayoutNow(
        "env-1",
        createPersistedPaneLayoutInput({
          containerId: "container-1",
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "local-only", type: "plain" }],
            activeTabId: "local-only",
          },
        }),
      ),
    ).rejects.toThrow("authoritative merge base");
    expect(save).not.toHaveBeenCalled();
    stop();
  });

  test("establishes a chained CAS base from an identical loaded record", async () => {
    const input = createPersistedPaneLayoutInput({
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "already-there", type: "plain" }],
        activeTabId: "already-there",
      },
    });
    const load = mock(async () => ({
      ...savedResult("env-unhydrated", input),
      revision: 7,
    }));
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => ({
        ...savedResult(environmentId, layout),
        revision: expectedRevision + 1,
      }),
    );
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 60_000 });

    await flushPaneLayoutNow("env-unhydrated", input);

    expect(load).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("env-unhydrated", input, 7);
    stop();
  });

  test("retries against revision zero when the record vanished mid-conflict", async () => {
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 9`);
        }
        return { ...savedResult(environmentId, layout), revision: 1 };
      },
    );
    // Another client deleted the environment's layout between our save and the
    // re-read, so there is nothing to merge with and nothing to overwrite.
    const load = mock(async () => null);
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[2]).toBe(0);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    ).toEqual(["local"]);
    stop();
  });

  test("replaces an unparseable remote record at its own revision", async () => {
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 6`);
        }
        return { ...savedResult(environmentId, layout), revision: 7 };
      },
    );
    const load = mock(async () => ({
      version: 1,
      environmentId: "env-1",
      containerId: "container-1",
      activePaneId: "default",
      // Older or corrupt on-disk shape: a valid CAS token, but nothing a merge
      // can treat as a common base.
      root: { kind: "leaf", tabs: "not-an-array" } as never,
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 6,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[2]).toBe(6);
    expect(
      (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id),
    ).toEqual(["local"]);
    stop();
  });

  test("refuses to overwrite a conflicting layout written by a newer client", async () => {
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 4`);
        }
        return { ...savedResult(environmentId, layout), revision: 5 };
      },
    );
    const load = mock(async () => ({
      version: 99,
      environmentId: "env-1",
      containerId: "container-1",
      activePaneId: "default",
      root: {
        kind: "leaf" as const,
        id: "default",
        tabs: [{ id: "future", type: "plain" as const }],
        activeTabId: "future",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 4,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");
    await waitForTimers();

    expect(save).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(
      "Pane layout changes are not being saved",
      expect.objectContaining({ duration: 10_000 }),
    );
    stop();
  });

  test("empties every pane of a split tree when there is no saved base", async () => {
    const splitState: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "left",
      backendRevision: 0,
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "local-left", type: "plain" }],
            activeTabId: "local-left",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [{ id: "local-right", type: "plain" }],
            activeTabId: "local-right",
          },
        ],
      },
    };
    const remoteInput = createPersistedPaneLayoutInput({
      ...splitState,
      root: {
        ...splitState.root,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "remote-left", type: "plain" }],
            activeTabId: "remote-left",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [],
            activeTabId: null,
          },
        ],
      } as typeof splitState.root,
    });
    const save = mock(
      async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
        if (save.mock.calls.length === 1) {
          throw new Error(`Pane layout revision conflict: expected ${expectedRevision}, current 3`);
        }
        return { ...savedResult(environmentId, layout), revision: 4 };
      },
    );
    const load = mock(async () => ({
      ...savedResult("env-1", remoteInput),
      revision: 3,
    }));
    const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", splitState);
    usePaneLayoutStore.getState().addTab("left", { id: "new-local", type: "plain" }, "env-1");
    await waitForTimers();

    // Revision zero means nothing local was ever saved, so the merge base has
    // to be empty in every pane — otherwise a tab present only on the remote
    // side would read as a local deletion. Nothing is lost here.
    const merged = save.mock.calls[1]![1].root as {
      children: Array<{ tabs: Array<{ id: string }> }>;
    };
    expect(merged.children.flatMap(({ tabs }) => tabs.map(({ id }) => id)).sort()).toEqual(
      ["local-left", "local-right", "new-local", "remote-left"].sort(),
    );
    stop();
  });

  test("declines an adoption that is behind or disagrees with the known revision", () => {
    const stop = startPaneLayoutPersistence({
      save: async (environmentId, input) => createSaved(environmentId, input),
      debounceMs: 60_000,
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1", {
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: 5,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "known", type: "plain" }],
        activeTabId: "known",
      },
    });

    const snapshot = (revision: number, tabId: string): EnvironmentPaneState => ({
      containerId: "container-1",
      activePaneId: "default",
      backendRevision: revision,
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: tabId, type: "plain" }],
        activeTabId: tabId,
      },
    });

    // Strictly older than what the mirror already holds.
    expect(adoptPersistedPaneLayout("env-1", snapshot(4, "stale"))).toBe(false);
    // Same revision, different content: one of the two is wrong, and the mirror
    // is the one that came from a completed save.
    expect(adoptPersistedPaneLayout("env-1", snapshot(5, "different"))).toBe(false);
    // Same revision, same content is simply a redundant echo.
    expect(adoptPersistedPaneLayout("env-1", snapshot(5, "known"))).toBe(true);
    // A newer revision is exactly what adoption is for.
    expect(adoptPersistedPaneLayout("env-1", snapshot(6, "newer"))).toBe(true);
    stop();
  });

  test("does not roll back a local edit that landed while a save was in flight", async () => {
    const inFlight: { release: (() => void) | null } = { release: null };
    const save = mock(async (environmentId: string, layout: LayoutInput) => {
      if (save.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          inFlight.release = resolve;
        });
      }
      return createSaved(environmentId, layout);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "first", type: "plain" }, "env-1");
    await waitForTimers();
    expect(save).toHaveBeenCalledTimes(1);

    usePaneLayoutStore.getState().addTab("default", { id: "second", type: "plain" }, "env-1");
    inFlight.release?.();
    await waitForTimers();

    // The completed save only knew about "first". Installing its result would
    // have wiped "second" out of the UI until the next write came back.
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-1")
        .map(({ id }) => id),
    ).toEqual(["first", "second"]);
    stop();
  });

  test("does not install a save after hydration becomes stale during dependency loading", async () => {
    let releaseHydration!: () => void;
    const hydrationBlocked = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    let hydrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hydrationStarted = resolve;
    });
    const hydrateDependencies = mock(async () => {
      hydrationStarted();
      await hydrationBlocked;
    });
    const save = mock(async (environmentId: string, input: LayoutInput) => ({
      ...createSaved(environmentId, input),
      revision: 8,
    }));
    const stop = startPaneLayoutPersistence({
      save,
      hydrateDependencies,
      debounceMs: 5,
    });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");
    store.addTab("default", { id: "local", type: "plain" }, "env-1");

    await started;
    usePaneLayoutStore.setState((state) => ({
      hydration: new Map(state.hydration).set("env-1", "pending"),
    }));
    releaseHydration();
    await waitForTimers();

    expect(hydrateDependencies).toHaveBeenCalledTimes(1);
    expect(usePaneLayoutStore.getState().environments.get("env-1")?.backendRevision).toBe(0);
    stop();
  });

  test("validates a rebased tab against this client's records before installing it", async () => {
    const buildTab = {
      id: "remote-build",
      type: "claude-build" as const,
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
        isLocal: false,
      },
    };
    const baseRoot: PaneLeaf = {
      kind: "leaf",
      id: "default",
      tabs: [{ id: "base", type: "plain" }],
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
      root: { ...baseRoot, tabs: [...baseRoot.tabs, buildTab] },
    });
    const runRebase = async () => {
      const save = mock(
        async (environmentId: string, layout: LayoutInput, expectedRevision: number) => {
          if (save.mock.calls.length === 1) {
            throw new Error(
              `Pane layout revision conflict: expected ${expectedRevision}, current 2`,
            );
          }
          return { ...savedResult(environmentId, layout), revision: 3 };
        },
      );
      const load = mock(async () => ({
        ...savedResult("env-1", remoteInput),
        revision: 2,
      }));
      const stop = startPaneLayoutPersistence({ save, load, debounceMs: 5 });
      const store = usePaneLayoutStore.getState();
      store.initialize("container-1", "env-1");
      store.beginHydration("env-1");
      store.finishHydration("env-1", baseState);
      usePaneLayoutStore.getState().addTab("default", { id: "local", type: "plain" }, "env-1");
      await waitForTimers();
      const savedTabIds = (save.mock.calls[1]![1].root as { tabs: Array<{ id: string }> }).tabs.map(
        ({ id }) => id,
      );
      const storeTabIds = usePaneLayoutStore
        .getState()
        .getAllTabs("env-1")
        .map(({ id }) => id);
      stop();
      return { savedTabIds, storeTabIds };
    };

    // The build tab is merged into the record either way — the shared layout is
    // not this client's to prune.
    const withoutPipeline = await runRebase();
    expect(withoutPipeline.savedTabIds).toEqual(["base", "remote-build", "local"]);
    // ...but installing it locally would render a build tab with no pipeline
    // behind it, so reconciliation drops it from what this client shows.
    expect(withoutPipeline.storeTabIds).toEqual(["base", "local"]);

    resetStore();
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", { id: "pipeline-1" } as never]]),
      buildEnvironmentIds: new Set(),
    });
    const withPipeline = await runRebase();
    expect(withPipeline.savedTabIds).toEqual(["base", "remote-build", "local"]);
    expect(withPipeline.storeTabIds).toEqual(["base", "remote-build", "local"]);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("announces a settled write chain on success and on failure", async () => {
    const settled: string[] = [];
    const unsubscribe = onPaneLayoutWriteSettled((environmentId) => {
      settled.push(environmentId);
    });
    const save = mock(async (environmentId: string, layout: LayoutInput) => {
      if (save.mock.calls.length === 2) throw new Error("offline");
      return createSaved(environmentId, layout);
    });
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    const store = usePaneLayoutStore.getState();
    store.initialize("container-1", "env-1");
    store.beginHydration("env-1");
    store.finishHydration("env-1");

    store.addTab("default", { id: "ok", type: "plain" }, "env-1");
    await waitForTimers();
    expect(settled).toEqual(["env-1"]);

    usePaneLayoutStore.getState().addTab("default", { id: "fails", type: "plain" }, "env-1");
    await waitForTimers();
    // A failed write must still announce: the whole point of the signal is to
    // let a dropped remote snapshot be re-fetched when the write it deferred
    // to never lands.
    expect(settled).toEqual(["env-1", "env-1"]);

    unsubscribe();
    usePaneLayoutStore.getState().addTab("default", { id: "after", type: "plain" }, "env-1");
    await waitForTimers();
    expect(settled).toEqual(["env-1", "env-1"]);
    stop();
  });

  test("isolates a throwing settled handler from later handlers", async () => {
    const observed: string[] = [];
    const warn = console.warn;
    console.warn = mock(() => undefined);
    const unsubscribeThrowing = onPaneLayoutWriteSettled(() => {
      throw new Error("listener failed");
    });
    const unsubscribeHealthy = onPaneLayoutWriteSettled((environmentId) => {
      observed.push(environmentId);
    });
    try {
      const save = mock(async (environmentId: string, input: LayoutInput) =>
        createSaved(environmentId, input),
      );
      const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
      const store = usePaneLayoutStore.getState();
      store.initialize("container-1", "env-1");
      store.beginHydration("env-1");
      store.finishHydration("env-1");
      store.addTab("default", { id: "write", type: "plain" }, "env-1");
      await waitForTimers();

      expect(observed).toEqual(["env-1"]);
      expect(console.warn).toHaveBeenCalledWith(
        "[PaneLayout] A write-settled handler threw:",
        expect.any(Error),
      );
      stop();
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
      console.warn = warn;
    }
  });

  test("uses the production backend-intent path immediately and installs its authoritative result", async () => {
    const applyIntent = spyOn(backend, "applyPaneLayoutIntent").mockImplementation(
      async (environmentId, _base, desired) => ({
        ...desired,
        environmentId,
        updatedAt: "2026-01-02T00:00:00.000Z",
        revision: 7,
      }),
    );
    localStorage.setItem(
      "orkestrator.pane-selection.v1",
      JSON.stringify({
        version: 1,
        entries: [
          {
            environmentId: "env-1",
            activePaneId: "default",
            activeTabIds: {},
          },
        ],
      }),
    );

    const stop = startPaneLayoutPersistence({
      hydrateDependencies: async () => undefined,
    });
    try {
      const store = usePaneLayoutStore.getState();
      store.initialize("container-1", "env-1");
      store.beginHydration("env-1");
      store.finishHydration("env-1");
      store.addTab("default", { id: "production-write", type: "plain" }, "env-1");

      await waitForTimers();

      expect(applyIntent).toHaveBeenCalledTimes(1);
      const [environmentId, base, desired] = applyIntent.mock.calls[0]!;
      expect(environmentId).toBe("env-1");
      expect(base.root.kind).toBe("leaf");
      expect(desired.root.kind).toBe("leaf");
      expect(JSON.stringify(desired)).toContain("production-write");
      expect(usePaneLayoutStore.getState().environments.get("env-1")?.backendRevision).toBe(7);
      expect(localStorage.getItem("orkestrator.pane-selection.v1")).toBe(
        JSON.stringify({ version: 1, entries: [] }),
      );
    } finally {
      stop();
      applyIntent.mockRestore();
      localStorage.removeItem("orkestrator.pane-selection.v1");
    }
  });

  test("reports a production backend-intent failure and keeps later writes usable", async () => {
    let attempt = 0;
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const applyIntent = spyOn(backend, "applyPaneLayoutIntent").mockImplementation(
      async (environmentId, _base, desired) => {
        attempt += 1;
        if (attempt === 1) throw new Error("intent transport failed");
        return {
          ...desired,
          environmentId,
          updatedAt: "2026-01-02T00:00:00.000Z",
          revision: attempt,
        };
      },
    );
    const stop = startPaneLayoutPersistence({
      hydrateDependencies: async () => undefined,
    });
    try {
      const store = usePaneLayoutStore.getState();
      store.initialize("container-1", "env-1");
      store.beginHydration("env-1");
      store.finishHydration("env-1");
      store.addTab("default", { id: "first", type: "plain" }, "env-1");
      await waitForTimers();
      expect(errorLog).toHaveBeenCalledWith(
        "[PaneLayout] Failed to persist pane layout:",
        expect.objectContaining({ message: "intent transport failed" }),
      );

      usePaneLayoutStore.getState().addTab("default", { id: "second", type: "plain" }, "env-1");
      await waitForTimers();
      expect(applyIntent).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(applyIntent.mock.calls[1]?.[2])).toContain("second");
    } finally {
      stop();
      applyIntent.mockRestore();
      errorLog.mockRestore();
    }
  });
});
