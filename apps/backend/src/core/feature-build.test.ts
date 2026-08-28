import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { createFeatureBuild } from "./feature-build.js";
import type { Project } from "./models.js";

interface StartedPipeline {
  id: string;
  environmentId: string;
}

/**
 * Records what the command asked the supervisor for.
 *
 * The supervisor's own behaviour is covered by the pipeline tests; what matters
 * here is that one request produces exactly one ticket and one pipeline, and
 * that the ticket's contents reach the pipeline that implements it.
 */
function fakeSupervisor() {
  const started: StartBuildPipelineInput[] = [];
  let counter = 0;
  return {
    started,
    service: {
      async start(input: StartBuildPipelineInput): Promise<StartedPipeline> {
        started.push(input);
        return { id: `pipeline-${++counter}`, environmentId: "" };
      },
    } as never,
  };
}

async function withStorage(
  run: (storage: StorageService) => Promise<void>,
  project?: Partial<Project>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-feature-build-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "project-1",
    name: "acme",
    gitUrl: "https://example.invalid/acme.git",
    localPath: "/tmp/acme",
    addedAt: new Date(0).toISOString(),
    order: 0,
    ...project,
  } as Project);
  try {
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const input = {
  projectId: "project-1",
  title: "  Dark mode toggle  ",
  description: "  Adds a toggle to the header.  ",
  acceptanceCriteria: "  The preference survives a reload.  ",
  environmentType: "containerized" as const,
  agentType: "claude" as const,
};

describe("createFeatureBuild", () => {
  test("creates one in-progress ticket and starts the build that implements it", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      const result = await createFeatureBuild(input, {
        storage,
        buildPipelines: supervisor.service,
      });

      const tasks = await storage.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task.title).toBe("Dark mode toggle");
      expect(task.description).toBe("Adds a toggle to the header.");
      expect(task.acceptanceCriteria).toBe("The preference survives a reload.");
      // The build starts immediately, so the column reflects what is happening.
      expect(task.status).toBe("in-progress");

      expect(result.taskId).toBe(task.id);
      expect(supervisor.started).toHaveLength(1);
      const started = supervisor.started[0]!;
      expect(started.taskId).toBe(task.id);
      // Linking the source is what lets the pipeline move this ticket and
      // attach its environment to it.
      expect(started.source).toEqual({ type: "kanban", taskId: task.id });
      expect(started.taskSnapshot.acceptanceCriteria).toBe("The preference survives a reload.");
      expect(started.namingPrompt).toContain("Dark mode toggle");
    });
  });

  test("runs verification on the model that addressed the review", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      await createFeatureBuild(
        {
          ...input,
          steps: {
            build: { agent: "claude", model: "opus" },
            address: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
          },
        },
        { storage, buildPipelines: supervisor.service },
      );
      const started = supervisor.started[0]!;
      expect(started.steps?.verify).toEqual({
        agent: "codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
      });
      // The pipeline's own agent is the build step's harness.
      expect(started.agentType).toBe("claude");
    });
  });

  test("keeps an explicit verify selection", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      await createFeatureBuild(
        {
          ...input,
          steps: {
            address: { agent: "codex", model: "gpt-5.6" },
            verify: { agent: "claude", model: "opus" },
          },
        },
        { storage, buildPipelines: supervisor.service },
      );
      expect(supervisor.started[0]!.steps?.verify).toEqual({ agent: "claude", model: "opus" });
    });
  });

  test("forwards the reviewer panel and the environment shaping", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      await createFeatureBuild(
        {
          ...input,
          reviewers: [
            { agent: "claude", model: "opus" },
            { agent: "codex", model: "gpt-5.6" },
          ],
          environmentOptions: {
            name: "feature-dark-mode",
            networkAccessMode: "restricted",
            portMappings: [{ containerPort: 5173, hostPort: 5173, protocol: "tcp" }],
          },
        },
        { storage, buildPipelines: supervisor.service },
      );
      const started = supervisor.started[0]!;
      expect(started.reviewers).toHaveLength(2);
      expect(started.environmentOptions?.name).toBe("feature-dark-mode");
      expect(started.environmentOptions?.networkAccessMode).toBe("restricted");
    });
  });

  test("a retry under the same request id reuses the ticket rather than adding one", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      const first = await createFeatureBuild(
        { ...input, requestId: "request-1" },
        { storage, buildPipelines: supervisor.service },
      );
      // The pipeline has moved the ticket on by the time the caller retries,
      // which is exactly the case a plain create-if-absent would fail on.
      await storage.updateKanbanTask(first.taskId, { status: "review" });

      const second = await createFeatureBuild(
        { ...input, requestId: "request-1" },
        { storage, buildPipelines: supervisor.service },
      );

      expect(second.taskId).toBe(first.taskId);
      expect(await storage.getKanbanTasks("project-1")).toHaveLength(1);
    });
  });

  test("rejects reuse of a request id with different immutable launch arguments", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      await createFeatureBuild(
        { ...input, requestId: "request-conflict" },
        { storage, buildPipelines: supervisor.service },
      );

      await expect(
        createFeatureBuild(
          {
            ...input,
            requestId: "request-conflict",
            title: "A different feature",
            acceptanceCriteria: "Different acceptance criteria",
            environmentOptions: { name: "different-environment", networkAccessMode: "full" },
            steps: { address: { agent: "codex", model: "gpt-5.6" } },
            reviewers: [
              { agent: "claude", model: "opus" },
              { agent: "codex", model: "gpt-5.6" },
            ],
          },
          { storage, buildPipelines: supervisor.service },
        ),
      ).rejects.toThrow("requestId was already used with different arguments");
      expect(await storage.getKanbanTasks("project-1")).toHaveLength(1);
      expect(supervisor.started).toHaveLength(1);
    });
  });

  test("refuses a local build for a project with no host checkout", async () => {
    await withStorage(
      async (storage) => {
        const supervisor = fakeSupervisor();
        await expect(
          createFeatureBuild(
            { ...input, environmentType: "local" },
            { storage, buildPipelines: supervisor.service },
          ),
        ).rejects.toThrow("no local path");
        // Nothing was created, so there is no orphan ticket to clean up.
        expect(await storage.getKanbanTasks("project-1")).toHaveLength(0);
      },
      { localPath: undefined },
    );
  });

  test("rejects a malformed request before touching the board", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
      await expect(
        createFeatureBuild(
          { ...input, title: "   " },
          { storage, buildPipelines: supervisor.service },
        ),
      ).rejects.toThrow("Invalid feature build request");
      expect(await storage.getKanbanTasks("project-1")).toHaveLength(0);
    });
  });

  test("reports an unavailable supervisor rather than leaving a ticket behind", async () => {
    await withStorage(async (storage) => {
      await expect(createFeatureBuild(input, { storage })).rejects.toThrow(
        "Build pipeline supervisor is unavailable",
      );
      expect(await storage.getKanbanTasks("project-1")).toHaveLength(0);
    });
  });
});
