import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  buildMessageForkActionKinds,
  findNextForkMessage,
  findPreviousForkMessage,
  getForkPromptText,
} from "./message-fork";

function message(
  id: string,
  role: NativeMessage["role"],
  content = id,
): NativeMessage {
  return {
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-07-27T12:00:00.000Z",
  };
}

describe("message fork placement", () => {
  test("adds actions to every prompt and only the bottom of each response", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1a", "assistant"),
      message("assistant-1b", "assistant"),
      message("user-2", "user"),
      message("assistant-2", "assistant"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, false)),
    ).toEqual([
      ["user-1", "prompt"],
      ["assistant-1b", "response"],
      ["user-2", "prompt"],
      ["assistant-2", "response"],
    ]);
  });

  test("does not expose an unfinished response or client-only optimistic prompt", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("optimistic-user-2", "user"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, true)),
    ).toEqual([["user-1", "prompt"]]);
  });
});

describe("message fork boundaries", () => {
  const messages = [
    message("user-1", "user"),
    message("assistant-1", "assistant"),
    message("system-local", "system"),
    message("user-2", "user", "Edit this prompt"),
    message("assistant-2", "assistant"),
  ];

  test("finds the persisted messages on either side of a selection", () => {
    expect(findPreviousForkMessage(messages, "user-2")?.id).toBe("assistant-1");
    expect(findNextForkMessage(messages, "assistant-1")?.id).toBe("user-2");
  });

  test("extracts the selected prompt text for the new draft", () => {
    expect(getForkPromptText(messages[3]!)).toBe("Edit this prompt");
  });
});

