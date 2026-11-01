import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { startFeaturePlanBuild } from "./feature-plan-build.js";
import { launchBuildPipeline } from "./build-pipeline-launch.js";
import type { Project } from "./models.js";
import type { FeaturePlan } from "./storage-shared.js";

type StartBehaviour = (input: StartBuildPipelineInput, storage: StorageService) => Promise<void>;

function fakeSupervisor(storage: StorageService, behaviour?: StartBehaviour) {
  const started: StartBuildPipelineInput[] = [];
  return {
    started,
    service: {
      async start(input: StartBuildPipelineInput) {
        started.push(input);
        await behaviour?.(input, storage);
        return {
          id: `pipeline-${started.length}`,
          taskId: input.taskId,
          projectId: input.projectId,
          environmentId: "env-built",
          phase: "building",
        };
      },
    } as never,
  };
}

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-feature-plan-build-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "project-1",
    name: "acme",
    gitUrl: "https://example.invalid/acme.git",
    localPath: "/tmp/acme",
    addedAt: new Date(0).toISOString(),
    order: 0,
  } as Project);
  try {
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function plannedFeature(storage: StorageService): Promise<FeaturePlan> {
  const plan = await storage.kanban.createFeaturePlan("project-1");
  const now = new Date(0).toISOString();
  return storage.kanban.updateFeaturePlan(plan.id, {
    title: "Dark mode",
    summary: "A dark theme",
    status: "stories",
    stories: [
      {
        id: "story-1",
        title: "Toggle",
        description: "A header toggle",
        acceptanceCriteria: ["It persists"],
        messages: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

describe("startFeaturePlanBuild", () => {
  test("creates the ticket, claims the plan and starts a Codex build with saved defaults", async () => {
    await withStorage(async (storage) => {
      const plan = await plannedFeature(storage);
      const supervisor = fakeSupervisor(storage);
      const result = await startFeaturePlanBuild(
        { featureId: plan.id },
        { storage, buildPipelines: supervisor.service },
      );

      expect(result.reused).toBe(false);
      expect(supervisor.started).toHaveLength(1);
      const started = supervisor.started[0]!;
      expect(started.agentType).toBe("codex");
      expect(started.environmentType).toBe("local");
      expect(started.featurePlanId).toBe(plan.id);
      expect(started.source).toEqual({ type: "kanban", taskId: result.taskId });
      expect(started.taskSnapshot.description).toContain("### 1. Toggle");
      // Saved Build defaults were filled by the backend, not the caller.
      expect(started.steps?.address?.agent).toBeDefined();

      const task = await storage.kanban.getKanbanTask(result.taskId);
      expect(task?.title).toBe("Dark mode");
      const linked = await storage.kanban.getFeaturePlan(plan.id);
      expect(linked).toMatchObject({
        status: "building",
        buildTaskId: result.taskId,
        buildPipelineId: "pipeline-1",
        codexEnvironmentId: "env-built",
      });
    });
  });

  test("never starts a second build for a linked plan", async () => {
    await withStorage(async (storage) => {
      const plan = await plannedFeature(storage);
      const supervisor = fakeSupervisor(storage);
      const context = { storage, buildPipelines: supervisor.service };
      const first = await startFeaturePlanBuild({ featureId: plan.id }, context);
      // The fake supervisor stores no pipeline record, so the link cannot be
      // read back: the launch refuses rather than starting another build.
      await expect(startFeaturePlanBuild({ featureId: plan.id }, context)).rejects.toThrow(
        "already has an active build",
      );
      expect(supervisor.started).toHaveLength(1);
      expect((await storage.kanban.getKanbanTasks("project-1")).map(({ id }) => id)).toEqual([
        first.taskId,
      ]);
    });
  });

  test("finishes a launch an earlier process claimed but never linked", async () => {
    await withStorage(async (storage) => {
      const plan = await plannedFeature(storage);
      const task = await storage.kanban.addKanbanTask("project-1", "Dark mode", "stories");
      await storage.kanban.claimFeaturePlanBuild(plan.id, task.id);
      const supervisor = fakeSupervisor(storage);
      const result = await startFeaturePlanBuild(
        { featureId: plan.id },
        { storage, buildPipelines: supervisor.service },
      );
      expect(result).toMatchObject({ taskId: task.id, reused: true });
      expect(supervisor.started[0]?.taskId).toBe(task.id);
      expect((await storage.kanban.getKanbanTasks("project-1")).length).toBe(1);
    });
  });

  test("releases its claim and deletes its ticket when the pipeline never starts", async () => {
    await withStorage(async (storage) => {
      const plan = await plannedFeature(storage);
      const supervisor = fakeSupervisor(storage, async () => {
        throw new Error("environment failed");
      });
      await expect(
        startFeaturePlanBuild(
          { featureId: plan.id },
          { storage, buildPipelines: supervisor.service },
        ),
      ).rejects.toThrow("environment failed");
      const after = await storage.kanban.getFeaturePlan(plan.id);
      expect(after?.status).toBe("stories");
      expect(after?.buildTaskId).toBeUndefined();
      expect(await storage.kanban.getKanbanTasks("project-1")).toEqual([]);
    });
  });

  test("never undoes a link the supervisor already recorded", async () => {
    await withStorage(async (storage) => {
      const plan = await plannedFeature(storage);
      const supervisor = fakeSupervisor(storage, async (input) => {
        await storage.kanban.updateFeaturePlan(plan.id, {
          status: "building",
          buildTaskId: input.taskId,
          buildPipelineId: "pipeline-linked",
        });
        throw new Error("Failed to start build pipeline");
      });
      await expect(
        startFeaturePlanBuild(
          { featureId: plan.id },
          { storage, buildPipelines: supervisor.service },
        ),
      ).rejects.toThrow("Failed to start build pipeline");
      const after = await storage.kanban.getFeaturePlan(plan.id);
      expect(after).toMatchObject({ status: "building", buildPipelineId: "pipeline-linked" });
      expect((await storage.kanban.getKanbanTasks("project-1")).length).toBe(1);
    });
  });

  test("refuses a plan with no stories without creating a ticket", async () => {
    await withStorage(async (storage) => {
      const plan = await storage.kanban.createFeaturePlan("project-1");
      const supervisor = fakeSupervisor(storage);
      await expect(
        startFeaturePlanBuild(
          { featureId: plan.id },
          { storage, buildPipelines: supervisor.service },
        ),
      ).rejects.toThrow("no stories");
      expect(await storage.kanban.getKanbanTasks("project-1")).toEqual([]);
    });
  });
});

describe("launchBuildPipeline", () => {
  test("fills omitted steps from saved defaults and keeps explicit choices", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      await launchBuildPipeline(
        {
          taskId: "task-1",
          projectId: "project-1",
          environmentType: "local",
          taskTitle: "T",
          taskSnapshot: {
            title: "T",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
          source: { type: "kanban", taskId: "task-1" },
          namingPrompt: "T",
          steps: { build: { agent: "claude", model: "opus" } },
          reviewers: [{ agent: "codex", model: "gpt-5" }],
        },
        { storage, buildPipelines: supervisor.service },
      );
      const started = supervisor.started[0]!;
      expect(started.agentType).toBe("claude");
      expect(started.steps?.build).toEqual({ agent: "claude", model: "opus" });
      // The review step is always the first reviewer.
      expect(started.steps?.review).toEqual({ agent: "codex", model: "gpt-5" });
      expect(started.steps?.pr?.agent).toBeDefined();
    });
  });

  test("rejects a request without a project", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      await expect(
        launchBuildPipeline({ taskId: "task-1" }, { storage, buildPipelines: supervisor.service }),
      ).rejects.toThrow("Invalid build pipeline start request");
      expect(supervisor.started).toEqual([]);
    });
  });
});
