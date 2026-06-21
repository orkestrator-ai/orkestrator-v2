import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

mock.module("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [project],
    addProject: mock(async () => {}),
    removeProject: mock(async () => {}),
    updateProject: mock(async () => {}),
    reorderProjects: mock(async () => {}),
    validateGitUrl: mock(async () => true),
    isLoading: false,
  }),
}));

mock.module("@/hooks/useEnvironments", () => ({
  useEnvironments: () => ({
    allEnvironments: [],
    loadEnvironments: loadEnvironmentsMock,
    createEnvironment: createEnvironmentMock,
    deleteEnvironment: mock(async () => {}),
    startEnvironment: startEnvironmentMock,
    stopEnvironment: mock(async () => {}),
    restartEnvironment: mock(async () => {}),
    reorderEnvironments: mock(async () => {}),
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

const { HierarchicalSidebar } = await import("../../../src/components/sidebar/HierarchicalSidebar");

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
});
