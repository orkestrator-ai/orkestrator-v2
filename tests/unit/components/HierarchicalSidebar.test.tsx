import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockReadImage } from "../../mocks/clipboard";
import { useClaudeOptionsStore, useConfigStore, useUIStore } from "@/stores";
import type { Environment, Project } from "@/types";

import * as realUseProjects from "@/hooks/useProjects";
import * as realUseEnvironments from "@/hooks/useEnvironments";
import * as realUseEnvironmentDiffStats from "@/hooks/useEnvironmentDiffStats";
import * as realBackend from "@/lib/backend";

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

mock.module("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: projectsValue,
    addProject: addProjectMock,
    removeProject: removeProjectMock,
    updateProject: updateProjectMock,
    reorderProjects: reorderProjectsMock,
    validateGitUrl: mock(async () => true),
    isLoading: false,
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
} = await import("../../../src/components/sidebar/HierarchicalSidebar");

afterAll(() => {
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
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
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
    expect(resolveSidebarReorder("project-1", "project-1", "project", [project], [])).toBeNull();
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
