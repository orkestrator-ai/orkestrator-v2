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
import { responseModelId } from "./models.js";
import { dispatchPrompt } from "./prompt.js";
import { publicContextUsage } from "./public.js";
import type { SessionState } from "./state.js";
import { applySessionEvent } from "./translate.js";

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
  test("an oversized resolved model leaves the valid requested model on the row", () => {
    const state = running();
    const named = { provider: "anthropic", model: "requested" };
    const tooLarge = assistant({ ...named, responseModel: "é".repeat(MAX_MODEL_ID_BYTES) });
    applySessionEvent(state, { type: "message_start", message: assistant(named) });
    applySessionEvent(state, textDelta("Hello", tooLarge));
    applySessionEvent(state, { type: "message_end", message: tooLarge });

    expect(state.messages.at(-1)?.modelId).toBe("anthropic/requested");
  });

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

function usage(input: number, output: number, cost = 0) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

type TestEntry =
  | ReturnType<typeof entry>
  | {
      type: "usage" | "compaction" | "branch_summary";
      provider?: string;
      model?: string;
      usage: ReturnType<typeof usage>;
    };

/** A session whose run ends when the test says, with Pi's append-only accounting. */
function stubSession(entries: TestEntry[]) {
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
    getSessionStats: () => ({
      cost: entries.reduce((sum, item) => {
        const usage = item.type === "message" ? item.message.usage : item.usage;
        return sum + (usage?.cost.total ?? 0);
      }, 0),
      toolCalls: 0,
    }),
    getLastAssistantText: () => undefined,
    sessionManager: {
      getEntries: () => entries.slice(),
      getEntryCount: () => entries.length,
      getBranch: () => entries.slice(),
    },
  } as unknown as AgentSession;
  return { session, finish: () => settle() };
}

function entry(id: string, message: Record<string, unknown>) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: "2026-11-18T00:00:00.000Z",
    message: message as { usage?: ReturnType<typeof usage> },
  };
}

/** Run one turn whose responses are `responses`, in order. */
async function turnOf(
  state: SessionState,
  responses: Array<Record<string, unknown>>,
  entries: TestEntry[] = [],
  { emitFrames = true, aborted = false } = {},
) {
  const stub = stubSession(entries);
  state.session = stub.session;
  state.status = "running";
  state.promptSequence += 1;
  const handle = await dispatchPrompt(state, stub.session, {
    prompt: "do the thing",
    images: [],
    requestId: `request-${state.promptSequence}`,
  });
  for (const message of responses) {
    if (emitFrames) {
      applySessionEvent(state, { type: "message_start", message });
      applySessionEvent(state, { type: "message_end", message });
    }
    entries.push(entry(`entry-${entries.length}`, message));
  }
  if (aborted) applySessionEvent(state, { type: "agent_settled", aborted: true });
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

    expect(reported?.turns?.at(-1)).toMatchObject({
      modelId: "anthropic/claude-sonnet-4-5-20250929",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
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
    const reported = await turnOf(
      state,
      [
        assistant({
          ...requested,
          responseModel: "claude-sonnet-4-5-20250929",
          usage: usage(1, 1),
        }),
      ],
      [],
      { emitFrames: false },
    );

    expect(reported?.turns?.at(-1)?.modelId).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  test("a legacy response with no provider has a display fallback and unattributed usage", async () => {
    const state = running();
    const reported = await turnOf(state, [assistant({ usage: usage(3, 2) })]);

    expect(reported?.turns?.at(-1)?.modelId).toBeUndefined();
    expect(reported?.modelId).toBe(SELECTED);
  });

  test.each([
    { type: "usage", provider: "anthropic", model: "different" },
    { type: "compaction" },
    { type: "branch_summary" },
    { type: "message", message: { role: "toolResult" } },
  ] as const)(
    "keeps an additional $type charge without assigning it to the reply model",
    async (charge) => {
      const state = running();
      const entries: TestEntry[] = [];
      await turnOf(state, [assistant({ ...requested, usage: usage(10, 5, 0.01) })], entries);
      const billed = usage(0, 0, 0.02);
      entries.push(
        charge.type === "message"
          ? entry("tool-result", { ...charge.message, usage: billed })
          : { ...charge, usage: billed },
      );
      const reported = await turnOf(
        state,
        [assistant({ ...requested, usage: usage(3, 2, 0.03) })],
        entries,
      );

      const turn = reported?.turns?.at(-1);
      expect(turn?.costUsd).toBeCloseTo(0.05);
      expect(turn).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      expect(turn?.modelId).toBeUndefined();
    },
  );

  test("a cache refresh and response from the same model keep their attribution", async () => {
    const entries: TestEntry[] = [{ type: "usage", ...requested, usage: usage(0, 0, 0.02) }];
    const reported = await turnOf(
      running(),
      [assistant({ ...requested, usage: usage(3, 2, 0.03) })],
      entries,
    );

    expect(reported?.turns?.at(-1)).toMatchObject({ modelId: SELECTED, costUsd: 0.05 });
  });

  test.each(["error", "aborted"] as const)(
    "a paid %s uses only the follow-up's tokens",
    async (stopReason) => {
      const state = running();
      const entries: TestEntry[] = [];
      await turnOf(state, [assistant({ ...requested, usage: usage(100, 20, 0.01) })], entries);
      const reported = await turnOf(
        state,
        [assistant({ provider: "openai", model: "second", stopReason, usage: usage(8, 2, 0.02) })],
        entries,
        { aborted: stopReason === "aborted" },
      );

      expect(reported?.turns?.map((turn) => [turn.modelId, turn.totalTokens])).toEqual([
        [SELECTED, 120],
        ["openai/second", 10],
      ]);
      expect(reported?.turns?.at(-1)?.costUsd).toBeCloseTo(0.02);
      expect(reported?.modelId).toBe(SELECTED);
    },
  );

  test("a cost-only response makes a turn with another model unattributed", async () => {
    const reported = await turnOf(running(), [
      assistant({ provider: "openai", model: "other", usage: usage(0, 0, 0.01) }),
      assistant({ ...requested, usage: usage(5, 2, 0.02) }),
    ]);
    expect(reported?.turns?.at(-1)).toMatchObject({ costUsd: 0.03, totalTokens: 7 });
    expect(reported?.turns?.at(-1)?.modelId).toBeUndefined();
  });

  test("a cost-only turn remains visible through the public usage response", async () => {
    const reported = await turnOf(running(), [
      assistant({ ...requested, usage: usage(0, 0, 0.01) }),
    ]);
    expect(reported?.turns?.at(-1)).toMatchObject({
      modelId: SELECTED,
      costUsd: 0.01,
      totalTokens: 0,
    });
  });

  test("an unidentified spender makes a turn with a known model unattributed", async () => {
    const reported = await turnOf(running(), [
      assistant({ model: "missing-provider", usage: usage(2, 1, 0.01) }),
      assistant({ ...requested, usage: usage(5, 2, 0.02) }),
    ]);
    expect(reported?.turns?.at(-1)).toMatchObject({ costUsd: 0.03, totalTokens: 10 });
    expect(reported?.turns?.at(-1)?.modelId).toBeUndefined();
  });

  test.each([true, false])(
    "a zero-spend failure leaves the latest answer's model (live frames: %s)",
    async (emitFrames) => {
      const reported = await turnOf(
        running(),
        [
          assistant({ ...requested, responseModel: "answer", usage: usage(5, 2) }),
          assistant({
            provider: "openai",
            model: "failed",
            stopReason: "error",
            usage: usage(0, 0),
          }),
        ],
        [],
        { emitFrames },
      );
      expect(reported?.modelId).toBe("anthropic/answer");
      expect(reported?.turns?.at(-1)?.modelId).toBe("anthropic/answer");
    },
  );

  test("an answer without usage still provides the latest model", async () => {
    const reported = await turnOf(running(), [
      assistant({ ...requested, responseModel: "answer", usage: usage(0, 0) }),
    ]);

    expect(reported?.modelId).toBe("anthropic/answer");
    expect(reported?.turns?.at(-1)?.modelId).toBeUndefined();
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
