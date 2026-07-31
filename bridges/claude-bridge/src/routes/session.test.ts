import { afterAll, describe, expect, test, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import { TaskRegistry } from "@orkestrator/protocol/task-list";

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
const mockCreateOrRecoverSession = mock(async (
  title?: string,
  _clientSessionKey?: string,
) => ({
  id: "s-1",
  title: title ?? "Test",
  status: "idle" as const,
  createdAt: new Date("2026-01-01"),
  lastActivity: new Date("2026-01-01"),
}));

// A session that has run task tools, for the task-list endpoint. The registry
// is the real one: the endpoint's whole job is to serve what it holds.
const sessionTaskRegistry = new TaskRegistry();
sessionTaskRegistry.apply(
  "TaskCreate",
  { subject: "Rehydrated task" },
  "Task #1 created successfully: Rehydrated task",
);

const mockGetSession = mock((id: string) =>
  id === "s-1" || id === "s-tasks"
    ? {
        id,
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        taskRegistry: id === "s-tasks" ? sessionTaskRegistry : undefined,
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
const successfulPromptStart = async (...args: SendPromptParams) => {
  args[3]?.onQueryStarted?.();
};
const mockSendPrompt = mock(successfulPromptStart);
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
const mockDismissQuestion = mock(() => true);
const mockGetPendingPlanApprovals = mock(() => []);
const mockGetSessionActivity = mock<
  typeof realSessionManager.getSessionActivity
>(async (id: string) => (id === "s-1" ? "working" : "missing"));
const mockRespondToPlanApproval = mock(() => true);
const mockSetSessionPreferences = mock(
  async (_id: string, preferences: { planMode?: boolean }) => preferences,
);
const mockClearPromptSuggestion = mock((id: string) => id === "s-1");
const mockGetPromptDispatchState = mock<
  typeof realSessionManager.getPromptDispatchState
>(() => "new");
const mockClaimPromptDispatch = mock<
  typeof realSessionManager.claimPromptDispatch
>(async (_sessionId, _requestId, startDispatch) => {
  const dispatch = startDispatch();
  await dispatch.started;
  return "claimed";
});
const mockReconcilePersistedSessions = mock(async () => {});
const mockEnsurePersistedSession = mock(async (id: string) => mockGetSession(id));
const mockHydratePersistedSessionMessages = mock(async () => mockGetSessionMessages());
const mockDeleteSessionDurably = mock(async (id: string) => mockDeleteSession(id));
const mockRenameSessionDurably = mock(async (id: string) => id === "s-1");
const mockForkPersistedSession = mock(async () => ({
  id: "session-fork",
  title: "Test (fork)",
}));
const mockRewindSessionFiles = mock(
  async (..._args: Parameters<typeof realSessionManager.rewindSessionFiles>): Promise<unknown> => ({
    canRewind: true,
    filesChanged: [],
  }),
);
const mockStopBackgroundTask = mock(
  async (
    ..._args: Parameters<typeof realSessionManager.stopBackgroundTask>
  ): Promise<Awaited<ReturnType<typeof realSessionManager.stopBackgroundTask>>> => ({ ok: true }),
);

/**
 * A refusal shaped the way the session manager shapes them: a plain `code`
 * property the route maps to a status. Deliberately not an instance of the real
 * `SessionOperationError` — the route reaches the manager through the module
 * mock installed below, so it must not depend on class identity surviving that
 * boundary.
 */
function refusal(code: "not_found" | "conflict" | "invalid", message: string): Error {
  return Object.assign(new Error(message), { code });
}

mock.module("../services/session-manager.js", () => ({
  createSession: mockCreateSession,
  createOrRecoverSession: mockCreateOrRecoverSession,
  getSession: mockGetSession,
  listSessions: mockListSessions,
  getSessionMessages: mockGetSessionMessages,
  sendPrompt: mockSendPrompt,
  abortSession: mockAbortSession,
  deleteSession: mockDeleteSession,
  reconcilePersistedSessions: mockReconcilePersistedSessions,
  ensurePersistedSession: mockEnsurePersistedSession,
  hydratePersistedSessionMessages: mockHydratePersistedSessionMessages,
  deleteSessionDurably: mockDeleteSessionDurably,
  renameSessionDurably: mockRenameSessionDurably,
  forkPersistedSession: mockForkPersistedSession,
  rewindSessionFiles: mockRewindSessionFiles,
  stopBackgroundTask: mockStopBackgroundTask,
  getPendingQuestions: mockGetPendingQuestions,
  getSessionActivity: mockGetSessionActivity,
  getSessionInitData: mockGetSessionInitData,
  answerQuestion: mockAnswerQuestion,
  dismissQuestion: mockDismissQuestion,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  respondToPlanApproval: mockRespondToPlanApproval,
  setSessionPreferences: mockSetSessionPreferences,
  clearPromptSuggestion: mockClearPromptSuggestion,
  claimPromptDispatch: mockClaimPromptDispatch,
  getPromptDispatchState: mockGetPromptDispatchState,
}));

/**
 * Restore every persistence seam to its inert default.
 *
 * These are the mocks the branch declared and then never invoked, so each
 * suite below drives them directly; without a reset a `mockRejectedValueOnce`
 * left armed by one test would surface as an unrelated 500 in the next.
 */
function resetPersistenceMocks(): void {
  mockReconcilePersistedSessions.mockReset();
  mockReconcilePersistedSessions.mockImplementation(async () => {});
  mockHydratePersistedSessionMessages.mockReset();
  mockHydratePersistedSessionMessages.mockImplementation(async () => mockGetSessionMessages());
  mockRenameSessionDurably.mockReset();
  mockRenameSessionDurably.mockImplementation(async (id: string) => id === "s-1");
  mockForkPersistedSession.mockReset();
  mockForkPersistedSession.mockImplementation(async () => ({
    id: "session-fork",
    title: "Test (fork)",
  }));
  mockRewindSessionFiles.mockReset();
  mockRewindSessionFiles.mockImplementation(async () => ({
    canRewind: true,
    filesChanged: [],
  }));
  mockStopBackgroundTask.mockReset();
  mockStopBackgroundTask.mockImplementation(async () => ({ ok: true }));
  mockEnsurePersistedSession.mockReset();
  mockEnsurePersistedSession.mockImplementation(async (id: string) => mockGetSession(id));
}

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
    mockCreateOrRecoverSession.mockReset();
    mockCreateOrRecoverSession.mockImplementation(async (title?: string) => ({
      id: "s-1",
      title: title ?? "Test",
      status: "idle" as const,
      createdAt: new Date("2026-01-01"),
      lastActivity: new Date("2026-01-01"),
    }));
    mockGetSession.mockClear();
    mockListSessions.mockClear();
    mockGetSessionMessages.mockClear();
    mockSendPrompt.mockReset();
    mockSendPrompt.mockImplementation(successfulPromptStart);
    mockAbortSession.mockClear();
    mockDeleteSession.mockClear();
    mockReconcilePersistedSessions.mockClear();
    mockEnsurePersistedSession.mockClear();
    mockHydratePersistedSessionMessages.mockClear();
    mockDeleteSessionDurably.mockClear();
    mockGetPendingQuestions.mockClear();
    mockAnswerQuestion.mockClear();
    mockDismissQuestion.mockClear();
    mockGetPendingPlanApprovals.mockClear();
    mockGetSessionActivity.mockReset();
    mockGetSessionActivity.mockImplementation(async (id: string) =>
      id === "s-1" ? "working" : "missing",
    );
    mockRespondToPlanApproval.mockClear();
    mockClaimPromptDispatch.mockReset();
    mockClaimPromptDispatch.mockImplementation(async (
      _sessionId,
      _requestId,
      startDispatch,
    ) => {
      const dispatch = startDispatch();
      await dispatch.started;
      return "claimed";
    });
    mockSetSessionPreferences.mockClear();
    mockSetSessionPreferences.mockImplementation(
      async (_id: string, preferences: { planMode?: boolean }) => preferences,
    );
    mockClearPromptSuggestion.mockClear();
    mockClearPromptSuggestion.mockImplementation((id: string) => id === "s-1");
    mockGetPromptDispatchState.mockReset();
    mockGetPromptDispatchState.mockImplementation(() => "new");
    resetPersistenceMocks();
  });

  // --- POST /session/create ---
  describe("POST /session/create", () => {
    test("creates a session and returns 201", async () => {
      const res = await jsonRequest("POST", "/session/create", { title: "Test" });
      expect(res.status).toBe(201);
      const data = await jsonBody(res);
      expect(data.sessionId).toBe("s-1");
      expect(data.title).toBe("Test");
      expect(mockCreateOrRecoverSession).toHaveBeenCalledWith("Test", undefined);
    });

    test("passes the stable client key through durable recovery", async () => {
      const res = await jsonRequest("POST", "/session/create", {
        title: "Startup",
        clientSessionKey: "env-env-1:startup-agent",
      });

      expect(res.status).toBe(201);
      expect(mockCreateOrRecoverSession).toHaveBeenCalledWith(
        "Startup",
        "env-env-1:startup-agent",
      );
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
      expect(Object.hasOwn(data, "planMode")).toBe(false);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown");
      expect(res.status).toBe(404);
    });

    test("maps a materialization refusal instead of returning a bodiless 500", async () => {
      mockGetSession.mockImplementationOnce(() => undefined);
      mockEnsurePersistedSession.mockImplementation(async () => {
        throw refusal("conflict", "Session store is locked");
      });

      const res = await app.request("/session/s-1");
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "Session store is locked" });
    });

    test("still reports an unclassified materialization fault as a 500 with a body", async () => {
      mockGetSession.mockImplementationOnce(() => undefined);
      mockEnsurePersistedSession.mockImplementation(async () => {
        throw new Error("claude home unreadable");
      });

      const res = await app.request("/session/s-1");
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "claude home unreadable" });
    });
  });

  describe("PUT /session/:id/preferences", () => {
    test("persists plan mode in the authoritative session", async () => {
      const res = await jsonRequest("PUT", "/session/s-1/preferences", { planMode: true });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ planMode: true });
      expect(mockSetSessionPreferences).toHaveBeenCalledWith("s-1", { planMode: true });
    });

    test.each([
      [null],
      [[]],
      ["plan"],
      [true],
      [1],
    ])("rejects a non-object request body: %p", async (body) => {
      const res = await jsonRequest("PUT", "/session/s-1/preferences", body);

      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({
        error: "Request body must be a JSON object",
      });
      expect(mockSetSessionPreferences).not.toHaveBeenCalled();
    });

    test("rejects a non-boolean plan mode", async () => {
      const res = await jsonRequest("PUT", "/session/s-1/preferences", { planMode: "yes" });

      expect(res.status).toBe(400);
      expect(mockSetSessionPreferences).not.toHaveBeenCalled();
    });

    test.each([
      [{}, "planMode is required"],
      [{ planMode: true, future: true }, "Unexpected session preference field: future"],
    ])("rejects incomplete or unknown preference fields", async (body, message) => {
      const res = await jsonRequest("PUT", "/session/s-1/preferences", body);

      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: message });
      expect(mockSetSessionPreferences).not.toHaveBeenCalled();
    });

    test("rejects malformed JSON without calling the preference store", async () => {
      const res = await app.request("/session/s-1/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });

      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({
        error: "Request body must be valid JSON",
      });
      expect(mockSetSessionPreferences).not.toHaveBeenCalled();
    });

    test("does not acknowledge a preference that failed to persist", async () => {
      mockSetSessionPreferences.mockRejectedValueOnce(new Error("disk full"));

      const res = await jsonRequest("PUT", "/session/s-1/preferences", {
        planMode: true,
      });

      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "disk full" });
    });

    test("maps an unknown session preference update to 404", async () => {
      mockSetSessionPreferences.mockRejectedValueOnce(
        refusal("not_found", "Session not found"),
      );

      const res = await jsonRequest("PUT", "/session/missing/preferences", {
        planMode: true,
      });

      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session not found" });
    });
  });

  describe("DELETE /session/:id/prompt-suggestion", () => {
    test("dismisses the persisted suggestion", async () => {
      const res = await jsonRequest("DELETE", "/session/s-1/prompt-suggestion");

      expect(res.status).toBe(204);
      expect(mockClearPromptSuggestion).toHaveBeenCalledWith("s-1");
    });

    test("returns 404 for an unknown session", async () => {
      const res = await jsonRequest("DELETE", "/session/s-unknown/prompt-suggestion");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /session/:id/structured-output", () => {
    test("serves the latest result and isolates mismatched request ids", async () => {
      mockGetSession.mockImplementationOnce(() => ({
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        structuredOutputRequestId: "structured-1",
        structuredOutput: {
          ok: true as const,
          provider: "claude" as const,
          requestId: "structured-1",
          value: { summary: "done" },
        },
      }));
      const latest = await app.request("/session/s-1/structured-output");
      expect(await jsonBody(latest)).toMatchObject({
        requestId: "structured-1",
        structuredOutput: { ok: true, value: { summary: "done" } },
      });

      mockGetSession.mockImplementationOnce(() => ({
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        structuredOutputRequestId: "structured-1",
      }));
      const mismatch = await app.request(
        "/session/s-1/structured-output?requestId=structured-2",
      );
      expect(await jsonBody(mismatch)).toEqual({
        structuredOutput: null,
        requestId: "structured-2",
      });
      expect((await app.request("/session/s-unknown/structured-output")).status).toBe(404);
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

    test("maps a materialization refusal instead of returning a bodiless 500", async () => {
      mockGetSession.mockImplementationOnce(() => undefined);
      mockEnsurePersistedSession.mockImplementation(async () => {
        throw refusal("not_found", "Session has not been materialized");
      });

      const res = await app.request("/session/s-1/messages");
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session has not been materialized" });
      expect(mockHydratePersistedSessionMessages).not.toHaveBeenCalled();
    });
  });

  // --- GET /session/:id/tasks ---
  describe("GET /session/:id/tasks", () => {
    test("serves the session's authoritative task list", async () => {
      const res = await app.request("/session/s-tasks/tasks");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        items: [{ id: "1", subject: "Rehydrated task", status: "pending" }],
        complete: true,
      });
    });

    test("reports an empty, complete list for a session that has run no task tools", async () => {
      const res = await app.request("/session/s-1/tasks");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ items: [], complete: true });
    });

    test("hydrates a persisted session before serving its reconstructed tasks", async () => {
      const persistedRegistry = new TaskRegistry();
      const persisted = {
        id: "s-persisted",
        title: "From disk",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        persistedMessagesLoaded: false,
        taskRegistry: undefined as TaskRegistry | undefined,
      };
      mockEnsurePersistedSession.mockImplementationOnce(async () => persisted);
      mockHydratePersistedSessionMessages.mockImplementationOnce(async () => {
        persistedRegistry.apply(
          "TaskCreate",
          { subject: "Recovered task" },
          "Task #1 created successfully: Recovered task",
        );
        persisted.taskRegistry = persistedRegistry;
        persisted.persistedMessagesLoaded = true;
        return [];
      });

      const res = await app.request("/session/s-persisted/tasks");
      expect(res.status).toBe(200);
      expect(mockHydratePersistedSessionMessages).toHaveBeenCalledWith("s-persisted");
      expect(await jsonBody(res)).toEqual({
        items: [{ id: "1", subject: "Recovered task", status: "pending" }],
        complete: true,
      });
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/tasks");
      expect(res.status).toBe(404);
    });
  });

  // --- POST /session/:id/prompt ---
  describe("POST /session/:id/prompt", () => {
    test("maps a materialization refusal instead of returning a bodiless 500", async () => {
      mockGetSession.mockImplementationOnce(() => undefined);
      mockEnsurePersistedSession.mockImplementation(async () => {
        throw refusal("conflict", "Session is being deleted");
      });

      const res = await jsonRequest("POST", "/session/s-1/prompt", { prompt: "Hello" });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "Session is being deleted" });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("returns 202 with valid prompt", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello Claude",
      });
      expect(res.status).toBe(202);
      const data = await jsonBody(res);
      expect(data.status).toBe("processing");
    });

    test("durably claims a stable request id before dispatch", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(202);
      expect(mockClaimPromptDispatch).toHaveBeenCalledWith(
        "s-1",
        "initial-prompt:env-1:tab-1",
        expect.any(Function),
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "Launch once",
        expect.objectContaining({
          requestId: "initial-prompt:env-1:tab-1",
        }),
        expect.objectContaining({
          onQueryStarted: expect.any(Function),
        }),
      );
    });

    test("acknowledges a duplicate stable request id without dispatching it again", async () => {
      mockClaimPromptDispatch.mockResolvedValueOnce("duplicate");

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        status: "already-processed",
        requestId: "initial-prompt:env-1:tab-1",
        duplicate: true,
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("routes a running session's same-id retry through the duplicate claim", async () => {
      mockGetSession.mockImplementationOnce(() => ({
        id: "s-1",
        title: "Test",
        status: "running" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      }));
      mockClaimPromptDispatch.mockResolvedValueOnce("duplicate");

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        status: "already-processed",
        requestId: "initial-prompt:env-1:tab-1",
        duplicate: true,
      });
      expect(mockClaimPromptDispatch).toHaveBeenCalledWith(
        "s-1",
        "initial-prompt:env-1:tab-1",
        expect.any(Function),
      );
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("does not dispatch when the durable request-id claim fails", async () => {
      mockClaimPromptDispatch.mockRejectedValueOnce(new Error("journal unavailable"));

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "journal unavailable" });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("does not acknowledge a claimed prompt whose SDK startup barrier rejects", async () => {
      mockSendPrompt.mockRejectedValueOnce(new Error("attachment unreadable"));

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch with attachment",
        requestId: "initial-prompt:env-1:tab-startup-failure",
      });

      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "attachment unreadable" });
      expect(mockClaimPromptDispatch).toHaveBeenCalledTimes(1);
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    test("maps a request-id reservation conflict to 409", async () => {
      mockClaimPromptDispatch.mockRejectedValueOnce(
        refusal("conflict", "Session is already processing a prompt"),
      );

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({
        error: "Session is already processing a prompt",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("forwards a structured schema and stable request id", async () => {
      const outputSchema = { type: "object", properties: { summary: { type: "string" } } };
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review",
        outputSchema,
        requestId: "structured-1",
      });

      expect(res.status).toBe(202);
      expect(await jsonBody(res)).toMatchObject({
        status: "processing",
        requestId: "structured-1",
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "Review",
        expect.objectContaining({ outputSchema, requestId: "structured-1" }),
      );
    });

    test("rejects malformed schemas and deduplicates a running structured request", async () => {
      const malformed = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review",
        outputSchema: "not a schema",
        requestId: "structured-1",
      });
      expect(malformed.status).toBe(400);

      mockGetPromptDispatchState.mockReturnValueOnce("processing");
      const duplicate = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review",
        outputSchema: { type: "object" },
        requestId: "structured-1",
      });
      expect(duplicate.status).toBe(202);
      expect(await jsonBody(duplicate)).toMatchObject({
        status: "processing",
        duplicate: true,
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("rejects oversized request ids and reports completed duplicates", async () => {
      const tooLong = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review",
        outputSchema: { type: "object" },
        requestId: "x".repeat(201),
      });
      expect(tooLong.status).toBe(400);

      mockGetPromptDispatchState.mockReturnValueOnce("already-processed");
      const completed = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review",
        outputSchema: { type: "object" },
        requestId: "complete-1",
      });
      expect(completed.status).toBe(200);
      expect(await jsonBody(completed)).toEqual({
        status: "already-processed",
        requestId: "complete-1",
        duplicate: true,
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    /**
     * The destructive case. A plain prompt runs shell commands and edits files,
     * so a retry after a lost HTTP response must attach to the turn already
     * running instead of starting a second one. Dedup used to be gated on
     * `outputSchema`, which left every ordinary prompt unprotected.
     */
    test("deduplicates an unstructured prompt carrying a repeated request id", async () => {
      mockGetPromptDispatchState.mockReturnValueOnce("processing");
      const duplicate = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "rm the temp dir",
        requestId: "plain-1",
      });

      expect(duplicate.status).toBe(202);
      expect(await jsonBody(duplicate)).toEqual({
        status: "processing",
        requestId: "plain-1",
        duplicate: true,
      });
      expect(mockGetPromptDispatchState).toHaveBeenCalledWith("s-1", "plain-1");
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("replays the original outcome for an unstructured prompt that already finished", async () => {
      mockGetPromptDispatchState.mockReturnValueOnce("already-processed");
      const duplicate = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "rm the temp dir",
        requestId: "plain-2",
      });

      expect(duplicate.status).toBe(200);
      expect(await jsonBody(duplicate)).toEqual({
        status: "already-processed",
        requestId: "plain-2",
        duplicate: true,
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("forwards the client request id on an unstructured prompt so the bridge can dedup it", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello",
        requestId: "plain-3",
      });

      expect(res.status).toBe(202);
      expect(await jsonBody(res)).toMatchObject({ requestId: "plain-3" });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "Hello",
        expect.objectContaining({ requestId: "plain-3" }),
        expect.objectContaining({ onQueryStarted: expect.any(Function) }),
      );
    });

    /**
     * Ordered before the `running` conflict: the retry *is* the running turn, so
     * answering 409 "already processing a prompt" would tell the client its own
     * request collided with somebody else's.
     */
    test("answers a duplicate rather than a conflict while its own turn runs", async () => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "running" as const,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
              taskRegistry: undefined,
            }
          : undefined,
      );
      mockGetPromptDispatchState.mockReturnValueOnce("processing");

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello",
        requestId: "plain-4",
      });

      expect(res.status).toBe(202);
      expect(await jsonBody(res)).toMatchObject({ duplicate: true });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("accepts the request even when background processing later rejects", async () => {
      mockSendPrompt.mockImplementationOnce(async () => {
        throw new Error("provider disconnected");
      });
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello",
      });
      expect(res.status).toBe(202);
      await Promise.resolve();
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
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

    test("accepts an image-only prompt", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "",
        attachments: [{
          type: "image",
          path: "",
          filename: "screen.png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        }],
      });

      expect(res.status).toBe(202);
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "",
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ filename: "screen.png" }),
          ]),
        }),
      );
    });

    test("rejects malformed attachments", async () => {
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "hello",
        attachments: [{ type: "secret", path: 42 }],
      });

      expect(res.status).toBe(400);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("rejects malformed image-only data and empty attachment sources", async () => {
      const malformedData = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "",
        attachments: [{
          type: "image",
          path: "",
          dataUrl: "not base64",
        }],
      });
      expect(malformedData.status).toBe(400);

      const emptySource = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "",
        attachments: [{ type: "image", path: "" }],
      });
      expect(emptySource.status).toBe(400);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("rejects inline image data over the 8MB attachment limit", async () => {
      const oversizedDataUrl = `data:image/png;base64,${
        Buffer.alloc((8 * 1024 * 1024) + 1, 1).toString("base64")
      }`;
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "describe",
        attachments: [{
          type: "image",
          path: "",
          dataUrl: oversizedDataUrl,
        }],
      });

      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({
        error: "Attachments are invalid; inline images must be valid base64 and no larger than 8MB",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("accepts inline image data exactly at the 8MB attachment limit", async () => {
      const maximumDataUrl = `data:image/png;base64,${
        Buffer.alloc(8 * 1024 * 1024, 1).toString("base64")
      }`;
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "describe",
        attachments: [{
          type: "image",
          path: "",
          dataUrl: maximumDataUrl,
        }],
      });

      expect(response.status).toBe(202);
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "describe",
        expect.objectContaining({
          attachments: [expect.objectContaining({ dataUrl: maximumDataUrl })],
        }),
      );
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

      // The key set, asserted first. Bun's `toEqual` treats a missing key and
      // an `undefined` one as equal, so a `toEqual` on this object alone cannot
      // notice `agent`, `includeLocalSettings` or `promptSuggestions` dropping
      // out of the forwarded options entirely.
      expect(Object.keys(callArgs[2]!).sort()).toEqual([
        "agent",
        "attachments",
        "effort",
        "fastMode",
        "includeLocalSettings",
        "model",
        "outputSchema",
        "permissionMode",
        "promptSuggestions",
        "requestId",
      ]);
      expect(callArgs[2]).toEqual({
        model: "opus",
        attachments: undefined,
        effort: "xhigh",
        permissionMode: "auto",
        fastMode: undefined,
        agent: undefined,
        includeLocalSettings: undefined,
        promptSuggestions: undefined,
        outputSchema: undefined,
        requestId: undefined,
      });
    });

    test("forwards the agent, local-settings and suggestion options", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        agent: "  reviewer  ",
        includeLocalSettings: true,
        promptSuggestions: true,
        fastMode: true,
      });

      const options = mockSendPrompt.mock.calls[0]![2]!;
      expect(options.agent).toBe("reviewer");
      expect(options.includeLocalSettings).toBe(true);
      expect(options.promptSuggestions).toBe(true);
      expect(options.fastMode).toBe(true);
    });

    test("drops a blank agent and non-boolean toggles", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        agent: "   ",
        includeLocalSettings: "yes",
        promptSuggestions: 1,
        fastMode: "true",
      });

      const options = mockSendPrompt.mock.calls[0]![2]!;
      expect(options.agent).toBeUndefined();
      expect(options.includeLocalSettings).toBeUndefined();
      expect(options.promptSuggestions).toBeUndefined();
      expect(options.fastMode).toBeUndefined();
    });

    test("returns 409 while a file rewind is restoring the working tree", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        rewindInProgress: true,
      } as ReturnType<typeof mockGetSession>);

      const res = await jsonRequest("POST", "/session/s-1/prompt", { prompt: "test" });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({
        error: "Session is restoring files from a checkpoint",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
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

    test("returns not_running when the session has no active query", async () => {
      mockAbortSession.mockReturnValueOnce(false);
      const res = await jsonRequest("POST", "/session/s-1/abort");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ status: "not_running" });
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

    test("maps concurrent deletion and unexpected storage failures", async () => {
      mockDeleteSessionDurably.mockImplementationOnce(async () => {
        throw refusal("conflict", "Session deletion is already in progress");
      });
      const conflict = await jsonRequest("DELETE", "/session/s-1");
      expect(conflict.status).toBe(409);
      expect(await jsonBody(conflict)).toEqual({
        error: "Session deletion is already in progress",
      });

      mockDeleteSessionDurably.mockImplementationOnce(async () => {
        throw new Error("disk busy");
      });
      const failure = await jsonRequest("DELETE", "/session/s-1");
      expect(failure.status).toBe(500);
      expect(await jsonBody(failure)).toEqual({ error: "disk busy" });
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

  // --- GET /session/:id/activity ---
  describe("GET /session/:id/activity", () => {
    test("returns the session's activity state", async () => {
      const res = await app.request("/session/s-1/activity");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ activity: "working" });
      expect(mockGetSessionActivity).toHaveBeenCalledWith("s-1");
    });

    test("returns 200 with activity 'missing' for an unknown session", async () => {
      const res = await app.request("/session/s-unknown/activity");

      // Deliberately not 404. The backend reads a 404 from this path as "the
      // bridge is too old to have this route" and fails the environment, while
      // an in-band "missing" only unmaps this one session.
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ activity: "missing" });
    });

    test("does not resolve, materialize or hydrate the session", async () => {
      await app.request("/session/s-1/activity");

      // Every one of these is a liveness side effect, and the backend polls
      // this route every two seconds for every session it knows about.
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockEnsurePersistedSession).not.toHaveBeenCalled();
      expect(mockHydratePersistedSessionMessages).not.toHaveBeenCalled();
    });

    test("is not shadowed by GET /session/:id", async () => {
      mockGetSessionActivity.mockImplementation(async () => "waiting");

      const res = await app.request("/session/s-1/activity");
      expect(await jsonBody(res)).toEqual({ activity: "waiting" });
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

    test("serializes multi-select answers unambiguously when labels contain commas", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-2",
          sessionId: "s-1",
          questions: [
            {
              question: "Pick languages",
              header: "Languages",
              options: [{ label: "TypeScript, strict" }, { label: "Python" }],
              multiSelect: true,
            },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-2/answer",
        { answers: [["TypeScript, strict", "Python"]] },
      );
      expect(res.status).toBe(200);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[1]).toEqual({
        "Pick languages": JSON.stringify(["TypeScript, strict", "Python"]),
      });
    });

    test("preserves a single-select option plus custom answer without ambiguity", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-option-custom",
          sessionId: "s-1",
          questions: [
            {
              question: "Pick a color",
              header: "Color",
              options: [{ label: "Red" }],
              multiSelect: false,
            },
          ],
        },
      ]);

      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-option-custom/answer",
        { answers: [["Red", "Magenta, with sparkle 🦊"]] },
      );
      expect(res.status).toBe(200);
      expect(mockAnswerQuestion.mock.calls[0]?.[1]).toEqual({
        "Pick a color": JSON.stringify(["Red", "Magenta, with sparkle 🦊"]),
      });
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

    test("rejects missing answer slots instead of resolving a partial response", async () => {
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
      expect(res.status).toBe(400);
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
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

    test("rejects malformed nested answers without resolving the question", async () => {
      const pending = {
        id: "q-malformed",
        sessionId: "s-1",
        questions: [
          { question: "Pick?", header: "P", options: [{ label: "a" }] },
        ],
      };
      for (const answers of [
        ["not-an-array"],
        [["valid", 42]],
        [[{ label: "forged" }]],
      ]) {
        mockGetPendingQuestions.mockImplementationOnce(() => [pending]);
        const res = await jsonRequest(
          "POST",
          "/session/s-1/questions/q-malformed/answer",
          { answers },
        );
        expect(res.status).toBe(400);
      }
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    test("rejects extra question rows and bounded-answer overflows", async () => {
      const pending = {
        id: "q-bounded",
        sessionId: "s-1",
        questions: [
          { question: "Pick?", header: "P", options: [{ label: "a" }] },
        ],
      };
      const invalidAnswers = [
        [[]],
        [["a"], ["extra"]],
        [Array.from({ length: 17 }, (_, index) => `answer-${index}`)],
        [["x".repeat(16_385)]],
      ];
      for (const answers of invalidAnswers) {
        mockGetPendingQuestions.mockImplementationOnce(() => [pending]);
        const res = await jsonRequest(
          "POST",
          "/session/s-1/questions/q-bounded/answer",
          { answers },
        );
        expect(res.status).toBe(400);
      }
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    test("rejects a collectively oversized answer payload", async () => {
      const questions = Array.from({ length: 16 }, (_, index) => ({
        question: `Question ${index}?`,
        header: String(index),
        options: [],
      }));
      mockGetPendingQuestions.mockImplementationOnce(() => [{
        id: "q-oversized",
        sessionId: "s-1",
        questions,
      }]);
      const answers = questions.map(() =>
        Array.from({ length: 16 }, () => "x".repeat(1_100)));
      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-oversized/answer",
        { answers },
      );
      expect(res.status).toBe(400);
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    /**
     * 409 + `{status:"stale"}`, matching the Codex bridge's approval contract.
     * 404 would be wrong: it means "no such session", which the UI has to treat
     * as a retryable failure. A window that has closed is neither.
     */
    test("returns 409 stale when the pending question does not exist", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => []);
      const res = await jsonRequest(
        "POST",
        "/session/s-1/questions/q-missing/answer",
        { answers: [["x"]] },
      );
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
    });

    test("returns 409 stale when answerQuestion reports the question is gone", async () => {
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
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
    });

    // Still a 404: the session itself is unknown, which is a genuine error the
    // client must surface rather than silently discard.
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

  describe("DELETE /session/:id/questions/:questionId", () => {
    test("dismisses a pending question owned by the session", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [{
        id: "q-1",
        sessionId: "s-1",
        questions: [],
      }]);

      const res = await app.request("/session/s-1/questions/q-1", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(mockDismissQuestion).toHaveBeenCalledWith("q-1");
    });

    test("does not dismiss a question from another session", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => []);

      const res = await app.request("/session/s-1/questions/q-other", { method: "DELETE" });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
      expect(mockDismissQuestion).not.toHaveBeenCalled();
    });

    test("returns 404 for an unknown session", async () => {
      const res = await app.request("/session/s-unknown/questions/q-1", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mockDismissQuestion).not.toHaveBeenCalled();
    });

    test("returns 409 stale when the question resolves between snapshot and dismissal", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [{
        id: "q-1",
        sessionId: "s-1",
        questions: [],
      }]);
      mockDismissQuestion.mockImplementationOnce(() => false);

      const res = await app.request("/session/s-1/questions/q-1", { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
    });
  });

  // --- Error paths (500 branches) ---
  describe("error paths", () => {
    test("POST /session/create returns 500 when durable create throws", async () => {
      mockCreateOrRecoverSession.mockImplementationOnce(async () => {
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
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [{
        id: "a-1",
        sessionId: "s-1",
        toolUseId: "tool-1",
      }]);
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: true,
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("approved");
    });

    test("returns rejected status with feedback", async () => {
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [{
        id: "a-1",
        sessionId: "s-1",
        toolUseId: "tool-1",
      }]);
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

    test("does not allow responding to another session's approval", async () => {
      mockGetPendingPlanApprovals.mockImplementationOnce(() => []);
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-other/respond", {
        approved: true,
      });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
      expect(mockRespondToPlanApproval).not.toHaveBeenCalled();
    });

    test("returns 409 stale when the approval resolves between snapshot and response", async () => {
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [{
        id: "a-1",
        sessionId: "s-1",
      }]);
      mockRespondToPlanApproval.mockImplementationOnce(() => false);
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: true,
      });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
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

// ---------------------------------------------------------------------------
// Persisted-session routes
// ---------------------------------------------------------------------------
//
// Every handler here reaches an SDK-backed operation that can legitimately
// refuse, and each refusal has a distinct meaning to the client: 404 "there is
// nothing by that name", 409 "it exists but not in a state that permits this",
// 400 "the thing you pointed at is not addressable". Collapsing them into an
// opaque 500 is what these suites exist to prevent.

describe("persisted session routes", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSessionMessages.mockClear();
    mockListSessions.mockClear();
    mockSendPrompt.mockClear();
    resetPersistenceMocks();
  });

  // --- GET /session/list ---
  describe("GET /session/list", () => {
    test("reconciles the on-disk sessions before listing", async () => {
      const res = await app.request("/session/list");
      expect(res.status).toBe(200);
      expect(mockReconcilePersistedSessions).toHaveBeenCalledTimes(1);
    });

    test("still serves the in-memory list when reconciliation fails", async () => {
      mockReconcilePersistedSessions.mockImplementation(async () => {
        throw new Error("claude home unreadable");
      });

      const res = await app.request("/session/list");

      // Adopting on-disk sessions is an enrichment. Letting it fail the request
      // would hide the sessions the user is actually working in behind a 500.
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe("s-1");
    });
  });

  // --- GET /session/:id ---
  describe("GET /session/:id", () => {
    test("hydrates persisted lifecycle state before serving the authoritative snapshot", async () => {
      const persisted = {
        id: "s-1",
        title: "Persisted",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        persistedMessagesLoaded: false,
        backgroundTasks: undefined as
          | Record<string, {
              id: string;
              toolUseId: string;
              status: "failed";
              error: string;
            }>
          | undefined,
      };
      mockGetSession.mockImplementationOnce(
        () => persisted as ReturnType<typeof mockGetSession>,
      );
      mockHydratePersistedSessionMessages.mockImplementationOnce(async () => {
        persisted.persistedMessagesLoaded = true;
        persisted.backgroundTasks = {
          "task-restored": {
            id: "task-restored",
            toolUseId: "agent-tool-restored",
            status: "failed",
            error: "Restored failure",
          },
        };
        return [];
      });

      const response = await app.request("/session/s-1");

      expect(response.status).toBe(200);
      expect(mockHydratePersistedSessionMessages).toHaveBeenCalledWith("s-1");
      expect((await jsonBody(response)).backgroundTasks).toEqual({
        "task-restored": {
          id: "task-restored",
          toolUseId: "agent-tool-restored",
          status: "failed",
          error: "Restored failure",
        },
      });
    });

    test("reports a persisted lifecycle hydration failure with a JSON body", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Persisted",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        persistedMessagesLoaded: false,
      } as ReturnType<typeof mockGetSession>);
      mockHydratePersistedSessionMessages.mockImplementationOnce(async () => {
        throw new Error("transcript unreadable");
      });

      const response = await app.request("/session/s-1");

      expect(response.status).toBe(500);
      expect(await jsonBody(response)).toEqual({ error: "transcript unreadable" });
    });

    test("serves the authoritative background-task and rate-limit snapshot", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        backgroundTasks: {
          "task-1": {
            id: "task-1",
            toolUseId: "agent-tool-1",
            status: "failed",
            description: "Build",
            error: "Compiler failed",
            endedAt: 1_769_990_400_000,
          },
        },
        rateLimits: [{ label: "Five Hour", usedPercent: 42 }],
        rewindInProgress: true,
      } as ReturnType<typeof mockGetSession>);

      const data = await jsonBody(await app.request("/session/s-1"));

      // A tab that was unmounted while this changed rehydrates from here.
      expect(data.backgroundTasks).toEqual({
        "task-1": {
          id: "task-1",
          toolUseId: "agent-tool-1",
          status: "failed",
          description: "Build",
          error: "Compiler failed",
          endedAt: 1_769_990_400_000,
        },
      });
      expect(data.rateLimits).toEqual([{ label: "Five Hour", usedPercent: 42 }]);
      expect(data.rewindInProgress).toBe(true);
    });

    test("reports an empty task set and no rewind for a fresh session", async () => {
      const data = await jsonBody(await app.request("/session/s-1"));
      expect(data.backgroundTasks).toEqual({});
      expect(data.rewindInProgress).toBe(false);
    });
  });

  // --- GET /session/:id/messages ---
  describe("GET /session/:id/messages", () => {
    test("hydrates a session whose transcript has not been read yet", async () => {
      mockGetSession.mockReturnValueOnce(undefined as ReturnType<typeof mockGetSession>);
      mockEnsurePersistedSession.mockImplementation(async () => ({
        id: "s-persisted",
        title: "From disk",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        persistedMessagesLoaded: false,
      }) as Awaited<ReturnType<typeof mockEnsurePersistedSession>>);
      mockHydratePersistedSessionMessages.mockImplementation(async () => [
        {
          id: "u-1",
          role: "user" as const,
          content: "from the transcript",
          parts: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      ]);

      const res = await app.request("/session/s-persisted/messages");

      expect(res.status).toBe(200);
      expect(mockHydratePersistedSessionMessages).toHaveBeenCalledWith("s-persisted");
      // The in-memory getter must not be consulted for a session whose
      // transcript still lives only on disk.
      expect(mockGetSessionMessages).not.toHaveBeenCalled();
      expect((await jsonBody(res)).messages[0].content).toBe("from the transcript");
    });

    test("serves the in-memory transcript once it has been loaded", async () => {
      const res = await app.request("/session/s-1/messages");
      expect(res.status).toBe(200);
      expect(mockHydratePersistedSessionMessages).not.toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalledWith("s-1");
    });
  });

  // --- POST /session/:id/rename ---
  describe("POST /session/:id/rename", () => {
    test("renames a session and echoes the trimmed title", async () => {
      const res = await jsonRequest("POST", "/session/s-1/rename", { title: "  Renamed  " });
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ status: "renamed", title: "Renamed" });
      expect(mockRenameSessionDurably).toHaveBeenCalledWith("s-1", "Renamed");
    });

    test("returns 400 for a blank or missing title", async () => {
      expect((await jsonRequest("POST", "/session/s-1/rename", { title: "   " })).status).toBe(400);
      expect((await jsonRequest("POST", "/session/s-1/rename", {})).status).toBe(400);
      expect(mockRenameSessionDurably).not.toHaveBeenCalled();
    });

    test("returns 404 when the session does not exist", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/rename", { title: "x" });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session not found" });
    });

    test("maps a rename refusal to its status instead of a 500", async () => {
      mockRenameSessionDurably.mockImplementation(async () => {
        throw refusal("not_found", "Session has not been materialized");
      });
      const res = await jsonRequest("POST", "/session/s-1/rename", { title: "x" });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session has not been materialized" });
    });

    test("returns 500 for an unexpected rename failure", async () => {
      mockRenameSessionDurably.mockImplementation(async () => {
        throw new Error("disk full");
      });
      const res = await jsonRequest("POST", "/session/s-1/rename", { title: "x" });
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "disk full" });
    });
  });

  // --- POST /session/:id/fork ---
  describe("POST /session/:id/fork", () => {
    test("forks a session and returns 201 with the new id", async () => {
      const res = await jsonRequest("POST", "/session/s-1/fork", {
        upToMessageId: "  msg-7  ",
        title: "  Experiment  ",
      });

      expect(res.status).toBe(201);
      expect(await jsonBody(res)).toEqual({
        sessionId: "session-fork",
        title: "Test (fork)",
      });
      expect(mockForkPersistedSession).toHaveBeenCalledWith("s-1", {
        upToMessageId: "msg-7",
        title: "Experiment",
      });
    });

    test("forks the whole session when no boundary is given", async () => {
      await jsonRequest("POST", "/session/s-1/fork", {});
      expect(mockForkPersistedSession).toHaveBeenCalledWith("s-1", {
        upToMessageId: undefined,
        title: undefined,
      });
    });

    test("returns 404 for an unknown session before touching the SDK", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/fork", {});
      expect(res.status).toBe(404);
      expect(mockForkPersistedSession).not.toHaveBeenCalled();
    });

    const forkRefusals: Array<{ code: "not_found" | "conflict" | "invalid"; message: string; status: number }> = [
      { code: "not_found", message: "Session has not been materialized", status: 404 },
      { code: "conflict", message: "Cannot fork a running session", status: 409 },
      {
        code: "conflict",
        message: "Installed Claude Agent SDK does not support session forking",
        status: 409,
      },
      {
        code: "invalid",
        message: "The selected Claude message is not a persisted fork boundary",
        status: 400,
      },
    ];

    for (const { code, message, status } of forkRefusals) {
      test(`returns ${status} for "${message}"`, async () => {
        mockForkPersistedSession.mockImplementation(async () => {
          throw refusal(code, message);
        });
        const res = await jsonRequest("POST", "/session/s-1/fork", {});
        expect(res.status).toBe(status);
        expect(await jsonBody(res)).toEqual({ error: message });
      });
    }

    test("returns 500 for an unexpected fork failure", async () => {
      mockForkPersistedSession.mockImplementation(async () => {
        throw new Error("rollout copy failed");
      });
      const res = await jsonRequest("POST", "/session/s-1/fork", {});
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "rollout copy failed" });
    });
  });

  // --- POST /session/:id/rewind ---
  describe("POST /session/:id/rewind", () => {
    test("rewinds files and returns the SDK result", async () => {
      mockRewindSessionFiles.mockImplementation(async () => ({
        canRewind: true,
        filesChanged: ["/src/a.ts"],
        insertions: 3,
        deletions: 1,
      }));

      const res = await jsonRequest("POST", "/session/s-1/rewind", { messageId: " msg-7 " });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        status: "rewound",
        result: { canRewind: true, filesChanged: ["/src/a.ts"], insertions: 3, deletions: 1 },
      });
      expect(mockRewindSessionFiles).toHaveBeenCalledWith("s-1", "msg-7", false);
    });

    test("previews without touching files when dryRun is set", async () => {
      const res = await jsonRequest("POST", "/session/s-1/rewind", {
        messageId: "msg-7",
        dryRun: true,
      });
      expect((await jsonBody(res)).status).toBe("previewed");
      expect(mockRewindSessionFiles).toHaveBeenCalledWith("s-1", "msg-7", true);
    });

    test("treats a non-true dryRun as a real rewind", async () => {
      await jsonRequest("POST", "/session/s-1/rewind", {
        messageId: "msg-7",
        dryRun: "yes",
      });
      expect(mockRewindSessionFiles).toHaveBeenCalledWith("s-1", "msg-7", false);
    });

    test("returns 400 when no messageId is given", async () => {
      const res = await jsonRequest("POST", "/session/s-1/rewind", { messageId: "   " });
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "messageId is required" });
      expect(mockRewindSessionFiles).not.toHaveBeenCalled();
    });

    test("returns 404 for an unknown session before touching the SDK", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/rewind", { messageId: "m" });
      expect(res.status).toBe(404);
      expect(mockRewindSessionFiles).not.toHaveBeenCalled();
    });

    const rewindRefusals: Array<{ code: "not_found" | "conflict" | "invalid"; message: string; status: number }> = [
      { code: "not_found", message: "Session has not been materialized", status: 404 },
      { code: "conflict", message: "Cannot rewind a running session", status: 409 },
      {
        code: "conflict",
        message: "A file rewind is already in progress for this session",
        status: 409,
      },
      {
        code: "invalid",
        message: "The selected Claude message is not a persisted checkpoint",
        status: 400,
      },
    ];

    for (const { code, message, status } of rewindRefusals) {
      test(`returns ${status} for "${message}"`, async () => {
        mockRewindSessionFiles.mockImplementation(async () => {
          throw refusal(code, message);
        });
        const res = await jsonRequest("POST", "/session/s-1/rewind", { messageId: "m" });
        expect(res.status).toBe(status);
        expect(await jsonBody(res)).toEqual({ error: message });
      });
    }

    test("returns 500 for an unexpected rewind failure", async () => {
      mockRewindSessionFiles.mockImplementation(async () => {
        throw new Error("backup unreadable");
      });
      const res = await jsonRequest("POST", "/session/s-1/rewind", { messageId: "m" });
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "backup unreadable" });
    });
  });

  // --- POST /session/:id/compact ---
  describe("POST /session/:id/compact", () => {
    test("dispatches the compaction turn and returns 202", async () => {
      const res = await jsonRequest("POST", "/session/s-1/compact");
      expect(res.status).toBe(202);
      expect(await jsonBody(res)).toEqual({ status: "processing" });
      expect(mockSendPrompt).toHaveBeenCalledWith("s-1", "/compact");
    });

    test("returns 404 for an unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/compact");
      expect(res.status).toBe(404);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("returns 409 while a turn is already running", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Test",
        status: "running" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      } as ReturnType<typeof mockGetSession>);

      const res = await jsonRequest("POST", "/session/s-1/compact");
      expect(res.status).toBe(409);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("returns 409 while files are being restored", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        rewindInProgress: true,
      } as ReturnType<typeof mockGetSession>);

      const res = await jsonRequest("POST", "/session/s-1/compact");
      expect(res.status).toBe(409);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("maps a materialization refusal instead of returning 500", async () => {
      mockGetSession.mockReturnValueOnce(undefined as ReturnType<typeof mockGetSession>);
      mockEnsurePersistedSession.mockImplementation(async () => {
        throw refusal("conflict", "Session store is locked");
      });

      const res = await jsonRequest("POST", "/session/s-1/compact");
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "Session store is locked" });
    });
  });

  // --- POST /session/:id/tasks/:taskId/stop ---
  describe("POST /session/:id/tasks/:taskId/stop", () => {
    test("stops a background task", async () => {
      const res = await jsonRequest("POST", "/session/s-1/tasks/task-1/stop");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ status: "stopped" });
      expect(mockStopBackgroundTask).toHaveBeenCalledWith("s-1", "task-1");
    });

    test("returns 404 when the session is unknown", async () => {
      mockStopBackgroundTask.mockImplementation(async () => ({
        ok: false,
        reason: "session_not_found",
        message: "Session not found",
      }));
      const res = await jsonRequest("POST", "/session/s-x/tasks/task-1/stop");
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session not found" });
    });

    test("returns 404 when the task is unknown", async () => {
      mockStopBackgroundTask.mockImplementation(async () => ({
        ok: false,
        reason: "task_not_found",
        message: "Task not found",
      }));
      const res = await jsonRequest("POST", "/session/s-1/tasks/nope/stop");
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Task not found" });
    });

    test("returns 409 when the task exists but nothing live can reach it", async () => {
      mockStopBackgroundTask.mockImplementation(async () => ({
        ok: false,
        reason: "no_control_channel",
        message: "No live Claude control channel can reach this task",
      }));

      const res = await jsonRequest("POST", "/session/s-1/tasks/task-1/stop");

      // Not a 404: the user can see this task. A 404 told them it did not
      // exist, which is the opposite of the truth.
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({
        error: "No live Claude control channel can reach this task",
      });
    });

    test("returns 500 when the stop request itself throws", async () => {
      mockStopBackgroundTask.mockImplementation(async () => {
        throw new Error("control channel died");
      });
      const res = await jsonRequest("POST", "/session/s-1/tasks/task-1/stop");
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "control channel died" });
    });
  });
});
