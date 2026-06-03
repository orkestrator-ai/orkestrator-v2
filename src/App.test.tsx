import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useCodexStore, createCodexSessionKey } from "@/stores/codexStore";
import { useOpenCodeStore, createOpenCodeSessionKey } from "@/stores/openCodeStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import type { AppConfig, Environment } from "@/types";

import * as realLayout from "@/components/layout";
import * as realTooltip from "@/components/ui/tooltip";
import * as realTerminal from "@/components/terminal";
import * as realKanban from "@/components/kanban";
import * as realContexts from "@/contexts";
import * as realSonnerUi from "@/components/ui/sonner";
import * as realErrors from "@/components/errors";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import * as realButton from "@/components/ui/button";
import * as realPrMonitorService from "@/hooks/usePrMonitorService";
import * as realGlobalActivityMonitor from "@/hooks/useGlobalActivityMonitor";
import * as realHooks from "@/hooks";
import * as realTauri from "@/lib/tauri";
import * as realSonner from "sonner";
import * as realLucideReact from "lucide-react";
import * as realProcess from "@tauri-apps/plugin-process";

const realLayoutSnapshot = { ...realLayout };
const realTooltipSnapshot = { ...realTooltip };
const realTerminalSnapshot = { ...realTerminal };
const realKanbanSnapshot = { ...realKanban };
const realContextsSnapshot = { ...realContexts };
const realSonnerUiSnapshot = { ...realSonnerUi };
const realErrorsSnapshot = { ...realErrors };
const realAlertDialogSnapshot = { ...realAlertDialog };
const realButtonSnapshot = { ...realButton };
const realPrMonitorServiceSnapshot = { ...realPrMonitorService };
const realGlobalActivityMonitorSnapshot = { ...realGlobalActivityMonitor };
const realHooksSnapshot = { ...realHooks };
const realTauriSnapshot = { ...realTauri };
const realSonnerSnapshot = { ...realSonner };
const realLucideReactSnapshot = { ...realLucideReact };
const realProcessSnapshot = { ...realProcess };

const mockStartEnvironment = mock(async () => {});
const mockExit = mock(async () => {});

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
  }: {
    environmentId: string;
    isActive: boolean;
  }) => (
    <div
      data-testid={`terminal-${environmentId}`}
      data-active={String(isActive)}
    >
      {environmentId}
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

mock.module("@/lib/tauri", () => ({
  checkDocker: mockCheckDocker,
  checkClaudeCli: mock(async () => true),
  checkClaudeConfig: mock(async () => true),
  checkCodexCli: mock(async () => true),
  checkOpencodeCli: mock(async () => true),
  checkGithubCli: mock(async () => true),
  getAvailableAiCli: mock(async () => "claude"),
  getConfig: mock(async () => mockConfig),
  syncAllEnvironmentsWithDocker: mockSyncAllEnvironmentsWithDocker,
}));

mock.module("sonner", () => ({
  toast: {
    error: mock(() => {}),
  },
}));

mock.module("lucide-react", () => ({
  Loader2: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

mock.module("@tauri-apps/plugin-process", () => ({
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
    activeEnvironmentId: null,
  });

  useClaudeStore.setState({
    sessions: new Map(),
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

afterAll(() => {
  mock.module("@/components/layout", () => realLayoutSnapshot);
  mock.module("@/components/ui/tooltip", () => realTooltipSnapshot);
  mock.module("@/components/terminal", () => realTerminalSnapshot);
  mock.module("@/components/kanban", () => realKanbanSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
  mock.module("@/components/ui/sonner", () => realSonnerUiSnapshot);
  mock.module("@/components/errors", () => realErrorsSnapshot);
  mock.module("@/components/ui/alert-dialog", () => realAlertDialogSnapshot);
  mock.module("@/components/ui/button", () => realButtonSnapshot);
  mock.module("@/hooks/usePrMonitorService", () => realPrMonitorServiceSnapshot);
  mock.module("@/hooks/useGlobalActivityMonitor", () => realGlobalActivityMonitorSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/lib/tauri", () => realTauriSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
  mock.module("lucide-react", () => realLucideReactSnapshot);
  mock.module("@tauri-apps/plugin-process", () => realProcessSnapshot);
});

describe("App background processing mounts", () => {
  beforeEach(() => {
    cleanup();
    mockStartEnvironment.mockClear();
    mockExit.mockClear();
    mockCheckDocker.mockClear();
    mockCheckDocker.mockImplementation(async () => true);
    mockSyncAllEnvironmentsWithDocker.mockClear();
    mockSyncAllEnvironmentsWithDocker.mockImplementation(async () => []);
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

    expect(screen.getByTestId("terminal-env-visible").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("terminal-env-background").getAttribute("data-active")).toBe("false");
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

  test("keeps off-screen environments with queued native prompts mounted across agents until queues drain", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-queued-claude", "project-2"),
        makeEnvironment("env-queued-codex", "project-2"),
        makeEnvironment("env-queued-opencode", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const claudeSessionKey = createClaudeSessionKey("env-queued-claude", "tab-1");
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
      expect(screen.getByTestId("terminal-env-queued-codex")).toBeTruthy();
      expect(screen.getByTestId("terminal-env-queued-opencode")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-env-queued-claude").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("terminal-env-queued-codex").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("terminal-env-queued-opencode").getAttribute("data-active")).toBe("false");

    act(() => {
      useClaudeStore.getState().clearQueue(claudeSessionKey);
      useCodexStore.getState().clearQueue(codexSessionKey);
      useOpenCodeStore.getState().clearQueue(openCodeSessionKey);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-env-queued-claude")).toBeNull();
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
});

describe("App Docker availability", () => {
  beforeEach(() => {
    cleanup();
    mockStartEnvironment.mockClear();
    mockExit.mockClear();
    mockCheckDocker.mockClear();
    mockCheckDocker.mockImplementation(async () => true);
    mockSyncAllEnvironmentsWithDocker.mockClear();
    mockSyncAllEnvironmentsWithDocker.mockImplementation(async () => []);
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

    const retry = screen.getByRole("button", { name: /retry/i });
    retry.click();

    await waitFor(() => {
      expect(mockCheckDocker).toHaveBeenCalledTimes(2);
      expect(mockSyncAllEnvironmentsWithDocker).toHaveBeenCalledTimes(1);
    });
  });
});
