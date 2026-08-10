import { describe, expect, test } from "bun:test";
import {
  inspectOpenCodeIncompleteTurn,
  openCodeIncompleteTurnRequestId,
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
} from "./opencode-turn-recovery.js";

function user(
  text: string,
  id = "user-1",
  info: Record<string, unknown> = {},
) {
  return { info: { id, role: "user", ...info }, parts: [{ type: "text", text }] };
}

function stalledAssistant(overrides: {
  id?: string;
  info?: Record<string, unknown>;
  parts?: unknown[];
} = {}) {
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

describe("inspectOpenCodeIncompleteTurn", () => {
  test("continues an unknown reasoning-only finish with the turn's model and agent", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant(),
    ])).toEqual({
      action: "continue",
      assistantMessageId: "assistant-1",
      modelId: "opencode-go/deepseek-v4-flash",
      agent: "build",
    });
  });

  test("preserves model, agent, and variant from the authoritative user request", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this", "user-1", {
        request: {
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
          agent: "reviewer",
          variant: "high",
        },
      }),
      stalledAssistant(),
    ])).toEqual({
      action: "continue",
      assistantMessageId: "assistant-1",
      modelId: "anthropic/claude-sonnet",
      agent: "reviewer",
      variant: "high",
    });
  });

  test("supports the legacy direct user execution-setting shape", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this", "user-1", {
        model: { providerID: "openai", modelID: "gpt-5" },
        agent: "plan",
        variant: "low",
      }),
      stalledAssistant(),
    ])).toMatchObject({
      modelId: "openai/gpt-5",
      agent: "plan",
      variant: "low",
    });
  });

  test("falls back to the message-level finish field when no step-finish part exists", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({
        info: { finish: "unknown" },
        parts: [{ type: "reasoning", text: "thinking" }],
      }),
    ])).toMatchObject({ action: "continue", assistantMessageId: "assistant-1" });
  });

  test("reports exhausted when the latest user turn is already the continuation", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({ id: "assistant-1" }),
      user(OPENCODE_INCOMPLETE_TURN_CONTINUATION, "user-2"),
      stalledAssistant({ id: "assistant-2" }),
    ])).toMatchObject({ action: "exhausted", assistantMessageId: "assistant-2" });
  });

  test("does not recover usable text, other finish reasons, errors, or pending work", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({
        parts: [
          { type: "text", text: "A real answer" },
          { type: "step-finish", reason: "unknown" },
        ],
      }),
    ])).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "step-finish", reason: "stop" },
        ],
      }),
    ])).toBeNull();
    // A user stop stamps MessageAbortedError on the assistant message; an
    // errored turn must never be auto-continued.
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({ info: { error: { name: "MessageAbortedError" } } }),
    ])).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      {
        info: { id: "assistant-tools", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
      },
      stalledAssistant(),
    ])).toBeNull();
  });

  test("returns null with no assistant after the latest user message", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant(),
      user("A newer prompt", "user-2"),
    ])).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([stalledAssistant()])).toBeNull();
    expect(inspectOpenCodeIncompleteTurn([])).toBeNull();
  });

  test("omits model and agent when the assistant message reports none", () => {
    expect(inspectOpenCodeIncompleteTurn([
      user("Review this"),
      stalledAssistant({
        info: { providerID: undefined, modelID: undefined, agent: undefined },
      }),
    ])).toEqual({ action: "continue", assistantMessageId: "assistant-1" });
  });

  test("derives a stable durable request id from the stalled assistant", () => {
    expect(openCodeIncompleteTurnRequestId("msg_abc")).toBe(
      "opencode-incomplete-msg_abc",
    );
  });
});
