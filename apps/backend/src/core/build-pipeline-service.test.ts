import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { StorageService } from "./storage.js";
import {
  BuildPipelineService,
} from "./build-pipeline-service.js";
import type {
  BuildPipelineProvider,
  ProviderStatus,
} from "./build-pipeline-provider.js";

const cleanReview: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "base",
    commit: { sha: "head", subject: "feat: build" },
    filesReviewed: ["src/app.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [{ command: "bun test", result: "passed", summary: "Passed" }],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Implemented the task.",
    before: "Missing.",
    after: "Present.",
    keyCodeChanges: [{
      file: "src/app.ts",
      line: 1,
      description: "Adds the feature.",
    }],
    userImpact: "The feature is available.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "low",
    reasoning: "Small change.",
  },
  testResults: {
    total: 1,
    passed: 1,
    failed: 0,
    notRun: 0,
    failures: [],
  },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready." },
  summaryOfChange: "Implemented the task.",
  reviewSummary: "No findings.",
};

class FakeProvider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly phases = new Map<string, PipelineSessionPhase>();
  readonly sent: Array<{ sessionId: string; requestId: string }> = [];
  private counter = 0;

  async createSession(phase: PipelineSessionPhase): Promise<string> {
    const id = `${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async send(
    sessionId: string,
    _prompt: string,
    options: { requestId: string; schema?: JsonSchema },
  ): Promise<void> {
    this.sent.push({ sessionId, requestId: options.requestId });
  }

  async status(_sessionId: string): Promise<ProviderStatus> {
    return "idle";
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return [{
      id: `${sessionId}-assistant`,
      role: "assistant",
      parts: [{ type: "text", content: "Finished" }],
    }];
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> {
    const phase = this.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "review"
        ? cleanReview
        : { complete: true, rationale: "All criteria pass." }) as T,
    };
  }

  async abort(_sessionId: string): Promise<void> {}
}

async function withService(
  run: (
    service: BuildPipelineService,
    storage: StorageService,
    provider: FakeProvider,
    invocations: Array<{ command: string; args: Record<string, unknown> }>,
  ) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-runner-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/build",
    setupScriptsComplete: true,
  });
  const provider = new FakeProvider();
  const invocations: Array<{
    command: string;
    args: Record<string, unknown>;
  }> = [];
  const invoke = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    invocations.push({ command, args });
    if (command === "detect_pr_local") return null as T;
    if (command === "start_environment" || command === "run_environment_setup") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "update_environment_agent_settings") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "update_kanban_task") return undefined as T;
    if (command === "update_feature_plan") return undefined as T;
    throw new Error(`Unexpected command: ${command}`);
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async () => provider,
  });
  try {
    await run(service, storage, provider, invocations);
  } finally {
    service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function pipeline(
  storage: StorageService,
  id: string,
): Promise<BuildPipeline> {
  const stored = await storage.getBuildPipeline(id);
  if (!stored) throw new Error("Pipeline disappeared");
  return stored.snapshot as BuildPipeline;
}

describe("BuildPipelineService", () => {
  test("owns and advances the complete pipeline without a renderer", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start({
        taskId: "task-1",
        projectId: "project-1",
        environmentType: "local",
        agentType: "claude",
        taskTitle: "Backend pipeline",
        taskSnapshot: {
          title: "Backend pipeline",
          description: "Move the runner",
          acceptanceCriteria: "No renderer orchestration",
          comments: [],
          images: [],
        },
        source: { type: "kanban", taskId: "task-1" },
        existingEnvironmentId: "env-1",
      });

      expect(started).toMatchObject({
        controller: "backend",
        phase: "starting-environment",
        environmentId: "env-1",
      });

      for (let pass = 0; pass < 7; pass += 1) {
        await service.advanceNow(started.id);
      }

      const completed = await pipeline(storage, started.id);
      expect(completed.phase).toBe("complete");
      expect(completed.sessions.map((session) => session.phase)).toEqual([
        "build",
        "review",
        "verify",
        "pr",
      ]);
      expect(completed.sessions.every((session) =>
        Array.isArray(session.messages))).toBe(true);
      expect(provider.sent).toHaveLength(4);
      expect(completed.verificationResult).toBe("pass");
    });
  });

  test("pause and cancel are backend mutations and abort running work", async () => {
    await withService(async (service, storage, provider) => {
      let aborted = "";
      provider.abort = async (sessionId) => {
        aborted = sessionId;
      };
      const started = await service.start({
        taskId: "task-2",
        projectId: "project-1",
        environmentType: "local",
        agentType: "claude",
        taskTitle: "Control pipeline",
        taskSnapshot: {
          title: "Control pipeline",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        existingEnvironmentId: "env-1",
      });
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      expect(running.phase).toBe("building");

      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      expect(aborted).toBe(running.sessions[0]?.sdkSessionId ?? "");

      const resumed = await service.resume(started.id);
      expect(resumed.phase).toBe("building");
      const cancelled = await service.cancel(started.id);
      expect(cancelled).toMatchObject({
        phase: "failed",
        error: "Build cancelled",
        controller: "backend",
      });
    });
  });

  test("publishes running transcripts from the backend before a stage completes", async () => {
    await withService(async (service, storage, provider) => {
      provider.status = async () => "running";
      provider.messages = async (sessionId) => [{
        id: `${sessionId}-assistant`,
        role: "assistant",
        parts: [{ type: "text", content: "Implementing the backend runner" }],
      }];
      const started = await service.start({
        taskId: "task-live",
        projectId: "project-1",
        environmentType: "local",
        agentType: "claude",
        taskTitle: "Live transcript",
        taskSnapshot: {
          title: "Live transcript",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        existingEnvironmentId: "env-1",
      });

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const running = await pipeline(storage, started.id);
      expect(running.phase).toBe("building");
      expect(running.sessions[0]).toMatchObject({
        status: "running",
        messageRevision: 1,
        messages: [expect.objectContaining({ role: "assistant" })],
      });
    });
  });

  test("durably links Kanban and feature-plan ownership before advancing", async () => {
    await withService(async (service, storage, _provider, invocations) => {
      const started = await service.start({
        taskId: "task-3",
        projectId: "project-1",
        environmentType: "local",
        agentType: "codex",
        taskTitle: "Feature pipeline",
        taskSnapshot: {
          title: "Feature pipeline",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        source: { type: "kanban", taskId: "task-3" },
        featurePlanId: "feature-1",
        existingEnvironmentId: "env-1",
      });

      expect(started.sourceLinkedAt).toBeString();
      expect(invocations).toContainEqual({
        command: "update_kanban_task",
        args: {
          taskId: "task-3",
          environmentId: "env-1",
          buildPipelineId: started.id,
        },
      });
      expect(invocations).toContainEqual({
        command: "update_feature_plan",
        args: {
          featureId: "feature-1",
          updates: {
            status: "building",
            buildTaskId: "task-3",
            buildPipelineId: started.id,
            codexEnvironmentId: "env-1",
          },
        },
      });
      expect((await pipeline(storage, started.id)).sourceLinkedAt).toBeString();
    });
  });

  test("recovers an environment created before the pipeline association was saved", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-recovery-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "recovered-env",
      projectId: "project-1",
      buildPipelineId: "recovering-pipeline",
      name: "recovered",
      branch: "recovered",
      containerId: null,
      status: "stopped",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/recovered",
    });
    const recovering: BuildPipeline = {
      id: "recovering-pipeline",
      taskId: "task-3",
      projectId: "project-1",
      environmentId: "",
      environmentType: "local",
      agentType: "claude",
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: new Date(0).toISOString(),
      taskTitle: "Recover pipeline",
      taskSnapshot: {
        title: "Recover pipeline",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      backendRevision: 0,
      controller: "backend",
    };
    await storage.saveBuildPipeline(
      recovering.id,
      recovering.projectId,
      "",
      2,
      recovering,
      0,
    );
    let createCalls = 0;
    const service = new BuildPipelineService(
      storage,
      async <T>(command: string): Promise<T> => {
        if (command === "create_environment") createCalls += 1;
        throw new Error(`Unexpected command: ${command}`);
      },
      {
        autoAdvance: false,
        provider: async () => new FakeProvider(),
      },
    );
    try {
      await service.advanceNow(recovering.id);
      expect(createCalls).toBe(0);
      expect(await pipeline(storage, recovering.id)).toMatchObject({
        environmentId: "recovered-env",
        environmentType: "local",
        phase: "starting-environment",
      });
    } finally {
      service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
