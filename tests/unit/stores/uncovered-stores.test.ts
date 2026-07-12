import { afterEach, describe, expect, mock, test } from "bun:test";
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
    tabStates: {}, containerStates: {}, containerRefCounts: {}, stateChangeCallbacks: new Map(),
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
    expect(callback).toHaveBeenCalledWith("env-1", "idle", "waiting");

    useAgentActivityStore.getState().unregisterStateCallback(callbackId);
    useAgentActivityStore.getState().removeTabState("tab-1");
    useAgentActivityStore.getState().removeContainerState("env-1");
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("idle");
    expect(useAgentActivityStore.getState().getContainerState("env-1")).toBe("idle");
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
