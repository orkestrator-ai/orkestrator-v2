import { createSessionKey } from "@/lib/utils";
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
import {useClaudeStore} from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import {useCodexStore} from "@/stores/codexStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import {useOpenCodeStore} from "@/stores/openCodeStore";
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
    containerStateUpdatedAt: {},
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
  useUIStore.setState({ selectedEnvironmentId: null });
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
  mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (
      command === "record_environment_activity" ||
      command === "record_environment_completion"
    ) {
      const environment = useEnvironmentStore
        .getState()
        .getEnvironmentById(String(args?.environmentId));
      return Promise.resolve({
        ...environment,
        lastActivityAt: args?.occurredAt,
        ...(command === "record_environment_completion"
          ? { hasUnreadWork: true }
          : {}),
      });
    }
    if (command === "set_environment_agent_activity") {
      const environment = useEnvironmentStore
        .getState()
        .getEnvironmentById(String(args?.environmentId));
      return Promise.resolve({
        ...environment,
        agentActivityState: args?.state,
        agentActivityUpdatedAt: args?.occurredAt,
      });
    }
    if (command === "get_environment_snapshots") {
      return Promise.resolve(useEnvironmentStore.getState().environments);
    }
    return Promise.resolve();
  });
}

/**
 * Environments carry their own unread flag now, so the badge is read back from
 * the environment store rather than from a per-window list.
 */
function unreadEnvironmentIds(): string[] {
  return useEnvironmentStore.getState().environments
    .filter((environment) => environment.hasUnreadWork)
    .map((environment) => environment.id);
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
      command === "record_environment_activity" ||
      command === "record_environment_completion"
        ? Promise.resolve({
            ...environment,
            lastActivityAt: args?.occurredAt,
            hasUnreadWork: command === "record_environment_completion",
          })
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
      expect(mockInvoke).toHaveBeenCalledWith(
        "set_environment_agent_activity",
        expect.objectContaining({
          environmentId: "env-tmux",
          state: "working",
          occurredAt: expect.any(String),
        }),
      );
      expect(useEnvironmentStore.getState().getEnvironmentById("env-tmux"))
        .toMatchObject({ agentActivityState: "working" });
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });
    await waitFor(() => {
      expect(unreadEnvironmentIds()).toEqual(["env-tmux"]);
      expect(mockInvoke).toHaveBeenCalledWith(
        "record_environment_completion",
        expect.objectContaining({ environmentId: "env-tmux" }),
      );
      expect(mockInvoke).toHaveBeenCalledWith(
        "set_environment_agent_activity",
        expect.objectContaining({
          environmentId: "env-tmux",
          state: "idle",
        }),
      );
    });
  });

  test("persists the first explicit idle observation during native hydration", async () => {
    const environment = {
      ...makeEnvironment("env-native", ""),
      environmentType: "local" as const,
      containerId: null,
      agentActivityState: "working" as const,
      agentActivityUpdatedAt: "2026-07-27T11:00:00.000Z",
    };
    const sessionKey = createSessionKey(environment.id, "tab-1");
    useEnvironmentStore.setState({ environments: [environment] });
    useClaudeStore.setState({
      clients: new Map([[environment.id, {} as any]]),
      sessions: new Map([[
        sessionKey,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
        } as any,
      ]]),
    });

    render(<MonitorHarness />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "set_environment_agent_activity",
        expect.objectContaining({
          environmentId: environment.id,
          state: "idle",
        }),
      );
      expect(useAgentActivityStore.getState().containerStates[environment.id])
        .toBe("idle");
      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
        .toMatchObject({ agentActivityState: "idle" });
    });
  });

  test("repairs a poisoned persisted token with a current frontend observation", async () => {
    const maximumDate = "+275760-09-13T00:00:00.000Z";
    const environment = {
      ...makeEnvironment("env-native", ""),
      environmentType: "local" as const,
      containerId: null,
      agentActivityState: "working" as const,
      agentActivityUpdatedAt: maximumDate,
    };
    const sessionKey = createSessionKey(environment.id, "tab-1");
    useEnvironmentStore.setState({ environments: [environment] });
    useClaudeStore.setState({
      clients: new Map([[environment.id, {} as any]]),
      sessions: new Map([[
        sessionKey,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
        } as any,
      ]]),
    });

    render(<MonitorHarness />);

    await waitFor(() => {
      const activityCall = mockInvoke.mock.calls.find(
        ([command]) => command === "set_environment_agent_activity",
      );
      expect(activityCall).toBeDefined();
      const occurredAt = (
        activityCall?.[1] as { occurredAt?: string } | undefined
      )?.occurredAt;
      expect(occurredAt).toEqual(expect.any(String));
      expect(Date.parse(occurredAt!)).toBeLessThan(Date.parse(maximumDate));
      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
        .toMatchObject({ agentActivityState: "idle" });
    });
  });

  test("bumps a frontend observation past the persisted activity token", async () => {
    const persistedAt = "2026-07-27T12:00:00.000Z";
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      agentActivityState: "idle" as const,
      agentActivityUpdatedAt: persistedAt,
    };
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);

    act(() => {
      useAgentActivityStore.getState().setContainerState(
        environment.id,
        "working",
        "2026-07-27T11:00:00.000Z",
      );
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "set_environment_agent_activity",
        {
          environmentId: environment.id,
          state: "working",
          occurredAt: "2026-07-27T12:00:00.001Z",
        },
      );
    });
  });

  test("reconciles an optimistic agent state with the authoritative response", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
    };
    const authoritativeAt = "2026-07-27T12:00:02.000Z";
    useEnvironmentStore.setState({ environments: [environment] });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "set_environment_agent_activity") {
        return Promise.resolve({
          ...environment,
          agentActivityState: "waiting",
          agentActivityUpdatedAt: authoritativeAt,
        });
      }
      return Promise.resolve();
    });
    render(<MonitorHarness />);

    act(() => {
      useAgentActivityStore.getState().setContainerState(
        environment.id,
        "working",
        "2026-07-27T12:00:01.000Z",
      );
    });

    await waitFor(() => {
      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
        .toMatchObject({
          agentActivityState: "waiting",
          agentActivityUpdatedAt: authoritativeAt,
        });
      expect(useAgentActivityStore.getState().containerStates[environment.id])
        .toBe("waiting");
      expect(useAgentActivityStore.getState().containerStateUpdatedAt[environment.id])
        .toBe(authoritativeAt);
    });
  });

  test("reasserts completed native activity after a newer working response wins", async () => {
    const environment = {
      ...makeEnvironment("env-native", ""),
      environmentType: "local" as const,
      containerId: null,
    };
    const sessionKey = createSessionKey(environment.id, "tab-1");
    let activityWrites = 0;
    useEnvironmentStore.setState({ environments: [environment] });
    useClaudeStore.setState({
      clients: new Map([[environment.id, {} as any]]),
      sessions: new Map([[
        sessionKey,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: true,
        } as any,
      ]]),
    });
    mockInvoke.mockImplementation((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (
        command === "record_environment_activity"
        || command === "record_environment_completion"
      ) {
        return Promise.resolve({
          ...environment,
          lastActivityAt: args?.occurredAt,
          ...(command === "record_environment_completion"
            ? { hasUnreadWork: true }
            : {}),
        });
      }
      if (command === "get_environment_snapshots") {
        return Promise.resolve(
          useEnvironmentStore.getState().environments,
        );
      }
      if (command !== "set_environment_agent_activity") {
        return Promise.resolve(undefined);
      }
      activityWrites += 1;
      if (activityWrites === 2) {
        // Simulate another renderer winning the ordering race after this
        // renderer observed the final idle transition.
        return Promise.resolve({
          ...environment,
          agentActivityState: "working",
          agentActivityUpdatedAt: new Date(
            Date.parse(String(args?.occurredAt)) + 1,
          ).toISOString(),
        });
      }
      return Promise.resolve({
        ...environment,
        agentActivityState: args?.state,
        agentActivityUpdatedAt: args?.occurredAt,
      });
    });

    render(<MonitorHarness />);
    await waitFor(() => expect(activityWrites).toBe(1));

    act(() => {
      useClaudeStore.getState().setSessionLoading(sessionKey, false);
    });

    await waitFor(() => {
      expect(activityWrites).toBe(3);
      expect(useAgentActivityStore.getState().getContainerState(environment.id))
        .toBe("idle");
      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
        .toMatchObject({ agentActivityState: "idle" });
    });
  });

  test("refreshes the authoritative agent state after persistence fails", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      agentActivityState: "working" as const,
      agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
    };
    const persistedEnvironment = {
      ...environment,
      agentActivityState: "idle" as const,
      agentActivityUpdatedAt: "2026-07-27T12:00:00.500Z",
    };
    useEnvironmentStore.setState({ environments: [environment] });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "set_environment_agent_activity") {
        return Promise.reject(new Error("write unavailable"));
      }
      if (command === "get_environment_snapshots") {
        return Promise.resolve([persistedEnvironment]);
      }
      return Promise.resolve();
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      render(<MonitorHarness />);
      act(() => {
        useAgentActivityStore.getState().setContainerState(
          environment.id,
          "waiting",
          "2026-07-27T12:00:01.000Z",
        );
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "get_environment_snapshots",
          { projectId: environment.projectId },
        );
        expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
          .toMatchObject({
            agentActivityState: "idle",
            agentActivityUpdatedAt: "2026-07-27T12:00:00.500Z",
          });
        expect(useAgentActivityStore.getState().containerStates[environment.id])
          .toBe("idle");
        expect(useAgentActivityStore.getState().containerStateUpdatedAt[environment.id])
          .toBe("2026-07-27T12:00:00.500Z");
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("does not let an older failed write roll back a newer agent observation", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
    };
    let rejectFirst: ((reason: Error) => void) | undefined;
    let activityWrites = 0;
    useEnvironmentStore.setState({ environments: [environment] });
    mockInvoke.mockImplementation((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "set_environment_agent_activity") {
        activityWrites += 1;
        if (activityWrites === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve({
          ...environment,
          agentActivityState: args?.state,
          agentActivityUpdatedAt: args?.occurredAt,
        });
      }
      if (command === "get_environment_snapshots") {
        throw new Error("stale write must not refresh");
      }
      return Promise.resolve();
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      render(<MonitorHarness />);
      act(() => {
        useAgentActivityStore.getState().setContainerState(
          environment.id,
          "working",
          "2026-07-27T12:00:01.000Z",
        );
      });
      await waitFor(() => expect(activityWrites).toBe(1));
      act(() => {
        useAgentActivityStore.getState().setContainerState(
          environment.id,
          "waiting",
          "2026-07-27T12:00:02.000Z",
        );
      });
      await waitFor(() => expect(activityWrites).toBe(2));

      await act(async () => {
        rejectFirst?.(new Error("older write failed"));
        await Promise.resolve();
      });

      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
        .toMatchObject({
          agentActivityState: "waiting",
          agentActivityUpdatedAt: "2026-07-27T12:00:02.000Z",
        });
      expect(mockInvoke.mock.calls.some(
        ([command]) => command === "get_environment_snapshots",
      )).toBe(false);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("does not let an older successful response replace a newer agent observation", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
    };
    let resolveFirst: ((value: Environment) => void) | undefined;
    let activityWrites = 0;
    useEnvironmentStore.setState({ environments: [environment] });
    mockInvoke.mockImplementation((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command !== "set_environment_agent_activity") {
        return Promise.resolve();
      }
      activityWrites += 1;
      if (activityWrites === 1) {
        return new Promise<Environment>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        ...environment,
        agentActivityState: args?.state,
        agentActivityUpdatedAt: args?.occurredAt,
      });
    });
    render(<MonitorHarness />);

    act(() => {
      useAgentActivityStore.getState().setContainerState(
        environment.id,
        "working",
        "2026-07-27T12:00:01.000Z",
      );
    });
    await waitFor(() => expect(activityWrites).toBe(1));
    act(() => {
      useAgentActivityStore.getState().setContainerState(
        environment.id,
        "waiting",
        "2026-07-27T12:00:02.000Z",
      );
    });
    await waitFor(() => expect(activityWrites).toBe(2));

    await act(async () => {
      resolveFirst?.({
        ...environment,
        agentActivityState: "idle",
        agentActivityUpdatedAt: "2026-07-27T12:00:01.000Z",
      });
      await Promise.resolve();
    });

    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
      .toMatchObject({
        agentActivityState: "waiting",
        agentActivityUpdatedAt: "2026-07-27T12:00:02.000Z",
      });
  });

  test("restores the previous agent snapshot when write and refresh both fail", async () => {
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      agentActivityState: "working" as const,
      agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
    };
    useEnvironmentStore.setState({ environments: [environment] });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "set_environment_agent_activity") {
        return Promise.reject(new Error("write unavailable"));
      }
      if (command === "get_environment_snapshots") {
        return Promise.reject(new Error("snapshot unavailable"));
      }
      return Promise.resolve();
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      render(<MonitorHarness />);
      act(() => {
        useAgentActivityStore.getState().setContainerState(
          environment.id,
          "waiting",
          "2026-07-27T12:00:01.000Z",
        );
      });

      await waitFor(() => {
        expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
          .toMatchObject({
            agentActivityState: "working",
            agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
          });
        expect(useAgentActivityStore.getState().containerStates[environment.id])
          .toBe("working");
        expect(useAgentActivityStore.getState().containerStateUpdatedAt[environment.id])
          .toBe("2026-07-27T12:00:00.000Z");
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to refresh agent activity:",
          expect.any(Error),
        );
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("does not mark completed work unread while its environment is open", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
    useUIStore.setState({ selectedEnvironmentId: environment.id });
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "record_environment_activity" ||
      command === "record_environment_completion"
        ? Promise.resolve({
            ...environment,
            lastActivityAt: args?.occurredAt,
            hasUnreadWork: command === "record_environment_completion",
          })
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
    expect(unreadEnvironmentIds()).toEqual([]);
  });

  test("records a second tmux tab while the environment remains working", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "record_environment_activity" ||
      command === "record_environment_completion"
        ? Promise.resolve({
            ...environment,
            lastActivityAt: args?.occurredAt,
            hasUnreadWork: command === "record_environment_completion",
          })
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
      )).toHaveLength(1);
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_completion",
      )).toHaveLength(1);
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

  test("restores the persisted unread state when atomic completion persistence fails", async () => {
    const previousActivityAt = "2026-07-20T10:00:00.000Z";
    const environment = {
      ...makeEnvironment("env-tmux", "container-tmux"),
      lastActivityAt: previousActivityAt,
      hasUnreadWork: false,
    };
    useEnvironmentStore.getState().setEnvironments([environment]);
    mockInvoke.mockImplementation((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "record_environment_activity") {
        return Promise.resolve({
          ...environment,
          lastActivityAt: args?.occurredAt,
        });
      }
      if (command === "record_environment_completion") {
        return Promise.reject(new Error("completion persistence unavailable"));
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
        store.setBusy(stateKey, false);
      });

      await waitFor(() => {
        expect(useEnvironmentStore.getState().getEnvironmentById("env-tmux"))
          .toMatchObject({
            lastActivityAt: previousActivityAt,
            hasUnreadWork: false,
          });
        expect(consoleWarn).toHaveBeenCalledWith(
          "[GlobalActivityMonitor] Failed to persist environment completion:",
          expect.any(Error),
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

  test("treats resetting a working tmux tab as teardown, not completion", async () => {
    const environment = makeEnvironment("env-tmux", "container-tmux");
    useEnvironmentStore.getState().setEnvironments([environment]);
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
    });
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState(environment.id))
        .toBe("working");
      expect(mockInvoke.mock.calls.some(
        ([command]) => command === "record_environment_activity",
      )).toBe(true);
    });
    const activityCallsBeforeReset = mockInvoke.mock.calls.filter(
      ([command]) => command === "record_environment_activity",
    ).length;
    const activityAtBeforeReset = useEnvironmentStore
      .getState()
      .getEnvironmentById(environment.id)?.lastActivityAt;

    act(() => {
      useClaudeTmuxStore.getState().resetTab(stateKey);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState(environment.id))
        .toBe("idle");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke.mock.calls.filter(
      ([command]) => command === "record_environment_activity",
    )).toHaveLength(activityCallsBeforeReset);
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt)
      .toBe(activityAtBeforeReset);
    expect(unreadEnvironmentIds()).toEqual([]);
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

  test("does not persist activity for an environment the store does not know", async () => {
    // The environment store is empty, so persistActivity bails before issuing
    // any backend write — an unknown id has no row to update.
    const stateKey = createClaudeTmuxStateKey("env-unknown", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-unknown",
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
    });

    // The in-memory activity state still updates; only persistence is skipped.
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-unknown"))
        .toBe("working");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-unknown"))
        .toBe("idle");
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "record_environment_activity",
      expect.anything(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "record_environment_completion",
      expect.anything(),
    );
    expect(unreadEnvironmentIds()).toEqual([]);
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
        {
          containerId: "container-1",
          subscriptionId: expect.any(String),
        },
      );
    });
    const startCall = mockInvoke.mock.calls.find(
      ([command]) => command === "start_claude_state_polling",
    );
    const subscriptionId = (
      startCall?.[1] as { subscriptionId?: string } | undefined
    )?.subscriptionId;
    expect(subscriptionId).toEqual(expect.any(String));

    await act(async () => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "waiting",
        },
      });
    });

    expect(useAgentActivityStore.getState().getContainerState("env-container"))
      .toBe("waiting");

    act(() => {
      useEnvironmentStore.setState({ environments: [] });
    });

    await waitFor(() => {
      expect(mockUnlisten).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith(
        "stop_claude_state_polling",
        { containerId: "container-1", subscriptionId },
      );
    });
  });

  test("does not echo backend-owned terminal activity into the frontend durable source", async () => {
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    render(<MonitorHarness />);
    await waitFor(() => {
      expect(eventCallbacks.has("claude-state-container-1")).toBe(true);
    });
    mockInvoke.mockClear();

    await act(async () => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "working",
          occurred_at: "2026-07-27T12:00:00.000Z",
        },
      });
      await Promise.resolve();
    });

    expect(useAgentActivityStore.getState().getContainerState("env-container"))
      .toBe("working");
    expect(mockInvoke.mock.calls.some(
      ([command]) => command === "set_environment_agent_activity",
    )).toBe(false);
  });

  test("tracks a timestamped terminal sequence without duplicating state persistence", async () => {
    const environment = makeEnvironment("env-container", "container-1");
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);
    await waitFor(() => {
      expect(eventCallbacks.has("claude-state-container-1")).toBe(true);
    });
    mockInvoke.mockClear();

    for (const [state, occurred_at] of [
      ["working", "2026-07-27T12:00:00.000Z"],
      ["waiting", "2026-07-27T12:00:01.000Z"],
      ["idle", "2026-07-27T12:00:02.000Z"],
    ] as const) {
      act(() => {
        eventCallbacks.get("claude-state-container-1")?.({
          payload: {
            container_id: "container-1",
            state,
            occurred_at,
          },
        });
      });
    }

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState(environment.id))
        .toBe("idle");
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      )).toHaveLength(1);
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_completion",
      )).toHaveLength(1);
    });
    expect(mockInvoke.mock.calls.some(
      ([command]) => command === "set_environment_agent_activity",
    )).toBe(false);
  });

  test("ignores terminal state events with malformed or poisoned observation times", async () => {
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    render(<MonitorHarness />);
    await waitFor(() => {
      expect(eventCallbacks.has("claude-state-container-1")).toBe(true);
    });
    mockInvoke.mockClear();

    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "working",
          occurred_at: "not-a-date",
        },
      });
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "working",
          occurred_at: "+275760-09-13T00:00:00.000Z",
        },
      });
    });

    expect(useAgentActivityStore.getState().containerStates["env-container"])
      .toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  test("does not let an idle terminal source hide working native activity", async () => {
    const environment = makeEnvironment("env-container", "container-1");
    const sessionKey = createSessionKey(environment.id, "tab-native");
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);

    act(() => {
      useClaudeStore.setState({
        clients: new Map([[environment.id, {} as any]]),
        sessions: new Map([[
          sessionKey,
          {
            sessionId: "native-session",
            messages: [],
            isLoading: true,
          } as any,
        ]]),
      });
    });
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState(environment.id))
        .toBe("working");
    });

    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "idle",
          occurred_at: "2026-07-27T12:00:00.000Z",
        },
      });
    });

    expect(useAgentActivityStore.getState().getContainerState(environment.id))
      .toBe("working");
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
    expect(unreadEnvironmentIds()).toEqual([environment.id]);

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

  test("does not re-mark unread when a stale or duplicate completed event arrives", async () => {
    // Simulates the user having already opened/cleared the environment after an
    // earlier completion: a redelivered or out-of-order "completed" event whose
    // timestamp is not newer than what we already have must not re-flag it.
    const environment = {
      ...makeEnvironment("env-local", ""),
      environmentType: "local" as const,
      containerId: null,
      lastActivityAt: "2026-07-23T10:00:00.000Z",
    };
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({ selectedEnvironmentId: null });
    render(<MonitorHarness />);

    await waitFor(() => {
      expect(eventCallbacks.has("environment-activity-recorded")).toBe(true);
    });

    act(() => {
      // Equal timestamp (duplicate delivery).
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: environment.id,
          occurred_at: "2026-07-23T10:00:00.000Z",
          activity_kind: "completed",
        },
      });
      // Older timestamp (out-of-order delivery).
      eventCallbacks.get("environment-activity-recorded")?.({
        payload: {
          environment_id: environment.id,
          occurred_at: "2026-07-23T09:00:00.000Z",
          activity_kind: "completed",
        },
      });
    });

    expect(unreadEnvironmentIds()).toEqual([]);
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
    let persistenceCalls = 0;
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (
        command !== "record_environment_activity" &&
        command !== "record_environment_completion"
      ) return Promise.resolve();
      persistenceCalls += 1;
      const occurredAt = String(args?.occurredAt);
      if (persistenceCalls === 1) {
        firstOccurredAt = occurredAt;
        return new Promise<Environment>((resolve) => {
          resolveFirstActivity = resolve;
        });
      }
      return Promise.resolve({
        ...environment,
        lastActivityAt: occurredAt,
        hasUnreadWork: command === "record_environment_completion",
      });
    });

    render(<MonitorHarness />);
    await waitFor(() => expect(eventCallbacks.has("claude-state-container-1")).toBe(true));

    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: { container_id: "container-1", state: "working" },
      });
    });
    await waitFor(() => expect(persistenceCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    act(() => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: { container_id: "container-1", state: "idle" },
      });
    });

    await waitFor(() => expect(persistenceCalls).toBe(2));
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
          {
            containerId: "container-1",
            subscriptionId: expect.any(String),
          },
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

  test("retries a transient polling start failure with the same registration", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    let startAttempts = 0;
    mockInvoke.mockImplementation((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "start_claude_state_polling") {
        startAttempts += 1;
        if (startAttempts === 1) {
          return Promise.reject(new Error("transport interrupted"));
        }
        return Promise.resolve(args);
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);

      await waitFor(() => expect(startAttempts).toBe(2));
      const startCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "start_claude_state_polling",
      );
      expect(startCalls).toHaveLength(2);
      expect(startCalls[0]?.[1]).toEqual(startCalls[1]?.[1]);
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
        {
          containerId: "container-1",
          subscriptionId: expect.any(String),
        },
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
      {
        containerId: "container-1",
        subscriptionId: expect.any(String),
      },
    );
  });

  test("disposes a stale listener when the container restarts mid-registration", async () => {
    // The container stops and comes back while the first listen() is still in
    // flight. The superseded registration must drop its listener instead of
    // installing it, otherwise the restarted container would end up with two
    // subscriptions and the stale one would outlive the next stop.
    let resolveFirstListen: ((unlisten: () => void) => void) | undefined;
    const staleUnlisten = mock(() => {});
    mockListen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveFirstListen = resolve;
        }),
    );

    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    render(<MonitorHarness />);

    await waitFor(() => expect(resolveFirstListen).toBeDefined());
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_claude_state_polling",
      {
        containerId: "container-1",
        subscriptionId: expect.any(String),
      },
    );

    // Container stops, then the same container id starts again. The second
    // pass allocates a fresh registration symbol for the same key.
    await act(async () => {
      useEnvironmentStore.setState({ environments: [] });
      await Promise.resolve();
    });
    await act(async () => {
      useEnvironmentStore.setState({
        environments: [makeEnvironment("env-container", "container-1")],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_claude_state_polling",
        {
          containerId: "container-1",
          subscriptionId: expect.any(String),
        },
      );
    });
    const startCallsAfterRestart = mockInvoke.mock.calls.filter(
      ([command]) => command === "start_claude_state_polling",
    ).length;

    await act(async () => {
      resolveFirstListen?.(staleUnlisten);
      await Promise.resolve();
    });

    // The superseded registration unsubscribes and does not start a second poll.
    expect(staleUnlisten).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls.filter(
      ([command]) => command === "start_claude_state_polling",
    )).toHaveLength(startCallsAfterRestart);
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
      {
        containerId: "container-1",
        subscriptionId: expect.any(String),
      },
    );
  });

  test("backs off and eventually gives up instead of warning forever", async () => {
    // Without a cap this warns every 30s for the life of the environment and
    // never recovers. The ladder itself also needs pinning: only its first
    // rung was previously exercised.
    const realSetTimeout = globalThis.setTimeout;
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      }
      throw new Error("timed out waiting for condition");
    };

    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const retryDelays: number[] = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delayMs?: number,
    ) => {
      retryDelays.push(delayMs ?? 0);
      // Collapse the ladder so the assertion does not take ~16 seconds.
      return realSetTimeout(callback, 0);
    }) as typeof globalThis.setTimeout);

    let startAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_claude_state_polling") {
        startAttempts += 1;
        return Promise.reject(new Error("backend unavailable"));
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);

      await waitUntil(() => consoleError.mock.calls.length > 0);
      // Eight attempts, then a single explicit give-up — not an endless loop.
      expect(startAttempts).toBe(8);
      expect(retryDelays).toEqual([0, 250, 500, 1000, 2000, 4000, 8000]);
      expect(consoleError).toHaveBeenCalledWith(
        "[GlobalActivityMonitor] Giving up on terminal state polling for",
        "container-1",
        expect.stringContaining("after 8 attempts"),
      );

      // No further attempts once it has given up.
      await new Promise((resolve) => realSetTimeout(resolve, 30));
      expect(startAttempts).toBe(8);
    } finally {
      timeoutSpy.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  test("releases a registration whose start succeeds after the container stops", async () => {
    // The environment stopped while the start request was in flight, so the
    // backend now holds a lease nothing will ever release.
    let resolveStart: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_claude_state_polling") {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    render(<MonitorHarness />);

    await waitFor(() => expect(resolveStart).toBeDefined());
    const stopCallsBefore = mockInvoke.mock.calls.filter(
      ([command]) => command === "stop_claude_state_polling",
    ).length;

    await act(async () => {
      useEnvironmentStore.setState({ environments: [] });
      await Promise.resolve();
    });
    await act(async () => {
      resolveStart?.(undefined);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "stop_claude_state_polling",
      ).length).toBeGreaterThan(stopCallsBefore);
    });
  });

  test("compensates instead of retrying when a start fails after the container stops", async () => {
    // A transport failure is ambiguous: the backend may already have accepted
    // the idempotent registration, so this must release rather than retry.
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    let rejectStart: ((reason: unknown) => void) | undefined;
    let startAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_claude_state_polling") {
        startAttempts += 1;
        return new Promise((_resolve, reject) => {
          rejectStart = reject;
        });
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);
      await waitFor(() => expect(rejectStart).toBeDefined());

      await act(async () => {
        useEnvironmentStore.setState({ environments: [] });
        await Promise.resolve();
      });
      await act(async () => {
        rejectStart?.(new Error("transport interrupted"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockInvoke.mock.calls.filter(
          ([command]) => command === "stop_claude_state_polling",
        ).length).toBeGreaterThanOrEqual(2);
      });
      // Retrying a registration for a container that is gone would leak it.
      expect(startAttempts).toBe(1);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("cancels a pending retry when the container stops", async () => {
    // Two failures arm a 250ms retry. Removing the container must disarm it,
    // or the timer fires against a registration that no longer exists.
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    let startAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_claude_state_polling") {
        startAttempts += 1;
        return Promise.reject(new Error("backend unavailable"));
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      render(<MonitorHarness />);
      // Attempt 1 fails, attempt 2 fires immediately and fails, arming a 250ms
      // third attempt.
      await waitFor(() => expect(startAttempts).toBe(2));

      await act(async () => {
        useEnvironmentStore.setState({ environments: [] });
        await Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(startAttempts).toBe(2);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("cancels a pending retry when the monitor unmounts", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    let startAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_claude_state_polling") {
        startAttempts += 1;
        return Promise.reject(new Error("backend unavailable"));
      }
      return Promise.resolve();
    });
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });

    try {
      const view = render(<MonitorHarness />);
      await waitFor(() => expect(startAttempts).toBe(2));

      await act(async () => {
        view.unmount();
        await Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(startAttempts).toBe(2);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("stops a registration whose listener never resolved when the monitor unmounts", async () => {
    // Unmount walks the poller map, not the listener map: a container that was
    // registered while listen() was still pending has no unlisten to call but
    // still owns a backend lease.
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

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "stop_claude_state_polling",
      {
        containerId: "container-1",
        subscriptionId: expect.any(String),
      },
    );
  });

  test("mints a distinct subscription token per container and survives an unavailable crypto", async () => {
    // The token is the whole ownership mechanism; two containers sharing one
    // would let either release the other's lease.
    const randomUuid = spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("insecure context");
      });
    try {
      useEnvironmentStore.setState({
        environments: [
          makeEnvironment("env-a", "container-a"),
          makeEnvironment("env-b", "container-b"),
        ],
      });
      render(<MonitorHarness />);

      await waitFor(() => {
        expect(mockInvoke.mock.calls.filter(
          ([command]) => command === "start_claude_state_polling",
        )).toHaveLength(2);
      });

      const tokens = mockInvoke.mock.calls
        .filter(([command]) => command === "start_claude_state_polling")
        .map(([, args]) => (args as { subscriptionId: string }).subscriptionId);
      expect(new Set(tokens).size).toBe(2);
      // The counter fallback still produces a usable, container-scoped token.
      expect(tokens[0]).toContain("container-a");
      expect(tokens[1]).toContain("container-b");
    } finally {
      randomUuid.mockRestore();
    }
  });

  test("ignores a claude-state payload that is not a known activity state", async () => {
    useEnvironmentStore.setState({
      environments: [makeEnvironment("env-container", "container-1")],
    });
    render(<MonitorHarness />);
    await waitFor(() => {
      expect(eventCallbacks.has("claude-state-container-1")).toBe(true);
    });

    await act(async () => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: { container_id: "container-1", state: "busy" },
      });
      await Promise.resolve();
    });

    expect(useAgentActivityStore.getState().containerStates)
      .not.toHaveProperty("env-container");
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "record_environment_activity",
      expect.anything(),
    );
    expect(unreadEnvironmentIds()).toEqual([]);
  });

  test("does not resurrect a terminal observation the store refused as stale", async () => {
    // The store rejects a token older than the one it holds. If the per-source
    // map kept the rejected value anyway, the next observation from a different
    // source would merge against a state that was never adopted and push the
    // sidebar back to working.
    const environment = makeEnvironment("env-container", "container-1");
    useEnvironmentStore.setState({ environments: [environment] });
    render(<MonitorHarness />);
    await waitFor(() => {
      expect(eventCallbacks.has("claude-state-container-1")).toBe(true);
    });

    act(() => {
      useAgentActivityStore.setState({
        containerStates: { "env-container": "idle" },
        containerStateUpdatedAt: {
          "env-container": "2026-07-27T12:00:10.000Z",
        },
      });
    });

    await act(async () => {
      eventCallbacks.get("claude-state-container-1")?.({
        payload: {
          container_id: "container-1",
          state: "working",
          occurred_at: "2026-07-27T12:00:05.000Z",
        },
      });
      await Promise.resolve();
    });
    expect(useAgentActivityStore.getState().getContainerState("env-container"))
      .toBe("idle");

    // A native source now reports idle. The rejected "working" must not merge
    // back in and outrank it.
    act(() => {
      useClaudeStore.setState({
        clients: new Map([["env-container", {} as any]]),
        sessions: new Map([
          [
            createSessionKey("env-container", "tab-1"),
            { sessionId: "s1", messages: [], isLoading: false } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-container"))
        .toBe("idle");
    });
  });

  test("skips persistence for an activity key no environment owns", async () => {
    render(<MonitorHarness />);
    await act(async () => {
      useAgentActivityStore.getState().setContainerState("env-unknown", "working");
      await Promise.resolve();
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "set_environment_agent_activity",
      expect.anything(),
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
    const sessionKey = createSessionKey("env-claude", "tab-1");
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
    const sessionKey = createSessionKey("env-claude", "tab-plan");
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

  test("treats a pending Codex approval as waiting for user input", async () => {
    // Codex derived activity from `isLoading` alone, so an environment blocked
    // on a command approval reported idle — the sidebar showed green while the
    // turn sat waiting for the user.
    const sessionKey = createSessionKey("env-codex", "tab-approval");
    render(<MonitorHarness />);

    act(() => {
      useCodexStore.setState({
        clients: new Map([["env-codex", {} as any]]),
        sessions: new Map([
          [sessionKey, { sessionId: "codex-thread", isLoading: false } as any],
        ]),
        pendingApprovals: new Map([
          [sessionKey, [{ approvalId: "approval-1" } as any]],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("waiting");
    });

    // Answering the approval releases it back to idle.
    act(() => {
      useCodexStore.setState({ pendingApprovals: new Map() });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("idle");
    });
  });

  test("reports waiting for an approval raised mid-turn, while still loading", async () => {
    /**
     * Codex holds `isLoading` for every non-terminal phase, so a turn parked on
     * an approval is *also* loading. Checking `isLoading` first showed the
     * environment as merely busy and gave the user no signal that it was their
     * input the turn was blocked on — which is the whole point of the amber
     * state.
     */
    const sessionKey = createSessionKey("env-codex", "tab-midturn");
    render(<MonitorHarness />);

    act(() => {
      useCodexStore.setState({
        clients: new Map([["env-codex", {} as any]]),
        sessions: new Map([
          [sessionKey, { sessionId: "codex-thread", isLoading: true } as any],
        ]),
        pendingApprovals: new Map([
          [sessionKey, [{ approvalId: "approval-1" } as any]],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("waiting");
    });

    // Answering it returns the environment to plain "working" — the turn is
    // still running, it is just no longer blocked on the user.
    act(() => {
      useCodexStore.setState({ pendingApprovals: new Map() });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-codex"))
        .toBe("working");
    });
  });

  test("keeps each native environment working while any tab is still loading", async () => {
    const claudeWorkingKey = createSessionKey(
      "env-claude",
      "tab-working",
    );
    const claudeIdleKey = createSessionKey("env-claude", "tab-idle");
    const openCodeWorkingKey = createSessionKey(
      "env-opencode",
      "tab-working",
    );
    const openCodeIdleKey = createSessionKey(
      "env-opencode",
      "tab-idle",
    );
    const codexWorkingKey = createSessionKey("env-codex", "tab-working");
    const codexIdleKey = createSessionKey("env-codex", "tab-idle");
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
      if (
        command !== "record_environment_activity" &&
        command !== "record_environment_completion"
      ) return Promise.resolve();
      const environment = environments.find((candidate) => candidate.id === args?.environmentId)!;
      return Promise.resolve({
        ...environment,
        lastActivityAt: args?.occurredAt,
        hasUnreadWork: command === "record_environment_completion",
      });
    });

    const claudeA = createSessionKey("env-claude", "tab-a");
    const claudeB = createSessionKey("env-claude", "tab-b");
    const openCodeA = createSessionKey("env-opencode", "tab-a");
    const openCodeB = createSessionKey("env-opencode", "tab-b");
    const codexA = createSessionKey("env-codex", "tab-a");
    const codexB = createSessionKey("env-codex", "tab-b");
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
      const completionCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_completion",
      );
      expect(activityCalls).toHaveLength(3);
      expect(completionCalls).toHaveLength(3);
      for (const environmentId of ["env-claude", "env-opencode", "env-codex"]) {
        expect(activityCalls.filter(([, args]) => args?.environmentId === environmentId))
          .toHaveLength(1);
        expect(completionCalls.filter(([, args]) => args?.environmentId === environmentId))
          .toHaveLength(1);
        expect(useAgentActivityStore.getState().getContainerState(environmentId))
          .toBe("working");
      }
      expect(new Set(unreadEnvironmentIds())).toEqual(
        new Set(["env-claude", "env-opencode", "env-codex"]),
      );
    });
  });

  test("does not let an idle agent type overwrite another working agent type", async () => {
    const claudeKey = createSessionKey("env-shared", "tab-claude");
    const codexKey = createSessionKey("env-shared", "tab-codex");
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
    const claudeKey = createSessionKey("env-claude", "tab-1");
    const openCodeKey = createSessionKey("env-opencode", "tab-1");
    const codexKey = createSessionKey("env-codex", "tab-1");
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
        ["question-1", { sessionId: "opencode-session" } as any],
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
    const claudeKey = createSessionKey("env-claude", "tab-1");
    const openCodeKey = createSessionKey("env-opencode", "tab-1");
    const codexKey = createSessionKey("env-codex", "tab-1");
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
    const claudeKey = createSessionKey("env-claude", "tab-1");
    const openCodeKey = createSessionKey("env-opencode", "tab-1");
    const codexKey = createSessionKey("env-codex", "tab-1");
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

  test("treats clearing working native sessions as teardown, not completion", async () => {
    const environments = ["env-claude", "env-opencode", "env-codex"].map((id) => ({
      ...makeEnvironment(id),
      environmentType: "local" as const,
      containerId: null,
    }));
    useEnvironmentStore.getState().setEnvironments(environments);
    mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command !== "record_environment_activity") return Promise.resolve();
      const environment = environments.find(
        (candidate) => candidate.id === args?.environmentId,
      )!;
      return Promise.resolve({ ...environment, lastActivityAt: args?.occurredAt });
    });
    const claudeKey = createSessionKey("env-claude", "tab-1");
    const openCodeKey = createSessionKey("env-opencode", "tab-1");
    const codexKey = createSessionKey("env-codex", "tab-1");
    render(<MonitorHarness />);

    act(() => {
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
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(
        ([command]) => command === "record_environment_activity",
      )).toHaveLength(3);
    });
    const activityTimesBeforeClear = new Map(
      environments.map((environment) => [
        environment.id,
        useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt,
      ]),
    );

    act(() => {
      useClaudeStore.setState({ sessions: new Map() });
      useOpenCodeStore.setState({ sessions: new Map() });
      useCodexStore.setState({ sessions: new Map() });
    });

    await waitFor(() => {
      for (const environment of environments) {
        expect(useAgentActivityStore.getState().getContainerState(environment.id))
          .toBe("idle");
      }
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke.mock.calls.filter(
      ([command]) => command === "record_environment_activity",
    )).toHaveLength(3);
    for (const environment of environments) {
      expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lastActivityAt)
        .toBe(activityTimesBeforeClear.get(environment.id));
    }
    expect(unreadEnvironmentIds()).toEqual([]);
  });

  test("keeps working above waiting across native agent types and restores waiting afterward", async () => {
    const openCodeKey = createSessionKey("env-shared", "tab-opencode");
    const codexKey = createSessionKey("env-shared", "tab-codex");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-shared", {} as any]]),
        sessions: new Map([
          [openCodeKey, { sessionId: "opencode-session", isLoading: false } as any],
        ]),
        pendingPermissions: new Map([
          ["permission-1", { sessionId: "opencode-session" } as any],
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
    const claudeKey = createSessionKey("env-shared", "tab-claude");
    const tmuxKey = createClaudeTmuxStateKey("env-shared", "tab-tmux");
    const openCodeKey = createSessionKey("env-shared", "tab-opencode");
    const codexKey = createSessionKey("env-shared", "tab-codex");
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
    const openCodeSessionKey = createSessionKey("env-opencode", "tab-1");
    const codexSessionKey = createSessionKey("env-codex", "tab-1");
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
          ["permission-1", { sessionId: "opencode-session" } as any],
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

  test("derives OpenCode waiting from a pending question", async () => {
    // pendingQuestions is the second arm of OpenCode's isWaiting; a question
    // blocks the turn on the user exactly like a permission prompt does.
    const sessionKey = createSessionKey("env-opencode", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "opencode-session",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("idle");
    });

    act(() => {
      useOpenCodeStore.setState({
        pendingQuestions: new Map([
          ["question-1", { sessionId: "opencode-session" } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("waiting");
    });

    act(() => {
      useOpenCodeStore.setState({ pendingQuestions: new Map() });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("idle");
    });
  });

  test("ignores an OpenCode question raised against another session", async () => {
    const sessionKey = createSessionKey("env-opencode", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "opencode-session",
              messages: [],
              isLoading: true,
            } as any,
          ],
        ]),
        pendingQuestions: new Map([
          ["question-1", { sessionId: "some-other-session" } as any],
        ]),
      });
    });

    // The question belongs to a session this environment does not own, so the
    // running turn stays blue rather than flipping to amber.
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("working");
    });
  });

  test("merges sibling sessions of one agent so working outranks waiting", async () => {
    // Within a single store the per-session states are folded together: a
    // waiting tab must not mask a sibling tab that is still running.
    const waitingKey = createSessionKey("env-opencode", "tab-waiting");
    const workingKey = createSessionKey("env-opencode", "tab-working");
    render(<MonitorHarness />);

    act(() => {
      useOpenCodeStore.setState({
        clients: new Map([["env-opencode", {} as any]]),
        sessions: new Map([
          [
            waitingKey,
            { sessionId: "waiting-session", messages: [], isLoading: false } as any,
          ],
          [
            workingKey,
            { sessionId: "working-session", messages: [], isLoading: true } as any,
          ],
        ]),
        pendingQuestions: new Map([
          ["question-1", { sessionId: "waiting-session" } as any],
        ]),
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("working");
    });

    act(() => {
      useOpenCodeStore.setState({
        sessions: new Map([
          [
            waitingKey,
            { sessionId: "waiting-session", messages: [], isLoading: false } as any,
          ],
          [
            workingKey,
            { sessionId: "working-session", messages: [], isLoading: false } as any,
          ],
        ]),
      });
    });

    // With nothing running the unanswered question surfaces as amber.
    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("waiting");
    });

    act(() => {
      useOpenCodeStore.setState({ pendingQuestions: new Map() });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-opencode"))
        .toBe("idle");
    });
  });
});
