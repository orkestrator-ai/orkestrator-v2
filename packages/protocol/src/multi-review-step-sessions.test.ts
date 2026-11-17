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
    addressFindingsModel: { agent: "codex", model: "gpt-6" },
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 1,
    ...overrides,
  };
}

function access(target: MultiReviewWorkflow) {
  return Object.fromEntries(
    (["prepare", "consolidate", "address-findings"] as const).map((step) => {
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
  for (const owner of [
    "preparationSession",
    "reviewSession",
    "addressFindingsSession",
    "reviewer",
  ] as const) {
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
          phase: "addressing-findings",
          reviewModel: { agent: "claude", model: "opus" },
          preparationSession: session("prepare", "prepare"),
          reviewSession: session("consolidate", "consolidate"),
          addressFindingsSession: session("address-findings", "address-findings"),
          activeRequest: {
            kind: "address-findings",
            requestId: "f",
            state: "sent",
            createdAt: STARTED,
          },
        }),
      ),
    ).toEqual({
      prepare: "own:prepare",
      consolidate: "own:consolidate",
      "address-findings": "own:address-findings",
    });
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
    ).toEqual({
      prepare: "own:prepare",
      consolidate: "other-step:prepare",
      "address-findings": "none",
    });
  });

  test("a session every step shares belongs to the step using it now", () => {
    // Without a separate preparation model all three ran in the Address Findings session.
    const legacy = (overrides: Partial<MultiReviewWorkflow>) =>
      workflow({ addressFindingsSession: session("shared"), ...overrides });
    expect(access(legacy({ phase: "reviewing" }))).toEqual({
      prepare: "own:shared",
      consolidate: "other-step:prepare",
      "address-findings": "other-step:prepare",
    });
    expect(access(legacy({ phase: "ready" }))).toEqual({
      prepare: "other-step:consolidate",
      consolidate: "own:shared",
      "address-findings": "other-step:consolidate",
    });
    expect(access(legacy({ phase: "completed" }))).toEqual({
      prepare: "other-step:address-findings",
      consolidate: "other-step:address-findings",
      "address-findings": "own:shared",
    });
    // The handoff has not been dispatched: the session still holds
    // consolidation's turn, and no step may claim it.
    expect(access(legacy({ phase: "interactive", addressPromptPending: true }))).toEqual({
      prepare: "other-step:none",
      consolidate: "other-step:none",
      "address-findings": "other-step:none",
    });
  });

  test("once the pipeline moves past every step sharing a session, the last one keeps it", () => {
    // An older record kept preparation and consolidation in one review session.
    expect(
      access(
        workflow({
          phase: "addressing-findings",
          reviewModel: { agent: "claude", model: "opus" },
          reviewSession: session("review"),
          addressFindingsSession: session("address-findings"),
          activeRequest: {
            kind: "address-findings",
            requestId: "f",
            state: "sent",
            createdAt: STARTED,
          },
        }),
      ),
    ).toEqual({
      prepare: "other-step:consolidate",
      consolidate: "own:review",
      "address-findings": "own:address-findings",
    });
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
    expect(
      isMultiReviewStepTranscriptRequest({ workflowId: "multi-1", step: "address-findings" }),
    ).toBe(true);
    expect(
      isMultiReviewStepTranscriptRequest({
        workflowId: "multi-1",
        step: "prepare",
        knownSourceToken: "rt1.scope.token",
      }),
    ).toBe(true);
    for (const invalid of [
      { workflowId: "multi-1", step: "reviewer" },
      { workflowId: " ", step: "address-findings" },
      { workflowId: "multi-1", step: "address-findings", knownSourceToken: "" },
      { workflowId: "multi-1", step: "address-findings", knownSourceToken: "x".repeat(513) },
      { workflowId: "multi-1", step: "address-findings", extra: true },
    ]) {
      expect(isMultiReviewStepTranscriptRequest(invalid)).toBe(false);
    }
  });
});
