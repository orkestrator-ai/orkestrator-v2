import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useCodexStore, createCodexSessionKey } from "@/stores/codexStore";
import { useOpenCodeStore, createOpenCodeSessionKey } from "@/stores/openCodeStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { AppConfig, Environment } from "@/types";

import * as realLayout from "@/components/layout";
import * as realTooltip from "@/components/ui/tooltip";
import * as realTerminal from "@/components/terminal";
import * as realKanban from "@/components/kanban";
import * as realContexts from "@/contexts";
import * as realSonnerUi from "@/components/ui/sonner";
import * as realErrors from "@/components/errors";
import * as realLinear from "@/components/linear";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import * as realButton from "@/components/ui/button";
import * as realPrMonitorService from "@/hooks/usePrMonitorService";
import * as realGlobalActivityMonitor from "@/hooks/useGlobalActivityMonitor";
import * as realHooks from "@/hooks";
import * as realBackend from "@/lib/backend";
import * as realSonner from "sonner";
import * as realLucideReact from "lucide-react";
import * as realProcess from "@/lib/native/process";

const realLayoutSnapshot = { ...realLayout };
const realTooltipSnapshot = { ...realTooltip };
const realTerminalSnapshot = { ...realTerminal };
const realKanbanSnapshot = { ...realKanban };
const realContextsSnapshot = { ...realContexts };
const realSonnerUiSnapshot = { ...realSonnerUi };
const realErrorsSnapshot = { ...realErrors };
const realLinearSnapshot = { ...realLinear };
const realAlertDialogSnapshot = { ...realAlertDialog };
const realButtonSnapshot = { ...realButton };
const realPrMonitorServiceSnapshot = { ...realPrMonitorService };
const realGlobalActivityMonitorSnapshot = { ...realGlobalActivityMonitor };
const realHooksSnapshot = { ...realHooks };
const realBackendSnapshot = { ...realBackend };
const realSonnerSnapshot = { ...realSonner };
const realLucideReactSnapshot = { ...realLucideReact };
const realProcessSnapshot = { ...realProcess };

const mockStartEnvironment = mock(async () => {});
const mockExit = mock(async () => {});
const mockLinearMonitorRender = mock(() => undefined);
const mockListen = listen as ReturnType<typeof mock>;
type AppEventCallback = (event: { payload: any }) => void;
let appEventCallbacks = new Map<string, AppEventCallback>();
const mockAppUnlisten = mock(() => {});

const mockConfig: AppConfig = {
  version: "1.0",
  global: {
    containerResources: {
      cpuCores: 2,
      memoryGb: 4,
    },
    envFilePatterns: [".env.local", ".env"],
    allowedDomains: ["github.com"],
    defaultAgent: "claude",
    opencodeModel: "opencode/grok-code",
    codexModel: "gpt-5.3-codex",
    codexReasoningEffort: "medium",
    opencodeMode: "terminal",
    claudeMode: "terminal",
    claudeNativeBackend: "sdk",
    codexMode: "native",
    terminalAppearance: {
      fontFamily: "FiraCode Nerd Font",
      fontSize: 14,
      backgroundColor: "#000000",
    },
    terminalScrollback: 5000,
    experimentalCodexRawEventLogging: true,
  },
  repositories: {},
};

mock.module("@/components/layout", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

mock.module("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module("@/components/terminal", () => ({
  TerminalContainer: ({
    environmentId,
    isActive,
    onStartContainer,
    onCreateScript,
  }: {
    environmentId: string;
    isActive: boolean;
    onStartContainer?: (initialPrompt?: string) => void;
    onCreateScript?: (initialPrompt: string) => void;
  }) => (
    <div
      data-testid={`terminal-${environmentId}`}
      data-active={String(isActive)}
    >
      {environmentId}
      <button
        type="button"
        data-testid={`start-${environmentId}`}
        onClick={() => onStartContainer?.()}
      >
        start {environmentId}
      </button>
      <button
        type="button"
        data-testid={`start-prompt-${environmentId}`}
        onClick={() => onStartContainer?.("Prompt from terminal")}
      >
        start prompt {environmentId}
      </button>
      <button
        type="button"
        data-testid={`create-script-${environmentId}`}
        onClick={() => onCreateScript?.("Create setup script")}
      >
        create script {environmentId}
      </button>
    </div>
  ),
}));

mock.module("@/components/kanban", () => ({
  KanbanBoard: ({ projectId }: { projectId: string }) => <div data-testid="kanban-board">{projectId}</div>,
}));

mock.module("@/contexts", () => ({
  TerminalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

mock.module("@/components/errors", () => ({
  ErrorDetailsDialog: () => null,
}));

mock.module("@/components/linear", () => ({
  ...realLinearSnapshot,
  LinearPipelineCompletionMonitor: () => {
    mockLinearMonitorRender();
    return <div data-testid="linear-completion-monitor" />;
  },
}));

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <>{children}</> : null,
  AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}));

mock.module("@/hooks/usePrMonitorService", () => ({
  usePrMonitorService: () => {},
}));

mock.module("@/hooks/useGlobalActivityMonitor", () => ({
  useGlobalActivityMonitor: () => {},
}));

mock.module("@/hooks", () => ({
  useEnvironments: () => ({
    startEnvironment: mockStartEnvironment,
  }),
}));

const mockCheckDocker = mock(async () => true);
const mockSyncAllEnvironmentsWithDocker = mock(async () => [] as string[]);
const mockCheckClaudeCli = mock(async () => true);
const mockCheckClaudeConfig = mock(async () => true);
const mockCheckOpencodeCli = mock(async () => true);
const mockCheckCodexCli = mock(async () => true);
const mockCheckGithubCli = mock(async () => true);
const mockGetAvailableAiCli = mock<() => Promise<string | null>>(async () => "claude");
const mockGetConfig = mock(async () => mockConfig);
const mockSavePaneLayout = mock(async (environmentId: string, layout: Record<string, unknown>) => ({
  ...layout,
  environmentId,
  updatedAt: "2026-07-16T00:00:00.000Z",
  revision: 1,
}));

mock.module("@/lib/backend", () => ({
  checkDocker: mockCheckDocker,
  checkClaudeCli: mockCheckClaudeCli,
  checkClaudeConfig: mockCheckClaudeConfig,
  checkCodexCli: mockCheckCodexCli,
  checkOpencodeCli: mockCheckOpencodeCli,
  checkGithubCli: mockCheckGithubCli,
  getAvailableAiCli: mockGetAvailableAiCli,
  getConfig: mockGetConfig,
  savePaneLayout: mockSavePaneLayout,
  syncAllEnvironmentsWithDocker: mockSyncAllEnvironmentsWithDocker,
}));

const mockToastError = mock(() => {});

mock.module("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

mock.module("lucide-react", () => ({
  Loader2: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

mock.module("@/lib/native/process", () => ({
  exit: mockExit,
}));

import App from "./App";

function makeEnvironment(id: string, projectId: string): Environment {
  return {
    id,
    projectId,
    name: `env-${id}`,
    branch: id,
    containerId: `container-${id}`,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
  } as Environment;
}

function resetStores({
  environments,
  selectedProjectId,
  selectedEnvironmentId,
  setupScriptsRunning = new Set<string>(),
}: {
  environments: Environment[];
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  setupScriptsRunning?: Set<string>;
}) {
  localStorage.clear();

  useEnvironmentStore.setState({
    environments,
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning,
  });

  useUIStore.setState({
    selectedProjectId,
    selectedEnvironmentId,
    recentProjectIds: [],
    sidebarWidth: 280,
    collapsedProjects: [],
    selectedEnvironmentIds: [],
    expandedSessionsEnvironments: [],
    zoomLevel: 100,
  });

  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });

  useProjectStore.setState({
    projects: [],
    isLoading: false,
    error: null,
  });

  useConfigStore.setState({
    config: mockConfig,
    isLoading: false,
    error: null,
  });

  useClaudeOptionsStore.setState({
    options: {},
    pendingNativeLaunches: {},
  });

  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });

  useClaudeStore.setState({
    sessions: new Map(),
    messageQueue: new Map(),
  });

  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
  });

  useCodexStore.setState({
    sessions: new Map(),
    messageQueue: new Map(),
  });

  useOpenCodeStore.setState({
    sessions: new Map(),
    messageQueue: new Map(),
  });
}

function resetAppMocks() {
  mockStartEnvironment.mockClear();
  mockStartEnvironment.mockImplementation(async () => {});
  mockExit.mockClear();
  mockCheckDocker.mockClear();
  mockCheckDocker.mockImplementation(async () => true);
  mockSyncAllEnvironmentsWithDocker.mockClear();
  mockSyncAllEnvironmentsWithDocker.mockImplementation(async () => []);
  mockCheckClaudeCli.mockClear();
  mockCheckClaudeCli.mockImplementation(async () => true);
  mockCheckClaudeConfig.mockClear();
  mockCheckClaudeConfig.mockImplementation(async () => true);
  mockCheckOpencodeCli.mockClear();
  mockCheckOpencodeCli.mockImplementation(async () => true);
  mockCheckCodexCli.mockClear();
  mockCheckCodexCli.mockImplementation(async () => true);
  mockCheckGithubCli.mockClear();
  mockCheckGithubCli.mockImplementation(async () => true);
  mockGetAvailableAiCli.mockClear();
  mockGetAvailableAiCli.mockImplementation(async () => "claude");
  mockGetConfig.mockClear();
  mockGetConfig.mockImplementation(async () => mockConfig);
  mockSavePaneLayout.mockClear();
  mockToastError.mockClear();
  mockLinearMonitorRender.mockClear();
  mockAppUnlisten.mockClear();
  appEventCallbacks = new Map();
  mockListen.mockClear();
  mockListen.mockImplementation((eventName: string, callback: AppEventCallback) => {
    appEventCallbacks.set(eventName, callback);
    return Promise.resolve(mockAppUnlisten);
  });
  document.documentElement.style.zoom = "";
}

afterAll(() => {
  mock.module("@/components/layout", () => realLayoutSnapshot);
  mock.module("@/components/ui/tooltip", () => realTooltipSnapshot);
  mock.module("@/components/terminal", () => realTerminalSnapshot);
  mock.module("@/components/kanban", () => realKanbanSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
  mock.module("@/components/ui/sonner", () => realSonnerUiSnapshot);
  mock.module("@/components/errors", () => realErrorsSnapshot);
  mock.module("@/components/linear", () => realLinearSnapshot);
  mock.module("@/components/ui/alert-dialog", () => realAlertDialogSnapshot);
  mock.module("@/components/ui/button", () => realButtonSnapshot);
  mock.module("@/hooks/usePrMonitorService", () => realPrMonitorServiceSnapshot);
  mock.module("@/hooks/useGlobalActivityMonitor", () => realGlobalActivityMonitorSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
  mock.module("lucide-react", () => realLucideReactSnapshot);
  mock.module("@/lib/native/process", () => realProcessSnapshot);
});

describe("App background processing mounts", () => {
  beforeEach(() => {
    cleanup();
    resetAppMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("keeps off-screen setup-running environments mounted in hidden background terminals", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-background", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
      setupScriptsRunning: new Set(["env-background"]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-background")).toBeTruthy();
    });

    expect(
      screen.getByTestId("background-terminal-host").className.split(/\s+/)
    ).not.toContain("hidden");
    expect(screen.getByTestId("terminal-env-visible").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("terminal-env-background").getAttribute("data-active")).toBe("false");
  });

  test("mounts the Linear completion monitor globally", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    expect(await screen.findByTestId("linear-completion-monitor")).toBeTruthy();
    expect(mockLinearMonitorRender).toHaveBeenCalled();
  });

  test("starts one pane persistence subscription and flushes it on app teardown", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    const { unmount } = render(<App />);

    act(() => {
      const store = usePaneLayoutStore.getState();
      store.initialize("container-1", "env-1");
      store.beginHydration("env-1");
      store.finishHydration("env-1");
      store.addTab("default", { id: "tab-1", type: "plain" }, "env-1");
      store.addTab("default", { id: "tab-2", type: "plain" }, "env-1");
    });
    unmount();

    await waitFor(() => expect(mockSavePaneLayout).toHaveBeenCalledTimes(1));
    expect(mockSavePaneLayout).toHaveBeenCalledWith(
      "env-1",
      expect.objectContaining({ version: 1, activePaneId: "default" }),
    );
  });

  test("keeps off-screen environments with pending setup commands mounted before setup starts", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-pending-setup", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    useEnvironmentStore.getState().setPendingSetupCommands("env-pending-setup", [
      "/usr/local/bin/workspace-setup.sh",
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-pending-setup")).toBeTruthy();
    });

    expect(screen.getByTestId("terminal-env-pending-setup").getAttribute("data-active")).toBe("false");
  });

  test("does not duplicate setup-running environments that are already visible", async () => {
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
      setupScriptsRunning: new Set(["env-visible"]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByTestId("terminal-env-visible")).toHaveLength(1);
    });
  });

  test("does not foreground-mount inactive sibling environments in the selected project", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-sibling", "project-1"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
    });

    expect(screen.queryByTestId("terminal-env-sibling")).toBeNull();
  });

  test("keeps an active sibling in the selected project mounted as a hidden background terminal", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-sibling", "project-1"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          "pipeline-sibling",
          {
            id: "pipeline-sibling",
            environmentId: "env-sibling",
            phase: "building",
          } as never,
        ],
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-sibling")).toBeTruthy();
    });

    // Selected environment is foreground; the active sibling stays mounted but
    // inactive so its pipeline-advancement effects keep running.
    expect(screen.getByTestId("terminal-env-visible").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("terminal-env-sibling").getAttribute("data-active")).toBe("false");
  });

  test("keeps off-screen environments with a pending native launch mounted", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-pending-launch", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    useClaudeOptionsStore.getState().setPendingNativeLaunch("env-pending-launch", {
      containerId: "container-env-pending-launch",
      environmentId: "env-pending-launch",
      initialPrompt: "Stand up the Codex session",
      targetPaneId: "default",
      agentType: "codex",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-pending-launch")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-pending-launch").getAttribute("data-active")).toBe("false");
  });

  test("keeps off-screen environments with a pending tab initialPrompt mounted", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-pending-prompt", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-pending-prompt",
          {
            root: {
              kind: "leaf" as const,
              id: "default",
              tabs: [
                {
                  id: "tab-1",
                  type: "codex-native" as any,
                  codexNativeData: {
                    environmentId: "env-pending-prompt",
                    containerId: "container-env-pending-prompt",
                    isLocal: false,
                  },
                  initialPrompt: "Run the off-screen audit",
                } as any,
              ],
              activeTabId: "tab-1",
            },
            activePaneId: "default",
            containerId: "container-env-pending-prompt",
          },
        ],
      ]),
      activeEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-pending-prompt")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-pending-prompt").getAttribute("data-active")).toBe("false");
  });

  test("keeps off-screen environments with queued prompts mounted across agents until queues drain", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-queued-claude", "project-2"),
        makeEnvironment("env-queued-tmux", "project-2"),
        makeEnvironment("env-queued-codex", "project-2"),
        makeEnvironment("env-queued-opencode", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const claudeSessionKey = createClaudeSessionKey("env-queued-claude", "tab-1");
    const tmuxStateKey = createClaudeTmuxStateKey("env-queued-tmux", "tab-1");
    const codexSessionKey = createCodexSessionKey("env-queued-codex", "tab-1");
    const openCodeSessionKey = createOpenCodeSessionKey("env-queued-opencode", "tab-1");
    useClaudeStore.setState({
      messageQueue: new Map([
        [
          claudeSessionKey,
          [
            {
              id: "queue-claude",
              text: "Run queued Claude work",
              attachments: [],
              effort: "medium",
              planModeEnabled: false,
              fastModeEnabled: false,
            },
          ],
        ],
      ]),
    });
    useClaudeTmuxStore.setState({
      messageQueue: new Map([
        [
          tmuxStateKey,
          [
            {
              id: "queue-tmux",
              text: "Run queued tmux work",
              attachments: [],
            },
          ],
        ],
      ]),
    });
    useCodexStore.setState({
      messageQueue: new Map([
        [
          codexSessionKey,
          [
            {
              id: "queue-codex",
              text: "Run queued Codex work",
              attachments: [],
              model: "gpt-5",
              mode: "build",
              reasoningEffort: "medium",
              fastMode: false,
            },
          ],
        ],
      ]),
    });
    useOpenCodeStore.setState({
      messageQueue: new Map([
        [
          openCodeSessionKey,
          [
            {
              id: "queue-opencode",
              text: "Run queued OpenCode work",
              attachments: [],
              model: "openai/gpt-5",
              mode: "build",
            },
          ],
        ],
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-queued-claude")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-queued-tmux")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-queued-codex")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-queued-opencode")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-queued-claude").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("terminal-env-queued-tmux").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("terminal-env-queued-codex").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("terminal-env-queued-opencode").getAttribute("data-active")).toBe("false");

    act(() => {
      useClaudeStore.getState().clearQueue(claudeSessionKey);
      useClaudeTmuxStore.getState().clearQueue(tmuxStateKey);
      useCodexStore.getState().clearQueue(codexSessionKey);
      useOpenCodeStore.getState().clearQueue(openCodeSessionKey);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-env-queued-claude")).toBeNull();
      expect(screen.queryByTestId("terminal-env-queued-tmux")).toBeNull();
      expect(screen.queryByTestId("terminal-env-queued-codex")).toBeNull();
      expect(screen.queryByTestId("terminal-env-queued-opencode")).toBeNull();
    });
  });

  test("keeps off-screen environments with a loading native session mounted until idle", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-loading-codex", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const sessionKey = createCodexSessionKey("env-loading-codex", "tab-1");
    useCodexStore.setState({
      sessions: new Map([
        [
          sessionKey,
          {
            sessionId: "sess-loading",
            messages: [],
            isLoading: true,
          } as any,
        ],
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-loading-codex")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-loading-codex").getAttribute("data-active")).toBe("false");

    // Once the session reports idle, the env should no longer be mounted as background.
    act(() => {
      useCodexStore.setState({
        sessions: new Map([
          [
            sessionKey,
            {
              sessionId: "sess-loading",
              messages: [],
              isLoading: false,
            } as any,
          ],
        ]),
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-env-loading-codex")).toBeNull();
    });
  });

  test("keeps off-screen environments with a busy tmux session mounted until idle", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-busy-tmux", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const stateKey = createClaudeTmuxStateKey("env-busy-tmux", "tab-1");
    useClaudeTmuxStore.getState().setRunning(stateKey, true, {
      environmentId: "env-busy-tmux",
      sessionId: "session-tmux",
    });
    useClaudeTmuxStore.getState().setBusy(stateKey, true);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-busy-tmux")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-busy-tmux").getAttribute("data-active")).toBe("false");

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-env-busy-tmux")).toBeNull();
    });
  });

  test("keeps off-screen environments with a pending tmux hook mounted while waiting", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-waiting-tmux", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const stateKey = createClaudeTmuxStateKey("env-waiting-tmux", "tab-1");
    useClaudeTmuxStore.getState().setRunning(stateKey, true, {
      environmentId: "env-waiting-tmux",
      sessionId: "session-tmux",
    });
    useClaudeTmuxStore.getState().addPendingQuestion(stateKey, {
      eventId: "question-1",
      questions: [],
      toolInput: {},
      payload: {},
      receivedAt: "2026-06-16T00:00:00.000Z",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-waiting-tmux")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-waiting-tmux").getAttribute("data-active")).toBe("false");
  });
});

describe("App Docker availability", () => {
  beforeEach(() => {
    cleanup();
    resetAppMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("retry rechecks Docker and syncs environments after Docker becomes available", async () => {
    // Startup: Docker unavailable. Retry: Docker now available.
    mockCheckDocker.mockImplementationOnce(async () => false);
    mockCheckDocker.mockImplementationOnce(async () => true);
    mockSyncAllEnvironmentsWithDocker.mockImplementation(async () => ["env-stale"]);

    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    // Wait for the startup check to flip dockerAvailable to false.
    await waitFor(() => {
      expect(mockCheckDocker).toHaveBeenCalledTimes(1);
    });
    // Startup check should NOT have triggered sync because Docker was unavailable.
    expect(mockSyncAllEnvironmentsWithDocker).not.toHaveBeenCalled();

    act(() => {
      screen.getByRole("button", { name: /retry/i }).click();
    });

    await waitFor(() => {
      expect(mockCheckDocker).toHaveBeenCalledTimes(2);
      expect(mockSyncAllEnvironmentsWithDocker).toHaveBeenCalledTimes(1);
    });
  });
});

describe("App startup checks and global events", () => {
  beforeEach(() => {
    cleanup();
    resetAppMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("shows the no-AI-CLI dialog and retries CLI checks", async () => {
    mockCheckClaudeCli.mockImplementation(async () => false);
    mockCheckClaudeConfig.mockImplementation(async () => false);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    mockGetAvailableAiCli.mockImplementation(async () => null);

    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("AI CLI Required")).toBeTruthy();
    });

    mockCheckClaudeCli.mockImplementation(async () => true);
    mockCheckClaudeConfig.mockImplementation(async () => true);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    mockGetAvailableAiCli.mockImplementation(async () => "claude");

    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    await waitFor(() => {
      expect(mockCheckClaudeCli).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("AI CLI Required")).toBeNull();
    });
  });

  test("shows Claude login required when Claude is installed but not configured", async () => {
    mockCheckClaudeCli.mockImplementation(async () => true);
    mockCheckClaudeConfig.mockImplementation(async () => false);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    mockGetAvailableAiCli.mockImplementation(async () => "claude");

    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Claude Code Login Required")).toBeTruthy();
    });
  });

  test("shows and dismisses the GitHub CLI warning", async () => {
    mockCheckGithubCli.mockImplementation(async () => false);

    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("GitHub CLI Not Found")).toBeTruthy();
    });

    act(() => {
      screen.getByRole("button", { name: "Continue Without GitHub CLI" }).click();
    });

    await waitFor(() => {
      expect(screen.queryByText("GitHub CLI Not Found")).toBeNull();
    });
  });

  test("continues rendering when config load fails", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    mockGetConfig.mockImplementation(async () => {
      throw new Error("config unavailable");
    });

    try {
      resetStores({
        environments: [],
        selectedProjectId: null,
        selectedEnvironmentId: null,
      });

      render(<App />);

      await waitFor(() => {
        expect(mockGetConfig).toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
          "[App] Failed to load config:",
          expect.any(Error),
        );
      });
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("handles menu zoom and credential error events", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(appEventCallbacks.has("menu-zoom")).toBe(true);
      expect(appEventCallbacks.has("claude-credentials-error")).toBe(true);
    });

    act(() => {
      appEventCallbacks.get("menu-zoom")?.({ payload: "in" });
    });
    await waitFor(() => {
      expect(document.documentElement.style.zoom).toBe("110%");
    });

    act(() => {
      appEventCallbacks.get("menu-zoom")?.({ payload: "reset" });
      appEventCallbacks.get("claude-credentials-error")?.({
        payload: {
          kind: "refresh_failed",
          message: "Unable to refresh Claude credentials",
        },
      });
    });

    await waitFor(() => {
      expect(document.documentElement.style.zoom).toBe("100%");
      expect(mockToastError).toHaveBeenCalledWith(
        "Claude credentials refresh failed",
        expect.objectContaining({
          description: "Unable to refresh Claude credentials",
        }),
      );
    });
  });
});

describe("App terminal overlay actions", () => {
  beforeEach(() => {
    cleanup();
    resetAppMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("normal overlay start rehydrates a saved initial prompt before starting", async () => {
    resetStores({
      environments: [
        {
          ...makeEnvironment("env-visible", "project-1"),
          defaultAgent: "codex",
          initialPrompt: "Stand up the Codex session",
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    act(() => {
      screen.getByTestId("start-env-visible").click();
    });

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Stand up the Codex session",
      );
      expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
        .toMatchObject({
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Stand up the Codex session",
        });
    });
  });

  test("rehydration keeps an existing agentType over the environment default", async () => {
    resetStores({
      environments: [
        {
          ...makeEnvironment("env-visible", "project-1"),
          defaultAgent: "codex",
          initialPrompt: "Resume the prior task",
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    // Existing options carry an agentType but no initialPrompt, so the stored
    // prompt is rehydrated while the prior agentType wins over defaultAgent.
    useClaudeOptionsStore.getState().setOptions("env-visible", {
      launchAgent: false,
      agentType: "opencode",
      initialPrompt: "",
    });

    render(<App />);

    act(() => {
      screen.getByTestId("start-env-visible").click();
    });

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Resume the prior task",
      );
      expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
        .toMatchObject({
          launchAgent: true,
          agentType: "opencode",
          initialPrompt: "Resume the prior task",
        });
    });
  });

  test("rehydration falls back to the global default agent when none is set", async () => {
    resetStores({
      environments: [
        {
          ...makeEnvironment("env-visible", "project-1"),
          initialPrompt: "Boot the default agent",
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    act(() => {
      screen.getByTestId("start-env-visible").click();
    });

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Boot the default agent",
      );
      // No existing options and no environment defaultAgent, so the agentType
      // falls back to config.global.defaultAgent ("claude").
      expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
        .toMatchObject({
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Boot the default agent",
        });
    });
  });

  test("normal overlay start does not rehydrate once setup scripts are complete", async () => {
    resetStores({
      environments: [
        {
          ...makeEnvironment("env-visible", "project-1"),
          defaultAgent: "codex",
          initialPrompt: "Should not be rehydrated",
          setupScriptsComplete: true,
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    act(() => {
      screen.getByTestId("start-env-visible").click();
    });

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith("env-visible", undefined);
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
      .toBeUndefined();
  });

  test("normal overlay starts clear stale Claude options before starting", async () => {
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    useClaudeOptionsStore.getState().setOptions("env-visible", {
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "stale",
    });

    render(<App />);

    act(() => {
      screen.getByTestId("start-env-visible").click();
    });

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith("env-visible", undefined);
      expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
        .toBeUndefined();
    });
  });

  test("create-script overlay clears launch options when start fails", async () => {
    mockStartEnvironment.mockImplementation(async () => {
      throw new Error("start failed");
    });
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    const originalConsoleError = console.error;
    console.error = mock(() => {});
    try {
      act(() => {
        screen.getByTestId("create-script-env-visible").click();
      });

      await waitFor(() => {
        expect(mockStartEnvironment).toHaveBeenCalledWith(
          "env-visible",
          "Create setup script",
        );
        expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
          .toBeUndefined();
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
