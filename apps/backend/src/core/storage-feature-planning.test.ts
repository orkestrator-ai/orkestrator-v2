import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import { FeaturePlanningFenceError, StorageService } from "./storage.js";

const dataDirs: string[] = [];

async function createStorage(): Promise<{ storage: StorageService; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-feature-planning-storage-"));
  dataDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  return { storage, dataDir };
}

function record(
  featureId: string,
  overrides: Partial<FeaturePlanningRecord> = {},
): FeaturePlanningRecord {
  return {
    version: 1,
    operationId: "operation-1",
    featureId,
    projectId: "caller-supplied-project",
    kind: "feature",
    userMessage: "Plan this feature",
    phase: "dispatching",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    backendRevision: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => fs.rm(dataDir, { recursive: true, force: true })),
  );
});

describe("StorageService feature planning authority", () => {
  test("canonicalizes project ownership and prevents concurrent active starts", async () => {
    const { storage } = await createStorage();
    const feature = await storage.createFeaturePlan("canonical-project");

    const [first, second] = await Promise.all([
      storage.startFeaturePlanning(record(feature.id, { operationId: "operation-a" })),
      storage.startFeaturePlanning(record(feature.id, { operationId: "operation-b" })),
    ]);

    expect([first.started, second.started].filter(Boolean)).toHaveLength(1);
    const persisted = await storage.getFeaturePlan(feature.id);
    expect(persisted?.planning?.projectId).toBe("canonical-project");
    expect(persisted?.planning?.operationId).toMatch(/^operation-[ab]$/);
  });

  test("lists only valid active records and permits replacing a terminal record", async () => {
    const { storage, dataDir } = await createStorage();
    const active = await storage.createFeaturePlan("project-1");
    const terminal = await storage.createFeaturePlan("project-1");
    const malformed = await storage.createFeaturePlan("project-1");
    await storage.startFeaturePlanning(record(active.id));
    await storage.startFeaturePlanning(
      record(terminal.id, {
        operationId: "terminal-operation",
        phase: "complete",
      }),
    );

    const plans = await storage.listAllFeaturePlans();
    const malformedPlan = plans.find((plan) => plan.id === malformed.id)!;
    malformedPlan.planning = { phase: "running" } as never;
    await fs.writeFile(
      path.join(dataDir, "feature-plans.json"),
      `${JSON.stringify(plans, null, 2)}\n`,
    );

    await expect(storage.listActiveFeaturePlanning()).resolves.toEqual([
      expect.objectContaining({ featureId: active.id, phase: "dispatching" }),
    ]);
    await expect(
      storage.startFeaturePlanning(
        record(terminal.id, {
          operationId: "replacement-operation",
        }),
      ),
    ).resolves.toMatchObject({
      started: true,
      feature: { planning: { operationId: "replacement-operation" } },
    });
    await expect(
      storage.startFeaturePlanning({
        ...record(active.id),
        backendRevision: -1,
      }),
    ).rejects.toThrow("Feature planning record is invalid");
  });

  test("fences mutations, bumps revisions, and clears only the matching operation", async () => {
    const { storage } = await createStorage();
    const feature = await storage.createFeaturePlan("project-1");
    await storage.startFeaturePlanning(record(feature.id));

    await expect(
      storage.mutateFeaturePlanning(feature.id, "stale-operation", () => undefined),
    ).rejects.toBeInstanceOf(FeaturePlanningFenceError);

    const mutated = await storage.mutateFeaturePlanning(
      feature.id,
      "operation-1",
      (plan, planning) => {
        plan.summary = "durable update";
        planning.phase = "running";
        return "result";
      },
    );
    expect(mutated.result).toBe("result");
    expect(mutated.feature).toMatchObject({
      summary: "durable update",
      planning: { phase: "running", backendRevision: 1 },
    });

    await storage.clearFeaturePlanning(feature.id, "stale-operation");
    expect((await storage.getFeaturePlan(feature.id))?.planning?.operationId).toBe("operation-1");
    await storage.clearFeaturePlanning(feature.id, "operation-1");
    expect((await storage.getFeaturePlan(feature.id))?.planning).toBeUndefined();
  });

  test("generic storage updates preserve lifecycle-owned fields", async () => {
    const { storage } = await createStorage();
    const feature = await storage.createFeaturePlan("project-1");
    await storage.startFeaturePlanning(record(feature.id));
    const attached = await storage.getFeaturePlan(feature.id);

    const updated = await storage.updateFeaturePlan(feature.id, {
      id: "forged-feature",
      projectId: "forged-project",
      createdAt: "forged-created-at",
      updatedAt: "forged-updated-at",
      order: 999,
      planning: record(feature.id, { operationId: "forged-operation" }),
      title: "allowed title",
    } as never);

    expect(updated).toMatchObject({
      id: feature.id,
      projectId: "project-1",
      createdAt: feature.createdAt,
      order: feature.order,
      title: "allowed title",
      planning: { operationId: "operation-1" },
    });
    expect(updated.updatedAt).not.toBe("forged-updated-at");
    expect(updated.planning).toEqual(attached?.planning);
  });
});
