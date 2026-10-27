import { describe, expect, test } from "bun:test";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { deferred, openCodeFake, waitUntil } from "./agent-provider-test-support.js";
import { OpenCodeActionRetryCoordinator } from "./opencode-action-retry.js";
import { OpenCodeReviewSessionPermissions } from "./opencode-review-session-permissions.js";
import { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";
import { OpenCodeWorkflowResultBroker } from "./opencode-workflow-result-broker.js";

const sessionId = "owned-session";

function retryHarness() {
  const fake = openCodeFake();
  const connection = {
    agent: "opencode" as const,
    baseUrl: "http://opencode.test",
    authToken: "test-token",
    directory: "/workspace",
  };
  const messageIds = new OpenCodeMessageIdCoordinator();
  const requestOptions = () => ({ signal: new AbortController().signal });
  const state = new OpenCodeStreamState();
  const lifecycle = new OpenCodeSessionLifecycle(
    fake.client,
    connection.directory,
    Date.now,
    1000,
    requestOptions,
  );
  lifecycle.own(sessionId);
  state.beginTurn(sessionId, 1, "request-1");
  state.apply({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "retry", action: { title: "Usage limit reached" } },
    },
  } as never);
  const workflowResults = new OpenCodeWorkflowResultBroker(
    fake.client,
    connection.directory,
    requestOptions,
    (id, operation) => messageIds.runExclusive(id, operation),
  );
  const reviewPermissions = new OpenCodeReviewSessionPermissions(
    fake.client,
    connection.directory,
    requestOptions,
    () => undefined,
  );
  const coordinator = new OpenCodeActionRetryCoordinator(
    connection,
    fake.client,
    messageIds,
    state,
    lifecycle,
    workflowResults,
    reviewPermissions,
    requestOptions,
    () => undefined,
  );
  fake.setPending(
    [
      { id: "perm-stopped", sessionID: sessionId },
      { id: "perm-other", sessionID: "other" },
    ],
    [
      { id: "question-stopped", sessionID: sessionId },
      { id: "question-other", sessionID: "other" },
    ],
  );
  return { fake, coordinator, workflowResults };
}

describe("OpenCode automatic retry abort cleanup", () => {
  test("rejects parked permissions and questions before the abort task completes", async () => {
    const { fake, coordinator, workflowResults } = retryHarness();
    await workflowResults.begin(sessionId, "request-1");
    const gate = deferred();
    fake.setPendingReadGate(gate.promise);
    coordinator.requestAbort(sessionId);
    try {
      await waitUntil(() => fake.permissionListCallCount === 1);
      expect(coordinator.isPending(sessionId)).toBe(true);
      expect(fake.abortCalls).toHaveLength(1);
      gate.resolve();
      await waitUntil(() => !coordinator.isPending(sessionId));
      expect(coordinator.isUnsettled(sessionId)).toBe(false);
      expect(fake.permissionReplies.map((reply) => reply.requestID)).toEqual(["perm-stopped"]);
      expect(fake.questionRejections.map((reply) => reply.requestID)).toEqual(["question-stopped"]);
      expect((await fake.client.permission.list()).data).toMatchObject([
        { id: "perm-other", sessionID: "other" },
      ]);
      expect((await fake.client.question.list()).data).toMatchObject([
        { id: "question-other", sessionID: "other" },
      ]);
    } finally {
      gate.resolve();
      await waitUntil(() => !coordinator.isPending(sessionId));
    }
  });

  test("still rejects pending requests when ownership settlement fails after interruption", async () => {
    const { fake, coordinator, workflowResults } = retryHarness();
    await workflowResults.begin(sessionId, "request-1");
    fake.setAbortHandler(async () => {
      fake.setSessionGetError(new Error("settlement read unavailable"));
      return { data: true };
    });
    coordinator.requestAbort(sessionId);
    await waitUntil(() => !coordinator.isPending(sessionId));
    expect(fake.permissionReplies).toHaveLength(1);
    expect(fake.questionRejections).toHaveLength(1);
    expect(coordinator.isUnsettled(sessionId)).toBe(true);
  });

  test("reports cleanup failure and permits a later abort to retry rejection", async () => {
    const { fake, coordinator } = retryHarness();
    fake.setQuestionRejectResponse({
      error: { message: "unavailable" },
      response: { status: 500 },
    });
    coordinator.requestAbort(sessionId);
    await waitUntil(() => !coordinator.isPending(sessionId));
    expect(coordinator.isUnsettled(sessionId)).toBe(true);
    fake.setQuestionRejectResponse({ data: true });
    coordinator.requestAbort(sessionId);
    await waitUntil(() => !coordinator.isPending(sessionId));
    expect(coordinator.isUnsettled(sessionId)).toBe(false);
    expect(fake.abortCalls).toHaveLength(2);
    expect((await fake.client.question.list()).data).toMatchObject([
      { id: "question-other", sessionID: "other" },
    ]);
  });
});
