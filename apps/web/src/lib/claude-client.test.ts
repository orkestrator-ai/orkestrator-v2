import { afterEach, describe, expect, test, mock, beforeEach } from "bun:test";
import {
  createClient,
  checkHealth,
  getModels,
  createSession,
  listSessions,
  getSession,
  lookupSession,
  getSessionMessages,
  getStructuredOutput,
  shouldReconcileClaudePrompt,
  sendPrompt,
  sendStructuredPrompt,
  abortSession,
  deleteSession,
  forkClaudeSession,
  compactClaudeSession,
  rewindClaudeFiles,
  stopClaudeBackgroundTask,
  getPendingQuestions,
  getPendingPlanApprovals,
  answerQuestion,
  dismissQuestion,
  respondToPlanApproval,
  updateSessionPreferences,
  dismissPromptSuggestion,
  getSlashCommands,
  subscribeToEvents,
  SessionNotFoundError,
  applyClaudeMessagePatch,
  contentFromParts,
  parseClaudeBackgroundTasks,
  parseClaudeContextUsage,
  parseClaudeRateLimits,
  type ClaudeClient,
  type ClaudeMessage,
  type ClaudeMessagePart,
  type ClaudeMessagePatch,
} from "./claude-client";
import { StructuredOutputReadUnavailableError } from "@orkestrator/protocol/structured-output";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

function mockFetchJson(data: unknown, status = 200) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(data), { status })
  ) as unknown as typeof fetch;
}

function mockFetchError() {
  globalThis.fetch = mock(async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number) {
  globalThis.fetch = mock(async () =>
    new Response(null, { status })
  ) as unknown as typeof fetch;
}

describe("claude-client", () => {
  let client: ClaudeClient;

  beforeEach(() => {
    client = createClient("http://127.0.0.1:4001");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    delete window.orkestratorGateway;
    mock.restore();
  });

  describe("createClient", () => {
    test("returns a client with the given base URL", () => {
      const c = createClient("http://localhost:5000");
      expect(c.baseUrl).toBe("http://localhost:5000");
    });

    test("rewrites loopback base URLs through the gateway when enabled", () => {
      window.orkestratorGateway = { enabled: true };

      const c = createClient("http://localhost:5000");

      expect(c.baseUrl).toBe(`${window.location.origin}/__orkestrator/proxy/loopback/5000`);
    });

    test("adds the Claude bridge credential to REST requests", async () => {
      const requests: Array<{ url: string; headers: Headers }> = [];
      globalThis.fetch = mock(async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify({ models: [] }), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const authenticated = createClient(
        "http://127.0.0.1:5000",
        "claude-secret",
      );
      await getModels(authenticated);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://127.0.0.1:5000/config/models");
      expect(requests[0]?.headers.get("x-orkestrator-claude-token"))
        .toBe("claude-secret");
    });
  });

  describe("checkHealth", () => {
    test("returns true when server responds ok", async () => {
      mockFetchJson({ status: "ok" });
      expect(await checkHealth(client)).toBe(true);
    });

    test("returns false when server responds with error status", async () => {
      mockFetchStatus(500);
      expect(await checkHealth(client)).toBe(false);
    });

    test("returns false when fetch throws", async () => {
      mockFetchError();
      expect(await checkHealth(client)).toBe(false);
    });
  });

  describe("getModels", () => {
    test("returns models array on success", async () => {
      mockFetchJson({ models: [{ id: "opus", name: "Opus" }] });
      const models = await getModels(client);
      expect(models).toEqual([{ id: "opus", name: "Opus" }]);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      const models = await getModels(client);
      expect(models).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      const models = await getModels(client);
      expect(models).toEqual([]);
    });
  });

  describe("createSession", () => {
    test("returns session data on success", async () => {
      mockFetchJson({ sessionId: "s-1", title: "Test" }, 201);
      const result = await createSession(client, "Test");
      expect(result).toEqual({ sessionId: "s-1", title: "Test" });
    });

    test("returns null on non-ok response", async () => {
      mockFetchStatus(500);
      const result = await createSession(client);
      expect(result).toBeNull();
    });

    test("returns null on network error", async () => {
      mockFetchError();
      const result = await createSession(client);
      expect(result).toBeNull();
    });
  });

  describe("listSessions", () => {
    test("returns sessions array on success", async () => {
      const sessions = [{ id: "s-1", title: "A", status: "idle" as const, createdAt: "2026-01-01", lastActivity: "2026-01-01" }];
      mockFetchJson({ sessions });
      const result = await listSessions(client);
      expect(result).toEqual(sessions);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      expect(await listSessions(client)).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await listSessions(client)).toEqual([]);
    });
  });

  describe("getSession", () => {
    test("returns session details on success", async () => {
      const session = { id: "s-1", title: "A", status: "idle" as const, createdAt: "2026-01-01", lastActivity: "2026-01-01" };
      mockFetchJson(session);
      const result = await getSession(client, "s-1");
      expect(result).toEqual(session);
      await expect(lookupSession(client, "s-1")).resolves.toEqual({
        kind: "found",
        session,
      });
    });

    test("returns null on 404", async () => {
      mockFetchStatus(404);
      expect(await getSession(client, "s-missing")).toBeNull();
    });

    test("returns null on network error", async () => {
      mockFetchError();
      expect(await getSession(client, "s-1")).toBeNull();
    });

    test("distinguishes missing sessions from an unavailable bridge", async () => {
      mockFetchStatus(404);
      await expect(lookupSession(client, "s-missing")).resolves.toEqual({
        kind: "missing",
      });

      mockFetchStatus(503);
      const unavailableHttp = await lookupSession(client, "s-1");
      expect(unavailableHttp.kind).toBe("unavailable");
      if (unavailableHttp.kind === "unavailable") {
        expect(unavailableHttp.error.message).toContain("HTTP 503");
      }

      mockFetchError();
      const unavailableTransport = await lookupSession(client, "s-1");
      expect(unavailableTransport.kind).toBe("unavailable");
      if (unavailableTransport.kind === "unavailable") {
        expect(unavailableTransport.error.message).toBe("network error");
      }

      mockFetchJson({ id: "s-1", status: "paused" });
      const unavailableMalformed = await lookupSession(client, "s-1");
      expect(unavailableMalformed.kind).toBe("unavailable");
      if (unavailableMalformed.kind === "unavailable") {
        expect(unavailableMalformed.error.message).toContain("malformed");
      }
    });

    test("sanitizes malformed optional metadata without rejecting the core session", async () => {
      const base = {
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
      };

      // Whole-field rejections: the required usage triple is broken, the
      // suggestion is not a string, the task record is not a record.
      for (const [malformed, expectedField] of [
        [
          { contextUsage: { usedTokens: 1, totalTokens: 10, percentUsed: Number.NaN } },
          "contextUsage",
        ],
        [{ promptSuggestion: { text: "not a string" } }, "promptSuggestion"],
        [{ planMode: "yes" }, "planMode"],
        [{ backgroundTasks: "none" }, "backgroundTasks"],
      ] as const) {
        mockFetchJson({ ...base, ...malformed });
        const result = await lookupSession(client, "s-1");
        expect(result.kind).toBe("found");
        if (result.kind === "found") {
          expect(result.session).toMatchObject(base);
          expect(result.session.contextUsage).toBeUndefined();
          expect(result.session.promptSuggestion).toBeUndefined();
          expect(result.session.planMode).toBeUndefined();
          expect(result.session.backgroundTasks).toBeUndefined();
          expect(result.session.invalidMetadataFields).toEqual([expectedField]);
        }
      }
    });

    test("keeps the core usage reading and names a dropped optional decoration", async () => {
      mockFetchJson({
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        contextUsage: {
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
          // The bridge forwards utilization unclamped, so this can exceed 100.
          rateLimits: [{ label: "five hour", usedPercent: 120 }],
        },
        backgroundTasks: {
          build: { id: "build", status: "running" },
          broken: { id: "mismatch", status: "running" },
        },
      });

      const result = await lookupSession(client, "s-1");
      expect(result.kind).toBe("found");
      if (result.kind === "found") {
        expect(result.session.contextUsage).toEqual({
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
        });
        expect(result.session.backgroundTasks).toEqual({
          build: { id: "build", status: "running" },
        });
        expect(result.session.invalidMetadataFields).toEqual([
          "contextUsage.rateLimits",
          "backgroundTasks.broken",
        ]);
      }
    });

    test("rehydrates authoritative top-level rate limits into context usage", async () => {
      mockFetchJson({
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        contextUsage: {
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
          rateLimits: [{ label: "Five Hour" }],
        },
        rateLimits: [
          { label: "Five Hour", usedPercent: 11 },
          {
            label: "Weekly",
            usedPercent: 13,
            resetsAt: "2026-08-04T10:00:00.000Z",
          },
        ],
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: {
          rateLimits: [
            { label: "Five Hour", usedPercent: 11 },
            {
              label: "Weekly",
              usedPercent: 13,
              resetsAt: "2026-08-04T10:00:00.000Z",
            },
          ],
          contextUsage: {
            rateLimits: [
              { label: "Five Hour", usedPercent: 11 },
              {
                label: "Weekly",
                usedPercent: 13,
                resetsAt: "2026-08-04T10:00:00.000Z",
              },
            ],
          },
        },
      });
    });

    test("preserves top-level rate limits before context usage exists", async () => {
      mockFetchJson({
        id: "s-1",
        status: "running",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        rateLimits: [{
          label: "Five Hour",
          usedPercent: 17,
          resetsAt: "2026-08-04T10:00:00.000Z",
          windowMinutes: 300,
        }],
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: {
          contextUsage: undefined,
          rateLimits: [{
            label: "Five Hour",
            usedPercent: 17,
            resetsAt: "2026-08-04T10:00:00.000Z",
            windowMinutes: 300,
          }],
        },
      });
    });

    test("treats an empty top-level rate-limit snapshot as authoritative", async () => {
      mockFetchJson({
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        contextUsage: {
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
          rateLimits: [{ label: "Stale" }],
        },
        rateLimits: [],
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: {
          rateLimits: [],
          contextUsage: {
            usedTokens: 1,
            totalTokens: 10,
            percentUsed: 10,
          },
        },
      });
      if (result.kind === "found") {
        expect(result.session.contextUsage).not.toHaveProperty("rateLimits");
        expect(result.session.invalidMetadataFields).toBeUndefined();
      }
    });

    test("keeps valid top-level windows from a partial snapshot and reports the drop", async () => {
      mockFetchJson({
        id: "s-1",
        status: "running",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        contextUsage: {
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
          rateLimits: [{ label: "Stale" }],
        },
        rateLimits: [
          { label: "Five Hour", usedPercent: 18, windowMinutes: 300 },
          { label: "Broken", usedPercent: 101 },
        ],
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: {
          rateLimits: [
            { label: "Five Hour", usedPercent: 18, windowMinutes: 300 },
          ],
          contextUsage: {
            rateLimits: [
              { label: "Five Hour", usedPercent: 18, windowMinutes: 300 },
            ],
          },
          invalidMetadataFields: ["rateLimits"],
        },
      });
    });

    test("reports a malformed top-level snapshot without replacing nested limits", async () => {
      mockFetchJson({
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        contextUsage: {
          usedTokens: 1,
          totalTokens: 10,
          percentUsed: 10,
          rateLimits: [{ label: "Nested", usedPercent: 7 }],
        },
        rateLimits: "not-an-array",
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: {
          rateLimits: undefined,
          contextUsage: {
            rateLimits: [{ label: "Nested", usedPercent: 7 }],
          },
          invalidMetadataFields: ["rateLimits"],
        },
      });
    });

    test("propagates a valid plan-mode preference", async () => {
      mockFetchJson({
        id: "s-1",
        status: "idle",
        createdAt: "2026-01-01",
        lastActivity: "2026-01-01",
        planMode: true,
      });

      const result = await lookupSession(client, "s-1");
      expect(result).toMatchObject({
        kind: "found",
        session: { planMode: true },
      });
    });
  });

  describe("session preferences and prompt suggestions", () => {
    test("updates plan mode with the expected authenticated bridge request", async () => {
      let request: Request | undefined;
      globalThis.fetch = mock(async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ planMode: true }), { status: 200 });
      }) as unknown as typeof fetch;

      const authenticatedClient = createClient(
        "http://127.0.0.1:4001",
        "bridge-token",
      );
      await updateSessionPreferences(
        authenticatedClient,
        "session-1",
        { planMode: true },
      );

      expect(request?.url).toBe(
        "http://127.0.0.1:4001/session/session-1/preferences",
      );
      expect(request?.method).toBe("PUT");
      expect(request?.headers.get("X-Orkestrator-Claude-Token")).toBe(
        "bridge-token",
      );
      expect(await request?.json()).toEqual({ planMode: true });
    });

    test("reports preference update failures", async () => {
      mockFetchStatus(503);
      await expect(
        updateSessionPreferences(client, "session-1", { planMode: false }),
      ).rejects.toThrow("HTTP 503");
    });

    test("dismisses suggestions and treats an already-missing suggestion as success", async () => {
      const requests: Request[] = [];
      globalThis.fetch = mock(async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: requests.length === 1 ? 204 : 404 });
      }) as unknown as typeof fetch;

      const authenticatedClient = createClient(
        "http://127.0.0.1:4001",
        "bridge-token",
      );
      await dismissPromptSuggestion(authenticatedClient, "session-1");
      await dismissPromptSuggestion(authenticatedClient, "session-1");
      expect(requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
      expect(
        requests.every(
          (request) =>
            request.headers.get("X-Orkestrator-Claude-Token") === "bridge-token",
        ),
      ).toBe(true);
    });

    test("reports non-404 suggestion dismissal failures", async () => {
      mockFetchStatus(500);
      await expect(
        dismissPromptSuggestion(client, "session-1"),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("Claude metadata validators", () => {
    const usage = {
      usedTokens: 25,
      totalTokens: 100,
      percentUsed: 25,
      inputTokens: 20,
      outputTokens: 5,
      source: "claude" as const,
      rateLimits: [{ label: "five hour", usedPercent: 50 }],
      credits: { hasCredits: true, balance: "10.00" },
      contextCategories: [{ name: "system", tokens: 10 }],
    };

    test("accepts complete finite usage", () => {
      expect(parseClaudeContextUsage(usage)).toEqual(usage);
    });

    test("accepts every optional usage metadata branch", () => {
      const complete = {
        usedTokens: 25,
        totalTokens: 100,
        percentUsed: 25,
        modelId: "claude-opus-4-1",
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        lastTurnTokens: 34,
        sessionTokens: 89,
        costUsd: 1.25,
        durationMs: 10_000,
        apiDurationMs: 9_000,
        permissionDenials: 1,
        linesAdded: 12,
        linesRemoved: 3,
        estimated: false,
        source: "provider" as const,
        updatedAt: "2026-07-28T12:00:00.000Z",
        rateLimits: [{
          label: "Five Hour",
          usedPercent: 21,
          resetsAt: "2026-07-28T17:00:00.000Z",
          windowMinutes: 300,
        }],
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "10.00",
        },
        contextCategories: [{
          name: "system",
          tokens: 10,
          color: "#abcdef",
        }],
      };

      expect(parseClaudeContextUsage(complete)).toEqual(complete);
    });

    test("drops malformed string, boolean, and category metadata independently", () => {
      const dropped: string[] = [];
      expect(parseClaudeContextUsage({
        ...usage,
        modelId: 42,
        updatedAt: false,
        estimated: "no",
        contextCategories: "system",
      }, dropped)).toEqual({
        ...usage,
        contextCategories: undefined,
      });
      expect(dropped.sort()).toEqual([
        "contextCategories",
        "estimated",
        "modelId",
        "updatedAt",
      ]);
    });

    test("rejects only the required numeric triple", () => {
      expect(parseClaudeContextUsage({ ...usage, percentUsed: Number.POSITIVE_INFINITY }))
        .toBeUndefined();
      expect(parseClaudeContextUsage({ ...usage, percentUsed: 101 })).toBeUndefined();
      expect(parseClaudeContextUsage({ ...usage, usedTokens: -1 })).toBeUndefined();
      // An overdrawn core reading is a broken triple, not a droppable extra:
      // the meter itself would be lying.
      expect(parseClaudeContextUsage({ ...usage, usedTokens: 101 })).toBeUndefined();
      expect(parseClaudeContextUsage({ ...usage, totalTokens: 0 })).toBeUndefined();
    });

    test("accepts the boundary values the bridge legitimately reports", () => {
      expect(parseClaudeContextUsage({ ...usage, percentUsed: 100 })).toMatchObject({
        percentUsed: 100,
      });
      expect(parseClaudeContextUsage({
        ...usage,
        rateLimits: [{ label: "five hour", usedPercent: 100 }],
      })).toMatchObject({
        rateLimits: [{ label: "five hour", usedPercent: 100 }],
      });
      // usedTokens === totalTokens is a full-but-valid window.
      expect(parseClaudeContextUsage({ ...usage, usedTokens: 100 })).toMatchObject({
        usedTokens: 100,
        totalTokens: 100,
      });
    });

    test("drops an out-of-range rate-limit window but keeps the reading", () => {
      const dropped: string[] = [];
      // The bridge forwards utilization unclamped, so >100 does happen.
      expect(parseClaudeContextUsage({
        ...usage,
        rateLimits: [
          { label: "five hour", usedPercent: 101 },
          { label: "weekly", usedPercent: 20 },
        ],
      }, dropped)).toEqual({
        ...usage,
        rateLimits: [{ label: "weekly", usedPercent: 20 }],
      });
      expect(dropped).toEqual(["rateLimits"]);
    });

    test("validates standalone rate-limit snapshots with drop-not-reject semantics", () => {
      expect(parseClaudeRateLimits(undefined)).toBeUndefined();
      expect(parseClaudeRateLimits([])).toEqual([]);

      const malformedSnapshot: string[] = [];
      expect(parseClaudeRateLimits("not-an-array", malformedSnapshot))
        .toBeUndefined();
      expect(malformedSnapshot).toEqual(["rateLimits"]);

      const partialSnapshot: string[] = [];
      expect(parseClaudeRateLimits([
        {
          label: "Weekly",
          usedPercent: 15,
          resetsAt: "2026-08-04T10:00:00.000Z",
          windowMinutes: 10_080,
        },
        null,
        { label: "Broken", windowMinutes: -1 },
      ], partialSnapshot)).toEqual([{
        label: "Weekly",
        usedPercent: 15,
        resetsAt: "2026-08-04T10:00:00.000Z",
        windowMinutes: 10_080,
      }]);
      expect(partialSnapshot).toEqual(["rateLimits"]);
    });

    test("drops other malformed optional decorations individually", () => {
      const dropped: string[] = [];
      expect(parseClaudeContextUsage({
        ...usage,
        inputTokens: "20",
        contextCategories: [{ name: "system", tokens: -1 }],
        credits: { hasCredits: "yes" },
        source: "telepathy",
      }, dropped)).toEqual({
        usedTokens: 25,
        totalTokens: 100,
        percentUsed: 25,
        outputTokens: 5,
        rateLimits: usage.rateLimits,
      });
      expect(dropped.sort()).toEqual([
        "contextCategories",
        "credits",
        "inputTokens",
        "source",
      ]);
    });

    test("keeps valid background tasks while dropping malformed ones", () => {
      const tasks = {
        build: {
          id: "build",
          description: "Run build",
          status: "running" as const,
          startedAt: 100,
        },
      };
      expect(parseClaudeBackgroundTasks(tasks)).toEqual(tasks);

      const dropped: string[] = [];
      expect(parseClaudeBackgroundTasks({
        ...tasks,
        mismatch: { id: "other", status: "running" },
        clock: { id: "clock", status: "running", startedAt: Number.NaN },
      }, dropped)).toEqual(tasks);
      expect(dropped.sort()).toEqual(["clock", "mismatch"]);

      // Only a value that is not a record at all rejects the snapshot.
      expect(parseClaudeBackgroundTasks("none")).toBeUndefined();
      expect(parseClaudeBackgroundTasks(null)).toBeUndefined();
    });

    test("preserves optional background-task fields and drops primitive entries", () => {
      const complete = {
        id: "build",
        toolUseId: "agent-tool-1",
        description: "Run build",
        status: "failed" as const,
        isBackgrounded: true,
        startedAt: 100,
        endedAt: 200,
        error: "command failed",
      };
      const dropped: string[] = [];
      expect(parseClaudeBackgroundTasks({
        build: complete,
        primitive: 17,
      }, dropped)).toEqual({ build: complete });
      expect(dropped).toEqual(["primitive"]);
    });

    test("rejects each malformed optional background-task field", () => {
      const dropped: string[] = [];
      expect(parseClaudeBackgroundTasks({
        description: { id: "description", status: "running", description: 1 },
        toolUseId: { id: "toolUseId", status: "running", toolUseId: 1 },
        backgrounded: { id: "backgrounded", status: "running", isBackgrounded: "yes" },
        ended: { id: "ended", status: "completed", endedAt: Number.POSITIVE_INFINITY },
        error: { id: "error", status: "failed", error: false },
        emptyId: { id: "", status: "pending" },
        status: { id: "status", status: "unknown" },
      }, dropped)).toEqual({});
      expect(dropped.sort()).toEqual([
        "backgrounded",
        "description",
        "emptyId",
        "ended",
        "error",
        "status",
        "toolUseId",
      ]);
    });
  });

  describe("getSessionMessages", () => {
    test("returns messages on success", async () => {
      mockFetchJson({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolArgs: { todos: [{ content: "task", status: "in_progress" }] },
              toolState: "success",
            }],
            timestamp: "2026-03-10T11:00:00.000Z",
          },
        ],
      });
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe("msg-1");
    });

    test("returns messages as-is when no TodoWrite parts exist", async () => {
      mockFetchJson({
        messages: [{
          id: "msg-1",
          role: "assistant",
          content: "Hello",
          parts: [{ type: "tool-invocation", toolName: "Read", toolArgs: { file_path: "/foo" }, toolState: "success" }],
          timestamp: "2026-03-10T11:00:00.000Z",
        }],
      });
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe("msg-1");
    });

    test("throws SessionNotFoundError on 404", async () => {
      mockFetchStatus(404);
      expect(getSessionMessages(client, "s-missing")).rejects.toThrow(SessionNotFoundError);
    });

    test("returns empty array on non-404 error status", async () => {
      mockFetchStatus(500);
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toEqual([]);
    });

    test("throws on non-404 error status when strict refresh is requested", async () => {
      mockFetchStatus(500);
      expect(
        getSessionMessages(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("sendPrompt", () => {
    test("keeps ambiguous dispatches locked for authoritative reconciliation", () => {
      expect(shouldReconcileClaudePrompt({
        ok: false,
        outcome: "unknown",
        requestId: "request-1",
      })).toBe(true);
      expect(shouldReconcileClaudePrompt({
        ok: false,
        outcome: "rejected",
        requestId: "request-1",
        httpStatus: 409,
      })).toBe(false);
      expect(shouldReconcileClaudePrompt(true)).toBe(true);
      expect(shouldReconcileClaudePrompt(false)).toBe(false);
    });

    test("returns the accepted request identity on 202", async () => {
      mockFetchJson({ status: "processing" }, 202);
      const result = await sendPrompt(client, "s-1", "Hello");
      expect(result).toMatchObject({
        ok: true,
        outcome: "accepted",
        status: "processing",
        requestId: expect.any(String),
      });
    });

    /**
     * Asserted as a whole body rather than field by field: this is the only
     * place the prompt wire shape is pinned, so a per-field assertion silently
     * tolerates an option being dropped from the request builder.
     */
    test("forwards every prompt option verbatim in the request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ status: "processing" }), { status: 202 });
      }) as unknown as typeof fetch;

      const outputSchema = { type: "object" as const, properties: {} };
      await sendPrompt(client, "s-1", "Hello", {
        effort: "xhigh",
        permissionMode: "auto",
        model: "opus",
        fastMode: true,
        agent: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
        attachments: [{ type: "image", path: "/tmp/a.png", filename: "a.png" }],
        outputSchema,
        requestId: "req-1",
      });

      expect(JSON.parse(capturedBody!)).toEqual({
        prompt: "Hello",
        model: "opus",
        attachments: [{ type: "image", path: "/tmp/a.png", filename: "a.png" }],
        effort: "xhigh",
        permissionMode: "auto",
        fastMode: true,
        agent: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
        outputSchema,
        requestId: "req-1",
      });
    });

    test("omits unset options rather than sending nulls", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ status: "processing" }), { status: 202 });
      }) as unknown as typeof fetch;

      await sendPrompt(client, "s-1", "Hello");

      // `requestId` is the exception: it is always present, because the bridge
      // deduplicates on it and a prompt sent without one can be dispatched twice
      // if its HTTP response is lost.
      const body = JSON.parse(capturedBody!);
      expect(body.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(body).toEqual({ prompt: "Hello", requestId: body.requestId });
    });

    test("sends a distinct request id per call so separate prompts are separate turns", async () => {
      const bodies: string[] = [];
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body as string);
        return new Response(JSON.stringify({ status: "processing" }), { status: 202 });
      }) as unknown as typeof fetch;

      await sendPrompt(client, "s-1", "Hello");
      await sendPrompt(client, "s-1", "Hello");

      const [first, second] = bodies.map((body) => JSON.parse(body).requestId);
      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });

    test("reuses a caller-supplied request id so a retry cannot double-dispatch", async () => {
      const bodies: string[] = [];
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body as string);
        return new Response(JSON.stringify({ status: "processing" }), { status: 202 });
      }) as unknown as typeof fetch;

      await sendPrompt(client, "s-1", "Hello", { requestId: "retry-me" });
      await sendPrompt(client, "s-1", "Hello", { requestId: "retry-me" });

      expect(bodies.map((body) => JSON.parse(body).requestId)).toEqual([
        "retry-me",
        "retry-me",
      ]);
    });

    test("distinguishes a definite HTTP rejection from an ambiguous transport failure", async () => {
      mockFetchStatus(500);
      expect(await sendPrompt(client, "s-1", "Hello", {
        requestId: "rejected-request",
      })).toEqual({
        ok: false,
        outcome: "rejected",
        requestId: "rejected-request",
        httpStatus: 500,
      });

      mockFetchError();
      expect(await sendPrompt(client, "s-1", "Hello", {
        requestId: "ambiguous-request",
      })).toEqual({
        ok: false,
        outcome: "unknown",
        requestId: "ambiguous-request",
      });
    });

    test("surfaces a generated id that a transport-failure retry can reuse", async () => {
      const bodies: string[] = [];
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body as string);
        if (bodies.length === 1) throw new TypeError("response lost");
        return Response.json({ status: "already-processed", duplicate: true });
      }) as unknown as typeof fetch;

      const first = await sendPrompt(client, "s-1", "Hello");
      expect(first.outcome).toBe("unknown");
      const retry = await sendPrompt(client, "s-1", "Hello", {
        requestId: first.requestId,
      });

      expect(retry).toMatchObject({
        ok: true,
        status: "already-processed",
        requestId: first.requestId,
        duplicate: true,
      });
      expect(bodies.map((body) => JSON.parse(body).requestId)).toEqual([
        first.requestId,
        first.requestId,
      ]);
    });
  });

  describe("structured output", () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    test("dispatches the schema and preserves the authoritative request id", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return Response.json({
          status: "already-processed",
          requestId: "bridge-request",
          duplicate: true,
        });
      }) as unknown as typeof fetch;

      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema, {
          requestId: "client-request",
          effort: "high",
        }),
      ).resolves.toEqual({
        status: "already-processed",
        requestId: "bridge-request",
        duplicate: true,
      });
      expect(JSON.parse(capturedBody!)).toEqual({
        requestId: "client-request",
        effort: "high",
        prompt: "Review",
        outputSchema: schema,
      });
    });

    test("returns null when dispatch is rejected or its transport is unavailable", async () => {
      mockFetchStatus(409);
      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema),
      ).resolves.toBeNull();

      mockFetchError();
      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema),
      ).resolves.toBeNull();
    });

    test("reads success, pending, malformed envelopes, and malformed JSON", async () => {
      const success = {
        ok: true,
        provider: "claude",
        requestId: "request/1",
        value: { summary: "done" },
      } as const;
      mockFetchJson({ structuredOutput: success });
      await expect(
        getStructuredOutput(client, "s-1", "request/1"),
      ).resolves.toEqual(success);
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        "http://127.0.0.1:4001/session/s-1/structured-output?requestId=request%2F1",
        expect.anything(),
      );

      mockFetchJson({ structuredOutput: null });
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toBeNull();

      mockFetchJson({ structuredOutput: { ok: true, provider: "claude" } });
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        requestId: "request-1",
        error: { code: "malformed_output" },
      });

      mockFetchJson(null);
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });

      globalThis.fetch = mock(async () =>
        new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
      ) as unknown as typeof fetch;
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });
    });

    test("throws a typed observation error when the result channel is unavailable", async () => {
      mockFetchError();

      const promise = getStructuredOutput(client, "s-1", "request-1");
      await expect(promise).rejects.toBeInstanceOf(StructuredOutputReadUnavailableError);
      await expect(promise).rejects.toMatchObject({
        provider: "claude",
        requestId: "request-1",
        retryable: true,
      });
    });
  });

  describe("abortSession", () => {
    test("returns true on success", async () => {
      mockFetchJson({ status: "aborted" });
      expect(await abortSession(client, "s-1")).toBe(true);
    });

    test("returns false on error", async () => {
      mockFetchError();
      expect(await abortSession(client, "s-1")).toBe(false);
    });
  });

  describe("deleteSession", () => {
    test("returns true on success", async () => {
      mockFetchJson({ status: "deleted" });
      expect(await deleteSession(client, "s-1")).toBe(true);
    });

    test("returns false on 404", async () => {
      mockFetchStatus(404);
      expect(await deleteSession(client, "s-missing")).toBe(false);
    });

    test("returns false on network error", async () => {
      mockFetchError();
      expect(await deleteSession(client, "s-1")).toBe(false);
    });
  });

  describe("session management", () => {
    /** Records `[url, init]` for every call and answers with `response()`. */
    function captureFetch(response: () => Response) {
      const calls: Array<[string, RequestInit | undefined]> = [];
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        return response();
      }) as unknown as typeof fetch;
      return calls;
    }

    describe("forkClaudeSession", () => {
      test("returns the forked session id and title", async () => {
        const calls = captureFetch(() =>
          Response.json({ sessionId: "s-2", title: "Fork" }),
        );

        expect(
          await forkClaudeSession(client, "s-1", {
            upToMessageId: "msg-3",
            title: "Fork",
          }),
        ).toEqual({ sessionId: "s-2", title: "Fork" });
        expect(calls[0]?.[0]).toBe("http://127.0.0.1:4001/session/s-1/fork");
        expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({
          upToMessageId: "msg-3",
          title: "Fork",
        });
      });

      test("omits a title the bridge did not report", async () => {
        mockFetchJson({ sessionId: "s-2" });
        expect(await forkClaudeSession(client, "s-1")).toEqual({
          sessionId: "s-2",
        });
      });

      test("throws rather than binding a tab to an absent session id", async () => {
        // A `200 {}` used to resolve to `{ sessionId: undefined }`, and every
        // later request then addressed the literal string "undefined".
        mockFetchJson({});
        await expect(forkClaudeSession(client, "s-1")).rejects.toThrow(
          "did not include a session id",
        );

        mockFetchJson({ sessionId: "" });
        await expect(forkClaudeSession(client, "s-1")).rejects.toThrow(
          "did not include a session id",
        );

        mockFetchJson({ sessionId: 7 });
        await expect(forkClaudeSession(client, "s-1")).rejects.toThrow(
          "did not include a session id",
        );
      });

      test("throws on a non-2xx response", async () => {
        mockFetchStatus(500);
        await expect(forkClaudeSession(client, "s-1")).rejects.toThrow("HTTP 500");
      });

      test("throws rather than surfacing a malformed body", async () => {
        globalThis.fetch = mock(async () =>
          new Response("not json", { status: 200 }),
        ) as unknown as typeof fetch;
        await expect(forkClaudeSession(client, "s-1")).rejects.toThrow(
          "did not include a session id",
        );
      });
    });

    describe("compactClaudeSession", () => {
      test("posts to the compact endpoint", async () => {
        const calls = captureFetch(() => new Response(null, { status: 200 }));

        expect(await compactClaudeSession(client, "s-1")).toBe(true);
        expect(calls[0]?.[0]).toBe("http://127.0.0.1:4001/session/s-1/compact");
        expect(calls[0]?.[1]?.method).toBe("POST");
      });

      test("reports failure without throwing", async () => {
        mockFetchStatus(409);
        expect(await compactClaudeSession(client, "s-1")).toBe(false);

        mockFetchError();
        expect(await compactClaudeSession(client, "s-1")).toBe(false);
      });
    });

    describe("rewindClaudeFiles", () => {
      test("posts the message id and defaults dryRun to false", async () => {
        const calls = captureFetch(() => Response.json({ reverted: ["a.ts"] }));

        expect(await rewindClaudeFiles(client, "s-1", "msg-3")).toEqual({
          reverted: ["a.ts"],
        });
        expect(calls[0]?.[0]).toBe("http://127.0.0.1:4001/session/s-1/rewind");
        expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({
          messageId: "msg-3",
          dryRun: false,
        });
      });

      test("forwards an explicit dry run", async () => {
        const calls = captureFetch(() => Response.json({}));
        await rewindClaudeFiles(client, "s-1", "msg-3", true);
        expect(JSON.parse(calls[0]?.[1]?.body as string).dryRun).toBe(true);
      });

      test("throws on a non-2xx response", async () => {
        mockFetchStatus(500);
        await expect(rewindClaudeFiles(client, "s-1", "msg-3")).rejects.toThrow(
          "HTTP 500",
        );
      });
    });

    describe("stopClaudeBackgroundTask", () => {
      test("posts to the task stop endpoint", async () => {
        const calls = captureFetch(() => new Response(null, { status: 200 }));

        expect(await stopClaudeBackgroundTask(client, "s-1", "task-1")).toBe(true);
        expect(calls[0]?.[0]).toBe(
          "http://127.0.0.1:4001/session/s-1/tasks/task-1/stop",
        );
        expect(calls[0]?.[1]?.method).toBe("POST");
      });

      test("escapes a task id that would otherwise change the route", async () => {
        const calls = captureFetch(() => new Response(null, { status: 200 }));

        await stopClaudeBackgroundTask(client, "s-1", "task/../../danger?x=1");

        expect(calls[0]?.[0]).toBe(
          "http://127.0.0.1:4001/session/s-1/tasks/task%2F..%2F..%2Fdanger%3Fx%3D1/stop",
        );
      });

      test("reports failure without throwing", async () => {
        mockFetchStatus(404);
        expect(await stopClaudeBackgroundTask(client, "s-1", "task-1")).toBe(false);

        mockFetchError();
        expect(await stopClaudeBackgroundTask(client, "s-1", "task-1")).toBe(false);
      });
    });
  });

  describe("getPendingQuestions", () => {
    test("returns questions array on success", async () => {
      const questions = [{ id: "q-1", sessionId: "s-1", questions: [{ question: "Continue?", header: "", options: [] }] }];
      mockFetchJson({ questions });
      const result = await getPendingQuestions(client, "s-1");
      expect(result).toEqual(questions);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(404);
      expect(await getPendingQuestions(client, "s-1")).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await getPendingQuestions(client, "s-1")).toEqual([]);
    });

    test("can surface refresh failures to strict callers", async () => {
      mockFetchStatus(500);
      await expect(
        getPendingQuestions(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 500");

      globalThis.fetch = mock(async () => {
        throw "non-error question rejection";
      }) as unknown as typeof fetch;
      await expect(
        getPendingQuestions(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("Failed to get pending Claude questions");
    });
  });

  describe("getPendingPlanApprovals", () => {
    test("returns the authoritative approval snapshot", async () => {
      const approvals = [{ id: "approval-1", sessionId: "s-1" }];
      mockFetchJson({ approvals });

      expect(await getPendingPlanApprovals(client, "s-1")).toEqual(approvals);
    });

    test("returns an empty snapshot on ordinary failures and throws in strict mode", async () => {
      mockFetchStatus(503);
      expect(await getPendingPlanApprovals(client, "s-1")).toEqual([]);
      await expect(
        getPendingPlanApprovals(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 503");

      mockFetchError();
      expect(await getPendingPlanApprovals(client, "s-1")).toEqual([]);
      await expect(
        getPendingPlanApprovals(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("network error");

      globalThis.fetch = mock(async () => {
        throw { reason: "non-error approval rejection" };
      }) as unknown as typeof fetch;
      await expect(
        getPendingPlanApprovals(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("Failed to get pending Claude plan approvals");
    });
  });

  describe("subscribeToEvents", () => {
    class MockEventSource {
      static latest: MockEventSource | null = null;
      readonly url: string;
      readonly readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = mock(() => {});
      private listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(url: string) {
        this.url = url;
        MockEventSource.latest = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      get subscribedTypes(): string[] {
        return [...this.listeners.keys()];
      }

      emit(type: string, data: unknown, lastEventId = "") {
        this.listeners.get(type)?.({
          type,
          data: JSON.stringify(data),
          lastEventId,
        } as MessageEvent);
      }
    }

    test("yields parsed events and closes on iterator return", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;
      source.emit("message.updated", { sessionId: "s-1", message: { id: "m-1" } });

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: {
          type: "message.updated",
          sessionId: "s-1",
          data: { sessionId: "s-1", message: { id: "m-1" } },
        },
      });
      await iterator.return?.();
      expect(source.close).toHaveBeenCalledTimes(1);
    });

    test("delivers an event directly to a pending read", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const pending = iterator.next();

      MockEventSource.latest!.emit("keepalive", {
        sessionId: "s-1",
        timestamp: "now",
      });

      await expect(pending).resolves.toMatchObject({
        done: false,
        value: {
          type: "keepalive",
          sessionId: "s-1",
        },
      });
      await iterator.return?.();
    });

    test("adds the bridge credential to the EventSource query", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const authenticated = createClient(
        "http://127.0.0.1:4001",
        "claude secret/with symbols",
      );
      const iterator = subscribeToEvents(authenticated)[Symbol.asyncIterator]();

      const sourceUrl = new URL(MockEventSource.latest!.url);
      expect(sourceUrl.pathname).toBe("/event/subscribe");
      expect(sourceUrl.searchParams.get("token")).toBe(
        "claude secret/with symbols",
      );

      await iterator.return?.();
    });

    test("rejects a pending read on connection failure", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const pending = iterator.next();
      MockEventSource.latest?.onerror?.();

      await expect(pending).rejects.toThrow("SSE connection error");
      expect(MockEventSource.latest?.close).toHaveBeenCalledTimes(1);
    });

    test("subscribes to every event type the bridge emits", async () => {
      // An EventSource only delivers the named types it listened for, so a
      // type missing here is silently dropped — which for `message.patched`
      // would freeze a transcript after its first frame.
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const subscribed = MockEventSource.latest!.subscribedTypes;

      for (const type of [
        "connected",
        "keepalive",
        "replay.required",
        "session.updated",
        "session.idle",
        "session.error",
        "session.init",
        "session.title-updated",
        "session.structured-output",
        "message.updated",
        "message.patched",
        "question.asked",
        "question.answered",
        "plan.enter-requested",
        "plan.exit-requested",
        "plan.approval-requested",
        "plan.approval-responded",
        "system.compact",
        "system.message",
      ]) {
        expect(subscribed).toContain(type);
      }

      await iterator.return?.();
    });

    test("resumes a replacement subscription from the last received cursor", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const cursorClient = {
        ...client,
        baseUrl: "http://127.0.0.1:9876",
      };
      const first = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("keepalive", { timestamp: "now" }, "42");
      await first.next();
      await first.return?.();

      const second = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      expect(MockEventSource.latest?.url).toBe(
        "http://127.0.0.1:9876/event/subscribe?since=42",
      );
      await second.return?.();
    });

    test("retains and URL-encodes an opaque generation cursor", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const cursorClient = {
        ...client,
        baseUrl: "http://127.0.0.1:9877",
      };
      const first = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("keepalive", { timestamp: "now" }, "generation-A:42");
      await first.next();
      await first.return?.();

      const second = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      expect(MockEventSource.latest?.url).toBe(
        "http://127.0.0.1:9877/event/subscribe?since=generation-A%3A42",
      );
      await second.return?.();
    });

    test("never regresses a cursor when an out-of-order frame arrives", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const cursorClient = {
        ...client,
        baseUrl: "http://127.0.0.1:9879",
      };
      const first = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("keepalive", { timestamp: "newer" }, "generation-A:44");
      MockEventSource.latest!.emit("keepalive", { timestamp: "older" }, "generation-A:43");
      await first.next();
      await first.next();
      await first.return?.();

      const second = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      expect(MockEventSource.latest?.url).toBe(
        "http://127.0.0.1:9879/event/subscribe?since=generation-A%3A44",
      );
      await second.return?.();
    });

    test("accepts a lower revision after the bridge generation changes", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const cursorClient = {
        ...client,
        baseUrl: "http://127.0.0.1:9880",
      };
      const first = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("keepalive", {}, "generation-A:44");
      MockEventSource.latest!.emit("keepalive", {}, "generation-B:1");
      await first.next();
      await first.next();
      await first.return?.();

      const second = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      expect(MockEventSource.latest?.url).toBe(
        "http://127.0.0.1:9880/event/subscribe?since=generation-B%3A1",
      );
      await second.return?.();
    });

    test("ignores invalid cursors instead of reflecting them into the URL", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const cursorClient = {
        ...client,
        baseUrl: "http://127.0.0.1:9878",
      };
      const first = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("keepalive", { timestamp: "now" }, "bad cursor?value");
      await first.next();
      await first.return?.();

      const second = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
      expect(MockEventSource.latest?.url).toBe(
        "http://127.0.0.1:9878/event/subscribe",
      );
      await second.return?.();
    });

    test("evicts the least-recently-updated cursor when the cache is full", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const clients = Array.from({ length: 33 }, (_, index) => ({
        ...client,
        baseUrl: `http://127.0.0.1:${10_000 + index}`,
      }));

      for (const [index, cursorClient] of clients.entries()) {
        const iterator = subscribeToEvents(cursorClient)[Symbol.asyncIterator]();
        MockEventSource.latest!.emit(
          "keepalive",
          { timestamp: `${index}` },
          `generation-${index}:1`,
        );
        await iterator.next();
        await iterator.return?.();
      }

      const evicted = subscribeToEvents(clients[0]!)[Symbol.asyncIterator]();
      expect(MockEventSource.latest!.url).toBe(
        "http://127.0.0.1:10000/event/subscribe",
      );
      await evicted.return?.();

      const retained = subscribeToEvents(clients.at(-1)!)[Symbol.asyncIterator]();
      expect(MockEventSource.latest!.url).toBe(
        "http://127.0.0.1:10032/event/subscribe?since=generation-32%3A1",
      );
      await retained.return?.();
    });

    test("an already-aborted signal does not open EventSource", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      MockEventSource.latest = null;
      const controller = new AbortController();
      controller.abort();

      const iterator = subscribeToEvents(client, controller.signal)[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
      await expect(iterator.throw?.(new Error("consumer failed")))
        .rejects.toThrow("consumer failed");
      expect(MockEventSource.latest).toBeNull();
    });

    test("aborting resolves a pending read and cleans up the subscription", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const controller = new AbortController();
      const iterator = subscribeToEvents(
        client,
        controller.signal,
      )[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;
      const pending = iterator.next();

      controller.abort();

      await expect(pending).resolves.toMatchObject({ done: true });
      expect(source.close).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      controller.abort();
      expect(source.close).toHaveBeenCalledTimes(1);
    });

    test("next stays complete after iterator return", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;

      await iterator.return?.();
      source.emit("keepalive", { timestamp: "too late" });

      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      expect(source.close).toHaveBeenCalledTimes(1);
    });

    test("iterator throw rejects and cleans up the subscription", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;
      const failure = new Error("consumer failed");

      await expect(iterator.throw!(failure)).rejects.toBe(failure);

      expect(source.close).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    });

    test("drops malformed event JSON and keeps the subscription usable", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;
      (source as unknown as { listeners: Map<string, (event: MessageEvent) => void> })
        .listeners.get("keepalive")?.({
          type: "keepalive",
          data: "{not-json",
          lastEventId: "10",
        } as MessageEvent);
      source.emit("keepalive", { timestamp: "valid" }, "11");
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: "keepalive", data: { timestamp: "valid" } },
      });
      await iterator.return?.();
    });

    test("yields a patch frame with its revision intact", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      MockEventSource.latest!.emit("message.patched", {
        sessionId: "s-1",
        messageId: "m-1",
        partCount: 1,
        changedParts: [{ index: 0, part: { type: "text", content: "streamed" } }],
        timestamp: "2026-07-20T12:00:00.000Z",
        revision: 7,
      });

      const next = await iterator.next();
      expect(next.value.type).toBe("message.patched");
      expect(next.value.data).toMatchObject({ messageId: "m-1", revision: 7 });
      await iterator.return?.();
    });
  });

  describe("answerQuestion", () => {
    test("returns applied on success", async () => {
      mockFetchJson({ status: "answered" });
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe("applied");
    });

    test("returns error on network failure", async () => {
      mockFetchError();
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe("error");
    });

    // 409 is the bridge saying the window closed; 404 is "no such session",
    // which is a genuine failure the user can act on. Collapsing the two is what
    // made a closed window look like a broken bridge.
    test("maps a closed window to stale and an unknown session to error", async () => {
      mockFetchJson({ error: "Question is no longer pending", status: "stale" }, 409);
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe("stale");

      mockFetchJson({ error: "Session not found" }, 404);
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe("error");

      mockFetchStatus(403);
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe("forbidden");
    });
  });

  describe("dismissQuestion", () => {
    test("returns applied when the bridge accepts the dismissal", async () => {
      mockFetchJson({ status: "dismissed" });
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe("applied");
      // Asserted on url + method only: requests go through `fetchClaude`, which
      // also attaches the bridge auth header and a timeout signal.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${client.baseUrl}/session/s-1/questions/q-1`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    test("distinguishes a stale question from HTTP and network failures", async () => {
      mockFetchJson({ error: "Question is no longer pending", status: "stale" }, 409);
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe("stale");

      mockFetchJson({ error: "gone" }, 404);
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe("error");

      mockFetchError();
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe("error");
    });
  });

  describe("respondToPlanApproval", () => {
    test("returns applied when approved", async () => {
      mockFetchJson({ status: "approved" });
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe("applied");
    });

    test("returns applied when rejected with feedback", async () => {
      mockFetchJson({ status: "rejected" });
      expect(await respondToPlanApproval(client, "s-1", "a-1", false, "needs changes")).toBe("applied");
    });

    test("distinguishes a stale approval from retryable HTTP and network failures", async () => {
      mockFetchJson({ error: "Plan approval is no longer pending", status: "stale" }, 409);
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe("stale");

      // Unknown session, not a closed window: retryable and worth reporting.
      mockFetchStatus(404);
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe("error");

      mockFetchStatus(503);
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe("error");

      mockFetchError();
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe("error");
    });
  });

  describe("getSlashCommands", () => {
    test("returns commands array on success", async () => {
      mockFetchJson({ commands: ["/help", "/clear"] });
      const result = await getSlashCommands(client);
      expect(result).toEqual(["/help", "/clear"]);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      expect(await getSlashCommands(client)).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await getSlashCommands(client)).toEqual([]);
    });

    test("combines the caller signal with the internal timeout signal", async () => {
      const controller = new AbortController();
      let observedSignal: AbortSignal | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }) as unknown as typeof fetch;

      const commands = getSlashCommands(client, controller.signal);
      await Promise.resolve();
      controller.abort();

      expect(await commands).toEqual([]);
      expect(observedSignal?.aborted).toBe(true);
    });
  });

  describe("SessionNotFoundError", () => {
    test("has correct name and message", () => {
      const error = new SessionNotFoundError("s-42");
      expect(error.name).toBe("SessionNotFoundError");
      expect(error.message).toBe("Session not found: s-42");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("contentFromParts", () => {
    test("concatenates only the text parts", () => {
      expect(
        contentFromParts([
          { type: "text", content: "a" },
          { type: "thinking", content: "IGNORED" },
          { type: "tool-invocation", toolName: "Read" },
          { type: "text", content: "b" },
        ]),
      ).toBe("ab");
    });

    test("treats a text part with no content as empty rather than 'undefined'", () => {
      // A streamed block starts with no content at all; stringifying it would
      // put the literal word "undefined" into the transcript.
      expect(contentFromParts([{ type: "text" }, { type: "text", content: "x" }])).toBe("x");
    });

    test("returns an empty string for no parts", () => {
      expect(contentFromParts([])).toBe("");
    });
  });

  describe("applyClaudeMessagePatch", () => {
    const base: ClaudeMessage = {
      id: "m-1",
      role: "assistant",
      content: "hello",
      parts: [
        { type: "text", content: "hello" },
        { type: "tool-invocation", toolName: "Read", toolUseId: "t-1", toolState: "pending" },
      ],
      timestamp: "2026-07-20T12:00:00.000Z",
      revision: 4,
    };

    /** A well-formed patch that is the immediate successor of `base`. */
    const nextPatch = (overrides: Partial<ClaudeMessagePatch> = {}): ClaudeMessagePatch => ({
      messageId: "m-1",
      partCount: 2,
      changedParts: [{ index: 0, part: { type: "text", content: "hello there" } }],
      timestamp: "2026-07-20T12:00:01.000Z",
      revision: 5,
      ...overrides,
    });

    test("replaces only the indexed parts and leaves the rest untouched", () => {
      const patched = applyClaudeMessagePatch(base, nextPatch())!;

      expect(patched.parts[0]).toEqual({ type: "text", content: "hello there" });
      // The tool part was not in the patch, so it must survive by identity.
      expect(patched.parts[1]).toBe(base.parts[1]);
      // And the original message is not mutated in place.
      expect(base.parts[0]).toEqual({ type: "text", content: "hello" });
    });

    test("derives content from the text parts so patches need not resend it", () => {
      const patched = applyClaudeMessagePatch(
        base,
        nextPatch({
          partCount: 3,
          changedParts: [{ index: 2, part: { type: "text", content: " and more" } }],
        }),
      )!;

      expect(patched.content).toBe("hello and more");
      expect(patched.content).toBe(contentFromParts(patched.parts));
    });

    test("appends beyond the current length", () => {
      const patched = applyClaudeMessagePatch(
        base,
        nextPatch({
          partCount: 3,
          changedParts: [{ index: 2, part: { type: "thinking", content: "pondering" } }],
        }),
      )!;

      expect(patched.parts).toHaveLength(3);
      expect(patched.parts[2]).toEqual({ type: "thinking", content: "pondering" });
    });

    test("truncates to partCount when a finalized message replaces streamed blocks", () => {
      const patched = applyClaudeMessagePatch(
        base,
        nextPatch({
          partCount: 1,
          changedParts: [{ index: 0, part: { type: "text", content: "final" } }],
        }),
      )!;

      expect(patched.parts).toHaveLength(1);
      expect(patched.content).toBe("final");
    });

    test("advances the stored revision so the next patch can build on it", () => {
      const patched = applyClaudeMessagePatch(base, nextPatch())!;
      expect(patched.revision).toBe(5);

      // And that result is a valid base for revision 6.
      expect(applyClaudeMessagePatch(patched, nextPatch({ revision: 6 }))).not.toBeNull();
    });

    describe("rejects a patch it cannot safely apply", () => {
      test("when frames were missed — the revision is not the immediate successor", () => {
        // The reconnect case: the tab holds revision 4 but the bridge has moved
        // on. Applying by index here would drop everything sent in between,
        // and the bridge will never re-send it. Rejecting forces a refetch.
        expect(applyClaudeMessagePatch(base, nextPatch({ revision: 9 }))).toBeNull();
        // Also a replay of a revision already applied.
        expect(applyClaudeMessagePatch(base, nextPatch({ revision: 4 }))).toBeNull();
        expect(applyClaudeMessagePatch(base, nextPatch({ revision: 3 }))).toBeNull();
      });

      test("when the message carries no revision at all", () => {
        const unversioned: ClaudeMessage = { ...base, revision: undefined };
        expect(applyClaudeMessagePatch(unversioned, nextPatch({ revision: 1 }))).toBeNull();
      });

      test("when the payload would leave a hole in the parts array", () => {
        // Second line of defence behind the revision check: a blank block is
        // indistinguishable from real empty output once rendered, so reject
        // rather than paper over the gap.
        expect(
          applyClaudeMessagePatch(
            base,
            nextPatch({
              partCount: 4,
              changedParts: [{ index: 3, part: { type: "text", content: "far" } }],
            }),
          ),
        ).toBeNull();
      });

      test("when changedParts is missing or not an array", () => {
        // This arrives as JSON from a subprocess. An unchecked iteration would
        // throw out of the SSE loop and tear down the whole subscription.
        expect(
          applyClaudeMessagePatch(
            base,
            nextPatch({ changedParts: undefined as unknown as ClaudeMessagePatch["changedParts"] }),
          ),
        ).toBeNull();
        expect(
          applyClaudeMessagePatch(
            base,
            nextPatch({ changedParts: "nope" as unknown as ClaudeMessagePatch["changedParts"] }),
          ),
        ).toBeNull();
      });

      test("when partCount is absent, negative or not an integer", () => {
        // `parts.length = <these>` throws a RangeError.
        for (const partCount of [undefined, -1, 1.5, Number.NaN, "2"]) {
          expect(
            applyClaudeMessagePatch(
              base,
              nextPatch({ partCount: partCount as unknown as number }),
            ),
          ).toBeNull();
        }
      });

      test("when an index is out of range or not an integer", () => {
        for (const index of [-1, 2, 0.5, undefined]) {
          expect(
            applyClaudeMessagePatch(
              base,
              nextPatch({
                partCount: 2,
                changedParts: [
                  { index: index as unknown as number, part: { type: "text", content: "x" } },
                ],
              }),
            ),
          ).toBeNull();
        }
      });

      test("when a changed entry carries no part object", () => {
        expect(
          applyClaudeMessagePatch(
            base,
            nextPatch({
              changedParts: [
                { index: 0, part: undefined as unknown as ClaudeMessagePart },
              ],
            }),
          ),
        ).toBeNull();
        expect(
          applyClaudeMessagePatch(
            base,
            nextPatch({
              changedParts: [null as unknown as { index: number; part: ClaudeMessagePart }],
            }),
          ),
        ).toBeNull();
      });

      test("when the payload is not an object at all", () => {
        expect(
          applyClaudeMessagePatch(base, undefined as unknown as ClaudeMessagePatch),
        ).toBeNull();
      });
    });
  });
});
