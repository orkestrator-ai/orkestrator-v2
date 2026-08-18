import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  getPendingPermissions,
  getPendingQuestions,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  subscribeToEvents,
  type OpencodeClient,
} from "./opencode-client";

const originalFetch = globalThis.fetch;

function setTestUrl(url: string): void {
  (window as unknown as Window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  setTestUrl("about:blank");
  mock.restore();
});

describe("opencode-client events and pending requests", () => {
  test("subscribes through stream and directly iterable response shapes", async () => {
    const stream = (async function* () {
      yield { type: "session.updated" };
    })();
    const wrapped = { event: { subscribe: async () => ({ stream }) } } as unknown as OpencodeClient;
    expect(await subscribeToEvents(wrapped)).toBe(stream);

    const direct = (async function* () {
      yield { type: "session.updated" };
    })();
    const directClient = { event: { subscribe: async () => direct } } as unknown as OpencodeClient;
    expect(await subscribeToEvents(directClient)).toBe(direct);
  });

  test("returns null for invalid or failed event subscriptions", async () => {
    const invalid = { event: { subscribe: async () => ({}) } } as unknown as OpencodeClient;
    const failed = {
      event: {
        subscribe: async () => {
          throw new Error("stream failed");
        },
      },
    } as unknown as OpencodeClient;
    expect(await subscribeToEvents(invalid)).toBeNull();
    expect(await subscribeToEvents(failed)).toBeNull();
  });

  test("lists pending questions and permissions, including empty and failed responses", async () => {
    const client = {
      question: { list: async () => ({ data: [{ id: "question-1", questions: [] }] }) },
      permission: { list: async () => ({ data: [{ id: "permission-1", permission: "edit" }] }) },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(client)).toHaveLength(1);
    expect(await getPendingPermissions(client)).toHaveLength(1);

    const empty = {
      question: { list: async () => ({ data: undefined }) },
      permission: { list: async () => ({ data: undefined }) },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(empty)).toEqual([]);
    expect(await getPendingPermissions(empty)).toEqual([]);

    const failed = {
      question: {
        list: async () => {
          throw new Error("question failed");
        },
      },
      permission: {
        list: async () => {
          throw new Error("permission failed");
        },
      },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(failed)).toEqual([]);
    expect(await getPendingPermissions(failed)).toEqual([]);
    await expect(getPendingQuestions(failed, { throwOnError: true })).rejects.toThrow(
      "question failed",
    );
    await expect(getPendingPermissions(failed, { throwOnError: true })).rejects.toThrow(
      "permission failed",
    );

    const resolvedFailure = {
      question: {
        list: async () => ({
          data: undefined,
          error: { message: "question endpoint unavailable" },
        }),
      },
      permission: {
        list: async () => ({
          data: undefined,
          error: { message: "permission endpoint unavailable" },
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(resolvedFailure)).toEqual([]);
    expect(await getPendingPermissions(resolvedFailure)).toEqual([]);
    await expect(getPendingQuestions(resolvedFailure, { throwOnError: true })).rejects.toThrow(
      "question endpoint unavailable",
    );
    await expect(getPendingPermissions(resolvedFailure, { throwOnError: true })).rejects.toThrow(
      "permission endpoint unavailable",
    );

    const primitiveFailure = {
      question: {
        list: async () => {
          throw "question offline";
        },
      },
      permission: {
        list: async () => {
          throw 503;
        },
      },
    } as unknown as OpencodeClient;
    await expect(getPendingQuestions(primitiveFailure, { throwOnError: true })).rejects.toThrow(
      "Failed to get pending OpenCode questions",
    );
    await expect(getPendingPermissions(primitiveFailure, { throwOnError: true })).rejects.toThrow(
      "Failed to get pending OpenCode permissions",
    );
  });

  test("normalizes both session-id spellings and rejects malformed or missing ids", async () => {
    const client = {
      question: {
        list: async () => ({
          data: [
            { id: "question-sdk", sessionID: "session-sdk", questions: [] },
            { id: "question-legacy", sessionId: "session-legacy", questions: [] },
            {
              id: "question-fallback",
              sessionID: 42,
              sessionId: "session-valid-fallback",
              questions: [],
            },
            { id: "question-malformed", sessionID: { id: "nested" }, questions: [] },
            { id: "question-missing", questions: [] },
          ],
        }),
      },
      permission: {
        list: async () => ({
          data: [
            {
              id: "permission-sdk",
              sessionID: "session-sdk",
              permission: "edit",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-legacy",
              sessionId: "session-legacy",
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-fallback",
              sessionID: "",
              sessionId: "session-valid-fallback",
              permission: "bash",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-malformed",
              sessionId: false,
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-missing",
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    expect((await getPendingQuestions(client)).map((request) => request.sessionId)).toEqual([
      "session-sdk",
      "session-legacy",
      "session-valid-fallback",
      "",
      "",
    ]);
    expect((await getPendingPermissions(client)).map((request) => request.sessionId)).toEqual([
      "session-sdk",
      "session-legacy",
      "session-valid-fallback",
      "",
      "",
    ]);
  });

  test("replies to and rejects requests with the v2 SDK shape", async () => {
    const questionReply = mock(async () => ({}));
    const questionReject = mock(async () => ({}));
    const permissionReply = mock(async () => ({}));
    const client = {
      question: { reply: questionReply, reject: questionReject },
      permission: { reply: permissionReply },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(client, "question-1", [["Yes"]])).toBe("applied");
    expect(await replyToPermission(client, "permission-1", "always", "remember")).toBe("applied");
    expect(await rejectQuestion(client, "question-1")).toBe("applied");
    expect(questionReply).toHaveBeenCalledWith(
      { requestID: "question-1", answers: [["Yes"]] },
      { throwOnError: true },
    );
    expect(permissionReply).toHaveBeenCalledWith(
      { requestID: "permission-1", reply: "always", message: "remember" },
      { throwOnError: true },
    );
    expect(questionReject).toHaveBeenCalledWith(
      { requestID: "question-1" },
      { throwOnError: true },
    );
  });

  test("reports pending when a failed response remains authoritatively pending", async () => {
    const failed = {
      question: {
        reply: async () => {
          throw new Error("reply failed");
        },
        reject: async () => {
          throw new Error("reject failed");
        },
        list: async () => ({
          data: [{ id: "question-1", sessionID: "session-1", questions: [] }],
        }),
      },
      permission: {
        reply: async () => {
          throw new Error("permission failed");
        },
        list: async () => ({
          data: [
            {
              id: "permission-1",
              sessionID: "session-1",
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await replyToQuestion(failed, "question-1", [])).toBe("pending");
    expect(await replyToPermission(failed, "permission-1", "reject")).toBe("pending");
    expect(await rejectQuestion(failed, "question-1")).toBe("pending");
  });

  test("reports gone without claiming application when reconciliation finds no request", async () => {
    const reconciled = {
      question: {
        reply: async () => {
          throw new Error("reply outcome unknown");
        },
        reject: async () => {
          throw new Error("reject outcome unknown");
        },
        list: async () => ({ data: [] }),
      },
      permission: {
        reply: async () => {
          throw new Error("permission outcome unknown");
        },
        list: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(reconciled, "question-1", [["Yes"]])).toBe("gone");
    expect(await replyToPermission(reconciled, "permission-1", "once")).toBe("gone");
    expect(await rejectQuestion(reconciled, "question-1")).toBe("gone");
  });

  test("reports unknown instead of throwing when reconciliation is unavailable", async () => {
    const unavailable = {
      question: {
        reply: async () => {
          throw new Error("reply outcome unknown");
        },
        reject: async () => {
          throw new Error("reject outcome unknown");
        },
        list: async () => {
          throw new Error("question reconciliation unavailable");
        },
      },
      permission: {
        reply: async () => {
          throw new Error("permission outcome unknown");
        },
        list: async () => {
          throw new Error("permission reconciliation unavailable");
        },
      },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(unavailable, "question-1", [["Yes"]])).toBe("unknown");
    expect(await replyToPermission(unavailable, "permission-1", "reject")).toBe("unknown");
    expect(await rejectQuestion(unavailable, "question-1")).toBe("unknown");
  });

  test("bounds reconciliation even when the pending-list client ignores cancellation", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) =>
      originalSetTimeout(handler, 0)) as typeof globalThis.setTimeout;
    try {
      const unavailable = {
        question: {
          reply: async () => {
            throw new Error("reply outcome unknown");
          },
          list: async () => new Promise(() => {}),
        },
      } as unknown as OpencodeClient;

      expect(await replyToQuestion(unavailable, "question-1", [["Yes"]])).toBe("unknown");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
