import { describe, expect, test } from "bun:test";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import {
  createOptimisticNativeMessage,
  isClientOnlyNativeMessage,
  isOptimisticNativeMessage,
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

function createClientOnlyMessage(
  id: string,
  content: string,
  createdAt: string,
): NativeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt,
  };
}

describe("client-only optimistic messages", () => {
  test("classifies optimistic, error, and system ids as client-only", () => {
    expect(isOptimisticNativeMessage({ id: "optimistic-123" })).toBe(true);
    expect(isOptimisticNativeMessage({ id: "server-123" })).toBe(false);

    expect(isClientOnlyNativeMessage({ id: "optimistic-123" })).toBe(true);
    expect(isClientOnlyNativeMessage({ id: `${ERROR_MESSAGE_PREFIX}123` })).toBe(true);
    expect(isClientOnlyNativeMessage({ id: `${SYSTEM_MESSAGE_PREFIX}123` })).toBe(true);
    expect(isClientOnlyNativeMessage({ id: "server-123" })).toBe(false);
  });

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

  test("omits the file url for an attachment whose path is not absolute", () => {
    const message = createOptimisticNativeMessage("optimistic-relative", "Look at this", [
      { path: "screenshots/error.png", name: "error.png" },
    ]);

    expect(message.parts[1]).toEqual({
      type: "file",
      content: "error.png",
      fileUrl: undefined,
    });
  });

  test("encodes an absolute attachment path when building the file url", () => {
    // `#` and `?` are legal URI delimiters that encodeURI leaves alone, so a
    // filename containing either would otherwise truncate into a fragment or
    // query and resolve to the wrong file.
    const message = createOptimisticNativeMessage("optimistic-encoded", "Look at this", [
      { path: "/workspace/screen shots/error #1.png", name: "error #1.png" },
    ]);

    expect(message.parts[1]).toEqual({
      type: "file",
      content: "error #1.png",
      fileUrl: "file:///workspace/screen%20shots/error%20%231.png",
    });
  });

  test("escapes a question mark in an attachment path", () => {
    const message = createOptimisticNativeMessage("optimistic-query", "Look at this", [
      { path: "/workspace/is it broken?.png", name: "is it broken?.png" },
    ]);

    expect(message.parts[1]).toEqual({
      type: "file",
      content: "is it broken?.png",
      fileUrl: "file:///workspace/is%20it%20broken%3F.png",
    });
  });

  test("drops an optimistic message whose text only differs from the server echo by CRLF line endings", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-crlf",
      "line one\r\nline two",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming = [
      createServerMessage("server-crlf", "line one\nline two", "2026-04-15T10:00:02.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-crlf"]);
  });

  test("drops an optimistic message whose text only differs from the server echo by surrounding whitespace", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-trim",
      "  Deploy the app\n",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming = [
      createServerMessage("server-trim", "Deploy the app", "2026-04-15T10:00:02.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-trim"]);
  });

  test("drops both optimistic messages when the same text was sent twice and echoed twice", () => {
    const first = createOptimisticNativeMessage(
      "optimistic-dup-1",
      "run the tests",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    const second = createOptimisticNativeMessage(
      "optimistic-dup-2",
      "run the tests",
      [],
      "2026-04-15T10:00:02.000Z",
    );
    const incoming = [
      createServerMessage("server-dup-1", "run the tests", "2026-04-15T10:00:03.000Z"),
      createServerMessage("server-dup-2", "run the tests", "2026-04-15T10:00:04.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([first, second], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-dup-1", "server-dup-2"]);
  });

  test("drops only one optimistic message when two identical sends share a single server echo", () => {
    const first = createOptimisticNativeMessage(
      "optimistic-half-1",
      "run the tests",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    const second = createOptimisticNativeMessage(
      "optimistic-half-2",
      "run the tests",
      [],
      "2026-04-15T10:00:02.000Z",
    );
    const incoming = [
      createServerMessage("server-half-1", "run the tests", "2026-04-15T10:00:00.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([first, second], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "server-half-1",
      "optimistic-half-2",
    ]);
  });

  test("preserves an optimistic message when the matching incoming echo was already present as a server message", () => {
    const alreadyEchoed = createServerMessage(
      "server-existing",
      "run the tests",
      "2026-04-15T10:00:00.000Z",
    );
    const optimistic = createOptimisticNativeMessage(
      "optimistic-unechoed",
      "run the tests",
      [],
      "2026-04-15T10:00:01.000Z",
    );

    const merged = mergeNativeMessagesPreservingClientOnly(
      [alreadyEchoed, optimistic],
      [alreadyEchoed],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "server-existing",
      "optimistic-unechoed",
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

  test("keeps error messages in chronological order when merging", () => {
    const serverMessage = createServerMessage(
      "server-5",
      "Initial response",
      "2026-04-15T10:00:00.000Z",
    );
    const errorMessage = createClientOnlyMessage(
      `${ERROR_MESSAGE_PREFIX}stream-1`,
      "Stream disconnected",
      "2026-04-15T10:00:01.000Z",
    );
    const laterServerMessage = createServerMessage(
      "server-6",
      "Recovered",
      "2026-04-15T10:00:02.000Z",
    );

    const merged = mergeNativeMessagesPreservingClientOnly(
      [serverMessage, errorMessage],
      [serverMessage, laterServerMessage],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "server-5",
      `${ERROR_MESSAGE_PREFIX}stream-1`,
      "server-6",
    ]);
  });

  test("places a client-only message older than every incoming message first", () => {
    const errorMessage = createClientOnlyMessage(
      `${ERROR_MESSAGE_PREFIX}startup-1`,
      "Session failed to start",
      "2026-04-15T09:59:59.000Z",
    );
    const incoming = [
      createServerMessage("server-7", "First", "2026-04-15T10:00:00.000Z"),
      createServerMessage("server-8", "Second", "2026-04-15T10:00:01.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([errorMessage], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      `${ERROR_MESSAGE_PREFIX}startup-1`,
      "server-7",
      "server-8",
    ]);
  });

  test("does not duplicate a client-only message that the incoming snapshot already contains by id", () => {
    const systemId = `${SYSTEM_MESSAGE_PREFIX}naming-2`;
    const staleSystemMessage = createClientOnlyMessage(
      systemId,
      "Naming environment...",
      "2026-04-15T10:00:01.000Z",
    );
    const incomingSystemMessage = createClientOnlyMessage(
      systemId,
      "Named environment",
      "2026-04-15T10:00:01.000Z",
    );
    const serverMessage = createServerMessage(
      "server-9",
      "Initial response",
      "2026-04-15T10:00:00.000Z",
    );

    const merged = mergeNativeMessagesPreservingClientOnly(
      [serverMessage, staleSystemMessage],
      [serverMessage, incomingSystemMessage],
    );

    expect(merged.map((message) => message.id)).toEqual(["server-9", systemId]);
    expect(merged[1]?.content).toBe("Named environment");
  });
});
