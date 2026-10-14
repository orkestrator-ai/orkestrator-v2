import { afterEach, describe, expect, test } from "bun:test";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import {
  applyEnvironmentSetupComplete,
  cleanupDeletedEnvironmentSubscriptions,
  cleanupSubscriptionsRemovedByProjectSnapshot,
  reconcileEnvironmentLifecycleErrors,
} from "./useEnvironments";
import {
  armWindowBuildPipelineActivation,
  armWindowStartupAgentActivation,
  consumeWindowStartupAgentActivation,
  getWindowBuildPipelineActivation,
  hasWindowBuildPipelineHandoffResolved,
  markWindowBuildPipelineHandoffResolved,
} from "@/lib/pane-selection-storage";

afterEach(() => {
  localStorage.clear();
  useEnvironmentStore.setState({ environments: [] });
});

function environment(id: string, projectId: string): Environment {
  return {
    id,
    projectId,
    name: id,
    branch: id,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "ready",
  };
}

describe("cleanupDeletedEnvironmentSubscriptions", () => {
  test("retires the creating window's startup-agent handoff on deletion", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      armWindowStartupAgentActivation("env-deleted");

      cleanupDeletedEnvironmentSubscriptions("env-deleted");

      expect(consumeWindowStartupAgentActivation("env-deleted")).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("retires the launching window's pipeline handoff on deletion", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      armWindowBuildPipelineActivation("env-deleted", "pipeline-1");
      markWindowBuildPipelineHandoffResolved("env-deleted", "pipeline-1");

      cleanupDeletedEnvironmentSubscriptions("env-deleted");

      expect(getWindowBuildPipelineActivation("env-deleted")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-deleted", "pipeline-1")).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("cleans up only environments removed by an authoritative project snapshot", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const removed = environment("removed", "project-1");
      const surviving = environment("surviving", "project-1");
      const otherProject = environment("other-project", "project-2");
      useEnvironmentStore.setState({
        environments: [removed, surviving, otherProject],
      });
      for (const id of ["removed", "surviving", "other-project"]) {
        armWindowStartupAgentActivation(id);
      }

      cleanupSubscriptionsRemovedByProjectSnapshot("project-1", [surviving]);

      expect(consumeWindowStartupAgentActivation("removed")).toBe(false);
      expect(consumeWindowStartupAgentActivation("surviving")).toBe(true);
      expect(consumeWindowStartupAgentActivation("other-project")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });
});

describe("startup-agent handoff failure cleanup", () => {
  test("retires the handoff after a durable lifecycle failure", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      useEnvironmentStore.setState({
        environments: [
          {
            ...environment("env-1", "project-1"),
            pendingAgentLaunch: true,
            lifecycleError: "setup failed",
          },
        ],
      });
      armWindowStartupAgentActivation("env-1");

      reconcileEnvironmentLifecycleErrors();

      expect(consumeWindowStartupAgentActivation("env-1")).toBe(false);
      expect(useEnvironmentStore.getState().environments[0]?.pendingAgentLaunch).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("retires the handoff after an unsuccessful setup completion event", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      useEnvironmentStore.setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowStartupAgentActivation("env-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: false });

      expect(consumeWindowStartupAgentActivation("env-1")).toBe(false);
      expect(useEnvironmentStore.getState().environments[0]?.pendingAgentLaunch).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });
});

describe("pipeline handoff failure cleanup", () => {
  test("retires the handoff after a durable lifecycle failure", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      useEnvironmentStore.setState({
        environments: [
          {
            ...environment("env-1", "project-1"),
            pendingAgentLaunch: true,
            lifecycleError: "setup failed",
          },
        ],
      });
      armWindowBuildPipelineActivation("env-1", "pipeline-1");
      markWindowBuildPipelineHandoffResolved("env-1", "pipeline-1");

      reconcileEnvironmentLifecycleErrors();

      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("retires the handoff after an unsuccessful setup completion event", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      useEnvironmentStore.setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowBuildPipelineActivation("env-1", "pipeline-1");
      markWindowBuildPipelineHandoffResolved("env-1", "pipeline-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: false });

      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("keeps the handoff armed after a successful setup completion event", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      useEnvironmentStore.setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowBuildPipelineActivation("env-1", "pipeline-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: true });

      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });
});
