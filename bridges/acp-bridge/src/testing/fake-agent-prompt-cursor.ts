import { state, whenReleased, write, type JsonObject } from "./fake-agent-context.js";

export function handlePromptCursor(
  message: JsonObject,
  params: { prompt?: Array<{ text?: unknown }> } | undefined,
  prompt: string,
): boolean {
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS")) {
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "live-read-1",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-read-1",
        status: "completed",
        rawOutput: { content: "package contents" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "live-search-1",
        title: "grep",
        kind: "search",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-search-1",
        status: "completed",
        rawOutput: { totalMatches: 1, truncated: false },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      },
    });
    const finish = () =>
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    // Keep the authoritative turn running until the test releases it.
    if (prompt.startsWith("CURSOR_GENERIC_TOOLS_RUNNING")) whenReleased(finish);
    else finish();
    return true;
  }
  if (prompt.startsWith("TOOLS")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Editing the file. " },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          title: "Edit `src/example.ts`",
          kind: "edit",
          status: "pending",
          rawInput: { path: "src/example.ts" },
          locations: [{ path: "src/example.ts", line: 1 }],
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          status: "in_progress",
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/example.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;\nconst ready = true;",
            },
          ],
          rawOutput: { success: true },
          locations: [{ path: "src/example.ts" }],
        },
      },
    });
    // ACP tool updates are upserts. A client must retain an update even when
    // an initial `tool_call` frame was missed or the agent did not send one.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "search-1",
          title: "Search for references",
          kind: "search",
          status: "completed",
          rawInput: { pattern: "value" },
          rawOutput: { totalMatches: 3 },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Finished editing." },
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("GROK_USE_TOOL")) {
    // Grok 1.0.52 runs MCP tools through its `use_tool` wrapper. The call
    // carries the wrapped tool in `rawInput`; the permission request that
    // follows names only the wrapper.
    const toolName = prompt.slice("GROK_USE_TOOL".length).trim() || "orkestrator__check_inbox";
    const meta = { "x.ai/tool": { name: "use_tool" } };
    state.promptRequestId = message.id as number;
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: toolName,
          kind: "other",
          status: "pending",
          rawInput: { variant: "UseTool", tool_name: toolName, tool_input: {} },
          _meta: meta,
        },
      },
    });
    write({
      jsonrpc: "2.0",
      id: 900,
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tool-1", title: toolName, _meta: meta },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    return true;
  }
  state.promptRequestId = message.id as number;
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking permission. " },
      },
    },
  });
  write({
    jsonrpc: "2.0",
    id: 900,
    method: "session/request_permission",
    params: {
      sessionId: "fake-session",
      toolCall: { toolCallId: "tool-1", title: "Run safe command" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  });
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Run safe command",
        kind: "execute",
        status: "pending",
        rawInput: { command: "printf ok" },
      },
    },
  });
  return true;
}
