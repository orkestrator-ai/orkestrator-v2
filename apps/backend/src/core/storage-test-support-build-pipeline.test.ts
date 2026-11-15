/**
 * `seedBuildPipeline` stores a pipeline from outside the backend, the way the
 * real-stack specs give a running profile a finished pipeline through
 * `e2e/agent-testing/backend-store.ts` (the backend has no command that writes
 * an arbitrary snapshot). A running `StorageService` must read the record
 * without a restart, and the seed must refuse what a real admission would.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { seedBuildPipeline } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function finishedPipeline(id: string): BuildPipeline {
  return {
    id,
    projectId: "project-1",
    taskId: id,
    environmentId: "",
    environmentType: "local",
    agentType: "codex",
    phase: "failed",
    error: "Seeded fixture",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 1,
    createdAt: new Date(0).toISOString(),
    taskTitle: "Seeded",
    controller: "backend",
    backendRevision: 0,
    taskSnapshot: {
      title: "Seeded",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
  };
}

async function runningStorage(): Promise<{ dataDir: string; storage: StorageService }> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-seeded-build-pipeline-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return { dataDir, storage };
}

test("a seeded pipeline reaches a running backend's reads as a backend-owned record", async () => {
  const { dataDir, storage } = await runningStorage();
  expect(await storage.listBuildPipelines("project-1")).toEqual([]);

  const seeded = await seedBuildPipeline(
    dataDir,
    finishedPipeline("seeded-1") as unknown as Record<string, unknown>,
  );

  expect(seeded).toMatchObject({ id: "seeded-1", projectId: "project-1", revision: 1 });
  const listed = await storage.listBuildPipelines("project-1");
  expect(listed.map((record) => record.id)).toEqual(["seeded-1"]);
  expect(listed[0]!.snapshot).toMatchObject({
    phase: "failed",
    controller: "backend",
    backendRevision: 1,
  });
});

test("refuses a snapshot that is not a pipeline, and an id that already exists", async () => {
  const { dataDir, storage } = await runningStorage();
  await expect(seedBuildPipeline(dataDir, { id: "broken" })).rejects.toThrow(
    "Not a build pipeline snapshot",
  );
  const snapshot = finishedPipeline("seeded-2") as unknown as Record<string, unknown>;
  await seedBuildPipeline(dataDir, snapshot);
  await expect(seedBuildPipeline(dataDir, snapshot)).rejects.toThrow("already exists");
  expect((await storage.listBuildPipelines("project-1")).map((record) => record.id)).toEqual([
    "seeded-2",
  ]);
});

test("refuses a pipeline whose admission an active pipeline already holds", async () => {
  const { dataDir, storage } = await runningStorage();
  const active = (id: string) =>
    ({
      ...finishedPipeline(id),
      phase: "building",
      error: undefined,
      admissionKey: "admission-1",
    }) as unknown as Record<string, unknown>;
  await seedBuildPipeline(dataDir, active("seeded-3"));

  // saveBuildPipeline answers a colliding first admission with the holder's
  // record rather than an error; the seed must not report that as stored.
  await expect(seedBuildPipeline(dataDir, active("seeded-4"))).rejects.toThrow(
    "An active build pipeline already holds this admission: seeded-3",
  );
  expect((await storage.listBuildPipelines("project-1")).map((record) => record.id)).toEqual([
    "seeded-3",
  ]);
});
