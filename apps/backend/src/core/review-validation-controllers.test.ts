import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";
import { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";
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
import { rewritePipeline } from "./build-pipeline-review-fanout-test-support.js";

async function harness(validationCommand = "project-check") {
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
            command: validationCommand,
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
  let head = "1".repeat(40);
  let fingerprint = "a".repeat(64);
  let finish = false;
  const invoke = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ name, args });
    if (name === "get_environment_uncommitted_paths") return { head, paths: [], fingerprint } as T;
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
    if (name === "generate_review_package") return testGeneratedReviewPackage(args) as T;
    if (name === "verify_review_package") return { valid: true } as T;
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
    changeWorktree: () => {
      head = "2".repeat(40);
      fingerprint = "b".repeat(64);
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("discovery avoids a duplicate build when the full test stage already builds", () => {
  const prompt = reviewValidationDiscoveryPrompt("main");
  expect(prompt).toContain("if the full test stage already runs the production build");
  expect(prompt).toContain("omit a separate build command instead of repeating it");
  expect(prompt.startsWith(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION)).toBe(true);
  expect(prompt).toContain("First read the repository's agent instructions — AGENTS.md");
  expect(prompt).toContain("include it only when this change meets that condition");
  expect(prompt).toContain(SYSTEM_INSTRUCTIONS_FRAME_OPEN);
});

test("protocol changes hand off focused implementation checks to one required full-suite run", async () => {
  // The provider fixture returns the repository-required plan. This verifies the
  // discovery contract and controller handoff, not a live model's plan selection.
  const h = await harness("mise run test");
  const service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  try {
    const started = await service.start({
      taskId: "protocol-change",
      projectId: "project-1",
      existingEnvironmentId: "env-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "Update shared protocol",
      taskSnapshot: {
        title: "Update shared protocol",
        description: "Change packages/protocol/src/review-evidence-frames.ts.",
        acceptanceCriteria:
          "Follow AGENTS.md validation requirements for packages/protocol changes.",
        comments: [],
        images: [],
      },
      reviewers: [
        { agent: "claude", model: "reviewer-a" },
        { agent: "claude", model: "reviewer-b" },
      ],
    });
    const read = async () =>
      (await h.storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
    for (let i = 0; i < 8 && (await read()).validationRun?.status !== "running"; i++)
      await service.advanceNow(started.id);
    expect((await read()).validationRun?.status).toBe("running");
    expect(h.sends).toHaveLength(2);
    const [implementation, discovery] = h.sends;
    expect(implementation!.prompt).toContain("packages/protocol/src/review-evidence-frames.ts");
    expect(implementation!.prompt).toContain("Run focused checks needed during implementation");
    expect(implementation!.prompt).toContain(
      "do not run a separate full test/typecheck/build pass",
    );
    expect(discovery!.options.schema).toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(discovery!.prompt).toContain(
      "You are review preparation, not a pre-review implementation worker",
    );
    expect(discovery!.prompt).toContain(
      "Exemptions that let implementation workers defer full validation until review do not apply to this discovery task",
    );
    expect(discovery!.prompt).toContain(
      "Discover and schedule every applicable repository-required validation command, including required full suites, once against the committed branch",
    );
    h.finish();
    await service.advanceNow(started.id);
    const starts = h.calls.filter((call) => call.name === "start_review_validation");
    expect(starts).toHaveLength(1);
    expect(
      (starts[0]!.args.run as ReviewValidationRun).plan.commands.map((c) => c.command),
    ).toEqual(["mise run test"]);
    expect((await read()).reviewPackage?.id).toBe((await read()).validationRun?.id);
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
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
    expect(h.calls.some((call) => call.name === "generate_review_package")).toBe(false);
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
    const generated = h.calls.find((call) => call.name === "generate_review_package")!;
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
    expect(h.calls.filter((call) => call.name === "generate_review_package")).toHaveLength(1);

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
    // A failed verification starts an implementation turn first. Only after
    // that turn changes the worktree may fresh discovery certify another run.
    expect(h.sends.at(-1)!.options.schema).toBeUndefined();
    expect((await read()).sessions.at(-1)?.phase).toBe("fix");
    h.changeWorktree();
    await service.advanceNow(started.id);
    expect(h.sends.at(-1)!.options.schema).toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(h.calls.filter((call) => call.name === "generate_review_package")).toHaveLength(1);
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test.each(["named", "current"] as const)(
  "pipeline %s validation restart is idempotent while pending, running and reloaded",
  async (restartMode) => {
    const h = await harness();
    let service = new BuildPipelineService(h.storage, h.invoke, {
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
      for (
        let pass = 0;
        pass < 8 && (await read()).validationRun?.status !== "running";
        pass += 1
      ) {
        await service.advanceNow(started.id);
      }
      if (restartMode === "named") {
        h.finish();
        await service.advanceNow(started.id);
      }
      const sealed = await read();
      const originalRunId = sealed.validationRun!.id;
      if (restartMode === "named") expect(sealed.reviewPackage?.id).toBe(originalRunId);

      h.keepRunning();
      const sendsBeforeRestart = h.sends.length;
      const dispatch = spyOn(BuildPipelineSupervisor.prototype, "runLocked").mockResolvedValueOnce(
        undefined,
      );
      let restarted: BuildPipeline;
      try {
        restarted =
          restartMode === "named"
            ? await service.restartStep(started.id, `validation:${originalRunId}`)
            : await service.restartCurrentStep(started.id);
        expect(restarted.validationRun?.status).toBe("planned");
        expect(
          (await service.restartStep(started.id, `validation:${originalRunId}`)).validationRun?.id,
        ).toBe(restarted.validationRun!.id);
        expect((await service.restartCurrentStep(started.id)).rewinds).toHaveLength(1);
      } finally {
        dispatch.mockRestore();
      }
      await service.advanceNow(started.id);
      restarted = await read();
      const restartedRunId = restarted.validationRun!.id;
      expect(restartedRunId).not.toBe(originalRunId);
      expect(restarted.validationRun?.status).toBe("running");
      expect(restarted.reviewPackage).toBeUndefined();

      // Retrying either control must keep the replacement generation running.
      for (let repeat = 0; repeat < 2; repeat++) {
        const named = await service.restartStep(started.id, `validation:${originalRunId}`);
        const current = await service.restartCurrentStep(started.id);
        expect(named.validationRun?.id).toBe(restartedRunId);
        expect(current.validationRun?.id).toBe(restartedRunId);
        expect(current.rewinds).toHaveLength(1);
      }
      await service.shutdown();
      service = new BuildPipelineService(h.storage, h.invoke, {
        autoAdvance: false,
        provider: async () => h.provider,
      });
      expect(
        (await service.restartStep(started.id, `validation:${originalRunId}`)).validationRun?.id,
      ).toBe(restartedRunId);
      expect((await service.restartCurrentStep(started.id)).validationRun?.id).toBe(restartedRunId);
      expect(h.calls.filter((call) => call.name === "start_review_validation")).toHaveLength(2);
      expect(h.calls.filter((call) => call.name === "cancel_review_validation")).toHaveLength(
        restartMode === "current" ? 1 : 0,
      );

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
      // A later, unrelated validation generation must still be restartable.
      const unrelated = structuredClone(stillRunning);
      unrelated.validationRun!.id = "unrelated-validation";
      await h.storage.saveBuildPipeline(
        unrelated.id,
        unrelated.projectId,
        unrelated.environmentId,
        1,
        unrelated,
        unrelated.backendRevision,
      );
      const next = await service.restartCurrentStep(started.id);
      expect(next.validationRun?.id).not.toBe("unrelated-validation");
      expect(next.validationRun?.id).not.toBe(restartedRunId);
      expect(next.rewinds).toHaveLength(2);
      await expect(service.restartStep(started.id, `validation:${originalRunId}`)).rejects.toThrow(
        "no longer available",
      );
    } finally {
      await service.shutdown();
      await h.cleanup();
    }
  },
);

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

/** A single-review pipeline advanced until its validation run is running. */
async function pipelineWithRunningValidation(
  h: Awaited<ReturnType<typeof harness>>,
  taskId: string,
) {
  const service = new BuildPipelineService(h.storage, h.invoke, {
    autoAdvance: false,
    provider: async () => h.provider,
  });
  const started = await service.start({
    taskId,
    projectId: "project-1",
    existingEnvironmentId: "env-1",
    environmentType: "local",
    agentType: "claude",
    taskTitle: taskId,
    taskSnapshot: {
      title: taskId,
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
  expect((await read()).validationRun?.status).toBe("running");
  return { service, pipelineId: started.id, read };
}

test("skipping validation stops the checks and seals their partial results for the review", async () => {
  const h = await harness();
  const { service, pipelineId, read } = await pipelineWithRunningValidation(
    h,
    "task-skip-validation",
  );
  try {
    const runId = (await read()).validationRun!.id;
    await expect(service.skipStep(pipelineId, "validation:stale-run")).rejects.toThrow(
      "This step has already finished",
    );

    const sendsBeforeSkip = h.sends.length;
    const skipped = await service.skipStep(pipelineId, `validation:${runId}`);
    expect(h.calls.some((call) => call.name === "cancel_review_validation")).toBe(true);
    expect(skipped.phase).toBe("reviewing");
    expect(skipped.skippedValidationRunId).toBe(runId);
    expect(skipped.validationRun).toMatchObject({ id: runId, status: "cancelled" });
    expect(skipped.reviewPackage?.id).toBe(runId);
    const sealing = h.calls.filter((call) => call.name === "generate_review_package");
    expect(sealing).toHaveLength(1);
    const preparation = sealing[0]!.args.preparation as {
      validation: Array<{ status: string }>;
    };
    expect(preparation.validation.map((result) => result.status)).toEqual(["incomplete"]);
    // The review starts; validation is not prepared again.
    expect(h.sends).toHaveLength(sendsBeforeSkip + 1);
    expect(h.sends.at(-1)!.options.schema).not.toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(skipped.sessions.at(-1)).toMatchObject({ phase: "review", status: "running" });
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("skipping a paused validation seals the cancelled run instead of preparing again", async () => {
  const h = await harness();
  const { service, pipelineId, read } = await pipelineWithRunningValidation(h, "task-skip-paused");
  try {
    const runId = (await read()).validationRun!.id;
    const paused = await service.pause(pipelineId);
    expect(paused.phase).toBe("paused");
    expect(paused.validationRun?.status).toBe("cancelled");

    const skipped = await service.skipStep(pipelineId, `validation:${runId}`);
    expect(skipped.phase).toBe("reviewing");
    expect(skipped.pausedFromPhase).toBeUndefined();
    expect(skipped.reviewPackage?.id).toBe(runId);
    expect(skipped.sessions.some((session) => session.label === "Review Package Session")).toBe(
      false,
    );
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});

test("a replacement controller recovers a persisted skipped validation run", async () => {
  const h = await harness();
  const { service, pipelineId, read } = await pipelineWithRunningValidation(h, "task-skip-recover");
  let restored: BuildPipelineService | undefined;
  try {
    const runId = (await read()).validationRun!.id;
    await service.pause(pipelineId);
    await service.shutdown();
    // Durable state after admitting the skip, before the supervisor seals it.
    await rewritePipeline(h.storage, pipelineId, (pipeline) => {
      pipeline.phase = pipeline.pausedFromPhase!;
      delete pipeline.pausedFromPhase;
      delete pipeline.pauseCause;
      pipeline.skippedValidationRunId = runId;
    });
    const sendsBeforeRecovery = h.sends.length;
    restored = new BuildPipelineService(h.storage, h.invoke, {
      autoAdvance: false,
      provider: async () => h.provider,
    });
    await restored.init();
    await restored.advanceNow(pipelineId);
    const recovered = await read();
    expect(recovered.phase).toBe("reviewing");
    expect(recovered.reviewPackage?.id).toBe(runId);
    expect(recovered.skippedValidationRunId).toBe(runId);
    expect(recovered.validationRun?.status).toBe("cancelled");
    expect(h.sends).toHaveLength(sendsBeforeRecovery + 1);
    expect(h.sends.at(-1)!.options.schema).not.toBe(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(h.calls.filter((call) => call.name === "generate_review_package")).toHaveLength(1);
  } finally {
    await service.shutdown();
    await restored?.shutdown();
    await h.cleanup();
  }
});

test("skipping an agent stage stops its session and opens the next stage", async () => {
  const h = await harness();
  const { service, pipelineId, read } = await pipelineWithRunningValidation(h, "task-skip-review");
  const aborted: string[] = [];
  h.provider.abort = async (sessionId) => {
    aborted.push(sessionId);
  };
  try {
    h.finish();
    await service.advanceNow(pipelineId);
    const reviewing = await read();
    expect(reviewing.phase).toBe("reviewing");
    const review = reviewing.sessions.at(-1)!;
    expect(review).toMatchObject({ phase: "review", status: "running" });

    const verifying = await service.skipStep(pipelineId, review.sdkSessionId);
    expect(aborted).toEqual([review.sdkSessionId]);
    expect(verifying.phase).toBe("verifying");
    expect(verifying.structuredReview).toBeUndefined();
    expect(verifying.sessions.find((s) => s.sdkSessionId === review.sdkSessionId)).toMatchObject({
      skipped: true,
      status: "idle",
    });
    const verify = verifying.sessions.at(-1)!;
    expect(verify).toMatchObject({ phase: "verify", status: "running" });

    // A renderer still showing the review cannot skip the stage after it.
    await expect(service.skipStep(pipelineId, review.sdkSessionId)).rejects.toThrow(
      "This step has already finished",
    );

    const shipping = await service.skipStep(pipelineId, verify.sdkSessionId);
    expect(shipping.phase).toBe("creating-pr");
    expect(shipping.verificationResult).toBeUndefined();
    expect(shipping.sessions.at(-1)).toMatchObject({ phase: "pr", status: "running" });
    await expect(
      service.skipStep(pipelineId, shipping.sessions.at(-1)!.sdkSessionId),
    ).rejects.toThrow("The pull request step cannot be skipped");
  } finally {
    await service.shutdown();
    await h.cleanup();
  }
});
