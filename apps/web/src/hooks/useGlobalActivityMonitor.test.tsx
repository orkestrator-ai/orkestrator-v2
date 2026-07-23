import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import {
  isEnvironmentCompletionTransition,
  isEnvironmentActivityTransition,
  useGlobalActivityMonitor,
} from "./useGlobalActivityMonitor";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import {
  createOpenCodeSessionKey,
  useOpenCodeStore,
} from "@/stores/openCodeStore";
import type { Environment } from "@/types";

const mockListen = listen as ReturnType<typeof mock>;
const mockInvoke = invoke as ReturnType<typeof mock>;

type EventCallback = (event: { payload: any }) => void;
let eventCallbacks = new Map<string, EventCallback>();
const mockUnlisten = mock(() => {});

function MonitorHarness() {
  useGlobalActivityMonitor();
  return null;
}

function resetStores() {
  useEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  useClaudeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    messageQueue: new Map(),
  });
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    effortLevels: new Map(),
  });
  useCodexStore.setState({
    clients: new Map(),
    sessions: new Map(),
    messageQueue: new Map(),
  });
  useOpenCodeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    messageQueue: new Map(),
  });
  useUIStore.setState({
    selectedEnvironmentId: null,
    unreadEnvironmentIds: [],
  });
}

function resetBackendMocks() {
  eventCallbacks = new Map();
  mockUnlisten.mockClear();
  mockListen.mockClear();
  mockListen.mockImplementation((eventName: string, callback: EventCallback) => {
    eventCallbacks.set(eventName, callback);
    return Promise.resolve(mockUnlisten);
  });
  mockInvoke.mockClear();
  mockInvoke.mockImplementation(() => Promise.resolve());
}

function makeEnvironment(id: string, containerId = `container-${id}`): Environment {
  return {
    id,
    projectId: "project-1",
    name: id,
    branch: id,
    containerId,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-06-16T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
  } as Environment;
}

function addTmuxQuestion(stateKey: string, eventId = "question-1") {
  useClaudeTmuxStore.getState().addPendingQuestion(stateKey, {
    eventId,
    questions: [],
    toolInput: {},
    payload: {},
    receivedAt: "2026-06-16T00:00:00.000Z",
  });
}

afterEach(() => {
  cleanup();
  eventCallbacks = new Map();
  mockListen.mockImplementation(() => Promise.resolve(() => {}));
  mockInvoke.mockImplementation(() => Promise.resolve());
});

describe("useGlobalActivityMonitor tmux activity", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
    resetBackendMocks();
  });

  test("identifies prompt, completion, and waiting transitions as sortable activity", () => {
    expect(isEnvironmentActivityTransition("idle", "working")).toBe(true);
    expect(isEnvironmentActivityTransition("working", "idle")).toBe(true);
    expect(isEnvironmentActivityTransition("working", "waiting")).toBe(true);
    expect(isEnvironmentActivityTransition("idle", "waiting")).toBe(true);
    expect(isEnvironmentActivityTransition("waiting", "idle")).toBe(false);
    expect(isEnvironmentActivityTransition("working", "working")).toBe(false);
    expect(isEnvironmentActivityTransition("waiting", "waiting")).toBe(false);
    expect(isEnvironmentActivityTransition("idle", "idle")).toBe(false);
    expect(isEnvironmentCompletionTransition("working", "idle")).toBe(true);
    expect(isEnvironmentCompletionTransition("working", "waiting")).toBe(true);
    expect(isEnvironmentCompletionTransition("idle", "working")).toBe(false);
    expect(isEnvironmentCompletionTransition("idle", "waiting")).toBe(false);
    expect(isEnvironmentCompletionTransition("waiting", "idle")).toBe(false);
  });

  test("persists meaningful environment activity and updates the live snapshot", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "record_environment_activity"
        ? Promise.resolve({ ...environment, lastActivityAt: args?.occurredAt })
        : Promise.resolve(),
    );
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useEnvironmentStore.getState().getEnvironmentById("env-tmux")?.lastActivityAt)
        .toBeTruthy();
      const activityCall = mockInvoke.mock.calls.find(
        ([command]) => command === "record_environment_activity",
      );
      expect(activityCall?.[1]).toMatchObject({ environmentId: "env-tmux" });
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });
    await waitFor(() => {
      expect(useUIStore.getState().unreadEnvironmentIds).toEqual(["env-tmux"]);
    });
  });

  test("does not mark completed work unread while its environment is open", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
    useUIStore.setState({ selectedEnvironmentId: environment.id });
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "record_environment_activity"
        ? Promise.resolve({ ...environment, lastActivityAt: args?.occurredAt })
        : Promise.resolve(),
    );
    const stateKey = createClaudeTmuxStateKey(environment.id, "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: environment.id,
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
      store.setBusy(stateKey, false);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState(environment.id)).toBe("idle");
    });
    expect(useUIStore.getState().unreadEnvironmentIds).toEqual([]);
  });

  test("records a second tmux tab while the environment remains working", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "record_environment_activity"
        ? Promise.resolve({ ...environment, lastActivityAt: args?.occurredAt })
        : Promise.resolve(),
    );
    const firstTab = createClaudeTmuxStateKey("env-tmux", "tab-1");
    const secondTab = createClaudeTmuxStateKey("env-tmux", "tab-2");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(firstTab, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.setBusy(firstTab, true);
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      )).toHaveLength(1);
    });
    mockInvoke.mockClear();

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(secondTab, true, {
        environmentId: "env-tmux",
        sessionId: "session-2",
      });
      store.setBusy(secondTab, true);
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      )).toHaveLength(1);
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(secondTab, false);
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      )).toHaveLength(2);
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });
  });

  test("rolls back an optimistic activity timestamp when persistence fails", async () => {
    const previousActivityAt = "2026-07-20T10:00:00.000Z";
    const environment = {
      ...makeEnvironment("env-tmux", "container-tmux"),
      lastActivityAt: previousActivityAt,
    };
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((command: string) => {
      if (command === "record_environment_activity") {
        return Promise.reject(new Error("persistence unavailable"));
      }
      if (command === "get_environment_snapshots") {
        return Promise.resolve([environment]);
      }
      return Promise.resolve();
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");

    try {
      render(<MonitorHarness />);
      act(() => {
        const store = useClaudeTmuxStore.getState();
        store.setRunning(stateKey, true, {
          environmentId: "env-tmux",
          sessionId: "session-1",
        });
        store.setBusy(stateKey, true);
      });

      await waitFor(() => {
        expect(useEnvironmentStore.getState().getEnvironmentById("env-tmux")?.lastActivityAt)
          .toBe(previousActivityAt);
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to persist environment activity:",
          expect.any(Error),
        );
        expect(mockInvoke).toHaveBeenCalledWith(
          "get_environment_snapshots",
          { projectId: "project-1" },
        );
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("falls back to the previous timestamp when persistence and refresh both fail", async () => {
    const previousActivityAt = "2026-07-20T10:00:00.000Z";
    const environment = {
      ...makeEnvironment("env-tmux", "container-tmux"),
      lastActivityAt: previousActivityAt,
    };
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((command: string) => {
      if (command === "record_environment_activity") {
        return Promise.reject(new Error("persistence unavailable"));
      }
      if (command === "get_environment_snapshots") {
        return Promise.reject(new Error("snapshot unavailable"));
      }
      return Promise.resolve();
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");

    try {
      render(<MonitorHarness />);
      act(() => {
        const store = useClaudeTmuxStore.getState();
        store.setRunning(stateKey, true, {
          environmentId: "env-tmux",
          sessionId: "session-1",
        });
        store.setBusy(stateKey, true);
      });

      await waitFor(() => {
        expect(useEnvironmentStore.getState().getEnvironmentById("env-tmux")?.lastActivityAt)
          .toBe(previousActivityAt);
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to refresh environment activity:",
          expect.any(Error),
        );
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("maps a busy Claude tmux tab to working activity for the environment", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("idle");
    });
  });

  test("derives activity from existing tmux tab state when the monitor mounts", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-tmux",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);

    render(<MonitorHarness />);

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });
  });

  test("maps pending Claude tmux hook cards to waiting activity", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      addTmuxQuestion(stateKey);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("waiting");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("waiting");
    });
  });

  test("keeps working activity above waiting when another tmux tab is busy", async () => {
    const waitingKey = createClaudeTmuxStateKey("env-tmux", "tab-waiting");
    const busyKey = createClaudeTmuxStateKey("env-tmux", "tab-busy");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(waitingKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-waiting",
      });
      addTmuxQuestion(waitingKey);
      store.setRunning(busyKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-busy",
      });
      store.setBusy(busyKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });
  });

  test("clears tmux activity when a tab is reset", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });

    act(() => {
      useClaudeTmuxStore.getState().resetTab(stateKey);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("idle");
    });
  });

  test("uses a tab environmentId when the tmux key is legacy unscoped", async () => {
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning("legacy-tab", true, {
        environmentId: "env-legacy",
        sessionId: "session-legacy",
      });
      store.setBusy("legacy-tab", true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-legacy"))
        .toBe("working");
    });
  });
});

describe("useGlobalActivityMonitor terminal activity", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
    resetBackendMocks();
  });

  test("starts polling running containers, applies events, and stops on environment removal", async () => {
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    render(<MonitorHarness />);

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(
        "claude-state-container-1",
        expect.any(Function),
      );
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_claude_state_polling",
        { containerId: "container-1" },
      );
    });

    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "waiting",
        },
      });
    });

    expect(useAgentActivityStore.getState().getContainerState("container-1"))
      .toBe("waiting");

    act(() => {
      useEnvironmentStore.setState({ environments: [] });
    });

    await waitFor(() => {
      expect(mockUnlisten).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith(
        "stop_claude_state_polling",
        { containerId: "container-1" },
      );
    });
  });

  test("applies newer backend terminal activity events to the live environment list", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    };
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);

    await waitFor(() => {
      expect(eventCallbacks.has("environment-activity-recorded")).toBe(true);
    });

    act(() => {
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: environment.id,
          occurred_at: "2026-07-23T10:00:00.000Z",
          activity_kind: "completed",
        },
      });
    });
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt)
      .toBe("2026-07-23T10:00:00.000Z");
    expect(useUIStore.getState().unreadEnvironmentIds).toEqual([environment.id]);

    act(() => {
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: environment.id,
          occurred_at: "2026-07-23T08:00:00.000Z",
        },
      });
    });
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt)
      .toBe("2026-07-23T10:00:00.000Z");
  });

  test("ignores malformed backend terminal activity events", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    };
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);

    await waitFor(() => {
      expect(eventCallbacks.has("environment-activity-recorded")).toBe(true);
    });

    act(() => {
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: environment.id,
          occurred_at: "not-a-date",
        },
      });
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: "",
          occurred_at: "2026-07-23T10:00:00.000Z",
        },
      });
    });

    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt)
      .toBe("2026-07-23T09:00:00.000Z");
  });

  test("reports failure to register the backend terminal activity listener", async () => {
    const registrationError = new Error("listener unavailable");
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    mockListen.mockImplementation(
      (
        eventName: string,
        callback: (event: { payload: unknown }) => void,
      ) => {
        if (eventName === "environment-activity-recorded") {
          return Promise.reject(registrationError);
        }
        eventCallbacks.set(eventName, callback);
        return Promise.resolve(mockUnlisten);
      },
    );

    try {
      render(<MonitorHarness />);

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to listen for terminal activity:",
          registrationError,
        );
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("does not let an older persistence response replace newer optimistic activity", async () => {
    const environment = makeEnvironment("env-container", "container-1");
    useEnvironmentStore.setState({ environments: [environment] });
    let resolveFirstActivity: ((value: Environment) => void) | undefined;
    let firstOccurredAt = "";
    let activityCalls = 0;
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command !== "record_environment_activity") return Promise.resolve();
      activityCalls += 1;
      const occurredAt = String(args?.occurredAt);
      if (activityCalls === 1) {
        firstOccurredAt = occurredAt;
        return new Promise<Environment>((resolve) => {
          resolveFirstActivity = resolve;
        });
      }
      return Promise.resolve({ ...environment, lastActivityAt: occurredAt });
    });

    render(<MonitorHarness />);
    await waitFor(() => expect(eventCallbacks.has("claude-state-container-1")).toBe(true));

    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: { container_id: "container-1", state: "working" },
      });
    });
    await waitFor(() => expect(activityCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: { container_id: "container-1", state: "idle" },
      });
    });

    await waitFor(() => expect(activityCalls).toBe(2));
    const newerActivityAt = useEnvironmentStore
      .getState()
      .getEnvironmentById("env-container")?.lastActivityAt;
    expect(newerActivityAt).toBeTruthy();
    expect(Date.parse(newerActivityAt!)).toBeGreaterThan(Date.parse(firstOccurredAt));

    await act(async () => {
      resolveFirstActivity?.({ ...environment, lastActivityAt: firstOccurredAt });
      await Promise.resolve();
    });
    expect(useEnvironmentStore.getState().getEnvironmentById("env-container")?.lastActivityAt)
      .toBe(newerActivityAt);
  });

  test("retries listener registration after the first registration fails", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    mockListen.mockRejectedValueOnce(new Error("listener unavailable"));
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to listen for",
          "claude-state-container-1",
          expect.any(Error),
        );
      });

      act(() => {
        useEnvironmentStore.setState({
          environments: [makeEnvironment("env-container", "container-1")],
        });
      });

      await waitFor(() => {
        expect(mockListen.mock.calls.filter(
          ([eventName]) => eventName === "claude-state-container-1",
        )).toHaveLength(2);
        expect(mockInvoke).toHaveBeenCalledWith(
          "start_claude_state_polling",
          { containerId: "container-1" },
        );
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("logs polling start and stop failures without rejecting the monitor", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    mockInvoke.mockImplementation((command: string) => {
      if (
        command === "start_claude_state_polling" ||
        command === "stop_claude_state_polling"
      ) {
        return Promise.reject(new Error(`${command} unavailable`));
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to start polling for",
          "container-1",
          expect.any(Error),
        );
      });

      act(() => {
        useEnvironmentStore.setState({ environments: [] });
      });

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to stop polling for",
          "container-1",
          expect.any(Error),
        );
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("stops polling and removes listeners when the monitor unmounts", async () => {
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    const view = render(<MonitorHarness />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_claude_state_polling",
        { containerId: "container-1" },
      );
    });

    mockInvoke.mockImplementation((command: string) =>
      command === "stop_claude_state_polling"
        ? Promise.reject(new Error("stop unavailable"))
        : Promise.resolve(),
    );
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(mockUnlisten).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenCalledWith(
      "stop_claude_state_polling",
      { containerId: "container-1" },
    );
  });

  test("disposes a listener that resolves after the monitor unmounts", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    mockListen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    const view = render(<MonitorHarness />);

    await waitFor(() => expect(resolveListen).toBeDefined());
    view.unmount();

    await act(async () => {
      resolveListen?.(mockUnlisten);
      await Promise.resolve();
    });

    expect(mockUnlisten).toHaveBeenCalledTimes(2);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_claude_state_polling",
      { containerId: "container-1" },
    );
  });
});

describe("useGlobalActivityMonitor native agent activity", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
    resetBackendMocks();
  });

  test("derives Claude native working, waiting, and disconnected states", async () => {
    const sessionKey = createClaudeSessionKey("env-claude", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      useClaudeStore.setState({
        clients: new Map([["env-claude", {} as any]]),
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "claude-session",
              messages: [],
              isLoading: true,
            } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("working");
    });

    act(() => {
      useClaudeStore.setState({
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "claude-session",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
        pendingQuestions: new Map([
          ["question-1", { sessionId: "claude-session" } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("waiting");
    });

    act(() => {
      useClaudeStore.setState({
        clients: new Map(),
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "claude-session",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
        pendingQuestions: new Map(),
      });
    });

    expect(useAgentActivityStore.getState().getContainerState("env-claude"))
      .toBe("waiting");
  });

  test("treats a Claude plan approval as waiting for user input", async () => {
    const sessionKey = createClaudeSessionKey("env-claude", "tab-plan");
    render(<MonitorHarness />);

    act(() => {
      useClaudeStore.setState({
        clients: new Map([["env-claude", {} as any]]),
        sessions: new Map([
          [sessionKey, { sessionId: "claude-plan", isLoading: false } as any],
        ]),
        pendingPlanApprovals: new Map([
          ["approval-1", { id: "approval-1", sessionId: "claude-plan" } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("waiting");
    });
  });

  test("keeps each native environment working while any tab is still loading", async () => {
    const claudeWorkingKey = createClaudeSessionKey(
      "env-claude",
      "tab-working",
    );
    const claudeIdleKey = createClaudeSessionKey("env-claude", "tab-idle");
    const openCodeWorkingKey = createOpenCodeSessionKey(
      "env-opencode",
      "tab-working",
    );
    const openCodeIdleKey = createOpenCodeSessionKey(
      "env-opencode",
      "tab-idle",
    );
    const codexWorkingKey = createCodexSessionKey("env-codex", "tab-working");
    const codexIdleKey = createCodexSessionKey("env-codex", "tab-idle");
    render(<MonitorHarness />);

    act(() => {
      useClaudeStore.setState({
        clients: new Map([["env-claude", {} as any]]),
        sessions: new Map([
          [
            claudeWorkingKey,
            { sessionId: "claude-working", isLoading: true } as any,
          ],
          [
            claudeIdleKey,
            { sessionId: "claude-idle", isLoading: false } as any,
          ],
        ]),
      });
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
        sessions: new Map([
          [
            openCodeWorkingKey,
            { sessionId: "opencode-working", isLoading: true } as any,
          ],
          [
            openCodeIdleKey,
            { sessionId: "opencode-idle", isLoading: false } as any,
          ],
        ]),
      });
      useCodexStore.setState({
        clients: new Map([["env-codex", {} as any]]),
        sessions: new Map([
          [
            codexWorkingKey,
            { sessionId: "codex-working", isLoading: true } as any,
          ],
          [
            codexIdleKey,
            { sessionId: "codex-idle", isLoading: false } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });

    act(() => {
      useClaudeStore.setState({
        sessions: new Map([
          [
            claudeWorkingKey,
            { sessionId: "claude-working", isLoading: false } as any,
          ],
          [
            claudeIdleKey,
            { sessionId: "claude-idle", isLoading: false } as any,
          ],
        ]),
      });
      useOpenCodeStore.setState({
        sessions: new Map([
          [
            openCodeWorkingKey,
            { sessionId: "opencode-working", isLoading: false } as any,
          ],
          [
            openCodeIdleKey,
            { sessionId: "opencode-idle", isLoading: false } as any,
          ],
        ]),
      });
      useCodexStore.setState({
        sessions: new Map([
          [
            codexWorkingKey,
            { sessionId: "codex-working", isLoading: false } as any,
          ],
          [
            codexIdleKey,
            { sessionId: "codex-idle", isLoading: false } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("idle");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("idle");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("idle");
    });
  });

  test("records per-session prompt, completion, and waiting activity while another tab remains working", async () => {
    const environments = ["env-claude", "env-opencode", "env-codex"].map((id) => ({
      ...makeEnvironment(id),
      environmentType: "local" as const,
      containerId: null,
    }));
    useEnvironmentStore.getState().setEnvironments(environments);
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command !== "record_environment_activity") return Promise.resolve();
      const environment = environments.find((candidate) => candidate.id === args?.environmentId)!;
      return Promise.resolve({ ...environment, lastActivityAt: args?.occurredAt });
    });

    const claudeA = createClaudeSessionKey("env-claude", "tab-a");
    const claudeB = createClaudeSessionKey("env-claude", "tab-b");
    const openCodeA = createOpenCodeSessionKey("env-opencode", "tab-a");
    const openCodeB = createOpenCodeSessionKey("env-opencode", "tab-b");
    const codexA = createCodexSessionKey("env-codex", "tab-a");
    const codexB = createCodexSessionKey("env-codex", "tab-b");
    useClaudeStore.setState({
      clients: new Map([["env-claude", {} as any]]),
      sessions: new Map([[claudeA, { sessionId: "claude-a", isLoading: true } as any]]),
    });
    useOpenCodeStore.setState({
      clients: new Map([["env-opencode", {} as any]]),
      sessions: new Map([[openCodeA, { sessionId: "opencode-a", isLoading: true } as any]]),
    });
    useCodexStore.setState({
      clients: new Map([["env-codex", {} as any]]),
      sessions: new Map([[codexA, { sessionId: "codex-a", isLoading: true } as any]]),
    });
    render(<MonitorHarness />);
    mockInvoke.mockClear();

    act(() => {
      useClaudeStore.setState({
        sessions: new Map([
          [claudeA, { sessionId: "claude-a", isLoading: true } as any],
          [claudeB, { sessionId: "claude-b", isLoading: true } as any],
        ]),
      });
      useOpenCodeStore.setState({
        sessions: new Map([
          [openCodeA, { sessionId: "opencode-a", isLoading: true } as any],
          [openCodeB, { sessionId: "opencode-b", isLoading: true } as any],
        ]),
      });
      useCodexStore.setState({
        sessions: new Map([
          [codexA, { sessionId: "codex-a", isLoading: true } as any],
          [codexB, { sessionId: "codex-b", isLoading: true } as any],
        ]),
      });
    });

    await waitFor(() => {
      const activityCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      );
      expect(activityCalls).toHaveLength(3);
    });

    act(() => {
      useClaudeStore.setState({
        sessions: new Map([
          [claudeA, { sessionId: "claude-a", isLoading: true, messages: [{ id: "1" }] } as any],
          [claudeB, { sessionId: "claude-b", isLoading: true, messages: [{ id: "2" }] } as any],
        ]),
      });
      useOpenCodeStore.setState({
        sessions: new Map([
          [openCodeA, { sessionId: "opencode-a", isLoading: true, messages: [{ id: "1" }] } as any],
          [openCodeB, { sessionId: "opencode-b", isLoading: true, messages: [{ id: "2" }] } as any],
        ]),
      });
      useCodexStore.setState({
        sessions: new Map([
          [codexA, { sessionId: "codex-a", isLoading: true, messages: [{ id: "1" }] } as any],
          [codexB, { sessionId: "codex-b", isLoading: true, messages: [{ id: "2" }] } as any],
        ]),
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke.mock.calls.filter(
      ([command]) => command === "record_environment_activity",
    )).toHaveLength(3);

    act(() => {
      useClaudeStore.setState({
        sessions: new Map([
          [claudeA, { sessionId: "claude-a", isLoading: true } as any],
          [claudeB, { sessionId: "claude-b", isLoading: false } as any],
        ]),
        pendingQuestions: new Map([
          ["question-b", { sessionId: "claude-b" } as any],
        ]),
      });
      useOpenCodeStore.setState({
        sessions: new Map([
          [openCodeA, { sessionId: "opencode-a", isLoading: true } as any],
          [openCodeB, { sessionId: "opencode-b", isLoading: false } as any],
        ]),
      });
      useCodexStore.setState({
        sessions: new Map([
          [codexA, { sessionId: "codex-a", isLoading: true } as any],
          [codexB, { sessionId: "codex-b", isLoading: false } as any],
        ]),
      });
    });

    await waitFor(() => {
      const activityCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      );
      expect(activityCalls).toHaveLength(6);
      for (const environmentId of ["env-claude", "env-opencode", "env-codex"]) {
        expect(activityCalls.filter(([, args]) => args?.environmentId === environmentId))
          .toHaveLength(2);
        expect(useAgentActivityStore.getState().getContainerState(environmentId))
          .toBe("working");
      }
      expect(new Set(useUIStore.getState().unreadEnvironmentIds)).toEqual(
        new Set(["env-claude", "env-opencode", "env-codex"]),
      );
    });
  });

  test("does not let an idle agent type overwrite another working agent type", async () => {
    const claudeKey = createClaudeSessionKey("env-shared", "tab-claude");
    const codexKey = createCodexSessionKey("env-shared", "tab-codex");
    render(<MonitorHarness />);

    act(() => {
      useCodexStore.setState({
        clients: new Map([["env-shared", {} as any]]),
        sessions: new Map([
          [codexKey, { sessionId: "codex-working", isLoading: true } as any],
        ]),
      });
      useClaudeStore.setState({
        clients: new Map([["env-shared", {} as any]]),
        sessions: new Map([
          [claudeKey, { sessionId: "claude-idle", isLoading: false } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-shared"))
        .toBe("working");
    });
  });

  test("rehydrates existing native session activity when the monitor mounts", async () => {
    const claudeKey = createClaudeSessionKey("env-claude", "tab-1");
    const openCodeKey = createOpenCodeSessionKey("env-opencode", "tab-1");
    const codexKey = createCodexSessionKey("env-codex", "tab-1");
    useClaudeStore.setState({
      clients: new Map([["env-claude", {} as any]]),
      sessions: new Map([
        [claudeKey, { sessionId: "claude-session", isLoading: true } as any],
      ]),
    });
    useOpenCodeStore.setState({
      clients: new Map([["env-opencode", {} as any]]),
      sessions: new Map([
        [openCodeKey, { sessionId: "opencode-session", isLoading: false } as any],
      ]),
      pendingQuestions: new Map([
        ["question-1", { sessionID: "opencode-session" } as any],
      ]),
    });
    useCodexStore.setState({
      clients: new Map([["env-codex", {} as any]]),
      sessions: new Map([
        [codexKey, { sessionId: "codex-session", isLoading: true } as any],
      ]),
    });

    render(<MonitorHarness />);

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("waiting");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });
  });

  test("derives native activity when clients reconnect without a session update", async () => {
    const claudeKey = createClaudeSessionKey("env-claude", "tab-1");
    const openCodeKey = createOpenCodeSessionKey("env-opencode", "tab-1");
    const codexKey = createCodexSessionKey("env-codex", "tab-1");
    useClaudeStore.setState({
      sessions: new Map([
        [claudeKey, { sessionId: "claude-session", isLoading: true } as any],
      ]),
    });
    useOpenCodeStore.setState({
      sessions: new Map([
        [openCodeKey, { sessionId: "opencode-session", isLoading: true } as any],
      ]),
    });
    useCodexStore.setState({
      sessions: new Map([
        [codexKey, { sessionId: "codex-session", isLoading: true } as any],
      ]),
    });
    render(<MonitorHarness />);

    act(() => {
      useClaudeStore.setState({
        clients: new Map([["env-claude", {} as any]]),
      });
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
      });
      useCodexStore.setState({
        clients: new Map([["env-codex", {} as any]]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });
  });

  test("clears native source activity when disconnected sessions are removed", async () => {
    const claudeKey = createClaudeSessionKey("env-claude", "tab-1");
    const openCodeKey = createOpenCodeSessionKey("env-opencode", "tab-1");
    const codexKey = createCodexSessionKey("env-codex", "tab-1");
    useClaudeStore.setState({
      clients: new Map([["env-claude", {} as any]]),
      sessions: new Map([
        [claudeKey, { sessionId: "claude-session", isLoading: true } as any],
      ]),
    });
    useOpenCodeStore.setState({
      clients: new Map([["env-opencode", {} as any]]),
      sessions: new Map([
        [openCodeKey, { sessionId: "opencode-session", isLoading: true } as any],
      ]),
    });
    useCodexStore.setState({
      clients: new Map([["env-codex", {} as any]]),
      sessions: new Map([
        [codexKey, { sessionId: "codex-session", isLoading: true } as any],
      ]),
    });
    render(<MonitorHarness />);

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("working");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });

    act(() => {
      useClaudeStore.setState({ clients: new Map(), sessions: new Map() });
      useOpenCodeStore.setState({ clients: new Map(), sessions: new Map() });
      useCodexStore.setState({ clients: new Map(), sessions: new Map() });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-claude"))
        .toBe("idle");
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("idle");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("idle");
    });
  });

  test("keeps working above waiting across native agent types and restores waiting afterward", async () => {
    const openCodeKey = createOpenCodeSessionKey("env-shared", "tab-opencode");
    const codexKey = createCodexSessionKey("env-shared", "tab-codex");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-shared", {} as any]]),
        sessions: new Map([
          [openCodeKey, { sessionId: "opencode-session", isLoading: false } as any],
        ]),
        pendingPermissions: new Map([
          ["permission-1", { sessionID: "opencode-session" } as any],
        ]),
      });
      useCodexStore.setState({
        clients: new Map([["env-shared", {} as any]]),
        sessions: new Map([
          [codexKey, { sessionId: "codex-session", isLoading: true } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-shared"))
        .toBe("working");
    });

    act(() => {
      useCodexStore.setState({
        sessions: new Map([
          [codexKey, { sessionId: "codex-session", isLoading: false } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-shared"))
        .toBe("waiting");
    });
  });

  test("ignores store updates that do not affect activity", async () => {
    const claudeKey = createClaudeSessionKey("env-shared", "tab-claude");
    const tmuxKey = createClaudeTmuxStateKey("env-shared", "tab-tmux");
    const openCodeKey = createOpenCodeSessionKey("env-shared", "tab-opencode");
    const codexKey = createCodexSessionKey("env-shared", "tab-codex");
    useClaudeStore.setState({
      clients: new Map([["env-shared", {} as any]]),
      sessions: new Map([
        [claudeKey, { sessionId: "claude-session", isLoading: true } as any],
      ]),
    });
    useOpenCodeStore.setState({
      clients: new Map([["env-shared", {} as any]]),
      sessions: new Map([
        [openCodeKey, { sessionId: "opencode-session", isLoading: false } as any],
      ]),
    });
    useCodexStore.setState({
      clients: new Map([["env-shared", {} as any]]),
      sessions: new Map([
        [codexKey, { sessionId: "codex-session", isLoading: false } as any],
      ]),
    });
    const tmuxStore = useClaudeTmuxStore.getState();
    tmuxStore.setRunning(tmuxKey, true, {
      environmentId: "env-shared",
      sessionId: "tmux-session",
    });
    render(<MonitorHarness />);

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-shared"))
        .toBe("working");
    });

    act(() => {
      useClaudeStore.setState({ messageQueue: new Map() });
      useClaudeTmuxStore.setState({ draftText: new Map() });
      useOpenCodeStore.setState({ messageQueue: new Map() });
      useCodexStore.setState({ messageQueue: new Map() });
    });

    expect(useAgentActivityStore.getState().getContainerState("env-shared"))
      .toBe("working");
  });

  test("derives OpenCode waiting from pending permissions and Codex working from loading", async () => {
    const openCodeSessionKey = createOpenCodeSessionKey("env-opencode", "tab-1");
    const codexSessionKey = createCodexSessionKey("env-codex", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
        sessions: new Map([
          [
            openCodeSessionKey,
            {
              sessionId: "opencode-session",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
        pendingPermissions: new Map([
          ["permission-1", { sessionID: "opencode-session" } as any],
        ]),
      });
      useCodexStore.setState({
        clients: new Map([["env-codex", {} as any]]),
        sessions: new Map([
          [
            codexSessionKey,
            {
              sessionId: "codex-session",
              messages: [],
              isLoading: true,
            } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("waiting");
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });

    act(() => {
      useCodexStore.setState({
        sessions: new Map([
          [
            codexSessionKey,
            {
              sessionId: "codex-session",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("idle");
    });
  });
});
