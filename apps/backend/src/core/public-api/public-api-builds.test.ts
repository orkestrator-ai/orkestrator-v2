import { afterEach, describe, expect, test } from "bun:test";
import type { BuildPipeline, StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { BUILD_STEP_INSTRUCTIONS_FRAME_OPEN } from "@orkestrator/protocol/build-pipeline-stage-instructions";
import type {
  PublicBuildPipelineDetail,
  PublicBuildPipelineSummary,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import type { BuildPipelineService } from "../build-pipeline-service.js";
import { createBuildHarness, type BuildHarness } from "./build-test-support.js";
import { parseBuildLaunch } from "./actions-builds.js";
import { intentFingerprint, requestKey } from "./operation-ledger.js";
import { commitFile, headCommit } from "./test-support.js";

/**
 * `build.*`: the Build button on a Kanban ticket as public actions, over a
 * real `BuildPipelineService`, real storage and the real registry.
 */

const harnesses: BuildHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function setup(): Promise<BuildHarness> {
  const harness = await createBuildHarness();
  harnesses.push(harness);
  return harness;
}

async function restart(build: BuildHarness): Promise<BuildHarness> {
  harnesses.splice(harnesses.indexOf(build), 1);
  const restarted = await build.restart();
  harnesses.push(restarted);
  return restarted;
}

const TEXT = {
  build: "BUILD-RULES: write the failing test first.",
  verify: "VERIFY-RULES: run the CLI help.",
  reviewer: "REVIEWER-RULES: ignore generated files.",
  preparation: "PREPARATION-RULES: group findings by file.",
  lens: "Trace untrusted input to its sinks.",
};

function launchInput(build: BuildHarness): Record<string, unknown> {
  return {
    projectId: build.projectId,
    ticketId: build.ticketId,
    environmentId: "env-1",
    steps: {
      build: { instructions: TEXT.build },
      verify: {
        agent: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        instructions: TEXT.verify,
      },
    },
    reviewers: [
      {
        agent: "claude",
        model: "claude-opus-5",
        lens: { label: "Security", instruction: TEXT.lens },
        instructions: TEXT.reviewer,
      },
      { agent: "codex", model: "gpt-5.5" },
    ],
    reviewPreparation: { instructions: TEXT.preparation },
    maxIterations: 2,
  };
}

function expectContentFree(value: unknown): void {
  const json = JSON.stringify(value);
  for (const text of Object.values(TEXT)) expect(json).not.toContain(text);
  expect(json).not.toContain("Security");
}

async function stored(build: BuildHarness, id: string): Promise<BuildPipeline> {
  return (await build.harness.storage.getBuildPipeline(id))!.snapshot as BuildPipeline;
}

/** Whether a request key was ever admitted. */
async function admitted(build: BuildHarness, requestId: string): Promise<boolean> {
  const key = requestKey("operator", "build.launch", `project:${build.projectId}`, requestId);
  return Boolean(await build.harness.storage.publicOperations.findPublicOperationByKey(key));
}

describe("build.launch", () => {
  test("starts the ticket's build with per-step instructions and lenses, once per request key", async () => {
    const build = await setup();
    const input = launchInput(build);
    const launched = await build.harness.call<{ pipelineId: string; reused: boolean }>(
      "build.launch",
      input,
      { requestId: "build-1" },
    );
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    expect(launched.receipt).toMatchObject({ action: "build.launch", state: "succeeded" });
    expect(launched.result).toMatchObject({
      projectId: build.projectId,
      environmentId: "env-1",
      taskId: build.ticketId,
      reused: false,
    });
    expectContentFree(launched);

    const pipeline = await stored(build, launched.result.pipelineId);
    expect(pipeline.source).toEqual({ type: "kanban", taskId: build.ticketId });
    expect(pipeline.taskSnapshot.title).toBe("Add a --verbose flag");
    expect(pipeline.maxIterations).toBe(2);
    expect(pipeline.steps?.build).toMatchObject({ agent: "claude", instructions: TEXT.build });
    expect(pipeline.steps?.verify).toEqual({
      agent: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      instructions: TEXT.verify,
    });
    expect(pipeline.reviewers?.[0]).toEqual({
      agent: "claude",
      model: "claude-opus-5",
      lens: { label: "Security", instruction: TEXT.lens },
      instructions: TEXT.reviewer,
    });
    // Reviewer 1 is the review step, as in the launcher.
    expect(pipeline.steps?.review).toEqual(pipeline.reviewers?.[0]);
    // Naming only instructions keeps the saved preparation model.
    expect(pipeline.reviewPreparation).toMatchObject({
      agent: "claude",
      instructions: TEXT.preparation,
    });
    expect(pipeline.reviewPreparation?.model).toBeTruthy();

    const replay = await build.harness.call("build.launch", input, { requestId: "build-1" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.receipt?.operationId).toBe(launched.receipt!.operationId);
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(1);

    const conflict = await build.harness.call(
      "build.launch",
      { ...input, steps: { build: { instructions: "Something else." } } },
      { requestId: "build-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(1);
  });

  test("build.get and build.list report sizes, never the text, and survive a restart", async () => {
    let build = await setup();
    const launched = await build.harness.call<{ pipelineId: string }>(
      "build.launch",
      launchInput(build),
      { requestId: "build-restart" },
    );
    if (!launched.ok) throw new Error(launched.error.message);
    const id = launched.result.pipelineId;
    const expected = {
      id,
      taskId: build.ticketId,
      source: "kanban",
      maxIterations: 2,
      steps: {
        build: expect.objectContaining({ instructionsBytes: TEXT.build.length, lens: null }),
        verify: {
          agent: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          fastMode: null,
          instructionsBytes: TEXT.verify.length,
          lens: null,
        },
        review: expect.objectContaining({
          instructionsBytes: TEXT.reviewer.length,
          lens: { labelBytes: 8, instructionBytes: TEXT.lens.length },
        }),
      },
      reviewers: [
        expect.objectContaining({
          agent: "claude",
          model: "claude-opus-5",
          instructionsBytes: TEXT.reviewer.length,
          lens: { labelBytes: 8, instructionBytes: TEXT.lens.length },
        }),
        expect.objectContaining({ agent: "codex", instructionsBytes: 0, lens: null }),
      ],
      reviewPreparation: expect.objectContaining({
        instructionsBytes: TEXT.preparation.length,
      }),
    };
    const before = await build.harness.call<PublicBuildPipelineDetail>("build.get", {
      pipelineId: id,
    });
    expect(before.ok && before.result).toMatchObject(expected);
    expectContentFree(before);

    build = await restart(build);
    const after = await build.harness.call<PublicBuildPipelineDetail>("build.get", {
      pipelineId: id,
    });
    expect(after.ok && after.result).toMatchObject(expected);
    const listed = await build.harness.call<PublicPage<PublicBuildPipelineSummary>>("build.list", {
      projectId: build.projectId,
    });
    expect(listed.ok && listed.result).toMatchObject({
      total: 1,
      items: [{ id, phase: expect.any(String) }],
    });
    expectContentFree(listed);

    // The record kept the text, so the restarted service's prompts carry it.
    const pipeline = await stored(build, id);
    expect(pipeline.steps?.build?.instructions).toBe(TEXT.build);
    expect(pipeline.reviewers?.[0]?.lens?.instruction).toBe(TEXT.lens);
    for (let pass = 0; pass < 10 && build.provider.sent.length === 0; pass += 1) {
      await build.service.advanceNow(id);
    }
    const opening = build.provider.sent[0]?.prompt ?? "";
    expect(opening).toContain(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN);
    expect(opening).toContain(TEXT.build);
  });

  test("a second key for the ticket's active build reuses it", async () => {
    const build = await setup();
    const input = { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" };
    const first = await build.harness.call<{ pipelineId: string }>("build.launch", input, {
      requestId: "first",
    });
    const second = await build.harness.call<{ pipelineId: string; reused: boolean }>(
      "build.launch",
      input,
      { requestId: "second" },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result.pipelineId).toBe(first.result.pipelineId);
    expect(second.result.reused).toBe(true);
    expect(second.receipt?.operationId).not.toBe(first.receipt?.operationId);
  });

  test("guards refuse before admission and launch nothing", async () => {
    const build = await setup();
    const base = { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["iterations", { ...base, maxIterations: 11 }, "invalid-input"],
      ["iterations-zero", { ...base, maxIterations: 0 }, "invalid-input"],
      [
        "instructions",
        { ...base, steps: { verify: { instructions: "é".repeat(8193) } } },
        "input-too-large",
      ],
      [
        "reviewer-instructions",
        {
          ...base,
          reviewers: [{ agent: "claude", model: "opus", instructions: "x".repeat(16_385) }],
        },
        "input-too-large",
      ],
      [
        "lens-label",
        {
          ...base,
          reviewers: [
            { agent: "claude", model: "opus", lens: { label: "x".repeat(65), instruction: "y" } },
          ],
        },
        "invalid-input",
      ],
      [
        "lens-instruction",
        {
          ...base,
          reviewers: [
            { agent: "claude", model: "opus", lens: { label: "L", instruction: "é".repeat(2049) } },
          ],
        },
        "invalid-input",
      ],
      [
        "lens-on-build",
        { ...base, steps: { build: { lens: { label: "L", instruction: "y" } } } },
        "invalid-input",
      ],
      [
        "lens-on-preparation",
        { ...base, reviewPreparation: { lens: { label: "L", instruction: "y" } } },
        "invalid-input",
      ],
      ["model-without-agent", { ...base, steps: { pr: { model: "opus" } } }, "invalid-input"],
      ["reviewer-without-model", { ...base, reviewers: [{ agent: "claude" }] }, "invalid-input"],
      ["unknown-step", { ...base, steps: { ship: { agent: "claude" } } }, "invalid-input"],
      [
        "review-and-reviewers",
        {
          ...base,
          steps: { review: { instructions: "x" } },
          reviewers: [{ agent: "claude", model: "opus" }],
        },
        "invalid-input",
      ],
      ["both-targets", { ...base, type: "local" }, "invalid-input"],
      ["no-target", { projectId: build.projectId, ticketId: build.ticketId }, "invalid-input"],
      [
        "base-with-environment",
        { ...base, baseBranch: "main", baseCommit: "a".repeat(40) },
        "invalid-input",
      ],
      [
        "half-base",
        { ...base, environmentId: undefined, type: "local", baseBranch: "main" },
        "invalid-input",
      ],
      ["ticket", { ...base, ticketId: "missing" }, "not-found"],
      ["environment", { ...base, environmentId: "missing" }, "not-found"],
    ];
    for (const [name, input, code] of cases) {
      const refused = await build.harness.call("build.launch", input, { requestId: `bad-${name}` });
      expect({ name, code: refused.ok ? null : (refused.error.code as string) }).toEqual({
        name,
        code,
      });
      expect({ name, admitted: await admitted(build, `bad-${name}`) }).toEqual({
        name,
        admitted: false,
      });
    }
    const iterations = await build.harness.call(
      "build.launch",
      { ...base, maxIterations: 11 },
      { requestId: "bad-iterations-message" },
    );
    expect(!iterations.ok && iterations.error.message).toContain("iteration limit");
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(0);
  });

  test("an environment of another project, the project checkout or no supervisor is refused", async () => {
    const build = await setup();
    const environment = (await build.harness.storage.getEnvironment("env-1"))!;
    await build.harness.storage.addEnvironment({
      ...environment,
      id: "env-home",
      projectHome: true,
    });
    const home = await build.harness.call(
      "build.launch",
      { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-home" },
      { requestId: "home" },
    );
    expect(!home.ok && home.error.code).toBe("unsupported");
    await build.harness.storage.addEnvironment({
      ...environment,
      id: "env-other",
      projectId: "another-project",
    });
    const other = await build.harness.call(
      "build.launch",
      { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-other" },
      { requestId: "other" },
    );
    expect(!other.ok && other.error.code).toBe("conflict");
    (build.harness.context as { buildPipelines?: unknown }).buildPipelines = undefined;
    const unavailable = await build.harness.call(
      "build.launch",
      { projectId: build.projectId, ticketId: build.ticketId, type: "local" },
      { requestId: "unavailable" },
    );
    expect(!unavailable.ok && unavailable.error.code).toBe("capability-unavailable");
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(0);
  });

  test("a new environment takes the type, a validated base and the ticket's snapshot", async () => {
    const build = await setup();
    const project = (await build.harness.storage.getProject(build.projectId))!;
    const starts: StartBuildPipelineInput[] = [];
    const fake = {
      async start(input: StartBuildPipelineInput) {
        starts.push(input);
        return {
          id: "pipeline-new",
          projectId: input.projectId,
          environmentId: "",
          taskId: input.taskId,
          phase: "creating-environment",
        } as BuildPipeline;
      },
    } as unknown as BuildPipelineService;
    (build.harness.context as { buildPipelines?: BuildPipelineService }).buildPipelines = fake;
    const head = await headCommit(project.localPath!);
    const launched = await build.harness.call(
      "build.launch",
      {
        projectId: build.projectId,
        ticketId: build.ticketId,
        type: "container",
        baseBranch: "main",
        baseCommit: head,
        agent: "codex",
      },
      { requestId: "new-env" },
    );
    expect(launched.ok && launched.result).toEqual({
      pipelineId: "pipeline-new",
      projectId: build.projectId,
      environmentId: null,
      taskId: build.ticketId,
      phase: "creating-environment",
      reused: false,
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      taskId: build.ticketId,
      projectId: build.projectId,
      environmentType: "containerized",
      agentType: "codex",
      delegationBaseBranch: "main",
      delegationBaseCommit: head,
      source: { type: "kanban", taskId: build.ticketId },
      taskTitle: "Add a --verbose flag",
      taskSnapshot: {
        title: "Add a --verbose flag",
        acceptanceCriteria: expect.stringContaining("--verbose"),
        comments: [],
        images: [],
      },
    });
    expect(starts[0]!.existingEnvironmentId).toBeUndefined();

    // A container clones from the remote: an unpushed base is refused.
    const unpushed = await commitFile(project.localPath!, "local.txt", "local only\n");
    const refused = await build.harness.call(
      "build.launch",
      {
        projectId: build.projectId,
        ticketId: build.ticketId,
        type: "container",
        baseBranch: "main",
        baseCommit: unpushed,
      },
      { requestId: "unpushed" },
    );
    expect(!refused.ok && refused.error.code).toBe("conflict");
    expect(starts).toHaveLength(1);
  });
});

describe("build.cancel", () => {
  test("cancels once, replays, and refuses a build that already ended", async () => {
    const build = await setup();
    const launched = await build.harness.call<{ pipelineId: string }>(
      "build.launch",
      { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" },
      { requestId: "to-cancel" },
    );
    if (!launched.ok) throw new Error(launched.error.message);
    const pipelineId = launched.result.pipelineId;
    const cancelled = await build.harness.call("build.cancel", { pipelineId }, { requestId: "c1" });
    expect(cancelled.ok && cancelled.result).toMatchObject({ pipelineId, phase: "failed" });
    expect((await stored(build, pipelineId)).error).toBe("Build cancelled");
    const replay = await build.harness.call("build.cancel", { pipelineId }, { requestId: "c1" });
    expect(replay.receipt?.replayed).toBe(true);
    const again = await build.harness.call("build.cancel", { pipelineId }, { requestId: "c2" });
    expect(!again.ok && again.error.code).toBe("conflict");
    const missing = await build.harness.call(
      "build.cancel",
      { pipelineId: "missing" },
      { requestId: "c3" },
    );
    expect(!missing.ok && missing.error.code).toBe("not-found");
    const get = await build.harness.call("build.get", { pipelineId: "missing" });
    expect(!get.ok && get.error.code).toBe("not-found");
  });
});

describe("restart recovery", () => {
  /**
   * An operation a backend left in flight when it died: admitted under the
   * same key and intent `build.launch` would compute, then running.
   */
  async function inFlight(
    build: BuildHarness,
    action: "build.launch" | "build.cancel",
    input: Record<string, unknown>,
    resolved: Record<string, string>,
  ): Promise<string> {
    const scope =
      action === "build.launch"
        ? `project:${build.projectId}`
        : `build:${String(input.pipelineId)}`;
    const intent = action === "build.launch" ? parseBuildLaunch(input) : input;
    const { record } = await build.harness.storage.publicOperations.admitPublicOperation({
      authority: "operator",
      action,
      scope,
      requestId: "restart",
      requestKey: requestKey("operator", action, scope, "restart"),
      fingerprint: intentFingerprint(action, intent),
      generation: build.harness.storage.getResourceGeneration(),
      resources: { projectId: build.projectId },
      resolved,
    });
    await build.harness.storage.publicOperations.updatePublicOperation(
      record.operationId,
      (current) => ({ ...current, state: "running", stage: "launching" }),
    );
    return record.operationId;
  }

  async function launched(build: BuildHarness, requestId: string): Promise<BuildPipeline> {
    const response = await build.harness.call<{ pipelineId: string }>(
      "build.launch",
      { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" },
      { requestId },
    );
    if (!response.ok) throw new Error(response.error.message);
    return stored(build, response.result.pipelineId);
  }

  test("a launch the restart interrupted settles from the saved pipeline and never launches again", async () => {
    let build = await setup();
    const input = { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" };
    // The pipeline the interrupted launch saved, under its admission key.
    const pipeline = await launched(build, "earlier");
    const operationId = await inFlight(build, "build.launch", input, {
      admissionKey: pipeline.admissionKey!,
    });
    build = await restart(build);
    const recovered = await build.harness.call("run.get", { operationId });
    expect(recovered.receipt).toMatchObject({
      state: "partial",
      result: { pipelineId: pipeline.id, environmentId: "env-1" },
      error: { code: "partial-failure" },
    });
    const replay = await build.harness.call("build.launch", input, { requestId: "restart" });
    expect(replay.receipt).toMatchObject({ operationId, replayed: true, state: "partial" });
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(1);
    expect(build.invoked).toEqual([]);
  });

  test("without a saved pipeline the launch is interrupted, not run again", async () => {
    let build = await setup();
    const input = { projectId: build.projectId, ticketId: build.ticketId, environmentId: "env-1" };
    await inFlight(build, "build.launch", input, { admissionKey: "0".repeat(64) });
    build = await restart(build);
    const replay = await build.harness.call("build.launch", input, { requestId: "restart" });
    expect(replay.receipt).toMatchObject({ replayed: true, state: "interrupted" });
    expect(!replay.ok && replay.error.code).toBe("run-interrupted");
    expect(await build.harness.storage.listBuildPipelines(build.projectId)).toHaveLength(0);
    expect(build.invoked).toEqual([]);
  });

  for (const ended of [true, false]) {
    test(`a cancel the restart interrupted ${ended ? "settles from the ended pipeline" : "is interrupted while it still runs"}`, async () => {
      let build = await setup();
      const pipeline = await launched(build, "to-cancel");
      if (ended) await build.service.cancel(pipeline.id);
      const operationId = await inFlight(build, "build.cancel", { pipelineId: pipeline.id }, {});
      build = await restart(build);
      const recovered = await build.harness.call("run.get", { operationId });
      expect(recovered.receipt).toMatchObject(
        ended
          ? { state: "succeeded", result: { pipelineId: pipeline.id, phase: "failed" } }
          : { state: "interrupted", error: { code: "run-interrupted" } },
      );
      expect((await stored(build, pipeline.id)).phase).toBe(ended ? "failed" : pipeline.phase);
    });
  }
});
