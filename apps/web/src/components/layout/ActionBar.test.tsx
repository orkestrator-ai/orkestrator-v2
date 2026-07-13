import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const realSonnerSnapshot = { ...realSonner };

const deleteEnvironmentMock = mock(async (_environmentId: string) => {});
const mergePrMock = mock(async (_containerId: string, _method: string, _deleteBranch: boolean) => {});
const mergePrLocalMock = mock(async (_environmentId: string, _method: string, _deleteBranch: boolean) => {});
const createTabMock = mock((_agent: string, _options?: unknown) => {});
const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});
const setProjectBoardTabMock = mock((_tab: string) => {});
const setProjectBoardNotesOpenMock = mock((_open: boolean) => {});
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
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

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="alert-dialog-root">{children}</div> : null,
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
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} type="button">
      {children}
    </button>
  ),
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
        isWorkspaceReady: () => false,
        isSetupScriptsRunning: () => false,
        setEnvironmentPR: () => {},
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
        isOpen: false,
        togglePanel: () => {},
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
    closeActiveTab: () => {},
    createTab: createTabMock,
    selectTab: () => {},
    tabCount: 0,
  }),
}));

mock.module("@/lib/backend", () => ({
  mergePr: mergePrMock,
  mergePrLocal: mergePrLocalMock,
  openInEditor: async () => {},
  openLocalInEditor: async () => {},
  readContainerFile: async () => ({ content: "{}" }),
  readLocalFile: async () => ({ content: "{}" }),
  recreateEnvironment: async () => {},
  setEnvironmentPr: async () => {},
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
  mock.module("sonner", () => realSonnerSnapshot);
});

beforeEach(() => {
  cleanup();
  console.error = mock(() => {}) as typeof console.error;
  console.log = mock(() => {}) as typeof console.log;
  deleteEnvironmentMock.mockReset();
  mergePrMock.mockReset();
  mergePrLocalMock.mockReset();
  createTabMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  setProjectBoardTabMock.mockReset();
  setProjectBoardNotesOpenMock.mockReset();
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
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

describe("ActionBar grid presentation", () => {
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
        <div className="xterm" tabIndex={0} />
        <ActionBar />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText("Message"), {
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

describe("ActionBar workflow tabs", () => {
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

    expect(screen.getByRole("tab", { name: "Linear" }).getAttribute("aria-selected")).toBe("true");
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
  });
});
