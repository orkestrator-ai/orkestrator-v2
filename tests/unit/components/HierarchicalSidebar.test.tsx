import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { mockReadImage } from "../../mocks/clipboard";
import { useClaudeOptionsStore, useConfigStore, useUIStore } from "@/stores";
import type { Environment, Project } from "@/types";

import * as realDndCore from "@dnd-kit/core";
import * as realUseProjects from "@/hooks/useProjects";
import * as realUseEnvironments from "@/hooks/useEnvironments";
import * as realUseEnvironmentDiffStats from "@/hooks/useEnvironmentDiffStats";
import * as realBackend from "@/lib/backend";

const realDndCoreSnapshot = { ...realDndCore };
const realUseProjectsSnapshot = { ...realUseProjects };
const realUseEnvironmentsSnapshot = { ...realUseEnvironments };
const realUseEnvironmentDiffStatsSnapshot = { ...realUseEnvironmentDiffStats };
const realBackendSnapshot = { ...realBackend };

const project: Project = {
  id: "project-1",
  name: "Project One",
  gitUrl: "https://github.com/acme/project-one.git",
  localPath: null,
  addedAt: "2024-01-01T00:00:00.000Z",
  order: 0,
};

const createdEnvironment: Environment = {
  id: "env-created",
  projectId: "project-1",
  name: "env-created",
  branch: "main",
  containerId: "container-created",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
};

const createEnvironmentMock = mock(async () => createdEnvironment);
const updateEnvironmentAgentSettingsMock = mock(async () => createdEnvironment);
const renameEnvironmentFromPromptMock = mock(async () => {});
const updateEnvironmentMock = mock(() => {});
const startEnvironmentMock = mock(async () => undefined);
const loadEnvironmentsMock = mock(async () => {});
const deleteEnvironmentMock = mock(async () => {});
const stopEnvironmentMock = mock(async () => {});
const restartEnvironmentMock = mock(async () => {});
const reorderEnvironmentsMock = mock(async () => {});
const addProjectMock = mock(async () => {});
const removeProjectMock = mock(async () => {});
const updateProjectMock = mock(async () => {});
const reorderProjectsMock = mock(async () => {});
let projectsValue: Project[] = [project];
let environmentsValue: Environment[] = [];
let projectsLoadingValue = false;
type DndContextProps = ComponentProps<typeof realDndCore.DndContext>;
let dndContextProps: DndContextProps | null = null;

mock.module("@dnd-kit/core", () => ({
  ...realDndCoreSnapshot,
  DndContext: (props: DndContextProps) => {
    dndContextProps = props;
    return createElement(realDndCoreSnapshot.DndContext, props);
  },
}));

mock.module("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: projectsValue,
    addProject: addProjectMock,
    removeProject: removeProjectMock,
    updateProject: updateProjectMock,
    reorderProjects: reorderProjectsMock,
    validateGitUrl: mock(async () => true),
    isLoading: projectsLoadingValue,
  }),
}));

mock.module("@/hooks/useEnvironments", () => ({
  useEnvironments: () => ({
    allEnvironments: environmentsValue,
    loadEnvironments: loadEnvironmentsMock,
    createEnvironment: createEnvironmentMock,
    deleteEnvironment: deleteEnvironmentMock,
    startEnvironment: startEnvironmentMock,
    stopEnvironment: stopEnvironmentMock,
    restartEnvironment: restartEnvironmentMock,
    reorderEnvironments: reorderEnvironmentsMock,
    updateEnvironment: updateEnvironmentMock,
  }),
}));

mock.module("@/hooks/useEnvironmentDiffStats", () => ({
  useEnvironmentDiffStats: mock(() => {}),
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  renameEnvironmentFromPrompt: renameEnvironmentFromPromptMock,
  updateEnvironmentAgentSettings: updateEnvironmentAgentSettingsMock,
}));

const {
  HierarchicalSidebar,
  deleteProjectAndEnvironments,
  resolveSidebarReorder,
  resolveSidebarSelection,
} = await import("../../../apps/web/src/components/sidebar/HierarchicalSidebar");

afterAll(() => {
  mock.module("@dnd-kit/core", () => realDndCoreSnapshot);
  mock.module("@/hooks/useProjects", () => realUseProjectsSnapshot);
  mock.module("@/hooks/useEnvironments", () => realUseEnvironmentsSnapshot);
  mock.module("@/hooks/useEnvironmentDiffStats", () => realUseEnvironmentDiffStatsSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalReload = window.location.reload;

describe("HierarchicalSidebar", () => {
  beforeEach(() => {
    cleanup();
    createEnvironmentMock.mockClear();
    updateEnvironmentAgentSettingsMock.mockClear();
    renameEnvironmentFromPromptMock.mockClear();
    updateEnvironmentMock.mockClear();
    startEnvironmentMock.mockClear();
    loadEnvironmentsMock.mockClear();
    deleteEnvironmentMock.mockClear();
    stopEnvironmentMock.mockClear();
    restartEnvironmentMock.mockClear();
    reorderEnvironmentsMock.mockClear();
    addProjectMock.mockClear();
    removeProjectMock.mockClear();
    updateProjectMock.mockClear();
    reorderProjectsMock.mockClear();
    projectsValue = [project];
    environmentsValue = [];
    projectsLoadingValue = false;
    dndContextProps = null;
    mockReadImage.mockReset();
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: mock(() => {}),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;

    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });
    useUIStore.setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      collapsedProjects: [],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      zoomLevel: 100,
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          defaultAgent: "claude",
          claudeMode: "terminal",
          opencodeMode: "terminal",
          codexMode: "native",
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    }));
  });

  afterEach(() => {
    cleanup();
    window.location.reload = originalReload;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  });

  test("renders the active server switcher in the sidebar header", async () => {
    const originalApi = window.orkestrator;
    window.orkestrator = {
      ...(originalApi ?? {}),
      connections: {
        list: mock(async () => ({
          activeConnectionId: "local",
          connections: [{ id: "local", name: "Local", address: null, kind: "local" as const, active: true, requiresToken: false }],
        })),
        connect: mock(async () => ({ activeConnectionId: "local", connections: [] })),
        use: mock(async () => ({ activeConnectionId: "local", connections: [] })),
        forget: mock(async () => ({ activeConnectionId: "local", connections: [] })),
      },
    } as Window["orkestrator"];
    try {
      render(<HierarchicalSidebar />);
      expect(await screen.findByRole("button", { name: "Connected server: Local" })).toBeTruthy();
    } finally {
      cleanup();
      window.orkestrator = originalApi;
    }
  });

  test("reloads the workspace from the refresh button", () => {
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;

    render(<HierarchicalSidebar />);

    const refreshButton = screen.getByRole("button", {
      name: "Refresh projects, environments, tabs, and layout",
    });
    const addProjectButton = screen.getByTitle("Add project");
    expect(refreshButton.compareDocumentPosition(addProjectButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(refreshButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("renders distinct loading and empty project states", () => {
    projectsValue = [];
    projectsLoadingValue = true;
    const loadingView = render(<HierarchicalSidebar />);
    expect(screen.getByText("Loading projects...")).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();

    loadingView.unmount();
    projectsLoadingValue = false;
    render(<HierarchicalSidebar />);
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add your first project" })).toBeTruthy();
  });

  test("clears multi-selection only when Escape is pressed", () => {
    environmentsValue = [
      { ...createdEnvironment, id: "env-1", name: "Environment One" },
      { ...createdEnvironment, id: "env-2", name: "Environment Two" },
    ];
    useUIStore.setState({ selectedEnvironmentIds: ["env-1", "env-2"] });
    render(<HierarchicalSidebar />);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-1", "env-2"]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual([]);
  });

  test("propagates initial prompt image attachments into launch options", async () => {
    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByTitle("Create environment"));

    const prompt = await screen.findByLabelText(/Initial Prompt/i);
    prompt.focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await screen.findByAltText(/initial-prompt-/);

    fireEvent.change(prompt, {
      target: { value: "Use this screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(createEnvironmentMock).toHaveBeenCalledWith(
        "project-1",
        undefined,
        "full",
        "Use this screenshot",
        undefined,
        "containerized",
      );
      expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled();
      expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith("env-created", "Use this screenshot");
      expect(startEnvironmentMock).toHaveBeenCalledWith("env-created", "Use this screenshot");
      expect(useClaudeOptionsStore.getState().getOptions("env-created")).toEqual(
        expect.objectContaining({
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Use this screenshot",
          initialPromptAttachments: [
            expect.objectContaining({
              base64Data: "QUJD",
              previewUrl: "data:image/png;base64,QUJD",
              name: expect.stringMatching(/^initial-prompt-.*\.png$/),
            }),
          ],
        }),
      );
    });
  });

  test("closes the create dialog before auto-start finishes", async () => {
    let resolveStart: (() => void) | undefined;
    startEnvironmentMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByTitle("Create environment"));
    await screen.findByText("Create Ork (Environment)");

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled();
      expect(renameEnvironmentFromPromptMock).not.toHaveBeenCalled();
      expect(startEnvironmentMock).toHaveBeenCalledWith("env-created", "");
      expect(screen.queryByText("Create Ork (Environment)")).toBeNull();
    });

    resolveStart?.();
  });

  test("auto-starts while initial-prompt rename is still running", async () => {
    let resolveRename: (() => void) | undefined;
    renameEnvironmentFromPromptMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );

    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByTitle("Create environment"));
    const prompt = await screen.findByLabelText(/Initial Prompt/i);
    fireEvent.change(prompt, { target: { value: "Implement billing exports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(startEnvironmentMock).toHaveBeenCalledWith("env-created", "Implement billing exports");
      expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith("env-created", "Implement billing exports");
      expect(screen.queryByText("Create Ork (Environment)")).toBeNull();
    });

    resolveRename?.();
  });

  test("starts the environment when initial-prompt rename fails", async () => {
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as unknown as typeof console.error;
    renameEnvironmentFromPromptMock.mockImplementationOnce(async () => {
      throw new Error("codex unavailable");
    });

    try {
      render(<HierarchicalSidebar />);

      fireEvent.click(screen.getByTitle("Create environment"));
      const prompt = await screen.findByLabelText(/Initial Prompt/i);
      fireEvent.change(prompt, { target: { value: "Use fallback startup" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

      await waitFor(() => {
        expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith("env-created", "Use fallback startup");
        expect(startEnvironmentMock).toHaveBeenCalledWith("env-created", "Use fallback startup");
      });
      expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to rename environment from initial prompt:",
        expect.any(Error),
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("keeps the create dialog open when environment creation fails", async () => {
    createEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("create failed");
    });
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      render(<HierarchicalSidebar />);
      fireEvent.click(screen.getByTitle("Create environment"));
      fireEvent.click(await screen.findByRole("button", { name: "Create Environment" }));

      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to create environment:", expect.any(Error),
      ));
      expect(screen.getByText("Create Ork (Environment)")).toBeTruthy();
      expect(updateEnvironmentAgentSettingsMock).not.toHaveBeenCalled();
      expect(startEnvironmentMock).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("does not select or start a partially configured environment", async () => {
    updateEnvironmentAgentSettingsMock.mockImplementationOnce(async () => {
      throw new Error("settings failed");
    });
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      render(<HierarchicalSidebar />);
      fireEvent.click(screen.getByTitle("Create environment"));
      fireEvent.click(await screen.findByRole("button", { name: "Create Environment" }));

      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to create environment:", expect.any(Error),
      ));
      expect(createEnvironmentMock).toHaveBeenCalledTimes(1);
      expect(updateEnvironmentMock).not.toHaveBeenCalled();
      expect(startEnvironmentMock).not.toHaveBeenCalled();
      expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
      expect(screen.getByText("Create Ork (Environment)")).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("closes the dialog but skips prompt renaming when auto-start fails", async () => {
    startEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("start failed");
    });
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      render(<HierarchicalSidebar />);
      fireEvent.click(screen.getByTitle("Create environment"));
      const prompt = await screen.findByLabelText(/Initial Prompt/i);
      fireEvent.change(prompt, { target: { value: "Rename after startup" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to auto-start environment:", expect.any(Error),
      ));
      expect(screen.queryByText("Create Ork (Environment)")).toBeNull();
      expect(renameEnvironmentFromPromptMock).not.toHaveBeenCalled();
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-created");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("highlights the project header when the project is selected without an environment", () => {
    useUIStore.setState({ selectedProjectId: "project-1", selectedEnvironmentId: null });

    render(<HierarchicalSidebar />);

    const header = getProjectHeader(screen.getByRole("button", { name: /Project One/i }));
    expect(header.className).toContain("bg-zinc-800/85");
    expect(header.className).toContain("border-zinc-700/70");
  });

  test("does not highlight the project header when an environment is selected", () => {
    useUIStore.setState({ selectedProjectId: "project-1", selectedEnvironmentId: "env-1" });

    render(<HierarchicalSidebar />);

    const header = getProjectHeader(screen.getByRole("button", { name: /Project One/i }));
    expect(header.className).not.toContain("bg-zinc-800/85");
    expect(header.className).toContain("border-transparent");
  });

  test("polls each project through the read-only silent snapshot path", async () => {
    let intervalCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      if (timeout === 5_000) intervalCallback = callback as () => void;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    try {
      render(<HierarchicalSidebar />);
      await waitFor(() => expect(intervalCallback).toBeDefined());
      loadEnvironmentsMock.mockClear();

      await act(async () => {
        intervalCallback?.();
        await Promise.resolve();
      });

      expect(loadEnvironmentsMock).toHaveBeenCalledWith("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("auto-collapses projects that have no environments after initial loading", async () => {
    render(<HierarchicalSidebar />);

    await waitFor(() => {
      expect(useUIStore.getState().collapsedProjects).toContain("project-1");
    });
  });

  test("reloads project environments after the environment store is reset", async () => {
    environmentsValue = [{ ...createdEnvironment, id: "env-1" }];
    const view = render(<HierarchicalSidebar />);
    await waitFor(() => expect(loadEnvironmentsMock).toHaveBeenCalledWith("project-1"));
    loadEnvironmentsMock.mockClear();

    environmentsValue = [];
    projectsValue = [...projectsValue];
    view.rerender(<HierarchicalSidebar />);

    await waitFor(() => expect(loadEnvironmentsMock).toHaveBeenCalledWith("project-1"));
  });

  test("selects environment ranges, toggles members, and auto-starts an uninitialized local environment", async () => {
    environmentsValue = [
      { ...createdEnvironment, id: "env-1", name: "Environment One", order: 0 },
      { ...createdEnvironment, id: "env-2", name: "Environment Two", order: 1 },
      {
        ...createdEnvironment,
        id: "env-3",
        name: "Environment Three",
        order: 2,
        environmentType: "local",
        containerId: null,
        worktreePath: undefined,
        status: "stopped",
      },
    ];
    useUIStore.setState({ selectedProjectId: "project-1", selectedEnvironmentId: "env-1" });
    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Environment Three" }), { shiftKey: true });
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-1", "env-2", "env-3"]);

    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(useUIStore.getState().selectedEnvironmentIds).toHaveLength(2);

    act(() => {
      useUIStore.getState().clearMultiSelection();
    });
    fireEvent.click(screen.getByRole("button", { name: "Environment Three" }));
    await waitFor(() => expect(startEnvironmentMock).toHaveBeenCalledWith("env-3"));
  });

  test("reports an automatic local environment start failure", async () => {
    environmentsValue = [{
      ...createdEnvironment,
      id: "env-local",
      name: "Local Environment",
      environmentType: "local",
      containerId: null,
      worktreePath: undefined,
      status: "stopped",
    }];
    startEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("start failed");
    });
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      render(<HierarchicalSidebar />);
      fireEvent.click(screen.getByRole("button", { name: "Local Environment" }));
      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "[HierarchicalSidebar] Failed to auto-start local environment:", expect.any(Error),
      ));
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-local");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("runs bulk stop, restart, and delete actions for eligible selected environments", async () => {
    environmentsValue = [
      { ...createdEnvironment, id: "env-running", name: "Running", order: 0, status: "running" },
      { ...createdEnvironment, id: "env-stopped", name: "Stopped", order: 1, status: "stopped" },
    ];
    useUIStore.setState({ selectedEnvironmentIds: ["env-running", "env-stopped"] });
    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByTitle("Stop selected"));
    await waitFor(() => expect(stopEnvironmentMock).toHaveBeenCalledWith("env-running"));
    expect(stopEnvironmentMock).not.toHaveBeenCalledWith("env-stopped");

    fireEvent.click(screen.getByTitle("Restart selected"));
    await waitFor(() => expect(restartEnvironmentMock).toHaveBeenCalledWith("env-running"));
    expect(restartEnvironmentMock).not.toHaveBeenCalledWith("env-stopped");

    fireEvent.click(screen.getByTitle("Delete selected"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete All" }));
    await waitFor(() => {
      expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-running");
      expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-stopped");
    });
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual([]);
  });

  test("reports bulk action failures and still exits delete selection mode", async () => {
    environmentsValue = [
      { ...createdEnvironment, id: "env-running", name: "Running", order: 0, status: "running" },
    ];
    useUIStore.setState({ selectedEnvironmentIds: ["env-running"] });
    stopEnvironmentMock.mockImplementationOnce(async () => { throw new Error("stop failed"); });
    restartEnvironmentMock.mockImplementationOnce(async () => { throw new Error("restart failed"); });
    deleteEnvironmentMock.mockImplementationOnce(async () => { throw new Error("delete failed"); });
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      render(<HierarchicalSidebar />);
      fireEvent.click(screen.getByTitle("Stop selected"));
      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to stop environment env-running:", expect.any(Error),
      ));

      fireEvent.click(screen.getByTitle("Restart selected"));
      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to restart environment env-running:", expect.any(Error),
      ));

      fireEvent.click(screen.getByTitle("Delete selected"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete All" }));
      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to delete environment env-running:", expect.any(Error),
      ));
      expect(useUIStore.getState().selectedEnvironmentIds).toEqual([]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("adds projects and keeps the dialog open with an actionable error after failure", async () => {
    addProjectMock.mockImplementationOnce(async () => {
      throw new Error("repository already exists");
    });
    render(<HierarchicalSidebar />);

    fireEvent.click(screen.getByTitle("Add project"));
    fireEvent.change(await screen.findByLabelText(/Git URL/i), {
      target: { value: "https://github.com/acme/new.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    await screen.findByText("repository already exists");
    expect(addProjectMock).toHaveBeenCalledWith("https://github.com/acme/new.git", undefined);
    expect(screen.getByRole("heading", { name: "Add Project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    await waitFor(() => expect(addProjectMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("opens repository settings from the project context menu", async () => {
    render(<HierarchicalSidebar />);
    const projectButton = screen.getByRole("button", { name: /Project One/i });

    fireEvent.contextMenu(projectButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Repository Settings" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Name") || screen.queryByTestId("settings-layout")).toBeTruthy();
    });
  });

  test("deletes a project through its confirmation dialog", async () => {
    environmentsValue = [{ ...createdEnvironment, id: "env-1", name: "Environment One" }];
    render(<HierarchicalSidebar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /Project One/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteEnvironmentMock).toHaveBeenCalledWith("env-1");
      expect(removeProjectMock).toHaveBeenCalledWith("project-1");
    });
  });

  test("routes project and environment drag events and ignores cancelled drops", async () => {
    const secondProject = { ...project, id: "project-2", name: "Project Two", order: 1 };
    projectsValue = [project, secondProject];
    environmentsValue = [
      { ...createdEnvironment, id: "env-1", order: 0 },
      { ...createdEnvironment, id: "env-2", order: 1 },
    ];
    render(<HierarchicalSidebar />);

    act(() => {
      currentDndContextProps().onDragStart?.({ active: { id: "project-1" } } as DragStartEvent);
    });
    await act(async () => {
      currentDndContextProps().onDragEnd?.({
        active: { id: "project-1" },
        over: { id: "project-2" },
      } as DragEndEvent);
      await Promise.resolve();
    });
    expect(reorderProjectsMock).toHaveBeenCalledWith(["project-2", "project-1"]);

    act(() => {
      currentDndContextProps().onDragStart?.({ active: { id: "env-1" } } as DragStartEvent);
    });
    await act(async () => {
      currentDndContextProps().onDragEnd?.({
        active: { id: "env-1" },
        over: { id: "env-2" },
      } as DragEndEvent);
      await Promise.resolve();
    });
    expect(reorderEnvironmentsMock).toHaveBeenCalledWith("project-1", ["env-2", "env-1"]);

    reorderProjectsMock.mockClear();
    reorderEnvironmentsMock.mockClear();
    act(() => {
      currentDndContextProps().onDragStart?.({ active: { id: "env-1" } } as DragStartEvent);
    });
    act(() => {
      currentDndContextProps().onDragEnd?.({ active: { id: "env-1" }, over: null } as DragEndEvent);
    });
    expect(reorderProjectsMock).not.toHaveBeenCalled();
    expect(reorderEnvironmentsMock).not.toHaveBeenCalled();
  });

  test("resolves every selection modifier and fallback branch", () => {
    const orderedIds = ["env-1", "env-2", "env-3"];
    expect(resolveSidebarSelection("missing", { shiftKey: true }, orderedIds, "env-1", [])).toEqual({
      type: "toggle",
      environmentId: "missing",
    });
    expect(resolveSidebarSelection("env-2", { shiftKey: true }, orderedIds, null, [])).toEqual({
      type: "range",
      ids: ["env-2"],
    });
    expect(resolveSidebarSelection("env-2", { shiftKey: true }, orderedIds, "missing", ["env-1"])).toEqual({
      type: "range",
      ids: ["env-2"],
    });
    expect(resolveSidebarSelection("env-1", { shiftKey: true, metaKey: true }, orderedIds, "env-3", [])).toEqual({
      type: "range",
      ids: ["env-1", "env-2", "env-3"],
    });
    expect(resolveSidebarSelection("env-2", { metaKey: true }, orderedIds, null, [])).toEqual({
      type: "toggle",
      environmentId: "env-2",
    });
    expect(resolveSidebarSelection("env-2", {}, orderedIds, null, [])).toEqual({
      type: "single",
      environmentId: "env-2",
    });
  });

  test("resolves project and same-project environment reorder operations", () => {
    const secondProject = { ...project, id: "project-2", name: "Project Two", order: 1 };
    expect(resolveSidebarReorder("project-1", "project-2", "project", [project, secondProject], [])).toEqual({
      type: "project",
      ids: ["project-2", "project-1"],
    });

    const first = { ...createdEnvironment, id: "env-1", order: 0 };
    const second = { ...createdEnvironment, id: "env-2", order: 1 };
    const other = { ...createdEnvironment, id: "env-3", projectId: "project-2", order: 0 };
    expect(resolveSidebarReorder("env-1", "env-2", "environment", [project], [first, second, other])).toEqual({
      type: "environment",
      projectId: "project-1",
      ids: ["env-2", "env-1"],
    });
    expect(resolveSidebarReorder("env-1", "env-3", "environment", [project], [first, second, other])).toBeNull();
    expect(resolveSidebarReorder("missing", "env-2", "environment", [project], [first, second])).toBeNull();
    expect(resolveSidebarReorder("env-1", "missing", "environment", [project], [first, second])).toBeNull();
    expect(resolveSidebarReorder("missing", "project-1", "project", [project], [])).toBeNull();
    expect(resolveSidebarReorder("project-1", "missing", "project", [project], [])).toBeNull();
    expect(resolveSidebarReorder("project-1", "project-1", "project", [project], [])).toBeNull();
    expect(resolveSidebarReorder("project-1", "project-2", null, [project], [])).toBeNull();
  });

  test("deletes a project only after every environment succeeds", async () => {
    const environments = [
      { ...createdEnvironment, id: "env-1", name: "First" },
      { ...createdEnvironment, id: "env-2", name: "Second" },
    ];
    await deleteProjectAndEnvironments("project-1", environments, deleteEnvironmentMock, removeProjectMock);
    expect(deleteEnvironmentMock.mock.calls.map(([id]) => id)).toEqual(["env-1", "env-2"]);
    expect(removeProjectMock).toHaveBeenCalledWith("project-1");

    deleteEnvironmentMock.mockClear();
    removeProjectMock.mockClear();
    deleteEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("delete failed");
    });
    await expect(
      deleteProjectAndEnvironments("project-1", environments, deleteEnvironmentMock, removeProjectMock),
    ).rejects.toThrow("Failed to delete some environments: First");
    expect(deleteEnvironmentMock).toHaveBeenCalledTimes(2);
    expect(removeProjectMock).not.toHaveBeenCalled();
  });

  test("removes empty projects and propagates project removal failures", async () => {
    await deleteProjectAndEnvironments("project-1", [], deleteEnvironmentMock, removeProjectMock);
    expect(deleteEnvironmentMock).not.toHaveBeenCalled();
    expect(removeProjectMock).toHaveBeenCalledWith("project-1");

    removeProjectMock.mockClear();
    removeProjectMock.mockImplementationOnce(async () => {
      throw new Error("remove failed");
    });
    await expect(
      deleteProjectAndEnvironments("project-1", [], deleteEnvironmentMock, removeProjectMock),
    ).rejects.toThrow("remove failed");
  });

  test("reports every environment that fails before preserving the project", async () => {
    const environments = [
      { ...createdEnvironment, id: "env-1", name: "First" },
      { ...createdEnvironment, id: "env-2", name: "Second" },
    ];
    deleteEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("first failed");
    });
    deleteEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("second failed");
    });
    const originalConsoleError = console.error;
    console.error = mock(() => undefined) as typeof console.error;

    try {
      await expect(
        deleteProjectAndEnvironments("project-1", environments, deleteEnvironmentMock, removeProjectMock),
      ).rejects.toThrow("Failed to delete some environments: First, Second");
      expect(deleteEnvironmentMock).toHaveBeenCalledTimes(2);
      expect(removeProjectMock).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });
});

// The selectable project header is the nearest ancestor div carrying the
// group/project marker class used for the selected/hover treatment.
function getProjectHeader(projectButton: HTMLElement): HTMLElement {
  let node: HTMLElement | null = projectButton.parentElement;
  while (node && !node.className.includes("group/project")) {
    node = node.parentElement;
  }
  if (!node) {
    throw new Error("Could not locate project header element");
  }
  return node;
}

function currentDndContextProps(): DndContextProps {
  if (!dndContextProps) {
    throw new Error("DndContext was not rendered");
  }
  return dndContextProps;
}
