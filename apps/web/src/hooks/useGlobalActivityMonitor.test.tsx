import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { useGlobalActivityMonitor } from "./useGlobalActivityMonitor";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
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
