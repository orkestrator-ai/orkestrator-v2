import { describe, expect, test } from "bun:test";
import {
  inspectOpenCodeIncompleteTurn,
  openCodeIncompleteTurnRequestId,
  openCodeTurnRecoveryPrompt,
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
  OPENCODE_PROVIDER_ERROR_CONTINUATION,
  OPENCODE_PROVIDER_ERROR_MAX_AGE_MS,
  OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS,
} from "./opencode-turn-recovery.js";

function user(text: string, id = "user-1", info: Record<string, unknown> = {}) {
  return { info: { id, role: "user", ...info }, parts: [{ type: "text", text }] };
}

function stalledAssistant(
  overrides: {
    id?: string;
    info?: Record<string, unknown>;
    parts?: unknown[];
  } = {},
) {
  return {
    info: {
      id: overrides.id ?? "assistant-1",
      role: "assistant",
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      agent: "build",
      ...overrides.info,
    },
    parts: overrides.parts ?? [
      { type: "step-start" },
      { type: "reasoning", text: "I still need to summarize" },
      { type: "step-finish", reason: "unknown" },
    ],
  };
}

function failedAssistant(
  overrides: { id?: string; statusCode?: number; name?: string; completed?: number } = {},
) {
  return {
    info: {
      id: overrides.id ?? "assistant-1",
      role: "assistant",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      agent: "build",
      finish: undefined,
      time: { created: 1_000, completed: overrides.completed ?? 2_000 },
      error: {
        name: overrides.name ?? "APIError",
        data: {
          message: 'Bad Request: {"model":"deepseek-v4.1-flash"}',
          statusCode: overrides.statusCode ?? 400,
          isRetryable: false,
        },
      },
    },
    // A request that fails before streaming persists no parts at all.
    parts: [],
  };
}

describe("inspectOpenCodeIncompleteTurn provider errors", () => {
  test("retries a provider API error after the first backoff with the turn's settings", () => {
    const recovery = inspectOpenCodeIncompleteTurn([user("Open the PR"), failedAssistant()]);
    expect(recovery).toEqual({
      action: "continue",
      reason: "provider-error",
      notBefore: 2_000 + OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS[0],
      assistantMessageId: "assistant-1",
      modelId: "opencode-go/deepseek-v4.1-flash",
      agent: "build",
    });
    expect(openCodeTurnRecoveryPrompt(recovery!)).toBe(OPENCODE_PROVIDER_ERROR_CONTINUATION);
  });

  test("backs off further for each consecutive retry and exhausts after three", () => {
    const history: unknown[] = [user("Open the PR"), failedAssistant({ id: "assistant-0" })];
    for (let retry = 1; retry <= OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS.length; retry += 1) {
      history.push(
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, `user-retry-${retry}`),
        failedAssistant({ id: `assistant-${retry}`, completed: 10_000 * retry }),
      );
      const recovery = inspectOpenCodeIncompleteTurn(history);
      if (retry < OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS.length) {
        expect(recovery).toMatchObject({
          action: "continue",
          reason: "provider-error",
          notBefore: 10_000 * retry + OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS[retry]!,
          assistantMessageId: `assistant-${retry}`,
        });
      } else {
        expect(recovery).toMatchObject({
          action: "exhausted",
          reason: "provider-error",
          assistantMessageId: `assistant-${retry}`,
        });
        expect(recovery).not.toHaveProperty("notBefore");
      }
    }
  });

  test("exhausts when a bounded history cannot prove where automatic retries began", () => {
    const history: unknown[] = [user("Open the PR")];
    for (let retry = 0; retry < 4; retry += 1) {
      history.push(user(OPENCODE_PROVIDER_ERROR_CONTINUATION, `retry-${retry}`));
      history.push(
        ...Array.from({ length: 62 }, (_, index) =>
          stalledAssistant({
            id: `tool-heavy-${retry}-${index}`,
            parts: [{ type: "tool", state: { status: "completed" } }],
          }),
        ),
      );
      history.push(failedAssistant({ id: `failed-${retry}` }));
    }
    expect(
      inspectOpenCodeIncompleteTurn(history.slice(-64), { historyComplete: false }),
    ).toMatchObject({
      action: "exhausted",
      reason: "provider-error",
      assistantMessageId: "failed-3",
    });
  });

  test("does not retry an old, future, or undated provider failure", () => {
    const now = 1_000_000;
    expect(
      inspectOpenCodeIncompleteTurn([user("Open the PR"), failedAssistant()], { now }),
    ).toBeNull();
    expect(
      inspectOpenCodeIncompleteTurn(
        [user("Open the PR"), failedAssistant({ completed: now + 1 })],
        { now },
      ),
    ).toBeNull();
    const undated = failedAssistant();
    undated.info.time = { created: Number.NaN, completed: Number.NaN };
    expect(inspectOpenCodeIncompleteTurn([user("Open the PR"), undated], { now })).toBeNull();
    expect(
      inspectOpenCodeIncompleteTurn(
        [
          user("Open the PR"),
          failedAssistant({ completed: now - OPENCODE_PROVIDER_ERROR_MAX_AGE_MS }),
        ],
        { now },
      ),
    ).toMatchObject({ action: "continue", reason: "provider-error" });
  });

  test("a manual prompt resets the retry budget", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Open the PR"),
        failedAssistant({ id: "assistant-1" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-2"),
        failedAssistant({ id: "assistant-2" }),
        user("Why did you stop?", "user-3"),
        failedAssistant({ id: "assistant-3" }),
      ]),
    ).toMatchObject({
      action: "continue",
      notBefore: 2_000 + OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS[0],
    });
  });

  test("does not retry deterministic failures", () => {
    for (const statusCode of [401, 402, 403, 404, 413]) {
      expect(
        inspectOpenCodeIncompleteTurn([user("Open the PR"), failedAssistant({ statusCode })]),
      ).toBeNull();
    }
    for (const name of ["MessageAbortedError", "ProviderAuthError", "MessageOutputLengthError"]) {
      expect(
        inspectOpenCodeIncompleteTurn([user("Open the PR"), failedAssistant({ name })]),
      ).toBeNull();
    }
  });

  test("retries transient statuses and errors without a status", () => {
    for (const statusCode of [429, 500, 502, 503, 529]) {
      expect(
        inspectOpenCodeIncompleteTurn([user("Open the PR"), failedAssistant({ statusCode })]),
      ).toMatchObject({ action: "continue", reason: "provider-error" });
    }
    const withoutStatus = failedAssistant();
    delete (withoutStatus.info.error.data as { statusCode?: number }).statusCode;
    expect(inspectOpenCodeIncompleteTurn([user("Open the PR"), withoutStatus])).toMatchObject({
      action: "continue",
      reason: "provider-error",
    });
  });

  test("does not retry while tool work from the turn is still pending", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Open the PR"),
        {
          info: { id: "assistant-tools", role: "assistant" },
          parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
        },
        failedAssistant({ id: "assistant-2" }),
      ]),
    ).toBeNull();
  });
});

describe("inspectOpenCodeIncompleteTurn", () => {
  test("continues an unknown reasoning-only finish with the turn's model and agent", () => {
    expect(inspectOpenCodeIncompleteTurn([user("Review this"), stalledAssistant()])).toEqual({
      action: "continue",
      reason: "incomplete",
      assistantMessageId: "assistant-1",
      modelId: "opencode-go/deepseek-v4-flash",
      agent: "build",
    });
  });

  test("preserves model, agent, and variant from the authoritative user request", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this", "user-1", {
          request: {
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
            agent: "reviewer",
            variant: "high",
          },
        }),
        stalledAssistant(),
      ]),
    ).toEqual({
      action: "continue",
      reason: "incomplete",
      assistantMessageId: "assistant-1",
      modelId: "anthropic/claude-sonnet",
      agent: "reviewer",
      variant: "high",
    });
  });

  test("supports the legacy direct user execution-setting shape", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this", "user-1", {
          model: { providerID: "openai", modelID: "gpt-5" },
          agent: "plan",
          variant: "low",
        }),
        stalledAssistant(),
      ]),
    ).toMatchObject({
      modelId: "openai/gpt-5",
      agent: "plan",
      variant: "low",
    });
  });

  test("falls back to the message-level finish field when no step-finish part exists", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({
          info: { finish: "unknown" },
          parts: [{ type: "reasoning", text: "thinking" }],
        }),
      ]),
    ).toMatchObject({ action: "continue", assistantMessageId: "assistant-1" });
  });

  test("reports exhausted when the latest user turn is already the continuation", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({ id: "assistant-1" }),
        user(OPENCODE_INCOMPLETE_TURN_CONTINUATION, "user-2"),
        stalledAssistant({ id: "assistant-2" }),
      ]),
    ).toMatchObject({ action: "exhausted", assistantMessageId: "assistant-2" });
  });

  test("does not recover usable text, other finish reasons, errors, or pending work", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({
          parts: [
            { type: "text", text: "A real answer" },
            { type: "step-finish", reason: "unknown" },
          ],
        }),
      ]),
    ).toBeNull();
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "step-finish", reason: "stop" },
          ],
        }),
      ]),
    ).toBeNull();
    // A user stop stamps MessageAbortedError on the assistant message; an
    // errored turn must never be auto-continued.
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({ info: { error: { name: "MessageAbortedError" } } }),
      ]),
    ).toBeNull();
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        {
          info: { id: "assistant-tools", role: "assistant" },
          parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
        },
        stalledAssistant(),
      ]),
    ).toBeNull();
  });

  test("returns null with no assistant after the latest user message", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant(),
        user("A newer prompt", "user-2"),
      ]),
    ).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([stalledAssistant()])).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([])).toBeNull();
  });

  test("omits model and agent when the assistant message reports none", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        stalledAssistant({
          info: { providerID: undefined, modelID: undefined, agent: undefined },
        }),
      ]),
    ).toEqual({ action: "continue", reason: "incomplete", assistantMessageId: "assistant-1" });
  });

  test("bounds alternating automatic continuations with the shared retry budget", () => {
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        failedAssistant({ id: "assistant-1" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-2"),
        failedAssistant({ id: "assistant-2" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-3"),
        stalledAssistant({ id: "assistant-3" }),
        user(OPENCODE_INCOMPLETE_TURN_CONTINUATION, "user-4"),
        failedAssistant({ id: "assistant-4" }),
      ]),
    ).toMatchObject({ action: "exhausted", reason: "provider-error" });
    expect(
      inspectOpenCodeIncompleteTurn([
        user("Review this"),
        failedAssistant({ id: "assistant-1" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-2"),
        failedAssistant({ id: "assistant-2" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-3"),
        failedAssistant({ id: "assistant-3" }),
        user(OPENCODE_PROVIDER_ERROR_CONTINUATION, "user-4"),
        stalledAssistant({ id: "assistant-4" }),
      ]),
    ).toMatchObject({ action: "exhausted", reason: "incomplete" });
  });

  test("derives a stable durable request id from the stalled assistant", () => {
    expect(openCodeIncompleteTurnRequestId("msg_abc")).toBe("opencode-incomplete-msg_abc");
  });
});
