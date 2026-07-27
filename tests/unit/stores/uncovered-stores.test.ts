import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useErrorDialogStore } from "../../../apps/web/src/stores/errorDialogStore";
import { useFileDirtyStore } from "../../../apps/web/src/stores/fileDirtyStore";
import { getEffectiveInterval, usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { useSessionStore } from "../../../apps/web/src/stores/sessionStore";
import {
  createPortalTargetKey,
  createTerminalKey,
  useTerminalPortalStore,
} from "../../../apps/web/src/stores/terminalPortalStore";

afterEach(() => {
  useAgentActivityStore.setState({
    tabStates: {}, containerStates: {}, containerStateUpdatedAt: {}, containerRefCounts: {}, stateChangeCallbacks: new Map(),
  });
  useErrorDialogStore.setState({ error: null });
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  usePrMonitorStore.setState({ monitoredEnvironments: {}, activeEnvironmentId: null });
  useSessionStore.setState({ sessions: new Map(), loadingEnvironments: new Set(), error: null });
  useTerminalPortalStore.setState({ paneHosts: new Map(), terminals: new Map() });
});

describe("agentActivityStore", () => {
  test("tracks tabs, references, containers, and callback lifecycle", async () => {
    const callback = mock(() => undefined);
    const state = useAgentActivityStore.getState();
    const callbackId = state.registerStateCallback(callback);
    state.setTabState("tab-1", "working");
    state.incrementContainerRef("env-1");
    state.incrementContainerRef("env-1");
    state.decrementContainerRef("env-1");
    state.setContainerState("env-1", "waiting");
    await Promise.resolve();

    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");
    expect(useAgentActivityStore.getState().containerRefCounts["env-1"]).toBe(1);
    expect(callback).toHaveBeenCalledWith(
      "env-1",
      "idle",
      "waiting",
      expect.any(String),
    );

    const currentObservation = Date.parse(
      useAgentActivityStore.getState().containerStateUpdatedAt["env-1"],
    );
    const newest = new Date(currentObservation + 2_000).toISOString();
    state.setContainerState("env-1", "working", newest);
    state.setContainerState(
      "env-1",
      "idle",
      new Date(currentObservation + 1_000).toISOString(),
    );
    expect(useAgentActivityStore.getState().getContainerState("env-1"))
      .toBe("working");
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBe(newest);

    useAgentActivityStore.getState().unregisterStateCallback(callbackId);
    useAgentActivityStore.getState().removeTabState("tab-1");
    useAgentActivityStore.getState().removeContainerState("env-1");
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("idle");
    expect(useAgentActivityStore.getState().getContainerState("env-1")).toBe("idle");
  });

  test("records and publishes the first explicit idle observation", async () => {
    const callback = mock(() => undefined);
    useAgentActivityStore.getState().registerStateCallback(callback);

    useAgentActivityStore.getState().setContainerState(
      "env-idle",
      "idle",
      "2026-07-27T12:00:00.000Z",
    );
    await Promise.resolve();

    expect(useAgentActivityStore.getState().containerStates["env-idle"])
      .toBe("idle");
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-idle"])
      .toBe("2026-07-27T12:00:00.000Z");
    expect(callback).toHaveBeenCalledWith(
      "env-idle",
      "idle",
      "idle",
      "2026-07-27T12:00:00.000Z",
    );
  });

  test("orders equal, malformed, and newer same-state observations", async () => {
    const callback = mock(() => undefined);
    useAgentActivityStore.getState().registerStateCallback(callback);
    const originalTime = "2026-07-27T12:00:00.000Z";
    const newerTime = "2026-07-27T12:00:01.000Z";

    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "waiting",
      originalTime,
    );
    await Promise.resolve();
    callback.mockClear();

    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "working",
      originalTime,
    );
    expect(useAgentActivityStore.getState().getContainerState("env-1"))
      .toBe("waiting");

    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "waiting",
      newerTime,
    );
    await Promise.resolve();
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBe(newerTime);
    expect(callback).not.toHaveBeenCalled();

    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "working",
      "not-a-date",
    );
    await Promise.resolve();
    expect(useAgentActivityStore.getState().getContainerState("env-1"))
      .toBe("working");
    expect(Number.isFinite(Date.parse(
      useAgentActivityStore.getState().containerStateUpdatedAt["env-1"],
    ))).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("normalizes poisoned future observations without breaking later updates", () => {
    const maximumDate = "+275760-09-13T00:00:00.000Z";
    const store = useAgentActivityStore.getState();

    expect(() => {
      store.setContainerState("env-future", "working", maximumDate);
      store.setContainerState("env-future", "idle");
    }).not.toThrow();

    const updatedAt = useAgentActivityStore
      .getState()
      .containerStateUpdatedAt["env-future"];
    expect(Number.isFinite(Date.parse(updatedAt))).toBe(true);
    expect(Date.parse(updatedAt)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    useAgentActivityStore.setState((state) => ({
      containerStates: { ...state.containerStates, "env-legacy": "working" },
      containerStateUpdatedAt: {
        ...state.containerStateUpdatedAt,
        "env-legacy": maximumDate,
      },
    }));
    expect(() => {
      store.setContainerState(
        "env-legacy",
        "idle",
        new Date().toISOString(),
      );
    }).not.toThrow();
    expect(useAgentActivityStore.getState().containerStates["env-legacy"])
      .toBe("idle");
  });

  test("isolates callback errors and supports suppression for backend-owned events", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const failingCallback = mock(() => {
      throw new Error("callback failed");
    });
    const healthyCallback = mock(() => undefined);
    useAgentActivityStore.getState().registerStateCallback(failingCallback);
    useAgentActivityStore.getState().registerStateCallback(healthyCallback);

    try {
      useAgentActivityStore.getState().setContainerState(
        "env-1",
        "working",
        "2026-07-27T12:00:00.000Z",
      );
      await Promise.resolve();
      expect(failingCallback).toHaveBeenCalledTimes(1);
      expect(healthyCallback).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[agentActivityStore] Callback error:",
        expect.any(Error),
      );

      failingCallback.mockClear();
      healthyCallback.mockClear();
      useAgentActivityStore.getState().setContainerState(
        "env-1",
        "idle",
        "2026-07-27T12:00:01.000Z",
        false,
      );
      await Promise.resolve();
      expect(useAgentActivityStore.getState().getContainerState("env-1"))
        .toBe("idle");
      expect(failingCallback).not.toHaveBeenCalled();
      expect(healthyCallback).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("replaces optimistic activity with an older authoritative snapshot", async () => {
    const callback = mock(() => undefined);
    useAgentActivityStore.getState().registerStateCallback(callback);
    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "working",
      "2026-07-27T12:00:02.000Z",
    );
    await Promise.resolve();
    callback.mockClear();

    useAgentActivityStore.getState().reconcileContainerState(
      "env-1",
      "idle",
      "2026-07-27T12:00:01.000Z",
    );
    await Promise.resolve();
    expect(useAgentActivityStore.getState().containerStates["env-1"])
      .toBe("idle");
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBe("2026-07-27T12:00:01.000Z");
    expect(callback).not.toHaveBeenCalled();

    useAgentActivityStore.getState().reconcileContainerState(
      "env-1",
      "working",
      "not-a-date",
    );
    expect(useAgentActivityStore.getState().containerStates["env-1"])
      .toBeUndefined();
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBeUndefined();
  });

  test("preserves activity at zero references and removes all keyed state explicitly", () => {
    const store = useAgentActivityStore.getState();
    store.setContainerState(
      "env-1",
      "working",
      "2026-07-27T12:00:00.000Z",
    );
    store.incrementContainerRef("env-1");
    store.decrementContainerRef("env-1");

    expect(useAgentActivityStore.getState().containerRefCounts["env-1"])
      .toBeUndefined();
    expect(useAgentActivityStore.getState().containerStates["env-1"])
      .toBe("working");
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBe("2026-07-27T12:00:00.000Z");

    store.removeContainerState("env-1");
    expect(useAgentActivityStore.getState().containerStates["env-1"])
      .toBeUndefined();
    expect(useAgentActivityStore.getState().containerStateUpdatedAt["env-1"])
      .toBeUndefined();
  });
});

describe("errorDialogStore and fileDirtyStore", () => {
  test("opens and closes error details with the original prompt", () => {
    useErrorDialogStore.getState().showError("Failure", "Details", "retry this");
    expect(useErrorDialogStore.getState().error).toMatchObject({
      title: "Failure", message: "Details", initialPrompt: "retry this",
    });
    expect(useErrorDialogStore.getState().error?.timestamp).toBeInstanceOf(Date);
    useErrorDialogStore.getState().closeError();
    expect(useErrorDialogStore.getState().error).toBeNull();
  });

  test("tracks dirty content through load, edit, save, and close", () => {
    const state = useFileDirtyStore.getState();
    state.setOriginalContent("tab-1", "original");
    expect(state.isDirty("tab-1")).toBe(false);
    state.setContent("tab-1", "changed");
    expect(state.isDirty("tab-1")).toBe(true);
    expect(state.getContent("tab-1")).toBe("changed");
    state.markSaved("tab-1", "changed");
    expect(state.isDirty("tab-1")).toBe(false);
    state.clearDirty("tab-1");
    expect(state.getContent("tab-1")).toBeNull();
  });
});

describe("prMonitorStore", () => {
  test("calculates bounded backoff and updates every monitoring field", () => {
    expect(getEffectiveInterval("idle", 10)).toBe(Infinity);
    expect(getEffectiveInterval("normal", 0)).toBe(20_000);
    expect(getEffectiveInterval("merge-pending", 99)).toBe(32_000);

    const state = usePrMonitorStore.getState();
    state.startMonitoring("env-1", "normal");
    state.setActiveEnvironment("env-1");
    state.setMonitoringMode("env-1", "merge-pending");
    state._setCheckInProgress("env-1", true);
    state._updateLastCheckTime("env-1");
    state._incrementErrors("env-1");
    expect(state.getMonitoringState("env-1")).toMatchObject({
      mode: "merge-pending", checkInProgress: true, consecutiveErrors: 1,
    });
    state._resetErrors("env-1");
    expect(state.getMonitoringState("env-1")?.consecutiveErrors).toBe(0);
    state.stopMonitoring("env-1");
    expect(state.getMonitoringState("env-1")).toBeNull();
  });
});

describe("local session and terminal portal state", () => {
  test("supports all local session selectors and mutations", () => {
    const session = { id: "session-1", environmentId: "env-1", order: 2, name: "Old" } as never;
    const earlier = { id: "session-2", environmentId: "env-1", order: 1 } as never;
    const state = useSessionStore.getState();
    state.addSession(session);
    state.addSession(earlier);
    state.updateSession("session-1", { name: "New" });
    expect(state.getSession("session-1")?.name).toBe("New");
    expect(state.getSessionsByEnvironment("env-1").map((item) => item.id)).toEqual(["session-2", "session-1"]);
    state.setError("failed");
    expect(useSessionStore.getState().error).toBe("failed");
    state.removeSession("session-1");
    state.clearAllSessions();
    expect(useSessionStore.getState().sessions.size).toBe(0);
  });

  test("keys and manages environment-scoped pane hosts", () => {
    expect(createPortalTargetKey("env", "pane")).toBe("env::pane");
    expect(createTerminalKey("env", "tab")).toBe("env::tab");
    const element = document.createElement("div");
    useTerminalPortalStore.getState().registerPaneHost("env", "pane", element);
    expect(useTerminalPortalStore.getState().getPaneHost("env", "pane")).toBe(element);
    useTerminalPortalStore.getState().unregisterPaneHost("env", "pane");
    expect(useTerminalPortalStore.getState().getPaneHost("env", "pane")).toBeUndefined();
  });
});
