import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageService } from "./storage.js";

// Storage cost charged to recurring work. An extra read must show however warm
// the connection's row cache is, so a whole-store read served from that cache
// is still a `storage-read`; only reusing records a domain already decoded is
// a `storage-stat`.

const directories: string[] = [];

afterEach(async () => {
  recurringWorkMetrics.reset();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function storageIn(dataDir?: string): Promise<{ storage: StorageService; dataDir: string }> {
  const directory = dataDir ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-read-cost-")));
  if (!dataDir) directories.push(directory);
  const storage = new StorageService(directory);
  await storage.init();
  return { storage, dataDir: directory };
}

async function unitsDuring(kind: RecurringJobKind, run: () => Promise<unknown>) {
  recurringWorkMetrics.reset();
  await recurringWorkMetrics.observe(kind, run);
  return recurringWorkMetrics.snapshot().kinds[kind]?.workUnits ?? {};
}

describe("storage read accounting", () => {
  test("a whole-store read served from the row cache is still a storage read", async () => {
    const { storage, dataDir } = await storageIn();
    const plan = await storage.createFeaturePlan("project-1");
    await storage.getFeaturePlan(plan.id);

    expect(
      await unitsDuring("feature-planning-tick", async () => {
        await storage.getFeaturePlan(plan.id);
        await storage.getFeaturePlan(plan.id);
      }),
    ).toEqual({ "storage-read": 2 });

    // Another process's write: the next read reloads the rows, still one read.
    const { storage: other } = await storageIn(dataDir);
    await other.updateFeaturePlan(plan.id, { title: "renamed" });
    expect(
      await unitsDuring("feature-planning-tick", () => storage.getFeaturePlan(plan.id)),
    ).toEqual({ "storage-read": 1 });
    other.close();
    storage.close();
  });

  test("reusing decoded build pipelines is a storage stat; reloading them is a read", async () => {
    const { storage, dataDir } = await storageIn();
    await storage.saveBuildPipeline("p1", "proj-1", "", 1, { id: "p1", phase: "building" });

    expect(
      await unitsDuring("build-supervisor-tick", async () => {
        await storage.getBuildPipeline("p1");
        await storage.listAllBuildPipelines();
      }),
    ).toEqual({ "storage-stat": 2 });

    const { storage: other } = await storageIn(dataDir);
    await other.saveBuildPipeline("p2", "proj-1", "", 1, { id: "p2", phase: "building" });
    expect(
      await unitsDuring("build-supervisor-tick", async () => {
        await storage.getBuildPipeline("p1");
        await storage.getBuildPipeline("p1");
      }),
    ).toEqual({ "storage-read": 1, "storage-stat": 1 });
    other.close();
    storage.close();
  });
});
