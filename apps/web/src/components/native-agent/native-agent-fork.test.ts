import { describe, expect, test } from "bun:test";
import { buildMessageForkPlan } from "@/components/chat/message-fork";
import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  resolveNativeAgentPromptBoundary,
  resolveNativeAgentResponseBoundary,
} from "./native-agent-fork";

function message(
  id: string,
  role: NativeMessage["role"],
  extra: Partial<NativeMessage> = {},
): NativeMessage {
  const content = extra.content ?? id;
  return {
    id,
    role,
    content,
    parts: extra.parts ?? [{ type: "text", content }],
    createdAt: extra.createdAt ?? "2026-07-27T12:00:00.000Z",
    ...extra,
  };
}

/** A Codex (or OpenCode) turn that splits into text, tools, then more text. */
function splitCodexTurn(id: string, turnId: string): NativeMessage[] {
  return normalizeNativeMessages([
    message(id, "assistant", {
      turnId,
      content: "BeforeAfter",
      parts: [
        {
          type: "text",
          content: "Before",
          createdAt: "2026-07-27T12:00:05.000Z",
        },
        {
          type: "tool-invocation",
          content: "Read",
          toolName: "Read",
          createdAt: "2026-07-27T12:00:20.000Z",
        },
        {
          type: "text",
          content: "After",
          createdAt: "2026-07-27T12:00:40.000Z",
        },
      ],
    }),
  ]);
}

describe("native agent fork boundaries", () => {
  test("Codex response and following-prompt forks use the persisted id after a split", () => {
    const rows = splitCodexTurn("codex-1", "turn-1");
    expect(rows.map((row) => row.id)).toEqual([
      "codex-1",
      "codex-1:text-block:1",
      "codex-1:text-block:2",
    ]);

    const messages = [
      message("user-1", "user", { turnId: "turn-1" }),
      ...rows,
      message("user-2", "user", { turnId: "turn-2" }),
    ];
    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      resolvePromptBoundary: (candidate, all) =>
        resolveNativeAgentPromptBoundary("codex", candidate, all),
      resolveResponseBoundary: (candidate, all) =>
        resolveNativeAgentResponseBoundary("codex", candidate, all),
    });

    expect(plan.get("codex-1")?.boundary).toEqual({
      type: "message",
      messageId: "codex-1",
    });
    expect(plan.get("codex-1:text-block:1")?.boundary).toEqual({
      type: "message",
      messageId: "codex-1",
    });
    expect(plan.get("codex-1:text-block:2")?.boundary).toEqual({
      type: "message",
      messageId: "codex-1",
    });
    expect(plan.get("user-2")?.boundary).toEqual({
      type: "message",
      messageId: "codex-1",
    });
  });

  test("OpenCode response forks skip sibling split rows and keep persisted ids", () => {
    const rows = splitCodexTurn("oc-1", "turn-1");
    const messages = [message("user-1", "user"), ...rows, message("user-2", "user")];
    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      resolvePromptBoundary: (candidate, all) =>
        resolveNativeAgentPromptBoundary("opencode", candidate, all),
      resolveResponseBoundary: (candidate, all) =>
        resolveNativeAgentResponseBoundary("opencode", candidate, all),
    });

    expect(plan.get("oc-1:text-block:1")?.boundary).toEqual({
      type: "message",
      messageId: "user-2",
    });
    expect(plan.get("user-1")?.boundary).toEqual({
      type: "message",
      messageId: "user-1",
    });
  });

  test("Claude prompt forks branch at the previous turn's persisted source id", () => {
    // Every part carries the persisted id, so the boundary comes from the part
    // rather than from the split display row that happens to hold it.
    const rows = normalizeNativeMessages([
      message("claude-1", "assistant", {
        content: "BeforeAfter",
        parts: [
          { type: "text", content: "Before", sourceMessageId: "persisted-1" },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            sourceMessageId: "persisted-1",
          },
          { type: "text", content: "After", sourceMessageId: "persisted-1" },
        ],
      }),
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "claude-1",
      "claude-1:text-block:1",
      "claude-1:text-block:2",
    ]);

    const messages = [message("user-1", "user"), ...rows, message("user-2", "user")];
    const boundaryFor = (id: string) =>
      resolveNativeAgentPromptBoundary(
        "claude",
        messages.find((candidate) => candidate.id === id)!,
        messages,
      );

    expect(boundaryFor("user-2")).toEqual({
      type: "message",
      messageId: "persisted-1",
    });
    expect(boundaryFor("user-1")).toEqual({ type: "session-start" });
  });

  test("Claude prompt forks fall back to the split row's stripped id", () => {
    // A transcript whose parts predate `sourceMessageId` must still resolve to
    // an id the bridge stored, never to a `:text-block:` display row.
    const rows = splitCodexTurn("claude-1", "turn-1");
    const messages = [...rows, message("user-2", "user")];

    expect(resolveNativeAgentPromptBoundary("claude", messages.at(-1)!, messages)).toEqual({
      type: "message",
      messageId: "claude-1",
    });
  });

  test("Claude response forks map a split display row back to the source message", () => {
    const rows = splitCodexTurn("claude-1", "turn-1");
    const plan = buildMessageForkPlan(rows, {
      responseInProgress: false,
      resolvePromptBoundary: (candidate, all) =>
        resolveNativeAgentPromptBoundary("claude", candidate, all),
      resolveResponseBoundary: (candidate, all) =>
        resolveNativeAgentResponseBoundary("claude", candidate, all),
    });

    expect(plan.get("claude-1:text-block:2")?.boundary).toEqual({
      type: "message",
      messageId: "claude-1",
    });
  });

  test("Claude forks use the final source id in a coalesced tool block", () => {
    const rows = normalizeNativeMessages([
      message("claude-1", "assistant", {
        content: "",
        parts: [{ type: "tool-invocation", content: "Read", toolName: "Read" }],
        createdAt: "2026-07-27T12:00:01.000Z",
      }),
      message("claude-2", "assistant", {
        content: "",
        parts: [{ type: "tool-invocation", content: "Grep", toolName: "Grep" }],
        createdAt: "2026-07-27T12:00:20.000Z",
      }),
    ]);
    expect(rows).toHaveLength(1);

    const messages = [message("user-1", "user"), ...rows, message("user-2", "user")];
    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      resolvePromptBoundary: (candidate, all) =>
        resolveNativeAgentPromptBoundary("claude", candidate, all),
      resolveResponseBoundary: (candidate, all) =>
        resolveNativeAgentResponseBoundary("claude", candidate, all),
    });

    expect(plan.get("claude-1")?.boundary).toEqual({
      type: "message",
      messageId: "claude-2",
    });
    expect(plan.get("user-2")?.boundary).toEqual({
      type: "message",
      messageId: "claude-2",
    });
  });
});
