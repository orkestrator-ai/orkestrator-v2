import { expect, test } from "bun:test";
import type { PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import { PrAutoMergeController } from "./pr-auto-merge.js";
import { PrMonitorService } from "./pr-monitor.js";
import { environmentToPrMonitorTarget } from "./commands-pr-monitor.js";
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
