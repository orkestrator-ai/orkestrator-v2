import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { Environment, Project } from "./models.js";

async function withStorage<T>(
  run: (storage: StorageService, changes: ResourceChange[]) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-resource-events-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const changes: ResourceChange[] = [];
  storage.setResourceChangeListener((change) => changes.push(change));
  try {
    return await run(storage, changes);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function project(id: string): Project {
  return {
    id,
    name: id,
    gitUrl: `https://example.invalid/${id}.git`,
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  };
}

function environment(id: string, projectId: string): Environment {
  return {
    id,
    projectId,
    name: id,
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  } as Environment;
}

function kinds(changes: ResourceChange[]): string[] {
  return changes.map((change) => change.resource);
}

describe("StorageService resource change announcements", () => {
  test("announces project create, update, reorder and delete", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      expect(changes.at(-1)).toMatchObject({ resource: "project", id: "p1" });

      await storage.updateProject("p1", { name: "renamed" });
      expect(changes.at(-1)).toMatchObject({ resource: "project", id: "p1" });

      await storage.addProject(project("p2"));
      changes.length = 0;
      await storage.reorderProjects(["p2", "p1"]);
      // A reorder touches every record, so each one is announced.
      expect(new Set(changes.map((change) => change.id))).toEqual(new Set(["p1", "p2"]));

      changes.length = 0;
      await storage.removeProject("p1");
      expect(changes.at(-1)).toMatchObject({ resource: "project", id: "p1" });
    });
  });

  test("announces environment lifecycle against the environment id", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));
      expect(changes.at(-1)).toMatchObject({
        resource: "environment",
        id: "e1",
        projectId: "p1",
      });

      await storage.updateEnvironment("e1", { status: "running" });
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });

      await storage.recordEnvironmentActivity("e1", new Date(1000).toISOString());
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });

      await storage.setEnvironmentAgentActivity(
        "e1",
        "working",
        new Date(2000).toISOString(),
      );
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });

      await storage.removeEnvironment("e1");
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });
    });
  });

  test("does not announce when a no-op activity record changes nothing", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));
      await storage.recordEnvironmentActivity("e1", new Date(5000).toISOString());
      await storage.setEnvironmentAgentActivity(
        "e1",
        "working",
        new Date(5000).toISOString(),
      );

      changes.length = 0;
      // An older timestamp is discarded without a write, so nothing is announced.
      await storage.recordEnvironmentActivity("e1", new Date(1000).toISOString());
      await storage.setEnvironmentAgentActivity(
        "e1",
        "idle",
        new Date(1000).toISOString(),
      );
      expect(changes).toEqual([]);
    });
  });

  test("does not announce pure agent-activity lease renewals", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));
      const base = Date.now();
      const at = (offset: number) => new Date(base + offset).toISOString();

      // First observation is a genuine transition and must announce.
      await storage.setEnvironmentAgentActivity(
        "e1", "working", at(1_000), "frontend", "renderer-token",
      );
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });

      changes.length = 0;
      // Same observer, same state: a pure renewal refreshes only timestamps
      // and must not fan out a refetch to every connected client.
      await storage.setEnvironmentAgentActivity(
        "e1", "working", at(2_000), "frontend", "renderer-token",
      );
      expect(changes).toEqual([]);
      // ...but the lease itself still persisted.
      const renewed = await storage.getEnvironment("e1");
      const observer = Object.values(
        renewed!.frontendAgentActivityObservers ?? {},
      )[0]!;
      expect(observer.updatedAt).toBe(at(2_000));

      // A new source appearing is structural and announces.
      await storage.setEnvironmentAgentActivity(
        "e1", "working", at(3_000), "claude-terminal",
      );
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });

      changes.length = 0;
      // A same-state terminal refresh is also a pure timestamp refresh.
      await storage.setEnvironmentAgentActivity(
        "e1", "working", at(4_000), "claude-terminal",
      );
      expect(changes).toEqual([]);

      // A real per-observer state change announces even though the aggregate
      // stays "working" via the terminal source.
      await storage.setEnvironmentAgentActivity(
        "e1", "idle", at(5_000), "frontend", "renderer-token",
      );
      expect(changes.at(-1)).toMatchObject({ resource: "environment", id: "e1" });
    });
  });

  test("does not rewrite or announce a field-equal environment update", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));
      // First stop clears activity state and legitimately announces.
      await storage.updateEnvironment("e1", { name: "renamed", status: "stopped" });

      changes.length = 0;
      const before = await storage.getEnvironment("e1");
      // Re-applying the identical update merges to a field-equal record.
      await storage.updateEnvironment("e1", { name: "renamed", status: "stopped" });
      expect(changes).toEqual([]);
      expect(await storage.getEnvironment("e1")).toEqual(before!);
    });
  });

  test("announces kanban changes against the owning project", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      const task = await storage.addKanbanTask("p1", "title", "body");
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });

      await storage.updateKanbanTask(task.id, { title: "next" });
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });

      await storage.addKanbanComment(task.id, "comment");
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });

      await storage.deleteKanbanTask(task.id);
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });
    });
  });

  test("announces sessions against their environment, not the session id", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));

      changes.length = 0;
      const session = await storage.createSession("e1", "container-1", "tab-1", "plain");
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });

      await storage.updateSession(session.id, { status: "disconnected" });
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });

      await storage.removeSession(session.id);
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });
    });
  });

  test("announces session reorder, disconnect, and bulk removal", async () => {
    await withStorage(async (storage, changes) => {
      const first = await storage.createSession("e1", "container-1", "tab-1", "plain");
      const second = await storage.createSession("e1", "container-1", "tab-2", "plain");

      changes.length = 0;
      await storage.reorderSessions("e1", [second.id, first.id]);
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });

      changes.length = 0;
      await storage.disconnectEnvironmentSessions("e1");
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });

      changes.length = 0;
      await storage.removeSessionsByEnvironment("e1");
      expect(changes.at(-1)).toMatchObject({ resource: "session", id: "e1" });
    });
  });

  test("announces Kanban comment and image additions and deletions", async () => {
    await withStorage(async (storage, changes) => {
      const task = await storage.addKanbanTask("p1", "title", "body");
      const commented = await storage.addKanbanComment(task.id, "comment");

      changes.length = 0;
      await storage.deleteKanbanComment(task.id, commented.comments[0]!.id);
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });

      const onePixelPng = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">'
        + '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      changes.length = 0;
      const imaged = await storage.addKanbanImage(task.id, "pixel.png", onePixelPng);
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });

      changes.length = 0;
      await storage.deleteKanbanImage(task.id, imaged.images[0]!.id);
      expect(changes.at(-1)).toMatchObject({ resource: "kanban", id: "p1" });
    });
  });

  test("announces feature plans and project notes against the project", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));

      const plan = await storage.createFeaturePlan("p1");
      expect(changes.at(-1)).toMatchObject({ resource: "feature-plan", id: "p1" });

      await storage.appendFeaturePlanMessage(plan.id, "user", "hello");
      expect(changes.at(-1)).toMatchObject({ resource: "feature-plan", id: "p1" });

      await storage.saveProjectNotes("p1", "notes");
      expect(changes.at(-1)).toMatchObject({ resource: "project-notes", id: "p1" });
    });
  });

  test("announces feature-plan updates and story messages against the project", async () => {
    await withStorage(async (storage, changes) => {
      const plan = await storage.createFeaturePlan("p1");
      const story = {
        id: "story-1",
        title: "Story",
        description: "Description",
        acceptanceCriteria: ["works"],
        messages: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };

      changes.length = 0;
      await storage.updateFeaturePlan(plan.id, { title: "renamed", stories: [story] });
      expect(changes.at(-1)).toMatchObject({ resource: "feature-plan", id: "p1" });

      changes.length = 0;
      await storage.appendFeatureStoryMessage(plan.id, story.id, "user", "refine it");
      expect(changes.at(-1)).toMatchObject({ resource: "feature-plan", id: "p1" });
    });
  });

  test("announces config writes", async () => {
    await withStorage(async (storage, changes) => {
      await storage.updateGlobalConfig((await storage.loadConfig()).global);
      expect(changes.at(-1)).toMatchObject({ resource: "config", id: "app" });

      await storage.setGitHubToken("token");
      expect(changes.at(-1)).toMatchObject({ resource: "config", id: "app" });

      await storage.updateRepositoryConfig("p1", {
        defaultBranch: "develop",
        prBaseBranch: "main",
      });
      expect(changes.at(-1)).toMatchObject({ resource: "config", id: "app" });

      await storage.saveConfig(await storage.loadConfig());
      expect(changes.at(-1)).toMatchObject({ resource: "config", id: "app" });
    });
  });

  test("announces pane layout and looped review writes and deletes", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));

      changes.length = 0;
      await storage.savePaneLayout("e1", {
        version: 1,
        containerId: null,
        activePaneId: "pane-1",
        root: { kind: "leaf", id: "pane-1", tabs: [] },
      }, 0);
      expect(changes.at(-1)).toMatchObject({ resource: "pane-layout", id: "e1" });

      await storage.saveLoopedReviewWorkflow("w1", "e1", 1, { id: "w1" });
      expect(changes.at(-1)).toMatchObject({ resource: "looped-review", id: "w1" });

      await storage.deleteLoopedReviewWorkflow("w1");
      expect(changes.at(-1)).toMatchObject({ resource: "looped-review", id: "w1" });

      await storage.saveLoopedReviewWorkflow("w2", "e1", 1, { id: "w2" });
      await storage.saveLoopedReviewWorkflow("w3", "e1", 1, { id: "w3" });
      changes.length = 0;
      await storage.deleteLoopedReviewWorkflowsByEnvironment("e1");
      expect(new Set(changes.map((change) => change.id)))
        .toEqual(new Set(["w2", "w3"]));
      expect(changes.every((change) => change.resource === "looped-review")).toBe(true);

      await storage.deletePaneLayout("e1");
      expect(changes.at(-1)).toMatchObject({ resource: "pane-layout", id: "e1" });
    });
  });

  test("announces prompt queue and build pipeline writes and deletes", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addEnvironment(environment("e1", "p1"));
      changes.length = 0;

      await storage.savePromptQueue(
        "claude env-e1:tab-1",
        "e1",
        [{ id: "m1" }],
      );
      expect(changes.at(-1)).toMatchObject({
        resource: "prompt-queue",
        id: "e1",
      });

      await storage.claimPromptQueueHead(
        "claude env-e1:tab-1",
        "e1",
        "m1",
      );
      expect(changes.at(-1)).toMatchObject({
        resource: "prompt-queue",
        id: "e1",
      });

      await storage.saveBuildPipeline(
        "pipeline-1",
        "p1",
        "e1",
        1,
        { id: "pipeline-1" },
      );
      expect(changes.at(-1)).toMatchObject({
        resource: "build-pipeline",
        id: "pipeline-1",
      });

      await storage.deleteBuildPipeline("pipeline-1");
      expect(changes.at(-1)).toMatchObject({
        resource: "build-pipeline",
        id: "pipeline-1",
      });

      await storage.deletePromptQueuesByEnvironment("e1");
      expect(changes.at(-1)).toMatchObject({
        resource: "prompt-queue",
        id: "e1",
      });
    });
  });

  test("assigns strictly increasing revisions across every resource kind", async () => {
    await withStorage(async (storage, changes) => {
      await storage.addProject(project("p1"));
      await storage.addEnvironment(environment("e1", "p1"));
      await storage.saveProjectNotes("p1", "notes");
      await storage.addKanbanTask("p1", "title", "body");

      expect(kinds(changes)).toEqual([
        "project", "environment", "project-notes", "kanban",
      ]);
      const revisions = changes.map((change) => change.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
      expect(new Set(revisions).size).toBe(revisions.length);
    });
  });

  test("a throwing listener does not fail the mutation that succeeded", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-resource-events-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    storage.setResourceChangeListener(() => {
      throw new Error("client transport is broken");
    });
    try {
      await expect(storage.addProject(project("p1"))).resolves.toMatchObject({ id: "p1" });
      expect(await storage.getProject("p1")).toMatchObject({ id: "p1" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("stops announcing once the listener is detached", async () => {
    await withStorage(async (storage, changes) => {
      storage.setResourceChangeListener(null);
      await storage.addProject(project("p1"));
      expect(changes).toEqual([]);
    });
  });
});
