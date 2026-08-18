import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

const dataDirs: string[] = [];

async function createStorage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-feature-build-claim-"));
  dataDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  return storage;
}

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => fs.rm(dataDir, { recursive: true, force: true })),
  );
});

describe("StorageService feature build claims", () => {
  test("allows exactly one concurrent task to reserve a feature build", async () => {
    const storage = await createStorage();
    const feature = await storage.createFeaturePlan("project-1");

    const [first, second] = await Promise.all([
      storage.claimFeaturePlanBuild(feature.id, "task-a"),
      storage.claimFeaturePlanBuild(feature.id, "task-b"),
    ]);

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    const winner = first.claimed ? first : second;
    const loser = first.claimed ? second : first;
    const winningTaskId = winner.feature.buildTaskId;
    expect(loser.feature.buildTaskId).toBe(winningTaskId);
    expect(winner.feature).toMatchObject({
      status: "building",
      buildTaskId: expect.stringMatching(/^task-[ab]$/),
    });

    const persisted = await storage.getFeaturePlans("project-1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.buildTaskId).toBe(winningTaskId);
  });

  test("treats retrying the winning task as an idempotent claim", async () => {
    const storage = await createStorage();
    const feature = await storage.createFeaturePlan("project-1");

    expect((await storage.claimFeaturePlanBuild(feature.id, "task-a")).claimed).toBe(true);
    expect((await storage.claimFeaturePlanBuild(feature.id, "task-a")).claimed).toBe(true);
    expect((await storage.claimFeaturePlanBuild(feature.id, "task-b")).claimed).toBe(false);
  });
});
