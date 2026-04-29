import { afterAll, describe, expect, test, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Snapshot the real session-manager BEFORE installing the route's stub mock.
// Bun's `mock.module(...)` is process-global, so without this restore step the
// stub below leaks into `services/session-manager.test.ts` (and any other
// suite that imports the real module). See CLAUDE.md > "Bun `mock.module()`
// Rules" > "Snapshot-and-restore pattern".
import * as realSessionManager from "../services/session-manager.js";
const realSessionManagerSnapshot = { ...realSessionManager };

// --- Mock session-manager before importing the route ---

const mockCreateSession = mock(() => ({
  id: "s-1",
  title: "Test",
  status: "idle" as const,
  createdAt: new Date("2026-01-01"),
  lastActivity: new Date("2026-01-01"),
}));

const mockGetSession = mock((id: string) =>
  id === "s-1"
    ? {
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      }
    : undefined
);

const mockListSessions = mock(() => [
  {
    id: "s-1",
    title: "Test",
    status: "idle" as const,
    createdAt: new Date("2026-01-01"),
    lastActivity: new Date("2026-01-01"),
  },
]);

const mockGetSessionMessages = mock(() => [
  { id: "msg-1", role: "assistant", content: "Hello", parts: [], timestamp: "2026-01-01T00:00:00Z" },
]);

type SendPromptParams = Parameters<typeof realSessionManager.sendPrompt>;
const mockSendPrompt = mock(async (..._args: SendPromptParams) => {});
const mockAbortSession = mock(() => true);
const mockDeleteSession = mock((id: string) => id === "s-1");
const mockGetPendingQuestions = mock<
  () => ReturnType<typeof realSessionManager.getPendingQuestions>
>(() => []);
const mockGetSessionInitData = mock(() => ({
  mcpServers: [],
  plugins: [],
  slashCommands: [],
}));
const mockAnswerQuestion = mock(() => true);
const mockGetPendingPlanApprovals = mock(() => []);
const mockRespondToPlanApproval = mock(() => true);

mock.module("../services/session-manager.js", () => ({
  createSession: mockCreateSession,
  getSession: mockGetSession,
  listSessions: mockListSessions,
  getSessionMessages: mockGetSessionMessages,
  sendPrompt: mockSendPrompt,
  abortSession: mockAbortSession,
  deleteSession: mockDeleteSession,
  getPendingQuestions: mockGetPendingQuestions,
  getSessionInitData: mockGetSessionInitData,
  answerQuestion: mockAnswerQuestion,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  respondToPlanApproval: mockRespondToPlanApproval,
}));

// Import the route after mocking
import session from "./session.js";

// Mount on a test app
const app = new Hono();
app.route("/session", session);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

function jsonRequest(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// Restore the real session-manager when this suite finishes so other test
// files (e.g. services/session-manager.test.ts) see the real module.
afterAll(() => {
  mock.module("../services/session-manager.js", () => realSessionManagerSnapshot);
});

describe("session routes", () => {
  beforeEach(() => {
    mockCreateSession.mockClear();
    mockGetSession.mockClear();
    mockListSessions.mockClear();
    mockGetSessionMessages.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockDeleteSession.mockClear();
    mockGetPendingQuestions.mockClear();
    mockAnswerQuestion.mockClear();
    mockRespondToPlanApproval.mockClear();
  });

  // --- POST /session/create ---
  describe("POST /session/create", () => {
    test("creates a session and returns 201", async () => {
      const res = await jsonRequest("POST", "/session/create", { title: "Test" });
      expect(res.status).toBe(201);
      const data = await jsonBody(res);
      expect(data.sessionId).toBe("s-1");
      expect(data.title).toBe("Test");
    });

    test("creates a session with no body", async () => {
      const res = await jsonRequest("POST", "/session/create");
      expect(res.status).toBe(201);
    });
  });

  // --- GET /session/list ---
  describe("GET /session/list", () => {
    test("returns session list", async () => {
      const res = await app.request("/session/list");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe("s-1");
    });
  });

  // --- GET /session/:id ---
  describe("GET /session/:id", () => {
    test("returns session details", async () => {
      const res = await app.request("/session/s-1");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.id).toBe("s-1");
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown");
      expect(res.status).toBe(404);
    });
  });

  // --- GET /session/:id/messages ---
  describe("GET /session/:id/messages", () => {
    test("returns messages for existing session", async () => {
      const res = await app.request("/session/s-1/messages");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.messages).toHaveLength(1);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/messages");
      expect(res.status).toBe(404);
    });
  });

  // --- POST /session/:id/prompt ---
  describe("POST /session/:id/prompt", () => {
    test("returns 202 with valid prompt", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello Claude",
      });
      expect(res.status).toBe(202);
      const data = await jsonBody(res);
      expect(data.status).toBe("processing");
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/prompt", {
        prompt: "Hello",
      });
      expect(res.status).toBe(404);
    });

    test("returns 400 when prompt is missing", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {});
      expect(res.status).toBe(400);
    });

    test("passes effort and permissionMode to sendPrompt", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        effort: "xhigh",
        permissionMode: "auto",
        model: "opus",
      });
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
      const callArgs = mockSendPrompt.mock.calls[0];
      expect(callArgs[0]).toBe("s-1");
      expect(callArgs[1]).toBe("test");
      expect(callArgs[2]).toEqual({
        model: "opus",
        attachments: undefined,
        effort: "xhigh",
        permissionMode: "auto",
      });
    });

    test("validates effort level - rejects invalid values", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        effort: "invalid_level",
      });
      // Invalid effort should be passed as undefined
      const callArgs = mockSendPrompt.mock.calls[0];
      expect(callArgs[2].effort).toBeUndefined();
    });

    test("validates permissionMode - rejects invalid values", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        permissionMode: "hacker_mode",
      });
      // Invalid permissionMode should be passed as undefined
      const callArgs = mockSendPrompt.mock.calls[0];
      expect(callArgs[2].permissionMode).toBeUndefined();
    });

    test("accepts all valid effort levels", async () => {
      for (const level of ["low", "medium", "high", "xhigh", "max"]) {
        mockSendPrompt.mockClear();
        await jsonRequest("POST", "/session/s-1/prompt", {
          prompt: "test",
          effort: level,
        });
        const callArgs = mockSendPrompt.mock.calls[0];
        expect(callArgs[2].effort).toBe(level);
      }
    });

    test("accepts all valid permission modes", async () => {
      for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]) {
        mockSendPrompt.mockClear();
        await jsonRequest("POST", "/session/s-1/prompt", {
          prompt: "test",
          permissionMode: mode,
        });
        const callArgs = mockSendPrompt.mock.calls[0];
        expect(callArgs[2].permissionMode).toBe(mode);
      }
    });
  });

  // --- POST /session/:id/abort ---
  describe("POST /session/:id/abort", () => {
    test("returns aborted status", async () => {
      const res = await jsonRequest("POST", "/session/s-1/abort");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("aborted");
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/abort");
      expect(res.status).toBe(404);
    });
  });

  // --- DELETE /session/:id ---
  describe("DELETE /session/:id", () => {
    test("returns deleted status", async () => {
      const res = await jsonRequest("DELETE", "/session/s-1");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("deleted");
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("DELETE", "/session/s-unknown");
      expect(res.status).toBe(404);
    });
  });

  // --- GET /session/:id/questions ---
  describe("GET /session/:id/questions", () => {
    test("returns questions for session", async () => {
      const res = await app.request("/session/s-1/questions");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.questions).toEqual([]);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/questions");
      expect(res.status).toBe(404);
    });
  });

  // --- GET /session/:id/init ---
  describe("GET /session/:id/init", () => {
    test("returns init data for session", async () => {
      const res = await app.request("/session/s-1/init");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.initData).toBeDefined();
      expect(data.initData.mcpServers).toEqual([]);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/init");
      expect(res.status).toBe(404);
    });
  });

  // --- POST /session/:id/questions/:questionId/answer ---
  describe("POST /session/:id/questions/:questionId/answer", () => {
    test("answers a question and returns 200", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-1",
          sessionId: "s-1",
          questions: [
            {
              question: "Pick a color",
              header: "Color",
              options: [{ label: "red" }, { label: "blue" }],
            },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-1/answer",
        { answers: [["blue"]] },
      );
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("answered");

      expect(mockAnswerQuestion).toHaveBeenCalledTimes(1);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[0]).toBe("q-1");
      expect(callArgs[1]).toEqual({ "Pick a color": "blue" });
    });

    test("joins multiple selected answers with comma", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-2",
          sessionId: "s-1",
          questions: [
            {
              question: "Pick languages",
              header: "Languages",
              options: [{ label: "ts" }, { label: "py" }, { label: "go" }],
            },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-2/answer",
        { answers: [["ts", "py"]] },
      );
      expect(res.status).toBe(200);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[1]).toEqual({ "Pick languages": "ts, py" });
    });

    test("maps answers to multiple questions in order", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-3",
          sessionId: "s-1",
          questions: [
            { question: "First?", header: "F", options: [{ label: "a" }] },
            { question: "Second?", header: "S", options: [{ label: "b" }] },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-3/answer",
        { answers: [["a"], ["b"]] },
      );
      expect(res.status).toBe(200);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[1]).toEqual({ "First?": "a", "Second?": "b" });
    });

    test("handles missing answer slots as empty strings", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-4",
          sessionId: "s-1",
          questions: [
            { question: "Q1?", header: "1", options: [{ label: "a" }] },
            { question: "Q2?", header: "2", options: [{ label: "b" }] },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-4/answer",
        { answers: [["a"]] }, // only one answer for two questions
      );
      expect(res.status).toBe(200);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[1]).toEqual({ "Q1?": "a", "Q2?": "" });
    });

    test("returns 400 when answers is missing", async () => {
      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-1/answer",
        {},
      );
      expect(res.status).toBe(400);
    });

    test("returns 400 when answers is not an array", async () => {
      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-1/answer",
        { answers: "not-an-array" },
      );
      expect(res.status).toBe(400);
    });

    test("returns 404 when the pending question does not exist", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => []);
      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-missing/answer",
        { answers: [["x"]] },
      );
      expect(res.status).toBe(404);
    });

    test("returns 404 when answerQuestion reports the question is gone", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-5",
          sessionId: "s-1",
          questions: [
            { question: "Stale?", header: "S", options: [{ label: "x" }] },
          ],
        },
      ]);
      mockAnswerQuestion.mockImplementationOnce(() => false);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-5/answer",
        { answers: [["x"]] },
      );
      expect(res.status).toBe(404);
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest(
        "POST",
        "/session/s-unknown/questions/q-1/answer",
        { answers: [["x"]] },
      );
      expect(res.status).toBe(404);
    });

    test("returns 500 when JSON body parsing throws", async () => {
      const res = await app.request("/session/s-1/questions/q-1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      });
      expect(res.status).toBe(500);
    });
  });

  // --- Error paths (500 branches) ---
  describe("error paths", () => {
    test("POST /session/create returns 500 when createSession throws", async () => {
      mockCreateSession.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      const res = await jsonRequest("POST", "/session/create", { title: "x" });
      expect(res.status).toBe(500);
      const data = await jsonBody(res);
      expect(data.error).toBe("boom");
    });

    test("POST /session/:id/prompt returns 500 when JSON body is invalid", async () => {
      const res = await app.request("/session/s-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      });
      expect(res.status).toBe(500);
    });

    test("POST /session/:id/plan-approvals/:approvalId/respond returns 500 on bad JSON", async () => {
      const res = await app.request("/session/s-1/plan-approvals/a-1/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      });
      expect(res.status).toBe(500);
    });
  });

  // --- POST /session/:id/plan-approvals/:approvalId/respond ---
  describe("POST /session/:id/plan-approvals/:approvalId/respond", () => {
    test("returns approved status", async () => {
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: true,
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("approved");
    });

    test("returns rejected status with feedback", async () => {
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: false,
        feedback: "needs work",
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("rejected");
    });

    test("returns 400 when approved is not boolean", async () => {
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: "yes",
      });
      expect(res.status).toBe(400);
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/plan-approvals/a-1/respond", {
        approved: true,
      });
      expect(res.status).toBe(404);
    });
  });

  // --- GET /session/:id/plan-approvals ---
  describe("GET /session/:id/plan-approvals", () => {
    test("returns approvals for session", async () => {
      const res = await app.request("/session/s-1/plan-approvals");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.approvals).toEqual([]);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/plan-approvals");
      expect(res.status).toBe(404);
    });
  });
});
