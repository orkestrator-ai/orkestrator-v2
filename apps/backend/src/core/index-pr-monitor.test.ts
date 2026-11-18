import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { OrkestratorBackend } from "./index.js";
import { createEnvironment } from "./storage.js";
import { seedStore, storageDatabase } from "./storage-test-support.js";

test("the production backend wires PR terminal effects to merge cleanup recovery", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-backend-pr-cleanup-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
  });
  const { context } = backend as unknown as { context: CommandContext };
  const loadEnvironments = spyOn(context.storage, "loadEnvironments").mockResolvedValue([]);
  const getEnvironment = spyOn(context.storage, "getEnvironment").mockResolvedValue(null);
  const recoveries: Array<() => Promise<void>> = [];
  const schedule = spyOn(
    context.runtime.environments,
    "scheduleMergeCleanupRecovery",
  ).mockImplementation((_environmentId, recover) => {
    recoveries.push(recover);
  });
  try {
    await context.runtime.prMonitor.sync(context);
    context.runtime.prMonitor.resumeTerminalEffects("merged-env", {
      url: "https://github.com/o/r/pull/1",
      state: "merged",
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("merged-env", expect.any(Function));
    await recoveries[0]!();
    // The real recovery function reads through the context bound by this runtime.
    expect(getEnvironment).toHaveBeenCalledWith("merged-env");
    context.runtime.prMonitor.resumeTerminalEffects("closed-env", {
      url: "https://github.com/o/r/pull/2",
      state: "closed",
    });
    expect(schedule).toHaveBeenCalledTimes(1);
  } finally {
    schedule.mockRestore();
    getEnvironment.mockRestore();
    loadEnvironments.mockRestore();
    await backend.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.each([false, true])("startup restores PR and diff monitors (%s)", async (autoMerge) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-auto-merge-boot-"));
  const url = "https://github.com/o/r/pull/9";
  seedStore(dataDir, "environments.json", [
    {
      ...createEnvironment("project"),
      id: "auto-env",
      environmentType: "local",
      worktreePath: dataDir,
      status: "running",
      setupPhase: "ready",
      setupScriptsComplete: true,
      prUrl: url,
      prState: "open",
      hasMergeConflicts: false,
      prMergeability: "clean",
      autoMerge,
      ...(!autoMerge ? { cleanupAfterMergeRequestedAt: new Date().toISOString() } : {}),
    },
    { ...createEnvironment("other-project"), id: "unrelated-env" },
  ]);
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
  const internals = backend as unknown as {
    context: CommandContext;
    commands: Map<string, () => Promise<unknown>>;
    containerHostReachability?: { check: () => Promise<unknown> };
  };
  const context = internals.context;
  const service = context.runtime.prMonitor.service;
  const options = (
    service as unknown as { options: import("./git/pr-monitor.js").PrMonitorServiceOptions }
  ).options;
  const timers: Array<() => void> = [];
  options.schedule = (callback) => {
    timers.push(callback);
    return callback;
  };
  options.cancel = () => undefined;
  let detections = 0;
  options.effects.detect = async () => {
    detections++;
    return {
      url,
      state: "open",
      hasMergeConflicts: false,
      mergeability: "clean",
      headSha: "a".repeat(40),
      checkSummary: null,
      checkSummaryStatus: "succeeded",
    };
  };
  let merged!: () => void;
  const mergeCompleted = new Promise<void>((resolve) => (merged = resolve));
  internals.commands.set("merge_environment_pr", async () => {
    merged();
    return {};
  });
  const start = spyOn(
    context.controlMcp as unknown as { start: () => Promise<void> },
    "start",
  ).mockResolvedValue(undefined);
  const reachability = internals.containerHostReachability
    ? spyOn(internals.containerHostReachability, "check").mockResolvedValue(undefined)
    : null;
  const scheduleCleanup = spyOn(context.runtime.environments, "scheduleMergeCleanupRecovery");
  let unsubscribe: (() => void) | undefined;
  try {
    await backend.init();
    if (!autoMerge) {
      expect(scheduleCleanup).toHaveBeenCalledWith("auto-env", expect.any(Function));
      scheduleCleanup.mockClear();
    }
    expect(service.trackedIds()).toContain("auto-env");
    expect(context.runtime.diffStats.service.trackedIds()).toContain("auto-env");
    expect(detections).toBe(0);
    expect(timers.length).toBeGreaterThan(0);
    const checked = new Promise<void>((resolve) => {
      unsubscribe = context.runtime.prMonitor.onEvent((event) => {
        if (
          event.environmentId === "auto-env" &&
          "state" in event &&
          event.state.lastSuccessfulCheckAt
        ) {
          resolve();
        }
      });
    });
    timers.shift()!();
    await checked;
    expect(detections).toBe(1);
    if (autoMerge) {
      await mergeCompleted;
      expect((await context.storage.getEnvironment("auto-env"))?.autoMergePrUrl).toBe(url);
    } else {
      const loadAll = spyOn(context.storage, "loadEnvironments");
      const ownerReads = spyOn(storageDatabase(context.storage), "readStoreRowsByOwner");
      const syncPr = spyOn(context.runtime.prMonitor, "sync");
      const syncDiff = spyOn(context.runtime.diffStats, "sync");
      try {
        expect(await backend.invoke("get_environments", { projectId: "project" })).toMatchObject([
          { id: "auto-env", prUrl: url },
        ]);
        expect(
          await backend.invoke("get_environment_snapshots", {
            projectId: "project",
            includePrMonitorHealth: true,
          }),
        ).toMatchObject([{ id: "auto-env", prUrl: url, prMonitorConfirmed: true }]);
        expect(ownerReads.mock.calls).toEqual([
          ["environments", "project"],
          ["environments", "project"],
        ]);
        // Observe the real sync entry points as well as reads, including work
        // that could have been queued to run after the command resolves.
        expect(syncPr).not.toHaveBeenCalled();
        expect(syncDiff).not.toHaveBeenCalled();
        expect(loadAll).not.toHaveBeenCalled();
        expect(scheduleCleanup).not.toHaveBeenCalled();
      } finally {
        syncDiff.mockRestore();
        syncPr.mockRestore();
        ownerReads.mockRestore();
        loadAll.mockRestore();
      }
    }
  } finally {
    unsubscribe?.();
    await backend.shutdown();
    scheduleCleanup.mockRestore();
    start.mockRestore();
    reachability?.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
