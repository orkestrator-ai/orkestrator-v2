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
