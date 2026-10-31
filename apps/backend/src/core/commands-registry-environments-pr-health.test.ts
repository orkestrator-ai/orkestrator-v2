import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

test("PR health filters by project and bounded allowlist and composes the monitor's real health", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-pr-health-"));
  const storage = new StorageService(root);
  const runtime = new BackendRuntime({ emit: () => undefined });
  try {
    await storage.init();
    const project = await storage.addProject(createProject("remote", root));
    const other = await storage.addProject(createProject("other", root));
    const worker = createEnvironment(project.id, { environmentType: "local" });
    Object.assign(worker, {
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
      hasMergeConflicts: false,
    });
    await storage.addEnvironment(worker);
    const noPr = await storage.addEnvironment(createEnvironment(project.id));
    const foreign = createEnvironment(other.id);
    Object.assign(foreign, { prUrl: "https://github.com/o/r/pull/2", prState: "open" });
    await storage.addEnvironment(foreign);
    const announced = spyOn(runtime.prMonitor, "announcedStates").mockReturnValue(
      new Map([
        [
          worker.id,
          {
            environmentId: worker.id,
            mode: "normal",
            checkInProgress: false,
            consecutiveErrors: 0,
            lastCheckAt: new Date().toISOString(),
            lastSuccessfulCheckAt: new Date().toISOString(),
            prUrl: worker.prUrl!,
            prState: "open",
            hasMergeConflicts: false,
            checkSummary: { passed: 2, total: 3, pending: 1 },
            viewerCanMerge: true,
          },
        ],
      ]),
    );
    const handler = createCommandRegistry().get("get_environment_pr_health")!;
    const context = { storage, runtime } as CommandContext;
    const read = (environmentIds?: unknown[]) =>
      handler({ projectId: project.id, ...(environmentIds ? { environmentIds } : {}) }, context);
    const expected = {
      [worker.id]: {
        prMonitorConfirmed: true,
        prViewerCanMerge: true,
        prCheckSummary: { passed: 2, total: 3, pending: 1 },
      },
    };
    expect(await read()).toEqual(expected);
    expect(await read([worker.id, foreign.id, noPr.id])).toEqual(expected);
    expect(await read([foreign.id, noPr.id])).toEqual({});
    expect(await read([])).toEqual({});
    expect(await read([...Array.from({ length: 1000 }, () => "not-selected"), worker.id])).toEqual(
      {},
    );
    expect(await read([null, 42, worker.id])).toEqual(expected);
    expect(announced).toHaveBeenCalledTimes(6);
  } finally {
    runtime.shutdown();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
