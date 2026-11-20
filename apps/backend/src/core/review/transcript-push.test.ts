import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { multiReviewTranscriptPushTarget, SharedReviewTranscripts } from "./transcript-push.js";

function session(providerSessionId: string, status = "running") {
  return {
    sessionKey: `key-${providerSessionId}`,
    providerSessionId,
    agent: "codex",
    model: "m",
    requestIds: [],
    status,
    startedAt: "2026-11-19T00:00:00.000Z",
  };
}

function workflow(overrides: Record<string, unknown> = {}): MultiReviewWorkflow {
  return {
    id: "wf-1",
    environmentId: "env-1",
    phase: "reviewing",
    reviewers: [
      {
        id: "r-1",
        agent: "claude",
        model: "sonnet",
        status: "running",
        providerSessionId: "reviewer-session",
        startedAt: "2026-11-19T00:00:00.000Z",
      },
      { id: "r-2", agent: "codex", model: "m", status: "pending" },
    ],
    reviewSession: session("coordinator"),
    preparationSession: session("prepare", "idle"),
    ...overrides,
  } as unknown as MultiReviewWorkflow;
}

describe("multiReviewTranscriptPushTarget", () => {
  test("a reviewer's target names its session and changes digest with what its tab shows", () => {
    const first = multiReviewTranscriptPushTarget(workflow(), {
      workflowId: "wf-1",
      reviewerId: "r-1",
    });
    expect(first).toMatchObject({
      environmentId: "env-1",
      agent: "claude",
      providerSessionId: "reviewer-session",
      live: true,
    });
    const reported = workflow();
    const reviewer = reported.reviewers[0] as unknown as Record<string, unknown>;
    reviewer.status = "completed";
    reviewer.report = { summary: "done" };
    const second = multiReviewTranscriptPushTarget(reported, {
      workflowId: "wf-1",
      reviewerId: "r-1",
    });
    expect(second?.live).toBe(false);
    expect(second?.digest).not.toBe(first?.digest);
    // The same record reads the same digest.
    expect(
      multiReviewTranscriptPushTarget(workflow(), { workflowId: "wf-1", reviewerId: "r-1" })
        ?.digest,
    ).toBe(first?.digest);
  });

  test("a pending reviewer has no session yet, and a missing one is null", () => {
    expect(
      multiReviewTranscriptPushTarget(workflow(), { workflowId: "wf-1", reviewerId: "r-2" }),
    ).toMatchObject({ agent: "codex", live: true });
    expect(
      multiReviewTranscriptPushTarget(workflow(), { workflowId: "wf-1", reviewerId: "r-2" })
        ?.providerSessionId,
    ).toBeUndefined();
    expect(
      multiReviewTranscriptPushTarget(workflow(), { workflowId: "wf-1", reviewerId: "gone" }),
    ).toBeNull();
  });

  test("a step names its session only while it owns it", () => {
    const prepare = multiReviewTranscriptPushTarget(workflow(), {
      workflowId: "wf-1",
      step: "prepare",
    });
    expect(prepare).toMatchObject({ providerSessionId: "prepare", live: false, agent: "codex" });
    const consolidate = multiReviewTranscriptPushTarget(workflow({ phase: "consolidating" }), {
      workflowId: "wf-1",
      step: "consolidate",
    });
    expect(consolidate).toMatchObject({ providerSessionId: "coordinator", live: true });
    const none = multiReviewTranscriptPushTarget(workflow(), {
      workflowId: "wf-1",
      step: "address-findings",
    });
    expect(none?.providerSessionId).toBeUndefined();
    expect(none?.live).toBe(false);
  });
});

test("a hint fences the old reviewer read and shares one trailing refresh", async () => {
  const shared = new SharedReviewTranscripts();
  const identity = {
    environmentId: "env",
    providerSessionId: "s1",
    agent: "claude",
    view: "reviewer",
  };
  const snapshot = (sourceToken: string) => ({
    kind: "snapshot" as const,
    sourceToken,
    bytes: 0,
    messages: [],
    truncated: false,
  });
  const held = Promise.withResolvers<ReturnType<typeof snapshot>>();
  let loads = 0;
  const load = async () => (++loads === 1 ? held.promise : snapshot("new"));
  const old = shared.read(identity, undefined, false, load);
  shared.invalidate(identity.environmentId, identity.agent, identity.providerSessionId);
  const trailing = shared.read(identity, undefined, false, load);
  const otherViewer = shared.read(identity, undefined, false, load);
  expect(loads).toBe(1);
  held.resolve(snapshot("old"));
  expect(await old).toMatchObject({ sourceToken: "old" });
  expect(await trailing).toMatchObject({ sourceToken: "new" });
  expect(await otherViewer).toMatchObject({ sourceToken: "new" });
  expect(loads).toBe(2);
});
