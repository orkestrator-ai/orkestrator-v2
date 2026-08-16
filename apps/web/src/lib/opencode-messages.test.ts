import { afterEach,describe,expect,mock,test } from "bun:test";


import {
buildOpenCodeMessageFromPart,
carryOverOpenCodeSubagentHydration,
collectOpenCodeSubagentIds,
getOpenCodePartKey,
getSessionMessages,
hasOpenCodeSubagentSession,
mergeOpenCodeMessageInfo,
mergeOpenCodeSubagentTranscript,
normalizeOpenCodeMessage,
normalizeOpenCodePart,
type OpencodeClient,
type OpenCodeMessage
} from "./opencode-client";







const originalFetch = globalThis.fetch;



function setTestUrl(url: string): void {
  (window as unknown as Window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}



afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  setTestUrl("about:blank");
  mock.restore();
});



describe("opencode-client streaming part normalization", () => {
  test("normalizes text parts with source identity for incremental updates", () => {
    const part = normalizeOpenCodePart({
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: "Streaming text",
    });

    expect(part).toEqual({
      type: "text",
      content: "Streaming text",
      sourcePartId: "part-1",
      sourceMessageId: "message-1",
    });
  });

  test("copies OpenCode part start time onto createdAt", () => {
    const part = normalizeOpenCodePart({
      id: "part-timed",
      messageID: "message-1",
      type: "text",
      text: "Later",
      time: { start: Date.parse("2026-06-18T12:04:00.000Z") },
    });

    expect(part).toMatchObject({
      type: "text",
      content: "Later",
      createdAt: "2026-06-18T12:04:00.000Z",
    });
  });

  test("normalizes reasoning parts into thinking parts", () => {
    const part = normalizeOpenCodePart({
      id: "part-r",
      messageID: "message-1",
      type: "reasoning",
      text: "Let me think",
    });

    expect(part).toEqual({
      type: "thinking",
      content: "Let me think",
      sourcePartId: "part-r",
      sourceMessageId: "message-1",
    });
  });

  test("removes OpenCode's surrounding bold markers from reasoning", () => {
    const part = normalizeOpenCodePart({
      id: "part-r-bold",
      messageID: "message-1",
      type: "reasoning",
      text: "**Planning next changes**",
    });

    expect(part).toEqual({
      type: "thinking",
      content: "Planning next changes",
      sourcePartId: "part-r-bold",
      sourceMessageId: "message-1",
    });
  });

  test("removes an opening bold marker while reasoning is still streaming", () => {
    const part = normalizeOpenCodePart({
      id: "part-r-streaming",
      type: "reasoning",
      text: "**Planning next",
      time: { start: 1 },
    });

    expect(part?.content).toBe("Planning next");
  });

  test("preserves an unmatched opening marker when reasoning is not streaming", () => {
    expect(
      normalizeOpenCodePart({
        type: "reasoning",
        text: "**Planning next",
        time: { start: 1, end: 2 },
      })?.content,
    ).toBe("**Planning next");
    expect(
      normalizeOpenCodePart({ type: "reasoning", text: "**Planning next" })
        ?.content,
    ).toBe("**Planning next");
  });

  test("preserves inline, trailing, and completed prefix bold Markdown", () => {
    for (const content of [
      "Use **care** when editing",
      "Planning ends with **care**",
      "**Planning** then inspect",
      "**Planning**\n- inspect files",
      "**Planning** then **care**",
      "Planning next**",
    ]) {
      expect(
        normalizeOpenCodePart({ type: "reasoning", text: content })?.content,
      ).toBe(content);
    }
  });

  test("preserves surrounding whitespace while removing an outer bold wrapper", () => {
    const part = normalizeOpenCodePart({
      type: "reasoning",
      text: " \n**Planning next changes** \n",
    });

    expect(part?.content).toBe(" \nPlanning next changes \n");
  });

  test("drops reasoning that is empty after marker normalization", () => {
    for (const content of ["****", "  **  ", " \n\t "]) {
      expect(normalizeOpenCodePart({ type: "reasoning", text: content })).toBeNull();
    }
  });

  test("drops reasoning parts with empty text", () => {
    expect(
      normalizeOpenCodePart({ id: "part-r", type: "reasoning", text: "" }),
    ).toBeNull();
  });

  test("normalizes tool parts with mapped state and diff metadata", () => {
    const part = normalizeOpenCodePart({
      id: "part-t",
      messageID: "message-1",
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        title: "Edit file.ts",
        input: {
          filePath: "file.ts",
          oldString: "a",
          newString: "a\nb",
        },
        output: "done",
      },
    });

    expect(part?.type).toBe("tool-invocation");
    expect(part?.toolName).toBe("edit");
    expect(part?.toolState).toBe("success");
    expect(part?.toolTitle).toBe("Edit file.ts");
    expect(part?.toolOutput).toBe("done");
    expect(part?.sourcePartId).toBe("part-t");
    expect(part?.sourceMessageId).toBe("message-1");
    expect(part?.toolDiff).toMatchObject({
      filePath: "file.ts",
      before: "a",
      after: "a\nb",
      additions: 2,
      deletions: 1,
    });
  });

  test("normalizes Task tools into shared subagent parts", () => {
    const part = normalizeOpenCodePart({
      id: "part-task",
      messageID: "message-1",
      type: "tool",
      tool: "Task",
      state: {
        status: "running",
        title: "Review import scheduling",
        input: {
          description: "Review import scheduling",
          prompt: "Inspect the scheduling implementation",
          subagent_type: "general",
        },
        metadata: {
          parentSessionId: "session-parent",
          sessionId: "session-child",
        },
      },
    });

    expect(part).toMatchObject({
      type: "subagent",
      content: "Review import scheduling",
      sourcePartId: "part-task",
      sourceMessageId: "message-1",
      toolState: "pending",
      subagentId: "session-child",
      subagentName: "Review import scheduling",
      subagentRole: "general",
      subagentPrompt: "Inspect the scheduling implementation",
      subagentActions: [],
      subagentActionCount: 0,
    });
  });

  test("uses the Task output envelope as a child id and background state fallback", () => {
    const part = normalizeOpenCodePart({
      id: "part-task",
      messageID: "message-1",
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { description: "Background review" },
        output: '<task id="session-background" state="running">\n<task_result>Working</task_result>\n</task>',
      },
    });

    expect(part).toMatchObject({
      type: "subagent",
      subagentId: "session-background",
      toolState: "pending",
    });
  });

  test("supports agent aliases, alternate metadata keys, and Task display fallbacks", () => {
    const sessionIdPart = normalizeOpenCodePart({
      type: "tool",
      tool: "agent",
      state: {
        status: "pending",
        title: "Fallback title",
        input: { agent: "explore", prompt: "Inspect it" },
        metadata: { sessionID: "session-uppercase" },
      },
    });
    expect(sessionIdPart).toMatchObject({
      type: "subagent",
      content: "Fallback title",
      subagentId: "session-uppercase",
      subagentRole: "explore",
      subagentPrompt: "Inspect it",
    });

    const jobIdPart = normalizeOpenCodePart({
      type: "tool",
      tool: "Task",
      metadata: { jobId: "job-child" },
      state: { status: "running", input: {} },
    });
    expect(jobIdPart).toMatchObject({
      type: "subagent",
      content: "Task",
      subagentId: "job-child",
    });
  });

  test("uses completed and error Task envelopes as authoritative terminal states", () => {
    for (const [envelopeState, expectedState] of [
      ["completed", "success"],
      ["error", "failure"],
    ] as const) {
      const part = normalizeOpenCodePart({
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          input: { description: envelopeState },
          output: `<task id="${envelopeState}-child" state="${envelopeState}">result</task>`,
        },
      });
      expect(part).toMatchObject({
        type: "subagent",
        subagentId: `${envelopeState}-child`,
        toolState: expectedState,
      });
    }
  });

  test("parses edit counts from metadata, unified diffs, output diffs, and one-sided content", () => {
    const cases = [
      {
        part: {
          type: "tool", tool: "write", state: {
            status: "completed",
            input: { file_path: "a.ts", old_string: "old", new_string: "new" },
            metadata: { additions: 7, deletions: 3 },
          },
        },
        expected: { filePath: "a.ts", additions: 7, deletions: 3, before: "old", after: "new" },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: { path: "b.ts" },
            metadata: { diff: "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more" },
          },
        },
        expected: { filePath: "b.ts", additions: 2, deletions: 1 },
      },
      {
        part: {
          type: "tool", tool: "patch", state: {
            status: "completed", input: { file: "c.ts" },
            output: "@@ -1 +1 @@\n-old\n+new",
          },
        },
        expected: { filePath: "c.ts", additions: 1, deletions: 1 },
      },
      {
        part: {
          type: "tool", tool: "write", state: {
            status: "completed", input: { filePath: "new.ts", content: "one\ntwo" },
          },
        },
        expected: { filePath: "new.ts", additions: 2, deletions: 0 },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: { filePath: "old.ts", oldString: "one\ntwo" },
          },
        },
        expected: { filePath: "old.ts", additions: 0, deletions: 2 },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: {},
            metadata: { filediff: { file: "meta.ts", before: "a", after: "b\nc" } },
          },
        },
        expected: { filePath: "meta.ts", additions: 2, deletions: 1, before: "a", after: "b\nc" },
      },
    ];

    for (const { part, expected } of cases) {
      expect(normalizeOpenCodePart(part)?.toolDiff).toMatchObject(expected);
    }
  });

  test("maps tool error status to failure state and stringifies error payloads", () => {
    const part = normalizeOpenCodePart({
      id: "part-t",
      type: "tool",
      tool: "bash",
      state: {
        status: "error",
        error: { message: "boom" },
      },
    });

    expect(part?.toolState).toBe("failure");
    expect(part?.toolError).toBe(JSON.stringify({ message: "boom" }, null, 2));
  });

  test("normalizes file parts using filename then url", () => {
    const part = normalizeOpenCodePart({
      id: "part-f",
      messageID: "message-1",
      type: "file",
      filename: "photo.png",
      url: "file:///tmp/photo.png",
    });

    expect(part).toEqual({
      type: "file",
      content: "photo.png",
      sourcePartId: "part-f",
      sourceMessageId: "message-1",
      fileUrl: "file:///tmp/photo.png",
    });
  });

  test("uses the URL when a file part has no filename", () => {
    const part = normalizeOpenCodePart({
      type: "file",
      url: "file:///tmp/attachment.txt",
    });

    expect(part).toEqual({
      type: "file",
      content: "file:///tmp/attachment.txt",
      sourcePartId: undefined,
      sourceMessageId: undefined,
      fileUrl: "file:///tmp/attachment.txt",
    });
  });

  test("normalizes an empty file part with safe fallbacks", () => {
    const part = normalizeOpenCodePart({ type: "file" });

    expect(part).toEqual({
      type: "file",
      content: "",
      sourcePartId: undefined,
      sourceMessageId: undefined,
      fileUrl: undefined,
    });
  });

  test("returns null for unrecognized or non-object parts", () => {
    expect(normalizeOpenCodePart(null)).toBeNull();
    expect(normalizeOpenCodePart("nope")).toBeNull();
    expect(normalizeOpenCodePart({ type: "step-start" })).toBeNull();
  });
});



describe("opencode-client normalizeOpenCodeMessage", () => {
  test("aggregates text content and parts from an SDK message", () => {
    const message = normalizeOpenCodeMessage({
      info: { id: "message-1", role: "assistant", time: { created: 1739232000000 } },
      parts: [
        { id: "p1", messageID: "message-1", type: "text", text: "Hello " },
        { id: "p2", messageID: "message-1", type: "reasoning", text: "thinking" },
        { id: "p3", messageID: "message-1", type: "text", text: "world" },
        { id: "p4", type: "step-start" },
      ],
    });

    expect(message).toEqual({
      id: "message-1",
      role: "assistant",
      content: "Hello world",
      parts: [
        { type: "text", content: "Hello ", sourcePartId: "p1", sourceMessageId: "message-1" },
        { type: "thinking", content: "thinking", sourcePartId: "p2", sourceMessageId: "message-1" },
        { type: "text", content: "world", sourcePartId: "p3", sourceMessageId: "message-1" },
      ],
      createdAt: new Date(1739232000000).toISOString(),
    });
  });

  test("retains only a safe assistant-error marker", () => {
    const message = normalizeOpenCodeMessage({
      info: {
        id: "failed-message",
        role: "assistant",
        error: { message: "secret failure detail", token: "sensitive" },
      },
      parts: [],
    });

    expect(message?.hasError).toBe(true);
    expect(message).not.toHaveProperty("error");
    expect(JSON.stringify(message)).not.toContain("secret failure detail");
  });

  test("retains the error discriminator but no other error payload", () => {
    const aborted = normalizeOpenCodeMessage({
      info: {
        id: "aborted-message",
        role: "assistant",
        error: { name: "MessageAbortedError", data: { message: "secret detail" } },
      },
      parts: [],
    });

    expect(aborted?.hasError).toBe(true);
    expect(aborted?.errorName).toBe("MessageAbortedError");
    expect(JSON.stringify(aborted)).not.toContain("secret detail");

    // A non-record or unnamed error still marks the message, with no name to keep.
    const unnamed = normalizeOpenCodeMessage({
      info: { id: "unnamed", role: "assistant", error: { data: { message: "boom" } } },
      parts: [],
    });
    expect(unnamed?.hasError).toBe(true);
    expect(unnamed?.errorName).toBeUndefined();

    const primitive = normalizeOpenCodeMessage({
      info: { id: "primitive", role: "assistant", error: "boom" },
      parts: [],
    });
    expect(primitive?.hasError).toBe(true);
    expect(primitive?.errorName).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(normalizeOpenCodeMessage(null)).toBeNull();
    expect(normalizeOpenCodeMessage(42)).toBeNull();
  });

  test("preserves the final step finish reason without rendering it as content", () => {
    const message = normalizeOpenCodeMessage({
      info: { id: "unknown-finish", role: "assistant" },
      parts: [
        { id: "reasoning", messageID: "unknown-finish", type: "reasoning", text: "Working" },
        { id: "first-finish", messageID: "unknown-finish", type: "step-finish", reason: "tool-calls" },
        { id: "final-finish", messageID: "unknown-finish", type: "step-finish", reason: "unknown" },
      ],
    });

    expect(message?.finishReason).toBe("unknown");
    expect(message?.content).toBe("");
    expect(message?.parts.map((part) => part.type)).toEqual(["thinking"]);
  });
});



describe("OpenCode subagent transcript hydration", () => {
  test("collects nested ids once, deduplicates them, and caches by transcript identity", () => {
    const messages = [{
      id: "message-1",
      role: "assistant",
      content: "",
      parts: [{
        type: "subagent",
        subagentId: "child",
        content: "child",
        subagentActions: [
          {
            type: "subagent",
            subagentId: "grandchild",
            content: "grandchild",
            subagentActions: [],
          },
          {
            type: "subagent",
            subagentId: "child",
            content: "duplicate",
            subagentActions: [],
          },
        ],
      }],
      createdAt: "2026-07-28T00:00:00.000Z",
    }] as OpenCodeMessage[];

    const first = collectOpenCodeSubagentIds(messages);
    const second = collectOpenCodeSubagentIds(messages);

    expect([...first].sort()).toEqual(["child", "grandchild"]);
    expect(second).toBe(first);
  });

  test("loads child messages and exposes their tool calls as agent actions", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "task",
                      state: {
                        status: "running",
                        input: {
                          description: "Inspect imports",
                          prompt: "Review imports",
                          subagent_type: "general",
                        },
                        metadata: { sessionId: "session-child" },
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  info: { id: "child-message", role: "assistant", time: { created: 2 } },
                  parts: [
                    {
                      id: "child-tool",
                      messageID: "child-message",
                      type: "tool",
                      tool: "bash",
                      state: {
                        status: "completed",
                        title: "Read imports",
                        input: { command: "rg import src" },
                        output: "src/index.ts",
                        metadata: {},
                      },
                    },
                    {
                      id: "child-text",
                      messageID: "child-message",
                      type: "text",
                      text: "Review complete",
                    },
                  ],
                },
              ],
        })),
        children: mock(async () => ({ data: [] })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    const task = messages[0]?.parts[0];

    expect(task).toMatchObject({
      type: "subagent",
      subagentId: "session-child",
      subagentActionCount: 1,
      subagentActions: [
        {
          type: "tool-invocation",
          toolName: "bash",
          toolState: "success",
          toolArgs: { command: "rg import src" },
          toolOutput: "src/index.ts",
        },
        { type: "text", content: "Review complete" },
      ],
    });
    expect(hasOpenCodeSubagentSession(messages, "session-child")).toBe(true);
  });

  test("settles a completed background child from the session status snapshot", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "task",
                      state: {
                        status: "completed",
                        input: { description: "Background review" },
                        output: '<task id="background-child" state="running">Working</task>',
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  info: { id: "child-message", role: "assistant", time: { created: 2 } },
                  parts: [
                    {
                      id: "child-text",
                      messageID: "child-message",
                      type: "text",
                      text: "Finished in the background",
                    },
                  ],
                },
              ],
        })),
        status: mock(async () => ({
          data: { "background-child": { type: "idle" } },
        })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "subagent",
      subagentId: "background-child",
      toolState: "success",
      subagentActions: [
        { type: "text", content: "Finished in the background" },
      ],
    });
  });

  test("discovers legacy Task children through session.children", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "Task",
                      state: {
                        status: "running",
                        input: { description: "Review database", subagent_type: "explore" },
                      },
                    },
                  ],
                },
              ]
            : [],
        })),
        children: mock(async () => ({
          data: [
            {
              id: "legacy-child",
              title: "Review database (@explore subagent)",
              agent: "explore",
            },
          ],
        })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "subagent",
      subagentId: "legacy-child",
      subagentRole: "explore",
    });
  });

  test("merges live child state into nested agent rows", () => {
    const messages: OpenCodeMessage[] = [
      {
        id: "parent-message",
        role: "assistant",
        content: "",
        createdAt: "2026-07-22T12:00:00.000Z",
        parts: [
          {
            type: "subagent",
            content: "Outer",
            subagentId: "outer-child",
            subagentActions: [
              {
                type: "subagent",
                content: "Nested",
                subagentId: "nested-child",
                subagentActions: [],
              },
            ],
          },
        ],
      },
    ];
    const childMessages: OpenCodeMessage[] = [
      {
        id: "child-message",
        role: "assistant",
        content: "Done",
        createdAt: "2026-07-22T12:00:01.000Z",
        parts: [{ type: "text", content: "Done" }],
      },
    ];

    const merged = mergeOpenCodeSubagentTranscript(
      messages,
      "nested-child",
      childMessages,
      "success",
    );
    const outer = merged[0]?.parts[0];
    expect(outer?.type).toBe("subagent");
    expect(outer?.subagentActions?.[0]).toMatchObject({
      type: "subagent",
      toolState: "success",
      subagentActions: [{ type: "text", content: "Done" }],
    });
  });

  test("detects nested sessions and leaves non-matching transcripts unchanged", () => {
    const messages: OpenCodeMessage[] = [{
      id: "parent", role: "assistant", content: "", createdAt: "now",
      parts: [{
        type: "subagent", content: "outer", subagentId: "outer",
        subagentActions: [{ type: "subagent", content: "inner", subagentId: "inner" }],
      }],
    }];

    expect(hasOpenCodeSubagentSession(messages, "inner")).toBe(true);
    expect(hasOpenCodeSubagentSession(messages, "missing")).toBe(false);
    expect(mergeOpenCodeSubagentTranscript(messages, "missing", [], "success")).toBe(messages);
  });

  test("updates every matching row, ignores user actions, counts nested tools, and preserves terminal precedence", () => {
    const messages: OpenCodeMessage[] = [{
      id: "parent", role: "assistant", content: "", createdAt: "now",
      parts: [
        { type: "subagent", content: "first", subagentId: "child", toolState: "success" },
        { type: "subagent", content: "second", subagentId: "child", toolState: "failure" },
      ],
    }];
    const childMessages: OpenCodeMessage[] = [
      {
        id: "user", role: "user", content: "hidden", createdAt: "now",
        parts: [{ type: "tool-invocation", content: "user-tool" }],
      },
      {
        id: "assistant", role: "assistant", content: "", createdAt: "now",
        parts: [
          { type: "tool-invocation", content: "top" },
          {
            type: "subagent", content: "nested", subagentActions: [
              { type: "tool-invocation", content: "nested-tool" },
            ],
          },
        ],
      },
    ];

    const pending = mergeOpenCodeSubagentTranscript(messages, "child", childMessages, "pending");
    expect(pending[0]?.parts[0]).toMatchObject({
      toolState: "success",
      subagentActionCount: 2,
      subagentActions: [{ type: "tool-invocation", content: "top" }, { type: "subagent" }],
    });
    expect(pending[0]?.parts[1]).toMatchObject({ toolState: "failure", subagentActionCount: 2 });

    const failed = mergeOpenCodeSubagentTranscript(messages, "child", [], "failure");
    expect(failed[0]?.parts[0]?.toolState).toBe("failure");
    expect(failed[0]?.parts[1]?.toolState).toBe("failure");
  });

  test("fails the whole snapshot when a child transcript cannot be read", async () => {
    const messages = mock(async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "child") throw new Error("child offline");
      return {
        data: [{
          info: { id: "parent", role: "assistant" },
          parts: [{
            type: "tool", tool: "Task",
            state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
          }],
        }],
      };
    });
    const client = { session: { messages } } as unknown as OpencodeClient;

    expect(await getSessionMessages(client, "parent")).toEqual([]);
    await expect(getSessionMessages(client, "parent", { throwOnError: true })).rejects.toThrow("child offline");
  });

  test("continues without a status snapshot in non-strict mode and propagates it in strict mode", async () => {
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: [{
                  type: "tool", tool: "Task",
                  state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
                }],
              }]
            : [{ info: { id: "child", role: "assistant" }, parts: [{ type: "text", text: "done" }] }],
        }),
        status: async () => { throw new Error("status offline"); },
      },
    } as unknown as OpencodeClient;

    expect((await getSessionMessages(client, "parent"))[0]?.parts[0]).toMatchObject({
      subagentActions: [{ type: "text", content: "done" }],
    });
    await expect(getSessionMessages(client, "parent", { throwOnError: true })).rejects.toThrow("status offline");
  });

  test("handles resolved status errors and malformed status payloads", async () => {
    const messages = async ({ sessionID }: { sessionID: string }) => ({
      data: sessionID === "parent"
        ? [{
            info: { id: "parent", role: "assistant" },
            parts: [{
              type: "tool", tool: "Task",
              state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
            }],
          }]
        : [],
    });
    const resolvedFailure = {
      session: {
        messages,
        status: async () => ({ data: undefined, error: { message: "no statuses" } }),
      },
    } as unknown as OpencodeClient;
    expect(await getSessionMessages(resolvedFailure, "parent")).toHaveLength(1);
    await expect(getSessionMessages(resolvedFailure, "parent", { throwOnError: true })).rejects.toThrow("no statuses");

    const malformed = {
      session: { messages, status: async () => ({ data: [] }) },
    } as unknown as OpencodeClient;
    expect(await getSessionMessages(malformed, "parent")).toHaveLength(1);
  });

  test("handles failed and malformed child discovery responses", async () => {
    const parentData = [{
      info: { id: "parent", role: "assistant" },
      parts: [{
        type: "tool", tool: "Task",
        state: { status: "running", input: { description: "Legacy" } },
      }],
    }];
    const failed = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => { throw new Error("children offline"); },
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(failed, "parent"))[0]?.parts[0]?.subagentId).toBeUndefined();
    await expect(getSessionMessages(failed, "parent", { throwOnError: true })).rejects.toThrow("children offline");

    const resolvedFailure = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => ({
          data: undefined,
          error: { message: "children rejected" },
        }),
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(resolvedFailure, "parent"))[0]?.parts[0]?.subagentId)
      .toBeUndefined();
    await expect(
      getSessionMessages(resolvedFailure, "parent", { throwOnError: true }),
    ).rejects.toThrow("children rejected");

    const malformed = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => ({ data: { id: "not-an-array" } }),
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(malformed, "parent"))[0]?.parts[0]?.subagentId).toBeUndefined();
  });

  test("assigns duplicate legacy titles to distinct children", async () => {
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: ["one", "two"].map((id) => ({
                  id, type: "tool", tool: "Task",
                  state: { status: "running", input: { description: "Duplicate" } },
                })),
              }]
            : [],
        }),
        children: async () => ({ data: [
          { id: "child-one", title: "Duplicate" },
          { id: "child-two", title: "Duplicate" },
        ] }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "parent");
    expect(messages[0]?.parts.map((part) => part.subagentId)).toEqual(["child-one", "child-two"]);
  });

  test("hydrates grandchildren once and terminates recursive session cycles", async () => {
    const task = (id: string, child: string) => ({
      id, type: "tool", tool: "Task",
      state: { status: "running", input: { description: child }, metadata: { sessionId: child } },
    });
    const bySession: Record<string, unknown[]> = {
      parent: [{ info: { id: "p", role: "assistant" }, parts: [task("p-task", "child")] }],
      child: [{ info: { id: "c", role: "assistant" }, parts: [
        { type: "tool", tool: "bash", state: { status: "completed", input: {} } },
        task("c-task", "grandchild"),
      ] }],
      grandchild: [{ info: { id: "g", role: "assistant" }, parts: [
        task("g-task", "child"),
        { type: "text", text: "complete" },
      ] }],
    };
    const calls: string[] = [];
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID);
          return { data: bySession[sessionID] };
        },
        status: async () => ({ data: { child: { type: "idle" }, grandchild: { type: "idle" } } }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "parent");
    expect(calls).toEqual(["parent", "child", "grandchild"]);
    expect(messages[0]?.parts[0]).toMatchObject({
      toolState: "success",
      subagentActions: [
        { type: "tool-invocation", toolName: "bash" },
        { type: "subagent", subagentId: "grandchild", toolState: "success", subagentActions: [
          { type: "subagent", subagentId: "child", subagentActions: [] },
          { type: "text", content: "complete" },
        ] },
      ],
    });
  });

  test("maps busy, retry, idle-empty, and assistant-error snapshots to terminal states", async () => {
    const ids = ["busy-child", "retry-child", "empty-child", "failed-child"];
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: ids.map((id) => ({
                  type: "tool", tool: "Task",
                  state: { status: "running", input: { description: id }, metadata: { sessionId: id } },
                })),
              }]
            : sessionID === "failed-child"
              ? [{ info: { id: "failure", role: "assistant", error: { message: "failed" } }, parts: [] }]
              : [],
        }),
        status: async () => ({ data: {
          "busy-child": { type: "busy" },
          "retry-child": { type: "retry" },
          "empty-child": { type: "idle" },
          "failed-child": { type: "idle" },
        } }),
      },
    } as unknown as OpencodeClient;

    const states = (await getSessionMessages(client, "parent"))[0]?.parts.map((part) => part.toolState);
    expect(states).toEqual(["pending", "pending", "success", "failure"]);
  });
});



describe("opencode-client getOpenCodePartKey", () => {
  test("prefers the source part id", () => {
    expect(
      getOpenCodePartKey({ type: "text", content: "x", sourcePartId: "p1", sourceMessageId: "m1" }),
    ).toBe("p1");
  });

  test("falls back to a composite key from the source message id", () => {
    expect(
      getOpenCodePartKey({
        type: "tool-invocation",
        content: "edit",
        toolName: "edit",
        sourceMessageId: "m1",
      }),
    ).toBe("m1:tool-invocation:edit:edit");
  });

  test("returns null when the part has no source identity", () => {
    expect(getOpenCodePartKey({ type: "text", content: "x" })).toBeNull();
  });

  test("includes the file url so two attachments of a message stay distinct", () => {
    // Deliberate asymmetry with getPartFingerprint, which excludes fileUrl:
    // this key identifies a part *within one message* for in-place streaming
    // replacement, where the client and server URL never disagree.
    const first = getOpenCodePartKey({
      type: "file",
      content: "logo.png",
      fileUrl: "file:///one/logo.png",
      sourceMessageId: "m1",
    });
    const second = getOpenCodePartKey({
      type: "file",
      content: "logo.png",
      fileUrl: "file:///two/logo.png",
      sourceMessageId: "m1",
    });

    expect(first).toBe("m1:file:file:///one/logo.png:logo.png");
    expect(first).not.toBe(second);
  });

  test("collapses two empty-content file parts of one message onto the same key", () => {
    // `.filter(Boolean)` drops empty segments, so parts that differ only in an
    // absent field share a key and overwrite each other during streaming.
    const key = getOpenCodePartKey({ type: "file", content: "", sourceMessageId: "m1" });

    expect(key).toBe("m1:file");
    expect(getOpenCodePartKey({ type: "file", content: "", sourceMessageId: "m1" })).toBe(key);
  });
});



describe("opencode-client buildOpenCodeMessageFromPart", () => {
  test("creates a new assistant message when none exists", () => {
    const message = buildOpenCodeMessageFromPart(undefined, "message-1", {
      type: "text",
      content: "Hello",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(message.id).toBe("message-1");
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Hello");
    expect(message.parts).toHaveLength(1);
  });

  test("replaces an existing part matched by source identity", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: "Hello world",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(updated.parts).toHaveLength(1);
    expect(updated.content).toBe("Hello world");
    // Preserves role/createdAt from the existing message.
    expect(updated.createdAt).toBe(existing.createdAt);
  });

  test("appends a delta to the matched part when the incoming content is empty", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hel",
      parts: [{ type: "text", content: "Hel", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(
      existing,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    expect(updated.content).toBe("Hello");
    expect(updated.parts).toHaveLength(1);
  });

  test("appends a new part when the source identity does not match", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: " again",
      sourcePartId: "p2",
      sourceMessageId: "message-1",
    });

    expect(updated.parts).toHaveLength(2);
    expect(updated.content).toBe("Hello again");
  });

  test("preserves message-level metadata while streamed parts are rebuilt", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
      modelId: "anthropic/claude-sonnet-4",
      hasError: true,
      turnId: "turn-1",
      providerUsage: {
        cost: 0.1,
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: "anthropic/claude-sonnet-4",
      },
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: "Hello world",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(updated.modelId).toBe(existing.modelId);
    expect(updated.hasError).toBe(true);
    expect(updated.turnId).toBe("turn-1");
    expect(updated.providerUsage).toEqual(existing.providerUsage);
  });

  test("seeds role and createdAt from a partial base carrying no parts", () => {
    // This is the shape the OpenCode event adapter supplies when a part streams
    // in before its `message.updated`: the echo's role/createdAt are known from
    // the pending optimistic bubble, but none of its parts are.
    const message = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-early",
      {
        type: "text",
        content: "Hello from the part",
        sourcePartId: "p1",
        sourceMessageId: "server-early",
      },
    );

    expect(message).toMatchObject({
      id: "server-early",
      role: "user",
      content: "Hello from the part",
      createdAt: "2026-04-15T10:00:01.000Z",
    });
    expect(message.parts).toHaveLength(1);
  });

  test("keeps a user role across a follow-up part of the same message", () => {
    const seeded = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-early",
      { type: "text", content: "Look", sourcePartId: "p1", sourceMessageId: "server-early" },
    );

    const withFile = buildOpenCodeMessageFromPart(seeded, "server-early", {
      type: "file",
      content: "a.png",
      fileUrl: "file:///workspace/a.png",
      sourcePartId: "p2",
      sourceMessageId: "server-early",
    });

    expect(withFile.role).toBe("user");
    expect(withFile.parts).toHaveLength(2);
    // Aggregate content is recomputed from text parts only.
    expect(withFile.content).toBe("Look");
  });

  test("yields empty content when the first part of a message is a file", () => {
    const message = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-file-first",
      {
        type: "file",
        content: "a.png",
        fileUrl: "file:///workspace/a.png",
        sourcePartId: "p1",
        sourceMessageId: "server-file-first",
      },
    );

    expect(message.role).toBe("user");
    expect(message.content).toBe("");
    expect(message.parts).toHaveLength(1);
  });

  test("drops the delta when no existing part matches", () => {
    const message = buildOpenCodeMessageFromPart(
      undefined,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    // There is nothing to append to, so the empty part is stored as-is rather
    // than inventing a message body from a fragment.
    expect(message.content).toBe("");
    expect(message.parts).toHaveLength(1);
  });

  test("drops the delta when the matched part has a different type", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "",
      parts: [{
        type: "file",
        content: "a.png",
        sourcePartId: "p1",
        sourceMessageId: "message-1",
      }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(
      existing,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    expect(updated.parts).toHaveLength(1);
    expect(updated.parts[0]).toMatchObject({ type: "text", content: "" });
  });

  test("carries message-level metadata from the supplied base onto the new id", () => {
    // `existing` is spread wholesale, so a caller passing another message's
    // metadata would relabel this one. Pinned so the coupling is visible.
    const updated = buildOpenCodeMessageFromPart(
      {
        role: "assistant",
        createdAt: "2026-04-15T10:00:00.000Z",
        modelId: "anthropic/claude-sonnet-4",
        turnId: "turn-9",
      },
      "message-2",
      { type: "text", content: "Hi", sourcePartId: "p1", sourceMessageId: "message-2" },
    );

    expect(updated).toMatchObject({
      id: "message-2",
      modelId: "anthropic/claude-sonnet-4",
      turnId: "turn-9",
    });
  });
});



describe("opencode-client incremental message helpers", () => {
  test("merges message info without discarding existing parts", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "streamed",
      parts: [{ type: "text", content: "streamed" }],
      createdAt: "2026-04-15T00:00:00.000Z",
    };

    expect(mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      error: { name: "ProviderError" },
      tokens: { input: 4, output: 6 },
    })).toMatchObject({
      content: "streamed",
      parts: existing.parts,
      modelId: "openai/gpt-5.6-sol",
      hasError: true,
    });
    expect(mergeOpenCodeMessageInfo(
      { ...existing, hasError: true },
      { id: "message-1", role: "assistant" },
    )?.hasError).toBeUndefined();
    expect(mergeOpenCodeMessageInfo(existing, null)).toBeNull();
    expect(mergeOpenCodeMessageInfo(existing, {})).toBeNull();
  });

  test("carries the error discriminator in both directions", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "streamed",
      parts: [{ type: "text", content: "streamed" }],
      createdAt: "2026-04-15T00:00:00.000Z",
    };

    expect(mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "assistant",
      error: { name: "MessageAbortedError" },
    })).toMatchObject({ hasError: true, errorName: "MessageAbortedError" });

    // `info` is the whole record, so a retried turn that no longer reports an
    // error must lose the stale discriminator along with the flag.
    const cleared = mergeOpenCodeMessageInfo(
      { ...existing, hasError: true, errorName: "MessageAbortedError" },
      { id: "message-1", role: "assistant" },
    );
    expect(cleared?.hasError).toBeUndefined();
    expect(cleared?.errorName).toBeUndefined();

    // A later, differently-named failure replaces the previous discriminator.
    const replaced = mergeOpenCodeMessageInfo(
      { ...existing, hasError: true, errorName: "MessageAbortedError" },
      { id: "message-1", role: "assistant", error: { name: "ProviderError" } },
    );
    expect(replaced?.errorName).toBe("ProviderError");
  });

  test("keeps the existing createdAt rather than adopting the incoming clock", () => {
    // Consequence worth pinning: when a part streamed in before its info frame
    // and seeded createdAt from the optimistic bubble, the later info frame
    // does not replace that client send time with the server's.
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "user",
      content: "Run the tests",
      parts: [{ type: "text", content: "Run the tests" }],
      createdAt: "2026-04-15T10:00:01.000Z",
    };

    const merged = mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "user",
      time: { created: Date.parse("2026-04-15T10:00:09.000Z") },
    });

    expect(merged?.createdAt).toBe("2026-04-15T10:00:01.000Z");
  });

  test("adopts the authoritative role from a later info frame", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "user",
      content: "Run the tests",
      parts: [{ type: "text", content: "Run the tests" }],
      createdAt: "2026-04-15T10:00:01.000Z",
    };

    expect(
      mergeOpenCodeMessageInfo(existing, { id: "message-1", role: "assistant" })?.role,
    ).toBe("assistant");
  });

  test("preserves hydrated child actions and terminal state during a cheap refresh", () => {
    const previous: OpenCodeMessage[] = [{
      id: "parent",
      role: "assistant",
      content: "",
      createdAt: "2026-04-15T00:00:00.000Z",
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "success",
        subagentActionCount: 1,
        subagentActions: [{ type: "text", content: "done" }],
      }],
    }];
    const next: OpenCodeMessage[] = [{
      ...previous[0]!,
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "pending",
      }],
    }];

    expect(carryOverOpenCodeSubagentHydration(previous, next)[0]?.parts[0])
      .toMatchObject({
        toolState: "success",
        subagentActionCount: 1,
        subagentActions: [{ type: "text", content: "done" }],
      });
  });

  test("keeps an authoritative newly hydrated child instead of carrying stale actions", () => {
    const previous: OpenCodeMessage[] = [{
      id: "parent",
      role: "assistant",
      content: "",
      createdAt: "2026-04-15T00:00:00.000Z",
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "success",
        subagentActions: [{ type: "text", content: "old" }],
      }],
    }];
    const next: OpenCodeMessage[] = [{
      ...previous[0]!,
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "failure",
        subagentActions: [{ type: "text", content: "new" }],
      }],
    }];

    expect(carryOverOpenCodeSubagentHydration(previous, next)).toBe(next);
  });
});



describe("opencode-client normalizeOpenCodeMessage providerUsage", () => {
  const tokens = {
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 40, write: 10 },
    total: 170,
  };

  function assistant(info: Record<string, unknown>) {
    return normalizeOpenCodeMessage({
      info: {
        id: "msg-1",
        role: "assistant",
        time: { created: 1_000 },
        ...info,
      },
      parts: [],
    });
  }

  test("captures the full provider counter block", () => {
    const message = assistant({
      tokens,
      cost: 0.25,
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      agent: "build",
      time: { created: 1_000, completed: 3_500 },
    });

    expect(message?.modelId).toBe("anthropic/claude-sonnet-4");
    expect(message?.providerUsage).toEqual({
      cost: 0.25,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 170,
      modelId: "anthropic/claude-sonnet-4",
      agent: "build",
      durationMs: 2_500,
    });
  });

  test("publishes the provider-confirmed model before usage counters arrive", () => {
    expect(assistant({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    })?.modelId).toBe("openai/gpt-5.6-sol");
  });

  test("normalizes model attribution without assigning it to user messages", () => {
    expect(assistant({ modelID: "claude-sonnet-4" })?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ providerID: "  ", modelID: "claude-sonnet-4" })?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ providerID: "anthropic", modelID: "  " })?.modelId)
      .toBeUndefined();
    expect(
      normalizeOpenCodeMessage({
        info: {
          id: "msg-user",
          role: "user",
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          time: { created: 1_000 },
        },
        parts: [],
      })?.modelId,
    ).toBeUndefined();
  });

  test("attaches usage only to assistant messages that report tokens", () => {
    expect(assistant({})?.providerUsage).toBeUndefined();
    expect(assistant({ tokens: null })?.providerUsage).toBeUndefined();
    expect(
      normalizeOpenCodeMessage({
        info: { id: "msg-1", role: "user", time: { created: 1_000 }, tokens },
        parts: [],
      })?.providerUsage,
    ).toBeUndefined();
  });

  test("coerces every counter to a finite number", () => {
    expect(
      assistant({
        tokens: {
          input: "100",
          output: null,
          reasoning: "abc",
          cache: { read: "40", write: undefined },
          total: "170",
        },
        cost: "0.25",
      })?.providerUsage,
    ).toMatchObject({
      // `Number(...) || 0` turns a numeric string into a number and anything
      // unusable into zero, so one odd counter cannot poison the arithmetic.
      cost: 0,
      inputTokens: 100,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      // `total` only survives when it is already a number.
      totalTokens: undefined,
    });
  });

  test("tolerates an absent cache block", () => {
    expect(assistant({ tokens: { input: 1, output: 2 } })?.providerUsage).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("falls back to the bare model id when the provider is not named", () => {
    expect(assistant({ tokens, modelID: "claude-sonnet-4" })?.providerUsage?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ tokens, providerID: 7, modelID: 42 })?.providerUsage?.modelId)
      .toBe("42");
    expect(assistant({ tokens })?.providerUsage?.modelId).toBe("");
  });

  test("omits the duration until the turn reports both timestamps", () => {
    expect(assistant({ tokens })?.providerUsage?.durationMs).toBeUndefined();
    expect(
      assistant({ tokens, time: { created: 1_000, completed: "3500" } })
        ?.providerUsage?.durationMs,
    ).toBeUndefined();
  });

  test("clamps a completion timestamp that precedes the creation timestamp", () => {
    // Clock skew between the server and the rollout must never produce a
    // negative duration in the usage panel.
    expect(
      assistant({ tokens, time: { created: 5_000, completed: 1_000 } })
        ?.providerUsage?.durationMs,
    ).toBe(0);
  });
});
