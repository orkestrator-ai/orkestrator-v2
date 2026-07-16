import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import * as realSonner from "sonner";
import type { Environment, Project } from "@/types";

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
const realSonnerSnapshot = { ...realSonner };

const deleteEnvironmentMock = mock(async (_environmentId: string) => {});
const mergePrMock = mock(async (_containerId: string, _method: string, _deleteBranch: boolean) => {});
const mergePrLocalMock = mock(async (_environmentId: string, _method: string, _deleteBranch: boolean) => {});
const openInEditorMock = mock(async (_containerId: string, _editor: string) => {});
const openLocalInEditorMock = mock(async (_worktreePath: string, _editor: string) => {});
const readContainerFileMock = mock(async (_containerId: string, _path: string) => ({ content: "{}" }));
const readLocalFileMock = mock(async (_worktreePath: string, _path: string) => ({ content: "{}" }));
const setEnvironmentPrBackendMock = mock(async (
  _environmentId: string,
  _prUrl: string,
  _prState: string,
  _hasMergeConflicts: boolean,
) => {});
const setEnvironmentPRStoreMock = mock(() => {});
const createTabMock = mock((_agent: string, _options?: unknown) => {});
const selectTabMock = mock((_index: number) => {});
const closeActiveTabMock = mock(() => {});
const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});
const setProjectBoardTabMock = mock((_tab: string) => {});
const setProjectBoardNotesOpenMock = mock((_open: boolean) => {});
const toggleFilesPanelMock = mock(() => {});
const addCommentMock = mock(async (_taskId: string, _body: string) => {});
const updateTaskMock = mock(async (_taskId: string, _updates: unknown) => {});
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
let currentSelectedProjectId: string | null = selectedProject.id;
let currentProjectBoardTab: "kanban" | "linear" | "features" = "kanban";
let currentChanges: unknown[] = [];
let currentFilesPanelOpen = false;
let currentWorkspaceReady = false;
let currentSetupScriptsRunning = false;
let currentTabCount = 0;
let currentTaskAssociation: {
  task: { prMergeCommented?: boolean } | undefined;
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
  AlertDialogAction: ({
    children,
    className,
    disabled,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button className={className} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
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
  RepositorySettings: () => null,
  SettingsPage: () => null,
}));

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: () => null,
}));

mock.module("@/components/docker", () => ({
  DockerStatsDialog: () => null,
}));

mock.module("@/stores", () => ({
  useConfigStore: <T,>(selector?: (state: {
    config: {
      global: { defaultAgent: "codex"; preferredEditor: "vscode" };
      repositories: Record<string, { prBaseBranch?: string }>;
    };
  }) => T) =>
    selectState(
      {
        config: {
          global: { defaultAgent: "codex" as const, preferredEditor: "vscode" as const },
          repositories: { "project-1": { prBaseBranch: "main" } },
        },
      },
      selector,
    ),
  useEnvironmentStore: <T,>(selector?: (state: {
    getEnvironmentById: (environmentId: string) => Environment | undefined;
    updateEnvironment: () => void;
    isWorkspaceReady: () => boolean;
    isSetupScriptsRunning: () => boolean;
    setEnvironmentPR: () => void;
  }) => T) =>
    selectState(
      {
        getEnvironmentById: (environmentId: string) =>
          environmentId === currentEnvironment.id ? currentEnvironment : undefined,
        updateEnvironment: () => {},
        isWorkspaceReady: () => currentWorkspaceReady,
        isSetupScriptsRunning: () => currentSetupScriptsRunning,
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
    getProjectById: (projectId: string) => Project | undefined;
  }) => T) =>
    selectState(
      {
        getProjectById: (projectId: string) =>
          projectId === selectedProject.id ? selectedProject : undefined,
      },
      selector,
    ),
  useUIStore: <T,>(selector?: (state: {
    selectedEnvironmentId: string | null;
    selectedProjectId: string | null;
    projectBoardTab: "kanban" | "linear" | "features";
    setProjectBoardTab: (tab: "kanban" | "linear" | "features") => void;
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
}));

mock.module("@/hooks", () => ({
  useEnvironments: () => ({
    deleteEnvironment: deleteEnvironmentMock,
  }),
  useProjects: () => ({
    updateProject: () => Promise.resolve(),
  }),
  usePullRequest: () => ({
    prUrl: currentEnvironment.prUrl,
    prState: currentEnvironment.prState,
    hasMergeConflicts: currentEnvironment.hasMergeConflicts,
    viewPR: () => {},
    setModeCreatePending: () => {},
  }),
}));

mock.module("@/contexts", () => ({
  MAX_TABS: 10,
  useTerminalContext: () => ({
    closeActiveTab: closeActiveTabMock,
    createTab: createTabMock,
    selectTab: selectTabMock,
    tabCount: currentTabCount,
  }),
}));

mock.module("@/lib/backend", () => ({
  mergePr: mergePrMock,
  mergePrLocal: mergePrLocalMock,
  openInEditor: openInEditorMock,
  openLocalInEditor: openLocalInEditorMock,
  readContainerFile: readContainerFileMock,
  readLocalFile: readLocalFileMock,
  recreateEnvironment: async () => {},
  setEnvironmentPr: setEnvironmentPrBackendMock,
}));

mock.module("@/stores/kanbanStore", () => ({
  useKanbanStore: {
    getState: () => ({
      addComment: addCommentMock,
      updateTask: updateTaskMock,
    }),
  },
  findTaskForEnvironment: () => currentTaskAssociation,
}));

mock.module("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
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
  mock.module("sonner", () => realSonnerSnapshot);
});

beforeEach(() => {
  cleanup();
  console.error = mock(() => {}) as typeof console.error;
  console.log = mock(() => {}) as typeof console.log;
  console.warn = mock(() => {}) as typeof console.warn;
  deleteEnvironmentMock.mockReset();
  mergePrMock.mockReset();
  mergePrLocalMock.mockReset();
  openInEditorMock.mockReset();
  openLocalInEditorMock.mockReset();
  readContainerFileMock.mockReset();
  readLocalFileMock.mockReset();
  setEnvironmentPrBackendMock.mockReset();
  setEnvironmentPRStoreMock.mockReset();
  createTabMock.mockReset();
  selectTabMock.mockReset();
  closeActiveTabMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  setProjectBoardTabMock.mockReset();
  setProjectBoardNotesOpenMock.mockReset();
  toggleFilesPanelMock.mockReset();
  addCommentMock.mockReset();
  updateTaskMock.mockReset();
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
  currentProjectBoardTab = "kanban";
  currentChanges = [];
  currentFilesPanelOpen = false;
  currentWorkspaceReady = false;
  currentSetupScriptsRunning = false;
  currentTabCount = 0;
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

    expect(screen.queryByText("Docker configuration")).toBeNull();
  });

  test("does not show regular or context-menu tooltips on mobile pointer hover", async () => {
    render(<ActionBar presentation="grid" />);

    const dockerButton = screen.getByRole("button", { name: "Docker configuration" });
    const claudeButton = screen.getByRole("button", { name: "New tab with Claude" });
    fireEvent.mouseEnter(dockerButton.parentElement!);
    fireEvent.mouseEnter(claudeButton);
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(screen.queryByText("Docker configuration")).toBeNull();
    expect(screen.queryByText("New Tab with Claude")).toBeNull();
  });

  test("keeps context-menu tooltips enabled in the desktop bar", async () => {
    render(<ActionBar />);

    const claudeButton = screen.getByRole("button", { name: "New tab with Claude" });
    fireEvent.mouseEnter(claudeButton);

    await waitFor(() => {
      expect(screen.getByText("New Tab with Claude")).toBeTruthy();
    });

    fireEvent.mouseLeave(claudeButton);
    await waitFor(() => {
      expect(screen.queryByText("New Tab with Claude")).toBeNull();
    });

    fireEvent.focus(claudeButton);
    await waitFor(() => {
      expect(screen.getByText("New Tab with Claude")).toBeTruthy();
    });
    fireEvent.blur(claudeButton);
    await waitFor(() => {
      expect(screen.queryByText("New Tab with Claude")).toBeNull();
    });
  });

  test("renders mobile tools as two columns with labels after their icons", () => {
    const { container } = render(<ActionBar presentation="grid" />);

    const toolbar = container.querySelector("[data-presentation='grid']");
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelectorAll(".grid-cols-2").length).toBeGreaterThanOrEqual(2);

    const globalSettings = screen.getByRole("button", { name: "Global settings" });
    const claude = screen.getByRole("button", { name: "New tab with Claude" });
    expect(globalSettings.lastElementChild?.textContent).toBe("Global settings");
    expect(claude.lastElementChild?.textContent).toBe("New Claude tab");
  });

  test("keeps project and environment tools visible but disabled in the empty state", () => {
    currentSelectedProjectId = null;
    currentSelectedEnvironmentId = null;
    render(<ActionBar presentation="grid" />);

    expect(screen.getByRole("button", { name: "Global settings" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Repository settings" }).hasAttribute("disabled")).toBe(true);
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
    fireEvent.click(screen.getByRole("button", { name: "Linear pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: "Features" }));

    expect(setProjectBoardNotesOpenMock).toHaveBeenCalledWith(true);
    expect(setProjectBoardTabMock.mock.calls.map(([tab]) => tab)).toEqual([
      "kanban",
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
      expect(screen.queryByText("Ctrl⇧C")).toBeNull();
    });

    fireEvent.keyDown(window, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });

    expect(writeTextMock).not.toHaveBeenCalled();
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
    expect(screen.queryByText("Failed to Open Editor")).toBeNull();
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

  test("creates an agent-authored run script from the context menu", () => {
    render(<ActionBar />);

    const runButton = screen.getByRole("button", { name: "Run commands" });
    fireEvent.contextMenu(runButton);
    fireEvent.click(screen.getByRole("button", { name: "Create Script with Claude" }));

    expect(createTabMock).toHaveBeenCalledWith("claude", {
      initialPrompt: expect.any(String),
    });
  });
});

describe("ActionBar toolbar interactions", () => {
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
    const claudeButton = screen.getByRole("button", { name: "New tab with Claude" });
    const claudeLabel = Array.from(claudeButton.querySelectorAll("span")).find(
      (element) => element.textContent === "New Claude tab",
    )!;

    expect(fireEvent.contextMenu(globalSettings)).toBe(false);
    expect(fireEvent.contextMenu(globalSettingsIcon)).toBe(true);
    fireEvent.contextMenu(claudeLabel);

    expect(screen.getByRole("button", { name: "Claude Tmux" })).toBeTruthy();
    expect(container.querySelector("[data-mobile-toolbar]")).toBeTruthy();
  });

  test("handles numeric, tab creation, close, and file-panel shortcuts", () => {
    currentTabCount = 1;
    render(<ActionBar />);

    fireEvent.keyDown(window, { key: "3", code: "Digit3", ctrlKey: true });
    fireEvent.keyDown(window, { key: "4", code: "", ctrlKey: true });
    fireEvent.keyDown(window, { key: "t", code: "KeyT", metaKey: true });
    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true });
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });
    fireEvent.keyDown(window, { key: "w", code: "KeyW", metaKey: true });
    fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true });

    expect(selectTabMock.mock.calls.map(([index]) => index)).toEqual([2, 3]);
    expect(createTabMock).toHaveBeenCalledWith("plain");
    expect(createTabMock).toHaveBeenCalledWith("claude");
    expect(createTabMock).toHaveBeenCalledWith("opencode");
    expect(closeActiveTabMock).toHaveBeenCalledTimes(1);
    expect(toggleFilesPanelMock).toHaveBeenCalledTimes(1);
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
  test("shows the desktop empty-state guidance without a selected project", () => {
    currentSelectedProjectId = null;
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    expect(screen.getByText("Select an environment to get started")).toBeTruthy();
  });

  test("shows project board tabs in the top bar when no environment is selected", () => {
    currentSelectedEnvironmentId = null;

    render(<ActionBar />);

    expect(screen.queryByText("repo")).toBeNull();
    const notesButton = screen.getByRole("button", { name: "Project Notes" });
    const kanbanTab = screen.getByRole("tab", { name: "Kanban" });
    expect(kanbanTab).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Project Notes" })).toBeNull();
  });

  test("agent context menu items pass one-shot launch mode overrides", () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    };

    const { container } = render(<ActionBar />);
    const customMenuTriggers = container.querySelectorAll("[data-toolbar-custom-context-menu='true']");

    expect(screen.queryByRole("button", { name: "Claude Tmux" })).toBeNull();

    fireEvent.contextMenu(customMenuTriggers[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Claude Tmux" }));
    expect(createTabMock).toHaveBeenLastCalledWith("claude", { agentLaunchMode: "tmux" });

    fireEvent.contextMenu(customMenuTriggers[2]!);
    fireEvent.click(screen.getByRole("button", { name: "Codex Native" }));
    expect(createTabMock).toHaveBeenLastCalledWith("codex", { agentLaunchMode: "native" });

    fireEvent.contextMenu(customMenuTriggers[1]!);
    fireEvent.click(screen.getByRole("button", { name: "OpenCode CLI" }));
    expect(createTabMock).toHaveBeenLastCalledWith("opencode", { agentLaunchMode: "cli" });
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

  test("names PR, conflict, and push workflow tabs", () => {
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

    expect(createTabMock).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ displayTitle: "Conflict" }),
    );

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
});

describe("ActionBar merge completion", () => {
  test("merges a container PR, persists state, and comments on its task", async () => {
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
      expect(mergePrMock).toHaveBeenCalledWith("container-1", "squash", true);
      expect(setEnvironmentPrBackendMock).toHaveBeenCalledWith(
        "env-1",
        "https://github.com/org/repo/pull/1",
        "merged",
        false,
      );
      expect(setEnvironmentPRStoreMock).toHaveBeenCalledWith(
        "env-1",
        "https://github.com/org/repo/pull/1",
        "merged",
        false,
      );
      expect(addCommentMock).toHaveBeenCalledWith("task-1", "🎉 PR merged");
      expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
        prState: "merged",
        prMergeCommented: true,
      });
    });
  });

  test("merges a local PR through the environment-scoped backend", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/feature-env",
      prState: "open",
    };
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    await waitFor(() => {
      expect(mergePrLocalMock).toHaveBeenCalledWith("env-1", "squash", true);
    });
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  test("keeps a successful merge complete when state persistence and task comments fail", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
    };
    currentTaskAssociation = {
      task: { prMergeCommented: false },
      taskId: "task-1",
    };
    setEnvironmentPrBackendMock.mockRejectedValueOnce(new Error("save failed"));
    addCommentMock.mockRejectedValueOnce(new Error("comment failed"));
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    await waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        "[ActionBar] Failed to save merged state:",
        expect.any(Error),
      );
      expect(console.warn).toHaveBeenCalledWith(
        "[ActionBar] Failed to add PR merged comment:",
        expect.any(Error),
      );
    });
    expect(mergePrMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).not.toHaveBeenCalled();
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
    )).toBeNull();
  });

  test("keeps merge errors constrained and scrollable", async () => {
    currentEnvironment = {
      ...selectedEnvironment,
      prState: "open",
    };
    mergePrMock.mockRejectedValueOnce(longError("merge failed"));

    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge PR" }).at(-1)!);

    const errorAlert = await waitFor(() => findErrorAlert("Failed to merge PR:"));
    const dialogContent = screen.getByTestId("alert-dialog-content");

    expect(mergePrMock).toHaveBeenCalledWith("container-1", "squash", true);
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
    )).toBeNull();
  });
});
