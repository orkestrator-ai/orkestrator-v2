/**
 * Which model produced each response, and which model a turn's usage is
 * charged to.
 *
 * Pi reports both the model it asked for (`provider`/`model`) and, when the
 * provider says so, the one that answered (`responseModel`: an alias resolved
 * to a dated model, or a fallback model). The transcript row and the usage
 * row follow the answer; the composer keeps the user's selection.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { newSessionState } from "./agent-session.js";
import { MAX_MODEL_ID_BYTES } from "./config.js";
import { dispatchPrompt } from "./prompt.js";
import { publicContextUsage } from "./public.js";
import type { SessionState } from "./state.js";
import { applySessionEvent, responseModelId } from "./translate.js";

const SELECTED = "anthropic/claude-sonnet-4-5";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  state.composer = { ...state.composer, selectedModelId: SELECTED };
  return state;
}

function assistant(fields: Record<string, unknown> = {}) {
  return { role: "assistant", content: [], ...fields };
}

const requested = { provider: "anthropic", model: "claude-sonnet-4-5" };

function textDelta(delta: string, message: unknown = assistant(requested)) {
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

describe("responseModelId", () => {
  test("prefers the model the provider says answered", () => {
    expect(
      responseModelId(assistant({ ...requested, responseModel: "claude-sonnet-4-5-20250929" })),
    ).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  test("falls back to the requested model for a response that names none", () => {
    // Every session entry an older Pi wrote, and every provider that does not
    // report the answering model.
    expect(responseModelId(assistant(requested))).toBe("anthropic/claude-sonnet-4-5");
    expect(responseModelId(assistant({ ...requested, responseModel: "  " }))).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  test("keeps the model half's own slashes", () => {
    expect(
      responseModelId(
        assistant({
          provider: "openrouter",
          model: "anthropic/claude-opus-4-5",
          responseModel: "anthropic/claude-opus-4-5-20251101",
        }),
      ),
    ).toBe("openrouter/anthropic/claude-opus-4-5-20251101");
  });

  test("names no model without a provider, for a non-assistant message, or past the bound", () => {
    expect(responseModelId(assistant({ model: "claude" }))).toBeUndefined();
    expect(responseModelId({ role: "user", ...requested })).toBeUndefined();
    expect(responseModelId(undefined)).toBeUndefined();
    expect(
      responseModelId(assistant({ provider: "p", model: "m".repeat(MAX_MODEL_ID_BYTES) })),
    ).toBeUndefined();
  });
});

describe("live rows", () => {
  test("a row is attributed to the requested model, then to the one that answered", () => {
    const state = running();
    applySessionEvent(state, { type: "message_start", message: assistant(requested) });
    applySessionEvent(state, textDelta("Hello"));
    expect(state.messages.at(-1)?.modelId).toBe("anthropic/claude-sonnet-4-5");

    const before = state.revision;
    applySessionEvent(state, {
      type: "message_end",
      message: assistant({ ...requested, responseModel: "claude-sonnet-4-5-20250929" }),
    });

    expect(state.messages.at(-1)?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
    // A change readers must see, not a silent mutation.
    expect(state.revision).toBeGreaterThan(before);
    // An alias resolving is not the user choosing another model.
    expect(state.composer.selectedModelId).toBe(SELECTED);
  });

  test("a model named mid-stream reaches the row the delta opens", () => {
    const state = running();
    applySessionEvent(state, { type: "message_start", message: assistant(requested) });
    applySessionEvent(
      state,
      textDelta("Hi", assistant({ ...requested, responseModel: "claude-sonnet-4-5-20250929" })),
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  test("each response row keeps its own model", () => {
    const state = running();
    applySessionEvent(state, { type: "message_start", message: assistant(requested) });
    applySessionEvent(state, textDelta("first"));
    applySessionEvent(state, { type: "message_end", message: assistant(requested) });
    const fallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    applySessionEvent(state, { type: "message_start", message: assistant(fallback) });
    applySessionEvent(state, textDelta("second", assistant(fallback)));

    expect(state.messages.map((message) => message.modelId)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4-5",
    ]);
  });

  test("a tool-only row opened after the response ended carries its model", () => {
    const state = running();
    const answered = assistant({ ...requested, responseModel: "claude-sonnet-4-5-20250929" });
    applySessionEvent(state, { type: "message_start", message: assistant(requested) });
    applySessionEvent(state, { type: "message_end", message: answered });
    // Pi runs the response's tools after its `message_end`.
    applySessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  test("a response that names no model keeps the selection", () => {
    const state = running();
    applySessionEvent(state, { type: "message_start", message: assistant() });
    applySessionEvent(state, textDelta("Hello", assistant()));

    expect(state.messages.at(-1)?.modelId).toBe(SELECTED);
  });
});

function usage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A session whose run ends when the test says, storing `branch` as Pi's history. */
function stubSession(branch: unknown[]) {
  let settle: () => void = () => undefined;
  const run = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const session = {
    prompt: (_text: string, opts: { preflightResult?: (disposition: string) => void }) => {
      queueMicrotask(() => opts.preflightResult?.("started"));
      return run;
    },
    abort: async () => settle(),
    clearQueue: () => ({ steering: [], followUp: [] }),
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getLastAssistantText: () => undefined,
    sessionManager: { getBranch: () => branch },
  } as unknown as AgentSession;
  return { session, finish: () => settle() };
}

function entry(id: string, message: unknown) {
  return { type: "message", id, parentId: null, timestamp: "2026-11-18T00:00:00.000Z", message };
}

/** Run one turn whose responses are `responses`, in order. */
async function turnOf(state: SessionState, responses: Array<Record<string, unknown>>) {
  const stub = stubSession(responses.map((message, index) => entry(`entry-${index}`, message)));
  state.session = stub.session;
  const handle = await dispatchPrompt(state, stub.session, {
    prompt: "do the thing",
    images: [],
    requestId: "request-1",
  });
  for (const message of responses) {
    applySessionEvent(state, { type: "message_start", message });
    applySessionEvent(state, { type: "message_end", message });
  }
  stub.finish();
  await handle.completion;
  return publicContextUsage(state);
}

describe("usage attribution", () => {
  test("a turn answered by a resolved alias is charged to the model that answered", async () => {
    const state = running();
    const answered = assistant({
      ...requested,
      responseModel: "claude-sonnet-4-5-20250929",
      usage: usage(10, 5),
    });

    const reported = await turnOf(state, [answered, answered]);

    expect(reported?.turns?.at(-1)?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(reported?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(state.composer.selectedModelId).toBe(SELECTED);
  });

  test("a turn split across models is charged to none of them alone", async () => {
    const state = running();
    const first = assistant({ ...requested, usage: usage(10, 5) });
    const second = assistant({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: usage(20, 5),
    });

    const reported = await turnOf(state, [first, second]);
    const turn = reported?.turns?.at(-1);

    expect(turn).toBeDefined();
    expect(turn?.modelId).toBeUndefined();
    // The session's figure is the model that answered last.
    expect(reported?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  test("a response that failed before spending a token does not make a turn mixed", async () => {
    const state = running();
    const failed = assistant({
      provider: "openai",
      model: "gpt-4",
      stopReason: "error",
      usage: usage(0, 0),
    });
    const answered = assistant({ ...requested, usage: usage(10, 5) });

    const reported = await turnOf(state, [failed, answered]);

    expect(reported?.turns?.at(-1)?.modelId).toBe("anthropic/claude-sonnet-4-5");
  });

  test("with no response frames, the turn falls back to Pi's stored response", async () => {
    const state = running();
    const stub = stubSession([
      entry(
        "stored",
        assistant({
          ...requested,
          responseModel: "claude-sonnet-4-5-20250929",
          usage: usage(1, 1),
        }),
      ),
    ]);
    state.session = stub.session;
    const handle = await dispatchPrompt(state, stub.session, { prompt: "go", images: [] });
    stub.finish();
    await handle.completion;

    expect(publicContextUsage(state)?.turns?.at(-1)?.modelId).toBe(
      "anthropic/claude-sonnet-4-5-20250929",
    );
  });

  test("a legacy response with no provider falls back to the selection", async () => {
    const state = running();
    const reported = await turnOf(state, [assistant({ usage: usage(3, 2) })]);

    expect(reported?.turns?.at(-1)?.modelId).toBe(SELECTED);
    expect(reported?.modelId).toBe(SELECTED);
  });

  test("the context window is still found when the answering model is not in the catalogue", async () => {
    const state = running();
    state.composer = {
      ...state.composer,
      models: [{ id: SELECTED, name: "Sonnet", platform: "pi", contextWindow: 200_000 }],
    } as SessionState["composer"];
    const answered = assistant({
      ...requested,
      responseModel: "claude-sonnet-4-5-20250929",
      usage: usage(10, 5),
    });

    const reported = await turnOf(state, [answered]);

    expect(reported?.maximumTokens).toBe(200_000);
  });
});
