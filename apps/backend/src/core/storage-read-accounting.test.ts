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

describe("scoped storage read accounting", () => {
  test.each([
    ["kanban", "projectId", false],
    ["kanban", "projectId", true],
    ["sessions", "environmentId", false],
    ["sessions", "environmentId", true],
  ] as const)(
    "%s owner reads charge selected rows once (%s, warm: %s)",
    async (store, ownerField, warm) => {
      const { storage, dataDir } = await storageIn();
      const db = openBackendDatabase(dataDir);
      const selected = [
        { id: "a", [ownerField]: "p1" },
        { id: "c", [ownerField]: "p1" },
      ];
      db.writeStore(store, [selected[0], { id: "b", [ownerField]: "p2" }, selected[1]]);
      // A separate connection starts cold; warming it must not change scoped cost.
      const reader = openBackendDatabase(dataDir);
      try {
        if (warm) reader.readStore(store);
        expect(
          await costDuring("tab-cleanup", () => {
            expect(reader.readStoreRowsByOwner(store, "p1")).toEqual(selected);
          }),
        ).toEqual({
          units: { "storage-read": 1 },
          bytes: selected.reduce((sum, row) => sum + JSON.stringify(row).length, 0),
        });
        expect(
          await costDuring("tab-cleanup", () => {
            expect(reader.readStoreRowsByOwner(store, "missing")).toEqual([]);
          }),
        ).toEqual({ units: { "storage-read": 1 }, bytes: 0 });
      } finally {
        reader.close();
        db.close();
        storage.close();
      }
    },
  );

  test("keyed row reads charge only the selected row, including missing rows", async () => {
    const { storage, dataDir } = await storageIn();
    const db = openBackendDatabase(dataDir);
    const row = { id: "one", projectId: "p1" };
    db.writeStore("kanban", [row, { id: "two", projectId: "p2" }]);
    try {
      expect(
        await costDuring("tab-cleanup", () => {
          expect(db.readStoreRow("kanban", "one")).toEqual(row);
          expect(db.readStoreRow("kanban", "missing")).toBeUndefined();
        }),
      ).toEqual({ units: { "storage-read": 2 }, bytes: JSON.stringify(row).length });
    } finally {
      db.close();
      storage.close();
    }
  });

  test("document fallbacks charge a cold document once and cached owner reads fetch no bytes", async () => {
    const { storage, dataDir } = await storageIn();
    const db = openBackendDatabase(dataDir);
    const document = JSON.stringify([
      { id: "one", projectId: "p1" },
      { id: "two", projectId: "p2" },
    ]);
    db.transaction(() => db.writeRawDocumentInTransaction("kanban", document));
    try {
      expect(
        await costDuring("tab-cleanup", () => db.readStoreRowsByOwner("kanban", "p1")),
      ).toEqual({ units: { "storage-read": 1 }, bytes: document.length });
      expect(
        await costDuring("tab-cleanup", () => db.readStoreRowsByOwner("kanban", "p1")),
      ).toEqual({ units: { "storage-read": 1 }, bytes: 0 });
      expect(
        await costDuring("tab-cleanup", () => {
          expect(db.readStoreRow("kanban", "one")).toEqual({ id: "one", projectId: "p1" });
          expect(db.readStoreRow("kanban", "missing")).toBeUndefined();
        }),
      ).toEqual({ units: { "storage-read": 2 }, bytes: document.length * 2 });
    } finally {
      db.close();
      storage.close();
    }
  });

  test("a foreign workflow-result write rebuilds the index with one content read and row stats", async () => {
    const { storage, dataDir } = await storageIn();
    const results = new WorkflowResultService(dataDir);
    const other = new WorkflowResultService(dataDir);
    const slot = {
      kind: "feature-plan-state" as const,
      environmentId: "env-1",
      projectId: "p1",
      provider: "codex" as const,
    };
    try {
      await results.prepare({ ...slot, resultKey: "one" });
      await other.prepare({ ...slot, resultKey: "two" });
      const db = openBackendDatabase(dataDir);
      const expectedBytes =
        (db.readStoreHeader("workflow-results")?.document?.length ?? 0) +
        (
          db.db
            .query("SELECT value FROM store_rows WHERE store = ?")
            .all("workflow-results") as Array<{ value: string }>
        ).reduce((sum, row) => sum + row.value.length, 0);
      db.close();
      expect(expectedBytes).toBeGreaterThan(0);
      expect(
        await costDuring("feature-planning-tick", () => results.deleteByEnvironment("env-other")),
      ).toEqual({ units: { "storage-read": 1, "storage-stat": 2 }, bytes: expectedBytes });
      expect(
        await costDuring("feature-planning-tick", () => results.deleteByEnvironment("env-other")),
      ).toEqual({ units: { "storage-stat": 2 }, bytes: 0 });
    } finally {
      results.closeStorage();
      other.closeStorage();
      storage.close();
    }
  });
});
