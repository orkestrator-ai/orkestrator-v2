import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { useEnvironments } from "./useEnvironments";
import * as backend from "@/lib/backend";
import { appCommandScope } from "@/lib/node-scope-slots";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import {
  applyEnvironmentSetupComplete,
  cleanupDeletedEnvironmentSubscriptions,
  cleanupSubscriptionsRemovedByProjectSnapshot,
  reconcileEnvironmentLifecycleErrors,
  reconcileEnvironmentSetupSnapshots,
  refreshEnvironmentSnapshot,
} from "./useEnvironments";
import {
  armWindowBuildPipelineActivation,
  armWindowStartupAgentActivation,
  consumeWindowStartupAgentActivation,
  getWindowBuildPipelineActivation,
  hasWindowBuildPipelineHandoffResolved,
  markWindowBuildPipelineHandoffResolved,
} from "@/lib/pane-selection-storage";
import { appCommandStore } from "@/test/app-command-store";

afterEach(() => {
  cleanup();
  localStorage.clear();
  appCommandStore(environmentStore).setState({ environments: [] });
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
      appCommandStore(environmentStore).setState({
        environments: [removed, surviving, otherProject],
      });
      for (const id of ["removed", "surviving", "other-project"]) {
        armWindowStartupAgentActivation(id);
      }

      cleanupSubscriptionsRemovedByProjectSnapshot("project-1", [surviving], appCommandScope());

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
      appCommandStore(environmentStore).setState({
        environments: [
          {
            ...environment("env-1", "project-1"),
            pendingAgentLaunch: true,
            lifecycleError: "setup failed",
          },
        ],
      });
      armWindowStartupAgentActivation("env-1");

      reconcileEnvironmentLifecycleErrors(appCommandScope());

      expect(consumeWindowStartupAgentActivation("env-1")).toBe(false);
      expect(appCommandStore(environmentStore).getState().environments[0]?.pendingAgentLaunch).toBe(
        false,
      );
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
      appCommandStore(environmentStore).setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowStartupAgentActivation("env-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: false }, appCommandScope());

      expect(consumeWindowStartupAgentActivation("env-1")).toBe(false);
      expect(appCommandStore(environmentStore).getState().environments[0]?.pendingAgentLaunch).toBe(
        false,
      );
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
      appCommandStore(environmentStore).setState({
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

      reconcileEnvironmentLifecycleErrors(appCommandScope());

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
      appCommandStore(environmentStore).setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowBuildPipelineActivation("env-1", "pipeline-1");
      markWindowBuildPipelineHandoffResolved("env-1", "pipeline-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: false }, appCommandScope());

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
      appCommandStore(environmentStore).setState({
        environments: [{ ...environment("env-1", "project-1"), pendingAgentLaunch: true }],
      });
      armWindowBuildPipelineActivation("env-1", "pipeline-1");

      applyEnvironmentSetupComplete({ environment_id: "env-1", success: true }, appCommandScope());

      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });
});

describe("refreshEnvironmentSnapshot", () => {
  const reads = (result: Environment | null | Error) =>
    spyOn(backend, "getEnvironmentSnapshot").mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    });

  test("updates that environment and keeps the others' objects", async () => {
    const other = environment("env-2", "project-1");
    appCommandStore(environmentStore).setState({
      environments: [environment("env-1", "project-1"), other],
    });
    const list = spyOn(backend, "getEnvironmentSnapshots");
    const read = reads({ ...environment("env-1", "project-1"), status: "running" });

    expect(await refreshEnvironmentSnapshot("project-1", "env-1", appCommandScope())).toBe(true);

    const [first, second] = appCommandStore(environmentStore).getState().environments;
    expect(first!.status).toBe("running");
    expect(second).toBe(other);
    expect(read).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    read.mockRestore();
    list.mockRestore();
  });

  test("removes an environment the backend no longer has", async () => {
    appCommandStore(environmentStore).setState({
      environments: [environment("env-1", "project-1")],
    });
    const read = reads(null);
    expect(await refreshEnvironmentSnapshot("project-1", "env-1", appCommandScope())).toBe(true);
    expect(appCommandStore(environmentStore).getState().environments).toEqual([]);
    read.mockRestore();
  });

  test("adds one another client created", async () => {
    const read = reads(environment("env-new", "project-1"));
    expect(await refreshEnvironmentSnapshot("project-1", "env-new", appCommandScope())).toBe(true);
    expect(
      appCommandStore(environmentStore)
        .getState()
        .environments.map(({ id }) => id),
    ).toEqual(["env-new"]);
    read.mockRestore();
  });

  test.each([false, true])(
    "does not add a creation snapshot when generation changes (settled=%s)",
    async (settled) => {
      const pid = `creation-${settled}`;
      const created = environment("env-created", pid);
      let finishCreate!: (value: Environment) => void;
      let finishRead!: (value: Environment) => void;
      const create = spyOn(backend, "createEnvironment").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishCreate = resolve;
          }),
      );
      const read = spyOn(backend, "getEnvironmentSnapshot").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      try {
        const { result } = renderHookInAppCommandScope(() =>
          useEnvironments(null, { listenForRenameEvents: false }),
        );
        let snapshot = settled
          ? refreshEnvironmentSnapshot(pid, created.id, appCommandScope())
          : undefined;
        let creation!: Promise<Environment>;
        act(() => {
          creation = result.current.createEnvironment(pid);
        });
        if (!settled) snapshot = refreshEnvironmentSnapshot(pid, created.id, appCommandScope());
        const other = environment("env-other", pid);
        if (settled) {
          await act(async () => {
            finishCreate(other);
            await creation;
          });
        }
        await act(async () => {
          finishRead(created);
          expect(await snapshot).toBe(true);
        });
        expect(appCommandStore(environmentStore).getState().environments).toEqual(
          settled ? [other] : [],
        );
        if (!settled)
          await act(async () => {
            finishCreate(created);
            await creation;
          });
        else appCommandStore(environmentStore).getState().addEnvironment(created);
        expect(
          appCommandStore(environmentStore)
            .getState()
            .environments.map(({ id }) => id),
        ).toEqual([...(settled ? [other.id] : []), created.id]);
      } finally {
        create.mockRestore();
        read.mockRestore();
      }
    },
  );

  test("reports a backend that predates the read, changing nothing", async () => {
    const held = environment("env-1", "project-1");
    appCommandStore(environmentStore).setState({ environments: [held] });
    const read = reads(new Error("Unknown backend command: get_environment_snapshot"));
    expect(await refreshEnvironmentSnapshot("project-1", "env-1", appCommandScope())).toBe(false);
    expect(appCommandStore(environmentStore).getState().environments[0]).toBe(held);
    read.mockRestore();
  });

  test("a failed read is not mistaken for a missing command", async () => {
    const read = reads(new Error("backend down"));
    await expect(
      refreshEnvironmentSnapshot("project-1", "env-1", appCommandScope()),
    ).rejects.toThrow("backend down");
    read.mockRestore();
  });
});

describe("HTTPS remedy lifecycle", () => {
  test.each([undefined, null])(
    "authoritative snapshot clears a previous remedy (%s)",
    async (remedy) => {
      appCommandStore(environmentStore).setState({
        environments: [
          {
            ...environment("https-env", "p"),
            lifecycleError: "SSH failed",
            lifecycleRemedy: "use-https",
          },
        ],
      });
      const read = spyOn(backend, "getEnvironment").mockResolvedValue({
        ...environment("https-env", "p"),
        lifecycleError: null,
        lifecycleRemedy: remedy,
      });
      try {
        await act(async () => {
          await reconcileEnvironmentSetupSnapshots(appCommandScope());
        });
        const current = appCommandStore(environmentStore).getState().environments[0]!;
        expect(current.lifecycleError).toBeNull();
        expect(current.lifecycleRemedy).toBeNull();
      } finally {
        read.mockRestore();
      }
    },
  );

  test("retry clears the old remedy before backend admission and ignores an older snapshot", async () => {
    const failed = {
      ...environment("https-retry", "p"),
      lifecycleError: "SSH failed",
      lifecycleRemedy: "use-https" as const,
    };
    appCommandStore(environmentStore).setState({ environments: [failed] });
    let finishStart!: () => void;
    let finishRead!: (value: Environment) => void;
    const start = spyOn(backend, "startEnvironmentInBackground").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const read = spyOn(backend, "getEnvironmentSnapshot").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    try {
      const { result } = renderHookInAppCommandScope(() =>
        useEnvironments(null, { listenForRenameEvents: false }),
      );
      const snapshot = refreshEnvironmentSnapshot("p", failed.id, appCommandScope());
      let retry!: ReturnType<typeof result.current.startEnvironment>;
      act(() => {
        retry = result.current.startEnvironment(failed.id, undefined, { background: true });
      });
      expect(
        appCommandStore(environmentStore).getState().environments[0]?.lifecycleRemedy,
      ).toBeNull();
      await act(async () => {
        finishRead(failed);
        await snapshot;
      });
      expect(
        appCommandStore(environmentStore).getState().environments[0]?.lifecycleRemedy,
      ).toBeNull();
      await act(async () => {
        finishStart();
        await retry;
      });
    } finally {
      start.mockRestore();
      read.mockRestore();
    }
  });
});
