import { describe, expect, test } from "bun:test";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import {
  carryOverMessagesAddedDuringFetch,
  createOptimisticNativeMessage,
  isClientOnlyNativeMessage,
  isOptimisticNativeMessage,
  mergeNativeMessagesPreservingClientOnly,
  normalizeMessageContent,
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

  test("omits an empty text part from an attachment-only optimistic message", () => {
    const message = createOptimisticNativeMessage("optimistic-attachment-only", "", [
      {
        path: "/workspace/screenshots/error.png",
        name: "error.png",
      },
    ]);

    expect(message.parts).toEqual([{
      type: "file",
      content: "error.png",
      fileUrl: "file:///workspace/screenshots/error.png",
    }]);
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

  test("drops an optimistic attachment message when the echo names the same file with a different url", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-attachment",
      "Please inspect the screenshot",
      [{
        path: "/workspace/a.png",
        name: "a.png",
        previewUrl: "data:image/png;base64,abc123",
      }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-attachment",
        role: "user",
        content: "Please inspect the screenshot",
        parts: [
          { type: "text", content: "Please inspect the screenshot" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-attachment"]);
  });

  test("retires an attachment-only optimistic message against an echo carrying an empty text part", () => {
    // The OpenCode shape. Its client always sends `{ type: "text", text }` even
    // for an attachment-only prompt (`sendPrompt` in `opencode-client.ts`) and
    // `normalizeOpenCodePart` keeps a zero-length text part, whereas the Codex
    // bridge omits it. This helper is shared, so the fingerprint has to match
    // both or one agent duplicates every attachment-only prompt forever.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-empty-text-echo",
      "",
      [{ path: "/workspace/a.png", name: "a.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-empty-text-echo",
        role: "user",
        content: "",
        parts: [
          { type: "text", content: "" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-empty-text-echo"]);
  });

  test("keeps an attachment-only optimistic message when the echo names a different file", () => {
    // Ignoring the empty text part must not make every attachment-only prompt
    // interchangeable: the filename still carries the whole identity.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-empty-text-mismatch",
      "",
      [{ path: "/workspace/a.png", name: "a.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-empty-text-other-file",
        role: "user",
        content: "",
        parts: [
          { type: "text", content: "" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/b.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "optimistic-empty-text-mismatch",
      "server-empty-text-other-file",
    ]);
  });

  test("keeps an optimistic attachment message when the echo names a different file even with a matching url", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-different-file",
      "Please inspect the screenshot",
      [{ path: "/workspace/a.png", name: "a.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-different-file",
        role: "user",
        content: "Please inspect the screenshot",
        parts: [
          { type: "text", content: "Please inspect the screenshot" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "optimistic-different-file",
      "server-different-file",
    ]);
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

  describe("normalizeMessageContent", () => {
    test("collapses CRLF pairs and trims surrounding whitespace", () => {
      expect(normalizeMessageContent("  run\r\nthe tests\r\n  ")).toBe("run\nthe tests");
    });

    test("leaves a lone carriage return alone", () => {
      // Only CRLF pairs are line-ending noise. A bare \r is content, and
      // rewriting it would make two genuinely different prompts compare equal.
      expect(normalizeMessageContent("run\rthe tests")).toBe("run\rthe tests");
    });

    test("returns an empty string for whitespace-only content", () => {
      // findOptimisticEchoBase treats this as "no usable content" and declines
      // to claim an optimistic bubble, so the empty result is load-bearing.
      expect(normalizeMessageContent("   \r\n\t  ")).toBe("");
      expect(normalizeMessageContent("")).toBe("");
    });

    test("preserves interior whitespace, tabs, and unicode", () => {
      expect(normalizeMessageContent(" a\tb  c 🎉 ")).toBe("a\tb  c 🎉");
    });
  });

  test("retires an optimistic attachment against a same-named file in a different directory", () => {
    // Documented trade-off of excluding `fileUrl` from the fingerprint: the
    // filename is the whole attachment identity, so a same-named file from
    // another directory collides. See the comment on `getPartFingerprint` for
    // why this cannot be narrowed symmetrically. This test exists to make the
    // collision visible if anyone changes the fingerprint.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-same-basename",
      "Please inspect the screenshot",
      [{ path: "/one/logo.png", name: "logo.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-same-basename",
        role: "user",
        content: "Please inspect the screenshot",
        parts: [
          { type: "text", content: "Please inspect the screenshot" },
          { type: "file", content: "logo.png", fileUrl: "file:///two/logo.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-same-basename"]);
  });

  test("retires the oldest pending send first when two optimistic attachments collide", () => {
    // The collision above is survivable because retirement is ordered: the
    // first echo retires the earliest send, so a second echo still retires the
    // second send rather than both prompts vanishing at once.
    const first = createOptimisticNativeMessage(
      "optimistic-collide-first",
      "Check it",
      [{ path: "/one/logo.png", name: "logo.png" }],
      "2026-04-15T10:00:00.000Z",
    );
    const second = createOptimisticNativeMessage(
      "optimistic-collide-second",
      "Check it",
      [{ path: "/two/logo.png", name: "logo.png" }],
      "2026-04-15T10:00:01.000Z",
    );
    const echo: NativeMessage = {
      id: "server-collide-1",
      role: "user",
      content: "Check it",
      parts: [
        { type: "text", content: "Check it" },
        { type: "file", content: "logo.png", fileUrl: "file:///one/logo.png" },
      ],
      createdAt: "2026-04-15T10:00:02.000Z",
    };

    const afterFirstEcho = mergeNativeMessagesPreservingClientOnly(
      [first, second],
      [echo],
    );

    // The surviving bubble keeps its own (earlier) send time, so it sorts
    // ahead of the echo it is still waiting for.
    expect(afterFirstEcho.map((message) => message.id)).toEqual([
      "optimistic-collide-second",
      "server-collide-1",
    ]);
  });

  test("retires an optimistic attachment when the echo lists the same files in a different order", () => {
    // Part fingerprints are sorted, so a live echo that streams its file part
    // before its text part still retires the bubble instead of waiting for the
    // final transcript refresh.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-two-files",
      "Compare these",
      [
        { path: "/workspace/a.png", name: "a.png" },
        { path: "/workspace/b.png", name: "b.png" },
      ],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-two-files",
        role: "user",
        content: "Compare these",
        parts: [
          { type: "text", content: "Compare these" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/b.png" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-two-files"]);
  });

  test("keeps an optimistic prompt when the echo reorders its text parts", () => {
    // Sorting part fingerprints must not collapse two genuinely different
    // messages. Reordered text changes the aggregate `content`, which is
    // fingerprinted separately and keeps them apart.
    const optimistic: NativeMessage = {
      id: "optimistic-reordered-text",
      role: "user",
      content: "onetwo",
      parts: [
        { type: "text", content: "one" },
        { type: "text", content: "two" },
      ],
      createdAt: "2026-04-15T10:00:01.000Z",
    };
    const incoming: NativeMessage[] = [
      {
        id: "server-reordered-text",
        role: "user",
        content: "twoone",
        parts: [
          { type: "text", content: "two" },
          { type: "text", content: "one" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "optimistic-reordered-text",
      "server-reordered-text",
    ]);
  });

  test("retires an optimistic attachment listing the same files in the same order", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-two-files-ordered",
      "Compare these",
      [
        { path: "/workspace/a.png", name: "a.png" },
        { path: "/workspace/b.png", name: "b.png" },
      ],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-two-files-ordered",
        role: "user",
        content: "Compare these",
        parts: [
          { type: "text", content: "Compare these" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/b.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-two-files-ordered"]);
  });

  test("retires an optimistic attachment sent from a relative path", () => {
    // toOptimisticFileUrl declines to build a file:// url for a relative path,
    // so the optimistic part carries no fileUrl at all. Now that the
    // fingerprint ignores fileUrl, the name still carries the match.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-relative",
      "Read this",
      [{ path: "notes/todo.md", name: "todo.md" }],
      "2026-04-15T10:00:01.000Z",
    );
    expect(optimistic.parts[1]?.fileUrl).toBeUndefined();

    const incoming: NativeMessage[] = [
      {
        id: "server-relative",
        role: "user",
        content: "Read this",
        parts: [
          { type: "text", content: "Read this" },
          { type: "file", content: "todo.md", fileUrl: "file:///workspace/notes/todo.md" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual(["server-relative"]);
  });

  test("falls back to the attachment path when it has no name", () => {
    const optimistic = createOptimisticNativeMessage(
      "optimistic-unnamed",
      "Read this",
      [{ path: "/workspace/todo.md", name: "" }],
      "2026-04-15T10:00:01.000Z",
    );

    expect(optimistic.parts[1]).toMatchObject({
      type: "file",
      content: "/workspace/todo.md",
    });

    // The echo reports a bare filename, which no longer matches the path
    // fallback, so the bubble is preserved rather than wrongly retired.
    const incoming: NativeMessage[] = [
      {
        id: "server-unnamed",
        role: "user",
        content: "Read this",
        parts: [
          { type: "text", content: "Read this" },
          { type: "file", content: "todo.md", fileUrl: "file:///workspace/todo.md" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "optimistic-unnamed",
      "server-unnamed",
    ]);
  });

  test("never retires an optimistic user prompt against an assistant message repeating its text", () => {
    // The role guard in couldMatchOptimistic is what stops an agent that
    // restates the prompt from swallowing the user's own bubble.
    const optimistic = createOptimisticNativeMessage(
      "optimistic-restated",
      "Run the tests",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    const incoming: NativeMessage[] = [
      {
        id: "server-assistant-echo",
        role: "assistant",
        content: "Run the tests",
        parts: [{ type: "text", content: "Run the tests" }],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([optimistic], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "optimistic-restated",
      "server-assistant-echo",
    ]);
  });

  test("sorts a client-only message with no timestamp to the front", () => {
    // `new Date(createdAt || 0)` treats a missing timestamp as the epoch. This
    // pins the current placement so a future change to the fallback is a
    // deliberate one rather than a silently reordered transcript.
    const errorMessage: NativeMessage = {
      id: `${ERROR_MESSAGE_PREFIX}no-clock`,
      role: "assistant",
      content: "Failed to send prompt",
      parts: [{ type: "text", content: "Failed to send prompt" }],
      createdAt: "",
    };
    const incoming = [
      createServerMessage("server-5", "Hello", "2026-04-15T10:00:00.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([errorMessage], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      `${ERROR_MESSAGE_PREFIX}no-clock`,
      "server-5",
    ]);
  });

  test("places a client-only message after an incoming message sharing its timestamp", () => {
    const clientOnly = createClientOnlyMessage(
      `${ERROR_MESSAGE_PREFIX}tied`,
      "Failed to send prompt",
      "2026-04-15T10:00:00.000Z",
    );
    const incoming = [
      createServerMessage("server-6", "Hello", "2026-04-15T10:00:00.000Z"),
    ];

    const merged = mergeNativeMessagesPreservingClientOnly([clientOnly], incoming);

    expect(merged.map((message) => message.id)).toEqual([
      "server-6",
      `${ERROR_MESSAGE_PREFIX}tied`,
    ]);
  });

  test("returns the incoming array by reference when there is nothing client-only to preserve", () => {
    // The store's identity-preserving no-op write depends on this shape.
    const incoming = [
      createServerMessage("server-7", "Hello", "2026-04-15T10:00:00.000Z"),
    ];

    expect(mergeNativeMessagesPreservingClientOnly([], incoming)).toBe(incoming);

    const optimistic = createOptimisticNativeMessage(
      "optimistic-only",
      "Hello",
      [],
      "2026-04-15T10:00:01.000Z",
    );
    // Every client-only message is retired, so the incoming array survives
    // untouched rather than being rebuilt.
    expect(
      mergeNativeMessagesPreservingClientOnly([optimistic], incoming),
    ).toBe(incoming);
  });

  describe("carryOverMessagesAddedDuringFetch", () => {
    const snapshotMessage = createServerMessage(
      "server-prior",
      "Earlier prompt",
      "2026-04-15T10:00:00.000Z",
    );

    test("appends an authoritative message that arrived while the fetch was in flight", () => {
      const liveEcho = createServerMessage(
        "server-live",
        "Newer prompt",
        "2026-04-15T10:00:05.000Z",
      );

      const carried = carryOverMessagesAddedDuringFetch(
        [snapshotMessage],
        [snapshotMessage, liveEcho],
        new Set(["server-prior"]),
      );

      expect(carried.map((message) => message.id)).toEqual([
        "server-prior",
        "server-live",
      ]);
    });

    test("drops a message the server removed rather than resurrecting it", () => {
      const removed = createServerMessage(
        "server-removed",
        "Gone",
        "2026-04-15T10:00:01.000Z",
      );

      const carried = carryOverMessagesAddedDuringFetch(
        [snapshotMessage],
        [snapshotMessage, removed],
        // Present before the fetch started, absent from the snapshot: a real
        // deletion, not a message that raced the request.
        new Set(["server-prior", "server-removed"]),
      );

      expect(carried.map((message) => message.id)).toEqual(["server-prior"]);
    });

    test("leaves client-only messages to the merge step", () => {
      const optimistic = createOptimisticNativeMessage(
        "optimistic-inflight",
        "Newer prompt",
        [],
        "2026-04-15T10:00:05.000Z",
      );

      const carried = carryOverMessagesAddedDuringFetch(
        [snapshotMessage],
        [snapshotMessage, optimistic],
        new Set(["server-prior"]),
      );

      expect(carried.map((message) => message.id)).toEqual(["server-prior"]);
    });

    test("returns the snapshot by reference when nothing raced the fetch", () => {
      const snapshot = [snapshotMessage];

      expect(
        carryOverMessagesAddedDuringFetch(
          snapshot,
          [snapshotMessage],
          new Set(["server-prior"]),
        ),
      ).toBe(snapshot);
    });

    test("does not duplicate a live message the snapshot already contains", () => {
      const liveEcho = createServerMessage(
        "server-live",
        "Newer prompt",
        "2026-04-15T10:00:05.000Z",
      );

      const carried = carryOverMessagesAddedDuringFetch(
        [snapshotMessage, liveEcho],
        [snapshotMessage, liveEcho],
        new Set(["server-prior"]),
      );

      expect(carried.map((message) => message.id)).toEqual([
        "server-prior",
        "server-live",
      ]);
    });
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
