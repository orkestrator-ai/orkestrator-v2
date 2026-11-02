import { afterAll, afterEach, describe, expect, test, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { gunzipSync } from "node:zlib";
import { configureLogger } from "@orkestrator/protocol/logger";
import { TaskRegistry } from "@orkestrator/protocol/task-list";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { setClaudeLinuxSandboxStatusForTests } from "@orkestrator/protocol/node/claude-linux-sandbox";

// Snapshot the real session-manager BEFORE installing the route's stub mock.
// Bun's `mock.module(...)` is process-global, so without this restore step the
// stub below leaks into `services/session-manager-*.test.ts` (and any other
// suite that imports the real module). See CLAUDE.md > "Bun `mock.module()`
// Rules" > "Snapshot-and-restore pattern".
import * as realSessionManager from "../services/session-manager.js";
const realSessionManagerSnapshot = { ...realSessionManager };
import * as realClaudeSignIn from "../services/claude-sign-in.js";
const realClaudeSignInSnapshot = { ...realClaudeSignIn };
// The real session map (not mocked): the mixed-version suite places a session
// here so the real catalogue functions serve real rows through the route.
import { sessions as coreSessions } from "../services/session-manager-core.js";
import type { SessionState } from "../types/index.js";
import { PreferenceLockTimeoutError } from "../services/session-preferences.js";

// --- Mock session-manager before importing the route ---

const mockCreateSession = mock(() => ({
  id: "s-1",
  title: "Test",
  status: "idle" as const,
  createdAt: new Date("2026-01-01"),
  lastActivity: new Date("2026-01-01"),
}));
const mockCreateOrRecoverSession = mock(async (title?: string, _clientSessionKey?: string) => ({
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

const defaultGetSession = (id: string) =>
  id === "s-1" || id === "s-tasks"
    ? {
        id,
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        taskRegistry: id === "s-tasks" ? sessionTaskRegistry : undefined,
      }
    : undefined;
const mockGetSession = mock(defaultGetSession);
const runtimeHealth = new RuntimeHealthRecorder();
runtimeHealth.recordUnknown("future-event");
runtimeHealth.recordNotice({
  message: "Provider deprecated an option",
  severity: "warning",
  source: "provider",
});
const mockPeekSession = mock((id: string) =>
  id === "s-health" ? ({ id, lastAccessedAt: 123, health: runtimeHealth } as never) : undefined,
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
  {
    id: "msg-1",
    role: "assistant",
    content: "Hello",
    parts: [],
    timestamp: "2026-01-01T00:00:00Z",
  },
]);

type SendPromptParams = Parameters<typeof realSessionManager.sendPrompt>;
const successfulPromptStart = async (...args: SendPromptParams) => {
  args[3]?.onQueryStarted?.();
};
const mockSendPrompt = mock(successfulPromptStart);
const mockAbortSession = mock(() => true);
const mockGracefulInterruptClaudeSession = mock(async () => ({
  interrupted: true,
  stillQueued: [] as string[],
}));
const mockReadClaudeCommandCatalogue = mock<typeof realSessionManager.readClaudeCommandCatalogue>(
  async () => ({ catalogueVersion: 1, status: "missing", commands: [] }),
);
const mockRefreshClaudeCommandCatalogue = mock<
  typeof realSessionManager.refreshClaudeCommandCatalogue
>(async () => ({ outcome: "reread" }));
const mockTypedCommandUnavailableMessage = mock<
  typeof realSessionManager.typedCommandUnavailableMessage
>((_session, prompt) =>
  prompt.startsWith("/clear") ? "/clear starts a new Claude conversation." : undefined,
);
const mockResolveClaudeCommandInvocation = mock<
  typeof realSessionManager.resolveClaudeCommandInvocation
>(async () => ({ ok: false, message: "unset" }));
const mockReadSessionMcpServers = mock(async () => []);
const mockPerformSessionMcpAction = mock(async () => ({ ok: true }));
const mockSteerClaudeSession = mock(async () => "applied" as const);
const mockAnswerIdleSteerPrompt = mock(async () => "There is no active Claude turn to steer.");
const mockReadClaudeSteerDispatch = mock(() => "dispatched" as const);
const mockConfigureClaudeSession = mock(async () => undefined);
const mockAssertClaudeRuntimeAccepts = mock((_session: unknown, _options: unknown) => {});
const mockRefreshClaudeContextUsage = mock(async () => ({
  usedTokens: 25,
  totalTokens: 100,
  percentUsed: 25,
  source: "claude" as const,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));
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
const mockGetSessionActivity = mock<typeof realSessionManager.getSessionActivity>(
  async (id: string) => (id === "s-1" ? "working" : "missing"),
);
const mockRespondToPlanApproval = mock(() => true);
const mockSetSessionPreferences = mock(
  async (_id: string, preferences: { planMode?: boolean }) => preferences,
);
const mockClearPromptSuggestion = mock((id: string) => id === "s-1");
const mockGetPromptDispatchState = mock<typeof realSessionManager.getPromptDispatchState>(
  () => "new",
);
const mockClaimPromptDispatch = mock<typeof realSessionManager.claimPromptDispatch>(
  async (_sessionId, _requestId, startDispatch) => {
    const dispatch = startDispatch();
    await dispatch.started;
    return "claimed";
  },
);
const mockPersistedDispatchStatus = mock<typeof realSessionManager.persistedDispatchStatus>(
  async () => "unknown",
);
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
function refusal(
  code: "not_found" | "conflict" | "invalid" | "unavailable",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

mock.module("../services/session-manager.js", () => ({
  createSession: mockCreateSession,
  createOrRecoverSession: mockCreateOrRecoverSession,
  getSession: mockGetSession,
  peekSession: mockPeekSession,
  backgroundTaskRevision: () => 0,
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
  sessionCompletionPending: realSessionManagerSnapshot.sessionCompletionPending,
  getSessionInitData: mockGetSessionInitData,
  answerQuestion: mockAnswerQuestion,
  dismissQuestion: mockDismissQuestion,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  respondToPlanApproval: mockRespondToPlanApproval,
  setSessionPreferences: mockSetSessionPreferences,
  clearPromptSuggestion: mockClearPromptSuggestion,
  claimPromptDispatch: mockClaimPromptDispatch,
  getPromptDispatchState: mockGetPromptDispatchState,
  // Real: the route test drives it through the peeked session record.
  restoredDispatchClaimLost: realSessionManagerSnapshot.restoredDispatchClaimLost,
  dispatchJournalProvesAbsent: realSessionManagerSnapshot.dispatchJournalProvesAbsent,
  persistedDispatchStatus: mockPersistedDispatchStatus,
  gracefulInterruptClaudeSession: mockGracefulInterruptClaudeSession,
  readClaudeCommandCatalogue: mockReadClaudeCommandCatalogue,
  refreshClaudeCommandCatalogue: mockRefreshClaudeCommandCatalogue,
  resolveClaudeCommandInvocation: mockResolveClaudeCommandInvocation,
  typedCommandUnavailableMessage: mockTypedCommandUnavailableMessage,
  readSessionMcpServers: mockReadSessionMcpServers,
  performSessionMcpAction: mockPerformSessionMcpAction,
  steerClaudeSession: mockSteerClaudeSession,
  answerIdleSteerPrompt: mockAnswerIdleSteerPrompt,
  readClaudeSteerDispatch: mockReadClaudeSteerDispatch,
  configureClaudeSession: mockConfigureClaudeSession,
  refreshClaudeContextUsage: mockRefreshClaudeContextUsage,
  assertClaudeRuntimeAccepts: mockAssertClaudeRuntimeAccepts,
}));

const mockClaudeReadiness = mock(
  (): ReturnType<typeof realClaudeSignIn.claudeReadiness> => undefined,
);
mock.module("../services/claude-sign-in.js", () => ({
  ...realClaudeSignInSnapshot,
  claudeReadiness: mockClaudeReadiness,
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
import session, {
  boundClaudeTranscriptResponse,
  MAX_CLAUDE_TRANSCRIPT_RESPONSE_BYTES,
} from "./session.js";

// Mount on a test app
const app = new Hono();
app.route("/session", session);

/*
 * The transcript compression middleware is registered on the composition root,
 * not on this route module, so mounting `session` alone cannot exercise it. The
 * real app is importable here because the session-manager mocks above are
 * already installed and the bridge skips `serve()` under these two flags.
 */
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
process.env.CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
const { app: bridgeApp } = await import("../index.js");

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
// files (e.g. services/session-manager-*.test.ts) see the real module.
afterAll(() => {
  mock.module("../services/session-manager.js", () => realSessionManagerSnapshot);
  mock.module("../services/claude-sign-in.js", () => realClaudeSignInSnapshot);
});

describe("session routes", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockImplementation(defaultGetSession);
    mockPeekSession.mockClear();
    mockCreateSession.mockClear();
    mockCreateOrRecoverSession.mockReset();
    mockCreateOrRecoverSession.mockImplementation(async (title?: string) => ({
      id: "s-1",
      title: title ?? "Test",
      status: "idle" as const,
      createdAt: new Date("2026-01-01"),
      lastActivity: new Date("2026-01-01"),
    }));
    mockListSessions.mockClear();
    mockGetSessionMessages.mockClear();
    mockSendPrompt.mockReset();
    mockSendPrompt.mockImplementation(successfulPromptStart);
    mockAssertClaudeRuntimeAccepts.mockReset();
    mockAssertClaudeRuntimeAccepts.mockImplementation(() => {});
    mockConfigureClaudeSession.mockReset();
    mockConfigureClaudeSession.mockImplementation(async () => undefined);
    mockAbortSession.mockClear();
    mockGracefulInterruptClaudeSession.mockReset();
    mockGracefulInterruptClaudeSession.mockImplementation(async () => ({
      interrupted: true,
      stillQueued: [],
    }));
    mockRefreshClaudeContextUsage.mockClear();
    mockSteerClaudeSession.mockReset();
    mockSteerClaudeSession.mockResolvedValue("applied");
    mockAnswerIdleSteerPrompt.mockReset();
    mockAnswerIdleSteerPrompt.mockResolvedValue("There is no active Claude turn to steer.");
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
    mockClaimPromptDispatch.mockImplementation(async (_sessionId, _requestId, startDispatch) => {
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
    mockPersistedDispatchStatus.mockReset();
    mockPersistedDispatchStatus.mockImplementation(async () => "unknown");
    resetPersistenceMocks();
  });

  test("validates and applies a resumed session execution policy", async () => {
    const policy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "restricted",
    };
    const accepted = await jsonRequest("POST", "/session/s-1/config", { policy });
    expect(accepted.status).toBe(200);
    expect(await jsonBody(accepted)).toMatchObject({ ok: true, policy });

    const rejected = await jsonRequest("POST", "/session/s-1/config", {
      policy: { ...policy, approvals: "approve-everything" },
    });
    expect(rejected.status).toBe(400);
  });

  test.each(["default", "acceptEdits", "auto", "bypassPermissions"] as const)(
    "config applies %s and ignores stale permission parameters while preserving plan preference",
    async (approvalMode) => {
      const sessionData = { ...defaultGetSession("s-1")!, planMode: false };
      mockGetSession.mockImplementation(() => sessionData);
      for (const mode of ["build", "plan"] as const) {
        const response = await jsonRequest("POST", "/session/s-1/config", {
          mode,
          approvalMode,
          parameterValues: { permissionMode: "bypassPermissions" },
        });
        expect(response.status).toBe(200);
        expect(mockConfigureClaudeSession).toHaveBeenLastCalledWith(
          sessionData,
          expect.objectContaining({ permissionMode: mode === "plan" ? "plan" : approvalMode }),
        );
        expect(mockSetSessionPreferences).toHaveBeenLastCalledWith("s-1", {
          planMode: mode === "plan",
        });
      }
      sessionData.planMode = true;
      mockSetSessionPreferences.mockClear();
      await jsonRequest("POST", "/session/s-1/config", { approvalMode });
      expect(mockConfigureClaudeSession).toHaveBeenLastCalledWith(sessionData, {});
      expect(mockSetSessionPreferences).not.toHaveBeenCalled();
    },
  );

  test("applies Ultracode on and off through the live config route", async () => {
    const applyFlagSettings = mock(async (_settings: Record<string, unknown>) => undefined);
    const session = {
      id: "s-1",
      title: "Test",
      status: "idle" as const,
      createdAt: new Date("2026-01-01"),
      lastActivity: new Date("2026-01-01"),
      queryControl: { applyFlagSettings },
    };
    mockGetSession.mockImplementation((id) => (id === "s-1" ? (session as never) : undefined));
    mockConfigureClaudeSession.mockImplementation(
      realSessionManagerSnapshot.configureClaudeSession,
    );

    const enabled = await jsonRequest("POST", "/session/s-1/config", {
      reasoningId: "ultracode",
    });
    expect({ status: enabled.status, body: await jsonBody(enabled) }).toMatchObject({
      status: 200,
    });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: true, effortLevel: "high" });

    const disabled = await jsonRequest("POST", "/session/s-1/config", { reasoningId: "low" });
    expect(disabled.status).toBe(200);
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: false, effortLevel: "low" });
  });

  test("runtime health reads without touching or resolving the session", async () => {
    const response = await app.request("/session/s-health/runtime-health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: { drift: { unknownEvents: 1, unknownKinds: ["future-event"] } },
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
      notices: [
        expect.objectContaining({
          message: "Provider deprecated an option",
          severity: "warning",
          source: "provider",
        }),
      ],
    });
    expect(mockPeekSession).toHaveBeenCalledWith("s-health");
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  test("runtime health answers empty in band for an unknown session", async () => {
    const response = await app.request("/session/missing/runtime-health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: {},
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    });
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
      expect(mockCreateOrRecoverSession).toHaveBeenCalledWith("Startup", "env-env-1:startup-agent");
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
      const turnStartedAt = "2026-01-01T00:00:05.000Z";
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "running" as const,
              turnStartedAt,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      const res = await app.request("/session/s-1");
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.id).toBe("s-1");
      expect(data.turnStartedAt).toBe(turnStartedAt);
      expect(Object.hasOwn(data, "planMode")).toBe(false);
    });

    test("publishes sign-in readiness only once the account read found no login", async () => {
      const unknown = await jsonBody(await app.request("/session/s-1"));
      expect(Object.hasOwn(unknown, "readiness")).toBe(false);

      const readiness = {
        state: "authentication-required" as const,
        message: "Claude isn't signed in. Sign in to Claude to keep working.",
        signIn: {
          kind: "terminal" as const,
          hint: "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
        },
      };
      mockClaudeReadiness.mockImplementationOnce(() => readiness);
      const locked = await jsonBody(await app.request("/session/s-1"));
      expect(locked.readiness).toEqual(readiness);
    });

    test("serves a session's turn-time auth notice only while it stands", async () => {
      const base = {
        id: "s-1",
        title: "Test",
        status: "error" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      };
      mockGetSession.mockImplementationOnce(() => base);
      const clear = await jsonBody(await app.request("/session/s-1"));
      expect(Object.hasOwn(clear, "authNotice")).toBe(false);

      const authNotice = {
        state: "expired" as const,
        message: "Claude's login was refused. Sign in to Claude again to keep working.",
        occurrenceId: "assistant-1",
      };
      mockGetSession.mockImplementationOnce(() => ({ ...base, authNotice }));
      const raised = await jsonBody(await app.request("/session/s-1"));
      expect(raised.authNotice).toEqual(authNotice);
    });

    test("publishes the command inventory revision only when an inventory exists", async () => {
      const base = {
        id: "s-1",
        title: "Test",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      };
      mockGetSession.mockImplementationOnce(() => ({
        ...base,
        commandInventoryState: { authority: "replacement", revision: 7, truncated: false },
      }));
      const withInventory = await jsonBody(await app.request("/session/s-1"));
      expect(withInventory.commandRevision).toBe(7);
      // Served from memory: the catalogue read path is never involved.
      expect(mockReadClaudeCommandCatalogue).not.toHaveBeenCalled();

      mockGetSession.mockImplementationOnce(() => base);
      const withoutInventory = await jsonBody(await app.request("/session/s-1"));
      expect(Object.hasOwn(withoutInventory, "commandRevision")).toBe(false);
    });

    test("prefers the in-progress token lower bound while a turn is running", async () => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "running" as const,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
              usage: {
                usedTokens: 80,
                sessionTokens: 80,
                source: "claude" as const,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              inProgressUsage: {
                usedTokens: 130,
                sessionTokens: 210,
                source: "claude" as const,
                updatedAt: "2026-01-01T00:00:01.000Z",
              },
            }
          : undefined,
      );

      const res = await app.request("/session/s-1");
      expect(res.status).toBe(200);
      expect((await jsonBody(res)).contextUsage).toMatchObject({ sessionTokens: 210 });
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

  describe("GET /session/:id/usage", () => {
    test("requests the detailed context snapshot on demand", async () => {
      const res = await app.request("/session/s-1/usage");

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        contextUsage: {
          usedTokens: 25,
          totalTokens: 100,
          percentUsed: 25,
          source: "claude",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      expect(mockRefreshClaudeContextUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe("PUT /session/:id/preferences", () => {
    test("persists plan mode in the authoritative session", async () => {
      const res = await jsonRequest("PUT", "/session/s-1/preferences", { planMode: true });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ planMode: true });
      expect(mockSetSessionPreferences).toHaveBeenCalledWith("s-1", { planMode: true });
    });

    test.each([[null], [[]], ["plan"], [true], [1]])(
      "rejects a non-object request body: %p",
      async (body) => {
        const res = await jsonRequest("PUT", "/session/s-1/preferences", body);

        expect(res.status).toBe(400);
        expect(await jsonBody(res)).toEqual({
          error: "Request body must be a JSON object",
        });
        expect(mockSetSessionPreferences).not.toHaveBeenCalled();
      },
    );

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

    test("keeps a non-claim preference lock timeout as 500", async () => {
      const error = new PreferenceLockTimeoutError();
      mockSetSessionPreferences.mockRejectedValueOnce(error);

      const res = await jsonRequest("PUT", "/session/s-1/preferences", { planMode: true });

      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: error.message });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("maps an unknown session preference update to 404", async () => {
      mockSetSessionPreferences.mockRejectedValueOnce(refusal("not_found", "Session not found"));

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
      const mismatch = await app.request("/session/s-1/structured-output?requestId=structured-2");
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
      expect(data.messageWindow).toEqual({ truncated: false });
    });

    test("bounds aggregate transcript responses by dropping the oldest messages", () => {
      const messages = Array.from({ length: 20 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        content: String(index),
        parts: [{ type: "text" as const, content: "x".repeat(1024 * 1024) }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
      const bounded = boundClaudeTranscriptResponse(messages);

      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
        MAX_CLAUDE_TRANSCRIPT_RESPONSE_BYTES,
      );
      expect(bounded.messageWindow).toMatchObject({ truncated: true });
      expect(bounded.messages.at(-1)?.id).toBe("message-19");
      expect(bounded.messages[0]?.id).not.toBe("message-0");
    });

    test("trims parts off a single oversized message rather than dropping it", () => {
      // A long turn is one message, so message-level dropping has nothing left
      // to take. The newest parts are what the user is looking at.
      const parts = Array.from({ length: 40 }, (_, index) => ({
        type: "text" as const,
        content: `${index}:${"x".repeat(1024 * 1024)}`,
      }));
      const bounded = boundClaudeTranscriptResponse([
        {
          id: "message-long-turn",
          role: "assistant" as const,
          content: "done",
          parts,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(bounded.messages).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
        MAX_CLAUDE_TRANSCRIPT_RESPONSE_BYTES,
      );
      expect(bounded.messageWindow.truncated).toBe(true);
      expect(bounded.messageWindow.omittedParts).toBeGreaterThan(0);
      expect(bounded.messageWindow.omittedMessages).toBeUndefined();
      expect(bounded.messages[0]?.parts.at(-1)).toEqual(parts.at(-1)!);
    });

    test("gzip-compresses the transcript when the client accepts gzip", async () => {
      mockGetSessionMessages.mockReturnValueOnce([
        {
          id: "msg-compress",
          role: "assistant",
          content: "Hello",
          parts: [{ type: "text", content: "compressible ".repeat(8_192) }],
          timestamp: "2026-01-01T00:00:00Z",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        },
      ] as any);
      const request = new Request("http://localhost/session/s-1/messages");
      request.headers.set("Accept-Encoding", "gzip");
      const res = await bridgeApp.request(request);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");
      // Without Vary a shared cache could hand a gzip body to a client that
      // never asked for one.
      expect(res.headers.get("Vary")).toContain("Accept-Encoding");
      const decoded = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString());
      expect(decoded.messages[0]?.id).toBe("msg-compress");
    });

    test("leaves the transcript uncompressed when the client does not accept gzip", async () => {
      const res = await bridgeApp.request("http://localhost/session/s-1/messages");

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBeNull();
      expect(res.headers.get("Vary")).toContain("Accept-Encoding");
      expect((await jsonBody(res)).messages).toHaveLength(1);
    });

    test("returns 404 for unknown session", async () => {
      const res = await app.request("/session/s-unknown/messages");
      expect(res.status).toBe(404);
    });

    test("serves only the newest messages for a tail limit", async () => {
      mockGetSessionMessages.mockReturnValueOnce(
        Array.from({ length: 5 }, (_, index) => ({
          id: `msg-${index}`,
          role: "assistant",
          content: String(index),
          parts: [],
          timestamp: "2026-01-01T00:00:00Z",
        })) as any,
      );
      const res = await app.request("/session/s-1/messages?limit=2");

      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.messages.map((message: { id: string }) => message.id)).toEqual([
        "msg-3",
        "msg-4",
      ]);
      expect(data.messageWindow).toEqual({ truncated: true, omittedMessages: 3 });
    });

    test("serves the whole window for an unusable tail limit", async () => {
      for (const limit of ["0", "-1", "01", "2.5", "abc"]) {
        mockGetSessionMessages.mockReturnValueOnce(
          Array.from({ length: 3 }, (_, index) => ({
            id: `msg-${index}`,
            role: "assistant",
            content: String(index),
            parts: [],
            timestamp: "2026-01-01T00:00:00Z",
          })) as any,
        );
        const res = await app.request(`/session/s-1/messages?limit=${limit}`);
        expect(res.status).toBe(200);
        const data = await jsonBody(res);
        expect(data.messages).toHaveLength(3);
        expect(data.messageWindow).toEqual({ truncated: false });
      }
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

    test.each([
      { agent: "reviewer" },
      { parameterValues: { context1m: true } },
      { parameterValues: { context1m: false } },
      { promptSuggestions: true },
      { promptSuggestions: false },
      { parameterValues: { thinking: "adaptive" } },
      { permissionMode: "bypassPermissions" },
    ])("awaits launch compatibility before journaling %j", async (options) => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      mockAssertClaudeRuntimeAccepts.mockImplementationOnce(async () => {
        await Promise.resolve();
        throw refusal("conflict", "Claude is still running background work in this session");
      });
      mockClaimPromptDispatch.mockClear();

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Review it",
        requestId: "review-1",
        ...options,
      });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({
        error: "Claude is still running background work in this session",
      });
      expect(mockAssertClaudeRuntimeAccepts).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "s-1" }),
        expect.objectContaining(options),
      );
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("returns 202 with valid prompt", async () => {
      const turnStartedAt = "2026-01-01T00:00:05.000Z";
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              turnStartedAt,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Hello Claude",
      });
      expect(res.status).toBe(202);
      const data = await jsonBody(res);
      expect(data.status).toBe("processing");
      expect(data.turnStartedAt).toBe(turnStartedAt);
    });

    test("answers an idle /steer locally instead of starting a model turn", async () => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/steer keep the diff small",
      });
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        status: "accepted",
        requestId: undefined,
        local: true,
      });
      expect(mockAnswerIdleSteerPrompt).toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();

      mockGetPromptDispatchState.mockReturnValueOnce("already-processed");
      const retry = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/steer keep the diff small",
        requestId: "idle-steer",
      });
      expect(retry.status).toBe(200);
      expect(await jsonBody(retry)).toEqual({
        status: "already-processed",
        requestId: "idle-steer",
        duplicate: true,
        local: true,
      });
      expect(mockAnswerIdleSteerPrompt).toHaveBeenCalledTimes(1);
    });

    test("refuses a structured idle /steer instead of starting a turn", async () => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/steer keep going",
        outputSchema: { type: "object" },
      });
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({
        error: "/steer cannot be used with structured output",
      });
      expect(mockAnswerIdleSteerPrompt).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("durably claims a stable request id before dispatch", async () => {
      const turnStartedAt = "2026-01-01T00:00:06.000Z";
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              turnStartedAt,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(202);
      expect(await jsonBody(res)).toEqual({
        status: "processing",
        requestId: "initial-prompt:env-1:tab-1",
        turnStartedAt,
      });
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

    test("refuses a request id an earlier bridge process claimed and this one never saw", async () => {
      // Restored from disk: the turn may have run or died with that process.
      mockGetSession.mockImplementation((id) =>
        id === "s-1"
          ? {
              ...defaultGetSession(id)!,
              dispatchedRequestIds: new Set(["before-restart"]),
              restoredDispatchedRequestIds: new Set(["before-restart"]),
            }
          : undefined,
      );

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/deploy now",
        requestId: "before-restart",
      });

      expect(res.status).toBe(410);
      expect(await jsonBody(res)).toEqual({
        error: "Claude prompt outcome is no longer available; resubmit with a new requestId",
        kind: "dispatch-outcome-lost",
      });
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("keeps answering this process's own claims and local replies as processed", async () => {
      mockGetSession.mockImplementation((id) =>
        id === "s-1"
          ? {
              ...defaultGetSession(id)!,
              dispatchedRequestIds: new Set(["claimed-here", "idle-steer"]),
              restoredDispatchedRequestIds: new Set(["idle-steer"]),
            }
          : undefined,
      );

      // Claimed by this process, still persisting its claim.
      const own = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "claimed-here",
      });
      expect(own.status).toBe(200);
      expect(await jsonBody(own)).toMatchObject({ status: "already-processed", duplicate: true });

      // An idle `/steer` reply is answered locally and kept with the session,
      // so it never ran a turn that a restart could have lost.
      const local = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/steer keep going",
        requestId: "idle-steer",
      });
      expect(local.status).toBe(200);
      expect(await jsonBody(local)).toMatchObject({ status: "already-processed", local: true });
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

    test("returns 404 when the session disappears during a durable request-id claim", async () => {
      mockClaimPromptDispatch.mockResolvedValueOnce("not-found");

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:gone",
      });

      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Session not found" });
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

    test("maps a claim refused on a busy preference lock to 503", async () => {
      // The backend reads 503 as "not processed" and keeps the retry, where a
      // 500 would park the prompt as outcome unknown.
      mockClaimPromptDispatch.mockRejectedValueOnce(
        refusal(
          "unavailable",
          "The session's preferences are busy, so the prompt was not sent. Try again.",
        ),
      );

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Launch once",
        requestId: "initial-prompt:env-1:tab-1",
      });

      expect(res.status).toBe(503);
      expect(await jsonBody(res)).toEqual({
        error: "The session's preferences are busy, so the prompt was not sent. Try again.",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("forwards a structured schema and stable request id", async () => {
      const turnStartedAt = "2026-01-01T00:00:07.000Z";
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "idle" as const,
              turnStartedAt,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
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
        turnStartedAt,
      });
      // Through the durable claim, like a plain prompt with a request id.
      expect(mockClaimPromptDispatch).toHaveBeenCalledWith(
        "s-1",
        "structured-1",
        expect.any(Function),
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        "s-1",
        "Review",
        expect.objectContaining({ outputSchema, requestId: "structured-1" }),
        expect.objectContaining({ onQueryStarted: expect.any(Function) }),
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
      const turnStartedAt = "2026-01-01T00:00:08.000Z";
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "running" as const,
              turnStartedAt,
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );
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
        turnStartedAt,
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

    test("returns 409 for a requestless prompt while a turn is already running", async () => {
      mockGetSession.mockImplementationOnce((id: string) =>
        id === "s-1"
          ? {
              id,
              title: "Test",
              status: "running" as const,
              turnStartedAt: "2026-01-01T00:00:08.000Z",
              createdAt: new Date("2026-01-01"),
              lastActivity: new Date("2026-01-01"),
            }
          : undefined,
      );

      const res = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Another turn",
      });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({
        error: "Session is already processing a prompt",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
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
        attachments: [
          {
            type: "image",
            path: "",
            filename: "screen.png",
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
        ],
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
        attachments: [
          {
            type: "image",
            path: "",
            dataUrl: "not base64",
          },
        ],
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
      const oversizedDataUrl = `data:image/png;base64,${Buffer.alloc(
        8 * 1024 * 1024 + 1,
        1,
      ).toString("base64")}`;
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "describe",
        attachments: [
          {
            type: "image",
            path: "",
            dataUrl: oversizedDataUrl,
          },
        ],
      });

      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({
        error: "Attachments are invalid; inline images must be valid base64 and no larger than 8MB",
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("accepts inline image data exactly at the 8MB attachment limit", async () => {
      const maximumDataUrl = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024, 1).toString(
        "base64",
      )}`;
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "describe",
        attachments: [
          {
            type: "image",
            path: "",
            dataUrl: maximumDataUrl,
          },
        ],
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
        "parameterValues",
        "permissionMode",
        "promptSuggestions",
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
        // A real effort level switches Ultracode off explicitly.
        parameterValues: { ultracode: false },
      });
    });

    test("maps the ultracode reasoning level to high effort with the flag on", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "test",
        effort: "ultracode",
        parameterValues: { thinking: "adaptive" },
      });

      expect(mockSendPrompt.mock.calls[0]?.[2]).toMatchObject({
        effort: "high",
        parameterValues: { thinking: "adaptive", ultracode: true },
      });
    });

    test("forwards a read-only build turn independently of permission mode", async () => {
      await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "Consolidate the reports",
        permissionMode: "dontAsk",
        readOnly: true,
      });

      expect(mockSendPrompt.mock.calls[0]?.[2]).toMatchObject({
        permissionMode: "dontAsk",
        readOnly: true,
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
      for (const mode of [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
      ]) {
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

  describe("command catalogue and selected commands", () => {
    const reviewCommand = {
      name: "/review",
      id: "claude:/review",
      executionKind: "provider-prompt" as const,
      source: "unknown" as const,
      bindingRevision: "0123456789abcdef",
    };

    beforeEach(() => {
      mockReadClaudeCommandCatalogue.mockReset();
      mockReadClaudeCommandCatalogue.mockImplementation(async () => ({
        catalogueVersion: 1,
        status: "missing",
        commands: [],
      }));
      mockRefreshClaudeCommandCatalogue.mockReset();
      mockRefreshClaudeCommandCatalogue.mockImplementation(async () => ({ outcome: "reread" }));
      mockResolveClaudeCommandInvocation.mockReset();
      mockClaimPromptDispatch.mockClear();
    });

    test("serves the enhanced catalogue without resolving, touching or hydrating", async () => {
      mockReadClaudeCommandCatalogue.mockImplementationOnce(async () => ({
        catalogueVersion: 1,
        status: "ready",
        revision: 2,
        commands: [reviewCommand],
      }));
      const response = await app.request("/session/s-1/commands");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        catalogueVersion: 1,
        status: "ready",
        commands: [{ id: "claude:/review", executionKind: "provider-prompt" }],
      });
      expect(mockReadClaudeCommandCatalogue).toHaveBeenCalledWith("s-1");
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockEnsurePersistedSession).not.toHaveBeenCalled();
      expect(mockHydratePersistedSessionMessages).not.toHaveBeenCalled();
    });

    test("answers an unknown session in band, not with a 404", async () => {
      const response = await app.request("/session/never-seen/commands");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        catalogueVersion: 1,
        status: "missing",
        commands: [],
      });
    });

    test("a failed discovery is an error, never an empty ready list", async () => {
      mockReadClaudeCommandCatalogue.mockImplementationOnce(async () => {
        throw new Error("inventory exploded");
      });
      const response = await app.request("/session/s-1/commands");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "inventory exploded" });
    });

    test("refresh reports the outcome the session manager observed", async () => {
      mockRefreshClaudeCommandCatalogue.mockImplementationOnce(async () => ({
        outcome: "failed",
        message: "Claude could not reload every command resource (plugins: boom).",
      }));
      const response = await jsonRequest("POST", "/session/s-1/commands/refresh");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        outcome: "failed",
        message: "Claude could not reload every command resource (plugins: boom).",
      });
    });

    test("sends the canonical spelling while the transcript keeps the typed text", async () => {
      const args = "src/app.ts\n  and the tests\t";
      mockResolveClaudeCommandInvocation.mockImplementationOnce(async () => ({
        ok: true,
        command: reviewCommand,
        providerPrompt: `/review ${args}`,
      }));
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: `/Review ${args}`,
        requestId: "command-1",
        command: {
          id: "claude:/review",
          name: "/review",
          executionKind: "provider-prompt",
          bindingRevision: "0123456789abcdef",
          arguments: args,
        },
      });
      expect(response.status).toBe(202);
      expect(mockResolveClaudeCommandInvocation.mock.calls[0]?.[1]).toEqual({
        id: "claude:/review",
        name: "/review",
        executionKind: "provider-prompt",
        bindingRevision: "0123456789abcdef",
        arguments: args,
      });
      const [, prompt, options] = mockSendPrompt.mock.calls[0]!;
      expect(prompt).toBe(`/Review ${args}`);
      expect(options?.providerPrompt).toBe(`/review ${args}`);
    });

    test("a removed, forged or changed command is refused before any dispatch", async () => {
      mockResolveClaudeCommandInvocation.mockImplementationOnce(async () => ({
        ok: false,
        message: "/review changed since it was selected. Choose it again from the menu.",
      }));
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/review",
        requestId: "command-stale",
        command: {
          id: "claude:/review",
          name: "/review",
          executionKind: "provider-prompt",
          bindingRevision: "ffffffffffffffff",
          arguments: "",
        },
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "/review changed since it was selected. Choose it again from the menu.",
        kind: "command-unavailable",
      });
      // Nothing journaled, nothing sent: the backend reports a rejection.
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("rejects malformed command fields and literal intent with a selection", async () => {
      const malformed = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/review",
        command: { id: "claude:/review", name: "/review", executionKind: "provider-prompt" },
      });
      expect(malformed.status).toBe(400);
      const contradictory = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/review",
        allowProviderCommands: false,
        command: { ...reviewCommand, arguments: "" },
      });
      expect(contradictory.status).toBe(400);
      const badFlag = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "hello",
        allowProviderCommands: "no",
      });
      expect(badFlag.status).toBe(400);
      expect(mockResolveClaudeCommandInvocation).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("typed text naming an unavailable command is refused before dispatch", async () => {
      const refused = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/clear",
        requestId: "typed-clear",
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({
        error: "/clear starts a new Claude conversation.",
        kind: "command-unavailable",
      });
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();

      const passed = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/review src/a.ts",
        requestId: "typed-review",
      });
      expect(passed.status).toBe(202);
      expect(mockSendPrompt.mock.calls[0]?.[1]).toBe("/review src/a.ts");
      expect(mockSendPrompt.mock.calls[0]?.[2]?.providerPrompt).toBeUndefined();
    });

    test("literal intent passes the text through unchanged", async () => {
      const response = await jsonRequest("POST", "/session/s-1/prompt", {
        prompt: "/tmp/output.log looks wrong",
        allowProviderCommands: false,
      });
      expect(response.status).toBe(202);
      const [, prompt, options] = mockSendPrompt.mock.calls[0]!;
      expect(prompt).toBe("/tmp/output.log looks wrong");
      expect(options?.providerPrompt).toBeUndefined();
      expect(mockResolveClaudeCommandInvocation).not.toHaveBeenCalled();
    });
  });

  describe("a turn that requires a sandbox this host cannot run commands in", () => {
    const reason =
      "Claude's command sandbox cannot run commands on this host: bubblewrap starts, but AppArmor's bwrap-userns-restrict profile strips capabilities from the user namespace the Claude CLI nests inside it.";

    async function promptOnLinux(body: Record<string, unknown>) {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      setClaudeLinuxSandboxStatusForTests({
        available: false,
        failure: "nested-user-namespace",
        reason,
      });
      try {
        return await jsonRequest("POST", "/session/s-1/prompt", body);
      } finally {
        Object.defineProperty(process, "platform", platform);
        setClaudeLinuxSandboxStatusForTests({ available: true });
      }
    }

    test("is refused with the probe's reason before anything is journaled", async () => {
      mockGetSession.mockImplementation((id) =>
        id === "s-1"
          ? ({
              ...defaultGetSession(id)!,
              executionPolicy: {
                id: "interactive-host",
                sandbox: "provider",
                approvals: "auto-approve",
                projectResources: true,
                networkAccess: "full",
              },
            } as never)
          : undefined,
      );
      const refused = await promptOnLinux({ prompt: "List the files", requestId: "sandboxed" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: reason, kind: "sandbox-unavailable" });
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("a session without the provider sandbox is unaffected", async () => {
      const passed = await promptOnLinux({ prompt: "List the files", requestId: "plain" });
      expect(passed.status).toBe(202);
    });

    test("a read-only review turn is accepted and runs on the hook alone (todo 0190)", async () => {
      // Even in a session that requires the provider sandbox: the turn runs
      // under the read-only policy, whose sandbox is off where none can run.
      mockGetSession.mockImplementation((id) =>
        id === "s-1"
          ? ({
              ...defaultGetSession(id)!,
              executionPolicy: {
                id: "interactive-host",
                sandbox: "provider",
                approvals: "auto-approve",
                projectResources: true,
                networkAccess: "full",
              },
            } as never)
          : undefined,
      );
      const review = await promptOnLinux({
        prompt: "Review",
        readOnly: true,
        requestId: "review-report",
      });
      expect(review.status).toBe(202);
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
      expect(mockSendPrompt.mock.calls[0]?.[2]?.readOnly).toBe(true);
    });
  });

  /*
   * A backend from before the version-1 catalogue (ff4026b4e^, #827) talking to
   * this bridge. Its `HttpBridgeCatalogAdapter.slashCommands` read
   * `GET /session/:id/commands` first and fell back to `/plugins/commands` only
   * on a 404; its snapshot reader took `GET /session/:id`; its prompt body never
   * carried `allowProviderCommands` or `command`. The catalogue and the typed
   * command check below are the real session-manager functions, run against a
   * session placed in the real session map, so the rows are the ones this bridge
   * actually serves.
   */
  describe("mixed-version: old backend, current bridge", () => {
    const MIXED_SESSION_ID = "s-mixed-version";

    /** The pre-#827 backend's row reader, verbatim in behaviour. */
    function legacyReadSlashCommands(payload: unknown) {
      const record =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
      if (!record || !Array.isArray(record.commands)) return [];
      const allowed = new Set([
        "builtin",
        "project",
        "user",
        "plugin",
        "skill",
        "template",
        "extension",
        "orkestrator",
      ]);
      return record.commands.flatMap((candidate: unknown) => {
        const row = (typeof candidate === "string" ? { name: candidate } : candidate) as Record<
          string,
          unknown
        > | null;
        if (!row || typeof row.name !== "string" || !row.name) return [];
        const name = row.name.startsWith("/") ? row.name : `/${row.name}`;
        return [
          {
            name,
            source:
              typeof row.source === "string" && allowed.has(row.source) ? row.source : "unknown",
            ...(typeof row.description === "string" ? { description: row.description } : {}),
            ...(typeof row.argumentHint === "string" ? { argumentHint: row.argumentHint } : {}),
            ...(Array.isArray(row.aliases)
              ? {
                  aliases: row.aliases.filter(
                    (alias): alias is string => typeof alias === "string",
                  ),
                }
              : {}),
            ...(row.scope === "global" || row.scope === "session" ? { scope: row.scope } : {}),
          },
        ];
      });
    }

    function mixedSession(): SessionState {
      return {
        id: MIXED_SESSION_ID,
        title: "Mixed",
        status: "idle",
        messages: [],
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        initData: {
          mcpServers: [],
          plugins: [{ name: "acme", path: "/plugins/acme" }],
          slashCommands: [],
          skills: ["deploy"],
        },
      } as unknown as SessionState;
    }

    let placed: SessionState | undefined;

    function place(session: SessionState, commands: unknown[]): SessionState {
      placed = session;
      coreSessions.set(session.id, session);
      realSessionManagerSnapshot.recordCommandsChanged(session, { commands });
      return session;
    }

    const sdkCommands = [
      {
        name: "review",
        description: "Review the current diff",
        argumentHint: "[path]",
        aliases: ["rv"],
      },
      { name: "deploy", description: "Ship it", argumentHint: "" },
      { name: "acme:lint", description: "Plugin lint", argumentHint: "" },
      { name: "clear", description: "Clear conversation history", argumentHint: "" },
    ];

    beforeEach(() => {
      mockReadClaudeCommandCatalogue.mockReset();
      mockReadClaudeCommandCatalogue.mockImplementation(
        realSessionManagerSnapshot.readClaudeCommandCatalogue,
      );
      mockTypedCommandUnavailableMessage.mockReset();
      mockTypedCommandUnavailableMessage.mockImplementation(
        realSessionManagerSnapshot.typedCommandUnavailableMessage,
      );
      mockResolveClaudeCommandInvocation.mockReset();
      mockClaimPromptDispatch.mockClear();
    });

    afterEach(() => {
      if (placed) coreSessions.delete(placed.id);
      placed = undefined;
      // Restore the route-level defaults the other suites rely on.
      mockReadClaudeCommandCatalogue.mockReset();
      mockReadClaudeCommandCatalogue.mockImplementation(async () => ({
        catalogueVersion: 1,
        status: "missing",
        commands: [],
      }));
      mockTypedCommandUnavailableMessage.mockReset();
      mockTypedCommandUnavailableMessage.mockImplementation((_session, prompt) =>
        prompt.startsWith("/clear") ? "/clear starts a new Claude conversation." : undefined,
      );
    });

    test("the session catalogue an old backend reads first still satisfies its row reader", async () => {
      place(mixedSession(), sdkCommands);
      const response = await app.request(`/session/${MIXED_SESSION_ID}/commands`);
      // A 200: the old backend keeps this answer and never reaches /plugins/commands.
      expect(response.status).toBe(200);
      const body = await jsonBody(response);

      // The envelope fields are top-level additions; `commands` is still the array.
      expect(body).toMatchObject({ catalogueVersion: 1, status: "ready", freshness: "ttl" });
      expect(Number.isSafeInteger(body.revision)).toBe(true);
      expect(Array.isArray(body.commands)).toBe(true);
      for (const row of body.commands) {
        expect(typeof row.name).toBe("string");
        expect(row.name.length).toBeGreaterThan(0);
        if ("description" in row) expect(typeof row.description).toBe("string");
        if ("argumentHint" in row) expect(typeof row.argumentHint).toBe("string");
        if ("aliases" in row) {
          expect(Array.isArray(row.aliases)).toBe(true);
          for (const alias of row.aliases) expect(typeof alias).toBe("string");
        }
      }

      // What the old backend would render. Every name already has its slash, so
      // nothing is re-spelled. Differences from the pre-#827 bridge it was
      // written against: rows it cannot attribute are `unknown` (the old bridge
      // guessed `user`), every row is `session`-scoped (the old bridge used
      // `global` for non-project rows), and a skill is listed under its own
      // `/deploy` name instead of the old `/skill:deploy` spelling. Empty
      // argument hints are omitted, as the old bridge also did.
      expect(legacyReadSlashCommands(body)).toEqual([
        {
          name: "/review",
          source: "unknown",
          description: "Review the current diff",
          argumentHint: "[path]",
          aliases: ["/rv"],
          scope: "session",
        },
        {
          name: "/deploy",
          source: "skill",
          description: "Ship it",
          scope: "session",
        },
        {
          name: "/acme:lint",
          source: "plugin",
          description: "Plugin lint",
          scope: "session",
        },
        // The old reader drops `availability`, so an old backend lists /clear
        // as an ordinary command. Sending it is refused (see the prompt test).
        {
          name: "/clear",
          source: "unknown",
          description: "Clear conversation history",
          scope: "session",
        },
      ]);
      expect(body.commands.find((row: { name: string }) => row.name === "/clear")).toMatchObject({
        availability: { state: "unavailable", reason: "session-changing" },
      });
    });

    test("an unknown session reads as an empty list, so the old backend never falls back", async () => {
      const response = await app.request("/session/never-seen-mixed/commands");
      // The pre-#827 bridge spawned a probe here and returned the bridge-wide
      // list; this bridge answers in band with no rows. An old backend shows only
      // its own Claude built-ins until the session exists.
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body).toEqual({ catalogueVersion: 1, status: "missing", commands: [] });
      expect(legacyReadSlashCommands(body)).toEqual([]);
    });

    test("the snapshot adds commandRevision without touching the fields the old reader takes", async () => {
      const session = place(mixedSession(), sdkCommands);
      const held = session as unknown as ReturnType<typeof defaultGetSession>;
      mockGetSession.mockImplementation((id: string) =>
        id === MIXED_SESSION_ID ? held : defaultGetSession(id),
      );
      const before = await jsonBody(await app.request(`/session/${MIXED_SESSION_ID}`));
      const catalogue = await jsonBody(await app.request(`/session/${MIXED_SESSION_ID}/commands`));
      expect(Number.isSafeInteger(before.commandRevision)).toBe(true);
      expect(before.commandRevision).toBe(catalogue.revision);
      expect(before.status).toBe("idle");
      expect(before.id).toBe(MIXED_SESSION_ID);
      expect(before.title).toBe("Mixed");
      // The old reader took a top-level `revision` as the provider transcript
      // revision when `messageRevision` was absent; the command revision must
      // never appear under either name.
      expect(Object.hasOwn(before, "revision")).toBe(false);
      expect(Object.hasOwn(before, "messageRevision")).toBe(false);

      realSessionManagerSnapshot.recordCommandsChanged(session, {
        commands: [{ name: "fresh", description: "", argumentHint: "" }],
      });
      const after = await jsonBody(await app.request(`/session/${MIXED_SESSION_ID}`));
      expect(after.commandRevision).toBe(before.commandRevision + 1);
      expect(after.status).toBe("idle");
      expect(Object.hasOwn(after, "revision")).toBe(false);
      expect(Object.hasOwn(after, "messageRevision")).toBe(false);
      // Apart from the additive key, the snapshot an old backend reads is unchanged.
      const { commandRevision: _beforeRevision, ...beforeLegacy } = before;
      const { commandRevision: _afterRevision, ...afterLegacy } = after;
      expect(afterLegacy).toEqual(beforeLegacy);
    });

    test("an old prompt body is interpreted: typed /clear is refused, other commands pass", async () => {
      // The pre-#827 Claude prompt body: no `allowProviderCommands`, no `command`.
      const oldBody = (prompt: string, requestId: string) => ({
        prompt,
        requestId,
        attachments: [],
        fastMode: false,
        permissionMode: "bypassPermissions",
      });

      const refused = await jsonRequest("POST", "/session/s-1/prompt", oldBody("/clear", "old-1"));
      // A 422 is a terminal rejection to the old sender (only 404/409/5xx were
      // retried), and it surfaced `error` to the user. The pre-#827 bridge sent
      // /clear to the CLI, which moved to a conversation this tab cannot follow.
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({
        error:
          "/clear starts a new Claude conversation this tab cannot follow. Start a new session instead.",
        kind: "command-unavailable",
      });
      expect(mockClaimPromptDispatch).not.toHaveBeenCalled();
      expect(mockSendPrompt).not.toHaveBeenCalled();

      const passed = await jsonRequest(
        "POST",
        "/session/s-1/prompt",
        oldBody("/review src/a.ts", "old-2"),
      );
      expect(passed.status).toBe(202);
      const [, prompt, options] = mockSendPrompt.mock.calls[0]!;
      expect(prompt).toBe("/review src/a.ts");
      expect(options?.providerPrompt).toBeUndefined();
      expect(mockResolveClaudeCommandInvocation).not.toHaveBeenCalled();
    });
  });

  describe("POST /session/:id/steer", () => {
    test("steers the active SDK input stream and records the dispatch identity", async () => {
      const res = await jsonRequest("POST", "/session/s-1/steer", {
        input: "Focus on the failing test",
        requestId: "steer-1",
        expectedRunId: "run-1",
      });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ outcome: "applied" });
      expect(mockSteerClaudeSession).toHaveBeenCalledWith(
        "s-1",
        "Focus on the failing test",
        "steer-1",
        "run-1",
      );
    });

    test("returns the definitive capacity refusal contract", async () => {
      const refusal = {
        outcome: "rejected" as const,
        reason: "steer-capacity-exceeded" as const,
        requestId: "steer-full",
      };
      mockSteerClaudeSession.mockResolvedValueOnce(refusal);
      const res = await jsonRequest("POST", "/session/s-1/steer", {
        input: "Follow up",
        requestId: "steer-full",
        expectedRunId: "run-1",
      });
      expect(res.status).toBe(429);
      expect(await jsonBody(res)).toEqual(refusal);
    });

    test("reports an idle session without starting a turn", async () => {
      mockSteerClaudeSession.mockResolvedValueOnce("idle");
      const res = await jsonRequest("POST", "/session/s-1/steer", {
        input: "Follow up",
        requestId: "steer-idle",
        expectedRunId: "run-idle",
      });

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ outcome: "idle" });
    });
  });

  // --- POST /session/:id/abort ---
  describe("POST /session/:id/abort", () => {
    test("returns the graceful interrupt receipt", async () => {
      const res = await jsonRequest("POST", "/session/s-1/abort");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ status: "interrupt-requested", stillQueued: [] });
    });

    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/abort");
      expect(res.status).toBe(404);
    });

    test("returns not_running when the session has no active query", async () => {
      mockGracefulInterruptClaudeSession.mockResolvedValueOnce({
        interrupted: false,
        stillQueued: [],
      });
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

  // --- GET /session/:id/dispatch ---
  describe("GET /session/:id/dispatch", () => {
    test("reports a turn this process is running or has finished", async () => {
      for (const state of ["processing", "already-processed"] as const) {
        mockGetPromptDispatchState.mockReturnValueOnce(state);
        const res = await app.request("/session/s-1/dispatch?requestId=r-1");
        expect(res.status).toBe(200);
        expect(await jsonBody(res)).toEqual({
          dispatch: "dispatched",
          pending: state === "processing",
        });
      }
      expect(mockGetPromptDispatchState).toHaveBeenCalledWith("s-1", "r-1");
    });

    test("never reports a lost record as proof the prompt was not sent", async () => {
      // "new" and "not-found" cannot distinguish a prompt that was never sent
      // from one sent to a bridge process that has since restarted, and calling
      // the second never-sent would have the caller run the turn twice.
      for (const state of ["new", "not-found"] as const) {
        mockGetPromptDispatchState.mockReturnValueOnce(state);
        const res = await app.request("/session/s-1/dispatch?requestId=r-1");
        expect(res.status).toBe(200);
        expect(await jsonBody(res)).toEqual({ dispatch: "unknown" });
      }
    });

    test("answers lost for an id an earlier process claimed, exactly where the prompt route answers 410", async () => {
      const restored = {
        id: "s-1",
        dispatchedRequestIds: new Set(["before-restart", "idle-steer", "claimed-here"]),
        restoredDispatchedRequestIds: new Set(["before-restart", "idle-steer"]),
        // An idle `/steer` answered locally keeps its reply row, so it never
        // ran a turn a restart could have lost.
        localTranscript: [{ id: "idle-steer:idle-steer" }],
      };
      mockPeekSession.mockImplementation((id: string) =>
        id === "s-1" ? (restored as never) : undefined,
      );
      try {
        const read = async (requestId: string) =>
          jsonBody(await app.request(`/session/s-1/dispatch?requestId=${requestId}`));
        expect(await read("before-restart")).toEqual({ dispatch: "lost" });
        expect(await read("idle-steer")).toEqual({ dispatch: "unknown" });
        // Claimed by this process and still persisting: not lost.
        expect(await read("claimed-here")).toEqual({ dispatch: "unknown" });
        expect(await read("never-seen")).toEqual({ dispatch: "unknown" });

        // A turn this process is running or finished under a restored id still
        // reports dispatched: an explicit positive wins.
        for (const state of ["processing", "already-processed"] as const) {
          mockGetPromptDispatchState.mockReturnValueOnce(state);
          expect(await read("before-restart")).toEqual({
            dispatch: "dispatched",
            pending: state === "processing",
          });
        }
        expect(mockPersistedDispatchStatus).not.toHaveBeenCalled();
        // Read-only: never the touching or hydrating lookups.
        expect(mockGetSession).not.toHaveBeenCalled();
        expect(mockEnsurePersistedSession).not.toHaveBeenCalled();
      } finally {
        mockPeekSession.mockImplementation((id: string) =>
          id === "s-health"
            ? ({ id, lastAccessedAt: 123, health: runtimeHealth } as never)
            : undefined,
        );
      }
    });

    test("answers absent only from a resident session whose journal is complete", async () => {
      const resident = {
        id: "s-1",
        dispatchJournalComplete: true,
        dispatchedRequestIds: new Set(["claimed-here", "idle-steer"]),
        restoredDispatchedRequestIds: new Set(["before-restart"]),
        structuredOutputRequestId: "structured-slot",
        localTranscript: [{ id: "idle-steer:idle-steer" }],
      };
      mockPeekSession.mockImplementation((id: string) =>
        id === "s-1" ? (resident as never) : undefined,
      );
      try {
        const read = async (requestId: string) =>
          jsonBody(await app.request(`/session/s-1/dispatch?requestId=${requestId}`));
        expect(await read("never-sent")).toEqual({ dispatch: "absent" });
        expect(await read("before-restart")).toEqual({ dispatch: "lost" });
        expect(await read("claimed-here")).toEqual({ dispatch: "unknown" });
        expect(await read("idle-steer")).toEqual({ dispatch: "unknown" });
        expect(await read("structured-slot")).toEqual({ dispatch: "unknown" });
        // A journal that dropped an id, or could not be read, proves nothing.
        resident.dispatchJournalComplete = false;
        expect(await read("never-sent")).toEqual({ dispatch: "unknown" });
        Object.assign(resident, {
          dispatchJournalComplete: true,
          dispatchJournalUnavailable: true,
        });
        expect(await read("never-sent")).toEqual({ dispatch: "unknown" });
        Object.assign(resident, { dispatchJournalUnavailable: false, deleting: true });
        expect(await read("never-sent")).toEqual({ dispatch: "unknown" });
        expect(mockPersistedDispatchStatus).not.toHaveBeenCalled();
        expect(mockGetSession).not.toHaveBeenCalled();
      } finally {
        mockPeekSession.mockImplementation((id: string) =>
          id === "s-health"
            ? ({ id, lastAccessedAt: 123, health: runtimeHealth } as never)
            : undefined,
        );
      }
    });

    test("answers a session this process has not registered from its durable journal", async () => {
      mockGetPromptDispatchState.mockImplementation(() => "not-found");
      mockPersistedDispatchStatus.mockImplementation(async (_id, requestId) =>
        requestId === "before-restart" ? "lost" : requestId === "never-sent" ? "absent" : "unknown",
      );
      const lost = await app.request("/session/s-cold/dispatch?requestId=before-restart");
      expect(await jsonBody(lost)).toEqual({ dispatch: "lost" });
      expect(mockPersistedDispatchStatus).toHaveBeenCalledWith("s-cold", "before-restart");
      const absent = await app.request("/session/s-cold/dispatch?requestId=never-sent");
      expect(await jsonBody(absent)).toEqual({ dispatch: "absent" });
      const unknown = await app.request("/session/s-cold/dispatch?requestId=other");
      expect(await jsonBody(unknown)).toEqual({ dispatch: "unknown" });
      // A failed read is not evidence either way.
      mockPersistedDispatchStatus.mockImplementation(async () => {
        throw new Error("unreadable");
      });
      const failed = await app.request("/session/s-cold/dispatch?requestId=before-restart");
      expect(await jsonBody(failed)).toEqual({ dispatch: "unknown" });
      expect(mockEnsurePersistedSession).not.toHaveBeenCalled();
    });

    test("answers a blank request id without consulting dispatch state", async () => {
      mockGetPromptDispatchState.mockClear();
      for (const query of ["", "?requestId=", "?requestId=%20%20"]) {
        const res = await app.request(`/session/s-1/dispatch${query}`);
        expect(res.status).toBe(200);
        expect(await jsonBody(res)).toEqual({ dispatch: "unknown" });
      }
      expect(mockGetPromptDispatchState).not.toHaveBeenCalled();
    });

    test("is not shadowed by GET /session/:id", async () => {
      mockGetPromptDispatchState.mockReturnValueOnce("processing");
      const res = await app.request("/session/s-1/dispatch?requestId=r-1");
      expect(await jsonBody(res)).toEqual({ dispatch: "dispatched", pending: true });
    });
  });

  // --- GET /session/:id/activity ---
  describe("GET /session/:id/activity", () => {
    test("returns the session's activity state", async () => {
      const res = await app.request("/session/s-1/activity");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        activity: "working",
        contentRevision: expect.any(String),
      });
      expect(mockGetSessionActivity).toHaveBeenCalledWith("s-1");
    });

    test("reports that input is ready independently of continuing work", async () => {
      mockPeekSession.mockImplementationOnce(
        () => ({ id: "s-1", status: "idle", messages: [] }) as ReturnType<typeof mockPeekSession>,
      );
      const res = await app.request("/session/s-1/activity");

      expect(await jsonBody(res)).toEqual({
        activity: "working",
        readyForInput: true,
        completionPending: false,
        contentRevision: expect.any(String),
      });
    });

    test("withholds readiness while the session still holds a turn", async () => {
      for (const status of ["running", "failed"] as const) {
        mockPeekSession.mockImplementationOnce(
          () => ({ id: "s-1", status, messages: [] }) as ReturnType<typeof mockPeekSession>,
        );
        const res = await app.request("/session/s-1/activity");

        expect(await jsonBody(res)).toEqual({
          activity: "working",
          contentRevision: expect.any(String),
        });
      }
    });

    test("withholds readiness for a session this process is not holding", async () => {
      mockPeekSession.mockImplementationOnce(() => undefined);
      const res = await app.request("/session/s-1/activity");

      expect(await jsonBody(res)).toEqual({
        activity: "working",
        contentRevision: expect.any(String),
      });
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
      expect(await jsonBody(res)).toEqual({
        activity: "waiting",
        contentRevision: expect.any(String),
      });
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

      const res = await jsonRequest("POST", "/session/s-1/questions/q-1/answer", {
        answers: [["blue"]],
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("answered");

      expect(mockAnswerQuestion).toHaveBeenCalledTimes(1);
      const callArgs = mockAnswerQuestion.mock.calls[0];
      expect(callArgs[0]).toBe("q-1");
      expect(callArgs[1]).toEqual({ "Pick a color": "blue" });
    });

    test("does not write answer content to bridge logs", async () => {
      const secretAnswer = "private-answer-that-must-not-be-logged";
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-private",
          sessionId: "s-1",
          questions: [
            {
              question: "Private question",
              header: "Private",
              options: [],
            },
          ],
        },
      ]);
      const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
      configureLogger({ areaLevels: { "bridge.claude": "debug" } });

      try {
        const res = await jsonRequest("POST", "/session/s-1/questions/q-private/answer", {
          answers: [[secretAnswer]],
        });

        expect(res.status).toBe(200);
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secretAnswer);
        expect(debugSpy).toHaveBeenCalledWith(
          "[bridge.claude] question.answers-prepared questionId=q-private questionCount=1 answerCount=1",
        );
      } finally {
        configureLogger({ areaLevels: {} });
        debugSpy.mockRestore();
      }
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

      const res = await jsonRequest("POST", "/session/s-1/questions/q-2/answer", {
        answers: [["TypeScript, strict", "Python"]],
      });
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

      const res = await jsonRequest("POST", "/session/s-1/questions/q-option-custom/answer", {
        answers: [["Red", "Magenta, with sparkle 🦊"]],
      });
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

      const res = await jsonRequest("POST", "/session/s-1/questions/q-3/answer", {
        answers: [["a"], ["b"]],
      });
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
      const res = await jsonRequest("POST", "/session/s-1/questions/q-1/answer", {});
      expect(res.status).toBe(400);
    });

    test("returns 400 when answers is not an array", async () => {
      const res = await jsonRequest("POST", "/session/s-1/questions/q-1/answer", {
        answers: "not-an-array",
      });
      expect(res.status).toBe(400);
    });

    test("rejects malformed nested answers without resolving the question", async () => {
      const pending = {
        id: "q-malformed",
        sessionId: "s-1",
        questions: [{ question: "Pick?", header: "P", options: [{ label: "a" }] }],
      };
      for (const answers of [["not-an-array"], [["valid", 42]], [[{ label: "forged" }]]]) {
        mockGetPendingQuestions.mockImplementationOnce(() => [pending]);
        const res = await jsonRequest("POST", "/session/s-1/questions/q-malformed/answer", {
          answers,
        });
        expect(res.status).toBe(400);
      }
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    test("rejects extra question rows and bounded-answer overflows", async () => {
      const pending = {
        id: "q-bounded",
        sessionId: "s-1",
        questions: [{ question: "Pick?", header: "P", options: [{ label: "a" }] }],
      };
      const invalidAnswers = [
        [[]],
        [["a"], ["extra"]],
        [Array.from({ length: 17 }, (_, index) => `answer-${index}`)],
        [["x".repeat(16_385)]],
      ];
      for (const answers of invalidAnswers) {
        mockGetPendingQuestions.mockImplementationOnce(() => [pending]);
        const res = await jsonRequest("POST", "/session/s-1/questions/q-bounded/answer", {
          answers,
        });
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
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-oversized",
          sessionId: "s-1",
          questions,
        },
      ]);
      const answers = questions.map(() =>
        // Large enough to exceed the semantic 256 KiB answer limit, but small
        // enough to pass the request-body cap and exercise this validator.
        Array.from({ length: 16 }, () => "x".repeat(1_021)),
      );
      const res = await jsonRequest("POST", "/session/s-1/questions/q-oversized/answer", {
        answers,
      });
      expect(res.status).toBe(400);
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    test("rejects an oversized request body before parsing JSON", async () => {
      const oversizedInvalidJson = "{".repeat(
        AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes + 2_048,
      );

      const res = await app.request("/session/s-1/questions/q-oversized-body/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedInvalidJson,
      });

      expect(res.status).toBe(413);
      expect(await jsonBody(res)).toEqual({ error: "Question answer request is too large" });
      expect(mockGetPendingQuestions).not.toHaveBeenCalled();
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    /**
     * 409 + `{status:"stale"}`, matching the Codex bridge's approval contract.
     * 404 would be wrong: it means "no such session", which the UI has to treat
     * as a retryable failure. A window that has closed is neither.
     */
    test("returns 409 stale when the pending question does not exist", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => []);
      const res = await jsonRequest("POST", "/session/s-1/questions/q-missing/answer", {
        answers: [["x"]],
      });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
    });

    test("returns 409 stale when answerQuestion reports the question is gone", async () => {
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-5",
          sessionId: "s-1",
          questions: [{ question: "Stale?", header: "S", options: [{ label: "x" }] }],
        },
      ]);
      mockAnswerQuestion.mockImplementationOnce(() => false);

      const res = await jsonRequest("POST", "/session/s-1/questions/q-5/answer", {
        answers: [["x"]],
      });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toMatchObject({ status: "stale" });
    });

    // Still a 404: the session itself is unknown, which is a genuine error the
    // client must surface rather than silently discard.
    test("returns 404 for unknown session", async () => {
      const res = await jsonRequest("POST", "/session/s-unknown/questions/q-1/answer", {
        answers: [["x"]],
      });
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
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-1",
          sessionId: "s-1",
          questions: [],
        },
      ]);

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
      mockGetPendingQuestions.mockImplementationOnce(() => [
        {
          id: "q-1",
          sessionId: "s-1",
          questions: [],
        },
      ]);
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
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [
        {
          id: "a-1",
          sessionId: "s-1",
          toolUseId: "tool-1",
          plan: "# Complete plan",
        },
      ]);
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: true,
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("approved");
    });

    test("refuses approval when the pending plan is missing or truncated", async () => {
      for (const pending of [
        { id: "a-missing", sessionId: "s-1" },
        {
          id: "a-truncated",
          sessionId: "s-1",
          plan: "# Partial plan…",
          planTruncated: true,
        },
      ]) {
        mockGetPendingPlanApprovals.mockImplementationOnce(() => [pending]);
        const res = await jsonRequest("POST", `/session/s-1/plan-approvals/${pending.id}/respond`, {
          approved: true,
        });
        expect(res.status).toBe(409);
        expect(await jsonBody(res)).toMatchObject({ status: "rejected" });
      }
      expect(mockRespondToPlanApproval).not.toHaveBeenCalled();
    });

    test("returns rejected status with feedback", async () => {
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [
        {
          id: "a-1",
          sessionId: "s-1",
          toolUseId: "tool-1",
        },
      ]);
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: false,
        feedback: "needs work",
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.status).toBe("rejected");
    });

    test("does not write plan feedback to bridge logs", async () => {
      const privateFeedback = "private-plan-feedback-that-must-not-be-logged";
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [
        {
          id: "a-private",
          sessionId: "s-1",
          toolUseId: "tool-private",
        },
      ]);
      const logSpy = spyOn(console, "info").mockImplementation(() => undefined);

      try {
        const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-private/respond", {
          approved: false,
          feedback: privateFeedback,
        });

        expect(res.status).toBe(200);
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain(privateFeedback);
        expect(logSpy).toHaveBeenCalledWith(
          "[bridge.claude] plan-approval.response-received sessionId=s-1 approvalId=a-private approved=false hasFeedback=true",
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    test("returns 400 when approved is not boolean", async () => {
      const res = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: "yes",
      });
      expect(res.status).toBe(400);
    });

    test("rejects non-string and oversized plan feedback before forwarding it", async () => {
      const wrongType = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: false,
        feedback: { secret: "not text" },
      });
      expect(wrongType.status).toBe(400);

      const oversized = await jsonRequest("POST", "/session/s-1/plan-approvals/a-1/respond", {
        approved: false,
        feedback: "x".repeat(AGENT_INTERACTION_LIMITS.maxFreeTextBytes + 1),
      });
      expect(oversized.status).toBe(413);
      expect(mockRespondToPlanApproval).not.toHaveBeenCalled();
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
      mockGetPendingPlanApprovals.mockImplementationOnce(() => [
        {
          id: "a-1",
          sessionId: "s-1",
          plan: "# Complete plan",
        },
      ]);
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
    test("reports a restart interruption only beside the failure it explains", async () => {
      const restored = {
        id: "s-1",
        title: "Restored",
        status: "error" as "error" | "idle",
        error: "Claude restarted before this turn finished",
        interruption: "restart" as const,
        interruptedRequestId: "cut-short",
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      };
      mockGetSession.mockImplementation(() => restored as ReturnType<typeof mockGetSession>);

      expect(await jsonBody(await app.request("/session/s-1"))).toMatchObject({
        status: "error",
        error: "Claude restarted before this turn finished",
        interruption: "restart",
        interruptedRequestId: "cut-short",
      });

      // A stale field on a session that is no longer failed explains nothing.
      restored.status = "idle";
      const idle = await jsonBody(await app.request("/session/s-1"));
      expect(idle).not.toHaveProperty("interruption");
      expect(idle).not.toHaveProperty("interruptedRequestId");
      mockGetSession.mockImplementation(defaultGetSession);
    });

    test("reports a read-only turn's missing command sandbox past the turn (todo 0190)", async () => {
      const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
      const review = {
        id: "s-1",
        title: "Review",
        status: "running" as "running" | "idle",
        commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
        readOnlyCommandSandboxOff: reason as string | undefined,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      };
      mockGetSession.mockImplementation(() => review as ReturnType<typeof mockGetSession>);
      const running = await jsonBody(await app.request("/session/s-1"));
      expect(running.readOnlyCommandSandbox).toEqual({ state: "off", reason });
      expect(running.policy).toMatchObject({ id: "coordinator-read-only", sandbox: "none" });
      expect(running.policy.note).toContain(reason);

      review.status = "idle";
      expect(await jsonBody(await app.request("/session/s-1"))).toMatchObject({
        readOnlyCommandSandbox: { state: "off", reason },
      });
      delete review.readOnlyCommandSandboxOff;
      expect(await jsonBody(await app.request("/session/s-1"))).not.toHaveProperty(
        "readOnlyCommandSandbox",
      );
      mockGetSession.mockImplementation(defaultGetSession);
    });

    test("hydrates persisted lifecycle state before serving the authoritative snapshot", async () => {
      const persisted = {
        id: "s-1",
        title: "Persisted",
        status: "idle" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        persistedMessagesLoaded: false,
        backgroundTasks: undefined as
          | Record<
              string,
              {
                id: string;
                toolUseId: string;
                status: "failed";
                error: string;
              }
            >
          | undefined,
      };
      mockGetSession.mockImplementationOnce(() => persisted as ReturnType<typeof mockGetSession>);
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
        rateLimits: [{ label: "5-hour limit", usedPercent: 42 }],
        completionBlockedByBackgroundTasks: true,
        retainedContinuationRequestIds: new Set(["request-1"]),
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
      expect(data.rateLimits).toEqual([{ label: "5-hour limit", usedPercent: 42 }]);
      expect(data.completionBlockedByBackgroundTasks).toBe(true);
      expect(data.retainedContinuationRequestIds).toEqual(["request-1"]);
      expect(data.rewindInProgress).toBe(true);
    });

    test("serves the running turn's activity and thinking estimate", async () => {
      mockGetSession.mockReturnValueOnce({
        id: "s-1",
        title: "Test",
        status: "running" as const,
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
        activity: "compacting",
        thinkingTokens: 1_234,
      } as ReturnType<typeof mockGetSession>);

      const data = await jsonBody(await app.request("/session/s-1"));

      // The backend polls this snapshot, not the event stream, so the
      // indicator only ever reaches the tab from here.
      expect(data.activity).toBe("compacting");
      expect(data.thinkingTokens).toBe(1_234);
    });

    test("reports an empty task set and no rewind for a fresh session", async () => {
      const data = await jsonBody(await app.request("/session/s-1"));
      expect(data.backgroundTasks).toEqual({});
      expect(data.completionBlockedByBackgroundTasks).toBe(false);
      expect(data.retainedContinuationRequestIds).toEqual([]);
      expect(data.rewindInProgress).toBe(false);
    });
  });

  // --- GET /session/:id/messages ---
  describe("GET /session/:id/messages", () => {
    test("hydrates a session whose transcript has not been read yet", async () => {
      mockGetSession.mockReturnValueOnce(undefined as ReturnType<typeof mockGetSession>);
      mockEnsurePersistedSession.mockImplementation(
        async () =>
          ({
            id: "s-persisted",
            title: "From disk",
            status: "idle" as const,
            createdAt: new Date("2026-01-01"),
            lastActivity: new Date("2026-01-01"),
            persistedMessagesLoaded: false,
          }) as Awaited<ReturnType<typeof mockEnsurePersistedSession>>,
      );
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

    test("forwards a materialization failure and allows the next messages request to retry", async () => {
      mockEnsurePersistedSession.mockRejectedValueOnce(
        refusal("conflict", "Session temporarily unavailable"),
      );
      const failed = await app.request("/session/s-persisted/messages");
      expect(failed.status).toBe(409);
      expect(await jsonBody(failed)).toEqual({ error: "Session temporarily unavailable" });

      mockEnsurePersistedSession.mockResolvedValueOnce({
        id: "s-persisted",
        title: "From disk",
        status: "idle",
        createdAt: new Date("2026-01-01"),
        lastActivity: new Date("2026-01-01"),
      });
      const retried = await app.request("/session/s-persisted/messages");
      expect(retried.status).toBe(200);
      expect((await jsonBody(retried)).messages).toEqual(mockGetSessionMessages());
      expect(mockEnsurePersistedSession).toHaveBeenCalledTimes(2);
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
    test("persists backend-owned titles through the neutral title route", async () => {
      const res = await jsonRequest("POST", "/session/s-1/title", {
        title: "First prompt title",
      });
      expect(res.status).toBe(200);
      expect(mockRenameSessionDurably).toHaveBeenCalledWith("s-1", "First prompt title");
    });

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

    const forkRefusals: Array<{
      code: "not_found" | "conflict" | "invalid";
      message: string;
      status: number;
    }> = [
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

    const rewindRefusals: Array<{
      code: "not_found" | "conflict" | "invalid";
      message: string;
      status: number;
    }> = [
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

    test("contains a background compaction rejection after accepting the request", async () => {
      const logged = mock(() => {});
      const originalError = console.error;
      console.error = logged;
      try {
        mockSendPrompt.mockRejectedValueOnce(new Error("provider disconnected"));

        const res = await jsonRequest("POST", "/session/s-1/compact");
        expect(res.status).toBe(202);
        expect(await jsonBody(res)).toEqual({ status: "processing" });
        await Promise.resolve();
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining(
            '[bridge.claude] session.compact-failed error.name=Error error.message="provider disconnected"',
          ),
        );
      } finally {
        console.error = originalError;
      }
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
