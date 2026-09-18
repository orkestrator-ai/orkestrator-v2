import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import {
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  reviewValidationDiscoveryPrompt,
  REVIEW_VALIDATION_PLAN_SCHEMA,
} from "./review-validation-prompts.js";
import type { BuildPipelineProvider, ProviderSendOptions } from "./build-pipeline-provider.js";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "validation-controllers-"));
  const storage = new StorageService(directory);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "fixture",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date().toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/fixture",
    setupScriptsComplete: true,
  });
  const sends: Array<{ prompt: string; options: ProviderSendOptions }> = [];
  let sequence = 0;
  const provider: BuildPipelineProvider = {
    agent: "claude",
    createSession: async () => `session-${++sequence}`,
    send: async (_id, prompt, options) => {
      sends.push({ prompt, options });
    },
    status: async () => "idle",
    messages: async () => [],
    abort: async () => {},
    structured: async <T>(_id: string, requestId: string) => ({
      ok: true,
      provider: "claude",
      requestId,
      value: {
        headRef: "1".repeat(40),
        commands: [
          {
            id: "check",
            command: "project-check",
            cwd: ".",
            dependsOn: [],
            resources: [],
            weight: 1,
            timeoutMs: 5000,
          },
        ],
        limitations: [],
      } as T,
    }),
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let finish = false;
  const invoke = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ name, args });
    if (name === "get_environment_uncommitted_paths")
      return { head: "1".repeat(40), paths: [], fingerprint: "a".repeat(64) } as T;
    if (name.endsWith("_review_validation")) {
      const run = structuredClone(args.run) as ReviewValidationRun;
      if (name === "cancel_review_validation") run.status = "cancelled";
      else {
        run.status = finish ? "completed" : "running";
        if (finish)
          run.results = run.results.map((r) => ({
            ...r,
            status: "passed",
            exitCode: 0,
            stdoutPath: `.orkestrator/review-artifacts/${run.id}/validation-01.stdout.txt`,
            stderrPath: `.orkestrator/review-artifacts/${run.id}/validation-01.stderr.txt`,
            stdoutSha256: "a".repeat(64),
            stderrSha256: "b".repeat(64),
            durationMs: 500,
          }));
      }
      return run as T;
    }
    if (name === "generate_looped_review_package") return testGeneratedReviewPackage(args) as T;
    if (name === "verify_looped_review_package") return { valid: true } as T;
    if (name === "get_kanban_tasks") return [] as T;
    return {} as T;
  };
  return {
    storage,
    provider,
    sends,
    calls,
    invoke,
    finish: () => {
      finish = true;
    },
    keepRunning: () => {
      finish = false;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("discovery avoids a duplicate build when the full test stage already builds", () => {
  const prompt = reviewValidationDiscoveryPrompt("main");
  expect(prompt).toContain("if the full test stage already runs the production build");
  expect(prompt).toContain("omit a separate build command instead of repeating it");
  expect(prompt.startsWith(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION)).toBe(true);
  expect(prompt).toContain(SYSTEM_INSTRUCTIONS_FRAME_OPEN);
});

test("manual discovery hands off once; a replacement controller seals completed background evidence", async () => {
  const h = await harness();
  let service = new MultiReviewService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ agent: "claude", model: "reviewer" }],
      fixModel: { agent: "claude", model: "preparer" },
    });
    const read = async () =>
      (await h.storage.getMultiReviewWorkflow(started.id))!.snapshot as MultiReviewWorkflow;
    for (let i = 0; i < 5 && (await read()).validationRun?.status !== "running"; i++)
      await service.advanceNow(started.id);
    expect((await read()).validationRun?.status).toBe("running");
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.options.schema).toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(h.calls.some((call) => call.name === "generate_looped_review_package")).toBe(false);
    await service.shutdown();
    h.finish();
    service = new MultiReviewService(h.storage, h.invoke, {
      autoAdvance: false,
      provider: async () => {
        throw new Error("Discovery provider must not be needed for validation recovery");
      },
    });
    await service.advanceNow(started.id);
    const restored = await read();
    expect(restored.phase).toBe("reviewing");
    expect(restored.reviewPackage?.id).toBe(restored.validationRun?.id);
    expect(h.calls.filter((call) => call.name === "start_review_validation")).toHaveLength(1);
    const generated = h.calls.find((call) => call.name === "generate_looped_review_package")!;
    expect(generated.args.expectedHead).toBe("1".repeat(40));
    expect(h.sends).toHaveLength(1);
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("pipeline separates implementation from fresh discovery and waits for backend validation", async () => {
  const h = await harness();
  const service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      taskId: "task-1",
      projectId: "project-1",
      existingEnvironmentId: "env-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "fixture",
      taskSnapshot: {
        title: "fixture",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      reviewers: [
        { agent: "claude", model: "a" },
        { agent: "claude", model: "b" },
      ],
    });
    const read = async () =>
      (await h.storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
    for (let i = 0; i < 8 && (await read()).validationRun?.status !== "running"; i++)
      await service.advanceNow(started.id);
    expect((await read()).validationRun?.status).toBe("running");
    expect(h.sends).toHaveLength(2);
    expect(h.sends[0]!.prompt).toContain("do not run a separate full");
    expect(h.sends[0]!.options.schema).toBeUndefined();
    expect(h.sends[1]!.options.schema).toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    h.finish();
    await service.advanceNow(started.id);
    expect((await read()).reviewPackage?.id).toBe((await read()).validationRun?.id);
    expect(h.calls.filter((call) => call.name === "generate_looped_review_package")).toHaveLength(
      1,
    );

    // Restore a verification turn after review/addressing. A failing verdict
    // must not carry the prior run into the next implementation iteration.
    const record = (await h.storage.getBuildPipeline(started.id))!;
    const verifying = record.snapshot as BuildPipeline;
    delete verifying.reviewFanout;
    verifying.phase = "verifying";
    verifying.sessions.push({
      phase: "verify",
      agent: "claude",
      iteration: verifying.iteration,
      sessionKey: "verification-fixture",
      sdkSessionId: "verification-fixture",
      status: "idle",
      startedAt: new Date().toISOString(),
      label: "Verification Session",
      structuredRequestId: "verification-result",
      validationHeadAtStart: "1".repeat(40),
      validationWorktreeStatusAtStart: "clean",
    });
    verifying.currentSessionIndex = verifying.sessions.length - 1;
    await h.storage.saveBuildPipeline(
      verifying.id,
      verifying.projectId,
      verifying.environmentId,
      record.version,
      verifying,
      record.revision,
    );
    h.provider.structured = async <T>(_id: string, requestId: string) => ({
      ok: true,
      provider: "claude",
      requestId,
      value: { complete: false, rationale: "Another change is needed" } as T,
    });
    await service.advanceNow(started.id);
    expect((await read()).phase).toBe("fixing");
    expect((await read()).validationRun).toBeUndefined();
    expect((await read()).reviewPackage).toBeUndefined();
    await service.advanceNow(started.id);
    expect(h.sends.at(-1)!.options.schema).toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(h.calls.filter((call) => call.name === "generate_looped_review_package")).toHaveLength(
      1,
    );
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("pipeline validation restart discards stale evidence and keeps polling the new run", async () => {
  const h = await harness();
  const service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      taskId: "task-validation-restart",
      projectId: "project-1",
      existingEnvironmentId: "env-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "validation restart",
      taskSnapshot: {
        title: "validation restart",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
    });
    const read = async () =>
      (await h.storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
    for (let pass = 0; pass < 8 && (await read()).validationRun?.status !== "running"; pass += 1) {
      await service.advanceNow(started.id);
    }
    h.finish();
    await service.advanceNow(started.id);
    const sealed = await read();
    const originalRunId = sealed.validationRun!.id;
    expect(sealed.reviewPackage?.id).toBe(originalRunId);

    h.keepRunning();
    const sendsBeforeRestart = h.sends.length;
    const restarted = await service.restartStep(started.id, `validation:${originalRunId}`);
    const restartedRunId = restarted.validationRun!.id;
    expect(restartedRunId).not.toBe(originalRunId);
    expect(restarted.validationRun?.status).toBe("running");
    expect(restarted.reviewPackage).toBeUndefined();

    await service.advanceNow(started.id);
    await service.advanceNow(started.id);
    const stillRunning = await read();
    expect(stillRunning.validationRun).toMatchObject({ id: restartedRunId, status: "running" });
    expect(stillRunning.reviewPackage).toBeUndefined();
    expect(h.sends).toHaveLength(sendsBeforeRestart);
    expect(
      h.calls.filter(
        (call) =>
          call.name === "status_review_validation" &&
          (call.args.run as ReviewValidationRun).id === restartedRunId,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("replacement pipeline controller consumes a durable restart request", async () => {
  const h = await harness();
  let service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      taskId: "task-durable-restart",
      projectId: "project-1",
      existingEnvironmentId: "env-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "durable restart",
      taskSnapshot: {
        title: "durable restart",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
    });
    await service.shutdown();
    const record = (await h.storage.getBuildPipeline(started.id))!;
    const snapshot = record.snapshot as BuildPipeline;
    snapshot.phase = "verifying";
    snapshot.restartRequest = { kind: "session", phase: "verify" };
    await h.storage.saveBuildPipeline(
      snapshot.id,
      snapshot.projectId,
      snapshot.environmentId,
      record.version,
      snapshot,
      record.revision,
    );

    service = new BuildPipelineService(h.storage, h.invoke, {
      autoAdvance: false,
      provider: async () => h.provider,
    });
    await service.advanceNow(started.id);
    const restored = (await h.storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
    expect(restored.restartRequest).toBeUndefined();
    expect(restored.sessions.at(-1)).toMatchObject({ phase: "verify", status: "running" });
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("pipeline fails a corrupt validation restart without a retained plan", async () => {
  const h = await harness();
  let service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      taskId: "task-missing-validation-plan",
      projectId: "project-1",
      existingEnvironmentId: "env-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "missing validation plan",
      taskSnapshot: {
        title: "missing validation plan",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
    });
    await service.shutdown();
    const record = (await h.storage.getBuildPipeline(started.id))!;
    const snapshot = record.snapshot as BuildPipeline;
    snapshot.phase = "building";
    snapshot.restartRequest = { kind: "validation", implementationPhase: "build" };
    delete snapshot.validationRun;
    await h.storage.saveBuildPipeline(
      snapshot.id,
      snapshot.projectId,
      snapshot.environmentId,
      record.version,
      snapshot,
      record.revision,
    );

    service = new BuildPipelineService(h.storage, h.invoke, {
      autoAdvance: false,
      provider: async () => h.provider,
    });
    await service.advanceNow(started.id);
    const failed = (await h.storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
    expect(failed).toMatchObject({
      phase: "failed",
      error: "Validation restart plan is missing",
    });
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});
