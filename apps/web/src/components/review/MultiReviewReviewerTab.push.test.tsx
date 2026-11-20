/**
 * The reviewer tab over the `review-transcript` push topic
 * (docs/architecture/push-events.md): while active it reads its reviewer's
 * transcript when a frame names it, and while the subscription is healthy
 * its backstop falls from the old cadence to the recovery poll.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { PUSH_STREAM_STATE_EVENT } from "@orkestrator/protocol/push-events";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  acceptPushSets,
  connectPush,
  emitPushChange,
  subscribedPushKeys,
} from "@/test/push-fixture";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";

const KEY = "multi-1/reviewer/reviewer-1";
/** Fast enough to see several old-cadence reads in a short real-time window. */
const POLL_MS = 40;

afterEach(() => {
  cleanupNodeScopes();
  resetReadCoordinatorForTests();
});

function transcript(token: string): MultiReviewReviewerTranscript {
  return {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "claude",
    model: "opus",
    status: "running",
    messages: [],
    transcript: "snapshot",
    sourceToken: token,
  };
}

function setup() {
  let token = "token-1";
  const loadTranscript = mock(async () => transcript(token));
  const node = new FakeNodeClient({ invoke: { push_set_subscriptions: acceptPushSets } });
  const view = renderInNodeScope(
    <MultiReviewReviewerTab
      data={{ environmentId: "env-1", workflowId: "multi-1", reviewerId: "reviewer-1" } as never}
      isActive
      loadTranscript={loadTranscript}
      refreshIntervalMs={POLL_MS}
    />,
    { client: node },
  );
  const reads = () => loadTranscript.mock.calls.length;
  return {
    node,
    view,
    reads,
    setToken: (next: string) => {
      token = next;
    },
  };
}

const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test("subscribes its reviewer, reads on frames and otherwise only on the recovery poll", async () => {
  const { node, view, reads, setToken } = setup();
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
  await connectPush(node, view.scope, "review-transcript", KEY);
  expect(subscribedPushKeys(node)).toEqual([`review-transcript ${KEY}`]);
  await pause(POLL_MS * 3);
  const quiet = reads();
  await pause(POLL_MS * 8);
  expect(reads()).toBe(quiet);

  setToken("token-2");
  await emitPushChange(node, 1, "review-transcript", KEY, ["transcript"]);
  await waitFor(() => expect(reads()).toBe(quiet + 1));
  // Another reviewer's frame reads nothing here.
  await emitPushChange(node, 2, "review-transcript", "multi-1/reviewer/other", ["transcript"]);
  await pause(POLL_MS * 3);
  expect(reads()).toBe(quiet + 1);
});

test("a dropped stream returns it to the old cadence", async () => {
  const { node, view, reads } = setup();
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
  await connectPush(node, view.scope, "review-transcript", KEY);
  await pause(POLL_MS * 3);
  const quiet = reads();
  await act(async () => {
    node.emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
  });
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(quiet + 3), { timeout: 2_000 });
});
