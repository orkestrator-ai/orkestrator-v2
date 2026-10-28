import { expect, mock, spyOn, test } from "bun:test";
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
