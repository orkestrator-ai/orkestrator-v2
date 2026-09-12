import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import {
  activateProjectForEnvironmentCleanup,
  reconcileSelectedEnvironmentCleanupSelection,
  startEnvironmentCleanupSelectionSync,
} from "./environment-cleanup-selection";

import * as realBackend from "@/lib/backend";

const mockGetEnvironment = mock(async (_environmentId: string): Promise<Environment | null> => null);
mock.module("@/lib/backend", () => ({
  ...realBackend,
  getEnvironment: mockGetEnvironment,
}));

const { activateFeatureBuildEnvironment } = await import("./feature-build-activation");

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "feature-env",
    branch: "feature/cleanup",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function resetStores(): void {
  useEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });
  useUIStore.setState({
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
});

afterEach(() => {
  resetStores();
});

describe("activateProjectForEnvironmentCleanup", () => {
  test("selects the environment's project and expands it", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      collapsedProjects: ["project-1"],
    });

    expect(activateProjectForEnvironmentCleanup("env-1")).toBe(true);

    const ui = useUIStore.getState();
    expect(ui.selectedProjectId).toBe("project-1");
    expect(ui.selectedEnvironmentId).toBeNull();
    expect(ui.collapsedProjects).toEqual([]);
  });

  test("does not steal selection from a different environment", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-2",
    });

    expect(activateProjectForEnvironmentCleanup("env-1")).toBe(false);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-2");
  });

  test("leaves a failed merge-cleanup environment selected so retry stays reachable", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
      cleanupAfterMergeError: "delete failed",
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-01-02T00:00:00.000Z",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    expect(activateProjectForEnvironmentCleanup("env-1")).toBe(false);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  test("lets a fresh renderer-local deletion override a stale merge-cleanup error", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
      cleanupAfterMergeError: "delete failed",
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-01-02T00:00:00.000Z",
    });
    useEnvironmentStore.setState({
      environments: [environment],
      deletingEnvironments: new Set(["env-1"]),
    });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    expect(activateProjectForEnvironmentCleanup("env-1")).toBe(true);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
  });
});

describe("reconcileSelectedEnvironmentCleanupSelection", () => {
  test("activates the project once the selected environment is marked deleting", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-01-02T00:00:00.000Z",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    expect(reconcileSelectedEnvironmentCleanupSelection()).toBe(true);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
  });

  test("activates the project when renderer-local deletion is in flight", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({
      environments: [environment],
      deletingEnvironments: new Set(["env-1"]),
    });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    expect(reconcileSelectedEnvironmentCleanupSelection()).toBe(true);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  });

  test("does not leave a live environment", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    expect(reconcileSelectedEnvironmentCleanupSelection()).toBe(false);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  test("does not treat a missing record as cleanup", () => {
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-not-loaded",
    });

    expect(reconcileSelectedEnvironmentCleanupSelection()).toBe(false);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-not-loaded");
    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
  });

  test("does not treat a missing record as cleanup while the store is still loading", () => {
    useEnvironmentStore.setState({ environments: [], isLoading: true });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-not-loaded",
    });

    expect(reconcileSelectedEnvironmentCleanupSelection()).toBe(false);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-not-loaded");
  });
});

describe("startEnvironmentCleanupSelectionSync", () => {
  test("selects the project as soon as the selected environment starts deleting", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      collapsedProjects: ["project-1"],
    });

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      useEnvironmentStore.getState().setDeleting("env-1", true);
      expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
      expect(useUIStore.getState().selectedProjectId).toBe("project-1");
      expect(useUIStore.getState().collapsedProjects).toEqual([]);
    } finally {
      stop();
    }
  });

  test("selects the project when backend tombstone flags arrive", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      useEnvironmentStore.getState().updateEnvironment("env-1", {
        lifecycleOperation: "deleting",
        deletionRequestedAt: "2026-01-02T00:00:00.000Z",
      });
      expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    } finally {
      stop();
    }
  });

  test("leaves a previously observed environment after its record is removed", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      useEnvironmentStore.getState().removeEnvironment("env-1");
      expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
      expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    } finally {
      stop();
    }
  });

  test("keeps a select-then-hydrate activation while the record is still missing", () => {
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: null,
    });

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      useUIStore.getState().selectProjectAndEnvironment("project-1", "e-not-loaded");
      expect(useUIStore.getState().selectedEnvironmentId).toBe("e-not-loaded");

      useEnvironmentStore.getState().addEnvironment(
        makeEnvironment({
          id: "e-not-loaded",
          projectId: "project-1",
        }),
      );

      expect(useUIStore.getState().selectedEnvironmentId).toBe("e-not-loaded");
      expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    } finally {
      stop();
    }
  });

  test("keeps feature-build activation before the targeted getEnvironment resolves", async () => {
    let resolveEnvironment: ((environment: Environment) => void) | undefined;
    mockGetEnvironment.mockImplementationOnce(
      () =>
        new Promise<Environment | null>((resolve) => {
          resolveEnvironment = (environment) => resolve(environment);
        }),
    );

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      activateFeatureBuildEnvironment("project-1", {
        taskId: "task-feature",
        pipelineId: "pipeline-feature",
        environmentId: "env-feature",
      });

      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-feature");
      expect(useEnvironmentStore.getState().getEnvironmentById("env-feature")).toBeUndefined();

      const environment = makeEnvironment({
        id: "env-feature",
        projectId: "project-1",
      });
      resolveEnvironment?.(environment);
      await Promise.resolve();
      await Promise.resolve();

      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-feature");
      expect(useEnvironmentStore.getState().getEnvironmentById("env-feature")?.id).toBe(
        "env-feature",
      );
    } finally {
      stop();
    }
  });

  test("lets the user select an environment stranded by a failed delete tombstone", () => {
    const environment = makeEnvironment({
      id: "env-1",
      projectId: "project-1",
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-01-02T00:00:00.000Z",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: null,
    });

    const stop = startEnvironmentCleanupSelectionSync();
    try {
      useUIStore.getState().selectProjectAndEnvironment("project-1", "env-1");
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");

      useEnvironmentStore.getState().updateEnvironment("env-1", {
        name: "feature-env-renamed",
      });
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
    } finally {
      stop();
    }
  });
});
