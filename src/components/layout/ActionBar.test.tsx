import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import * as realContextMenu from "@/components/ui/context-menu";
import * as realTooltip from "@/components/ui/tooltip";
import * as realSettings from "@/components/settings";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import * as realDockerComponents from "@/components/docker";
import * as realStores from "@/stores";
import * as realHooks from "@/hooks";
import * as realContexts from "@/contexts";
import * as realTauri from "@/lib/tauri";
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
const realTauriSnapshot = { ...realTauri };

const deleteEnvironmentMock = mock(async (_environmentId: string) => {});
const mergePrMock = mock(async (_containerId: string, _method: string, _deleteBranch: boolean) => {});
const mergePrLocalMock = mock(async (_environmentId: string, _method: string, _deleteBranch: boolean) => {});
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

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
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} type="button">{children}</button>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
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
        changes: [],
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
    selectedEnvironmentId: string;
    selectedProjectId: string;
  }) => T) =>
    selectState(
      {
        selectedEnvironmentId: currentEnvironment.id,
        selectedProjectId: selectedProject.id,
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
    createTab: () => {},
    selectTab: () => {},
    tabCount: 0,
  }),
}));

mock.module("@/lib/tauri", () => ({
  mergePr: mergePrMock,
  mergePrLocal: mergePrLocalMock,
  openInEditor: async () => {},
  openLocalInEditor: async () => {},
  readContainerFile: async () => ({ content: "{}" }),
  readLocalFile: async () => ({ content: "{}" }),
  recreateEnvironment: async () => {},
  setEnvironmentPr: async () => {},
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
  mock.module("@/lib/tauri", () => realTauriSnapshot);
});

beforeEach(() => {
  cleanup();
  console.error = mock(() => {}) as typeof console.error;
  console.log = mock(() => {}) as typeof console.log;
  deleteEnvironmentMock.mockReset();
  mergePrMock.mockReset();
  mergePrLocalMock.mockReset();
  currentEnvironment = { ...selectedEnvironment };
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
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
