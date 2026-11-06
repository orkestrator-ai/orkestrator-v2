import { expect, test } from "bun:test";
import type { PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import { PrAutoMergeController } from "./pr-auto-merge.js";
import { PrMonitorService } from "./pr-monitor.js";
import { environmentToPrMonitorTarget } from "./commands-pr-monitor.js";
import type { Environment } from "./models.js";
import { createEnvironment } from "./storage.js";

test("real monitor wakes auto-merge when mergeability is the only changed observation", async () => {
  const now = new Date().toISOString();
  let environment = {
    ...createEnvironment("project"),
    id: "env",
    environmentType: "local" as const,
    worktreePath: "/tmp/feature",
    status: "running" as const,
    prUrl: "https://github.com/o/r/pull/1",
    prState: "open" as const,
    hasMergeConflicts: false,
    prMergeability: "blocked" as "blocked" | "clean",
    autoMerge: true,
    autoMergePrUrl: "https://github.com/o/r/pull/1",
    autoMergeEnabledAt: new Date(Date.parse(now) - 1).toISOString(),
  };
  let mergeability: "blocked" | "clean" = "blocked";
  const listeners = new Set<(event: PrMonitorEvent) => void>();
  const timers: Array<() => void> = [];
  let merges = 0;
  let detections = 0;
  const service = new PrMonitorService({
    now: () => now,
    monotonicNow: () => 0,
    random: () => 0,
    schedule: (callback) => {
      timers.push(callback);
      return callback;
    },
    cancel: () => undefined,
    emit: (_name, event) => {
      for (const listener of listeners) listener(event as PrMonitorEvent);
    },
    effects: {
      detect: async () => {
        detections++;
        return {
          url: environment.prUrl,
          state: "open",
          hasMergeConflicts: false,
          mergeability,
          headSha: "a".repeat(40),
          checkSummary: null,
          checkSummaryStatus: "succeeded",
          viewerCanMerge: true,
        };
      },
      persistPr: async (_id, detection) => {
        environment = { ...environment, prMergeability: detection.mergeability as "clean" };
      },
      clearPr: async () => undefined,
      findTaskForEnvironment: async () => null,
      moveTaskToReview: async () => undefined,
      addTaskComment: async () => undefined,
      updateTaskPrMetadata: async () => undefined,
    },
  });
  const controller = new PrAutoMergeController({
    storage: {
      getEnvironment: async () => environment,
      loadEnvironments: async () => [environment],
      loadConfig: async () => ({ global: {} }) as never,
      getRepositoryConfig: async () => ({}) as never,
      updateEnvironment: async () => environment,
    },
    invoke: async <T>() => {
      merges++;
      return {} as T;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    monitorState: () => service.revisionedSnapshot().entries[0] ?? null,
    resumeMonitoring: async () => service.sync([environmentToPrMonitorTarget(environment)]),
    schedule: () => 1,
    cancel: () => undefined,
  });
  try {
    // No client read or explicit evaluate: startup restores tracking itself.
    await controller.resume();
    timers.shift()!();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(detections).toBe(1);
    expect(merges).toBe(0);
    mergeability = "clean";
    timers.shift()!();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(detections).toBe(2);
    expect(merges).toBe(1);
  } finally {
    controller.dispose();
    service.shutdown();
  }
});

test("auto-merge turned on while mergeability is checking launches one Resolve per conflict episode", async () => {
  const now = new Date().toISOString();
  const prUrl = "https://github.com/o/r/pull/1";
  let environment: Environment = {
    ...createEnvironment("project"),
    id: "env",
    environmentType: "local",
    worktreePath: "/tmp/feature",
    status: "running",
    setupPhase: "ready",
    prUrl,
    prState: "open",
    // GitHub is still computing mergeability when the switch is turned on.
    hasMergeConflicts: null,
    prMergeability: "unknown",
    autoMerge: true,
    autoMergePrUrl: prUrl,
    autoMergeEnabledAt: new Date(Date.parse(now) - 1).toISOString(),
  };
  let reading: {
    hasMergeConflicts: boolean | null;
    mergeability: "unknown" | "dirty" | "blocked";
  } = { hasMergeConflicts: null, mergeability: "unknown" };
  const listeners = new Set<(event: PrMonitorEvent) => void>();
  const timers: Array<() => void> = [];
  const launches: Array<Record<string, unknown>> = [];
  const service = new PrMonitorService({
    now: () => now,
    monotonicNow: () => 0,
    random: () => 0,
    schedule: (callback) => {
      timers.push(callback);
      return callback;
    },
    cancel: () => undefined,
    emit: (_name, event) => {
      for (const listener of listeners) listener(event as PrMonitorEvent);
    },
    effects: {
      detect: async () => ({
        url: prUrl,
        state: "open",
        hasMergeConflicts: reading.hasMergeConflicts,
        mergeability: reading.mergeability,
        headSha: "a".repeat(40),
        checkSummary: null,
        checkSummaryStatus: "succeeded",
        viewerCanMerge: true,
      }),
      // Mirrors the runtime: a conflict-free reading ends the Resolve episode.
      persistPr: async (_id, detection) => {
        environment = {
          ...environment,
          hasMergeConflicts: detection.hasMergeConflicts,
          prMergeability: detection.mergeability ?? null,
          ...(detection.hasMergeConflicts === false
            ? { prRecheckAfterAgentCompletionArmedAt: undefined }
            : {}),
        };
      },
      clearPr: async () => undefined,
      findTaskForEnvironment: async () => null,
      moveTaskToReview: async () => undefined,
      addTaskComment: async () => undefined,
      updateTaskPrMetadata: async () => undefined,
    },
  });
  const controller = new PrAutoMergeController({
    storage: {
      getEnvironment: async () => environment,
      loadEnvironments: async () => [environment],
      loadConfig: async () => ({ global: {} }) as never,
      getRepositoryConfig: async () => ({}) as never,
      updateEnvironment: async () => environment,
    },
    invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
      if (command === "launch_native_agent_job") {
        launches.push(args);
        // The launch arms the episode token, as the command does.
        environment = { ...environment, prRecheckAfterAgentCompletionArmedAt: now };
        return { status: "accepted" } as T;
      }
      return {} as T;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    monitorState: () => service.revisionedSnapshot().entries[0] ?? null,
    resumeMonitoring: async () => service.sync([environmentToPrMonitorTarget(environment)]),
    schedule: () => 1,
    cancel: () => undefined,
  });
  const check = async () => {
    timers.shift()!();
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  try {
    await controller.resume();
    await check();
    expect(launches).toHaveLength(0);

    reading = { hasMergeConflicts: true, mergeability: "dirty" };
    await check();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      autoMergePrUrl: prUrl,
      completionAction: "refresh-pr-after-agent-completion",
      tabReuse: "any-agent",
      activateTab: false,
    });

    // Still the same conflict: the episode already has its Resolve.
    await check();
    expect(launches).toHaveLength(1);

    reading = { hasMergeConflicts: false, mergeability: "blocked" };
    await check();
    expect(environment.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
    expect(launches).toHaveLength(1);

    // A new conflict is a new episode, sent to the same Resolve tab.
    reading = { hasMergeConflicts: true, mergeability: "dirty" };
    await check();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({ tabReuse: "any-agent", activateTab: false });
  } finally {
    controller.dispose();
    service.shutdown();
  }
});

test.each(["interactive", "completion"] as const)(
  "%s wake merges a ready PR inside the rollup throttle window",
  async (wake) => {
    let clock = Date.now() - 10_000;
    const iso = () => new Date(clock).toISOString();
    const prUrl = "https://github.com/o/r/pull/1";
    let environment: Environment = {
      ...createEnvironment("project"),
      id: "env",
      environmentType: "local",
      worktreePath: "/tmp/feature",
      status: "running",
      setupPhase: "ready",
      prUrl,
      prState: "open",
      hasMergeConflicts: wake === "completion",
      prMergeability: wake === "completion" ? "dirty" : "clean",
    };
    const listeners = new Set<(event: PrMonitorEvent) => void>();
    const timers: Array<() => void> = [];
    const summaries: boolean[] = [];
    let merges = 0;
    let mergeArgs: Record<string, unknown> = {};
    const service = new PrMonitorService({
      now: iso,
      monotonicNow: () => clock,
      random: () => 0,
      schedule: (callback) => {
        timers.push(callback);
        return callback;
      },
      cancel: () => undefined,
      emit: (_name, event) => {
        for (const listener of listeners) listener(event as PrMonitorEvent);
      },
      effects: {
        detect: async (_target, options) => {
          summaries.push(options?.includeCheckSummary === true);
          return {
            url: prUrl,
            state: "open",
            hasMergeConflicts: environment.hasMergeConflicts ?? false,
            mergeability: environment.prMergeability ?? "clean",
            headSha: (summaries.length === 1 ? "a" : "b").repeat(40),
            checkSummary: options?.includeCheckSummary ? { passed: 2, total: 2, pending: 0 } : null,
            checkSummaryStatus: options?.includeCheckSummary ? "succeeded" : "skipped",
            viewerCanMerge: true,
          };
        },
        persistPr: async () => undefined,
        clearPr: async () => undefined,
        findTaskForEnvironment: async () => null,
        moveTaskToReview: async () => undefined,
        addTaskComment: async () => undefined,
        updateTaskPrMetadata: async () => undefined,
      },
    });
    const controller = new PrAutoMergeController({
      storage: {
        getEnvironment: async () => environment,
        loadEnvironments: async () => [environment],
        loadConfig: async () => ({ global: {} }) as never,
        getRepositoryConfig: async () => ({}) as never,
        updateEnvironment: async () => environment,
      },
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "merge_environment_pr") {
          merges++;
          mergeArgs = args;
        }
        return {} as T;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      monitorState: () => service.revisionedSnapshot().entries[0] ?? null,
      schedule: () => 1,
      cancel: () => undefined,
    });
    const settle = async () => {
      for (let i = 0; i < 60; i++) await Promise.resolve();
    };
    try {
      controller.start();
      service.sync([environmentToPrMonitorTarget(environment)]);
      timers.shift()!();
      await settle();
      expect(summaries).toEqual([true]);
      expect(merges).toBe(0);
      expect(service.revisionedSnapshot().entries[0]?.headSha).toBe("a".repeat(40));
      clock += 20_000;
      // The completion path models Resolve finishing with a new, conflict-free head.
      // Both wakes must refresh a recent rollup before authorizing a merge.
      environment = {
        ...environment,
        hasMergeConflicts: false,
        prMergeability: "clean",
        autoMerge: true,
        autoMergeCleanup: true,
        autoMergePrUrl: prUrl,
        autoMergeEnabledAt: iso(),
      };
      clock += 5;
      service.sync([environmentToPrMonitorTarget(environment)]);
      service.requestCheck("env", wake);
      timers.pop()!();
      await settle();
      // The refresh read the rollup even though the last one is under a minute
      // old, so it carries the head the merge is pinned to.
      expect(summaries).toEqual([true, true]);
      expect(merges).toBe(1);
      expect(mergeArgs).toMatchObject({
        cleanupAfterMerge: true,
        expectedHeadSha: "b".repeat(40),
        expectedPrUrl: prUrl,
      });
    } finally {
      controller.dispose();
      service.shutdown();
    }
  },
);
