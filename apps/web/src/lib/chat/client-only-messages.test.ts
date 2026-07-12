import { describe, expect, test } from "bun:test";
import { SYSTEM_MESSAGE_PREFIX } from "@/lib/opencode-client";
import {
  createOptimisticNativeMessage,
  mergeNativeMessagesPreservingClientOnly,
} from "./client-only-messages";
import type { NativeMessage } from "./native-message-types";

function createServerMessage(
  id: string,
  content: string,
  createdAt: string,
  fileName?: string,
): NativeMessage {
  const parts: NativeMessage["parts"] = [{ type: "text", content }];
  if (fileName) {
    parts.push({
      type: "file",
      content: fileName,
      fileUrl: `file:///workspace/${fileName}`,
    });
  }

  return {
    id,
    role: "user",
    content,
    parts,
    createdAt,
  };
}

describe("client-only optimistic messages", () => {
  test("includes file parts for optimistic attachments", () => {
    const message = createOptimisticNativeMessage("optimistic-1", "Review this", [
      {
        path: "/workspace/screenshots/error.png",
        previewUrl: "data:image/png;base64,abc123",
        name: "error.png",
      },
    ]);

    expect(message.parts).toEqual([
      { type: "text", content: "Review this" },
      {
        type: "file",
        content: "error.png",
        fileUrl: "data:image/png;base64,abc123",
      },
    ]);
  });

  test("preserves an optimistic message when the server echoes the same text with a different attachment", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-2",
      "Please inspect the screenshot",
      [{ path: "/workspace/a.png", name: "a.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming = [
      createServerMessage(
        "server-1",
        "Please inspect the screenshot",
        "2026-04-15T10:00:02.000Z",
        "b.png",
      ),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged).toHaveLength(2);
    expect(merged.some((message) => message.id === optimistic.id)).toBe(true);
    expect(merged.some((message) => message.id === "server-1")).toBe(true);
  });

  test("drops an optimistic message once the server echoes the same text and attachment", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-3",
      "Please inspect the screenshot",
      [{ path: "/workspace/a.png", name: "a.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming = [
      createServerMessage(
        "server-2",
        "Please inspect the screenshot",
        "2026-04-15T10:00:02.000Z",
        "a.png",
      ),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("server-2");
  });

  test("keeps system messages in chronological order when merging", () => {
    const serverMessage = createServerMessage(
      "server-3",
      "Initial response",
      "2026-04-15T10:00:00.000Z",
    );
    const systemMessage: NativeMessage = {
      id: `${SYSTEM_MESSAGE_PREFIX}naming-1`,
      role: "assistant",
      content: "Naming environment...",
      parts: [{ type: "text", content: "Naming environment..." }],
      createdAt: "2026-04-15T10:00:01.000Z",
    };
    const laterServerMessage = createServerMessage(
      "server-4",
      "Done",
      "2026-04-15T10:00:02.000Z",
    );

    const merged = mergeNativeMessagesPreservingClientOnly(
      [serverMessage, systemMessage],
      [serverMessage, laterServerMessage],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "server-3",
      `${SYSTEM_MESSAGE_PREFIX}naming-1`,
      "server-4",
    ]);
  });
});
