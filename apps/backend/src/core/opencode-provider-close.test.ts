/**
 * OpenCode ordinary close (`OpenCodeProvider.closeSession`): stop the owned
 * turn through the provider's abort path (settling workflow-turn ownership),
 * reject what is still pending for that session (fail closed), keep the
 * conversation, and treat 404 as already gone. OpenCode's `DELETE
 * /session/:id` deletes the conversation and must never be called.
 */
import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeFake, openCodeProvider } from "./agent-provider-test-support.js";

const sessionId = "owned-session";

/**
 * Production providers leave interactions for the tab to answer; only close
 * may reject them. The compatibility auto-responder is off so any rejection
 * observed here came from close.
 */
function interactiveProvider(fake: ReturnType<typeof openCodeFake>) {
  return createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    { openCodeClient: fake.client, monitorRetryMs: 1, autoAnswerRequests: false },
  );
}

/** Make the fake's session list reflect deletions, so retention is observable. */
function trackLiveSessions(fake: ReturnType<typeof openCodeFake>, ids: string[]) {
  const live = new Set(ids);
  const session = fake.client.session as unknown as Record<
    string,
    (parameters?: Record<string, unknown>) => Promise<unknown>
  >;
  const originalDelete = session.delete!.bind(session);
  session.delete = async (parameters) => {
    live.delete(String(parameters?.sessionID));
    return originalDelete(parameters);
  };
  session.list = async () => ({
    data: [...live].map((id) => ({ id, title: `Conversation ${id}`, time: { created: 1 } })),
  });
  return live;
}

describe("OpenCode close retains the conversation", () => {
  test("rejects pending permissions and questions of the closed session only", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        { id: "perm-closed", sessionID: sessionId },
        { id: "perm-other", sessionID: "other-session" },
      ],
      [
        { id: "question-closed", sessionID: sessionId },
        { id: "question-other", sessionID: "other-session" },
      ],
    );
    const provider = interactiveProvider(fake);
    try {
      await provider.closeSession!(sessionId);
      expect(fake.abortCalls).toEqual([{ sessionID: sessionId, directory: "/workspace" }]);
      expect(fake.permissionReplies).toEqual([
        { requestID: "perm-closed", directory: "/workspace", reply: "reject" },
      ]);
      expect(fake.questionRejections).toEqual([
        { requestID: "question-closed", directory: "/workspace" },
      ]);
      expect(fake.deleteCalls).toEqual([]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("fails closed when pending requests cannot be read or rejected", async () => {
    const readFailure = openCodeFake();
    readFailure.setPendingReadErrors(new Error("unreachable"), undefined);
    const unreadable = interactiveProvider(readFailure);
    try {
      await expect(unreadable.closeSession!(sessionId)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    } finally {
      await unreadable.dispose?.();
    }

    const rejectFailure = openCodeFake();
    rejectFailure.setPending([{ id: "perm-closed", sessionID: sessionId }], []);
    rejectFailure.setPermissionReplyResponse({
      error: { message: "failed" },
      response: { status: 500 },
    });
    const stuck = interactiveProvider(rejectFailure);
    try {
      await expect(stuck.closeSession!(sessionId)).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await stuck.dispose?.();
    }
  });

  test("a request answered between the read and the rejection is not a failure", async () => {
    const fake = openCodeFake();
    fake.setPending([], [{ id: "question-closed", sessionID: sessionId }]);
    fake.setQuestionRejectResponse({ error: { name: "NotFound" }, response: { status: 404 } });
    const provider = interactiveProvider(fake);
    try {
      await expect(provider.closeSession!(sessionId)).resolves.toBeUndefined();
      expect(fake.questionRejections).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("treats 404 on abort as a session that is already gone", async () => {
    const fake = openCodeFake();
    fake.setAbortResponse({ error: { name: "NotFound" }, response: { status: 404 } });
    const provider = interactiveProvider(fake);
    try {
      await expect(provider.closeSession!("gone-session")).resolves.toBeUndefined();
      expect(fake.permissionReplies).toEqual([]);
      expect(fake.deleteCalls).toEqual([]);
      // An ordinary abort still reports the failure.
      await expect(provider.abort("gone-session")).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("settles the workflow turn it stops", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    const options = {
      requestId: "validation-1",
      workflowResultTool: "submit_validation_plan",
      agentMcp: {
        url: "http://fixture.invalid/mcp",
        token: "fixture-token",
        workflowResultCapability: "fixture-capability",
      },
    };
    try {
      await provider.send(sessionId, "Prepare", options);
      const owner = async () =>
        (await fake.client.session.get({ sessionID: sessionId })).data?.metadata?.[
          "orkestrator.workflowResultTurn"
        ];
      expect(await owner()).toEqual({ version: 1, requestId: "validation-1", settled: false });
      await provider.closeSession!(sessionId);
      expect(await owner()).toEqual({ version: 1, requestId: "validation-1", settled: true });
      expect(fake.deleteCalls).toEqual([]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("the closed conversation is still listed for resume", async () => {
    const fake = openCodeFake();
    const live = trackLiveSessions(fake, [sessionId, "other-session"]);
    const provider = interactiveProvider(fake);
    try {
      await provider.closeSession!(sessionId);
      expect(live.has(sessionId)).toBe(true);
      const listed = await provider.listResumableSessions!();
      expect(listed.map((entry) => entry.sessionId)).toContain(sessionId);
      // The session can be deliberately re-registered afterwards.
      provider.registerSession?.(sessionId);
    } finally {
      await provider.dispose?.();
    }
  });
});
