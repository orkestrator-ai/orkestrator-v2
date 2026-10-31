import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { OrkestratorBackend } from "./index.js";

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

test("backend startup restores saved auto-merge and polls without any client request", async () => {
  const { createEnvironment } = await import("./storage.js");
  const { seedStore } = await import("./storage-test-support.js");
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
      autoMerge: true,
    },
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
    service as unknown as { options: import("./pr-monitor.js").PrMonitorServiceOptions }
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
  try {
    await backend.init();
    expect(service.trackedIds()).toContain("auto-env");
    expect(detections).toBe(0);
    expect(timers.length).toBeGreaterThan(0);
    timers.shift()!();
    await mergeCompleted;
    expect(detections).toBe(1);
    expect((await context.storage.getEnvironment("auto-env"))?.autoMergePrUrl).toBe(url);
  } finally {
    await backend.shutdown();
    start.mockRestore();
    reachability?.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
