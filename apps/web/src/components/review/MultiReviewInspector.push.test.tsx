/**
 * The flow graph inspector's transcript tails over the `review-transcript`
 * push topic (docs/architecture/push-events.md): a selected reviewer or step
 * reads its tail when a frame names it.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewStepTranscript,
} from "@orkestrator/protocol/multi-review";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  acceptPushSets,
  connectPush,
  emitPushChange,
  subscribedPushKeys,
} from "@/test/push-fixture";
import { ReviewerTranscriptTail, StepTranscriptTail } from "./MultiReviewInspector";

afterEach(() => {
  cleanupNodeScopes();
  resetReadCoordinatorForTests();
});

const node = () => new FakeNodeClient({ invoke: { push_set_subscriptions: acceptPushSets } });

test("a selected reviewer's tail subscribes its key and reads on a frame", async () => {
  const loadTranscript = mock(async (): Promise<MultiReviewReviewerTranscript> => ({
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "codex",
    model: "m",
    status: "running",
    messages: [],
    transcript: "snapshot",
    sourceToken: "t",
  }));
  const client = node();
  const view = renderInNodeScope(
    <ReviewerTranscriptTail
      workflowId="multi-1"
      reviewerId="reviewer-1"
      hasSession
      live
      isActive
      loadTranscript={loadTranscript}
    />,
    { client },
  );
  const key = "multi-1/reviewer/reviewer-1";
  await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
  await connectPush(client, view.scope, "review-transcript", key);
  expect(subscribedPushKeys(client)).toEqual([`review-transcript ${key}`]);
  const before = loadTranscript.mock.calls.length;
  await emitPushChange(client, 1, "review-transcript", key, ["transcript"]);
  await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThan(before));
});

test("a selected step's tail subscribes its step key and reads on a frame", async () => {
  const loadTranscript = mock(async (): Promise<MultiReviewStepTranscript> => ({
    workflowId: "multi-1",
    step: "consolidate",
    workflowPhase: "consolidating",
    session: "own",
    messages: [],
    transcript: "snapshot",
    sourceToken: "t",
  }));
  const client = node();
  const view = renderInNodeScope(
    <StepTranscriptTail
      workflowId="multi-1"
      step="consolidate"
      access={{ kind: "own" }}
      live
      isActive
      loadTranscript={loadTranscript}
    />,
    { client },
  );
  const key = "multi-1/step/consolidate";
  await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
  await connectPush(client, view.scope, "review-transcript", key);
  expect(subscribedPushKeys(client)).toEqual([`review-transcript ${key}`]);
  const before = loadTranscript.mock.calls.length;
  await emitPushChange(client, 1, "review-transcript", key, ["status"]);
  await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThan(before));
});
