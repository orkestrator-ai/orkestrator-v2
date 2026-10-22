import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageService } from "./storage.js";
import { openBackendDatabase } from "./storage-stores.js";
import { WorkflowResultService } from "./workflow-result-service.js";

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

async function costDuring(kind: RecurringJobKind, run: () => unknown) {
  recurringWorkMetrics.reset();
  await recurringWorkMetrics.observe(kind, run);
  const entry = recurringWorkMetrics.snapshot().kinds[kind];
  return { units: entry?.workUnits ?? {}, bytes: entry?.bytes ?? 0 };
}

async function unitsDuring(kind: RecurringJobKind, run: () => unknown) {
  return (await costDuring(kind, run)).units;
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

  test("reusing live pipeline tags in a transcript sweep is a storage stat", async () => {
    const { storage, dataDir } = await storageIn();
    await storage.saveBuildPipeline("p1", "proj-1", "", 1, { id: "p1", phase: "building" });
    // The first sweep decodes the control store into the live-tag cache. The
    // orphan sweep and the repair pass each list the manifest rows, which
    // are uncached row reads.
    expect(
      await unitsDuring("build-supervisor-tick", () => storage.sweepBuildPipelineTranscripts()),
    ).toEqual({ "storage-read": 3 });

    // A warm sweep: one stat for the live-tag hit, one for the repair pass
    // diffing its quota totals write against the committed row, and the two
    // manifest listings.
    expect(
      await unitsDuring("build-supervisor-tick", () => storage.sweepBuildPipelineTranscripts()),
    ).toEqual({ "storage-read": 2, "storage-stat": 2 });

    // Another process's write: the live tags are decoded again.
    const { storage: other } = await storageIn(dataDir);
    await other.saveBuildPipeline("p2", "proj-1", "", 1, { id: "p2", phase: "building" });
    expect(
      await unitsDuring("build-supervisor-tick", () => storage.sweepBuildPipelineTranscripts()),
    ).toEqual({ "storage-read": 3, "storage-stat": 1 });
    other.close();
    storage.close();
  });

  test("only content fetched from the database charges bytes", async () => {
    const { storage, dataDir } = await storageIn();
    const plan = await storage.createFeaturePlan("project-1");
    await storage.getFeaturePlan(plan.id);

    // Served by the connection's row cache: a read, nothing fetched.
    expect(
      await costDuring("feature-planning-tick", () => storage.getFeaturePlan(plan.id)),
    ).toEqual({ units: { "storage-read": 1 }, bytes: 0 });

    // A foreign write invalidates the cache: the same read fetches the rows.
    const { storage: other } = await storageIn(dataDir);
    await other.updateFeaturePlan(plan.id, { title: "renamed" });
    const miss = await costDuring("feature-planning-tick", () => storage.getFeaturePlan(plan.id));
    expect(miss.units).toEqual({ "storage-read": 1 });
    expect(miss.bytes).toBeGreaterThan(0);
    other.close();
    storage.close();
  });

  test("uncached row access is charged as reads with the bytes it fetched", async () => {
    const { dataDir } = await storageIn();
    const database = openBackendDatabase(dataDir);
    const rows = database.rows("storage-deletion-fences");
    database.transaction(() => rows.put("environment/env-1", "12"));

    expect(
      await costDuring("tab-cleanup", () => {
        rows.get("environment/env-1");
        rows.list();
      }),
    ).toEqual({ units: { "storage-read": 2 }, bytes: 4 });
    // Key-only lookups still query the database, but fetch no content.
    expect(
      await costDuring("tab-cleanup", () => {
        rows.has("environment/env-1");
        rows.owners();
        rows.list({ values: false });
        rows.get("environment/missing");
      }),
    ).toEqual({ units: { "storage-read": 4 }, bytes: 0 });
    // Row writes are not reads.
    expect(
      await costDuring("tab-cleanup", () =>
        database.transaction(() => rows.put("environment/env-2", "13")),
      ),
    ).toEqual({ units: {}, bytes: 0 });
    database.close();
  });

  test("blob files outside the stores are file reads, not storage reads", async () => {
    const { storage } = await storageIn();
    await storage.saveSessionBuffer("session-1", "buffer");
    expect(await costDuring("tab-cleanup", () => storage.loadSessionBuffer("session-1"))).toEqual({
      units: { "file-read": 1 },
      bytes: 6,
    });
    storage.close();
  });

  test("a workflow-result entry index hit is a storage stat", async () => {
    const { dataDir } = await storageIn();
    const results = new WorkflowResultService(dataDir);
    await results.prepare({
      resultKey: "result-1",
      kind: "feature-plan-state",
      environmentId: "env-1",
      projectId: "project-1",
      provider: "codex",
    });

    // The index built by the commit above is still at the committed revision.
    // A commit revalidates it before taking the write lock and again inside
    // the transaction: two stats, no reads.
    expect(
      await unitsDuring("feature-planning-tick", () => results.deleteByEnvironment("env-other")),
    ).toEqual({ "storage-stat": 2 });
    results.closeStorage();
  });
});
