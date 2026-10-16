import { describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewStepTranscriptRequest,
  multiReviewSharedSessionStep,
  multiReviewOwnsProviderSession,
  multiReviewStepSessionAccess,
  type MultiReviewSession,
  type MultiReviewWorkflow,
} from "./multi-review";

const STARTED = "2026-10-16T00:00:00.000Z";

const session = (providerSessionId: string, openedFor?: MultiReviewSession["openedFor"]) =>
  ({
    agent: "codex",
    model: "gpt-6",
    sessionKey: `key-${providerSessionId}`,
    providerSessionId,
    requestIds: [],
    status: "idle",
    startedAt: STARTED,
    ...(openedFor ? { openedFor } : {}),
  }) satisfies MultiReviewSession;

function workflow(overrides: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-6" },
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 1,
    ...overrides,
  };
}

function access(target: MultiReviewWorkflow) {
  return Object.fromEntries(
    (["prepare", "consolidate", "fix"] as const).map((step) => {
      const answer = multiReviewStepSessionAccess(target, step);
      return [
        step,
        answer.kind === "other-step"
          ? `other-step:${answer.step ?? "none"}`
          : answer.kind === "own"
            ? `own:${answer.session.providerSessionId}`
            : "none",
      ];
    }),
  );
}

describe("step sessions", () => {
  for (const owner of ["preparationSession", "reviewSession", "fixSession", "reviewer"] as const) {
    test(`provider ownership includes the current ${owner} and requires the same agent`, () => {
      const current = session("current");
      const target = workflow(
        owner === "reviewer"
          ? { reviewers: [{ id: "reviewer-1", ...current, status: "running" }] }
          : { [owner]: current },
      );
      expect(multiReviewOwnsProviderSession(target, "codex", "current")).toBe(true);
      expect(multiReviewOwnsProviderSession(target, "claude", "current")).toBe(false);
      expect(multiReviewOwnsProviderSession(target, "codex", "superseded")).toBe(false);
      expect(multiReviewOwnsProviderSession(workflow({}), "codex", "current")).toBe(false);
    });
  }

  test("separate sessions each belong to their own step", () => {
    expect(
      access(
        workflow({
          phase: "fixing",
          reviewModel: { agent: "claude", model: "opus" },
          preparationSession: session("prepare", "prepare"),
          reviewSession: session("consolidate", "consolidate"),
          fixSession: session("fix", "fix"),
          activeRequest: { kind: "fix", requestId: "f", state: "sent", createdAt: STARTED },
        }),
      ),
    ).toEqual({ prepare: "own:prepare", consolidate: "own:consolidate", fix: "own:fix" });
  });

  test("a step with no session yet has nothing to read", () => {
    expect(
      access(
        workflow({
          phase: "preparing",
          reviewModel: { agent: "claude", model: "opus" },
          reviewSession: session("prepare", "prepare"),
        }),
      ),
    ).toEqual({ prepare: "own:prepare", consolidate: "other-step:prepare", fix: "none" });
  });

  test("a session every step shares belongs to the step using it now", () => {
    // Without a separate preparation model all three ran in the fix session.
    const legacy = (overrides: Partial<MultiReviewWorkflow>) =>
      workflow({ fixSession: session("shared"), ...overrides });
    expect(access(legacy({ phase: "reviewing" }))).toEqual({
      prepare: "own:shared",
      consolidate: "other-step:prepare",
      fix: "other-step:prepare",
    });
    expect(access(legacy({ phase: "ready" }))).toEqual({
      prepare: "other-step:consolidate",
      consolidate: "own:shared",
      fix: "other-step:consolidate",
    });
    expect(access(legacy({ phase: "completed" }))).toEqual({
      prepare: "other-step:fix",
      consolidate: "other-step:fix",
      fix: "own:shared",
    });
    // The handoff has not been dispatched: the session still holds
    // consolidation's turn, and no step may claim it.
    expect(access(legacy({ phase: "interactive", addressPromptPending: true }))).toEqual({
      prepare: "other-step:none",
      consolidate: "other-step:none",
      fix: "other-step:none",
    });
  });

  test("once the pipeline moves past every step sharing a session, the last one keeps it", () => {
    // An older record kept preparation and consolidation in one review session.
    expect(
      access(
        workflow({
          phase: "fixing",
          reviewModel: { agent: "claude", model: "opus" },
          reviewSession: session("review"),
          fixSession: session("fix"),
          activeRequest: { kind: "fix", requestId: "f", state: "sent", createdAt: STARTED },
        }),
      ),
    ).toEqual({ prepare: "other-step:consolidate", consolidate: "own:review", fix: "own:fix" });
  });

  test("the shared-session owner follows the phase, then the failed request", () => {
    expect(multiReviewSharedSessionStep(workflow({ phase: "consolidating" }))).toBe("consolidate");
    expect(multiReviewSharedSessionStep(workflow({ phase: "paused", pausedStep: "prepare" }))).toBe(
      "prepare",
    );
    expect(
      multiReviewSharedSessionStep(
        workflow({
          phase: "failed",
          activeRequest: { kind: "consolidate", requestId: "c", state: "sent", createdAt: STARTED },
        }),
      ),
    ).toBe("consolidate");
    expect(multiReviewSharedSessionStep(workflow({ phase: "cancelled" }))).toBeNull();
  });
});

describe("step transcript requests", () => {
  test("accept a known step and a bounded token only", () => {
    expect(isMultiReviewStepTranscriptRequest({ workflowId: "multi-1", step: "fix" })).toBe(true);
    expect(
      isMultiReviewStepTranscriptRequest({
        workflowId: "multi-1",
        step: "prepare",
        knownSourceToken: "rt1.scope.token",
      }),
    ).toBe(true);
    for (const invalid of [
      { workflowId: "multi-1", step: "reviewer" },
      { workflowId: " ", step: "fix" },
      { workflowId: "multi-1", step: "fix", knownSourceToken: "" },
      { workflowId: "multi-1", step: "fix", knownSourceToken: "x".repeat(513) },
      { workflowId: "multi-1", step: "fix", extra: true },
    ]) {
      expect(isMultiReviewStepTranscriptRequest(invalid)).toBe(false);
    }
  });
});
