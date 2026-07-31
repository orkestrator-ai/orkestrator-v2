import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_VERSION,
  BUILD_STEP_KEYS,
  isActiveBuildPhase,
  isBuildPipeline,
  isBuildStepConfigs,
  isStartBuildPipelineInput,
  stepKeyForSessionPhase,
  MAX_BUILD_PIPELINE_ITERATIONS,
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  isVerificationVerdict,
  VERIFICATION_VERDICT_SCHEMA,
  type BuildPipeline,
  type BuildStepKey,
  type PipelineSessionPhase,
} from "./build-pipeline.js";
import type { StructuredReviewReport } from "./structured-review.js";

function snapshot(): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-29T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}

describe("build pipeline protocol", () => {
  test("accepts a backend-owned snapshot and exposes the current version", () => {
    expect(BUILD_PIPELINE_VERSION).toBe(2);
    expect(isBuildPipeline(snapshot())).toBe(true);
  });

  test("rejects a client-authored or malformed snapshot", () => {
    const { controller: _controller, ...clientAuthored } = snapshot();
    expect(isBuildPipeline(clientAuthored)).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), currentSessionIndex: 0 })).toBe(false);
  });

  test("rejects every malformed top-level snapshot field", () => {
    const session = {
      phase: "build" as const,
      iteration: 0,
      sessionKey: "build-0",
      sdkSessionId: "session-1",
      status: "running" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build",
    };
    const withSession: BuildPipeline = {
      ...snapshot(),
      sessions: [session],
      currentSessionIndex: 0,
    };
    const invalid: Array<[string, unknown]> = [
      ["non-record", null],
      ["array", []],
      ["controller", { ...snapshot(), controller: "client" }],
      ["id type", { ...snapshot(), id: 1 }],
      ["taskId type", { ...snapshot(), taskId: 1 }],
      ["projectId type", { ...snapshot(), projectId: 1 }],
      ["environmentId type", { ...snapshot(), environmentId: 1 }],
      ["environmentType", { ...snapshot(), environmentType: "remote" }],
      ["agentType", { ...snapshot(), agentType: "unknown" }],
      ["phase", { ...snapshot(), phase: "unknown" }],
      ["sessions type", { ...snapshot(), sessions: {} }],
      ["session item", { ...snapshot(), sessions: [{}] }],
      ["negative iteration", { ...snapshot(), iteration: -1 }],
      ["fractional iteration", { ...snapshot(), iteration: 0.5 }],
      ["fractional maxIterations", { ...snapshot(), maxIterations: 1.5 }],
      [
        "unsafe maxIterations",
        { ...snapshot(), maxIterations: Number.MAX_SAFE_INTEGER + 1 },
      ],
      ["negative backendRevision", { ...snapshot(), backendRevision: -1 }],
      [
        "fractional backendRevision",
        { ...snapshot(), backendRevision: 0.5 },
      ],
      ["taskTitle type", { ...snapshot(), taskTitle: 1 }],
      ["taskSnapshot", { ...snapshot(), taskSnapshot: {} }],
      ["verificationFeedback", { ...snapshot(), verificationFeedback: 1 }],
      ["structuredReview", { ...snapshot(), structuredReview: {} }],
      [
        "structuredReviewRequestId",
        { ...snapshot(), structuredReviewRequestId: "" },
      ],
      ["pausedFromPhase", { ...snapshot(), pausedFromPhase: "paused" }],
      ["error", { ...snapshot(), error: 1 }],
      ["failureContext", { ...snapshot(), failureContext: {} }],
      ["reconnectAttempt", { ...snapshot(), reconnectAttempt: {} }],
      ["pendingPromptAttempt", { ...snapshot(), pendingPromptAttempt: {} }],
      ["activePromptContext", { ...snapshot(), activePromptContext: {} }],
      ["pendingUserMessages", { ...snapshot(), pendingUserMessages: {} }],
      ["reviewRetryRequested", { ...snapshot(), reviewRetryRequested: 1 }],
      ["source", { ...snapshot(), source: { type: "unknown" } }],
      ["featurePlanId", { ...snapshot(), featurePlanId: "" }],
      ["admissionKey", { ...snapshot(), admissionKey: "" }],
      ["sourceLinkedAt", { ...snapshot(), sourceLinkedAt: "invalid" }],
      [
        "completionCommentStatus",
        { ...snapshot(), completionCommentStatus: "unknown" },
      ],
      [
        "completionCommentError",
        { ...snapshot(), completionCommentError: 1 },
      ],
      [
        "completionCommentId",
        { ...snapshot(), completionCommentId: "" },
      ],
      [
        "completionCommentPostedAt",
        { ...snapshot(), completionCommentPostedAt: "invalid" },
      ],
      [
        "fractional currentSessionIndex",
        { ...snapshot(), currentSessionIndex: -0.5 },
      ],
      [
        "negative index with sessions",
        { ...withSession, currentSessionIndex: -1 },
      ],
      [
        "out-of-range index with sessions",
        { ...withSession, currentSessionIndex: 1 },
      ],
    ];

    for (const [field, value] of invalid) {
      if (isBuildPipeline(value)) {
        throw new Error(`Accepted malformed snapshot field: ${field}`);
      }
    }
  });

  test("validates every persisted optional state branch", () => {
    const valid = {
      ...snapshot(),
      phase: "paused" as const,
      sessions: [{
        phase: "review" as const,
        iteration: 1,
        sessionKey: "review-1",
        sdkSessionId: "session-1",
        status: "running" as const,
        startedAt: "2026-07-29T00:01:00.000Z",
        label: "Review",
        messages: [],
        messageRevision: 2,
        structuredRequestId: "structured-1",
      }],
      currentSessionIndex: 0,
      verificationResult: "fail" as const,
      verificationFeedback: "A test failed.",
      structuredReviewRequestId: "review-request",
      pausedFromPhase: "reviewing" as const,
      error: "Paused by user",
      failureContext: {
        phase: "reviewing" as const,
        kind: "prompt-dispatch" as const,
        sessionId: "session-1",
        prompt: "continue",
        useTaskImages: false,
        requestId: "request-1",
        structuredReview: true,
      },
      reconnectAttempt: {
        id: "reconnect-1",
        phase: "reviewing" as const,
        kind: "stage-transition" as const,
        startedAt: "2026-07-29T00:02:00.000Z",
      },
      pendingPromptAttempt: {
        id: "attempt-1",
        sessionId: "session-1",
        requestId: "request-1",
        phase: "reviewing" as const,
        prompt: "review",
        useTaskImages: false,
        structuredReview: true,
        startedAt: "2026-07-29T00:03:00.000Z",
      },
      activePromptContext: {
        phase: "reviewing" as const,
        kind: "prompt-dispatch" as const,
      },
      source: {
        type: "github" as const,
        repositoryOwner: "owner",
        repositoryName: "repository",
        issueNumber: 7,
        issueUrl: "https://example.test/issues/7",
        status: "open",
        updatedAt: "2026-07-29T00:04:00.000Z",
      },
      featurePlanId: "feature-1",
      sourceLinkedAt: "2026-07-29T00:05:00.000Z",
      completionCommentStatus: "posted" as const,
      completionCommentId: "comment-1",
      completionCommentPostedAt: "2026-07-29T00:06:00.000Z",
    };

    expect(isBuildPipeline(valid)).toBe(true);

    const invalidOverrides: Array<Record<string, unknown>> = [
      { createdAt: "yesterday" },
      { verificationResult: "maybe" },
      { structuredReviewRequestId: "" },
      { pausedFromPhase: "paused" },
      { failureContext: { phase: "building", kind: "unknown" } },
      { reconnectAttempt: { ...valid.reconnectAttempt, startedAt: "invalid" } },
      { pendingPromptAttempt: { ...valid.pendingPromptAttempt, requestId: "" } },
      { source: { ...valid.source, issueNumber: 0 } },
      { featurePlanId: "" },
      { sourceLinkedAt: "invalid" },
      { completionCommentStatus: "unknown" },
      { completionCommentPostedAt: "invalid" },
      { sessions: [{ ...valid.sessions[0], messageRevision: -1 }] },
      { sessions: [{ ...valid.sessions[0], startedAt: "invalid" }] },
    ];
    for (const override of invalidOverrides) {
      expect(isBuildPipeline({ ...valid, ...override })).toBe(false);
    }
  });

  test("validates every source variant", () => {
    const base = snapshot();
    expect(isBuildPipeline({
      ...base,
      source: { type: "kanban", taskId: "task-1" },
    })).toBe(true);
    expect(isBuildPipeline({
      ...base,
      source: {
        type: "linear",
        issueId: "linear-id",
        issueIdentifier: "ENG-1",
        issueUrl: "https://example.test/ENG-1",
        status: "Started",
        teamKey: "ENG",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
    })).toBe(true);
    expect(isBuildPipeline({
      ...base,
      source: { type: "linear", issueId: "", issueIdentifier: "ENG-1" },
    })).toBe(false);
    expect(isBuildPipeline({
      ...base,
      source: { type: "kanban", taskId: "" },
    })).toBe(false);
  });

  test("accepts per-step configuration and rejects keys no step reads", () => {
    const base = snapshot();
    const steps = {
      build: { agent: "claude", model: "claude-a", reasoningEffort: "high" },
      review: { agent: "codex" },
    };
    expect(isBuildPipeline({ ...base, steps })).toBe(true);
    expect(isBuildPipeline({
      ...base,
      sessions: [{
        phase: "review",
        agent: "codex",
        iteration: 0,
        sessionKey: "key",
        sdkSessionId: "session",
        status: "running",
        startedAt: base.createdAt,
        label: "Review Session",
      }],
      currentSessionIndex: 0,
    })).toBe(true);

    expect(isBuildStepConfigs(steps)).toBe(true);
    expect(isBuildStepConfigs({ "resolve-conflicts": { agent: "codex" } })).toBe(true);
    // The fix stage follows the build step, so a key for it would never be read.
    expect(isBuildStepConfigs({ fix: { agent: "claude" } })).toBe(false);
    expect(isBuildStepConfigs({ build: { agent: "gemini" } })).toBe(false);
    expect(isBuildStepConfigs({ build: { agent: "claude", model: "" } })).toBe(false);
    expect(isBuildPipeline({ ...base, steps: { verify: {} } })).toBe(false);
    expect(isBuildPipeline({
      ...base,
      sessions: [{
        phase: "build",
        agent: "gemini",
        iteration: 0,
        sessionKey: "key",
        sdkSessionId: "session",
        status: "running",
        startedAt: base.createdAt,
        label: "Build Session",
      }],
      currentSessionIndex: 0,
    })).toBe(false);
  });

  test("rejects a step map that is not a record of steps at all", () => {
    // `Object.entries` is happy with a string or a number and returns nothing
    // for them, so without the record guard every one of these would read as an
    // empty — and therefore valid — configuration.
    for (const value of [null, undefined, [], "x", 123, true, () => undefined]) {
      expect(isBuildStepConfigs(value)).toBe(false);
    }
    expect(isBuildStepConfigs({})).toBe(true);
  });

  test("accepts an explicitly unset step but not a null one", () => {
    // A launcher that clears a step leaves the key behind with `undefined`,
    // which survives a structured clone but not JSON; both must round-trip.
    expect(isBuildStepConfigs({ build: undefined })).toBe(true);
    expect(isBuildStepConfigs({ build: undefined, review: { agent: "codex" } }))
      .toBe(true);
    // `null` is not "unset": it would reach the launcher as a configured step
    // and be dereferenced for its agent.
    expect(isBuildStepConfigs({ build: null })).toBe(false);
  });

  test("rejects a step whose harness, model or effort is unusable", () => {
    const invalid: unknown[] = [
      { build: {} },
      { build: { model: "claude-a" } },
      { build: { agent: "gemini" } },
      { build: { agent: null } },
      { build: { agent: 1 } },
      // A blank string is not "unset": it would be sent to the provider as the
      // model or effort to run under.
      { build: { agent: "claude", model: "" } },
      { build: { agent: "claude", reasoningEffort: "" } },
      { build: { agent: "claude", model: 123 } },
      { build: { agent: "claude", reasoningEffort: 123 } },
      { build: { agent: "claude", model: ["claude-a"] } },
      { build: [] },
      { build: "claude" },
    ];
    for (const value of invalid) {
      expect(isBuildStepConfigs(value)).toBe(false);
    }
    expect(isBuildStepConfigs({
      build: { agent: "claude", model: "claude-a", reasoningEffort: "high" },
    })).toBe(true);
    expect(isBuildStepConfigs({ build: { agent: "claude" } })).toBe(true);
  });

  test("rejects a prototype-polluting key from a parsed snapshot", () => {
    // JSON.parse makes `__proto__` an own enumerable key, so `Object.entries`
    // sees it. It is not a step, and carrying it through would put a key on the
    // record that nothing reads and every consumer inherits.
    const parsed = JSON.parse('{"__proto__":{"agent":"claude"}}') as unknown;
    expect(Object.keys(parsed as object)).toEqual(["__proto__"]);
    expect(isBuildStepConfigs(parsed)).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), steps: parsed })).toBe(false);
    expect(isBuildStepConfigs(
      JSON.parse('{"constructor":{"agent":"claude"}}'),
    )).toBe(false);
  });

  test("rejects a snapshot or a start request whose step map is malformed", () => {
    const base = snapshot();
    const input = {
      taskId: base.taskId,
      projectId: base.projectId,
      taskTitle: base.taskTitle,
      taskSnapshot: base.taskSnapshot,
      environmentType: base.environmentType,
      agentType: base.agentType,
    };
    for (const steps of [
      null,
      [],
      "build",
      7,
      { build: null },
      { build: { agent: "claude", reasoningEffort: "" } },
      { fix: { agent: "claude" } },
    ]) {
      expect(isBuildPipeline({ ...base, steps })).toBe(false);
      expect(isStartBuildPipelineInput({ ...input, steps })).toBe(false);
    }
    // Absent is not malformed: every step falls back to the repository default.
    expect(isBuildPipeline({ ...base, steps: undefined })).toBe(true);
    expect(isStartBuildPipelineInput({ ...input, steps: undefined })).toBe(true);
  });

  test("records the harness a session ran on, and only a known one", () => {
    const base = snapshot();
    const withAgent = (agent: unknown) => ({
      ...base,
      sessions: [{
        phase: "review",
        ...(agent === undefined ? {} : { agent }),
        iteration: 0,
        sessionKey: "review-key",
        sdkSessionId: "review-session",
        status: "idle",
        startedAt: base.createdAt,
        label: "Review Session",
      }],
      currentSessionIndex: 0,
    });

    for (const agent of ["claude", "codex", "opencode"]) {
      expect(isBuildPipeline(withAgent(agent))).toBe(true);
    }
    // Absent on every snapshot written before per-step harnesses existed; those
    // fall back to `agentType` rather than failing to load at all.
    expect(isBuildPipeline(withAgent(undefined))).toBe(true);
    for (const agent of ["gemini", "", null, 1, ["codex"]]) {
      expect(isBuildPipeline(withAgent(agent))).toBe(false);
    }
  });

  test("maps every phase to its own step, except the fix stage", () => {
    expect(stepKeyForSessionPhase("build")).toBe("build");
    expect(stepKeyForSessionPhase("review")).toBe("review");
    expect(stepKeyForSessionPhase("verify")).toBe("verify");
    expect(stepKeyForSessionPhase("pr")).toBe("pr");
    expect(stepKeyForSessionPhase("resolve-conflicts")).toBe("resolve-conflicts");
    // The fix stage has no launcher control of its own; it is build work.
    expect(stepKeyForSessionPhase("fix")).toBe("build");
  });

  test("maps every member of the phase union to a configurable step", () => {
    // A `Record` over the union, not a hand-picked list: adding a phase makes
    // this fail to compile rather than silently leaving it unasserted, which is
    // how a phase would end up resolving its harness from a step nobody
    // configures.
    const expected: Record<PipelineSessionPhase, BuildStepKey> = {
      build: "build",
      review: "review",
      verify: "verify",
      fix: "build",
      pr: "pr",
      "resolve-conflicts": "resolve-conflicts",
    };
    const phases = Object.keys(expected) as PipelineSessionPhase[];

    for (const phase of phases) {
      const step = stepKeyForSessionPhase(phase);
      expect(step).toBe(expected[phase]);
      // A step key the launcher never writes could never be read back.
      expect(BUILD_STEP_KEYS).toContain(step);
    }
    // Every configurable step is reachable from some phase, so no launcher
    // control can be configured and then never consulted.
    expect(new Set(phases.map(stepKeyForSessionPhase)))
      .toEqual(new Set(BUILD_STEP_KEYS));
  });

  test("publishes the configurable step keys in launcher order, immutably", () => {
    expect([...BUILD_STEP_KEYS]).toEqual([
      "build",
      "review",
      "verify",
      "pr",
      "resolve-conflicts",
    ]);
    // The guard tests membership against this list, and the launcher renders it
    // in order; a consumer mutating it would change both at once.
    expect(Object.isFrozen(BUILD_STEP_KEYS)).toBe(true);
    expect(() => {
      (BUILD_STEP_KEYS as BuildStepKey[]).push("fix" as BuildStepKey);
    }).toThrow();
    expect(BUILD_STEP_KEYS).toHaveLength(5);
  });

  test("classifies only nonterminal, nonpaused phases as active", () => {
    expect(isActiveBuildPhase("building")).toBe(true);
    expect(isActiveBuildPhase("paused")).toBe(false);
    expect(isActiveBuildPhase("complete")).toBe(false);
    expect(isActiveBuildPhase("failed")).toBe(false);
  });

  test("validates bounded start requests at the gateway boundary", () => {
    const pipeline = snapshot();
    const input = {
      taskId: pipeline.taskId,
      projectId: pipeline.projectId,
      taskTitle: pipeline.taskTitle,
      taskSnapshot: pipeline.taskSnapshot,
      environmentType: pipeline.environmentType,
      agentType: pipeline.agentType,
      maxIterations: 3,
    };
    expect(isStartBuildPipelineInput(input)).toBe(true);
    expect(isStartBuildPipelineInput({
      ...input,
      steps: { build: { agent: "claude", model: "claude-a" } },
    })).toBe(true);
    expect(isStartBuildPipelineInput({
      ...input,
      steps: { build: { agent: "claude" }, deploy: { agent: "codex" } },
    })).toBe(false);
    expect(isStartBuildPipelineInput({ ...input, maxIterations: 11 })).toBe(false);
    expect(isStartBuildPipelineInput({
      ...input,
      taskSnapshot: { ...input.taskSnapshot, images: [{ filename: 7, data: "" }] },
    })).toBe(false);
  });

  test("rejects malformed start request identifiers, enums, sources, and limits", () => {
    const base = {
      taskId: "task-1",
      projectId: "project-1",
      taskTitle: "Task",
      taskSnapshot: snapshot().taskSnapshot,
      environmentType: "local",
      agentType: "codex",
    };
    const invalid: unknown[] = [
      null,
      { ...base, taskId: "" },
      { ...base, projectId: "" },
      { ...base, taskTitle: "" },
      { ...base, environmentType: "remote" },
      { ...base, agentType: "unknown" },
      { ...base, existingEnvironmentId: "" },
      { ...base, featurePlanId: "" },
      { ...base, namingPrompt: 1 },
      { ...base, maxIterations: 0 },
      { ...base, maxIterations: 1.5 },
      { ...base, source: { type: "kanban", taskId: "" } },
      {
        ...base,
        source: {
          type: "github",
          repositoryOwner: "owner",
          repositoryName: "repo",
          issueNumber: -1,
          issueUrl: "url",
          status: "open",
        },
      },
      {
        ...base,
        taskSnapshot: {
          ...base.taskSnapshot,
          comments: [{ text: 4 }],
        },
      },
    ];
    for (const value of invalid) {
      expect(isStartBuildPipelineInput(value)).toBe(false);
    }
  });

  test("accepts and bounds the queued user message list", () => {
    const message = {
      id: "message-1",
      text: "also update the README",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    expect(isBuildPipeline({ ...snapshot(), pendingUserMessages: [] })).toBe(true);
    expect(isBuildPipeline({ ...snapshot(), pendingUserMessages: [message] }))
      .toBe(true);

    const invalid = [
      // Over the queue bound: a client that ignored sendMessage's limit, or a
      // hand-edited file, must not be able to grow this without bound.
      Array.from({ length: MAX_PIPELINE_USER_MESSAGES + 1 }, (_unused, index) => ({
        ...message,
        id: `message-${index}`,
      })),
      [{ ...message, text: "" }],
      [{ ...message, text: "x".repeat(MAX_PIPELINE_USER_MESSAGE_LENGTH + 1) }],
      [{ ...message, id: "" }],
      [{ ...message, createdAt: "not-a-date" }],
      [{ id: "message-1", text: "hello" }],
      "not-an-array",
    ];
    for (const pendingUserMessages of invalid) {
      expect(isBuildPipeline({ ...snapshot(), pendingUserMessages })).toBe(false);
    }
  });

  test("validates the review-retry request flag", () => {
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: true }))
      .toBe(true);
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: false }))
      .toBe(true);
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: "yes" }))
      .toBe(false);
  });

  test("validates the session fields the supervisor derives deadlines from", () => {
    const session = {
      phase: "review" as const,
      iteration: 0,
      sessionKey: "key",
      sdkSessionId: "session-1",
      status: "idle" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Review Session",
    };
    const withSession = (overrides: Record<string, unknown>) => ({
      ...snapshot(),
      sessions: [{ ...session, ...overrides }],
      currentSessionIndex: 0,
    });

    expect(isBuildPipeline(withSession({
      messagesFingerprint: "3:{}",
      messagesPersistedAt: "2026-07-29T00:00:01.000Z",
      structuredWaitStartedAt: "2026-07-29T00:00:02.000Z",
    }))).toBe(true);

    // A malformed timestamp here is not cosmetic: the supervisor subtracts it
    // from now() to decide whether to fail a stalled turn.
    expect(isBuildPipeline(withSession({ structuredWaitStartedAt: "soon" })))
      .toBe(false);
    expect(isBuildPipeline(withSession({ messagesPersistedAt: 0 }))).toBe(false);
    expect(isBuildPipeline(withSession({ messagesFingerprint: "" }))).toBe(false);
  });

  test("rejects a timestamp Date.parse would accept but toISOString never emits", () => {
    // Date.parse("March 5 2020") succeeds. Every timestamp in a snapshot comes
    // from toISOString, so accepting looser shapes only lets a legacy or
    // hand-edited record through into deadline arithmetic.
    for (const createdAt of [
      "March 5 2020",
      "2026-07-29",
      "2026-07-29T00:00:00",
      "29/07/2026",
      "",
    ]) {
      expect(isBuildPipeline({ ...snapshot(), createdAt })).toBe(false);
    }
    for (const createdAt of [
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00Z",
      "2026-07-29T00:00:00.000+01:00",
    ]) {
      expect(isBuildPipeline({ ...snapshot(), createdAt })).toBe(true);
    }
  });

  test("bounds maxIterations the same way on the record as at the gateway", () => {
    expect(isBuildPipeline({ ...snapshot(), maxIterations: 1 })).toBe(true);
    expect(isBuildPipeline({
      ...snapshot(),
      maxIterations: MAX_BUILD_PIPELINE_ITERATIONS,
    })).toBe(true);
    // The gateway caps starts at this bound, so a record above it can only come
    // from a writer that bypassed it — and it drives the fix-loop iteration cap.
    expect(isBuildPipeline({
      ...snapshot(),
      maxIterations: MAX_BUILD_PIPELINE_ITERATIONS + 1,
    })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), maxIterations: 0 })).toBe(false);
  });

  test("delegates structuredReview validation to the review report guard", () => {
    const report = {
      reviewScope: {
        targetBranch: "main",
        baseRef: "base",
        commit: { sha: "head", subject: "feat: build" },
        filesReviewed: [],
        filesSkipped: [],
        filesLeftUncommitted: [],
        commandsRun: [],
        commandsNotRun: [],
        limitations: [],
      },
      whatChanged: {
        overview: "o",
        before: "b",
        after: "a",
        keyCodeChanges: [],
        userImpact: "u",
      },
      riskProfile: {
        changeTypes: ["feature"],
        riskAreas: [],
        overallRisk: "low",
        reasoning: "r",
      },
      testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
      strengths: [],
      issues: [],
      testCoverageGaps: [],
      verdict: { ready: "yes", reasoning: "r" },
      summaryOfChange: "s",
      reviewSummary: "r",
    } as unknown as StructuredReviewReport;

    expect(isBuildPipeline({ ...snapshot(), structuredReview: report }))
      .toBe(true);
    expect(isBuildPipeline({
      ...snapshot(),
      structuredReview: { ...report, issues: "not-an-array" },
    })).toBe(false);
  });

  test("accepts the blank environmentId a pipeline holds before provisioning", () => {
    // Deliberate: the record exists before its environment does, and that window
    // is exactly when a crash used to orphan the pipeline.
    expect(isBuildPipeline({ ...snapshot(), environmentId: "" })).toBe(true);
    expect(isBuildPipeline({ ...snapshot(), projectId: "" })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), id: "" })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), taskId: "" })).toBe(false);
  });
});

describe("verification verdict contract", () => {
  test("accepts exactly the two contract fields", () => {
    expect(isVerificationVerdict({ complete: true, rationale: "Clean." }))
      .toBe(true);
    expect(isVerificationVerdict({ complete: false, rationale: "" }))
      .toBe(true);
  });

  test("rejects anything the schema would have rejected", () => {
    // `additionalProperties: false` is part of the contract, so a payload that
    // merely carries these two fields is not a verdict — the transcript would
    // otherwise render an unrelated tool result as a verification outcome.
    expect(isVerificationVerdict({
      complete: true,
      rationale: "Clean.",
      stage: "verify",
    })).toBe(false);
    expect(isVerificationVerdict({ complete: "yes", rationale: "Clean." }))
      .toBe(false);
    expect(isVerificationVerdict({ complete: true })).toBe(false);
    expect(isVerificationVerdict([])).toBe(false);
    expect(isVerificationVerdict(null)).toBe(false);
  });

  test("describes the shape the supervisor constrains the turn to", () => {
    expect(VERIFICATION_VERDICT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["complete", "rationale"],
      properties: {
        complete: { type: "boolean" },
        rationale: { type: "string" },
      },
    });
  });

  // The guard and the schema are derived from one field map, and these tests
  // fail if that ever stops being true. A guard with its own hardcoded field
  // list would keep passing the assertion above while silently refusing every
  // verdict the supervisor now asks for.
  test("the guard requires exactly the fields the schema declares", () => {
    const properties = VERIFICATION_VERDICT_SCHEMA.properties as Record<
      string,
      { type: string }
    >;
    const fields = Object.keys(properties);
    const sample: Record<string, unknown> = {};
    for (const [field, { type }] of Object.entries(properties)) {
      sample[field] = type === "boolean" ? true : "text";
    }

    expect(isVerificationVerdict(sample)).toBe(true);
    expect(VERIFICATION_VERDICT_SCHEMA.required).toEqual(fields);

    // Dropping any one declared field, or adding one the schema does not
    // declare, must fail the guard.
    for (const field of fields) {
      const { [field]: _omitted, ...missingOne } = sample;
      expect(isVerificationVerdict(missingOne)).toBe(false);
    }
    expect(isVerificationVerdict({ ...sample, extra: 1 })).toBe(false);
  });

  test("the schema and all nested containers cannot be mutated by a consumer", () => {
    // The supervisor hands this object straight to the provider, so a mutation
    // here would change what every future turn is constrained to.
    const required = VERIFICATION_VERDICT_SCHEMA.required as string[];
    const properties = VERIFICATION_VERDICT_SCHEMA.properties as Record<
      string,
      { type: string }
    >;

    expect(Object.isFrozen(VERIFICATION_VERDICT_SCHEMA)).toBe(true);
    expect(Object.isFrozen(required)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(properties.complete)).toBe(true);
    expect(Object.isFrozen(properties.rationale)).toBe(true);

    expect(() => {
      (VERIFICATION_VERDICT_SCHEMA as { type: string }).type = "array";
    }).toThrow();
    expect(() => {
      required.push("extra");
    }).toThrow();
    expect(() => {
      required.pop();
    }).toThrow();
    expect(() => {
      properties.extra = { type: "number" };
    }).toThrow();
    expect(() => {
      delete properties.complete;
    }).toThrow();
    expect(() => {
      properties.complete.type = "string";
    }).toThrow();

    expect(VERIFICATION_VERDICT_SCHEMA.type).toBe("object");
    expect(VERIFICATION_VERDICT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["complete", "rationale"],
      properties: {
        complete: { type: "boolean" },
        rationale: { type: "string" },
      },
    });
  });
});
