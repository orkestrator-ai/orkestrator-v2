import { afterEach, describe, expect, test } from "bun:test";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useErrorDialogStore } from "../../../apps/web/src/stores/errorDialogStore";
import { useFileDirtyStore } from "../../../apps/web/src/stores/fileDirtyStore";
import { usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { useSessionStore } from "../../../apps/web/src/stores/sessionStore";
import {
  createPortalTargetKey,
  createTerminalKey,
  useTerminalPortalStore,
} from "../../../apps/web/src/stores/terminalPortalStore";

afterEach(() => {
  useAgentActivityStore.setState({
    tabStates: {}, containerStates: {}, containerStateUpdatedAt: {}, containerRefCounts: {},
  });
  useErrorDialogStore.setState({ error: null });
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  usePrMonitorStore.setState({ states: new Map() });
  useSessionStore.setState({ sessions: new Map(), loadingEnvironments: new Set(), error: null });
  useTerminalPortalStore.setState({ paneHosts: new Map(), terminals: new Map() });
});

describe("agentActivityStore", () => {
  test("tracks per-tab presentation state and mounted container references", () => {
    const store = useAgentActivityStore.getState();

    expect(store.getTabState("missing")).toBe("idle");
    expect(store.getContainerState("missing")).toBe("idle");

    store.setTabState("tab-1", "working");
    store.incrementContainerRef("env-1");
    store.incrementContainerRef("env-1");
    store.decrementContainerRef("env-1");

    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");
    expect(useAgentActivityStore.getState().containerRefCounts["env-1"]).toBe(1);

    store.removeTabState("tab-1");
    store.decrementContainerRef("env-1");
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("idle");
    expect(useAgentActivityStore.getState().containerRefCounts["env-1"]).toBeUndefined();
  });

  test("replaces the projection from complete backend-owned snapshots", () => {
    const store = useAgentActivityStore.getState();
    store.replaceActivitySnapshot([
      {
        id: "env-1",
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
      },
      {
        id: "env-incomplete",
        agentActivityState: "waiting",
        agentActivityUpdatedAt: undefined,
      },
    ]);

    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-1": "working",
    });
    expect(useAgentActivityStore.getState().containerStateUpdatedAt).toEqual({
      "env-1": "2026-07-27T12:00:00.000Z",
    });

    store.replaceActivitySnapshot([{
      id: "env-2",
      agentActivityState: "idle",
      agentActivityUpdatedAt: "2026-07-27T12:00:01.000Z",
    }]);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-2": "idle",
    });
    expect(useAgentActivityStore.getState().getContainerState("env-1")).toBe("idle");
  });

  test("removes projected state without disturbing other environments", () => {
    const store = useAgentActivityStore.getState();
    store.replaceActivitySnapshot([
      {
        id: "env-1",
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
      },
      {
        id: "env-2",
        agentActivityState: "waiting",
        agentActivityUpdatedAt: "2026-07-27T12:00:01.000Z",
      },
    ]);

    store.removeContainerState("env-1");

    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-2": "waiting",
    });
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
  const monitorEntry = (environmentId: string, overrides: Record<string, unknown> = {}) => ({
    environmentId,
    mode: "normal" as const,
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: null,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    ...overrides,
  });

  test("mirrors backend snapshots and incremental events", () => {
    const state = usePrMonitorStore.getState();

    state.applySnapshot([
      monitorEntry("env-1", { mode: "merge-pending", consecutiveErrors: 1 }),
      monitorEntry("env-2"),
    ]);
    expect(usePrMonitorStore.getState().getMonitoringState("env-1")).toMatchObject({
      mode: "merge-pending", checkInProgress: false, consecutiveErrors: 1,
    });

    state.applyEvent({
      environmentId: "env-1",
      state: monitorEntry("env-1", { prState: "merged", prUrl: "https://github.com/org/repo/pull/1" }),
    });
    expect(usePrMonitorStore.getState().getMonitoringState("env-1")?.prState).toBe("merged");

    state.applyEvent({ environmentId: "env-1", removed: true });
    expect(usePrMonitorStore.getState().getMonitoringState("env-1")).toBeNull();

    // The snapshot is the complete truth: an entry absent from it is dropped.
    state.applySnapshot([]);
    expect(usePrMonitorStore.getState().getMonitoringState("env-2")).toBeNull();
  });

  test("skips updates when the payload matches what is already held", () => {
    const state = usePrMonitorStore.getState();
    state.applySnapshot([monitorEntry("env-1")]);
    const before = usePrMonitorStore.getState().states;

    state.applySnapshot([monitorEntry("env-1")]);
    expect(usePrMonitorStore.getState().states).toBe(before);

    state.applyEvent({ environmentId: "env-1", state: monitorEntry("env-1") });
    expect(usePrMonitorStore.getState().states).toBe(before);

    state.applyEvent({ environmentId: "env-9", removed: true });
    expect(usePrMonitorStore.getState().states).toBe(before);
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
