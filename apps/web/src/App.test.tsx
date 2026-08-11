import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import {useClaudeStore} from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import {useCodexStore} from "@/stores/codexStore";
import {useOpenCodeStore} from "@/stores/openCodeStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import {
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";
import type { AppConfig, Environment } from "@/types";
import { PANE_LAYOUT_VERSION } from "@/types/paneLayout";
import { mockToastError } from "../../../tests/mocks/sonner";

import * as realLayout from "@/components/layout";
import * as realTooltip from "@/components/ui/tooltip";
import * as realTerminal from "@/components/terminal";
import * as realKanban from "@/components/kanban";
import * as realProjects from "@/components/projects";
import * as realContexts from "@/contexts";
import * as realSonnerUi from "@/components/ui/sonner";
import * as realErrors from "@/components/errors";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import * as realButton from "@/components/ui/button";
import * as realPrMonitorService from "@/hooks/usePrMonitorService";
import * as realCodexBackgroundSync from "@/hooks/useCodexBackgroundSync";
import * as realGlobalActivityMonitor from "@/hooks/useGlobalActivityMonitor";
import * as realHooks from "@/hooks";
import * as realBackend from "@/lib/backend";
import * as realLucideReact from "lucide-react";
import * as realProcess from "@/lib/native/process";
import * as realBuildPipelinePersistence from "@/lib/build-pipeline-persistence";
import * as realPromptQueuePersistence from "@/lib/prompt-queue-persistence";

const realLayoutSnapshot = { ...realLayout };
const realTooltipSnapshot = { ...realTooltip };
const realTerminalSnapshot = { ...realTerminal };
const realKanbanSnapshot = { ...realKanban };
const realProjectsSnapshot = { ...realProjects };
const realContextsSnapshot = { ...realContexts };
const realSonnerUiSnapshot = { ...realSonnerUi };
const realErrorsSnapshot = { ...realErrors };
const realAlertDialogSnapshot = { ...realAlertDialog };
const realButtonSnapshot = { ...realButton };
const realPrMonitorServiceSnapshot = { ...realPrMonitorService };
const realCodexBackgroundSyncSnapshot = { ...realCodexBackgroundSync };
const realGlobalActivityMonitorSnapshot = { ...realGlobalActivityMonitor };
const realHooksSnapshot = { ...realHooks };
const realBackendSnapshot = { ...realBackend };
const realLucideReactSnapshot = { ...realLucideReact };
const realProcessSnapshot = { ...realProcess };
const realBuildPipelinePersistenceSnapshot = { ...realBuildPipelinePersistence };
const realPromptQueuePersistenceSnapshot = { ...realPromptQueuePersistence };

const mockStartEnvironment = mock(async () => {});
const mockCreateEnvironment = mock(async () => makeEnvironment("created", "project-1"));
const mockUpdateEnvironment = mock(() => {});
const mockUseEnvironmentLifecycleService = mock(() => {});
const mockUseCodexBackgroundSync = mock(() => {});
const mockExit = mock(async () => {});
const mockListen = listen as ReturnType<typeof mock>;
type AppEventCallback = (event: { payload: any }) => void;
let appEventCallbacks = new Map<string, AppEventCallback>();
const mockAppUnlisten = mock(() => {});
let projectLauncherProps: React.ComponentProps<typeof realProjects.ProjectLauncher> | null = null;

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
    isContainerRunning,
    onStartContainer,
    onCreateScript,
  }: {
    environmentId: string;
    isActive: boolean;
    isContainerRunning?: boolean;
    onStartContainer?: (initialPrompt?: string) => void;
    onCreateScript?: (initialPrompt: string) => void;
  }) => (
    <div
      data-testid={`terminal-${environmentId}`}
      data-active={String(isActive)}
      data-container-running={String(isContainerRunning)}
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

mock.module("@/components/projects", () => ({
  ...realProjectsSnapshot,
  ProjectLauncher: (props: React.ComponentProps<typeof realProjects.ProjectLauncher>) => {
    projectLauncherProps = props;
    return <div data-testid="project-launcher" />;
  },
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

mock.module("@/hooks/useCodexBackgroundSync", () => ({
  useCodexBackgroundSync: mockUseCodexBackgroundSync,
}));

mock.module("@/hooks/useGlobalActivityMonitor", () => ({
  useGlobalActivityMonitor: () => {},
}));

mock.module("@/hooks", () => ({
  useEnvironmentLifecycleService: mockUseEnvironmentLifecycleService,
  useEnvironments: () => ({
    startEnvironment: mockStartEnvironment,
    createEnvironment: mockCreateEnvironment,
    updateEnvironment: mockUpdateEnvironment,
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
const mockGetResourceRevisionManifest = mock(async () => ({
  generation: "a".repeat(32),
  reset: false,
  revisions: {},
}));
const mockGetEnvironment = mock(
  async (environmentId: string): Promise<Environment | null> =>
    useEnvironmentStore.getState().getEnvironmentById(environmentId) ?? null,
);
const mockSavePaneLayout = mock(async (
  environmentId: string,
  layout: Parameters<typeof realBackend.savePaneLayout>[1],
  expectedRevision = 0,
) => ({
  ...layout,
  environmentId,
  updatedAt: "2026-07-16T00:00:00.000Z",
  revision: expectedRevision + 1,
}));
const mockListLoopedReviewWorkflows = mock(
  async (_environmentId: string): Promise<Array<{
    id: string;
    environmentId: string;
    version: number;
    snapshot: LoopedReviewWorkflow;
    updatedAt: string;
    revision: number;
  }>> => [],
);
const mockSaveLoopedReviewWorkflow = mock(async (
  id: string,
  environmentId: string,
  version: number,
  snapshot: unknown,
  expectedRevision = 0,
) => ({
  id,
  environmentId,
  version,
  snapshot,
  updatedAt: "2026-07-26T00:00:00.000Z",
  revision: expectedRevision + 1,
}));
const mockListPromptQueues = mock(async (_environmentId: string) => []);
const mockListBuildPipelines = mock(async (_projectId: string) => []);
const appPersistenceLifecycle: string[] = [];
const mockStopBuildPipelinePersistence = mock(() => undefined);
const mockMigrateLegacyBuildPipelines = mock(async () => {
  appPersistenceLifecycle.push("migrate-build");
  return { importedIds: [], skipped: 0 };
});
const mockStartBuildPipelinePersistence = mock(() => {
  appPersistenceLifecycle.push("start-build");
  return mockStopBuildPipelinePersistence;
});
const mockApplyPaneLayoutIntent = mock(async (
  environmentId: string,
  _base: Parameters<typeof realBackend.applyPaneLayoutIntent>[1],
  desired: Parameters<typeof realBackend.applyPaneLayoutIntent>[2],
) => mockSavePaneLayout(environmentId, desired, 0));

mock.module("@/lib/build-pipeline-persistence", () => ({
  ...realBuildPipelinePersistenceSnapshot,
  hydrateBuildPipelinesForProject: (projectId: string) =>
    mockListBuildPipelines(projectId),
  migrateLegacyBuildPipelines: mockMigrateLegacyBuildPipelines,
  startBuildPipelinePersistence: mockStartBuildPipelinePersistence,
}));

mock.module("@/lib/prompt-queue-persistence", () => ({
  ...realPromptQueuePersistenceSnapshot,
  hydratePromptQueuesForEnvironment: (environmentId: string) =>
    mockListPromptQueues(environmentId),
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
  getResourceRevisionManifest: mockGetResourceRevisionManifest,
  getEnvironment: mockGetEnvironment,
  listBuildPipelines: mockListBuildPipelines,
  listLoopedReviewWorkflows: mockListLoopedReviewWorkflows,
  listPromptQueues: mockListPromptQueues,
  savePaneLayout: mockSavePaneLayout,
  applyPaneLayoutIntent: mockApplyPaneLayoutIntent,
  saveLoopedReviewWorkflow: mockSaveLoopedReviewWorkflow,
  syncAllEnvironmentsWithDocker: mockSyncAllEnvironmentsWithDocker,
}));

mock.module("lucide-react", () => ({
  Loader2: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

mock.module("@/lib/native/process", () => ({
  exit: mockExit,
}));

import App, { DOCKER_AVAILABILITY_POLL_INTERVAL_MS } from "./App";

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
}: {
  environments: Environment[];
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
}) {
  localStorage.clear();

  useEnvironmentStore.setState({
    environments,
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
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
  useLoopedReviewStore.setState({ workflows: new Map() });
}

function resetAppMocks() {
  mockStartEnvironment.mockClear();
  mockStartEnvironment.mockImplementation(async () => {});
  mockCreateEnvironment.mockClear();
  mockCreateEnvironment.mockImplementation(async () => makeEnvironment("created", "project-1"));
  mockUpdateEnvironment.mockClear();
  mockUseEnvironmentLifecycleService.mockClear();
  mockUseCodexBackgroundSync.mockClear();
  projectLauncherProps = null;
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
  mockGetResourceRevisionManifest.mockClear();
  mockGetResourceRevisionManifest.mockImplementation(async () => ({
    generation: "a".repeat(32),
    reset: false,
    revisions: {},
  }));
  mockGetEnvironment.mockClear();
  mockGetEnvironment.mockImplementation(
    async (environmentId: string) =>
      useEnvironmentStore.getState().getEnvironmentById(environmentId) ?? null,
  );
  mockSavePaneLayout.mockClear();
  mockApplyPaneLayoutIntent.mockClear();
  mockListLoopedReviewWorkflows.mockReset();
  mockListLoopedReviewWorkflows.mockResolvedValue([]);
  mockListPromptQueues.mockReset();
  mockListPromptQueues.mockResolvedValue([]);
  mockListBuildPipelines.mockReset();
  mockListBuildPipelines.mockResolvedValue([]);
  appPersistenceLifecycle.length = 0;
  mockStopBuildPipelinePersistence.mockClear();
  mockMigrateLegacyBuildPipelines.mockReset();
  mockMigrateLegacyBuildPipelines.mockImplementation(async () => {
    appPersistenceLifecycle.push("migrate-build");
    return { importedIds: [], skipped: 0 };
  });
  mockStartBuildPipelinePersistence.mockClear();
  mockSaveLoopedReviewWorkflow.mockClear();
  mockToastError.mockClear();
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
  mock.module("@/components/projects", () => realProjectsSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
  mock.module("@/components/ui/sonner", () => realSonnerUiSnapshot);
  mock.module("@/components/errors", () => realErrorsSnapshot);
  mock.module("@/components/ui/alert-dialog", () => realAlertDialogSnapshot);
  mock.module("@/components/ui/button", () => realButtonSnapshot);
  mock.module("@/hooks/usePrMonitorService", () => realPrMonitorServiceSnapshot);
  mock.module("@/hooks/useCodexBackgroundSync", () => realCodexBackgroundSyncSnapshot);
  mock.module("@/hooks/useGlobalActivityMonitor", () => realGlobalActivityMonitorSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("lucide-react", () => realLucideReactSnapshot);
  mock.module("@/lib/native/process", () => realProcessSnapshot);
  mock.module(
    "@/lib/build-pipeline-persistence",
    () => realBuildPipelinePersistenceSnapshot,
  );
  mock.module(
    "@/lib/prompt-queue-persistence",
    () => realPromptQueuePersistenceSnapshot,
  );
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

  test("mounts the environment lifecycle service exactly once at the app root", () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    expect(mockUseEnvironmentLifecycleService).toHaveBeenCalledTimes(1);
  });

  test("mounts the Codex background synchronizer exactly once at the app root", () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    expect(mockUseCodexBackgroundSync).toHaveBeenCalledTimes(1);
  });

  test("keeps a live container available when its setup phase failed", async () => {
    resetStores({
      environments: [{
        ...makeEnvironment("env-failed-setup", "project-1"),
        status: "error",
        setupPhase: "failed",
      }],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-failed-setup",
    });

    render(<App />);

    const terminal = await screen.findByTestId("terminal-env-failed-setup");
    expect(terminal.getAttribute("data-container-running")).toBe("true");
  });

  test("does not treat a stopped container with failed setup as available", async () => {
    resetStores({
      environments: [{
        ...makeEnvironment("env-stopped-setup", "project-1"),
        status: "stopped",
        setupPhase: "failed",
      }],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-stopped-setup",
    });

    render(<App />);

    const terminal = await screen.findByTestId("terminal-env-stopped-setup");
    expect(terminal.getAttribute("data-container-running")).toBe("false");
  });

  test("does not mount off-screen environments solely for backend-owned setup work", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        {
          ...makeEnvironment("env-background", "project-2"),
          setupPhase: "running",
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());

    expect(screen.getByTestId("terminal-env-visible").getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("terminal-env-background")).toBeNull();
    expect(screen.queryByTestId("background-terminal-host")).toBeNull();
  });

  test("hydrates looped reviews exactly once per environment, starting from an empty store", async () => {
    // Cold start is the case that matters: the store is empty, so hydration
    // must not be conditional on already holding a workflow. It must also not
    // be duplicated — a second hydration path would double every list call.
    resetStores({
      environments: [
        makeEnvironment("env-a", "project-1"),
        makeEnvironment("env-b", "project-1"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-a",
    });
    expect(useLoopedReviewStore.getState().workflows.size).toBe(0);

    render(<App />);

    await waitFor(() => {
      expect(mockListLoopedReviewWorkflows.mock.calls.map(([id]) => id).sort())
        .toEqual(["env-a", "env-b"]);
    });
  });

  test("starts and cleans up the authoritative resource synchronization listeners", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(appEventCallbacks.has("resource-changed")).toBe(true);
      expect(appEventCallbacks.has("native-event-stream-connected")).toBe(true);
      expect(mockGetResourceRevisionManifest).toHaveBeenCalledWith(undefined, {});
      expect(mockStartBuildPipelinePersistence).not.toHaveBeenCalled();
    });

    cleanup();
    expect(mockAppUnlisten.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockStopBuildPipelinePersistence).not.toHaveBeenCalled();
  });

  test("hydrates every environment queue and project pipeline independently", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-one", "project-one"),
        makeEnvironment("env-two", "project-two"),
      ],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    useProjectStore.setState({
      projects: [
        {
          id: "project-one",
          name: "One",
          gitUrl: "https://example.invalid/one.git",
          localPath: null,
          addedAt: "2026-01-01T00:00:00.000Z",
          order: 0,
        },
        {
          id: "project-two",
          name: "Two",
          gitUrl: "https://example.invalid/two.git",
          localPath: null,
          addedAt: "2026-01-01T00:00:00.000Z",
          order: 1,
        },
      ],
    });
    mockListPromptQueues.mockImplementation(async (environmentId) => {
      if (environmentId === "env-one") throw new Error("queue unavailable");
      return [];
    });
    mockListBuildPipelines.mockImplementation(async (projectId) => {
      if (projectId === "project-one") throw new Error("pipeline unavailable");
      return [];
    });
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      render(<App />);

      await waitFor(() => {
        expect(mockListPromptQueues.mock.calls.map(([id]) => id).sort()).toEqual(
          ["env-one", "env-two"],
        );
        expect(mockListBuildPipelines.mock.calls.map(([id]) => id).sort()).toEqual(
          ["project-one", "project-two"],
        );
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("contains a rejected legacy build-pipeline migration", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    const migrationError = new Error("migration unavailable");
    mockMigrateLegacyBuildPipelines.mockRejectedValueOnce(migrationError);
    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    console.warn = warn;
    try {
      render(<App />);

      expect(await screen.findByTestId("project-launcher")).toBeTruthy();
      await waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          "[App] Failed to migrate legacy build pipelines:",
          migrationError,
        );
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("contains one looped-review hydration rejection and continues hydrating peers", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-rejected", "project-one"),
        makeEnvironment("env-restored", "project-two"),
      ],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    const hydrationError = new Error("looped reviews unavailable");
    mockListLoopedReviewWorkflows.mockImplementation(async (environmentId: string) => {
      if (environmentId === "env-rejected") throw hydrationError;
      return [];
    });
    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    console.warn = warn;
    try {
      render(<App />);

      await waitFor(() => {
        expect(mockListLoopedReviewWorkflows.mock.calls.map(([id]) => id).sort()).toEqual([
          "env-rejected",
          "env-restored",
        ]);
        expect(warn).toHaveBeenCalledWith(
          "[App] Failed to restore looped reviews for env-rejected:",
          hydrationError,
        );
      });
      expect(screen.getByTestId("project-launcher")).toBeTruthy();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("hydrates looped reviews without retaining a background terminal host", async () => {
    const background = makeEnvironment("env-looped", "project-2");
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        background,
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    const workflow = loopedReviewFixture({
      environmentId: background.id,
      projectId: background.projectId,
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    useLoopedReviewStore.setState({ workflows: new Map() });
    mockListLoopedReviewWorkflows.mockImplementation(async (environmentId: string) =>
      environmentId === background.id
        ? [{
            id: workflow.id,
            environmentId: workflow.environmentId,
            version: workflow.version,
            snapshot: workflow,
            updatedAt: workflow.updatedAt,
            revision: 2,
          }]
        : []
    );

    render(<App />);

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({ backendRevision: 2, phase: "preparing" });
    });
    expect(mockListLoopedReviewWorkflows).toHaveBeenCalledWith("env-looped");
    expect(screen.queryByTestId("terminal-env-looped")).toBeNull();
  });

  test("routes the empty selection to the launcher and forwards environment operations", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });

    render(<App />);

    expect(screen.getByTestId("project-launcher")).toBeTruthy();
    expect(projectLauncherProps).toEqual({
      createEnvironment: mockCreateEnvironment,
      updateEnvironment: mockUpdateEnvironment,
      startEnvironment: mockStartEnvironment,
    });
    await waitFor(() => expect(mockCheckDocker).toHaveBeenCalled());
  });

  test("routes a selected project without an environment to its board", async () => {
    resetStores({
      environments: [],
      selectedProjectId: "project-1",
      selectedEnvironmentId: null,
    });

    render(<App />);

    expect(screen.getByTestId("kanban-board").textContent).toBe("project-1");
    expect(screen.queryByTestId("project-launcher")).toBeNull();
    await waitFor(() => expect(mockCheckDocker).toHaveBeenCalled());
  });

  test("persists same-turn pane intents and flushes them on app teardown", async () => {
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

    await waitFor(() => expect(mockApplyPaneLayoutIntent).toHaveBeenCalledTimes(2));
    expect(mockSavePaneLayout).toHaveBeenLastCalledWith(
      "env-1",
      expect.objectContaining({
        version: PANE_LAYOUT_VERSION,
        activePaneId: "default",
      }),
      0,
    );
  });

  test("does not mount off-screen environments solely for pending backend setup", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-pending-setup", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    useEnvironmentStore.getState().updateEnvironment("env-pending-setup", {
      setupPhase: "pending",
    });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-pending-setup")).toBeNull();
    expect(screen.queryByTestId("background-terminal-host")).toBeNull();
  });

  test("does not duplicate setup-running environments that are already visible", async () => {
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
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

  test("does not mount an active pipeline sibling because the backend owns advancement", async () => {
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
            taskId: "task-sibling",
            projectId: "project-1",
            environmentId: "env-sibling",
            environmentType: "containerized",
            agentType: "codex",
            phase: "building",
            sessions: [],
            currentSessionIndex: -1,
            iteration: 0,
            maxIterations: 3,
            createdAt: "2026-07-28T00:00:00.000Z",
            taskTitle: "Background task",
            taskSnapshot: {
              title: "Background task",
              description: "",
              acceptanceCriteria: "",
              comments: [],
              images: [],
            },
            source: { type: "kanban", taskId: "task-sibling" },
            backendRevision: 1,
            controller: "backend",
          },
        ],
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
    });

    expect(screen.getByTestId("terminal-env-visible").getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("terminal-env-sibling")).toBeNull();
  });

  test("does not mount off-screen environments for renderer launch projections", async () => {
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

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-pending-launch")).toBeNull();
  });

  test("does not mount off-screen environments for durable launch intents", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        {
          ...makeEnvironment("env-durable-launch", "project-2"),
          pendingAgentLaunch: true,
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-durable-launch")).toBeNull();
  });

  test("does not mount off-screen environments for backend startup sessions", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        {
          ...makeEnvironment("env-startup-session", "project-2"),
          pendingAgentLaunch: false,
          startupAgentSession: {
            tabId: "startup-agent",
            agent: "codex",
            style: "native",
            providerSessionId: "provider-session",
            status: "running",
            startedAt: "2026-07-29T12:00:00.000Z",
          },
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-startup-session")).toBeNull();
  });

  test.each(["starting", "error"] as const)(
    "does not mount an off-screen environment for a backend-owned %s startup session",
    async (status) => {
      resetStores({
        environments: [
          makeEnvironment("env-visible", "project-1"),
          {
            ...makeEnvironment(`env-startup-${status}`, "project-2"),
            pendingAgentLaunch: false,
            startupAgentSession: {
              tabId: "startup-agent",
              agent: "codex",
              style: "native",
              status,
              ...(status === "error"
                ? { error: "Agent launch failed; the backend will retry." }
                : {}),
            },
          },
        ],
        selectedProjectId: "project-1",
        selectedEnvironmentId: "env-visible",
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
      expect(screen.queryByTestId(`terminal-env-startup-${status}`)).toBeNull();
    },
  );

  test("does not mount a stopped environment that still carries a durable launch", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        {
          ...makeEnvironment("env-stopped-launch", "project-2"),
          status: "stopped",
          pendingAgentLaunch: true,
        },
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
    });
    // A stopped environment cannot act on the launch, so mounting it would buy a
    // terminal, store subscriptions and listeners for no work at all.
    expect(screen.queryByTestId("terminal-env-stopped-launch")).toBeNull();
  });

  test("does not mount off-screen environments for pending tab prompts", async () => {
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

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-pending-prompt")).toBeNull();
  });

  test("does not mount an off-screen environment merely because prompts are queued", async () => {
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

    const claudeSessionKey = createSessionKey("env-queued-claude", "tab-1");
    const tmuxStateKey = createClaudeTmuxStateKey("env-queued-tmux", "tab-1");
    const codexSessionKey = createSessionKey("env-queued-codex", "tab-1");
    const openCodeSessionKey = createSessionKey("env-queued-opencode", "tab-1");
    useClaudeStore.setState({
      messageQueue: new Map([
        [claudeSessionKey, [{
          id: "queue-claude",
          text: "Run queued Claude work",
          attachments: [],
          effort: "medium",
          planModeEnabled: false,
          fastModeEnabled: false,
        }]],
      ]),
    });
    useClaudeTmuxStore.setState({
      messageQueue: new Map([
        [tmuxStateKey, [{ id: "queue-tmux", text: "Run queued tmux work", attachments: [] }]],
      ]),
    });
    useCodexStore.setState({
      messageQueue: new Map([
        [codexSessionKey, [{
          id: "queue-codex",
          text: "Run queued Codex work",
          attachments: [],
          model: "gpt-5",
          mode: "build",
          reasoningEffort: "medium",
          fastMode: false,
        }]],
      ]),
    });
    useOpenCodeStore.setState({
      messageQueue: new Map([
        [openCodeSessionKey, [{
          id: "queue-opencode",
          text: "Run queued OpenCode work",
          attachments: [],
          model: "openai/gpt-5",
          mode: "build",
        }]],
      ]),
    });

    render(<App />);

    // The visible environment mounts, which is how we know the tree settled
    // rather than simply not having rendered yet.
    await waitFor(() => {
      expect(screen.getByTestId("terminal-env-visible")).toBeTruthy();
    });
    // `NativeAgentService` and `PromptQueueDrainer` dispatch these server-side.
    // Force-mounting a hidden terminal for them kept an environment alive for
    // work the renderer was not doing.
    expect(screen.queryByTestId("terminal-env-queued-claude")).toBeNull();
    expect(screen.queryByTestId("terminal-env-queued-tmux")).toBeNull();
    expect(screen.queryByTestId("terminal-env-queued-codex")).toBeNull();
    expect(screen.queryByTestId("terminal-env-queued-opencode")).toBeNull();
  });

  test("does not mount off-screen environments for loading native sessions", async () => {
    resetStores({
      environments: [
        makeEnvironment("env-visible", "project-1"),
        makeEnvironment("env-loading-codex", "project-2"),
      ],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const sessionKey = createSessionKey("env-loading-codex", "tab-1");
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

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-loading-codex")).toBeNull();
  });

  test("does not mount off-screen environments for busy tmux sessions", async () => {
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

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-busy-tmux")).toBeNull();
  });

  test("does not mount off-screen environments for pending tmux hooks", async () => {
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

    await waitFor(() => expect(screen.getByTestId("terminal-env-visible")).toBeTruthy());
    expect(screen.queryByTestId("terminal-env-waiting-tmux")).toBeNull();
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
      screen.getByRole("button", { name: "Check Again" }).click();
    });

    await waitFor(() => {
      expect(mockCheckDocker).toHaveBeenCalledTimes(2);
      expect(mockSyncAllEnvironmentsWithDocker).toHaveBeenCalledTimes(1);
    });
  });

  test("treats startup check failures as unavailable and keeps sync failures non-fatal", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;

    try {
      mockCheckDocker.mockImplementationOnce(async () => {
        throw new Error("docker socket unavailable");
      });
      resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });
      const first = render(<App />);

      expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith(
        "[App] Docker startup check failed:",
        expect.any(Error),
      );
      first.unmount();

      resetAppMocks();
      console.error = consoleError;
      mockSyncAllEnvironmentsWithDocker.mockImplementationOnce(async () => {
        throw new Error("sync failed");
      });
      resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });
      render(<App />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[App] Failed to sync environments with Docker:",
          expect.any(Error),
        );
      });
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("keeps a failed retry non-blocking and lets the user dismiss the warning", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    mockCheckDocker.mockImplementationOnce(async () => false);
    mockCheckDocker.mockImplementationOnce(async () => {
      throw new Error("retry failed");
    });

    try {
      resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });
      render(<App />);
      await screen.findByText("Docker Is Not Running");

      act(() => screen.getByRole("button", { name: "Check Again" }).click());
      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[App] Docker retry check failed:",
          expect.any(Error),
        );
      });

      act(() => screen.getByRole("button", { name: "Continue Without Docker" }).click());
      expect(screen.queryByText("Docker Is Not Running")).toBeNull();
      expect(screen.getByTestId("app-shell")).toBeTruthy();
      expect(mockExit).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("polls every 60 seconds and disables then re-enables container functionality", async () => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const pollCallbacks: Array<() => void> = [];
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === DOCKER_AVAILABILITY_POLL_INTERVAL_MS) {
        pollCallbacks.push(handler as () => void);
      }
      return 42;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => {}) as typeof window.clearInterval;
    mockCheckDocker
      .mockImplementationOnce(async () => true)
      // Two failures, because one is not enough to declare an outage.
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true);
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    const letDockerCheckSettle = () => act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    const runPoll = () => act(async () => {
      pollCallbacks.forEach((poll) => poll());
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    try {
      render(<App />);
      await waitFor(() => {
        expect(mockCheckDocker).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("terminal-env-visible").getAttribute("data-container-running"))
          .toBe("true");
      });
      expect(pollCallbacks.length).toBeGreaterThan(0);
      await letDockerCheckSettle();

      await runPoll();
      await waitFor(() => {
        expect(mockCheckDocker).toHaveBeenCalledTimes(3);
        expect(screen.getByText("Docker Is Not Running")).toBeTruthy();
      });
      // The daemon being down says nothing about whether this container is
      // still up, and answering "not running" here disposes the environment's
      // terminals. The outage must not reach that projection.
      expect(screen.getByTestId("terminal-env-visible").getAttribute("data-container-running"))
        .toBe("true");

      act(() => screen.getByRole("button", { name: "Continue Without Docker" }).click());
      await runPoll();
      await waitFor(() => {
        expect(mockCheckDocker).toHaveBeenCalledTimes(4);
        expect(screen.queryByText("Docker Is Not Running")).toBeNull();
      });
      expect(mockSyncAllEnvironmentsWithDocker).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("keeps container functionality after a single failed probe recovers", async () => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const pollCallbacks: Array<() => void> = [];
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === DOCKER_AVAILABILITY_POLL_INTERVAL_MS) {
        pollCallbacks.push(handler as () => void);
      }
      return 42;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => {}) as typeof window.clearInterval;
    mockCheckDocker
      .mockImplementationOnce(async () => true)
      // `docker info` timed out once under load; the confirming probe succeeds.
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true);
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    try {
      render(<App />);
      await waitFor(() => expect(mockCheckDocker).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });

      await act(async () => {
        pollCallbacks.forEach((poll) => poll());
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      await waitFor(() => expect(mockCheckDocker).toHaveBeenCalledTimes(3));

      expect(screen.queryByText("Docker Is Not Running")).toBeNull();
      expect(screen.getByTestId("terminal-env-visible").getAttribute("data-container-running"))
        .toBe("true");
      // Docker never left the "available" state, so nothing needed re-syncing
      // beyond the startup reconcile.
      expect(mockSyncAllEnvironmentsWithDocker).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("declares an outage without a confirming probe when Docker was never available", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
    // Startup has no healthy state to protect, so it must not pay for a second
    // 10s `docker info` before telling the user what is wrong.
    expect(mockCheckDocker).toHaveBeenCalledTimes(1);
  });

  test("deduplicates Docker polls while an earlier probe is still in flight", async () => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const pollCallbacks: Array<() => void> = [];
    let resolveDocker!: (available: boolean) => void;
    mockCheckDocker.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolveDocker = resolve;
      }),
    );
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === DOCKER_AVAILABILITY_POLL_INTERVAL_MS) {
        pollCallbacks.push(handler as () => void);
      }
      return 42;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => {}) as typeof window.clearInterval;
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });

    try {
      render(<App />);
      await waitFor(() => expect(mockCheckDocker).toHaveBeenCalledTimes(1));
      expect(pollCallbacks).toHaveLength(1);

      act(() => {
        pollCallbacks[0]!();
        pollCallbacks[0]!();
      });
      expect(mockCheckDocker).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveDocker(true);
        await Promise.resolve();
      });
      act(() => pollCallbacks[0]!());
      await waitFor(() => expect(mockCheckDocker).toHaveBeenCalledTimes(2));
    } finally {
      cleanup();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
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
    expect(
      screen.getAllByText(/Option [123]: Install/).map((option) => option.textContent),
    ).toEqual([
      "Option 1: Install Claude Code (recommended)",
      "Option 2: Install Codex",
      "Option 3: Install OpenCode",
    ]);

    mockCheckClaudeCli.mockImplementation(async () => true);
    mockCheckClaudeConfig.mockImplementation(async () => true);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    mockGetAvailableAiCli.mockImplementation(async () => "claude");

    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    await waitFor(
      () => {
        expect(mockCheckClaudeCli).toHaveBeenCalledTimes(2);
        expect(screen.queryByText("AI CLI Required")).toBeNull();
      },
      {
        // The aggregate runner executes the bridge suites concurrently; allow
        // the retry's async React updates to drain under that sustained load.
        timeout: 10_000,
      },
    );
  }, 15_000);

  test("checks host CLIs and shows onboarding after continuing without Docker", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    mockCheckClaudeCli.mockImplementation(async () => false);
    mockCheckClaudeConfig.mockImplementation(async () => false);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    mockCheckGithubCli.mockImplementation(async () => false);
    mockGetAvailableAiCli.mockImplementation(async () => null);
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Continue Without Docker" }).click());

    expect(await screen.findByText("AI CLI Required")).toBeTruthy();
    expect(mockCheckClaudeCli).toHaveBeenCalledTimes(1);
    expect(mockCheckClaudeConfig).toHaveBeenCalledTimes(1);
    expect(mockCheckOpencodeCli).toHaveBeenCalledTimes(1);
    expect(mockCheckCodexCli).toHaveBeenCalledTimes(1);
    expect(mockCheckGithubCli).toHaveBeenCalledTimes(1);
    expect(mockGetAvailableAiCli).toHaveBeenCalledTimes(1);
  });

  test("shows the host GitHub CLI warning after continuing without Docker", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    mockCheckGithubCli.mockImplementation(async () => false);
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Continue Without Docker" }).click());

    expect(await screen.findByText("GitHub CLI Not Found")).toBeTruthy();
  });

  test("shows the Claude login warning after continuing without Docker", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    mockCheckClaudeConfig.mockImplementation(async () => false);
    mockCheckOpencodeCli.mockImplementation(async () => false);
    mockCheckCodexCli.mockImplementation(async () => false);
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Continue Without Docker" }).click());

    expect(await screen.findByText("Claude Code Login Required")).toBeTruthy();
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

  test("handles initial and retried CLI check rejection", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    mockCheckClaudeCli.mockImplementation(async () => {
      throw new Error("cli probe failed");
    });

    try {
      resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });
      render(<App />);

      expect(await screen.findByText("AI CLI Required")).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith("[App] CLI check failed:", expect.any(Error));

      consoleError.mockClear();
      act(() => screen.getByRole("button", { name: "Retry" }).click());
      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[App] CLI retry check failed:",
          expect.any(Error),
        );
      });
      expect(screen.getByText("AI CLI Required")).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
    }
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

  test("switches from the CSS fallback to native page zoom and clears the fallback", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    const originalOrkestrator = window.orkestrator;
    let nativeZoomSupported = false;
    const setZoomFactor = mock(async () => nativeZoomSupported);
    window.orkestrator = {
      window: {
        startDragging: async () => undefined,
        setZoomFactor,
      },
    } as unknown as Window["orkestrator"];

    try {
      render(<App />);

      // A client that cannot zoom natively reports false, so the CSS fallback
      // is applied and has to stay in place.
      await waitFor(() => {
        expect(setZoomFactor).toHaveBeenCalledWith(1);
        expect(document.documentElement.style.zoom).toBe("100%");
      });

      // Once native zoom takes over, the stale fallback has to be cleared: the
      // compositor is already applying a factor, so leaving CSS zoom set would
      // compound the two.
      nativeZoomSupported = true;
      await waitFor(() => expect(appEventCallbacks.has("menu-zoom")).toBe(true));
      act(() => {
        appEventCallbacks.get("menu-zoom")?.({ payload: "in" });
      });

      await waitFor(() => {
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(document.documentElement.style.zoom).toBe("");
      });
    } finally {
      window.orkestrator = originalOrkestrator;
    }
  });

  test("falls back to CSS zoom when the native zoom bridge rejects", async () => {
    resetStores({
      environments: [],
      selectedProjectId: null,
      selectedEnvironmentId: null,
    });
    const originalOrkestrator = window.orkestrator;
    const originalConsoleWarn = console.warn;
    const consoleWarn = mock(() => undefined);
    console.warn = consoleWarn;
    const setZoomFactor = mock(async () => {
      throw new Error("Expected zoom factor to be a finite number greater than zero");
    });
    window.orkestrator = {
      window: {
        startDragging: async () => undefined,
        setZoomFactor,
      },
    } as unknown as Window["orkestrator"];

    try {
      render(<App />);

      await waitFor(() => {
        expect(setZoomFactor).toHaveBeenCalledWith(1);
        expect(document.documentElement.style.zoom).toBe("100%");
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        "[App] Failed to apply native zoom; using CSS fallback:",
        expect.any(Error),
      );
    } finally {
      console.warn = originalConsoleWarn;
      window.orkestrator = originalOrkestrator;
    }
  });

  test("handles every zoom shortcut and throttles alternate credential errors", async () => {
    resetStores({ environments: [], selectedProjectId: null, selectedEnvironmentId: null });
    render(<App />);

    await waitFor(() => expect(appEventCallbacks.has("menu-zoom")).toBe(true));

    act(() => appEventCallbacks.get("menu-zoom")?.({ payload: "out" }));
    expect(useUIStore.getState().zoomLevel).toBe(90);

    const keydown = (key: string, modifiers: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, ...modifiers });
      window.dispatchEvent(event);
      return event;
    };

    act(() => {
      expect(keydown("=", { metaKey: true }).defaultPrevented).toBe(true);
      expect(keydown("+", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(keydown("-", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(keydown("0", { metaKey: true }).defaultPrevented).toBe(true);
      expect(keydown("=", { metaKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
      expect(keydown("=", { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
      expect(keydown("=", {}).defaultPrevented).toBe(false);
    });
    expect(useUIStore.getState().zoomLevel).toBe(100);

    act(() => {
      appEventCallbacks.get("claude-credentials-error")?.({
        payload: { kind: "push_failed", message: "Unable to sync credentials" },
      });
      appEventCallbacks.get("claude-credentials-error")?.({
        payload: { kind: "push_failed", message: "Duplicate" },
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to sync Claude credentials",
      expect.objectContaining({ description: "Unable to sync credentials" }),
    );
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

  test("blocks container start and create-script actions while Docker is unavailable", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();

    act(() => {
      screen.getByTestId("start-env-visible").click();
      screen.getByTestId("create-script-env-visible").click();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartEnvironment).not.toHaveBeenCalled();
    expect(useClaudeOptionsStore.getState().getOptions("env-visible")).toBeUndefined();
  });

  test("still starts a local environment while Docker is unavailable", async () => {
    mockCheckDocker.mockImplementation(async () => false);
    resetStores({
      environments: [{
        ...makeEnvironment("env-local", "project-1"),
        environmentType: "local",
        containerId: null,
        status: "stopped",
      }],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-local",
    });

    render(<App />);
    expect(await screen.findByText("Docker Is Not Running")).toBeTruthy();
    act(() => screen.getByTestId("start-env-local").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith("env-local", undefined);
    });
  });

  test("an explicit overlay prompt takes precedence over the stored prompt", async () => {
    resetStores({
      environments: [{
        ...makeEnvironment("env-visible", "project-1"),
        initialPrompt: "Stored prompt",
      }],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);
    act(() => screen.getByTestId("start-prompt-env-visible").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Prompt from terminal",
      );
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
      .toMatchObject({ initialPrompt: "Prompt from terminal" });
  });

  test("rehydrates saved attachments and reconstructs missing preview URLs", async () => {
    const listedEnvironment = {
      ...makeEnvironment("env-visible", "project-1"),
      initialPrompt: "Resume with images",
      hasInitialPromptAttachments: true,
    };
    mockGetEnvironment.mockResolvedValueOnce({
      ...listedEnvironment,
      initialPromptAttachments: [
        {
          id: "saved-image",
          name: "diagram.png",
          base64Data: "QUJD",
        },
        {
          id: "saved-preview",
          name: "existing.png",
          previewUrl: "data:image/webp;base64,REVG",
          base64Data: "REVG",
        },
      ],
    });
    resetStores({
      environments: [listedEnvironment],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);
    act(() => screen.getByTestId("start-env-visible").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Resume with images",
      );
    });
    expect(mockGetEnvironment).toHaveBeenCalledWith("env-visible");
    expect(
      useClaudeOptionsStore.getState().getOptions("env-visible")
        ?.initialPromptAttachments,
    ).toEqual([
      {
        id: "saved-image",
        name: "diagram.png",
        previewUrl: "data:image/png;base64,QUJD",
        base64Data: "QUJD",
      },
      {
        id: "saved-preview",
        name: "existing.png",
        previewUrl: "data:image/webp;base64,REVG",
        base64Data: "REVG",
      },
    ]);
  });

  test("keeps existing launch attachments without replacing them from storage", async () => {
    const listedEnvironment = {
      ...makeEnvironment("env-visible", "project-1"),
      initialPrompt: "Use staged image",
    };
    resetStores({
      environments: [listedEnvironment],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });
    const stagedAttachments = [
      {
        id: "staged-image",
        name: "staged.png",
        previewUrl: "data:image/png;base64,U1RBR0VE",
        base64Data: "U1RBR0VE",
      },
    ];
    useClaudeOptionsStore.getState().setOptions("env-visible", {
      launchAgent: false,
      agentType: "opencode",
      initialPrompt: "",
      initialPromptAttachments: stagedAttachments,
    });

    render(<App />);
    act(() => screen.getByTestId("start-env-visible").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Use staged image",
      );
    });
    expect(mockGetEnvironment).not.toHaveBeenCalled();
    expect(
      useClaudeOptionsStore.getState().getOptions("env-visible")
        ?.initialPromptAttachments,
    ).toEqual(stagedAttachments);
  });

  test("blocks startup when saved attachments cannot be read and allows retry", async () => {
    const environment = {
      ...makeEnvironment("env-visible", "project-1"),
      initialPrompt: "Resume safely",
      hasInitialPromptAttachments: true,
    };
    mockGetEnvironment
      .mockRejectedValueOnce(new Error("detail read failed"))
      .mockResolvedValueOnce(environment);
    resetStores({
      environments: [environment],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const originalConsoleError = console.error;
    console.error = mock(() => {});
    try {
      render(<App />);
      act(() => screen.getByTestId("start-env-visible").click());

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "Could not restore saved prompt attachments",
          {
            description:
              "The environment was not started. Try again to reload its saved prompt.",
          },
        );
      });
      expect(mockStartEnvironment).not.toHaveBeenCalled();
      expect(
        useClaudeOptionsStore.getState().getOptions("env-visible"),
      ).toBeUndefined();

      act(() => screen.getByTestId("start-env-visible").click());
      await waitFor(() => {
        expect(mockStartEnvironment).toHaveBeenCalledWith(
          "env-visible",
          "Resume safely",
        );
      });
      expect(mockGetEnvironment).toHaveBeenCalledTimes(2);
    } finally {
      console.error = originalConsoleError;
    }
  });

  /**
   * The common case: a typed or stored prompt with no images at all. The listed
   * record already says so, so the launch must cost no detail read and must not
   * be blocked by one.
   */
  test("starts without a detail read when the backend reports no attachments", async () => {
    const environment = {
      ...makeEnvironment("env-visible", "project-1"),
      initialPrompt: "Resume without images",
      hasInitialPromptAttachments: false,
    };
    resetStores({
      environments: [environment],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);
    act(() => screen.getByTestId("start-env-visible").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Resume without images",
      );
    });
    expect(mockGetEnvironment).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  /**
   * A backend that predates the flag cannot say either way, so the read still
   * happens — but failing it degrades to the listed record rather than refusing
   * the launch, which is what that backend has always done.
   */
  test("starts anyway when a legacy backend cannot report attachment state", async () => {
    const environment = {
      ...makeEnvironment("env-visible", "project-1"),
      initialPrompt: "Resume on a legacy backend",
    };
    mockGetEnvironment.mockRejectedValueOnce(new Error("detail read failed"));
    resetStores({
      environments: [environment],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    const originalConsoleError = console.error;
    console.error = mock(() => {});
    try {
      render(<App />);
      act(() => screen.getByTestId("start-env-visible").click());

      await waitFor(() => {
        expect(mockStartEnvironment).toHaveBeenCalledWith(
          "env-visible",
          "Resume on a legacy backend",
        );
      });
      expect(mockGetEnvironment).toHaveBeenCalledWith("env-visible");
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
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

  test("create-script overlay retains launch options after successful startup", async () => {
    resetStores({
      environments: [makeEnvironment("env-visible", "project-1")],
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-visible",
    });

    render(<App />);
    act(() => screen.getByTestId("create-script-env-visible").click());

    await waitFor(() => {
      expect(mockStartEnvironment).toHaveBeenCalledWith(
        "env-visible",
        "Create setup script",
      );
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-visible"))
      .toMatchObject({
        launchAgent: true,
        initialPrompt: "Create setup script",
      });
  });
});
