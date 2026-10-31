import { expect, mock, spyOn, test } from "bun:test";
import {
  PR_MONITOR_CHANGED_EVENT,
  type PrMonitorEnvironmentState,
} from "@orkestrator/protocol/pr-monitor";
import type { PrMonitorEffects } from "./pr-monitor.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { environmentToPrMonitorTarget } from "./commands-pr-monitor.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { recurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { createEnvironment, type StorageService } from "./storage.js";

for (const initialized of [false, true]) {
  test(`PR shutdown is terminal with an ${initialized ? "initialized" : "unused"} monitor`, async () => {
    const scheduleMergeCleanup = mock(() => undefined);
    const runtime = new BackendRuntime({
      emit: () => undefined,
      prMonitor: { scheduleMergeCleanup },
    });
    const environment = {
      ...createEnvironment("project", { name: "feature" }),
      environmentType: "local" as const,
      worktreePath: "/unused/worktree",
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open" as const,
    };
    const loadEnvironments = mock(async () => [environment]);
    const getEnvironment = mock(async () => environment);
    const context: CommandContext = {
      runtime,
      storage: { loadEnvironments, getEnvironment } as unknown as StorageService,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    };
    const addPool = spyOn(recurringDiagnosticsRegistry, "addPool");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      if (initialized) {
        await runtime.prMonitor.sync(context);
        expect(runtime.prMonitor.service.trackedIds()).toEqual([environment.id]);
        expect(addPool).toHaveBeenCalledTimes(1);
      }
      let started!: () => void;
      const loading = new Promise<void>((resolve) => (started = resolve));
      loadEnvironments.mockImplementation(async () => {
        started();
        await gate;
        return [environment];
      });
      getEnvironment.mockImplementation(async () => {
        await gate;
        return environment;
      });
      const pendingSync = runtime.prMonitor.sync(context);
      await loading;
      const pendingWake = runtime.prMonitor.wakeForCompletion(environment.id, context);
      const pendingRefresh = runtime.prMonitor.requestRefresh(environment.id, context);
      // A lifecycle operation admitted before shutdown finishes after it.
      const lateLifecycle = runtime.environments.enqueueLifecycleOperation(
        environment.id,
        context.environmentLifecycleTasks!,
        async () => {
          await gate;
          runtime.prMonitor.invalidatePendingSync();
          runtime.prMonitor.service.untrack(environment.id);
          await runtime.prMonitor.sync(context);
        },
      );
      runtime.shutdown();
      const poolsAtShutdown = addPool.mock.calls.length;
      const timers = spyOn(globalThis, "setTimeout");
      try {
        const service = runtime.prMonitor.service;
        const target = environmentToPrMonitorTarget(environment);
        service.sync([target]);
        service.untrack(environment.id);
        service.pause(environment.id);
        service.requestMode(target, "create-pending");
        service.wakeForCompletion(target);
        service.requestCheck(environment.id);
        release();
        await Promise.all([pendingSync, pendingWake, pendingRefresh, lateLifecycle]);
        const reads = [loadEnvironments.mock.calls.length, getEnvironment.mock.calls.length];
        await runtime.prMonitor.sync(context);
        await runtime.prMonitor.wakeForCompletion(environment.id, context);
        await runtime.prMonitor.requestRefresh(environment.id, context);
        await runtime.prMonitor.reconcileConfirmedMerge(environment, context);
        runtime.prMonitor.resumeTerminalEffects(environment.id, {
          url: environment.prUrl,
          state: "merged",
        });
        runtime.shutdown();
        expect([loadEnvironments.mock.calls.length, getEnvironment.mock.calls.length]).toEqual(
          reads,
        );
        expect(addPool).toHaveBeenCalledTimes(poolsAtShutdown);
        expect(timers).not.toHaveBeenCalled();
        expect(scheduleMergeCleanup).not.toHaveBeenCalled();
        expect(runtime.prMonitor.service).toBe(service);
        expect(service.trackedIds()).toEqual([]);
        expect(service.revisionedSnapshot().entries).toEqual([]);
      } finally {
        timers.mockRestore();
      }
    } finally {
      release();
      runtime.shutdown();
      addPool.mockRestore();
    }
  });
}

test("runtime persistence maps mergeability and leaves omitted observations untouched", async () => {
  const runtime = new BackendRuntime({ emit: () => undefined });
  const updateEnvironment = mock(
    async (_id: string, _updates: Record<string, unknown>) => undefined,
  );
  const context = {
    runtime,
    storage: { loadEnvironments: async () => [], updateEnvironment } as unknown as StorageService,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
  } as CommandContext;
  try {
    await runtime.prMonitor.sync(context);
    // Exercise the real composition-root effect, rather than the replacement
    // persistence callback used by the monitor service harness.
    const { effects } = (
      runtime.prMonitor.service as unknown as {
        options: { effects: PrMonitorEffects };
      }
    ).options;
    const reading = {
      url: "https://github.com/o/r/pull/1",
      state: "open" as const,
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped" as const,
    };
    await effects.persistPr("env-1", { ...reading, mergeability: "clean" });
    expect(updateEnvironment).toHaveBeenLastCalledWith(
      "env-1",
      expect.objectContaining({
        prUrl: reading.url,
        prState: "open",
        prMergeability: "clean",
      }),
    );
    await effects.persistPr("env-1", { ...reading, mergeability: null });
    expect(updateEnvironment).toHaveBeenLastCalledWith(
      "env-1",
      expect.objectContaining({ prMergeability: null }),
    );
    await effects.persistPr("env-1", reading);
    expect(updateEnvironment.mock.calls.at(-1)?.[1]).not.toHaveProperty("prMergeability");
  } finally {
    runtime.shutdown();
  }
});

function monitorState(overrides: Partial<PrMonitorEnvironmentState> = {}) {
  return {
    environmentId: "env-1",
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-10-30T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-10-30T00:00:00.000Z",
    prUrl: "https://github.com/o/r/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    viewerCanMerge: null,
    ...overrides,
  } satisfies PrMonitorEnvironmentState;
}

test("relayed health vouches only for the monitor's own current reading", () => {
  const runtime = new BackendRuntime({ emit: () => undefined });
  const environment = {
    id: "env-1",
    prUrl: "https://github.com/o/r/pull/1",
    prState: "open" as const,
    hasMergeConflicts: false,
    environmentType: "local" as const,
    status: "stopped" as const,
  };
  const health = (state: PrMonitorEnvironmentState | null, env = environment) =>
    runtime.prMonitor.relayedHealth(env, new Map(state ? [[state.environmentId, state]] : []));
  try {
    expect(health(monitorState())).toEqual({ prMonitorConfirmed: true });
    expect(health(monitorState({ viewerCanMerge: false }))).toEqual({
      prMonitorConfirmed: true,
      prViewerCanMerge: false,
    });
    // A failing monitor still relays what it knows about permission.
    expect(health(monitorState({ consecutiveErrors: 2, viewerCanMerge: true }))).toEqual({
      prViewerCanMerge: true,
    });
    expect(health(monitorState({ lastSuccessfulCheckAt: null }))).toEqual({});
    expect(health(null)).toEqual({});
    // Nothing is relayed for a different PR, not even the permission.
    expect(
      health(monitorState({ prUrl: "https://github.com/o/r/pull/2", viewerCanMerge: false })),
    ).toEqual({});
    expect(
      health(monitorState(), { ...environment, environmentType: "containerized" as never }),
    ).toEqual({});
    // Reading it never starts the monitor.
    expect(runtime.prMonitor.announcedStates().size).toBe(0);
  } finally {
    runtime.shutdown();
  }
});

test("a change in relayed monitor inputs announces a content-free health hint", async () => {
  const runtime = new BackendRuntime({ emit: () => undefined });
  const announceEnvironmentPrHealth = mock((_id: string, _projectId: string) => undefined);
  const context = {
    runtime,
    storage: {
      loadEnvironments: async () => [],
      getEnvironment: async (id: string) => (id === "env-1" ? { id, projectId: "p-1" } : null),
      announceEnvironmentPrHealth,
    } as unknown as StorageService,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
  } as CommandContext;
  const announce = (payload: unknown) =>
    (runtime.prMonitor as unknown as { announce(event: string, payload: unknown): void }).announce(
      PR_MONITOR_CHANGED_EVENT,
      payload,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await runtime.prMonitor.sync(context);
    announce({ environmentId: "env-1", state: monitorState({ lastSuccessfulCheckAt: null }) });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(1);
    expect(announceEnvironmentPrHealth).toHaveBeenLastCalledWith("env-1", "p-1");

    // First answered check: confirmation flips.
    announce({ environmentId: "env-1", state: monitorState() });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(2);

    // A rollup change is relayed; only a later answered timestamp is quiet.
    announce({
      environmentId: "env-1",
      state: monitorState({
        checkSummary: { passed: 1, total: 1, pending: 0 },
        lastSuccessfulCheckAt: "2026-10-30T00:01:00.000Z",
      }),
    });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(3);
    announce({
      environmentId: "env-1",
      state: monitorState({
        checkSummary: { passed: 1, total: 1, pending: 0 },
        lastSuccessfulCheckAt: "2026-10-30T00:02:00.000Z",
      }),
    });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(3);

    // Errors flip it once, not once per error.
    announce({ environmentId: "env-1", state: monitorState({ consecutiveErrors: 1 }) });
    announce({ environmentId: "env-1", state: monitorState({ consecutiveErrors: 2 }) });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(4);

    announce({ environmentId: "env-1", state: monitorState({ viewerCanMerge: false }) });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(5);

    announce({ environmentId: "env-1", removed: true });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(6);

    // A deleted environment announces its own deletion; no hint.
    announce({ environmentId: "env-gone", state: monitorState({ environmentId: "env-gone" }) });
    await settle();
    expect(announceEnvironmentPrHealth).toHaveBeenCalledTimes(6);
  } finally {
    runtime.shutdown();
  }
});

test("a merge permission error clears the cached answer for that PR's repository", async () => {
  const runtime = new BackendRuntime({ emit: () => undefined });
  const environment = {
    ...createEnvironment("project", { name: "feature" }),
    environmentType: "local" as const,
    worktreePath: "/unused/worktree",
    prUrl: "https://github.com/o/r/pull/1",
  };
  try {
    const cache = runtime.prMonitor.viewerPermissions;
    await cache.resolve(
      "local-gh",
      { host: "github.com", owner: "o", repo: "r" },
      async () => true,
    );
    await cache.resolve(
      "local-gh",
      { host: "github.com", owner: "o", repo: "x" },
      async () => true,
    );
    runtime.prMonitor.invalidateViewerPermission(environment);
    expect(cache.size).toBe(1);
  } finally {
    runtime.shutdown();
  }
});
