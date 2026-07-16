import { beforeEach, describe, expect, test } from "bun:test";
import type { TranscriptLine } from "@/lib/claude-tmux-client";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage } from "@/lib/claude-client";
import {
  createClaudeTmuxStateKey,
  getEnvironmentIdFromClaudeTmuxStateKey,
  compactConsecutiveAssistantMessages,
  payloadToApproval,
  payloadToElicitation,
  payloadToInfoEvent,
  payloadToPermission,
  payloadToPlan,
  payloadToQuestion,
  useClaudeTmuxStore,
} from "./claudeTmuxStore";

function reset() {
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
  });
}

beforeEach(() => {
  reset();
});

describe("state keys", () => {
  test("creates and parses environment-scoped tmux state keys", () => {
    const key = createClaudeTmuxStateKey("env-1", "tab-a");

    expect(key).toBe("env:env-1:tab:tab-a");
    expect(getEnvironmentIdFromClaudeTmuxStateKey(key)).toBe("env-1");
    expect(getEnvironmentIdFromClaudeTmuxStateKey("tab-a")).toBeNull();
    expect(getEnvironmentIdFromClaudeTmuxStateKey("env::tab:tab-a")).toBeNull();
    expect(getEnvironmentIdFromClaudeTmuxStateKey("env:env-1")).toBeNull();
  });
});

describe("applyTranscriptLine", () => {
  test("user text line becomes a message", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("env-1", line);
    const env = useClaudeTmuxStore.getState().getTab("env-1");
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.content).toBe("hello");
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.id).toBe("u1");
    expect(env.messages[0]!.parts.find((p) => p.type === "text")?.content).toBe(
      "hello",
    );
  });

  test("replaceTranscript removes stale messages without clearing local drafts", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "stale",
      message: { role: "assistant", content: "stale copy" },
    });
    store.setDraftText("e", "keep my draft");

    store.replaceTranscript("e", [
      {
        type: "assistant",
        uuid: "server",
        message: { role: "assistant", content: "server copy" },
      },
    ]);

    expect(useClaudeTmuxStore.getState().getTab("e").messages).toMatchObject([
      { id: "server", content: "server copy" },
    ]);
    expect(useClaudeTmuxStore.getState().getDraftText("e")).toBe("keep my draft");
  });

  test("replaceTranscript accepts an authoritative empty snapshot", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "stale",
      message: { role: "assistant", content: "stale copy" },
    });

    store.replaceTranscript("e", []);

    expect(useClaudeTmuxStore.getState().getTab("e").messages).toEqual([]);
  });

  test("assistant tool_use + later tool_result merge into prior assistant message", () => {
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking…" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "result-line-uuid",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: "ok\n",
            is_error: false,
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);
    const env = useClaudeTmuxStore.getState().getTab("e");
    // Crucial: the tool_result-only "user" line should NOT create a second
    // message; it merges into the prior assistant message's parts.
    expect(env.messages).toHaveLength(1);
    const parts = env.messages[0]!.parts;
    const invocation = parts.find(
      (p) => p.type === "tool-invocation" && p.toolUseId === "tu1",
    );
    const result = parts.find(
      (p) => p.type === "tool-result" && p.toolUseId === "tu1",
    );
    expect(invocation).toBeTruthy();
    expect(invocation!.toolState).toBe("success");
    expect(result).toBeTruthy();
    expect(result!.toolOutput).toBe("ok\n");
  });

  test("ignores non-message line types", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "summary",
    } as unknown as TranscriptLine);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(0);
  });

  test("re-applying the same line is idempotent (dedup by uuid)", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "u-stable",
      message: { role: "assistant", content: "hi" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(1);
  });

  test("falls back to a stable hash when uuid and timestamp are absent", () => {
    const line: TranscriptLine = {
      type: "system",
      message: { role: "system", content: "boot" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    // Two applications of an identical line MUST dedupe.
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(1);
  });

  test("drops user messages that only contain slash-command meta wrappers", () => {
    // When the user runs `/model` from the Claude CLI, the transcript gains
    // synthetic user-role lines containing only command-meta tags. These
    // should never appear as chat bubbles.
    const caveat: TranscriptLine = {
      type: "user",
      uuid: "caveat-1",
      message: {
        role: "user",
        content:
          "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond.</local-command-caveat>",
      },
    };
    const cmdMeta: TranscriptLine = {
      type: "user",
      uuid: "cmd-meta-1",
      message: {
        role: "user",
        content:
          "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
      },
    };
    const stdout: TranscriptLine = {
      type: "user",
      uuid: "stdout-1",
      message: {
        role: "user",
        content:
          "<local-command-stdout>Set model to [1mSonnet 4.6[22m</local-command-stdout>",
      },
    };
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", caveat);
    store.applyTranscriptLine("e", cmdMeta);
    store.applyTranscriptLine("e", stdout);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(0);
  });

  test("preserves user text that surrounds command-meta wrappers", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "mixed-1",
      message: {
        role: "user",
        content:
          "Please run this:\n<command-name>/help</command-name>\nand let me know.",
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0];
    expect(msg).toBeTruthy();
    expect(msg!.content).toBe("Please run this:\n\nand let me know.");
  });

  test("strips embedded ANSI escapes from user text", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "ansi-1",
      message: {
        role: "user",
        content: "model is [1mSonnet 4.6[22m now",
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    expect(msg.content).toBe("model is Sonnet 4.6 now");
  });

  test("Edit tool_use populates toolDiff with file_path and before/after", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "edit-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-edit",
            name: "Edit",
            input: {
              file_path: "/work/apps/web/package.json",
              old_string: "\"react\": \"18.0.0\"",
              new_string: "\"react\": \"19.0.0\"",
            },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/apps/web/package.json");
    expect(tool?.toolDiff?.before).toBe("\"react\": \"18.0.0\"");
    expect(tool?.toolDiff?.after).toBe("\"react\": \"19.0.0\"");
  });

  test("Write tool_use populates toolDiff with after = content", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "write-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-write",
            name: "Write",
            input: { file_path: "/work/foo.txt", content: "line1\nline2" },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/foo.txt");
    expect(tool?.toolDiff?.before).toBe("");
    expect(tool?.toolDiff?.after).toBe("line1\nline2");
  });

  test("MultiEdit tool_use populates synthetic before/after chunks", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "multi-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-multi",
            name: "MultiEdit",
            input: {
              file_path: "/work/foo.ts",
              edits: [
                { old_string: "one", new_string: "two" },
                { old_string: "three", new_string: "four" },
              ],
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/foo.ts");
    expect(tool?.toolDiff?.before).toBe("one\nthree");
    expect(tool?.toolDiff?.after).toBe("two\nfour");
  });

  test("NotebookEdit tool_use captures notebook path and new source", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "notebook-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-notebook",
            name: "NotebookEdit",
            input: {
              notebook_path: "/work/analysis.ipynb",
              new_source: "print('done')",
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/analysis.ipynb");
    expect(tool?.toolDiff?.after).toBe("print('done')");
  });

  test("failed tool_result marks invocation failure and stores error text", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "assistant",
      uuid: "a-fail",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-fail", name: "Bash", input: {} }],
      },
    });
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "user",
      uuid: "r-fail",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-fail",
            content: "permission denied",
            is_error: true,
          },
        ],
      },
    });

    const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
    const invocation = parts.find((p) => p.type === "tool-invocation");
    const result = parts.find((p) => p.type === "tool-result");
    expect(invocation?.toolState).toBe("failure");
    expect(invocation?.toolError).toBe("permission denied");
    expect(result?.toolError).toBe("permission denied");
  });

  test("unmatched tool_result falls back to a standalone user message", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "user",
      uuid: "r-orphan",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "missing",
            content: "orphaned",
          },
        ],
      },
    });

    const env = useClaudeTmuxStore.getState().getTab("e");
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.parts[0]?.type).toBe("tool-result");
  });

  test("array content collects text, thinking, and tool_use", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me see" },
          { type: "text", text: "result" },
          { type: "tool_use", id: "tu2", name: "Read", input: { path: "f" } },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const thinking = msg.parts.find((p) => p.type === "thinking");
    const text = msg.parts.find((p) => p.type === "text");
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(thinking?.content).toContain("let me see");
    expect(text?.content).toContain("result");
    expect(tool?.toolName).toBe("Read");
  });
});

describe("compactConsecutiveAssistantMessages", () => {
  test("combines adjacent assistant transcript messages for native-style spacing", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "inspect",
        timestamp: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "inspect" }],
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:01Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Read",
            toolUseId: "tu1",
            toolState: "success",
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Grep",
            toolUseId: "tu2",
            toolState: "success",
          },
        ],
      },
      {
        id: "a3",
        role: "assistant",
        content: "done",
        timestamp: "2026-01-01T00:00:03Z",
        parts: [{ type: "text", content: "done" }],
      },
    ];

    const compacted = compactConsecutiveAssistantMessages(messages);

    expect(compacted).toHaveLength(2);
    expect(compacted[1]!.id).toBe("a1");
    expect(compacted[1]!.timestamp).toBe("2026-01-01T00:00:01Z");
    expect(compacted[1]!.content).toBe("done");
    expect(compacted[1]!.parts.map((part) => part.type)).toEqual([
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
  });

  test("does not combine assistant messages across a visible user message", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "first",
        timestamp: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "first" }],
      },
      {
        id: "u1",
        role: "user",
        content: "next",
        timestamp: "2026-01-01T00:01:00Z",
        parts: [{ type: "text", content: "next" }],
      },
      {
        id: "a2",
        role: "assistant",
        content: "second",
        timestamp: "2026-01-01T00:02:00Z",
        parts: [{ type: "text", content: "second" }],
      },
    ];

    expect(compactConsecutiveAssistantMessages(messages)).toHaveLength(3);
  });

  test("does not combine assistant messages across error entries", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "first",
        timestamp: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "first" }],
      },
      {
        id: `${ERROR_MESSAGE_PREFIX}auth`,
        role: "assistant",
        content: "auth failed",
        timestamp: "2026-01-01T00:00:01Z",
        parts: [],
      },
      {
        id: "a2",
        role: "assistant",
        content: "second",
        timestamp: "2026-01-01T00:00:02Z",
        parts: [{ type: "text", content: "second" }],
      },
    ];

    const compacted = compactConsecutiveAssistantMessages(messages);

    expect(compacted.map((message) => message.id)).toEqual([
      "a1",
      `${ERROR_MESSAGE_PREFIX}auth`,
      "a2",
    ]);
  });
});

describe("pendingApprovals", () => {
  test("addPendingApproval dedupes by eventId", () => {
    const a = payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} });
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    expect(
      useClaudeTmuxStore.getState().getTab("e").pendingApprovals,
    ).toHaveLength(1);
  });

  test("removePendingApproval removes by eventId", () => {
    useClaudeTmuxStore.getState().addPendingApproval(
      "e",
      payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} }),
    );
    useClaudeTmuxStore.getState().addPendingApproval(
      "e",
      payloadToApproval("evt-2", { tool_name: "Write", tool_input: {} }),
    );
    useClaudeTmuxStore.getState().removePendingApproval("e", "evt-1");
    const env = useClaudeTmuxStore.getState().getTab("e");
    expect(env.pendingApprovals).toHaveLength(1);
    expect(env.pendingApprovals[0]!.eventId).toBe("evt-2");
  });
});

describe("payloadToApproval", () => {
  test("reads snake_case tool_name and tool_input", () => {
    const a = payloadToApproval("e1", {
      tool_name: "Bash",
      tool_input: { cmd: "ls" },
    });
    expect(a.toolName).toBe("Bash");
    expect(a.toolInput).toEqual({ cmd: "ls" });
  });

  test("accepts camelCase variants", () => {
    const a = payloadToApproval("e1", {
      toolName: "Read",
      toolInput: { path: "x" },
    });
    expect(a.toolName).toBe("Read");
    expect(a.toolInput).toEqual({ path: "x" });
  });

  test("falls back when payload is empty", () => {
    const a = payloadToApproval("e1", {});
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });

  test("handles null payload", () => {
    const a = payloadToApproval("e1", null);
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });
});

describe("pending hook payload conversion", () => {
  test("normalizes question, plan, permission, and elicitation payload variants", () => {
    expect(
      payloadToQuestion("question", {
        toolInput: { questions: [{ question: "Continue?", header: "Choice", options: [] }] },
      }),
    ).toMatchObject({
      eventId: "question",
      questions: [{ question: "Continue?" }],
    });
    expect(
      payloadToPlan("plan", {
        tool_input: {
          plan: "Ship it",
          plan_file_path: "/tmp/plan.md",
          allowed_prompts: ["Bash"],
        },
      }),
    ).toMatchObject({
      eventId: "plan",
      plan: "Ship it",
      planFilePath: "/tmp/plan.md",
      allowedPrompts: ["Bash"],
    });
    expect(
      payloadToPermission("permission", {
        toolName: "Edit",
        toolInput: { file_path: "a.ts" },
        permissionSuggestions: ["allow"],
      }),
    ).toMatchObject({
      eventId: "permission",
      toolName: "Edit",
      toolInput: { file_path: "a.ts" },
      permissionSuggestions: ["allow"],
    });
    expect(
      payloadToElicitation("elicitation", {
        mcp_server_name: "docs",
        message: "Choose a value",
        mode: "form",
        requested_schema: { type: "object" },
      }),
    ).toMatchObject({
      eventId: "elicitation",
      mcpServerName: "docs",
      message: "Choose a value",
      mode: "form",
      requestedSchema: { type: "object" },
    });
  });

  test("uses safe empty fallbacks for malformed payloads", () => {
    expect(payloadToQuestion("question", null)).toMatchObject({
      questions: [],
      toolInput: {},
    });
    expect(payloadToPlan("plan", { tool_input: "invalid" })).toMatchObject({
      plan: null,
      planFilePath: null,
      allowedPrompts: [],
    });
    expect(payloadToPermission("permission", null)).toMatchObject({
      toolName: "tool",
      toolInput: {},
      permissionSuggestions: [],
    });
    expect(payloadToElicitation("elicitation", { requested_schema: "invalid" })).toMatchObject({
      mcpServerName: "MCP server",
      message: "MCP server requested input",
      mode: null,
      url: null,
      requestedSchema: null,
    });
  });
});

describe("payloadToInfoEvent", () => {
  test("prefers .message field", () => {
    const e = payloadToInfoEvent("e1", "Notification", { message: "hi" });
    expect(e.message).toBe("hi");
  });

  test("falls back to .notification then to kind", () => {
    expect(payloadToInfoEvent("e1", "Stop", { notification: "n" }).message).toBe(
      "n",
    );
    expect(payloadToInfoEvent("e1", "Stop", {}).message).toBe("Stop");
  });
});

describe("infoEvents", () => {
  test("pushInfoEvent keeps at most 20", () => {
    for (let i = 0; i < 25; i++) {
      useClaudeTmuxStore.getState().pushInfoEvent("e", {
        id: `i${i}`,
        kind: "Notification",
        message: String(i),
        receivedAt: "now",
      });
    }
    const events = useClaudeTmuxStore.getState().getTab("e").infoEvents;
    expect(events).toHaveLength(20);
    expect(events[events.length - 1]!.id).toBe("i24");
  });

  test("dismissInfoEvent removes by id", () => {
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "a",
      kind: "Notification",
      message: "x",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "b",
      kind: "Notification",
      message: "y",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().dismissInfoEvent("e", "a");
    const events = useClaudeTmuxStore.getState().getTab("e").infoEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("b");
  });
});

describe("drafts, attachments, and queue helpers", () => {
  test("stores draft text and mentions per scoped tab and deletes empty values", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    store.setDraftText(keyA, "hello @src/App.tsx");
    store.setDraftMentions(keyA, [
      {
        id: "mention-1",
        filename: "App.tsx",
        relativePath: "src/App.tsx",
      },
    ]);
    store.setDraftText(keyB, "other draft");

    expect(store.getDraftText(keyA)).toBe("hello @src/App.tsx");
    expect(store.getDraftMentions(keyA)).toEqual([
      {
        id: "mention-1",
        filename: "App.tsx",
        relativePath: "src/App.tsx",
      },
    ]);
    expect(store.getDraftText(keyB)).toBe("other draft");

    store.setDraftText(keyA, "");
    store.setDraftMentions(keyA, []);

    expect(useClaudeTmuxStore.getState().getDraftText(keyA)).toBe("");
    expect(useClaudeTmuxStore.getState().getDraftMentions(keyA)).toEqual([]);
    expect(useClaudeTmuxStore.getState().getDraftText(keyB)).toBe("other draft");
  });

  test("adds, removes, and clears attachments per scoped tab", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    store.addAttachment(keyA, {
      id: "att-1",
      type: "image",
      path: "/workspace/one.png",
      previewUrl: "data:image/png;base64,one",
      name: "one.png",
    });
    store.addAttachment(keyA, {
      id: "att-2",
      type: "image",
      path: "/workspace/two.png",
      previewUrl: "data:image/png;base64,two",
      name: "two.png",
    });
    store.addAttachment(keyB, {
      id: "att-b",
      type: "image",
      path: "/workspace/b.png",
      previewUrl: "data:image/png;base64,b",
      name: "b.png",
    });

    expect(store.getAttachments(keyA).map((attachment) => attachment.id)).toEqual([
      "att-1",
      "att-2",
    ]);

    store.removeAttachment(keyA, "att-1");
    expect(useClaudeTmuxStore.getState().getAttachments(keyA).map((a) => a.id)).toEqual([
      "att-2",
    ]);
    expect(useClaudeTmuxStore.getState().getAttachments(keyB).map((a) => a.id)).toEqual([
      "att-b",
    ]);

    useClaudeTmuxStore.getState().clearAttachments(keyA);
    expect(useClaudeTmuxStore.getState().getAttachments(keyA)).toEqual([]);
    expect(useClaudeTmuxStore.getState().getAttachments(keyB).map((a) => a.id)).toEqual([
      "att-b",
    ]);
  });

  test("queues, reorders, removes, drains, and clears messages per scoped tab", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    store.addToQueue(keyA, { id: "q-1", text: "first", attachments: [] });
    store.addToQueue(keyA, { id: "q-2", text: "second", attachments: [] });
    store.addToQueue(keyA, { id: "q-3", text: "third", attachments: [] });
    store.addToQueue(keyB, { id: "q-b", text: "other", attachments: [] });

    expect(store.getQueueLength(keyA)).toBe(3);
    expect(store.getQueuedMessages(keyA).map((message) => message.id)).toEqual([
      "q-1",
      "q-2",
      "q-3",
    ]);

    store.moveQueueItem(keyA, 2, 0);
    expect(useClaudeTmuxStore.getState().getQueuedMessages(keyA).map((m) => m.id)).toEqual([
      "q-3",
      "q-1",
      "q-2",
    ]);

    useClaudeTmuxStore.getState().removeQueueItem(keyA, "q-1");
    expect(useClaudeTmuxStore.getState().getQueuedMessages(keyA).map((m) => m.id)).toEqual([
      "q-3",
      "q-2",
    ]);
    expect(useClaudeTmuxStore.getState().removeFromQueue(keyA)?.id).toBe("q-3");
    expect(useClaudeTmuxStore.getState().removeFromQueue(keyA)?.id).toBe("q-2");
    expect(useClaudeTmuxStore.getState().removeFromQueue(keyA)).toBeUndefined();

    expect(useClaudeTmuxStore.getState().getQueuedMessages(keyB).map((m) => m.id)).toEqual([
      "q-b",
    ]);
    useClaudeTmuxStore.getState().clearQueue(keyB);
    expect(useClaudeTmuxStore.getState().getQueueLength(keyB)).toBe(0);
  });
});

describe("session lifecycle", () => {
  test("setRunning preserves prior sessionId when called without sessionId", () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("e", true, { sessionId: "sess-1" });
    // Subsequent setRunning that doesn't pass sessionId leaves it intact.
    useClaudeTmuxStore.getState().setRunning("e", false);
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.running).toBe(false);
    expect(tab.sessionId).toBe("sess-1");
  });

  test("setRunning with sessionId=null clears it", () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("e", true, { sessionId: "sess-1" });
    useClaudeTmuxStore.getState().setRunning("e", false, { sessionId: null });
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.sessionId).toBeNull();
  });

  test("setRunning records resumed and environmentId", () => {
    useClaudeTmuxStore.getState().setRunning("tab-a", true, {
      sessionId: "sess-2",
      environmentId: "env-x",
      resumed: true,
    });
    const tab = useClaudeTmuxStore.getState().getTab("tab-a");
    expect(tab.sessionId).toBe("sess-2");
    expect(tab.environmentId).toBe("env-x");
    expect(tab.resumed).toBe(true);
  });

  test("resetTab clears state", () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("e", true, { sessionId: "sess-1" });
    store.applyTranscriptLine("e", {
      type: "user",
      uuid: "u",
      message: { role: "user", content: "hi" },
    });
    store.setDraftText("e", "queued draft");
    store.addAttachment("e", {
      id: "att-1",
      type: "image",
      path: "/workspace/att.png",
      previewUrl: "data:image/png;base64,att",
      name: "att.png",
    });
    store.addToQueue("e", {
      id: "queue-1",
      text: "queued prompt",
      attachments: [],
    });

    store.resetTab("e");
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.running).toBe(false);
    expect(tab.sessionId).toBeNull();
    expect(tab.messages).toHaveLength(0);
    expect(useClaudeTmuxStore.getState().getDraftText("e")).toBe("");
    expect(useClaudeTmuxStore.getState().getAttachments("e")).toEqual([]);
    expect(useClaudeTmuxStore.getState().getQueuedMessages("e")).toEqual([]);
  });
});
