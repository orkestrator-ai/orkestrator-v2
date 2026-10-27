/** Pipeline records for the build pipeline's unit tests. */
import type { BuildPipeline, PipelineSession } from "@/stores/buildPipelineStore";
import type { ValidationRun } from "./pipeline-stage-groups";

export const CREATED = "2026-07-29T00:00:00.000Z";

/** A session starting `startSeconds` after the pipeline was created. */
export function session(
  phase: PipelineSession["phase"],
  key: string,
  startSeconds: number,
  overrides: Partial<PipelineSession> = {},
): PipelineSession {
  const startedAt = new Date(Date.parse(CREATED) + startSeconds * 1_000).toISOString();
  return {
    phase,
    iteration: 0,
    sessionKey: key,
    sdkSessionId: `${key}-session`,
    status: "idle",
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 50_000).toISOString(),
    label: `${key} label`,
    ...overrides,
  };
}

export function build(overrides: Partial<BuildPipeline>): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: CREATED,
    taskTitle: "Grouped",
    taskSnapshot: {
      title: "Grouped",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

/** A retry whose failed sessionless attempt survives on retired consolidation history. */
export function sessionlessReviewerRetry(status: "pending" | "running" | "failed"): BuildPipeline {
  return build({
    phase: "reviewing",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt" },
    ],
    reviewFanout: {
      reviewers: [
        {
          id: "retry",
          agent: "claude",
          model: "opus",
          status,
          error: status === "failed" ? "Retry creation failed" : undefined,
        },
        {
          id: "survivor",
          agent: "codex",
          model: "gpt",
          status: "completed",
          sessionKey: "survivor",
        },
      ],
    },
    sessions: [
      session("review", "survivor", 60, {
        label: "Review 2",
        reviewPassId: "retry",
        reviewerOutcome: "completed",
      }),
      session("review", "discarded", 120, {
        label: "Consolidation",
        reviewPassId: "retry",
        superseded: true,
        sessionlessReviewers: [
          { id: "retry", slot: 0, agent: "claude", model: "opus", error: "Creation failed" },
        ],
      }),
    ],
  });
}

export function validationRun(overrides: Partial<ValidationRun> = {}): ValidationRun {
  const command = {
    id: "test",
    command: "mise run test",
    cwd: ".",
    dependsOn: [] as string[],
    resources: ["turbo"],
    weight: 2 as const,
    timeoutMs: 1_200_000,
  };
  return {
    id: "validation-1",
    status: "completed",
    startedAt: "2026-07-29T00:03:00.000Z",
    completedAt: "2026-07-29T00:03:30.000Z",
    plan: {
      headRef: "a".repeat(40),
      commands: [command, { ...command, id: "lint" }],
      limitations: [],
    },
    results: ["test", "lint"].map((id) => ({
      id,
      command: "mise run test",
      status: "passed" as const,
      exitCode: 0,
      stdoutPath: ".orkestrator/test.stdout",
      stderrPath: ".orkestrator/test.stderr",
      stdoutBytes: 24,
      stderrBytes: 0,
      durationMs: 3_000,
      limitation: null,
    })),
    ...overrides,
  };
}

/**
 * Round 2's Verify failed; the user restarted round 1's Verify, which now
 * runs again. Verify 1, Fix 2, Review 2 and Verify 2 are the previous attempt.
 */
export function rewoundToFirstVerify(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  const superseded = { supersededBy: "rewind-1", supersededAt: "2026-07-29T00:10:00.000Z" };
  return build({
    phase: "verifying",
    iteration: 0,
    currentSessionIndex: 6,
    sessions: [
      session("build", "build-1", 0),
      session("review", "review-1", 60),
      session("verify", "verify-1", 120, { ...superseded, verificationResult: "fail" }),
      session("fix", "fix-2", 180, { ...superseded, iteration: 1 }),
      session("review", "review-2", 240, { ...superseded, iteration: 1 }),
      session("verify", "verify-2", 300, {
        ...superseded,
        iteration: 1,
        status: "error",
        error: "Verification failed after 2 iterations",
      }),
      session("verify", "verify-1-rerun", 600, { status: "running", completedAt: undefined }),
    ],
    rewinds: [
      {
        id: "rewind-1",
        at: "2026-07-29T00:10:00.000Z",
        fromPhase: "failed",
        fromIteration: 1,
        iteration: 0,
        step: { kind: "session", phase: "verify" },
        sessionKey: "verify-1",
        supersededSessions: 4,
      },
    ],
    ...overrides,
  });
}
