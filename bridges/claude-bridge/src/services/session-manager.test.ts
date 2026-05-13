import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Snapshot the real mcp-config / plugin-config modules BEFORE installing the
// stub mocks below. Bun's `mock.module(...)` is process-global, so without
// restoring on `afterAll` these stubs would leak into any later test in the
// same `bun test` run that imports the real modules. See CLAUDE.md > "Bun
// `mock.module()` Rules" > "Snapshot-and-restore pattern".
import * as realMcpConfig from "./mcp-config.js";
import * as realPluginConfig from "./plugin-config.js";
const mcpConfigSnapshot = { ...realMcpConfig };
const pluginConfigSnapshot = { ...realPluginConfig };

// ---------------------------------------------------------------------------
// Controllable mock for @anthropic-ai/claude-agent-sdk.query()
// ---------------------------------------------------------------------------
//
// The SDK's `query()` returns an object that is both an async iterable AND has
// methods like `supportedModels()` / `return()`. Each call here registers a
// QueryCall that the test can drive: push messages, finish the stream, or fail
// the iterator. The session-manager iterates with `for await` so the test
// retains full control over message ordering.
//
// The mock also records the `canUseTool` callback so tests can drive the
// AskUserQuestion / ExitPlanMode flows directly without simulating the full
// agent loop.

interface QueryCall {
  options: {
    cwd?: string;
    model?: string;
    abortController?: AbortController;
    canUseTool?: (
      toolName: string,
      input: unknown,
    ) => Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
    [key: string]: unknown;
  };
  push: (msg: unknown) => void;
  finish: () => void;
  fail: (err: Error) => void;
}

const pendingCalls: QueryCall[] = [];
const queryWaiters: Array<(call: QueryCall) => void> = [];

function nextQueryCall(timeoutMs = 1000): Promise<QueryCall> {
  return new Promise((resolve, reject) => {
    if (pendingCalls.length > 0) {
      const call = pendingCalls.shift()!;
      resolve(call);
      return;
    }
    const timer = setTimeout(() => {
      const idx = queryWaiters.indexOf(resolveWrapped);
      if (idx >= 0) queryWaiters.splice(idx, 1);
      reject(new Error("Timed out waiting for query() to be invoked"));
    }, timeoutMs);
    const resolveWrapped = (call: QueryCall) => {
      clearTimeout(timer);
      resolve(call);
    };
    queryWaiters.push(resolveWrapped);
  });
}

const mockQuery = mock((args: { prompt: unknown; options: QueryCall["options"] }) => {
  const queue: unknown[] = [];
  let pendingResolve: (() => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  const wake = () => {
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r();
    }
  };

  const call: QueryCall = {
    options: args.options,
    push: (msg) => {
      queue.push(msg);
      wake();
    },
    finish: () => {
      finished = true;
      wake();
    },
    fail: (err) => {
      error = err;
      finished = true;
      wake();
    },
  };

  // Honor the abort controller so abortSession() unblocks the iterator.
  args.options?.abortController?.signal.addEventListener("abort", () => {
    finished = true;
    wake();
  });

  const waiter = queryWaiters.shift();
  if (waiter) {
    waiter(call);
  } else {
    pendingCalls.push(call);
  }

  async function* iter() {
    while (true) {
      if (error) {
        const err = error;
        error = null;
        throw err;
      }
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (finished) return;
      await new Promise<void>((r) => {
        pendingResolve = r;
      });
    }
  }

  const generator = iter();
  return Object.assign(generator, {
    supportedModels: async () => [
      {
        value: "claude-opus-mock",
        displayName: "Claude Opus (mock)",
        description: "Mock model",
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"] as const,
      },
    ],
  });
});

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

mock.module("./mcp-config.js", () => ({
  getMcpServersForSdk: async () => ({}),
  getMcpServerNames: async () => new Set<string>(),
}));

mock.module("./plugin-config.js", () => ({
  getPluginsForSdk: async () => [],
}));

// Import AFTER mocks are installed so session-manager picks them up.
const sessionManager = await import("./session-manager.js");
const { eventEmitter } = await import("./event-emitter.js");
import type { SSEEvent } from "../types/index.js";

const {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  abortSession,
  getSessionMessages,
  sendPrompt,
  answerQuestion,
  getPendingQuestions,
  respondToPlanApproval,
  getPendingPlanApprovals,
  getSessionInitData,
  getAvailableModels,
} = sessionManager;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureEvents(): { events: SSEEvent[]; stop: () => void } {
  const events: SSEEvent[] = [];
  const unsubscribe = eventEmitter.subscribe((e) => events.push(e));
  return { events, stop: unsubscribe };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for condition");
}

const createdSessionIds: string[] = [];
function track(id: string): string {
  createdSessionIds.push(id);
  return id;
}

afterEach(() => {
  // Clean up any sessions/abortable work the test created.
  for (const id of createdSessionIds.splice(0)) {
    deleteSession(id);
  }
  pendingCalls.length = 0;
  queryWaiters.length = 0;
  mockQuery.mockClear();
});

afterAll(() => {
  // Restore the real mcp-config / plugin-config modules so other test files
  // in the same `bun test` run get the real implementations.
  mock.module("./mcp-config.js", () => mcpConfigSnapshot);
  mock.module("./plugin-config.js", () => pluginConfigSnapshot);
});

// ---------------------------------------------------------------------------
// Pure session-state CRUD
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  test("createSession produces a session with the expected shape and emits session.updated", () => {
    const { events, stop } = captureEvents();
    try {
      const session = createSession("My title");
      track(session.id);

      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe("My title");
      expect(session.status).toBe("idle");
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeInstanceOf(Date);

      const updated = events.find((e) => e.type === "session.updated" && e.sessionId === session.id);
      expect(updated).toBeDefined();
      expect((updated?.data as { status?: string })?.status).toBe("idle");
    } finally {
      stop();
    }
  });

  test("createSession assigns a default title when none is provided", () => {
    const session = createSession();
    track(session.id);
    expect(session.title).toMatch(/^Session /);
  });

  test("getSession and listSessions return registered sessions", () => {
    const a = createSession("alpha");
    const b = createSession("beta");
    track(a.id);
    track(b.id);

    expect(getSession(a.id)?.title).toBe("alpha");
    expect(getSession("session-does-not-exist")).toBeUndefined();

    const ids = listSessions().map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("deleteSession removes the session and returns true; subsequent deletes return false", () => {
    const session = createSession("doomed");
    expect(deleteSession(session.id)).toBe(true);
    expect(getSession(session.id)).toBeUndefined();
    expect(deleteSession(session.id)).toBe(false);
  });

  test("abortSession returns false when nothing is running", () => {
    const session = createSession("idle-session");
    track(session.id);
    expect(abortSession(session.id)).toBe(false);
  });

  test("getSessionMessages returns [] for a fresh session and [] for unknown", () => {
    const session = createSession("empty");
    track(session.id);
    expect(getSessionMessages(session.id)).toEqual([]);
    expect(getSessionMessages("session-missing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendPrompt — happy path, errors, abort, init
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
  test("happy path: appends user + assistant message, captures sdkSessionId, ends idle", async () => {
    const session = createSession("happy");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Hello Claude");
      const call = await nextQueryCall();

      // System init - sdkSessionId should be captured
      call.push({
        type: "system",
        subtype: "init",
        session_id: "sdk-session-xyz",
        mcp_servers: [],
        plugins: [],
        slash_commands: ["help"],
      });

      // Assistant message with text
      call.push({
        type: "assistant",
        uuid: "asst-uuid-1",
        message: {
          content: [{ type: "text", text: "Hi there!" }],
        },
      });

      // Successful result
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("idle");
      expect(stored.sdkSessionId).toBe("sdk-session-xyz");
      expect(stored.messages).toHaveLength(2);
      expect(stored.messages[0]?.role).toBe("user");
      expect(stored.messages[0]?.content).toBe("Hello Claude");
      expect(stored.messages[1]?.role).toBe("assistant");
      expect(stored.messages[1]?.content).toBe("Hi there!");

      const initData = getSessionInitData(session.id);
      expect(initData?.slashCommands).toEqual(["help"]);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("session.init");
      expect(eventTypes).toContain("message.updated");
      expect(eventTypes).toContain("session.idle");
    } finally {
      stop();
    }
  });

  test("rejects a second prompt while the session is already running", async () => {
    const session = createSession("busy");
    track(session.id);

    const first = sendPrompt(session.id, "first");
    const call = await nextQueryCall();

    await expect(sendPrompt(session.id, "second")).rejects.toThrow(/already processing/);

    call.finish();
    await first;
  });

  test("throws when the session id is unknown", async () => {
    await expect(sendPrompt("session-missing", "hi")).rejects.toThrow(/not found/);
  });

  test("query failure leaves session in error state and emits session.error", async () => {
    const session = createSession("will-fail");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "boom");
      const call = await nextQueryCall();
      call.fail(new Error("SDK exploded"));

      await expect(promptPromise).rejects.toThrow(/SDK exploded/);

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("error");
      expect(stored.error).toBe("SDK exploded");

      const errorEvent = events.find((e) => e.type === "session.error" && e.sessionId === session.id);
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.data as { error?: string })?.error).toBe("SDK exploded");
    } finally {
      stop();
    }
  });

  test("abortSession during a running query unblocks the iterator and emits session.idle", async () => {
    const session = createSession("abort-me");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "long-running");
      const call = await nextQueryCall();
      call.push({ type: "system", subtype: "init", session_id: "sdk-1", mcp_servers: [] });

      // Wait until the iterator has started consuming.
      await waitFor(() => getSession(session.id)?.status === "running");

      const result = abortSession(session.id);
      expect(result).toBe(true);

      await promptPromise;
      expect(call.options.abortController?.signal.aborted).toBe(true);
      expect(getSession(session.id)?.status).toBe("idle");

      const idleEvents = events.filter((e) => e.type === "session.idle");
      expect(idleEvents.length).toBeGreaterThan(0);
      const aborted = idleEvents.find((e) => (e.data as { aborted?: boolean })?.aborted === true);
      expect(aborted).toBeDefined();
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AskUserQuestion flow via canUseTool
// ---------------------------------------------------------------------------

describe("AskUserQuestion flow", () => {
  test("canUseTool registers a pending question, answerQuestion resolves it with allow", async () => {
    const session = createSession("question-flow");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "ask me");
    const call = await nextQueryCall();

    expect(typeof call.options.canUseTool).toBe("function");

    const canUseToolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [
        {
          question: "Pick a color",
          header: "Color choice",
          options: [{ label: "red" }, { label: "blue" }],
        },
      ],
    });

    // The pending question should now be visible to the API surface.
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [pending] = getPendingQuestions(session.id);
    expect(pending?.questions[0]?.question).toBe("Pick a color");

    expect(answerQuestion(pending!.id, { "Pick a color": "blue" })).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string; updatedInput?: { answers?: Record<string, string> } };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.answers).toEqual({ "Pick a color": "blue" });

    expect(getPendingQuestions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
  });

  test("answerQuestion returns false for unknown ids", () => {
    expect(answerQuestion("missing", {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode (plan approval) flow via canUseTool
// ---------------------------------------------------------------------------

describe("plan approval flow", () => {
  test("approving the plan resolves canUseTool with allow and emits plan.exit-requested", async () => {
    const session = createSession("plan-approve");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "make a plan");
      const call = await nextQueryCall();

      const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
      const [approval] = getPendingPlanApprovals(session.id);
      expect(approval?.sessionId).toBe(session.id);

      expect(respondToPlanApproval(approval!.id, true)).toBe(true);

      const result = (await canUseToolPromise) as { behavior: string };
      expect(result.behavior).toBe("allow");

      const exitEvent = events.find(
        (e) => e.type === "plan.exit-requested" && e.sessionId === session.id,
      );
      expect(exitEvent).toBeDefined();

      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("rejecting the plan resolves canUseTool with deny and includes feedback", async () => {
    const session = createSession("plan-reject");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    expect(respondToPlanApproval(approval!.id, false, "needs more detail")).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("needs more detail");

    // Finish the original turn. session-manager will then re-prompt with the
    // captured rejection feedback - serve a quick success for that re-prompt.
    call.finish();

    const repromptCall = await nextQueryCall();
    repromptCall.push({ type: "system", subtype: "init", session_id: "sdk-reprompt", mcp_servers: [] });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    expect(getSession(session.id)?.status).toBe("idle");
  });

  test("respondToPlanApproval returns false for unknown ids", () => {
    expect(respondToPlanApproval("missing", true)).toBe(false);
  });

  test("forwards permissionMode: 'plan' to the SDK so ExitPlanMode runs in real plan mode", async () => {
    const session = createSession("plan-mode-forwarded");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("plan");
    // Real plan mode does not need allowDangerouslySkipPermissions
    expect(call.options.allowDangerouslySkipPermissions).toBeFalsy();

    call.finish();
    await promptPromise;
  });

  test("approval is resolvable even if the UI responds before the SDK awaits the promise", async () => {
    const session = createSession("plan-fast-approve");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    // Kick off canUseTool but respond before awaiting it — this exercises the
    // race where the UI's approve fires synchronously after the request event.
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ok" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string };
    expect(result.behavior).toBe("allow");

    call.finish();
    await promptPromise;
  });

  // -------------------------------------------------------------------------
  // Defensive fallback: if the SDK fails ExitPlanMode despite an approval
  // (e.g. SDK plan-mode regression), the bridge should rewrite the tool
  // result to success and re-prompt Claude to continue.
  // -------------------------------------------------------------------------
  test("approved ExitPlanMode failure is overridden to success and triggers continuation re-prompt", async () => {
    const session = createSession("plan-approve-but-fail");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    call.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });

    // User approves the plan via canUseTool
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ship it" });
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    const canUseToolResult = (await canUseToolPromise) as { behavior: string };
    expect(canUseToolResult.behavior).toBe("allow");

    // Simulate the SDK emitting an assistant message containing the
    // ExitPlanMode tool_use, then a user message with a FAILED tool_result.
    call.push({
      type: "assistant",
      uuid: "asst-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-exit-1",
            name: "ExitPlanMode",
            input: { plan: "ship it" },
          },
        ],
      },
    });
    call.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-exit-1",
            content: "Error: not in plan mode",
            is_error: true,
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();

    // Bridge should have queued a continuation re-prompt — serve it.
    const repromptCall = await nextQueryCall();
    // The re-prompt should NOT be in plan mode (user has approved; Claude needs full tools)
    expect(repromptCall.options.permissionMode).not.toBe("plan");
    repromptCall.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    // Recursion guard: after the original sendPrompt resolves, there should be
    // no further queued query calls. The `_isReprompt` flag on the recursive
    // sendPrompt prevents the fallback from re-triggering on the re-prompt
    // itself.
    expect(pendingCalls.length).toBe(0);

    // The original assistant message's ExitPlanMode tool should now show success,
    // not the SDK's reported failure.
    const messages = getSession(session.id)?.messages ?? [];
    const assistantWithTool = messages.find((m) =>
      m.role === "assistant" &&
      m.parts.some((p) => p.toolName === "ExitPlanMode")
    );
    expect(assistantWithTool).toBeDefined();
    const exitPart = assistantWithTool?.parts.find((p) => p.toolName === "ExitPlanMode");
    expect(exitPart?.toolState).toBe("success");
    expect(exitPart?.toolError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAvailableModels
// ---------------------------------------------------------------------------

describe("getAvailableModels", () => {
  test("returns the SDK's supported models, mapped to ModelInfo shape", async () => {
    const models = await getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toMatchObject({
      id: "claude-opus-mock",
      name: "Claude Opus (mock)",
      supportsFastMode: true,
    });
  });
});
