import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GraphStorageError } from "./graph-run-errors.js";
import { graphEnvironmentFixture, graphRunFixture } from "./graph-run-test-support.js";
import { GRAPH_EFFECT_MAX_DATA_BYTES } from "./storage-graph-effects.js";
import { StorageService } from "./storage.js";

const roots: string[] = [];
const services: StorageService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function store(): Promise<StorageService> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-effects-"));
  roots.push(root);
  const storage = new StorageService(root);
  await storage.init();
  services.push(storage);
  await storage.addEnvironment(graphEnvironmentFixture());
  await storage.graphRuns.createGraphRun(graphRunFixture());
  return storage;
}

const intent = (key = "push:main:abc", owner = "process-1") => ({
  runId: "run-1",
  key,
  action: "push-branch" as const,
  nodeId: "push",
  activation: "push#iter=1#attempt=1",
  owner,
});

describe("graph effect journal", () => {
  test("records an intent, settles it and replays a done effect", async () => {
    const storage = await store();
    const begun = await storage.graphEffects.beginGraphEffect({ ...intent(), data: { a: 1 } });
    expect(begun).toMatchObject({ previous: null, record: { state: "intended", attempts: 1 } });
    await storage.graphEffects.settleGraphEffect("run-1", "push:main:abc", {
      state: "done",
      data: { b: 2 },
    });
    const again = await storage.graphEffects.beginGraphEffect(intent("push:main:abc", "process-2"));
    expect(again).toMatchObject({
      previous: "done",
      record: { state: "done", attempts: 1, owner: "process-1", data: { a: 1, b: 2 } },
    });
    // Done is final.
    await storage.graphEffects.settleGraphEffect("run-1", "push:main:abc", {
      state: "failed",
      error: "late",
    });
    expect((await storage.graphEffects.getGraphEffect("run-1", "push:main:abc"))?.state).toBe(
      "done",
    );
  });

  test("an unsettled or failed intent is claimed again, keeping its data", async () => {
    const storage = await store();
    await storage.graphEffects.beginGraphEffect({ ...intent(), data: { runId: "v-1" } });
    const recovered = await storage.graphEffects.beginGraphEffect(
      intent("push:main:abc", "process-2"),
    );
    expect(recovered).toMatchObject({
      previous: "intended",
      previousOwner: "process-1",
      record: { state: "intended", attempts: 2, owner: "process-2", data: { runId: "v-1" } },
    });
    await storage.graphEffects.settleGraphEffect("run-1", "push:main:abc", {
      state: "failed",
      error: "x".repeat(5_000),
    });
    const failed = await storage.graphEffects.getGraphEffect("run-1", "push:main:abc");
    expect(failed?.error).toHaveLength(2_000);
    const retried = await storage.graphEffects.beginGraphEffect(intent());
    expect(retried.previous).toBe("failed");
    expect(retried.record).not.toHaveProperty("error");
  });

  test("lists a run's effects and leaves artifact reads alone", async () => {
    const storage = await store();
    await storage.graphEffects.beginGraphEffect(intent("b"));
    await storage.graphEffects.beginGraphEffect(intent("a"));
    expect(
      (await storage.graphEffects.listGraphEffects("run-1")).map((effect) => effect.key).sort(),
    ).toEqual(["a", "b"]);
    expect(await storage.graphRuns.listGraphArtifacts("run-1")).toEqual([]);
  });

  test("bounds data and keys, and refuses a missing run or a deleting environment", async () => {
    const storage = await store();
    await expect(
      storage.graphEffects.beginGraphEffect({
        ...intent(),
        data: { blob: "x".repeat(GRAPH_EFFECT_MAX_DATA_BYTES) },
      }),
    ).rejects.toBeInstanceOf(GraphStorageError);
    await expect(storage.graphEffects.beginGraphEffect(intent("k".repeat(513)))).rejects.toThrow(
      "Invalid graph effect key",
    );
    await expect(
      storage.graphEffects.beginGraphEffect({ ...intent(), runId: "run-2" }),
    ).rejects.toMatchObject({ code: "run-not-found" });
    await storage.updateEnvironment("e1", { deletionRequestedAt: "2026-10-29T00:00:00.000Z" });
    await expect(storage.graphEffects.beginGraphEffect(intent())).rejects.toMatchObject({
      code: "environment-deleting",
    });
  });

  test("environment deletion removes a run's effects with its artifacts", async () => {
    const storage = await store();
    await storage.graphEffects.beginGraphEffect(intent());
    expect(await storage.graphRuns.deleteGraphRunsByEnvironment("e1")).toEqual(["run-1"]);
    expect(await storage.graphEffects.listGraphEffects("run-1")).toEqual([]);
    expect(await storage.graphEffects.getGraphEffect("run-1", "push:main:abc")).toBeNull();
  });
});
