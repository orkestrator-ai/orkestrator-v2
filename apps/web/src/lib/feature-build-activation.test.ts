import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";

import * as realBackend from "@/lib/backend";
import * as realBuildPipeline from "@/lib/build-pipeline-persistence";

const realModules = {
  "@/lib/backend": { ...realBackend },
  "@/lib/build-pipeline-persistence": { ...realBuildPipeline },
};

const mockGetEnvironment = mock(
  async (_environmentId: string): Promise<Environment | null> => null,
);
const mockHydrateBuildPipeline = mock(async (_id: string) => null as unknown);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getEnvironment: mockGetEnvironment,
}));
mock.module("@/lib/build-pipeline-persistence", () => ({
  ...realBuildPipeline,
  hydrateBuildPipeline: mockHydrateBuildPipeline,
}));

const { activateFeatureBuildEnvironment, scheduleBuildPipelineTabActivation } =
  await import("./feature-build-activation");
const { getWindowBuildPipelineActivation } = await import("./pane-selection-storage");
const { buildPipelineStore } = await import("@/stores/buildPipelineStore");
const { appCommandStore } = await import("@/test/app-command-store");
const { environmentStore } = await import("@/stores/environmentStore");
const { uiStore } = await import("@/stores/uiStore");

afterAll(() => {
  for (const [path, module] of Object.entries(realModules)) {
    mock.module(path, () => module);
  }
});

function resetStores(): void {
  localStorage.clear();
  appCommandStore(environmentStore).setState({
    environments: [],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    recentProjectIds: [],
    collapsedProjects: [],
    selectedEnvironmentIds: [],
  });
}

beforeEach(() => {
  resetStores();
  mockGetEnvironment.mockReset();
  mockGetEnvironment.mockImplementation(async () => null);
  mockHydrateBuildPipeline.mockReset();
  mockHydrateBuildPipeline.mockImplementation(async () => null);
});

afterEach(() => {
  resetStores();
});

describe("activateFeatureBuildEnvironment", () => {
  test("arms the pipeline handoff when the create dialog already has an environment", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      activateFeatureBuildEnvironment("project-1", {
        taskId: "task-1",
        pipelineId: "pipeline-1",
        environmentId: "env-1",
      });

      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-1");
      expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("arms the pipeline handoff after a deferred pipeline record resolves", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      activateFeatureBuildEnvironment("project-1", {
        taskId: "task-1",
        pipelineId: "pipeline-deferred",
      });
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();

      appCommandStore(buildPipelineStore)
        .getState()
        .replacePipeline(
          buildPipelineFixture({
            id: "pipeline-deferred",
            projectId: "project-1",
            environmentId: "env-1",
          }),
        );
      await Promise.resolve();

      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-deferred");
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("scheduleBuildPipelineTabActivation arms once a later environment id arrives", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      scheduleBuildPipelineTabActivation("project-1", "pipeline-kanban");
      expect(getWindowBuildPipelineActivation("env-kanban")).toBeNull();

      appCommandStore(buildPipelineStore)
        .getState()
        .replacePipeline(
          buildPipelineFixture({
            id: "pipeline-kanban",
            projectId: "project-1",
            environmentId: "env-kanban",
          }),
        );
      await Promise.resolve();

      expect(getWindowBuildPipelineActivation("env-kanban")).toBe("pipeline-kanban");
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-kanban");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });
});
