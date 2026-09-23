/**
 * Turn lifecycle.
 *
 * `dispatchPrompt` is driven here against a stub `AgentSession` rather than a
 * real one: the behaviour worth pinning is what this bridge does around the
 * SDK — when it reports a turn accepted, what it records when the turn ends,
 * and what it does with a run that outlives its budget — none of which needs a
 * model to answer.
 */
import { describe, expect, jest, test } from "bun:test";
import type { AgentSession, ContextUsage } from "@earendil-works/pi-coding-agent";
import { newSessionState } from "./agent-session.js";
import { dispatchPrompt, journal, setStructuredResult, type DispatchInput } from "./prompt.js";
import { applySessionEvent } from "./translate.js";
import { publicContextUsage, publicSteerDispatch } from "./public.js";
import type { SessionState } from "./state.js";

// The timeout is read from the environment at import, and six hours is not a
// thing a test can wait for. Set before `config.ts` is first loaded by the
// dynamic import below.
process.env.PI_BRIDGE_PROMPT_TIMEOUT_MS = "60000";

interface StubSession {
  session: AgentSession;
  finish: () => void;
  fail: (error: unknown) => void;
  accept: (accepted: boolean) => void;
  aborted: () => number;
  cleared: () => number;
  never: boolean;
}

/**
 * A session whose run this test controls.
 *
 * `preflightResult` is how the bridge learns a prompt was accepted, so the
 * stub exposes it directly instead of inferring acceptance from the run.
 */
function stubSession(
  options: {
    autoAccept?: boolean;
    onAbort?: () => void;
    contextUsage?: ContextUsage | undefined | (() => never);
    lastAssistantUsage?: Record<string, unknown>;
    lastAssistantText?: string;
    sessionStats?: Record<string, unknown>;
  } = {},
): StubSession {
  let settleRun: () => void = () => undefined;
  let rejectRun: (error: unknown) => void = () => undefined;
  let announce: (accepted: boolean) => void = () => undefined;
  let abortCount = 0;
  let clearCount = 0;

  const run = new Promise<void>((resolve, reject) => {
    settleRun = resolve;
    rejectRun = reject;
  });

  const session = {
    prompt: (_text: string, opts: { preflightResult?: (ok: boolean) => void }) => {
      announce = opts.preflightResult ?? (() => undefined);
      if (options.autoAccept !== false) queueMicrotask(() => announce(true));
      return run;
    },
    abort: async () => {
      options.onAbort?.();
      abortCount += 1;
      // A real abort ends the run; the bridge must not depend on that, but it
      // is the honest stub.
      settleRun();
    },
    clearQueue: () => {
      clearCount += 1;
      return { steering: [], followUp: [] };
    },
    getContextUsage: () =>
      typeof options.contextUsage === "function" ? options.contextUsage() : options.contextUsage,
    getSessionStats: () => options.sessionStats ?? { cost: 0 },
    getLastAssistantText: () => options.lastAssistantText,
    sessionManager: {
      getBranch: () =>
        options.lastAssistantUsage
          ? [
              {
                type: "message",
                id: "assistant-entry",
                parentId: null,
                timestamp: "2026-09-07T00:00:00.000Z",
                message: { role: "assistant", usage: options.lastAssistantUsage },
              },
            ]
          : [],
    },
  } as unknown as AgentSession;

  return {
    session,
    finish: () => settleRun(),
    fail: (error) => rejectRun(error),
    accept: (accepted) => announce(accepted),
    aborted: () => abortCount,
    cleared: () => clearCount,
    never: false,
  };
}

function runningState(): SessionState {
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  state.currentTurnUsage = {};
  return state;
}

function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return { prompt: "do the thing", images: [], ...overrides };
}

function closedDiagnostic(lines: string[]): Record<string, unknown> | undefined {
  return lines
    .filter((line) => line.startsWith("[bridge-diagnostics] "))
    .map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)))
    .find((entry) => entry.event === "closed");
}

describe("dispatchPrompt", () => {
  test.each([false, true])(
    "debug scopes track tool progress and close without a UI (debug=%s)",
    async (enabled) => {
      const previousFlag = process.env.ORKESTRATOR_BRIDGE_DEBUG;
      const previousInfo = console.info;
      const lines: string[] = [];
      process.env.ORKESTRATOR_BRIDGE_DEBUG = enabled ? "1" : "0";
      console.info = (line: unknown) => {
        lines.push(String(line));
      };
      const state = runningState();
      const stub = stubSession();
      let completion: Promise<void> | undefined;
      try {
        const handle = await dispatchPrompt(
          state,
          stub.session,
          input({ prompt: "PRIVATE PROMPT" }),
        );
        completion = handle.completion;
        expect(Boolean(state.diagnostics)).toBe(enabled);
        applySessionEvent(state, {
          type: "tool_execution_start",
          toolCallId: "PRIVATE ID",
          toolName: "bash",
          args: { command: "PRIVATE COMMAND" },
        });
        state.diagnostics?.report("heartbeat");
        if (enabled) {
          expect(lines.at(-1)).toContain('"pendingToolCount":1');
          expect(lines.at(-1)).toContain('"kind":"bash"');
        }
        applySessionEvent(state, {
          type: "tool_execution_end",
          toolCallId: "PRIVATE ID",
          toolName: "bash",
          result: { content: [] },
        });
        state.diagnostics?.report("heartbeat");
        if (enabled) expect(lines.at(-1)).toContain('"pendingToolCount":0');
        stub.finish();
        await completion;
        expect(state.diagnostics).toBeUndefined();
        if (enabled) expect(lines.at(-1)).toContain('"event":"closed"');
        else expect(lines).toHaveLength(0);
        expect(lines.join("\n")).not.toContain("PRIVATE");
      } finally {
        stub.finish();
        await completion;
        console.info = previousInfo;
        if (previousFlag === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
        else process.env.ORKESTRATOR_BRIDGE_DEBUG = previousFlag;
      }
    },
  );

  test("resolves as soon as the prompt is accepted, not when the turn ends", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // The turn has not finished — the route is free to answer 202 anyway.
    expect(state.status).toBe("running");

    stub.finish();
    await handle.completion;
    expect(state.status).toBe("idle");
  });

  test("installs a cancel handle that aborts the live run", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input());
    expect(state.cancelTurn).toBeDefined();

    await state.cancelTurn?.();
    expect(stub.aborted()).toBe(1);
    await handle.completion;
  });

  test("rejects when Pi refuses the prompt at preflight", async () => {
    const state = runningState();
    const stub = stubSession({ autoAccept: false });
    queueMicrotask(() => {
      stub.accept(false);
      stub.finish();
    });

    await expect(dispatchPrompt(state, stub.session, input())).rejects.toThrow();
  });

  test("records a completed turn as idle with its journal entry", async () => {
    const state = runningState();
    const stub = stubSession();
    journal(state, "req-1", "accepted");

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    stub.finish();
    await handle.completion;

    expect(state.status).toBe("idle");
    expect(state.error).toBeUndefined();
    expect(state.promptJournal.get("req-1")?.state).toBe("completed");
    // Everything the turn was holding is released, or the next turn inherits it.
    expect(state.cancelTurn).toBeUndefined();
    expect(state.compacting).toBe(false);
  });

  test("clears an undelivered steer when its target run ends", async () => {
    const state = runningState();
    const stub = stubSession();
    state.pendingSteerDeliveries.push({
      requestId: "steer-late",
      text: "too late",
      expectedRunId: "pi:generation:1",
    });
    state.steerJournal.set("steer-late", {
      requestId: "steer-late",
      inputDigest: "a".repeat(64),
      expectedRunId: "pi:generation:1",
      state: "queued",
      createdAt: 1,
    });
    state.queue.steering = ["too late"];

    const handle = await dispatchPrompt(state, stub.session, input());
    stub.finish();
    await handle.completion;

    expect(stub.cleared()).toBe(1);
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.queue.steering).toEqual([]);
    expect(state.steerJournal.get("steer-late")?.state).toBe("dropped");
    expect(publicSteerDispatch(state, "steer-late")).toEqual({ dispatch: "absent" });
  });

  test("keeps an undelivered steer ambiguous when Pi refuses to clear its queue", async () => {
    const state = runningState();
    const stub = stubSession();
    state.pendingSteerDeliveries.push({
      requestId: "steer-unclear",
      text: "too late",
      expectedRunId: "pi:generation:1",
    });
    state.steerJournal.set("steer-unclear", {
      requestId: "steer-unclear",
      inputDigest: "b".repeat(64),
      expectedRunId: "pi:generation:1",
      state: "queued",
      createdAt: 1,
    });
    stub.session.clearQueue = () => {
      throw new Error("queue unavailable");
    };

    const handle = await dispatchPrompt(state, stub.session, input());
    stub.finish();
    await handle.completion;

    expect(state.steerJournal.get("steer-unclear")?.state).toBe("ambiguous");
    expect(publicSteerDispatch(state, "steer-unclear")).toEqual({ dispatch: "unknown" });
  });

  test("records a failed turn with the text Pi refused with", async () => {
    const previousFlag = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    const previousInfo = console.info;
    const lines: string[] = [];
    process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
    console.info = (line: unknown) => lines.push(String(line));
    const state = runningState();
    const stub = stubSession();
    try {
      const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
      stub.fail(new Error("provider is out of quota"));
      await handle.completion;

      expect(state.status).toBe("error");
      expect(state.error).toBe("provider is out of quota");
      expect(state.promptJournal.get("req-1")?.state).toBe("failed");
      expect(closedDiagnostic(lines)).toMatchObject({
        terminal: "rejected",
        stream: "rejected",
        cancelReason: "turn-ended",
      });
    } finally {
      stub.finish();
      console.info = previousInfo;
      if (previousFlag === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previousFlag;
    }
  });

  test("records a timed-out turn with rejected outcomes and timeout cancellation", async () => {
    jest.useFakeTimers();
    const previousFlag = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    const previousInfo = console.info;
    const lines: string[] = [];
    process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
    console.info = (line: unknown) => lines.push(String(line));
    const state = runningState();
    const stub = stubSession();
    let completion: Promise<void> | undefined;
    try {
      const handle = await dispatchPrompt(
        state,
        stub.session,
        input({ requestId: "timeout" }),
        60_000,
      );
      completion = handle.completion;
      jest.advanceTimersByTime(60_001);
      await completion;

      expect(stub.aborted()).toBe(1);
      expect(state.status).toBe("error");
      expect(state.error).toBe("The Pi turn exceeded its time budget");
      expect(closedDiagnostic(lines)).toMatchObject({
        terminal: "rejected",
        stream: "rejected",
        cancellation: "resolved",
        cancelReason: "timeout",
      });
    } finally {
      stub.finish();
      await completion;
      console.info = previousInfo;
      if (previousFlag === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previousFlag;
      jest.useRealTimers();
    }
  });

  test("aborts a failed run before reporting the turn failed", async () => {
    const state = runningState();
    const order: string[] = [];
    const stub = stubSession({ onAbort: () => order.push("abort") });
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "deploy" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => {
        state.approvals.delete("a1");
        order.push(decision);
      },
    });

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // Stand in for the timeout firing: the wait rejects while the run is still
    // going. The bridge must spend the cancel handle before `settleTurn` drops
    // it, or the run keeps writing into a transcript reported as failed and
    // nothing can stop it.
    const cancel = state.cancelTurn;
    expect(cancel).toBeDefined();
    stub.fail(new Error("The Pi turn exceeded its time budget"));
    await handle.completion;

    expect(stub.aborted()).toBe(1);
    expect(order).toEqual(["deny", "abort"]);
    expect(state.status).toBe("error");
    expect(state.cancelTurn).toBeUndefined();
  });

  test("leaves a superseded turn's outcome to the turn that replaced it", async () => {
    const state = runningState();
    const stub = stubSession();
    journal(state, "req-1", "accepted");

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // A second turn claimed the session while the first was still running.
    state.promptSequence += 1;
    stub.finish();
    await handle.completion;

    // Still running: the *new* turn owns the status, and the old run must not
    // report the session idle underneath it.
    expect(state.status).toBe("running");
    expect(state.promptJournal.get("req-1")?.state).toBe("accepted");
  });

  test("does not settle a turn whose session already failed", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    state.status = "error";
    state.error = "something else failed first";
    stub.finish();
    await handle.completion;

    expect(state.error).toBe("something else failed first");
  });
});

describe("structured output", () => {
  test("parses the turn's final JSON value", async () => {
    const state = runningState();
    const withOutput = stubSession({ lastAssistantText: '{"verdict":"ready"}' });

    const handle = await dispatchPrompt(
      state,
      withOutput.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    withOutput.finish();
    await handle.completion;

    expect(state.structured.get("req-1")).toMatchObject({
      ok: true,
      provider: "pi",
      requestId: "req-1",
      value: { verdict: "ready" },
    });
  });

  test("reports a turn that ended with prose as malformed rather than throwing", async () => {
    const state = runningState();
    const withOutput = stubSession({ lastAssistantText: "I could not decide." });

    const handle = await dispatchPrompt(
      state,
      withOutput.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    withOutput.finish();
    await handle.completion;

    expect(state.structured.get("req-1")).toMatchObject({
      ok: false,
      error: { code: "malformed_output", retryable: true },
    });
  });

  test("refuses an output past the size cap instead of retaining it", async () => {
    const state = runningState();
    const withOutput = stubSession({
      lastAssistantText: `{"a":"${"x".repeat(2 * 1024 * 1024)}"}`,
    });

    const handle = await dispatchPrompt(
      state,
      withOutput.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    withOutput.finish();
    await handle.completion;

    const result = state.structured.get("req-1") as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("size limit");
  });

  test("bounds how many results one session retains", () => {
    const state = runningState();
    for (let index = 0; index < 80; index += 1) {
      setStructuredResult(state, `req-${index}`, { ok: true });
    }
    // Oldest-first eviction, so a long-lived session running structured turns
    // cannot retain every result it has ever produced.
    expect(state.structured.size).toBe(64);
    expect(state.structured.has("req-79")).toBe(true);
    expect(state.structured.has("req-0")).toBe(false);
  });
});

describe("context usage", () => {
  async function usageAfterTurn(contextUsage: ContextUsage | undefined | (() => never)) {
    const state = runningState();
    state.composer = { ...state.composer, selectedModelId: "anthropic/claude" };
    const stub = stubSession({ contextUsage });
    // Occupancy is read from the attached session, not from the handle the
    // turn was dispatched on.
    state.session = stub.session;
    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "usage" }));
    state.currentTurnUsage = { inputTokens: 700, outputTokens: 300 };
    stub.finish();
    await handle.completion;
    return { state, usage: publicContextUsage(state) };
  }

  test("reports Pi's own occupancy exactly when it has one", async () => {
    const { usage } = await usageAfterTurn({ tokens: 42_000, contextWindow: 200_000, percent: 21 });

    expect(usage).toMatchObject({
      usedTokens: 42_000,
      maximumTokens: 200_000,
      percentage: 21,
      lastTurnTokens: 1_000,
      source: "pi",
    });
    expect(usage?.estimated).toBeUndefined();
  });

  test("a post-compaction null tokens is reported as estimated, not as a wrong absolute", async () => {
    // Pi documents `tokens: null` between a compaction and the next model
    // response. The old probe fell through to a differently-scoped number and
    // presented it as an exact whole-session total.
    const { usage } = await usageAfterTurn({ tokens: null, contextWindow: 200_000, percent: null });

    expect(usage).toMatchObject({
      usedTokens: 1_000,
      maximumTokens: 200_000,
      estimated: true,
    });
    expect(usage?.percentage).toBeUndefined();
  });

  test("a session that cannot report usage at all still records the turn", async () => {
    const { usage } = await usageAfterTurn(undefined);

    expect(usage).toMatchObject({ usedTokens: 1_000, estimated: true });
    expect(usage?.maximumTokens).toBeUndefined();
  });

  test("a throwing getContextUsage does not fail the turn that just succeeded", async () => {
    const { state, usage } = await usageAfterTurn(() => {
      throw new Error("session disposed");
    });

    expect(state.status).toBe("idle");
    expect(usage).toMatchObject({ usedTokens: 1_000, estimated: true });
  });

  test("a zero-width context window is ignored rather than shown as a full meter", async () => {
    const { usage } = await usageAfterTurn({ tokens: 5_000, contextWindow: 0, percent: null });

    expect(usage?.usedTokens).toBe(5_000);
    expect(usage?.maximumTokens).toBeUndefined();
  });

  test("uses Pi's last assistant usage and session stats for the turn row", async () => {
    const state = runningState();
    state.composer = { ...state.composer, selectedModelId: "anthropic/claude" };
    const stub = stubSession({
      contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
      lastAssistantUsage: {
        input: 80,
        output: 20,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 7,
        totalTokens: 115,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
      },
      sessionStats: {
        cost: 0.02,
        toolCalls: 3,
        tokens: { total: 115 },
      },
    });
    state.session = stub.session;
    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "support-1" }));
    state.currentTurnUsage = { inputTokens: 999, outputTokens: 999 };
    stub.finish();
    await handle.completion;

    expect(publicContextUsage(state)).toMatchObject({
      sessionTokens: 115,
      turns: [
        {
          turnId: "assistant-entry",
          requestId: "support-1",
          modelId: "anthropic/claude",
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          reasoningTokens: 7,
          totalTokens: 115,
          toolCalls: 3,
          costUsd: 0.02,
        },
      ],
    });
  });
});

/**
 * A session that records what `prompt()` was given, with a run the test ends.
 *
 * `acceptAtPreflight: false` models an extension command: Pi runs its handler
 * inside `prompt()` and only reports preflight once the handler returns.
 */
function recordingSession(options: { acceptAtPreflight?: boolean; idle?: () => boolean } = {}) {
  const prompts: Array<{ text: string; expandPromptTemplates?: boolean; source?: string }> = [];
  let settle: () => void = () => undefined;
  let idleWaiters: Array<() => void> = [];
  let aborted = 0;
  const session = {
    prompt: (
      text: string,
      opts: {
        expandPromptTemplates?: boolean;
        source?: string;
        preflightResult?: (ok: boolean) => void;
      },
    ) => {
      prompts.push({
        text,
        expandPromptTemplates: opts.expandPromptTemplates,
        source: opts.source,
      });
      if (options.acceptAtPreflight !== false) queueMicrotask(() => opts.preflightResult?.(true));
      return new Promise<void>((resolve) => {
        settle = () => {
          if (options.acceptAtPreflight === false) opts.preflightResult?.(true);
          resolve();
        };
      });
    },
    get isIdle() {
      return options.idle?.() ?? true;
    },
    waitForIdle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      }),
    abort: async () => {
      aborted += 1;
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getLastAssistantText: () => undefined,
    sessionManager: { getBranch: () => [] },
  } as unknown as AgentSession;
  return {
    session,
    prompts,
    finish: () => settle(),
    becomeIdle: () => {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    },
    aborted: () => aborted,
  };
}

describe("command interpretation", () => {
  test("literal intent turns off every Pi command path", async () => {
    const state = runningState();
    const stub = recordingSession();

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: "/review this literally", expandCommands: false }),
    );
    stub.finish();
    await handle.completion;

    // `expandPromptTemplates: false` is Pi's single gate for extension command
    // dispatch, `/skill:` expansion and template expansion.
    expect(stub.prompts).toEqual([
      { text: "/review this literally", expandPromptTemplates: false, source: "rpc" },
    ]);
  });

  test.each([
    ["template", "/review src/app.ts"],
    ["skill", "/skill:lint --fix"],
  ])("a %s is accepted once and completes as an ordinary turn", async (_kind, text) => {
    const state = runningState();
    const stub = recordingSession();
    journal(state, "req-cmd", "accepted");

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: text, requestId: "req-cmd" }),
    );
    applySessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "expanded and answered" },
    });
    stub.finish();
    await handle.completion;

    expect(stub.prompts).toEqual([{ text, expandPromptTemplates: true, source: "rpc" }]);
    expect(state.status).toBe("idle");
    expect(state.promptJournal.get("req-cmd")?.state).toBe("completed");
    expect(state.messages.at(-1)?.content).toBe("expanded and answered");
    expect(state.messages.some((message) => message.id.startsWith("command-outcome:"))).toBe(false);
  });

  test("an extension command is accepted while its handler is still running", async () => {
    const state = runningState();
    const stub = recordingSession({ acceptAtPreflight: false });

    // Pi reports preflight only when the handler returns; waiting for it would
    // hold the prompt request open for the whole command.
    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: "/stats", requestId: "req-ext", extensionCommand: "stats" }),
    );
    expect(state.status).toBe("running");
    expect(state.commandRun?.invocation).toBe("stats");

    stub.finish();
    await handle.completion;

    expect(state.status).toBe("idle");
    expect(state.promptJournal.get("req-ext")?.state).toBe("completed");
    expect(state.commandRun).toBeUndefined();
    const outcome = state.messages.at(-1);
    expect(outcome?.id).toBe("command-outcome:req-ext");
    expect(outcome?.parts[0]).toMatchObject({ type: "status", severity: "info" });
    expect(outcome?.content).toContain("/stats finished without output");
  });

  test("an extension command's display messages become its durable outcome", async () => {
    const state = runningState();
    const stub = recordingSession({ acceptAtPreflight: false });

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: "/stats", requestId: "req-out", extensionCommand: "stats" }),
    );
    applySessionEvent(state, {
      type: "message_start",
      message: { role: "custom", customType: "stats", display: true, content: "12 turns, $0.40" },
    });
    // A hidden custom message is context for the model, not output.
    applySessionEvent(state, {
      type: "message_start",
      message: { role: "custom", customType: "stats", display: false, content: "internal" },
    });
    stub.finish();
    await handle.completion;

    expect(state.messages.at(-1)).toMatchObject({
      id: "command-outcome:req-out",
      role: "assistant",
      content: "12 turns, $0.40",
    });
  });

  test("an extension command that starts a turn stays busy until Pi is idle", async () => {
    const state = runningState();
    let idle = true;
    const stub = recordingSession({ acceptAtPreflight: false, idle: () => idle });

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: "/plan feature", requestId: "req-turn", extensionCommand: "plan" }),
    );
    // The handler called `pi.sendMessage(..., { triggerTurn: true })` and
    // returned: Pi's run is active although the wrapper has finished.
    idle = false;
    stub.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.status).toBe("running");

    applySessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Here is the plan" },
    });
    idle = true;
    stub.becomeIdle();
    await handle.completion;

    expect(state.status).toBe("idle");
    expect(state.promptJournal.get("req-turn")?.state).toBe("completed");
    expect(state.messages.at(-1)?.content).toBe("Here is the plan");
    // The reply is the outcome; no synthetic row is added on top of it.
    expect(state.messages.some((message) => message.id.startsWith("command-outcome:"))).toBe(false);
  });

  test("cancelling an extension command settles the turn although its handler cannot stop", async () => {
    const state = runningState();
    const stub = recordingSession({ acceptAtPreflight: false });

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ prompt: "/watch", requestId: "req-cancel", extensionCommand: "watch" }),
    );
    await state.cancelTurn?.();
    await handle.completion;

    expect(stub.aborted()).toBe(1);
    expect(state.status).toBe("idle");
    expect(state.cancelTurn).toBeUndefined();
    expect(state.messages.at(-1)?.content).toContain("/watch was cancelled");
    stub.finish();
  });
});
