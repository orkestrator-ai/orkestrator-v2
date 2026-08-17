import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext, useState } from "react";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import * as realContextMenu from "@/components/ui/context-menu";
import * as realTooltip from "@/components/ui/tooltip";
import * as realSettings from "@/components/settings";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import * as realDockerComponents from "@/components/docker";
import * as realStores from "@/stores";
import * as realHooks from "@/hooks";
import * as realContexts from "@/contexts";
import * as realBackend from "@/lib/backend";
import * as realKanbanStore from "@/stores/kanbanStore";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { promptQueueKey } from "@/lib/prompt-queue-persistence";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment, PrState, Project } from "@/types";
import type { ActionDefaults } from "@orkestrator/protocol/action-defaults";
import type { KanbanTask } from "@/lib/backend";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../../tests/mocks/sonner";

const realAlertDialogSnapshot = { ...realAlertDialog };
const realContextMenuSnapshot = { ...realContextMenu };
const realTooltipSnapshot = { ...realTooltip };
const realSettingsSnapshot = { ...realSettings };
const realEnvironmentSettingsDialogSnapshot = { ...realEnvironmentSettingsDialog };
const realDockerComponentsSnapshot = { ...realDockerComponents };
const realStoresSnapshot = { ...realStores };
const realHooksSnapshot = { ...realHooks };
const realContextsSnapshot = { ...realContexts };
const realBackendSnapshot = { ...realBackend };
const realKanbanStoreSnapshot = { ...realKanbanStore };

type MergeOutcome = {
  outcome: "merged" | "pending" | "unknown";
  cleanupOutcome: "not-requested" | "pending" | "completed" | "failed";
  cleanupError?: string;
};

const deleteEnvironmentMock = mock(async (_environmentId: string) => {});
const mergeEnvironmentPrMock = mock(async (
  _environmentId: string,
  _method: string,
  _deleteBranch: boolean,
  _cleanupAfterMerge: boolean,
): Promise<MergeOutcome> => ({
  outcome: "merged",
  cleanupOutcome: "not-requested",
}));
const mergePrMock = mock(async (
  _containerId: string,
  _method: string,
  _deleteBranch: boolean,
): Promise<{ outcome: "merged" | "pending" | "unknown" }> => ({ outcome: "merged" }));
const mergePrLocalMock = mock(async (
  _environmentId: string,
  _method: string,
  _deleteBranch: boolean,
): Promise<{ outcome: "merged" | "pending" | "unknown" }> => ({ outcome: "merged" }));
const openInEditorMock = mock(async (_containerId: string, _editor: string) => {});
const openLocalInEditorMock = mock(async (_worktreePath: string, _editor: string) => {});
const readContainerFileMock = mock(async (_containerId: string, _path: string) => ({ content: "{}" }));
const readLocalFileMock = mock(async (_worktreePath: string, _path: string) => ({ content: "{}" }));
// Mirrors `backend.setEnvironmentPr`; keep the parameters in step with it so
// argument assertions here cannot be written against a signature that does not
// exist.
const setEnvironmentPrBackendMock = mock(async (
  _environmentId: string,
  _prUrl: string,
  _prState: PrState,
  _hasMergeConflicts: boolean | null,
) => {});
const setEnvironmentPRStoreMock = mock(() => {});
const createTabMock = mock((_agent: string, _options?: unknown) => true);
// The controller reaches the pane layout store imperatively, so the real store
// action is swapped rather than the module mocked: `@/stores/paneLayoutStore`
// stays real for every other suite.
const clearTabInitialPromptMock = mock((_tabId: string, _environmentId?: string) => {});
const realClearTabInitialPrompt =
  usePaneLayoutStore.getState().clearTabInitialPrompt;
const enqueuePromptQueueMessageMock = mock(async (
  _queueKey: string,
  _environmentId: string,
  _message: unknown,
) => ({}));
const startedLoopedWorkflow = { id: "looped-workflow-1", phase: "preparing" as const };
const cancelledLoopedWorkflow = { id: "looped-workflow-1", phase: "cancelled" as const };
const startLoopedReviewMock = mock(async (_options: unknown) => startedLoopedWorkflow);
const installLoopedWorkflowMock = mock((_workflow: unknown) => {});
const removeLoopedWorkflowMock = mock((_workflowId: string) => {});
const deleteLoopedReviewMock = mock(async (_workflowId: string) => {});
const cancelLoopedReviewMock = mock(async (
  _workflowId: string,
): Promise<{ id: string; phase: string }> => cancelledLoopedWorkflow);
const startedMultiReview = { id: "multi-workflow-1", phase: "reviewing" as const };
const startMultiReviewMock = mock(async (_options: unknown) => startedMultiReview);
const cancelMultiReviewMock = mock(async (
  _workflowId: string,
): Promise<{ id: string; phase: "cancelled" | "cancelling" }> => ({
  id: "multi-workflow-1", phase: "cancelled",
}));
const deleteMultiReviewWorkflowMock = mock(async (_workflowId: string) => {});
const installMultiReviewWorkflowMock = mock((_workflow: unknown) => {});
const removeMultiReviewWorkflowMock = mock((_workflowId: string) => {});
const selectTabMock = mock((_index: number) => {});
const closeActiveTabMock = mock(() => {});
const setProjectBoardTabMock = mock((_tab: string) => {});
const setProjectBoardNotesOpenMock = mock((_open: boolean) => {});
const toggleFilesPanelMock = mock(() => {});
const addCommentMock = mock(async (_taskId: string, _body: string) => {});
const updateTaskMock = mock(async (_taskId: string, _updates: unknown) => {});
const viewPRMock = mock(() => {});
const setModeCreatePendingMock = mock(() => {});
const setModeMergePendingMock = mock(() => {});
const armRefreshAfterAgentCompletionMock = mock(async (): Promise<string | null> => "armed-at-1");
const disarmRefreshAfterAgentCompletionMock = mock(async (_armedAt: string) => {});
const updateProjectMock = mock(async () => {});
const updateEnvironmentMock = mock(() => {});
const recreateEnvironmentMock = mock(async () => {});
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
let writeTextMock: ReturnType<typeof mock>;

const selectedEnvironment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "feature-env",
  branch: "feature/very-long-error",
  containerId: "container-1",
  status: "running",
  prUrl: "https://github.com/org/repo/pull/1",
  prState: "merged",
  hasMergeConflicts: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
};

const selectedProject: Project = {
  id: "project-1",
  name: "repo",
  gitUrl: "git@github.com:org/repo.git",
  localPath: "/tmp/repo",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

let currentEnvironment: Environment = selectedEnvironment;
let currentSelectedEnvironmentId: string | null = selectedEnvironment.id;
let currentClaudeModel = "claude-default-model";
let currentClaudeFastModeDefault = false;
let currentCodexModel = "codex-default-model";
let currentCodexReasoningEffort = "medium";
let currentCodexFastModeDefault = false;
let currentOpenCodeModel = "opencode/default-model";
let currentSelectedProjectId: string | null = selectedProject.id;
/**
 * Environments and projects that exist in the store but are not the current
 * selection. Settings dialogs pin by id and read the store reactively, so a
 * pinned entity has to keep existing in the list independently of selection.
 */
let currentOtherEnvironments: Environment[] = [];
let currentOtherProjects: Project[] = [];
/** Projects removed from the store, to model a deletion while a dialog is open. */
let currentDeletedProjectIds = new Set<string>();
let currentProjectBoardTab: "kanban" | "github" | "linear" | "features" = "kanban";
let currentChanges: unknown[] = [];
let currentFilesPanelOpen = false;
let currentReviewPrompt: string | undefined;
let currentDefaultAgent: "claude" | "opencode" | "codex" | undefined = "codex";
let currentEnabledAgentPlatforms: Array<"claude" | "codex" | "cursor" | "grok" | "opencode"> | undefined;
let currentActionDefaults: ActionDefaults | undefined;
let currentPreferredEditor: "vscode" | "cursor" | undefined = "vscode";
let currentRepositoryConfig: Record<string, { prBaseBranch?: string }> = {
  "project-1": { prBaseBranch: "main" },
};
let currentWorkspaceReady = false;
let currentSetupScriptsRunning = false;
let currentTabCount = 0;
/**
 * Whether a terminal container has registered a tab factory. It is null
 * whenever the environment's terminal is not mounted or ready, which is a
 * distinct condition from having reached the tab limit.
 */
let currentCreateTabRegistered = true;
let currentKanbanNotes = "";
let currentKanbanNotesProjectId: string | null = null;
let currentTaskAssociation: {
  task: Partial<KanbanTask> | undefined;
  taskId: string | undefined;
} = { task: undefined, taskId: undefined };

function selectState<TState, TResult>(
  state: TState,
  selector?: (state: TState) => TResult,
): TResult | TState {
  return selector ? selector(state) : state;
}

function longError(prefix: string) {
  return `${prefix} ${"x".repeat(500)}\n${"y".repeat(500)}`;
}

function findErrorAlert(label: string) {
  return screen.getByText((_content, element) => element?.textContent?.startsWith(label) ?? false);
}

function expectProviderMenuOrder(action: string) {
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((label) => label?.startsWith(`${action} `)),
  ).toEqual([
    `${action} Claude`,
    `${action} Codex`,
    `${action} OpenCode`,
  ]);
}

/**
 * Points the review dialog's one agent/model/reasoning picker at a provider.
 *
 * The menu keeps itself open while the platform rail is browsed and marks the
 * rest of the dialog `aria-hidden` meanwhile, so it has to be dismissed before
 * the launch buttons are reachable again.
 */
function chooseReviewProvider(platform: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: "Agent, model and reasoning" }));
  fireEvent.click(screen.getByRole("button", { name: `${platform} models` }));
  fireEvent.keyDown(document.body, { key: "Escape" });
}

function confirmMerge() {
  fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);
}

function confirmMergeAndCleanup() {
  fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
  fireEvent.click(screen.getByRole("button", { name: "Merge & Cleanup" }));
}

const MockContextMenuState = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

const MockAlertDialogState = createContext<{
  onOpenChange?: (open: boolean) => void;
} | null>(null);

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <MockAlertDialogState.Provider value={{ onOpenChange }}>
        <div data-testid="alert-dialog-root">{children}</div>
      </MockAlertDialogState.Provider>
    ) : null,
  AlertDialogAction: function MockAlertDialogAction({
    children,
    className,
    disabled,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const state = useContext(MockAlertDialogState);
    return (
      <button
        className={className}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          state?.onOpenChange?.(false);
        }}
        type="button"
      >
        {children}
      </button>
    );
  },
  AlertDialogCancel: ({
    children,
    disabled,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const state = useContext(MockAlertDialogState);
    return (
      <button
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          state?.onOpenChange?.(false);
        }}
        type="button"
      >
        {children}
      </button>
    );
  },
  AlertDialogContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div className={className} data-testid="alert-dialog-content">
      {children}
    </div>
  ),
  AlertDialogDescription: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = useState(false);
    return (
      <MockContextMenuState.Provider value={{ open, setOpen }}>
        {children}
      </MockContextMenuState.Provider>
    );
  },
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
    const state = useContext(MockContextMenuState);
    return state?.open ? <>{children}</> : null;
  },
  ContextMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => {
    const state = useContext(MockContextMenuState);
    return (
      <button
        disabled={disabled}
        onClick={() => {
          onClick?.();
          state?.setOpen(false);
        }}
        type="button"
      >
        {children}
      </button>
    );
  },
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => {
    const state = useContext(MockContextMenuState);
    return (
      <span
        onContextMenu={(event) => {
          event.preventDefault();
          state?.setOpen(true);
        }}
      >
        {children}
      </span>
    );
  },
}));

mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module("@/components/settings", () => ({
  RepositorySettings: ({
    onOpenChange,
    onUpdateProject,
    open,
    project,
  }: {
    onOpenChange: (open: boolean) => void;
    onUpdateProject: (project: Project) => Promise<void>;
    open: boolean;
    project: Project;
  }) => open ? (
    <div>
      <span>Repository settings for {project.name}</span>
      <button
        onClick={() => void onUpdateProject({ ...project, name: "updated-repo" })}
        type="button"
      >
        Update mock repository
      </button>
      <button onClick={() => onOpenChange(false)} type="button">
        Close mock repository settings
      </button>
    </div>
  ) : null,
  SettingsPage: ({ open }: { open: boolean }) =>
    open ? <div>Global settings dialog</div> : null,
}));

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: ({
    environment,
    onOpenChange,
    onRestart,
    onUpdate,
    open,
  }: {
    environment: Environment;
    onOpenChange: (open: boolean) => void;
    onRestart: (environmentId: string) => Promise<void>;
    onUpdate: (environment: Environment) => void;
    open: boolean;
  }) => open ? (
    <div>
      <span>Environment settings for {environment.name}</span>
      <button onClick={() => onUpdate({ ...environment, name: "updated-env" })} type="button">
        Update mock environment
      </button>
      <button onClick={() => void onRestart(environment.id)} type="button">
        Restart mock environment
      </button>
      <button onClick={() => onOpenChange(false)} type="button">
        Close mock environment settings
      </button>
    </div>
  ) : null,
}));

mock.module("@/components/docker", () => ({
  DockerStatsDialog: ({ open }: { open: boolean }) =>
    open ? <div>Docker configuration dialog</div> : null,
}));

mock.module("@/stores", () => ({
  useConfigStore: <T,>(selector?: (state: {
    config: {
      global: {
        defaultAgent?: "claude" | "opencode" | "codex";
        preferredEditor?: "vscode" | "cursor";
        reviewInstruction?: string;
        claudeModel?: string;
        claudeNativeFastModeDefault?: boolean;
        codexModel: string;
        codexReasoningEffort: string;
        codexNativeFastModeDefault?: boolean;
        opencodeModel: string;
        enabledAgentPlatforms?: Array<"claude" | "codex" | "cursor" | "grok" | "opencode">;
        actionDefaults?: ActionDefaults;
      };
      repositories: Record<string, { prBaseBranch?: string }>;
    };
  }) => T) =>
    selectState(
      {
        config: {
          global: {
            defaultAgent: currentDefaultAgent,
            preferredEditor: currentPreferredEditor,
            reviewInstruction: currentReviewPrompt,
            claudeModel: currentClaudeModel,
            claudeNativeFastModeDefault: currentClaudeFastModeDefault,
            codexModel: currentCodexModel,
            codexReasoningEffort: currentCodexReasoningEffort,
            codexNativeFastModeDefault: currentCodexFastModeDefault,
            opencodeModel: currentOpenCodeModel,
            enabledAgentPlatforms: currentEnabledAgentPlatforms,
            actionDefaults: currentActionDefaults,
          },
          repositories: currentRepositoryConfig,
        },
      },
      selector,
    ),
  useEnvironmentStore: <T,>(selector?: (state: {
    environments: Environment[];
    getEnvironmentById: (environmentId: string) => Environment | undefined;
    updateEnvironment: (environmentId: string, environment: Environment) => void;
    setEnvironmentPR: () => void;
  }) => T) =>
    selectState(
      {
        environments: [
          ...(currentSelectedEnvironmentId ? [currentEnvironment] : []),
          ...currentOtherEnvironments,
        ].map((environment) => environment.id === currentEnvironment.id
          ? {
              ...environment,
              setupPhase: (currentSetupScriptsRunning
                ? "running"
                : currentWorkspaceReady
                  ? "ready"
                  : "pending") as Environment["setupPhase"],
            }
          : environment),
        getEnvironmentById: (environmentId: string) =>
          environmentId === currentEnvironment.id
            ? {
                ...currentEnvironment,
                setupPhase: (currentSetupScriptsRunning
                  ? "running"
                  : currentWorkspaceReady
                    ? "ready"
                    : "pending") as Environment["setupPhase"],
              }
            : undefined,
        updateEnvironment: updateEnvironmentMock,
        setEnvironmentPR: setEnvironmentPRStoreMock,
      },
      selector,
    ),
  useFilesPanelStore: <T,>(selector?: (state: {
    isOpen: boolean;
    togglePanel: () => void;
    changes: unknown[];
  }) => T) =>
    selectState(
      {
        isOpen: currentFilesPanelOpen,
        togglePanel: toggleFilesPanelMock,
        changes: currentChanges,
      },
      selector,
    ),
  useProjectStore: <T,>(selector?: (state: {
    projects: Project[];
    getProjectById: (projectId: string) => Project | undefined;
  }) => T) =>
    selectState(
      {
        projects: [...currentOtherProjects, selectedProject].filter(
          (project) => !currentDeletedProjectIds.has(project.id),
        ),
        getProjectById: (projectId: string) =>
          projectId === selectedProject.id
            && !currentDeletedProjectIds.has(projectId)
            ? selectedProject
            : currentOtherProjects.find((project) => project.id === projectId),
      },
      selector,
    ),
  useUIStore: <T,>(selector?: (state: {
    selectedEnvironmentId: string | null;
    selectedProjectId: string | null;
    projectBoardTab: "kanban" | "linear" | "github" | "features";
    setProjectBoardTab: (tab: "kanban" | "linear" | "github" | "features") => void;
    setProjectBoardNotesOpen: (open: boolean) => void;
  }) => T) =>
    selectState(
      {
        selectedEnvironmentId: currentSelectedEnvironmentId,
        selectedProjectId: currentSelectedProjectId,
        projectBoardTab: currentProjectBoardTab,
        setProjectBoardTab: setProjectBoardTabMock,
        setProjectBoardNotesOpen: setProjectBoardNotesOpenMock,
      },
      selector,
    ),
  useLoopedReviewStore: <T,>(selector: (state: {
    replaceWorkflow: typeof installLoopedWorkflowMock;
    removeWorkflow: typeof removeLoopedWorkflowMock;
  }) => T) => selector({
    replaceWorkflow: installLoopedWorkflowMock,
    removeWorkflow: removeLoopedWorkflowMock,
  }),
  useMultiReviewStore: {
    getState: () => ({
      replaceWorkflow: installMultiReviewWorkflowMock,
      removeWorkflow: removeMultiReviewWorkflowMock,
    }),
  },
}));

mock.module("@/hooks", () => ({
  useEnvironments: () => ({
    deleteEnvironment: deleteEnvironmentMock,
  }),
  useProjects: () => ({
    updateProject: updateProjectMock,
  }),
  usePullRequest: () => ({
    prUrl: currentEnvironment.prUrl,
    prState: currentEnvironment.prState,
    hasMergeConflicts: currentEnvironment.hasMergeConflicts,
    viewPR: viewPRMock,
    setModeCreatePending: setModeCreatePendingMock,
    setModeMergePending: setModeMergePendingMock,
    armRefreshAfterAgentCompletion: armRefreshAfterAgentCompletionMock,
    disarmRefreshAfterAgentCompletion: disarmRefreshAfterAgentCompletionMock,
  }),
}));

mock.module("@/contexts", () => ({
  MAX_TABS: 10,
  useTerminalContext: () => ({
    closeActiveTab: closeActiveTabMock,
    createTab: currentCreateTabRegistered ? createTabMock : null,
    selectTab: selectTabMock,
    tabCount: currentTabCount,
  }),
}));

mock.module("@/lib/backend", () => ({
  mergeEnvironmentPr: mergeEnvironmentPrMock,
  mergePr: mergePrMock,
  mergePrLocal: mergePrLocalMock,
  openInEditor: openInEditorMock,
  openLocalInEditor: openLocalInEditorMock,
  readContainerFile: readContainerFileMock,
  readLocalFile: readLocalFileMock,
  recreateEnvironment: recreateEnvironmentMock,
  setEnvironmentPr: setEnvironmentPrBackendMock,
  startLoopedReview: startLoopedReviewMock,
  cancelLoopedReview: cancelLoopedReviewMock,
  deleteLoopedReviewWorkflow: deleteLoopedReviewMock,
  startMultiReview: startMultiReviewMock,
  cancelMultiReview: cancelMultiReviewMock,
  deleteMultiReviewWorkflow: deleteMultiReviewWorkflowMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
}));

mock.module("@/stores/kanbanStore", () => ({
  useKanbanStore: {
    getState: () => ({
      addComment: addCommentMock,
      currentNotesProjectId: currentKanbanNotesProjectId,
      notes: currentKanbanNotes,
      updateTask: updateTaskMock,
    }),
  },
  findTaskForEnvironment: () => currentTaskAssociation,
}));

const { ActionBar } = await import("./ActionBar");

afterAll(() => {
  mock.module("@/components/ui/alert-dialog", () => realAlertDialogSnapshot);
  mock.module("@/components/ui/context-menu", () => realContextMenuSnapshot);
  mock.module("@/components/ui/tooltip", () => realTooltipSnapshot);
  mock.module("@/components/settings", () => realSettingsSnapshot);
  mock.module("@/components/environments/EnvironmentSettingsDialog", () => realEnvironmentSettingsDialogSnapshot);
  mock.module("@/components/docker", () => realDockerComponentsSnapshot);
  mock.module("@/stores", () => realStoresSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/stores/kanbanStore", () => realKanbanStoreSnapshot);
  usePaneLayoutStore.setState({
    clearTabInitialPrompt: realClearTabInitialPrompt,
  });
});

beforeEach(() => {
  cleanup();
  console.error = mock(() => {}) as typeof console.error;
  console.log = mock(() => {}) as typeof console.log;
  console.warn = mock(() => {}) as typeof console.warn;
  deleteEnvironmentMock.mockReset();
  mergeEnvironmentPrMock.mockReset();
  mergePrMock.mockReset();
  mergePrLocalMock.mockReset();
  openInEditorMock.mockReset();
  openLocalInEditorMock.mockReset();
  readContainerFileMock.mockReset();
  readLocalFileMock.mockReset();
  setEnvironmentPrBackendMock.mockReset();
  setEnvironmentPRStoreMock.mockReset();
  createTabMock.mockReset();
  createTabMock.mockImplementation(() => true);
  enqueuePromptQueueMessageMock.mockReset();
  enqueuePromptQueueMessageMock.mockImplementation(async () => ({}));
  clearTabInitialPromptMock.mockReset();
  usePaneLayoutStore.setState({
    clearTabInitialPrompt: clearTabInitialPromptMock,
  });
  startLoopedReviewMock.mockReset();
  startLoopedReviewMock.mockImplementation(async () => startedLoopedWorkflow);
  installLoopedWorkflowMock.mockReset();
  removeLoopedWorkflowMock.mockReset();
  deleteLoopedReviewMock.mockReset();
  deleteLoopedReviewMock.mockImplementation(async () => {});
  cancelLoopedReviewMock.mockReset();
  cancelLoopedReviewMock.mockImplementation(async () => cancelledLoopedWorkflow);
  startMultiReviewMock.mockReset();
  startMultiReviewMock.mockImplementation(async () => startedMultiReview);
  cancelMultiReviewMock.mockReset();
  cancelMultiReviewMock.mockImplementation(async () => ({
    id: "multi-workflow-1", phase: "cancelled" as const,
  }));
  deleteMultiReviewWorkflowMock.mockReset();
  deleteMultiReviewWorkflowMock.mockImplementation(async () => {});
  installMultiReviewWorkflowMock.mockReset();
  removeMultiReviewWorkflowMock.mockReset();
  selectTabMock.mockReset();
  closeActiveTabMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  setProjectBoardTabMock.mockReset();
  setProjectBoardNotesOpenMock.mockReset();
  toggleFilesPanelMock.mockReset();
  addCommentMock.mockReset();
  updateTaskMock.mockReset();
  viewPRMock.mockReset();
  setModeCreatePendingMock.mockReset();
  setModeMergePendingMock.mockReset();
  armRefreshAfterAgentCompletionMock.mockReset();
  armRefreshAfterAgentCompletionMock.mockImplementation(async () => "armed-at-1");
  disarmRefreshAfterAgentCompletionMock.mockReset();
  disarmRefreshAfterAgentCompletionMock.mockImplementation(async () => {});
  updateProjectMock.mockReset();
  updateEnvironmentMock.mockReset();
  recreateEnvironmentMock.mockReset();
  mergeEnvironmentPrMock.mockImplementation(async (
    _environmentId,
    _method,
    _deleteBranch,
    cleanupAfterMerge,
  ) => ({
    outcome: "merged",
    cleanupOutcome: cleanupAfterMerge ? "completed" : "not-requested",
  }));
  mergePrMock.mockImplementation(async () => ({ outcome: "merged" }));
  mergePrLocalMock.mockImplementation(async () => ({ outcome: "merged" }));
  openInEditorMock.mockImplementation(async () => {});
  openLocalInEditorMock.mockImplementation(async () => {});
  readContainerFileMock.mockImplementation(async () => ({ content: "{}" }));
  readLocalFileMock.mockImplementation(async () => ({ content: "{}" }));
  setEnvironmentPrBackendMock.mockImplementation(async () => {});
  addCommentMock.mockImplementation(async () => {});
  updateTaskMock.mockImplementation(async () => {});
  writeTextMock = mock(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
  currentEnvironment = { ...selectedEnvironment };
  currentSelectedEnvironmentId = currentEnvironment.id;
  currentSelectedProjectId = selectedProject.id;
  currentOtherEnvironments = [];
  currentOtherProjects = [];
  currentDeletedProjectIds = new Set<string>();
  currentProjectBoardTab = "kanban";
  currentChanges = [];
  currentFilesPanelOpen = false;
  currentReviewPrompt = undefined;
  currentDefaultAgent = "codex";
  currentEnabledAgentPlatforms = undefined;
  currentActionDefaults = undefined;
  currentClaudeModel = "claude-default-model";
  currentClaudeFastModeDefault = false;
  currentCodexModel = "codex-default-model";
  currentCodexReasoningEffort = "medium";
  currentCodexFastModeDefault = false;
  currentOpenCodeModel = "opencode/default-model";
  currentPreferredEditor = "vscode";
  currentRepositoryConfig = { "project-1": { prBaseBranch: "main" } };
  currentWorkspaceReady = false;
  currentSetupScriptsRunning = false;
  currentTabCount = 0;
  currentCreateTabRegistered = true;
  currentKanbanNotes = "";
  currentKanbanNotesProjectId = null;
  currentTaskAssociation = { task: undefined, taskId: undefined };
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
});

describe("ActionBar grid presentation", () => {
  test("does not show tooltips when mobile toolbar controls receive focus", async () => {
    render(<ActionBar presentation="grid" />);

    fireEvent.focus(screen.getByRole("button", { name: "Docker configuration" }));
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(screen.queryByText("Docker configuration") === null).toBe(true);
  });

  test("does not show regular or context-menu tooltips on mobile pointer hover", async () => {
    render(<ActionBar presentation="grid" />);

    const dockerButton = screen.getByRole("button", { name: "Docker configuration" });
    const nativeButton = screen.getByRole("button", { name: "New native agent tab" });
    fireEvent.mouseEnter(dockerButton.parentElement!);
    fireEvent.mouseEnter(nativeButton);
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(screen.queryByText("Docker configuration") === null).toBe(true);
    expect(screen.queryByText("New Native Agent Tab") === null).toBe(true);
  });

  test("keeps context-menu tooltips enabled on desktop hover", async () => {
    render(<ActionBar />);

    const nativeButton = screen.getByRole("button", { name: "New native agent tab" });
    fireEvent.mouseEnter(nativeButton);

    const tooltipTitle = await waitFor(() =>
      screen.getByText("New Native Agent Tab"),
    );

    fireEvent.mouseLeave(nativeButton);
    fireEvent.mouseLeave(tooltipTitle.parentElement!);
    await waitFor(() => {
      expect(screen.queryByText("New Native Agent Tab") === null).toBe(true);
    }, { timeout: 10_000 });
  }, 20_000);

  test("keeps context-menu tooltips enabled on desktop keyboard focus", async () => {
    render(<ActionBar />);

    const nativeButton = screen.getByRole("button", { name: "New native agent tab" });
    fireEvent.focus(nativeButton);
    expect(screen.getByText("New Native Agent Tab")).toBeTruthy();

    fireEvent.blur(nativeButton);
    await waitFor(() => {
      expect(screen.queryByText("New Native Agent Tab") === null).toBe(true);
    }, { timeout: 10_000 });
  // Radix closes the portalled tooltip on a timer. Under the repository's
  // concurrent workspace run this file shares a saturated runner with the web
  // build and can exceed Bun's default 10s test ceiling despite passing in
  // about a second alone.
  }, 20_000);

  test("renders mobile tools as two columns with labels after their icons", () => {
    const { container } = render(<ActionBar presentation="grid" />);

    const toolbar = container.querySelector("[data-presentation='grid']");
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelectorAll(".grid-cols-2").length).toBeGreaterThanOrEqual(2);

    const globalSettings = screen.getByRole("button", { name: "Global settings" });
    const native = screen.getByRole("button", { name: "New native agent tab" });
    expect(globalSettings.lastElementChild?.textContent).toBe("Global settings");
    expect(native.lastElementChild?.textContent).toBe("New agent");
    expect(screen.getByRole("button", { name: "New terminal tab" }).lastElementChild?.textContent)
      .toBe("New terminal");
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
        .filter((label) => label?.startsWith("New tab with ")),
    ).toEqual([]);
  });

  test("keeps project and environment tools visible but disabled in the empty state", () => {
    currentSelectedProjectId = null;
    currentSelectedEnvironmentId = null;
    render(<ActionBar presentation="grid" />);

    expect(screen.getByRole("button", { name: "Global settings" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Repository settings" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "New native agent tab" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "New terminal tab" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Kanban board" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Show file panel" }).hasAttribute("disabled")).toBe(true);
  });

  test("uses one visual variant for every mobile tool and shortens environment settings", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar presentation="grid" />);

    const environmentSettings = screen.getByRole("button", { name: "Environment settings" });
    const createPr = screen.getByRole("button", { name: "Create PR" });
    const projectNotes = screen.getByRole("button", { name: "Project notes" });
    const kanban = screen.getByRole("button", { name: "Kanban board" });

    expect(environmentSettings.textContent).toContain("Env. settings");
    expect(createPr.getAttribute("data-variant")).toBe("ghost");
    expect(projectNotes.getAttribute("data-variant")).toBe("ghost");
    expect(kanban.getAttribute("data-variant")).toBe("ghost");
  });

  test("shows Push Changes as soon as a PR is detected, without waiting for file changes", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: null,
      hasMergeConflicts: null,
    };
    currentChanges = [];
    render(<ActionBar presentation="grid" />);

    fireEvent.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Git Push" }),
    );
  });

  test("keeps Push Changes disabled when the environment cannot launch an agent", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      status: "stopped",
    };
    const view = render(<ActionBar presentation="grid" />);

    expect(
      (screen.getByRole("button", { name: "Push Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    currentEnvironment = {
      ...currentEnvironment,
      status: "running",
    };
    currentTabCount = 10;
    view.rerender(<ActionBar presentation="grid" />);

    expect(
      (screen.getByRole("button", { name: "Push Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("places the mobile file-change dot inline after the Show files label", () => {
    currentChanges = [{}];
    render(<ActionBar presentation="grid" />);

    const showFiles = screen.getByRole("button", { name: "Show file panel" });
    const labelGroup = showFiles.querySelector("span.flex");
    const label = labelGroup?.firstElementChild;
    const dot = labelGroup?.lastElementChild;

    expect(label?.textContent).toBe("Show files");
    expect(dot?.classList.contains("rounded-full")).toBe(true);
    expect(dot?.classList.contains("absolute")).toBe(false);
  });

  test("dispatches mobile project-board actions", () => {
    currentSelectedEnvironmentId = null;
    render(<ActionBar presentation="grid" />);

    fireEvent.click(screen.getByRole("button", { name: "Project notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Kanban board" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));
    fireEvent.click(screen.getByRole("button", { name: "Linear pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: "Features" }));

    expect(setProjectBoardNotesOpenMock).toHaveBeenCalledWith(true);
    expect(setProjectBoardTabMock.mock.calls.map(([tab]) => tab)).toEqual([
      "kanban",
      "github",
      "linear",
      "features",
    ]);
  });

  test("uses an accent state for the selected mobile board control", () => {
    currentSelectedEnvironmentId = null;
    currentProjectBoardTab = "linear";
    render(<ActionBar presentation="grid" />);

    const linear = screen.getByRole("button", { name: "Linear pipeline" });
    const kanban = screen.getByRole("button", { name: "Kanban board" });
    expect(linear.getAttribute("aria-pressed")).toBe("true");
    expect(linear.className).toContain("bg-primary/15");
    expect(kanban.getAttribute("aria-pressed")).toBe("false");
  });

  test("toggles the file panel from the mobile grid", () => {
    render(<ActionBar presentation="grid" />);

    fireEvent.click(screen.getByRole("button", { name: "Show file panel" }));

    expect(toggleFilesPanelMock).toHaveBeenCalledTimes(1);
  });

  test("uses an accent state when the file panel is selected", () => {
    currentFilesPanelOpen = true;
    render(<ActionBar presentation="grid" />);

    const hideFiles = screen.getByRole("button", { name: "Hide file panel" });
    expect(hideFiles.getAttribute("aria-pressed")).toBe("true");
    expect(hideFiles.className).toContain("bg-primary/15");
  });
});

describe("ActionBar copy URL", () => {
  test("copies the selected environment port address from the toolbar button", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(writeTextMock).toHaveBeenCalledWith("localhost:49152");
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Copied URL", {
        description: "localhost:49152",
      });
    });
  });

  test("shows the mapped address and Ctrl+Shift+C shortcut in the tooltip", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Copy URL" }).parentElement!);

    await waitFor(() => {
      expect(screen.getByText("localhost:49152")).toBeTruthy();
      expect(screen.getByText("Ctrl⇧C")).toBeTruthy();
    });
  });

  test("copies the selected environment port address with Ctrl+Shift+C", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });

    expect(writeTextMock).toHaveBeenCalledWith("localhost:49152");
  });

  test("ignores Ctrl+Shift+C from editable fields and terminal content", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    const { container } = render(
      <>
        <input aria-label="Message" />
        <textarea aria-label="Description" />
        <select aria-label="Agent"><option>Claude</option></select>
        <div aria-label="Editable content" contentEditable />
        <div contentEditable><span aria-label="Nested editable content">Nested</span></div>
        <div className="xterm" tabIndex={0} />
        <ActionBar />
      </>,
    );

    const directlyEditable = screen.getByLabelText("Editable content");
    Object.defineProperty(directlyEditable, "isContentEditable", {
      configurable: true,
      value: true,
    });

    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByLabelText("Description"), {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByLabelText("Agent"), {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(directlyEditable, {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByLabelText("Nested editable content"), {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(container.querySelector(".xterm")!, {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  test("does not copy the port address with extra modifiers", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);

    fireEvent.keyDown(window, {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  test("shows an error toast when copying the port address fails", async () => {
    writeTextMock.mockImplementationOnce(async () => {
      throw new Error("clipboard denied");
    });
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(writeTextMock).toHaveBeenCalledWith("localhost:49152");
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy URL");
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("disables the toolbar button and ignores Ctrl+Shift+C when no port address is visible", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: undefined,
    };

    render(<ActionBar />);

    const copyButton = screen.getByRole("button", { name: "No mapped URL" }) as HTMLButtonElement;
    expect(copyButton.disabled).toBe(true);
    fireEvent.mouseEnter(copyButton.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("No mapped URL")).toBeTruthy();
      expect(screen.queryByText("Ctrl⇧C") === null).toBe(true);
    });

    fireEvent.keyDown(window, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });

    expect(writeTextMock).not.toHaveBeenCalled();
  });
});

describe("ActionBar browser tabs", () => {
  test("opens a browser tab at the selected environment's mapped backend port", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      entryPort: 3000,
      hostEntryPort: 49152,
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));

    expect(createTabMock).toHaveBeenCalledWith("browser", {
      initialUrl: "http://localhost:49152/",
    });
  });

  test("opens an empty browser tab when the environment has no mapped port", () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));

    expect(createTabMock).toHaveBeenCalledWith("browser", { initialUrl: undefined });
  });

  test("keeps the browser tab button visible but disabled without an environment", () => {
    currentSelectedEnvironmentId = null;
    render(<ActionBar presentation="grid" />);

    const button = screen.getByRole("button", { name: "New browser tab" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("disables browser previews in the non-desktop web client", () => {
    window.orkestratorGateway = { enabled: true };
    try {
      render(<ActionBar />);
      const button = screen.getByRole("button", { name: "New browser tab" });
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
      expect(createTabMock).not.toHaveBeenCalled();
    } finally {
      delete window.orkestratorGateway;
    }
  });
});

describe("ActionBar editor and run commands", () => {
  test("opens container and local environments in the configured editor", async () => {
    const { rerender } = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => {
      expect(openInEditorMock).toHaveBeenCalledWith("container-1", "vscode");
    });

    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/feature-env",
    };
    rerender(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => {
      expect(openLocalInEditorMock).toHaveBeenCalledWith("/tmp/feature-env", "vscode");
    });
  });

  test("reports editor launch failures and clears the dialog", async () => {
    openInEditorMock.mockRejectedValueOnce(new Error("editor unavailable"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));

    expect(await screen.findByText("Failed to Open Editor")).toBeTruthy();
    expect(screen.getByText("editor unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText("Failed to Open Editor") === null).toBe(true);
  });

  test("reports non-Error editor launch rejections", async () => {
    openInEditorMock.mockRejectedValueOnce("editor backend unavailable");
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));

    expect(await screen.findByText("Failed to Open Editor")).toBeTruthy();
    expect(screen.getByText("editor backend unavailable")).toBeTruthy();
  });

  test("loads and runs container commands from orkestrator-ai.json", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({ run: ["bun test", "bun run build"] }),
    }));
    render(<ActionBar />);

    await waitFor(() => {
      expect(readContainerFileMock).toHaveBeenCalledWith("container-1", "orkestrator-ai.json");
      expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("false");
    });
    fireEvent.click(screen.getByRole("button", { name: "Run commands" }));

    expect(createTabMock).toHaveBeenCalledWith("plain", {
      initialCommands: ["bun test", "bun run build"],
    });
  });

  test("loads run commands from a local worktree", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/feature-env",
    };
    currentWorkspaceReady = true;
    readLocalFileMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({ run: ["bun test"] }),
    }));
    render(<ActionBar />);

    await waitFor(() => {
      expect(readLocalFileMock).toHaveBeenCalledWith("/tmp/feature-env", "orkestrator-ai.json");
      expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("false");
    });
  });

  test("keeps run commands disabled for malformed configuration and read failures", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockImplementationOnce(async () => ({ content: "not json" }));
    const { unmount } = render(<ActionBar />);

    await waitFor(() => {
      expect(readContainerFileMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Run commands" }));
    expect(createTabMock).not.toHaveBeenCalled();
    unmount();

    readContainerFileMock.mockRejectedValueOnce(new Error("read failed"));
    render(<ActionBar />);
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        "[ActionBar] Failed to read orkestrator-ai.json:",
        expect.any(Error),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Run commands" }));
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("keeps run commands disabled when valid configuration has no commands", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({ run: [] }),
    }));
    render(<ActionBar />);

    await waitFor(() => {
      expect(readContainerFileMock).toHaveBeenCalledTimes(1);
    });
    const runButton = screen.getByRole("button", { name: "Run commands" });
    expect(runButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(runButton);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("creates agent-authored run scripts with every context-menu provider", () => {
    render(<ActionBar />);

    const runButton = screen.getByRole("button", { name: "Run commands" });
    fireEvent.contextMenu(runButton);
    expectProviderMenuOrder("Create Script with");

    for (const [label, agent] of [
      ["Claude", "claude"],
      ["Codex", "codex"],
      ["OpenCode", "opencode"],
    ] as const) {
      fireEvent.contextMenu(runButton);
      fireEvent.click(screen.getByRole("button", { name: `Create Script with ${label}` }));
      expect(createTabMock).toHaveBeenLastCalledWith(agent, {
        initialPrompt: expect.any(String),
      });
    }
  });
});

describe("ActionBar toolbar interactions", () => {
  test("opens global, Docker, repository, and environment settings", async () => {
    const asyncDialogOptions = { timeout: 10_000 };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Global settings" }));
    expect(
      screen.getByRole("status", { name: "Loading global settings…" }),
    ).toBeTruthy();
    expect(
      await screen.findByText("Global settings dialog", undefined, asyncDialogOptions),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Docker configuration" }));
    expect(
      await screen.findByText("Docker configuration dialog", undefined, asyncDialogOptions),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(
      await screen.findByText("Repository settings for repo", undefined, asyncDialogOptions),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update mock repository" }));
    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledWith({
      ...selectedProject,
      name: "updated-repo",
    }), asyncDialogOptions);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(
      await screen.findByText(
        "Environment settings for feature-env",
        undefined,
        asyncDialogOptions,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update mock environment" }));
    expect(updateEnvironmentMock).toHaveBeenCalledWith(
      "env-1",
      expect.objectContaining({ id: "env-1", name: "updated-env" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart mock environment" }));
    await waitFor(
      () => expect(recreateEnvironmentMock).toHaveBeenCalledWith("env-1"),
      asyncDialogOptions,
    );
  }, 60_000);

  test("closes Docker configuration and preserves local controls when Docker stops", async () => {
    const renderActionBar = (available: boolean) => (
      <DockerAvailabilityProvider available={available}>
        <ActionBar />
      </DockerAvailabilityProvider>
    );
    const view = render(renderActionBar(true));

    fireEvent.click(screen.getByRole("button", { name: "Docker configuration" }));
    expect(await screen.findByText("Docker configuration dialog")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Open in VS Code" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    view.rerender(renderActionBar(false));

    expect(screen.queryByText("Docker configuration dialog") === null).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Docker configuration" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Open in VS Code" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/feature-env",
    };
    view.rerender(renderActionBar(false));

    const localEditorButton = screen.getByRole("button", { name: "Open in VS Code" });
    expect((localEditorButton as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Environment settings" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(localEditorButton);
    await waitFor(() => {
      expect(openLocalInEditorMock).toHaveBeenCalledWith("/tmp/feature-env", "vscode");
    });
    expect(openInEditorMock).not.toHaveBeenCalled();
  });

  test("dismisses repository and environment settings through onOpenChange", async () => {
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(await screen.findByText("Repository settings for repo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close mock repository settings" }));
    expect(screen.queryByText("Repository settings for repo") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(await screen.findByText("Environment settings for feature-env")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close mock environment settings" }));
    expect(screen.queryByText("Environment settings for feature-env") === null).toBe(true);
  });

  test("keeps environment settings pinned to the environment that opened them", async () => {
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(
      await screen.findByText("Environment settings for feature-env"),
    ).toBeTruthy();

    // The pinned environment still exists; only the selection moved on.
    currentOtherEnvironments = [{ ...selectedEnvironment }];
    currentEnvironment = {
      ...selectedEnvironment,
      id: "env-2",
      name: "second-env",
    };
    currentSelectedEnvironmentId = currentEnvironment.id;
    view.rerender(<ActionBar />);

    expect(screen.getByText("Environment settings for feature-env")).toBeTruthy();
    expect(screen.queryByText("Environment settings for second-env") === null).toBe(true);
  });

  test("reflects a background update to a pinned environment that is no longer selected", async () => {
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(
      await screen.findByText("Environment settings for feature-env"),
    ).toBeTruthy();

    currentOtherEnvironments = [{ ...selectedEnvironment }];
    currentEnvironment = { ...selectedEnvironment, id: "env-2", name: "second-env" };
    currentSelectedEnvironmentId = currentEnvironment.id;
    view.rerender(<ActionBar />);

    // The pin resolves through the store on every render, so a background sync
    // that renames the pinned environment must reach the open dialog.
    currentOtherEnvironments = [{ ...selectedEnvironment, name: "renamed-by-sync" }];
    view.rerender(<ActionBar />);

    expect(screen.getByText("Environment settings for renamed-by-sync")).toBeTruthy();
    expect(screen.queryByText("Environment settings for feature-env") === null).toBe(true);
  });

  test("closes environment settings when the pinned environment is deleted", async () => {
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(
      await screen.findByText("Environment settings for feature-env"),
    ).toBeTruthy();

    // Deleted from the store. Keeping a stale snapshot open would let the user
    // edit an environment that no longer exists, and updateEnvironment would
    // discard the edit without reporting anything.
    currentOtherEnvironments = [];
    currentSelectedEnvironmentId = null;
    view.rerender(<ActionBar />);

    await waitFor(() => {
      expect(screen.queryByText("Environment settings for feature-env") === null).toBe(true);
    });
    expect(updateEnvironmentMock).not.toHaveBeenCalled();
  });

  test("forwards environment settings updates to the store", async () => {
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update mock environment" }));

    expect(updateEnvironmentMock).toHaveBeenCalledWith(
      "env-1",
      expect.objectContaining({ id: "env-1", name: "updated-env" }),
    );
  });

  test("keeps repository settings pinned when project selection changes", async () => {
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(
      await screen.findByText("Repository settings for repo"),
    ).toBeTruthy();

    currentSelectedProjectId = "project-2";
    view.rerender(<ActionBar />);

    expect(screen.getByText("Repository settings for repo")).toBeTruthy();
  });

  test("closes repository settings when the pinned project is deleted", async () => {
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(
      await screen.findByText("Repository settings for repo"),
    ).toBeTruthy();

    currentDeletedProjectIds = new Set([selectedProject.id]);
    currentSelectedProjectId = null;
    view.rerender(<ActionBar />);

    await waitFor(() => {
      expect(screen.queryByText("Repository settings for repo") === null).toBe(true);
    });
  });

  test("supports drag scrolling and ends dragging on mouse up or leave", () => {
    const { container } = render(<ActionBar />);
    const toolbar = container.querySelector("[data-presentation='bar']")!;
    const scroller = toolbar.firstElementChild as HTMLDivElement;
    Object.defineProperty(scroller, "offsetLeft", { configurable: true, value: 10 });
    scroller.scrollLeft = 50;

    const mouseDown = createEvent.mouseDown(scroller, { button: 0 });
    Object.defineProperty(mouseDown, "pageX", { configurable: true, value: 110 });
    fireEvent(scroller, mouseDown);
    expect(scroller.className).toContain("cursor-grabbing");
    const mouseMove = createEvent.mouseMove(scroller);
    Object.defineProperty(mouseMove, "pageX", { configurable: true, value: 130 });
    fireEvent(scroller, mouseMove);
    expect(scroller.scrollLeft).toBe(20);

    fireEvent.mouseUp(scroller);
    expect(scroller.className).not.toContain("cursor-grabbing");
    const secondMouseDown = createEvent.mouseDown(scroller, { button: 0 });
    Object.defineProperty(secondMouseDown, "pageX", { configurable: true, value: 110 });
    fireEvent(scroller, secondMouseDown);
    fireEvent.mouseLeave(scroller);
    expect(scroller.className).not.toContain("cursor-grabbing");
  });

  test("suppresses native menus while preserving custom menus and non-HTML targets", () => {
    const { container } = render(<ActionBar presentation="grid" />);
    const globalSettings = screen.getByRole("button", { name: "Global settings" });
    const globalSettingsIcon = globalSettings.querySelector("svg")!;
    const nativeButton = screen.getByRole("button", { name: "New native agent tab" });
    const nativeLabel = Array.from(nativeButton.querySelectorAll("span")).find(
      (element) => element.textContent === "New agent",
    )!;

    expect(fireEvent.contextMenu(globalSettings)).toBe(false);
    expect(fireEvent.contextMenu(globalSettingsIcon)).toBe(true);
    fireEvent.contextMenu(nativeLabel);

    expect(screen.getByRole("button", { name: "Claude Tmux Tab" })).toBeTruthy();
    expect(container.querySelector("[data-mobile-toolbar]")).toBeTruthy();
  });

  test("handles numeric, tab creation, and file-panel shortcuts", () => {
    currentTabCount = 1;
    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "3", code: "Digit3", ctrlKey: true });
    fireEvent.keyDown(window, { key: "4", code: "", ctrlKey: true });
    fireEvent.keyDown(window, { key: "t", code: "KeyT", metaKey: true });
    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true });
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });
    fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true });

    expect(selectTabMock.mock.calls.map(([index]) => index)).toEqual([2, 3]);
    expect(createTabMock).toHaveBeenCalledWith("plain");
    expect(createTabMock).toHaveBeenCalledWith("agent-native");
    expect(createTabMock).not.toHaveBeenCalledWith("claude");
    expect(createTabMock).not.toHaveBeenCalledWith("opencode");
    expect(closeActiveTabMock).not.toHaveBeenCalled();
    expect(toggleFilesPanelMock).toHaveBeenCalledTimes(1);
  });

  test("ignores out-of-range tab selection and disabled panel shortcuts", () => {
    currentSelectedEnvironmentId = null;
    currentTabCount = 0;
    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "0", code: "Digit0", ctrlKey: true });
    fireEvent.keyDown(window, { key: "9", code: "Digit9", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true });

    expect(selectTabMock).not.toHaveBeenCalled();
    expect(closeActiveTabMock).not.toHaveBeenCalled();
    expect(toggleFilesPanelMock).not.toHaveBeenCalled();
  });

  test("opens a neutral native tab without routing removed provider shortcuts", () => {
    currentEnabledAgentPlatforms = ["codex"];
    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true });
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });

    expect(createTabMock).toHaveBeenCalledWith("agent-native");
    expect(createTabMock).not.toHaveBeenCalledWith("claude");
    expect(createTabMock).not.toHaveBeenCalledWith("opencode");
  });

  test("runs commands and opens the editor from keyboard shortcuts", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({ run: ["bun test"] }),
    }));
    render(<ActionBar />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("false");
    });

    fireEvent.keyDown(window, { key: "p", code: "KeyP", metaKey: true });
    fireEvent.keyDown(window, { key: "o", code: "KeyO", metaKey: true });

    expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] });
    await waitFor(() => {
      expect(openInEditorMock).toHaveBeenCalledWith("container-1", "vscode");
    });
  });
});

describe("ActionBar workflow tabs", () => {
  test("does not repeat the selected project name in the environment toolbar", () => {
    render(<ActionBar />);

    expect(screen.queryByText("repo") === null).toBe(true);
    expect(screen.queryByText("Select an environment to get started") === null).toBe(true);
  });

  test("shows the desktop empty-state guidance without a selected project", () => {
    currentSelectedProjectId = null;
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    expect(screen.getByText("Select an environment to get started")).toBeTruthy();
  });

  test("shows project board tabs in the top bar when no environment is selected", () => {
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    expect(screen.queryByText("repo") === null).toBe(true);
    const notesButton = screen.getByRole("button", { name: "Project Notes" });
    const kanbanTab = screen.getByRole("tab", { name: "Kanban" });
    expect(kanbanTab).toBeTruthy();
    expect(screen.getByRole("tab", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Linear" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Features" })).toBeTruthy();
    expect(notesButton.compareDocumentPosition(kanbanTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(notesButton);
    expect(setProjectBoardNotesOpenMock).toHaveBeenCalledWith(true);
  });

  test("selecting a board tab updates the project board tab", () => {
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Features" }), { button: 0 });
    expect(setProjectBoardTabMock).toHaveBeenCalledWith("features");
  });

  test("selecting the Linear board tab updates the project board tab", () => {
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Linear" }), { button: 0 });
    expect(setProjectBoardTabMock).toHaveBeenCalledWith("linear");
  });

  test("selecting the GitHub board tab updates the project board tab", () => {
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "GitHub" }), { button: 0 });
    expect(setProjectBoardTabMock).toHaveBeenCalledWith("github");
  });

  test("selecting the Kanban board tab updates the project board tab", () => {
    currentSelectedEnvironmentId = null;
    currentProjectBoardTab = "features";

    render(<ActionBar />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Kanban" }), { button: 0 });
    expect(setProjectBoardTabMock).toHaveBeenCalledWith("kanban");
  });

  test("marks the active board tab as selected based on projectBoardTab", () => {
    currentSelectedEnvironmentId = null;
    currentProjectBoardTab = "linear";

    render(<ActionBar />);

    const linearTab = screen.getByRole("tab", { name: "Linear" });
    expect(linearTab.getAttribute("aria-selected")).toBe("true");
    expect(linearTab.className).toContain("data-[state=active]:!bg-primary/15");
    expect(screen.getByRole("tab", { name: "Kanban" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Features" }).getAttribute("aria-selected")).toBe("false");
  });

  test("hides the Project Notes button when the active board tab is not kanban", () => {
    currentSelectedEnvironmentId = null;
    currentProjectBoardTab = "features";

    render(<ActionBar />);

    expect(screen.getByRole("tab", { name: "Features" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Project Notes" }) === null).toBe(true);
  });

  test("native and terminal context menus route neutral, tmux, and CLI tabs", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };

    render(<ActionBar />);

    expect(screen.queryByRole("button", { name: "Claude Tmux Tab" }) === null).toBe(true);

    fireEvent.contextMenu(screen.getByRole("button", { name: "New native agent tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Native Tab" }));
    expect(createTabMock).toHaveBeenLastCalledWith("agent-native");

    fireEvent.contextMenu(screen.getByRole("button", { name: "New native agent tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude Tmux Tab" }));
    expect(createTabMock).toHaveBeenLastCalledWith("claude", { agentLaunchMode: "tmux" });

    fireEvent.contextMenu(screen.getByRole("button", { name: "New terminal tab" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode CLI" }));
    expect(createTabMock).toHaveBeenLastCalledWith("opencode", { agentLaunchMode: "cli" });
  });

  test("shows enabled CLI providers on the terminal control and removes legacy provider buttons", () => {
    currentEnabledAgentPlatforms = ["claude", "codex", "cursor", "grok", "opencode"];
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "New native agent tab" }));
    expect(createTabMock).toHaveBeenLastCalledWith("agent-native");
    fireEvent.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(createTabMock).toHaveBeenLastCalledWith("plain");

    fireEvent.contextMenu(screen.getByRole("button", { name: "New terminal tab" }));
    for (const label of ["Claude CLI", "Codex CLI", "OpenCode CLI", "Cursor CLI", "Grok CLI"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Cursor CLI" }));
    expect(createTabMock).toHaveBeenLastCalledWith("cursor", { agentLaunchMode: "cli" });

    fireEvent.contextMenu(screen.getByRole("button", { name: "New terminal tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Grok CLI" }));
    expect(createTabMock).toHaveBeenLastCalledWith("grok", { agentLaunchMode: "cli" });

    for (const legacyLabel of [
      "New tab with Claude",
      "New tab with Codex",
      "New tab with OpenCode",
      "New tab with Cursor Agent",
      "New tab with Grok Build",
    ]) {
      expect(screen.queryByRole("button", { name: legacyLabel }) === null).toBe(true);
    }
  });

  test("filters terminal CLI and Claude Tmux options using enabled providers", () => {
    currentEnabledAgentPlatforms = ["codex"];
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "New native agent tab" }));
    expect(screen.getByRole("button", { name: "Native Tab" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claude Tmux Tab" }) === null).toBe(true);

    fireEvent.contextMenu(screen.getByRole("button", { name: "New terminal tab" }));
    expect(screen.getByRole("button", { name: "Codex CLI" })).toBeTruthy();
    for (const label of ["Claude CLI", "OpenCode CLI", "Cursor CLI", "Grok CLI"]) {
      expect(screen.queryByRole("button", { name: label }) === null).toBe(true);
    }
  });

  test("names review tabs with the workflow title", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };

    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });

    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        displayTitle: "Review",
        isReviewTab: true,
      }),
    );
  });

  test("durably queues the saved review instruction against the created tab", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentReviewPrompt = "Inspect origin/{{targetBranch}}...HEAD for release blockers.";
    currentCodexModel = "gpt-review-default";
    currentCodexReasoningEffort = "xhigh";
    currentCodexFastModeDefault = true;

    render(<ActionBar />);
    fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });

    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as { tabId?: string };
    expect(tabOptions).toMatchObject({
      displayTitle: "Review",
      initialPrompt: expect.stringContaining(
        'User review instruction (JSON string): "Inspect origin/main...HEAD for release blockers."',
      ),
      isReviewTab: true,
    });
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      `codex\u0000env-env-1:${tabOptions.tabId}`,
      "env-1",
      expect.objectContaining({
        id: `initial-prompt:env-1:${tabOptions.tabId}`,
        text: expect.stringContaining(
          'User review instruction (JSON string): "Inspect origin/main...HEAD for release blockers."',
        ),
        model: "gpt-review-default",
        reasoningEffort: "xhigh",
        mode: "build",
        fastMode: true,
      }),
    ));
  });

  test("preserves Claude model and fast-mode defaults in a one-click review", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "claude",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentClaudeModel = "claude-review-default";
    currentClaudeFastModeDefault = true;

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Code review" }));

    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/^claude\u0000env-env-1:tab-/),
      "env-1",
      expect.objectContaining({
        model: "claude-review-default",
        effort: "high",
        planModeEnabled: false,
        fastModeEnabled: true,
      }),
    ));
  });

  test("hands an OpenCode review to the backend before an environment switch", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "opencode",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentOpenCodeModel = "openai/review-default";
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Code review" }));
    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as { tabId?: string };

    currentSelectedEnvironmentId = "env-2";
    currentOtherEnvironments = [{
      ...selectedEnvironment,
      id: "env-2",
      name: "other-environment",
    }];
    view.rerender(<ActionBar />);

    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      `opencode\u0000env-env-1:${tabOptions.tabId}`,
      "env-1",
      expect.objectContaining({
        id: `initial-prompt:env-1:${tabOptions.tabId}`,
        model: "openai/review-default",
        mode: "build",
        text: expect.stringContaining("Security and instruction hierarchy"),
      }),
    ));
  });

  test("hands a Cursor PR to the backend before an environment switch", async () => {
    currentEnabledAgentPlatforms = ["claude", "codex", "cursor", "opencode"];
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "cursor",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    // Hold persistence open across the switch. Letting it resolve first would
    // let this pass without ever leaving env-1, which is the behaviour the test
    // exists to pin.
    let settleEnqueue: (() => void) | undefined;
    enqueuePromptQueueMessageMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        settleEnqueue = () => resolve({});
      }),
    );
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as {
      tabId?: string;
      initialPrompt?: string;
    };
    const tabId = tabOptions.tabId;
    expect(tabId).toMatch(/^tab-/);
    expect(tabOptions).toMatchObject({
      displayTitle: "PR",
      initialPrompt: expect.stringContaining("gh pr create --base main --fill"),
    });
    expect(settleEnqueue).toBeDefined();
    expect(clearTabInitialPromptMock).not.toHaveBeenCalled();

    currentSelectedEnvironmentId = "env-2";
    currentOtherEnvironments = [{
      ...selectedEnvironment,
      id: "env-2",
      name: "other-environment",
    }];
    view.rerender(<ActionBar />);
    // Only now, with env-1 deselected and its ActionBar re-rendered against
    // another environment, does the durable hand-off acknowledge.
    await act(async () => {
      settleEnqueue!();
      await Promise.resolve();
    });

    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      `cursor\u0000env-env-1:${tabId}`,
      "env-1",
      expect.objectContaining({
        id: `initial-prompt:env-1:${tabId}`,
        requestId: `initial-prompt:env-1:${tabId}`,
        text: expect.stringContaining("gh pr create --base main --fill"),
        mode: "build",
      }),
    ));
    // The renderer fallback is dropped against the originating environment, not
    // whichever one happens to be selected when persistence acknowledges.
    await waitFor(() => expect(clearTabInitialPromptMock).toHaveBeenCalledWith(
      tabId,
      "env-1",
    ));
    expect(setModeCreatePendingMock).toHaveBeenCalledTimes(1);
  });

  test("keeps a one-click PR renderer-owned for a non-ACP default agent", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "codex",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as { tabId?: string };
    expect(tabOptions).toMatchObject({
      displayTitle: "PR",
      initialPrompt: expect.stringContaining("gh pr create --base main --fill"),
    });
    // A default-mode Codex launch may still open a CLI tab, which owns no
    // backend session. Pre-allocating an id and queueing against it would
    // dispatch a turn with no tab to render it.
    expect(tabOptions.tabId).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(clearTabInitialPromptMock).not.toHaveBeenCalled();
  });

  test("durably queues a configured Claude PR with its fast-mode default", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "claude",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentClaudeFastModeDefault = true;

    render(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    chooseReviewProvider("claude");
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as { tabId?: string };
    expect(tabOptions).toMatchObject({
      agentLaunchMode: "native",
      displayTitle: "PR",
    });
    expect(tabOptions.tabId).toMatch(/^tab-/);
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      promptQueueKey("claude", `env-env-1:${tabOptions.tabId}`),
      "env-1",
      expect.objectContaining({
        id: `initial-prompt:env-1:${tabOptions.tabId}`,
        requestId: `initial-prompt:env-1:${tabOptions.tabId}`,
        text: expect.stringContaining("gh pr create --base main --fill"),
        // Claude reads `planModeEnabled` for its execution mode and treats an
        // absent field as build, so a PR launch must never arrive in plan mode.
        mode: "build",
        fastMode: true,
      }),
    ));
    await waitFor(() => expect(clearTabInitialPromptMock).toHaveBeenCalledWith(
      tabOptions.tabId,
      "env-1",
    ));
  });

  test("durably queues a configured Codex PR with its fast-mode default", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "codex",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentCodexFastModeDefault = true;

    render(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    chooseReviewProvider("codex");
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    const tabOptions = createTabMock.mock.calls.at(-1)?.[1] as { tabId?: string };
    expect(tabOptions.tabId).toMatch(/^tab-/);
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      promptQueueKey("codex", `env-env-1:${tabOptions.tabId}`),
      "env-1",
      expect.objectContaining({
        id: `initial-prompt:env-1:${tabOptions.tabId}`,
        mode: "build",
        fastMode: true,
      }),
    ));
  });

  test("retains the launch prompt when durable PR enqueue fails", async () => {
    currentEnabledAgentPlatforms = ["claude", "codex", "cursor", "opencode"];
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "cursor",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    enqueuePromptQueueMessageMock.mockRejectedValueOnce(
      new Error("backend unavailable"),
    );

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not start pull request creation",
      expect.objectContaining({ description: "backend unavailable" }),
    ));
    // Persistence never became authoritative, so the tab keeps the prompt it was
    // created with and can still launch the PR itself.
    expect(createTabMock).toHaveBeenLastCalledWith(
      "cursor",
      expect.objectContaining({
        initialPrompt: expect.stringContaining("gh pr create --base main --fill"),
      }),
    );
    expect(clearTabInitialPromptMock).not.toHaveBeenCalled();
  });

  test("retains the launch prompt when durable review enqueue fails", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    enqueuePromptQueueMessageMock.mockRejectedValueOnce(
      new Error("backend unavailable"),
    );

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Code review" }));

    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        initialPrompt: expect.stringContaining("Security and instruction hierarchy"),
        isReviewTab: true,
      }),
    );
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not start review",
      expect.objectContaining({ description: "backend unavailable" }),
    ));
  });

  test("names PR, resolve, and push workflow tabs", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const { rerender } = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "PR" }),
    );

    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    rerender(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(armRefreshAfterAgentCompletionMock).toHaveBeenCalledTimes(1);
      expect(createTabMock).toHaveBeenLastCalledWith(
        "codex",
        expect.objectContaining({ displayTitle: "Resolve" }),
      );
    });

    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: false,
    };
    currentChanges = [{ path: "src/example.ts" }];
    rerender(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Git Push" }),
    );
  });

  test("arms before launching Resolve and suppresses duplicate launches while arming", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const events: string[] = [];
    let resolveArm!: (armedAt: string | null) => void;
    armRefreshAfterAgentCompletionMock.mockImplementationOnce(() => {
      events.push("arm");
      return new Promise((resolve) => {
        resolveArm = resolve;
      });
    });
    createTabMock.mockImplementationOnce(() => {
      events.push("create");
      return true;
    });
    render(<ActionBar />);

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    fireEvent.click(resolveButton);
    fireEvent.click(resolveButton);

    expect(armRefreshAfterAgentCompletionMock).toHaveBeenCalledTimes(1);
    expect(createTabMock).not.toHaveBeenCalled();
    expect((resolveButton as HTMLButtonElement).disabled).toBe(true);

    resolveArm("armed-at-deferred");

    await waitFor(() => expect(createTabMock).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["arm", "create"]);
    expect((resolveButton as HTMLButtonElement).disabled).toBe(false);
  });

  test("disables the configured Resolve launch while it is being armed", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    let resolveArm!: (armedAt: string | null) => void;
    armRefreshAfterAgentCompletionMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveArm = resolve;
    }));
    render(<ActionBar />);

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    fireEvent.contextMenu(resolveButton);
    const confirm = screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement;
    fireEvent.click(confirm);

    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(armRefreshAfterAgentCompletionMock).toHaveBeenCalledTimes(1);

    // The launch the user just submitted is in flight. Presenting that as an
    // eligibility error would report their own successful submission as a
    // failure for as long as the backend arm took.
    expect(screen.getByRole("status").textContent).toContain("Launching");
    expect(screen.queryByRole("alert") === null).toBe(true);

    resolveArm("armed-after-menu-check");
    await waitFor(() => expect(createTabMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Configure conflict resolution" }) === null)
        .toBe(true));
  });

  test("keeps the Resolve dialog open through dismissals while the launch is arming", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    let resolveArm!: (armedAt: string | null) => void;
    armRefreshAfterAgentCompletionMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveArm = resolve;
    }));
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));

    const dialog = screen.getByRole("dialog", { name: "Configure conflict resolution" });
    expect(screen.getByRole("status").textContent).toContain("Launching");

    // Escape and Cancel must not unmount the reporting surface: a refused
    // createTab after the arm would otherwise have nowhere to put the error
    // and no toast to fall back on.
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    expect(createTabMock).not.toHaveBeenCalled();

    resolveArm("armed-during-dismiss-attempt");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("maximum tab count"));
    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(disarmRefreshAfterAgentCompletionMock).toHaveBeenCalledWith("armed-during-dismiss-attempt");
  });

  test("reports a refused Resolve tab in the dialog without a duplicate toast", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockResolvedValueOnce("armed-at-modal-refusal");
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("maximum tab count"));
    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    // The dialog is the reporting surface here; a toast would repeat the same
    // failure in different words behind a modal the user is already reading.
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(disarmRefreshAfterAgentCompletionMock).toHaveBeenCalledWith("armed-at-modal-refusal");

    // The dialog stays usable: a retry that succeeds clears it.
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Configure conflict resolution" }) === null)
        .toBe(true));
    expect(createTabMock).toHaveBeenCalledTimes(2);
  });

  test("reports an arm failure but still launches the requested Resolve agent", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockRejectedValueOnce(new Error("backend offline"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(createTabMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not schedule the PR refresh",
      expect.objectContaining({ description: expect.stringContaining("still open") }),
    );
    expect(disarmRefreshAfterAgentCompletionMock).not.toHaveBeenCalled();
  });

  test("rolls back the exact refresh arm when Resolve tab creation is refused", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockResolvedValueOnce("armed-at-refused");
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(disarmRefreshAfterAgentCompletionMock).toHaveBeenCalledWith("armed-at-refused");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open conflict resolution",
      expect.objectContaining({ description: expect.stringContaining("maximum tab count") }),
    );
  });

  test("does not roll back an earlier request when the current Resolve arm is refused", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockResolvedValueOnce(null);
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open conflict resolution",
      expect.any(Object),
    ));
    expect(disarmRefreshAfterAgentCompletionMock).not.toHaveBeenCalled();
  });

  test("rolls back the exact refresh arm when Resolve tab creation throws", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockResolvedValueOnce("armed-at-thrown");
    createTabMock.mockImplementationOnce(() => {
      throw new Error("pane rejected the tab");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(disarmRefreshAfterAgentCompletionMock).toHaveBeenCalledWith("armed-at-thrown");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open conflict resolution",
      { description: "pane rejected the tab" },
    );
  });

  test("reports tab refusal and unlocks Resolve when arm rollback rejects", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    armRefreshAfterAgentCompletionMock.mockResolvedValueOnce("armed-at-rollback-failure");
    createTabMock.mockReturnValueOnce(false);
    disarmRefreshAfterAgentCompletionMock.mockRejectedValueOnce(new Error("disarm rejected"));
    render(<ActionBar />);

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    fireEvent.click(resolveButton);

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open conflict resolution",
      expect.any(Object),
    ));
    expect(console.warn).toHaveBeenCalledWith(
      "[ActionBar] Failed to roll back the PR refresh arm:",
      expect.any(Error),
    );
    expect((resolveButton as HTMLButtonElement).disabled).toBe(false);
  });

  test("cancels an armed Resolve launch when the selected environment changes", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    let resolveArm!: (armedAt: string | null) => void;
    armRefreshAfterAgentCompletionMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveArm = resolve;
    }));
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    currentSelectedEnvironmentId = "env-2";
    currentOtherEnvironments = [{
      ...selectedEnvironment,
      id: "env-2",
      name: "other-environment",
      prState: "open",
      hasMergeConflicts: true,
    }];
    view.rerender(<ActionBar />);
    resolveArm("armed-before-selection-change");

    await waitFor(() => {
      expect(disarmRefreshAfterAgentCompletionMock).toHaveBeenCalledWith(
        "armed-before-selection-change",
      );
    });
    expect(createTabMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open conflict resolution",
      expect.objectContaining({ description: expect.stringContaining("selected environment changed") }),
    );
  });

  test("starts PR monitoring and honors environment defaults and one-shot workflow overrides", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: "opencode",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentDefaultAgent = "claude";
    const { rerender } = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(setModeCreatePendingMock).toHaveBeenCalledTimes(1);
    expect(createTabMock).toHaveBeenLastCalledWith(
      "opencode",
      expect.objectContaining({ displayTitle: "PR" }),
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(setModeCreatePendingMock).toHaveBeenCalledTimes(2);
    expect(createTabMock).toHaveBeenLastCalledWith(
      "opencode",
      expect.objectContaining({
        agentLaunchMode: "native",
        displayTitle: "PR",
        initialAgentModel: expect.any(String),
      }),
    );

    currentEnvironment = {
      ...currentEnvironment,
      prUrl: selectedEnvironment.prUrl,
      prState: "open",
      hasMergeConflicts: true,
    };
    rerender(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    chooseReviewProvider("codex");
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
    await waitFor(() => {
      expect(armRefreshAfterAgentCompletionMock).toHaveBeenCalledTimes(1);
      expect(createTabMock).toHaveBeenLastCalledWith(
        "codex",
        expect.objectContaining({
          agentLaunchMode: "native",
          displayTitle: "Resolve",
          initialAgentModel: expect.any(String),
        }),
      );
    });

    currentEnvironment = {
      ...currentEnvironment,
      hasMergeConflicts: false,
    };
    currentChanges = [{ path: "src/example.ts" }];
    rerender(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Push Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Push with Claude" }));
    expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({ displayTitle: "Git Push" }),
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Code review" }));
    expect(screen.getByRole("dialog", { name: "Configure code review" })).toBeTruthy();
    chooseReviewProvider("codex");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({
        agentLaunchMode: "native",
        displayTitle: "Review",
        initialAgentModel: expect.any(String),
        isReviewTab: true,
      }),
    );
  });

  test("configures a PR launch in a modal rather than a provider menu", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));

    expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create PR with Claude" }) === null).toBe(true);
    expect(screen.getByRole("combobox", { name: "Agent, model and reasoning" })).toBeTruthy();

    // Dismissing must leave the environment untouched: the modal replaces a menu
    // whose every item launched an agent immediately.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Configure pull request" }) === null).toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();
  });

  test("keeps the PR modal pinned when the selected environment changes", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy();

    currentSelectedEnvironmentId = "env-2";
    currentEnvironment = {
      ...currentEnvironment,
      id: "env-2",
      name: "other-environment",
    };
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("selected environment changed");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText(/into main/)).toBeTruthy();
    expect(createTabMock).not.toHaveBeenCalled();
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();
  });

  test("disables a configured PR launch when a PR appears while the modal is open", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    currentEnvironment = {
      ...currentEnvironment,
      prUrl: "https://github.com/org/repo/pull/2",
      prState: "open",
    };
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("now exists");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();
  });

  test("keeps the PR modal open and monitoring idle when tab creation is rejected", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("could not be created");
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(screen.queryByRole("dialog", { name: "Configure pull request" }) === null).toBe(true);
    expect(createTabMock).toHaveBeenCalledTimes(2);
    expect(setModeCreatePendingMock).toHaveBeenCalledTimes(1);
  });

  test("leaves PR monitoring idle when a plain-click launch is rejected", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    // Arming create-pending here would leave the backend polling every five
    // seconds for a PR that no agent was ever launched to create.
    expect(createTabMock).toHaveBeenCalledTimes(1);
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();
  });

  test("falls back to main when the repository stores an empty PR base branch", () => {
    // Repository settings persist a cleared "PR Base Branch" field verbatim,
    // so an empty string has to be treated as unset rather than as a branch.
    currentRepositoryConfig = { "project-1": { prBaseBranch: "" } };
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    const [, options] = createTabMock.mock.calls[0] as [string, { initialPrompt: string }];
    expect(options.initialPrompt).toContain("gh pr create --base main --fill");
    expect(options.initialPrompt).not.toContain("--base  ");
    expect(options.initialPrompt).not.toContain("git diff origin/...HEAD");
  });

  test("launches against the base branch pinned when the modal opened", () => {
    currentRepositoryConfig = { "project-1": { prBaseBranch: "release" } };
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    expect(screen.getByText(/into release/)).toBeTruthy();

    // Repository settings can be saved while the modal is open. The launch must
    // use the branch the user reviewed, not the one that replaced it.
    currentRepositoryConfig = { "project-1": { prBaseBranch: "develop" } };
    view.rerender(<ActionBar />);
    expect(screen.getByText(/into release/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    const [, options] = createTabMock.mock.calls[0] as [string, { initialPrompt: string }];
    expect(options.initialPrompt).toContain("gh pr create --base release --fill");
    expect(options.initialPrompt).not.toContain("develop");
  });

  test("disables a pinned PR launch when the environment stops running", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    currentEnvironment = { ...currentEnvironment, status: "stopped" };
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("no longer running");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
    expect(setModeCreatePendingMock).not.toHaveBeenCalled();
  });

  test("disables a pinned PR launch when the tab limit is reached", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    currentTabCount = 10;
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("maximum number of tabs");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("distinguishes an unready terminal from the tab limit", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));
    // No terminal container has registered a tab factory. Reporting the tab
    // limit here would be false and would send the user looking for tabs to close.
    currentCreateTabRegistered = false;
    view.rerender(<ActionBar />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("not ready to open a new tab");
    expect(alert).not.toContain("maximum number of tabs");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("opens the PR modal after a mobile long press without launching a default PR", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar presentation="grid" />);

    const createPrButton = screen.getByRole("button", { name: "Create PR" });
    fireEvent.pointerDown(createPrButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 575));
    fireEvent.pointerUp(createPrButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });

    // The 550 ms production timer is raced against this test's fixed 575 ms
    // sleep, so under aggregate scheduling the dialog can mount just after an
    // immediate query. Same fix as the code-review twin below.
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy();
    }, { timeout: 10_000 });

    // The click mobile browsers synthesize after the gesture must be consumed.
    fireEvent.click(createPrButton);
    expect(createTabMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        agentLaunchMode: "native",
        displayTitle: "PR",
      }),
    );
  }, 20_000);

  test("opens a configuration modal instead of a provider menu for Resolve", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve with Claude" }) === null).toBe(true);
    expect(screen.getByRole("combobox", { name: "Agent, model and reasoning" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("opens the Resolve modal after a mobile long press without launching a default resolve", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    render(<ActionBar presentation="grid" />);

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    fireEvent.pointerDown(resolveButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 575));
    fireEvent.pointerUp(resolveButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });

    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();

    // The click mobile browsers synthesize after the gesture must be consumed,
    // or the long press would also launch an unconfigured default-agent resolve.
    fireEvent.click(resolveButton);
    expect(createTabMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
    await waitFor(() => expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        agentLaunchMode: "native",
        displayTitle: "Resolve",
      }),
    ));
  }, 20_000);

  test("resolves against the base branch pinned when the modal opened", async () => {
    currentRepositoryConfig = { "project-1": { prBaseBranch: "release" } };
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    expect(screen.getByText(/against release/)).toBeTruthy();

    // Repository settings can be saved while the modal is open. The launch must
    // merge the branch the user reviewed, not the one that replaced it.
    currentRepositoryConfig = { "project-1": { prBaseBranch: "develop" } };
    view.rerender(<ActionBar />);
    expect(screen.getByText(/against release/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));

    await waitFor(() => expect(createTabMock).toHaveBeenCalledTimes(1));
    const [, options] = createTabMock.mock.calls[0] as [string, { initialPrompt: string }];
    expect(options.initialPrompt).toContain("git merge origin/release");
    expect(options.initialPrompt).not.toContain("develop");
  });

  test("disables a pinned Resolve launch when the conflicts are already gone", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    // Another agent, or a push, can clear the conflicts while the modal is open.
    currentEnvironment = { ...currentEnvironment, hasMergeConflicts: false };
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("no longer has merge conflicts");
    expect((screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("disables a pinned Resolve launch when the environment stops running", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    currentEnvironment = { ...currentEnvironment, status: "stopped" };
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("no longer running");
    expect((screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("disables a pinned Resolve launch when the tab limit is reached", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    currentTabCount = 10;
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("maximum number of tabs");
    expect((screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("distinguishes an unready terminal from the tab limit for Resolve", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    // No terminal container has registered a tab factory. Reporting the tab
    // limit here would be false and would send the user looking for tabs to close.
    currentCreateTabRegistered = false;
    view.rerender(<ActionBar />);

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("not ready to open a new tab");
    expect(alert).not.toContain("maximum number of tabs");
    expect((screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("disables a pinned Resolve launch when the selected environment changes", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    const view = render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Resolve" }));
    currentSelectedEnvironmentId = "env-2";
    currentOtherEnvironments = [{
      ...selectedEnvironment,
      id: "env-2",
      name: "other-environment",
      prState: "open",
      hasMergeConflicts: true,
    }];
    view.rerender(<ActionBar />);

    expect(screen.getByRole("alert").textContent).toContain("selected environment changed");
    expect((screen.getByRole("button", { name: "Resolve conflicts" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("routes every Push Changes context-menu provider", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: false,
    };
    currentChanges = [{ path: "src/example.ts" }];
    render(<ActionBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Push Changes" }));
    expectProviderMenuOrder("Push with");

    for (const [label, agent] of [
      ["Codex", "codex"],
      ["OpenCode", "opencode"],
    ] as const) {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Push Changes" }));
      fireEvent.click(screen.getByRole("button", { name: `Push with ${label}` }));
      expect(createTabMock).toHaveBeenLastCalledWith(
        agent,
        expect.objectContaining({ displayTitle: "Git Push" }),
      );
    }
  });

  test("opens the review modal after a mobile long press without launching the default review", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar presentation="grid" />);

    const reviewButton = screen.getByRole("button", { name: "Code review" });
    fireEvent.pointerDown(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 575));
    fireEvent.pointerUp(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Configure code review" })).toBeTruthy();
    }, { timeout: 10_000 });
    expect(createTabMock).not.toHaveBeenCalled();

    // Mobile browsers synthesize a click after the completed pointer gesture.
    // It must be consumed instead of launching an unconfigured review.
    fireEvent.click(reviewButton);
    expect(createTabMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        agentLaunchMode: "native",
        displayTitle: "Review",
        isReviewTab: true,
      }),
    );
  }, 20_000);

  test("allows ordinary review clicks after long-press suppression expires", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar presentation="grid" />);

    const reviewButton = screen.getByRole("button", { name: "Code review" });
    fireEvent.pointerDown(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 575));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Configure code review" })).toBeTruthy();
    }, { timeout: 10_000 });

    await new Promise((resolve) => setTimeout(resolve, 1_025));
    fireEvent.click(reviewButton);

    expect(createTabMock).toHaveBeenCalledTimes(1);
    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Review", isReviewTab: true }),
    );
  }, 20_000);

  test("clears active long-press click suppression when the action bar unmounts", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    const view = render(<ActionBar presentation="grid" />);

    const reviewButton = screen.getByRole("button", { name: "Code review" });
    fireEvent.pointerDown(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 24,
      clientY: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 575));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Configure code review" })).toBeTruthy();
    }, { timeout: 10_000 });

    view.unmount();

    expect(createTabMock).not.toHaveBeenCalled();
  }, 20_000);

  test("cancels a pending mobile long press after movement or pointer cancellation", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar presentation="grid" />);

    const reviewButton = screen.getByRole("button", { name: "Code review" });
    fireEvent.pointerDown(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(reviewButton, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 30,
      clientY: 10,
    });
    fireEvent.pointerDown(reviewButton, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerCancel(reviewButton, {
      pointerId: 2,
      pointerType: "touch",
    });

    await new Promise((resolve) => setTimeout(resolve, 575));
    expect(screen.queryByRole("dialog", { name: "Configure code review" }) === null).toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("maps every configured native review provider and closes without launch on Cancel", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    render(<ActionBar />);
    const reviewButton = screen.getByRole("button", { name: "Code review" });

    fireEvent.contextMenu(reviewButton);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Configure code review" }) === null).toBe(true);
    expect(createTabMock).not.toHaveBeenCalled();

    const cases = [
      { agent: "claude" },
      { agent: "codex" },
      { agent: "opencode" },
    ] as const;

    for (const reviewCase of cases) {
      fireEvent.contextMenu(reviewButton);
      chooseReviewProvider(reviewCase.agent);
      fireEvent.click(screen.getByRole("button", { name: "Start review" }));
      expect(createTabMock).toHaveBeenLastCalledWith(
        reviewCase.agent,
        expect.objectContaining({
          agentLaunchMode: "native",
          initialAgentModel: expect.any(String),
          isReviewTab: true,
        }),
      );
    }
    expect(createTabMock).toHaveBeenCalledTimes(cases.length);
  });

  test("places Multi Review after Review and sends only the launch intent to the backend", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentWorkspaceReady = true;
    render(<ActionBar />);

    const toolbarButtons = screen.getAllByRole("button");
    expect(toolbarButtons.indexOf(screen.getByRole("button", { name: "Multi Review" })))
      .toBe(toolbarButtons.indexOf(screen.getByRole("button", { name: "Code review" })) + 1);
    fireEvent.click(screen.getByRole("button", { name: "Multi Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    await waitFor(() => expect(startMultiReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: expect.arrayContaining([
        expect.objectContaining({ agent: "codex", model: expect.any(String) }),
      ]),
      fixModel: expect.objectContaining({ agent: "codex", model: expect.any(String) }),
    })));
    expect(createTabMock).toHaveBeenCalledWith("multi-review", {
      multiReviewId: "multi-workflow-1",
      displayTitle: "Multi Review",
    });
    expect(installMultiReviewWorkflowMock).toHaveBeenCalledWith(startedMultiReview);
  });

  test("keeps a still-cancelling Multi Review recoverable when the tab cannot open", async () => {
    // Cancellation is asynchronous, so the backend answers `cancelling`, not
    // `cancelled`. Deleting there is rejected, which would replace the real
    // launch error with a storage error and strand the record.
    cancelMultiReviewMock.mockImplementation(async () => ({
      id: "multi-workflow-1", phase: "cancelling" as const,
    }));
    createTabMock.mockImplementation((type: string) => type !== "multi-review");
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentWorkspaceReady = true;
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Multi Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    await waitFor(() => expect(cancelMultiReviewMock).toHaveBeenCalledWith("multi-workflow-1"));
    expect(deleteMultiReviewWorkflowMock).not.toHaveBeenCalled();
    expect(removeMultiReviewWorkflowMock).not.toHaveBeenCalled();
    expect(installMultiReviewWorkflowMock).toHaveBeenLastCalledWith({
      id: "multi-workflow-1", phase: "cancelling",
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Could not open Multi Review", {
      description: expect.stringContaining("maximum tab count was reached"),
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Could not open Multi Review", {
      description: expect.stringContaining("remains available for recovery"),
    });
    // The rollback already requested cancellation; it must not be re-issued.
    expect(cancelMultiReviewMock).toHaveBeenCalledTimes(1);
  });

  test("deletes a Multi Review that finished cancelling before its tab could open", async () => {
    createTabMock.mockImplementation((type: string) => type !== "multi-review");
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentWorkspaceReady = true;
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Multi Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    await waitFor(() =>
      expect(deleteMultiReviewWorkflowMock).toHaveBeenCalledWith("multi-workflow-1"));
    expect(removeMultiReviewWorkflowMock).toHaveBeenCalledWith("multi-workflow-1");
    expect(toastErrorMock).toHaveBeenCalledWith("Could not open Multi Review", {
      description: "The environment is not ready or the maximum tab count was reached.",
    });
    expect(cancelMultiReviewMock).toHaveBeenCalledTimes(1);
  });

  test("launches one dedicated looped-review tab with the default six-pass allowance", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentWorkspaceReady = true;
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    expect(
      screen.getByRole("dialog", { name: "Configure looped code review" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      targetBranch: "main",
      allowance: 6,
    })));
    expect(createTabMock).toHaveBeenCalledWith("looped-review", {
      loopedReviewId: "looped-workflow-1",
      displayTitle: "Looped Review",
    });
    expect(installLoopedWorkflowMock).toHaveBeenCalledWith(startedLoopedWorkflow);
    expect(removeLoopedWorkflowMock).not.toHaveBeenCalled();
  });

  test("blocks duplicate submissions and exposes a busy launch state", async () => {
    currentWorkspaceReady = true;
    let resolveStart!: (workflow: typeof startedLoopedWorkflow) => void;
    startLoopedReviewMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    const startButton = screen.getByRole("button", { name: "Start looped review" });
    fireEvent.click(startButton);

    const busyButton = await screen.findByRole("button", { name: "Starting looped review…" });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(busyButton.closest("form")!);
    expect(startLoopedReviewMock).toHaveBeenCalledTimes(1);

    resolveStart(startedLoopedWorkflow);
    await waitFor(() => expect(createTabMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Configure looped code review" }) === null).toBe(true);
  });

  test("disables the toolbar entry point while a launch is in flight", async () => {
    currentWorkspaceReady = true;
    let resolveStart!: (workflow: typeof startedLoopedWorkflow) => void;
    startLoopedReviewMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    render(<ActionBar />);

    const toolbarButton = screen.getByRole("button", { name: "Looped code review" });
    expect((toolbarButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toolbarButton);
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    // Otherwise a second review could be launched for the same environment
    // from the toolbar while the first is still being created. The open dialog
    // marks the toolbar aria-hidden, so it is queried explicitly.
    const toolbarEntry = () => screen.getByRole(
      "button", { name: "Looped code review", hidden: true },
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(toolbarEntry().disabled).toBe(true);
    });

    resolveStart(startedLoopedWorkflow);
    await waitFor(() => {
      expect(toolbarEntry().disabled).toBe(false);
    });
  });

  test("allows a fresh launch after a failed one", async () => {
    currentWorkspaceReady = true;
    startLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("backend unavailable");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());

    // The synchronous in-flight guard must be cleared on the failure path too,
    // or the user can never retry without reloading.
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));
    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledTimes(2));
  });

  test("surfaces a backend start rejection without attempting cleanup", async () => {
    currentWorkspaceReady = true;
    startLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("backend unavailable");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      { description: "backend unavailable" },
    ));
    expect(cancelLoopedReviewMock).not.toHaveBeenCalled();
    expect(deleteLoopedReviewMock).not.toHaveBeenCalled();
    expect(removeLoopedWorkflowMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Start looped review" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  test("passes linked ticket details and current project notes into looped review", async () => {
    currentWorkspaceReady = true;
    currentKanbanNotesProjectId = "project-1";
    currentKanbanNotes = "Prefer small, independently deployable changes.";
    currentTaskAssociation = {
      taskId: "task-1",
      task: {
        id: "task-1",
        projectId: "project-1",
        title: "Retry failed uploads",
        description: "Keep failed uploads available for retry.",
        acceptanceCriteria: "Retry without selecting the file again.",
        status: "in-progress",
        comments: [
          { id: "comment-1", text: "Preserve the original file.", createdAt: "2026-07-20" },
        ],
        images: [
          { id: "image-1", filename: "failed-upload.png", createdAt: "2026-07-20" },
        ],
        createdAt: "2026-07-20",
        order: 0,
        environmentId: "env-1",
      },
    };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      context: {
        ticketTitle: "Retry failed uploads",
        ticketDescription: "Keep failed uploads available for retry.",
        acceptanceCriteria: "Retry without selecting the file again.",
        comments: ["Preserve the original file."],
        imageNames: ["failed-upload.png"],
        projectNotes: "Prefer small, independently deployable changes.",
      },
    })));
  });

  test("passes current project notes without requiring a linked ticket", async () => {
    currentWorkspaceReady = true;
    currentKanbanNotesProjectId = "project-1";
    currentKanbanNotes = "Review database migrations carefully.";
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      context: {
        ticketTitle: undefined,
        ticketDescription: undefined,
        acceptanceCriteria: undefined,
        comments: undefined,
        imageNames: undefined,
        projectNotes: "Review database migrations carefully.",
      },
    })));
  });

  test("excludes notes loaded for another project from looped review", async () => {
    currentWorkspaceReady = true;
    currentKanbanNotesProjectId = "other-project";
    currentKanbanNotes = "Unrelated project notes";
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      context: undefined,
    })));
  });

  test("requires a running, workspace-ready environment with setup complete", () => {
    const assertUnavailable = () => {
      const button = screen.getByRole("button", { name: "Looped code review" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(screen.queryByRole("dialog", { name: "Configure looped code review" }) === null).toBe(true);
      expect(startLoopedReviewMock).not.toHaveBeenCalled();
    };

    currentEnvironment = { ...selectedEnvironment, status: "stopped" };
    currentWorkspaceReady = true;
    const stopped = render(<ActionBar />);
    assertUnavailable();
    stopped.unmount();

    currentEnvironment = { ...selectedEnvironment, status: "running" };
    currentWorkspaceReady = false;
    const unready = render(<ActionBar />);
    assertUnavailable();
    unready.unmount();

    currentWorkspaceReady = true;
    currentSetupScriptsRunning = true;
    render(<ActionBar />);
    assertUnavailable();
  });

  test("revalidates looped-review readiness when the configured launch is submitted", () => {
    currentWorkspaceReady = true;
    const view = render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));

    currentWorkspaceReady = false;
    view.rerender(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    expect(startLoopedReviewMock).not.toHaveBeenCalled();
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("rolls back the workflow when tab creation is refused", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockReturnValueOnce(false);
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(startLoopedReviewMock).toHaveBeenCalledTimes(1));
    expect(cancelLoopedReviewMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(installLoopedWorkflowMock).toHaveBeenNthCalledWith(1, startedLoopedWorkflow);
    expect(installLoopedWorkflowMock).toHaveBeenNthCalledWith(2, cancelledLoopedWorkflow);
    expect(deleteLoopedReviewMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(removeLoopedWorkflowMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({ description: expect.stringContaining("maximum tab count") }),
    );
    expect(
      screen.getByRole("dialog", { name: "Configure looped code review" }),
    ).toBeTruthy();
  });

  test("rolls back the workflow when tab creation throws", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockImplementationOnce(() => {
      throw new Error("pane rejected the tab");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(removeLoopedWorkflowMock).toHaveBeenCalledWith("looped-workflow-1"));
    expect(cancelLoopedReviewMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(deleteLoopedReviewMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      { description: "pane rejected the tab" },
    );
  });

  test("reports non-Error looped-review tab creation failures", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockImplementationOnce(() => {
      throw "pane rejected the tab";
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(removeLoopedWorkflowMock).toHaveBeenCalledWith("looped-workflow-1"));
    expect(deleteLoopedReviewMock).toHaveBeenCalledWith("looped-workflow-1");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      { description: "pane rejected the tab" },
    );
  });

  test("preserves the workflow projection when cancellation fails", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockReturnValueOnce(false);
    cancelLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("provider abort failed");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({
        description: expect.stringContaining("saved workflow remains available for recovery"),
      }),
    ));
    expect(installLoopedWorkflowMock).toHaveBeenCalledWith(startedLoopedWorkflow);
    expect(deleteLoopedReviewMock).not.toHaveBeenCalled();
    expect(removeLoopedWorkflowMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Configure looped code review" })).toBeTruthy();

    const recoveryToast = toastErrorMock.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(recoveryToast.action?.label).toBe("Open workflow");
    recoveryToast.action?.onClick();
    expect(createTabMock).toHaveBeenLastCalledWith("looped-review", {
      loopedReviewId: "looped-workflow-1",
      displayTitle: "Looped Review",
    });
  });

  test("reports when the recovery action cannot reopen the workflow tab", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockImplementation(() => false);
    cancelLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("provider abort failed");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({
        description: expect.stringContaining("saved workflow remains available for recovery"),
      }),
    ));

    const recoveryToast = toastErrorMock.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(recoveryToast.action?.label).toBe("Open workflow");
    recoveryToast.action?.onClick();
    expect(toastErrorMock).toHaveBeenLastCalledWith("Could not restore looped review", {
      description: expect.stringContaining("Free a tab"),
    });
  });

  test("reports thrown recovery errors, including non-Error values", async () => {
    currentWorkspaceReady = true;
    createTabMock
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error("pane restore exploded");
      })
      .mockImplementationOnce(() => {
        throw "pane unavailable";
      });
    cancelLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("provider abort failed");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({
        description: expect.stringContaining("saved workflow remains available for recovery"),
      }),
    ));

    const recoveryToast = toastErrorMock.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(recoveryToast.action?.label).toBe("Open workflow");

    recoveryToast.action?.onClick();
    expect(toastErrorMock).toHaveBeenLastCalledWith("Could not restore looped review", {
      description: "pane restore exploded",
    });

    recoveryToast.action?.onClick();
    expect(toastErrorMock).toHaveBeenLastCalledWith("Could not restore looped review", {
      description: "pane unavailable",
    });
  });

  test("keeps the cancelled snapshot visible when deletion fails", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockReturnValueOnce(false);
    deleteLoopedReviewMock.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({
        description: expect.stringContaining("saved workflow remains available for recovery"),
      }),
    ));
    expect(installLoopedWorkflowMock).toHaveBeenLastCalledWith(cancelledLoopedWorkflow);
    expect(removeLoopedWorkflowMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Configure looped code review" })).toBeTruthy();
  });

  test("preserves a cancelling workflow without attempting premature deletion", async () => {
    currentWorkspaceReady = true;
    createTabMock.mockReturnValueOnce(false);
    const cancellingWorkflow = { id: "looped-workflow-1", phase: "cancelling" as const };
    cancelLoopedReviewMock.mockImplementationOnce(async () => cancellingWorkflow);
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Looped code review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    await waitFor(() => expect(installLoopedWorkflowMock).toHaveBeenLastCalledWith(
      cancellingWorkflow,
    ));
    expect(deleteLoopedReviewMock).not.toHaveBeenCalled();
    expect(removeLoopedWorkflowMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not open looped review",
      expect.objectContaining({ description: expect.stringContaining("Cancellation is still in progress") }),
    );
  });

  test("falls back from an absent environment and global workflow default to Claude", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      defaultAgent: undefined,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentDefaultAgent = undefined;
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(createTabMock).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ displayTitle: "PR" }),
    );
  });
});

describe("ActionBar configured action defaults", () => {
  test("launches a one-click review with the configured Review default", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    // The app default agent is Codex; the Review default names Claude, so the
    // whole decision — platform, model and reasoning — must come from it.
    currentActionDefaults = {
      review: { platform: "claude", model: "opus[1m]", reasoningEffort: "max" },
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Code review" }));

    // The tab owns the model for every follow-up turn, so passing it only to
    // the queued message would confine the configured default to the first one.
    expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({
        displayTitle: "Review",
        initialAgentModel: "opus[1m]",
        initialReasoningEffort: "max",
      }),
    );
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/^claude\u0000env-env-1:tab-/),
      "env-1",
      expect.objectContaining({ model: "opus[1m]", effort: "max" }),
    ));
  });

  test("keeps the environment's own agent ahead of an application-level default", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      // The user created this environment with Codex explicitly.
      defaultAgent: "codex",
    };
    currentActionDefaults = {
      review: { platform: "claude", model: "opus[1m]", reasoningEffort: "max" },
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Code review" }));

    // Action defaults are application-level, so the narrower per-environment
    // choice wins — and Claude's model cannot travel to Codex with it.
    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Review" }),
    );
    expect(createTabMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("initialAgentModel");
  });

  test("applies a default whose platform matches the environment's own agent", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      defaultAgent: "claude",
    };
    currentActionDefaults = {
      pr: { platform: "claude", model: "haiku", reasoningEffort: "low" },
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    // Same platform, so nothing is being retargeted and the configured model
    // and reasoning level still apply.
    expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({
        displayTitle: "PR",
        initialAgentModel: "haiku",
        initialReasoningEffort: "low",
      }),
    );
  });

  test("ignores a Review default whose platform is no longer enabled", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentEnabledAgentPlatforms = ["codex"];
    currentActionDefaults = {
      review: { platform: "claude", model: "opus[1m]", reasoningEffort: "max" },
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Code review" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Review" }),
    );
    // Claude's model must not be carried onto Codex; the configured Codex
    // defaults are what the launch falls back to.
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/^codex\u0000env-env-1:tab-/),
      "env-1",
      expect.objectContaining({
        model: "codex-default-model",
        reasoningEffort: "medium",
      }),
    ));
  });

  test("applies the configured PR default to a plain Create PR click", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentActionDefaults = {
      pr: { platform: "claude", model: "haiku", reasoningEffort: "low" },
    };

    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({
        displayTitle: "PR",
        initialAgentModel: "haiku",
        initialReasoningEffort: "low",
      }),
    );
  });

  test("applies the configured Resolve and Push defaults", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: true,
    };
    currentActionDefaults = {
      resolve: { platform: "claude", model: "sonnet" },
      push: { platform: "opencode", model: "openai/gpt-push", reasoningEffort: "high" },
    };
    const view = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({
        displayTitle: "Resolve",
        initialAgentModel: "sonnet",
      }),
    ));

    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: false,
    };
    currentChanges = [{ path: "src/example.ts" }];
    view.rerender(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(createTabMock).toHaveBeenLastCalledWith(
      "opencode",
      expect.objectContaining({
        displayTitle: "Git Push",
        initialAgentModel: "openai/gpt-push",
        initialReasoningEffort: "high",
      }),
    );
  });

  test("keeps a context-menu agent choice ahead of the Push default", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: false,
    };
    currentChanges = [{ path: "src/example.ts" }];
    currentActionDefaults = {
      push: { platform: "opencode", model: "openai/gpt-push" },
    };

    render(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Push Changes" }));
    fireEvent.click(screen.getByText("Push with Claude"));

    // The menu picks a platform, so OpenCode's model cannot travel with it.
    expect(createTabMock).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({ displayTitle: "Git Push" }),
    );
    expect(createTabMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("initialAgentModel");
  });

  test("opens the Create PR dialog on the configured PR default", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };
    currentActionDefaults = {
      pr: { platform: "claude", model: "haiku" },
    };

    render(<ActionBar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Create PR" }));

    // Right-clicking must propose what the plain click would have done, or the
    // two adjacent affordances disagree about the same button.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Configure pull request" })).toBeTruthy());
    expect(
      screen.getByRole("combobox", { name: "Agent, model and reasoning" }).textContent,
    ).toContain("Haiku");
  });
});

describe("ActionBar pull request actions", () => {
  test("hides Push Changes for every terminal pull request state", () => {
    currentEnvironment = { ...selectedEnvironment, prState: "merged" };
    const view = render(<ActionBar />);

    expect(screen.queryByRole("button", { name: "Push Changes" }) === null).toBe(true);

    currentEnvironment = { ...selectedEnvironment, prState: "closed" };
    view.rerender(<ActionBar />);

    expect(screen.queryByRole("button", { name: "Push Changes" }) === null).toBe(true);
  });

  test("rehydrates an in-progress merge from the environment lifecycle marker", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      lifecycleOperation: "merging",
    };
    render(<ActionBar />);

    const mergeButton = screen.getByRole("button", { name: "Merging..." });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(true);
    expect(mergeButton.querySelector(".animate-spin")).toBeTruthy();
  });

  test("rehydrates an in-progress deletion by disabling cleanup", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "merged",
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-01-02T00:00:00.000Z",
    };
    render(<ActionBar />);

    const cleanupButton = screen.getByRole("button", { name: "Clean Up" }) as HTMLButtonElement;
    expect(cleanupButton.disabled).toBe(true);
    fireEvent.click(cleanupButton);
    expect(screen.queryByRole("button", { name: "Delete Environment" }) === null).toBe(true);
  });

  test("opens an active pull request in the browser", () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "View PR" }));

    expect(viewPRMock).toHaveBeenCalledTimes(1);
  });

  test("shows a disabled pending affordance while GitHub computes mergeability", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
      hasMergeConflicts: null,
    };
    render(<ActionBar />);

    const checking = screen.getByRole("button", { name: "Checking mergeability…" }) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Merge PR" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Resolve" }) === null).toBe(true);
  });

  test("presents a closed pull request and cleanup explanation without merged-branch wording", () => {
    currentEnvironment = { ...selectedEnvironment, prState: "closed" };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "PR Closed" }));
    expect(viewPRMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Merge PR" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    expect(screen.getByText(/The PR has been closed/)).toBeTruthy();
    expect(screen.queryByText(/remote branch will also be deleted/) === null).toBe(true);
  });
});

describe("ActionBar run commands", () => {
  test("loads, validates, and launches container run commands", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockResolvedValueOnce({
      content: JSON.stringify({ run: ["bun run dev", 42, " ", "bun test"] }),
    });

    render(<ActionBar />);

    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledWith(
      "container-1",
      "orkestrator-ai.json",
    ));
    const runButton = screen.getByRole("button", { name: "Run commands" });
    await waitFor(() => expect(runButton.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.click(runButton);

    expect(createTabMock).toHaveBeenCalledWith("plain", {
      initialCommands: ["bun run dev", "bun test"],
    });
  });

  test("loads local run commands from the worktree", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      status: "stopped",
      worktreePath: "/tmp/repo-worktree",
    };
    currentWorkspaceReady = true;
    readLocalFileMock.mockResolvedValueOnce({ content: '{"run":["bun run dev"]}' });

    render(<ActionBar />);
    await waitFor(() => expect(readLocalFileMock).toHaveBeenCalledWith(
      "/tmp/repo-worktree",
      "orkestrator-ai.json",
    ));
    const runButton = screen.getByRole("button", { name: "Run commands" });
    await waitFor(() => expect(runButton.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.click(runButton);

    expect(createTabMock).toHaveBeenCalledWith("plain", {
      initialCommands: ["bun run dev"],
    });
  });

  test("keeps run disabled for malformed files, read failures, and setup scripts", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockResolvedValueOnce({ content: "{not-json" });
    const { rerender } = render(<ActionBar />);

    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("true");

    currentEnvironment = { ...selectedEnvironment, containerId: "container-2" };
    currentSelectedEnvironmentId = currentEnvironment.id;
    readContainerFileMock.mockRejectedValueOnce(new Error("file unavailable"));
    rerender(<ActionBar />);
    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("true");

    currentEnvironment = { ...selectedEnvironment, containerId: "container-3" };
    currentSetupScriptsRunning = true;
    readContainerFileMock.mockResolvedValueOnce({ content: '{"run":["bun test"]}' });
    rerender(<ActionBar />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(readContainerFileMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Run commands" }));
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("keeps run disabled when a backend read unexpectedly returns no request", async () => {
    currentWorkspaceReady = true;
    readContainerFileMock.mockImplementationOnce(() => null as never);
    render(<ActionBar />);

    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledWith(
      "container-1",
      "orkestrator-ai.json",
    ));
    expect(screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled"))
      .toBe("true");
    expect(createTabMock).not.toHaveBeenCalled();
  });

  test("ignores a stale run-command response after the environment changes", async () => {
    currentWorkspaceReady = true;
    let resolveOld!: (value: { content: string }) => void;
    readContainerFileMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOld = resolve;
      }))
      .mockResolvedValueOnce({ content: '{"run":[]}' });

    const { rerender } = render(<ActionBar />);
    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledTimes(1));

    currentEnvironment = {
      ...selectedEnvironment,
      id: "env-2",
      containerId: "container-2",
    };
    currentSelectedEnvironmentId = "env-2";
    rerender(<ActionBar />);
    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalledTimes(2));

    resolveOld({ content: '{"run":["stale command"]}' });
    await Promise.resolve();
    await Promise.resolve();

    const runButton = screen.getByRole("button", { name: "Run commands" });
    expect(runButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(runButton);
    expect(createTabMock).not.toHaveBeenCalled();
  });
});

describe("ActionBar editor actions", () => {
  test("opens container and local environments in the preferred editor", async () => {
    const { rerender } = render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(openInEditorMock).toHaveBeenCalledWith("container-1", "vscode"));

    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      status: "stopped",
      worktreePath: "/tmp/repo-worktree",
    };
    rerender(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(openLocalInEditorMock).toHaveBeenCalledWith(
      "/tmp/repo-worktree",
      "vscode",
    ));
  });

  test("shows and dismisses editor launch failures", async () => {
    openInEditorMock.mockRejectedValueOnce(new Error("editor CLI unavailable"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    expect(await screen.findByText("Failed to Open Editor")).toBeTruthy();
    expect(screen.getByText("editor CLI unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText("Failed to Open Editor") === null).toBe(true);
  });

  test("uses the Cursor preference in the action and failure guidance", async () => {
    currentPreferredEditor = "cursor";
    openInEditorMock.mockRejectedValueOnce(new Error("cursor CLI unavailable"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Open in Cursor" }));

    await waitFor(() => expect(openInEditorMock).toHaveBeenCalledWith("container-1", "cursor"));
    expect(await screen.findByText("Failed to Open Editor")).toBeTruthy();
    expect(screen.getByText(/Make sure you have the Cursor CLI/)).toBeTruthy();
  });
});

describe("ActionBar successful cleanup and merge actions", () => {
  test("deletes a finished environment and closes the cleanup dialog", async () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    await waitFor(() => expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-1"));
    expect(screen.queryByRole("button", { name: "Delete Environment" }) === null).toBe(true);
  });

  test("discloses that draft pull requests are marked ready before merging", () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));

    expect(screen.getByTestId("alert-dialog-content").textContent).toContain(
      "If the pull request is a draft, it will be marked ready for review first.",
    );
  });

  test("offers cleanup after a confirmed successful merge", () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));

    expect(screen.getByRole("button", { name: "Merge & Cleanup" })).toBeTruthy();
    expect(screen.getByTestId("alert-dialog-content").textContent).toContain(
      "only after the merge is confirmed successful",
    );
  });

  test("submits merge and cleanup as one backend-owned workflow", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    let resolveMerge!: (outcome: MergeOutcome) => void;
    mergeEnvironmentPrMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMerge = resolve;
    }));
    render(<ActionBar />);

    confirmMergeAndCleanup();

    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      true,
    ));
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(mergePrLocalMock).not.toHaveBeenCalled();

    resolveMerge({ outcome: "merged", cleanupOutcome: "completed" });

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith(
      "Branch merged",
      expect.objectContaining({ id: "branch-merged-env-1" }),
    ));
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
  });

  test("leaves pending cleanup orchestration with the backend", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    mergeEnvironmentPrMock.mockResolvedValueOnce({
      outcome: "pending",
      cleanupOutcome: "pending",
    });
    render(<ActionBar />);

    confirmMergeAndCleanup();

    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      true,
    ));
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
  });

  test("does not clean up when the merge fails", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    mergeEnvironmentPrMock.mockRejectedValueOnce(new Error("merge failed"));
    render(<ActionBar />);

    confirmMergeAndCleanup();

    const errorAlert = await waitFor(() => findErrorAlert("Failed to merge PR:"));
    expect(errorAlert.textContent).toContain("merge failed");
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
  });

  test("offers the regular cleanup retry when post-merge cleanup fails", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    mergeEnvironmentPrMock.mockResolvedValueOnce({
      outcome: "merged",
      cleanupOutcome: "failed",
      cleanupError: "delete failed",
    });
    render(<ActionBar />);

    confirmMergeAndCleanup();

    const errorAlert = await waitFor(() => findErrorAlert("Failed to delete environment:"));
    expect(errorAlert.textContent).toContain("delete failed");
    expect(screen.getByRole("button", { name: "Delete Environment" })).toBeTruthy();
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
  });

  test("uses generic cleanup guidance when the backend omits the cleanup error", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    mergeEnvironmentPrMock.mockResolvedValueOnce({
      outcome: "merged",
      cleanupOutcome: "failed",
    });
    render(<ActionBar />);

    confirmMergeAndCleanup();

    const errorAlert = await waitFor(() => findErrorAlert("Failed to delete environment:"));
    expect(errorAlert.textContent).toContain("An unexpected error occurred");
    expect(screen.getByRole("button", { name: "Delete Environment" })).toBeTruthy();
  });

  test("keeps a cleanup retry tied to the environment that initiated the merge", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    let resolveMerge!: (outcome: MergeOutcome) => void;
    mergeEnvironmentPrMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMerge = resolve;
    }));
    const { rerender } = render(<ActionBar />);
    confirmMergeAndCleanup();
    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledTimes(1));

    currentEnvironment = {
      ...selectedEnvironment,
      id: "env-2",
      name: "second-env",
      branch: "feature/second",
      containerId: "container-2",
      prUrl: "https://github.com/org/repo/pull/2",
      prState: "open",
    };
    currentSelectedEnvironmentId = "env-2";
    rerender(<ActionBar />);
    resolveMerge({
      outcome: "merged",
      cleanupOutcome: "failed",
      cleanupError: "delete failed",
    });

    await waitFor(() => expect(findErrorAlert("Failed to delete environment:")).toBeTruthy());
    expect(screen.getByTestId("alert-dialog-content").textContent).toContain(
      'environment "feature-env"',
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    await waitFor(() => expect(deleteEnvironmentMock).toHaveBeenCalledTimes(1));
    expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-1");
  });

  test("uses one environment-scoped command for container and local environments", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    const { rerender } = render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      false,
    ));

    mergeEnvironmentPrMock.mockClear();
    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      status: "stopped",
      worktreePath: "/tmp/repo-worktree",
      prState: "open",
    };
    rerender(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      false,
    ));
    expect(mergePrLocalMock).not.toHaveBeenCalled();
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  test("pins ordinary cleanup to the environment whose dialog was opened", async () => {
    const { rerender } = render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));

    currentEnvironment = {
      ...selectedEnvironment,
      id: "env-2",
      name: "second-env",
      prState: "merged",
    };
    currentSelectedEnvironmentId = "env-2";
    rerender(<ActionBar />);

    expect(screen.getByTestId("alert-dialog-content").textContent).toContain(
      'environment "feature-env"',
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    await waitFor(() => expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-1"));
  });

  test("keeps the cleanup dialog open with the latest error after repeated failures", async () => {
    deleteEnvironmentMock
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));
    await waitFor(() => expect(findErrorAlert("Failed to delete environment:").textContent)
      .toContain("first failure"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));
    await waitFor(() => expect(findErrorAlert("Failed to delete environment:").textContent)
      .toContain("second failure"));
    expect(screen.getByRole("button", { name: "Delete Environment" })).toBeTruthy();
    expect(deleteEnvironmentMock).toHaveBeenCalledTimes(2);
  });

  test("disables cleanup controls and suppresses duplicates while deletion is pending", async () => {
    let resolveDelete!: () => void;
    deleteEnvironmentMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    const deletingButton = await screen.findByRole("button", { name: "Deleting..." });
    expect((deletingButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(deletingButton);
    expect(deleteEnvironmentMock).toHaveBeenCalledTimes(1);

    resolveDelete();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Deleting..." }) === null).toBe(true));
  });

  test("rehydrates a persisted backend cleanup failure", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      cleanupAfterMergeRequestedAt: "2026-01-02T00:00:00.000Z",
      cleanupAfterMergeError: "persisted cleanup failure",
      deletionRequestedAt: "2026-01-02T00:00:01.000Z",
      lifecycleOperation: "deleting",
    };
    render(<ActionBar />);

    const errorAlert = await waitFor(() => findErrorAlert("Failed to delete environment:"));
    expect(errorAlert.textContent).toContain("persisted cleanup failure");
    expect((screen.getByRole("button", { name: "Delete Environment" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});

describe("ActionBar keyboard shortcuts and tab guards", () => {
  test("dispatches tab, workflow, editor, and panel shortcuts", async () => {
    currentWorkspaceReady = true;
    currentTabCount = 1;
    readContainerFileMock.mockResolvedValueOnce({ content: '{"run":["bun test"]}' });
    render(<ActionBar />);
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled"),
    ).toBe("false"));

    fireEvent.keyDown(window, { key: "3", code: "Digit3", ctrlKey: true });
    fireEvent.keyDown(window, { key: "t", code: "KeyT", metaKey: true });
    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true });
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });
    fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });
    fireEvent.keyDown(window, { key: "p", code: "KeyP", metaKey: true });
    fireEvent.keyDown(window, { key: "o", code: "KeyO", metaKey: true });
    fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true });

    expect(selectTabMock).toHaveBeenCalledWith(2);
    expect(createTabMock).toHaveBeenCalledWith("plain");
    expect(createTabMock).toHaveBeenCalledWith("agent-native");
    expect(createTabMock).not.toHaveBeenCalledWith("claude");
    expect(createTabMock).not.toHaveBeenCalledWith("opencode");
    expect(createTabMock).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Review" }),
    );
    expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] });
    await waitFor(() => expect(openInEditorMock).toHaveBeenCalledWith("container-1", "vscode"));
    expect(closeActiveTabMock).not.toHaveBeenCalled();
    expect(toggleFilesPanelMock).toHaveBeenCalledTimes(1);
  });

  test("reports the tab limit for every tab-creating shortcut", async () => {
    currentTabCount = 9;
    currentWorkspaceReady = true;
    readContainerFileMock.mockResolvedValueOnce({ content: '{"run":["bun test"]}' });
    const { rerender } = render(<ActionBar />);
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled"),
    ).toBe("false"));

    currentTabCount = 10;
    rerender(<ActionBar />);
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Run commands" }).getAttribute("aria-disabled"),
    ).toBe("true"));

    for (const key of ["t", "n", "r", "p"]) {
      toastErrorMock.mockClear();
      const event = createEvent.keyDown(window, {
        key,
        code: `Key${key.toUpperCase()}`,
        metaKey: true,
      });
      fireEvent(window, event);

      expect(event.defaultPrevented).toBe(true);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock).toHaveBeenCalledWith("Tab limit reached", {
        description: "You can have up to 10 tabs open. Close a tab and try again.",
        id: "tab-limit-reached",
      });
    }

    expect(createTabMock).not.toHaveBeenCalled();
    expect(startLoopedReviewMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Code review" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Looped code review" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New terminal tab" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("falls back to the built-in review prompt for malformed config state", async () => {
    currentReviewPrompt = 123 as never;
    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });

    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/^codex\u0000env-env-1:tab-/),
      "env-1",
      expect.objectContaining({
        text: expect.stringContaining("Security and instruction hierarchy"),
      }),
    ));
  });
});

describe("ActionBar merge completion", () => {
  test("leaves merge persistence and task reconciliation to the backend", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
    };
    currentTaskAssociation = {
      task: { prMergeCommented: false },
      taskId: "task-1",
    };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    await waitFor(() => {
      expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
        "env-1",
        "squash",
        true,
        false,
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("Branch merged", {
        description: "feature/very-long-error",
        id: "branch-merged-env-1",
      });
    });
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
    expect(setEnvironmentPRStoreMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  test("keeps pending merges open without recording merge completion", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    currentTaskAssociation = {
      task: { prMergeCommented: false },
      taskId: "task-1",
    };
    mergeEnvironmentPrMock.mockResolvedValueOnce({
      outcome: "pending",
      cleanupOutcome: "not-requested",
    });
    render(<ActionBar />);

    confirmMerge();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Merge pending", {
      description: "feature/very-long-error",
      id: "branch-merge-submitted-env-1",
    }));
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
    expect(setEnvironmentPRStoreMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  test("monitors an unconfirmed merge submission without recording merge completion", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    currentTaskAssociation = {
      task: { prMergeCommented: false },
      taskId: "task-1",
    };
    mergeEnvironmentPrMock.mockResolvedValueOnce({
      outcome: "unknown",
      cleanupOutcome: "not-requested",
    });
    render(<ActionBar />);

    confirmMerge();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Merge submitted", {
      description: "feature/very-long-error",
      id: "branch-merge-submitted-env-1",
    }));
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
    expect(setEnvironmentPRStoreMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  test("keeps completion presentation tied to the initiating environment after selection changes", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    let resolveMerge!: (outcome: MergeOutcome) => void;
    mergeEnvironmentPrMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMerge = resolve;
    }));
    const { rerender } = render(<ActionBar />);
    confirmMerge();
    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledTimes(1));

    currentEnvironment = {
      ...selectedEnvironment,
      id: "env-2",
      branch: "feature/second",
      containerId: "container-2",
      prUrl: "https://github.com/org/repo/pull/2",
      prState: "open",
    };
    currentSelectedEnvironmentId = "env-2";
    rerender(<ActionBar />);
    resolveMerge({ outcome: "merged", cleanupOutcome: "not-requested" });

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Branch merged", {
      description: "feature/very-long-error",
      id: "branch-merged-env-1",
    }));
  });

  test("dispatches durable cleanup intent before the initiating action bar unmounts", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    let resolveMerge!: (outcome: MergeOutcome) => void;
    mergeEnvironmentPrMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMerge = resolve;
    }));
    const { unmount } = render(<ActionBar />);
    confirmMergeAndCleanup();
    await waitFor(() => expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      true,
    ));

    unmount();
    resolveMerge({ outcome: "merged", cleanupOutcome: "completed" });
    await Promise.resolve();
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
  });

  test("disables a newly visible cleanup action while backend merge cleanup is active", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "merged",
      lifecycleOperation: "merging",
    };
    render(<ActionBar />);

    const cleanupButton = screen.getByRole("button", { name: "Clean Up" }) as HTMLButtonElement;
    expect(cleanupButton.disabled).toBe(true);
    fireEvent.click(cleanupButton);
    expect(screen.queryByRole("button", { name: "Delete Environment" }) === null).toBe(true);
  });
});

describe("ActionBar error dialogs", () => {
  test("keeps cleanup errors constrained and scrollable", async () => {
    deleteEnvironmentMock.mockRejectedValueOnce(new Error(longError("delete failed")));

    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    const errorAlert = await waitFor(() => findErrorAlert("Failed to delete environment:"));
    const dialogContent = screen.getByTestId("alert-dialog-content");

    expect(dialogContent.className).toContain("max-h-[calc(100vh-2rem)]");
    expect(dialogContent.className).toContain("overflow-hidden");
    expect(errorAlert.className).toContain("max-h-[min(16rem,40vh)]");
    expect(errorAlert.className).toContain("overflow-y-auto");
    expect(errorAlert.className).toContain("overflow-x-hidden");
    expect(errorAlert.className).toContain("whitespace-pre-wrap");
    expect(errorAlert.className).toContain("break-words");
    expect(errorAlert.className).toContain("[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    expect(screen.queryByText(
      (_content, element) =>
        element?.textContent?.startsWith("Failed to delete environment:") ?? false,
    ) === null).toBe(true);
  });

  test("uses generic cleanup guidance for non-Error rejections", async () => {
    deleteEnvironmentMock.mockRejectedValueOnce({ reason: "backend disconnected" });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Clean Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Environment" }));

    const errorAlert = await waitFor(() => findErrorAlert("Failed to delete environment:"));
    expect(errorAlert.textContent).toContain(
      "Failed to delete environment: An unexpected error occurred",
    );
  });

  test("keeps merge errors constrained and scrollable", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
    };
    mergeEnvironmentPrMock.mockRejectedValueOnce(longError("merge failed"));

    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    const errorAlert = await waitFor(() => findErrorAlert("Failed to merge PR:"));
    const dialogContent = screen.getByTestId("alert-dialog-content");

    expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      false,
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(dialogContent.className).toContain("max-h-[calc(100vh-2rem)]");
    expect(dialogContent.className).toContain("overflow-hidden");
    expect(errorAlert.className).toContain("max-h-[min(16rem,40vh)]");
    expect(errorAlert.className).toContain("overflow-y-auto");
    expect(errorAlert.className).toContain("overflow-x-hidden");
    expect(errorAlert.className).toContain("whitespace-pre-wrap");
    expect(errorAlert.className).toContain("break-words");
    expect(errorAlert.className).toContain("[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    expect(screen.queryByText(
      (_content, element) =>
        element?.textContent?.startsWith("Failed to merge PR:") ?? false,
    ) === null).toBe(true);
  });

  test("reports a local merge failure without a success toast", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/feature-env",
      prState: "open",
    };
    mergeEnvironmentPrMock.mockRejectedValueOnce(new Error("local merge failed"));
    render(<ActionBar />);

    confirmMerge();

    const errorAlert = await waitFor(() => findErrorAlert("Failed to merge PR:"));
    expect(errorAlert.textContent).toContain("local merge failed");
    expect(mergeEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      "squash",
      true,
      false,
    );
    expect(mergePrLocalMock).not.toHaveBeenCalled();
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
  });

  test("uses generic merge guidance for unknown rejection values", async () => {
    currentEnvironment = { ...selectedEnvironment, prState: "open" };
    mergeEnvironmentPrMock.mockRejectedValueOnce({ reason: "unknown backend failure" });
    render(<ActionBar />);

    confirmMerge();

    const errorAlert = await waitFor(() => findErrorAlert("Failed to merge PR:"));
    expect(errorAlert.textContent).toContain("Failed to merge PR: An unexpected error occurred");
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(setEnvironmentPrBackendMock).not.toHaveBeenCalled();
  });
});
