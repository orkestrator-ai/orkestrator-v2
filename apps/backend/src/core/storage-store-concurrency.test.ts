import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

/**
 * Lost-update regressions for the stores that used to be plain
 * load -> mutate -> save JSON writers (sessions, project notes, Linear
 * completion comments) or in-process-only (feature plans). Each run splits
 * its writes across two backends sharing one data directory.
 */

const directories: string[] = [];
const services: StorageService[] = [];

async function storagePair(): Promise<[StorageService, StorageService]> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-store-concurrency-"));
  directories.push(dataDir);
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  services.push(first, second);
  await Promise.all([first.init(), second.init()]);
  return [first, second];
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const WRITES = 16;

describe("concurrent store writers across backends", () => {
  test("keeps every concurrently created session with a distinct order", async () => {
    const [first, second] = await storagePair();
    await Promise.all(
      Array.from({ length: WRITES }, (_, index) =>
        (index % 2 === 0 ? first : second).createSession(
          "env-1",
          "container-1",
          `tab-${index}`,
          "plain",
        ),
      ),
    );

    const sessions = await first.getSessionsByEnvironment("env-1");
    expect(new Set(sessions.map((session) => session.tabId)).size).toBe(WRITES);
    expect(new Set(sessions.map((session) => session.order)).size).toBe(WRITES);
  });

  test("keeps every concurrently saved project note", async () => {
    const [first, second] = await storagePair();
    await Promise.all(
      Array.from({ length: WRITES }, (_, index) =>
        (index % 2 === 0 ? first : second).kanban.saveProjectNotes(
          `project-${index}`,
          `note ${index}`,
        ),
      ),
    );

    for (let index = 0; index < WRITES; index += 1) {
      expect((await second.kanban.getProjectNotes(`project-${index}`)).content).toBe(
        `note ${index}`,
      );
    }
  });

  test("keeps every concurrently saved Linear completion comment", async () => {
    const [first, second] = await storagePair();
    await Promise.all(
      Array.from({ length: WRITES }, (_, index) =>
        (index % 2 === 0 ? first : second).kanban.saveLinearCompletionComment({
          pipelineId: `pipeline-${index}`,
          issueId: `issue-${index}`,
          status: "posted",
        }),
      ),
    );

    for (let index = 0; index < WRITES; index += 1) {
      const comment = await first.kanban.getLinearCompletionComment(`pipeline-${index}`);
      expect(comment?.issueId).toBe(`issue-${index}`);
    }
  });

  test("keeps every concurrently created feature plan", async () => {
    const [first, second] = await storagePair();
    const created = await Promise.all(
      Array.from({ length: WRITES }, (_, index) =>
        (index % 2 === 0 ? first : second).kanban.createFeaturePlan("project-1"),
      ),
    );

    const plans = await second.kanban.getFeaturePlans("project-1");
    expect(new Set(plans.map((plan) => plan.id))).toEqual(new Set(created.map((plan) => plan.id)));
  });
});
