import { appendFileSync, existsSync } from "node:fs";
import {
  cursorConfig,
  grokConfig,
  holdTurnFile,
  isObject,
  provider,
  state,
  whenFileExists,
  whenReleased,
  write,
  type JsonObject,
} from "./fake-agent-context.js";

export function handlePromptCursor(
  message: JsonObject,
  params: { prompt?: Array<{ text?: unknown }> } | undefined,
  prompt: string,
): boolean {
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_PENDING_SIBLING")) {
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
        sessionUpdate: "tool_call",
        toolCallId: "live-read-2",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-read-2",
        status: "completed",
        rawOutput: { content: "second contents" },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    whenReleased(() => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-read-1",
            status: "completed",
            rawOutput: { content: "first contents" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    });
    return true;
  }
  // A settled generic read followed by an in-flight execute. The execute is
  // not a Cursor read/search label, but it used to sit in the live suffix and
  // make the whole pass stand down. The read's replay entry is already in
  // `FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA`.
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_PENDING_OTHER")) {
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
        toolCallId: "live-shell-1",
        title: "Run safe command",
        kind: "execute",
        status: "pending",
        rawInput: { command: "printf ok" },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    whenReleased(() => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-shell-1",
            status: "completed",
            rawOutput: { exitCode: 0, stdout: "ok" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    });
    return true;
  }
  // Settled generic read whose true index entry is withheld, plus a pending
  // execute that keeps the turn open. The live replay window is that one
  // settled call, so a prior same-kind entry with no output hash is the only
  // candidate — the live join must leave the part generic.
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_STALE_KIND")) {
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
        toolCallId: "live-shell-1",
        title: "Run safe command",
        kind: "execute",
        status: "pending",
        rawInput: { command: "printf ok" },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    whenReleased(() => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-shell-1",
            status: "completed",
            rawOutput: { exitCode: 0, stdout: "ok" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    });
    return true;
  }
  // Same shape as the pending-sibling case, then a second completion of the
  // already-settled read while its live replay is still running. That arms a
  // follow-up live pass whose settled window is already enriched, so it must
  // not spawn another child.
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_NOOP_FOLLOWUP")) {
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
        sessionUpdate: "tool_call",
        toolCallId: "live-read-2",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-read-2",
        status: "completed",
        rawOutput: { content: "second contents" },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    const secondSettleFile = process.env.FAKE_ACP_SECOND_SETTLE_FILE;
    if (secondSettleFile) {
      whenFileExists(secondSettleFile, () => {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "live-read-2",
              status: "completed",
              rawOutput: { content: "second contents" },
            },
          },
        });
      });
    }
    whenReleased(() => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-read-1",
            status: "completed",
            rawOutput: { content: "first contents" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    });
    return true;
  }
  // A generic read that failed with no output, plus an in-flight execute.
  // The live join has neither a path nor an output hash and must not use the
  // kind fallback, so it spends a replay child and still leaves the part
  // generic until the final pass.
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_FAILED_NO_OUTPUT")) {
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
        status: "failed",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "live-shell-1",
        title: "Run safe command",
        kind: "execute",
        status: "pending",
        rawInput: { command: "printf ok" },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    whenReleased(() => {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-shell-1",
            status: "completed",
            rawOutput: { exitCode: 0, stdout: "ok" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
    });
    return true;
  }
  // A generic call settles — arming a live pass — and then the turn itself
  // fails, so no final pass will ever run to consume that armed timer.
  if (prompt.startsWith("CURSOR_GENERIC_TOOLS_FAIL")) {
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
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    write({
      jsonrpc: "2.0",
      id: message.id as number,
      error: { code: -32603, message: "fake turn failure" },
    });
    return true;
  }
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
    // Keep the authoritative turn running until the test releases it, so a
    // detached replay can prove it enriched completed calls *before* the
    // final response rather than racing it.
    if (prompt.startsWith("CURSOR_GENERIC_TOOLS_RUNNING")) whenReleased(finish);
    else finish();
    return true;
  }
  // A second turn's worth of generic Cursor tool calls, distinguishable from
  // `CURSOR_GENERIC_TOOLS` only by their outputs — which is exactly what the
  // replay join has to key on to keep the two turns apart.
  if (prompt.startsWith("CURSOR_SECOND_TURN_TOOLS")) {
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "live-read-2",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-read-2",
        status: "completed",
        rawOutput: { content: "tsconfig contents" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "live-search-2",
        title: "grep",
        kind: "search",
        status: "pending",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-search-2",
        status: "completed",
        rawOutput: { totalMatches: 2, truncated: false },
      },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "fake-session", update },
      });
    }
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("CURSOR_SAME_KIND_TOOLS")) {
    for (const live of [
      { id: "live-read-a", output: "a" },
      { id: "live-read-b", output: "b" },
      { id: "live-read-c", output: "shared" },
      { id: "live-read-d", output: "shared" },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: live.id,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
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
            toolCallId: live.id,
            status: "completed",
            rawOutput: { content: live.output },
          },
        },
      });
    }
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("CURSOR_OVERSIZED_REPLAY")) {
    // Lead with enough ordinary response text that replay enrichment pushes
    // the aggregate over its budget. When the bridge trims, the notice and
    // the final enriched tool remain observable for the persistence check.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "s".repeat(128 * 1024) },
        },
      },
    });
    for (const live of [
      { id: "live-huge-a", output: "huge-a" },
      { id: "live-huge-b", output: "huge-b" },
      { id: "live-huge-c", output: "huge-c" },
    ]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: live.id,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
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
            toolCallId: live.id,
            status: "completed",
            rawOutput: { content: live.output },
          },
        },
      });
    }
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
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
