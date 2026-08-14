#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { appendFileSync, closeSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId: number | null = null;

if (process.env.FAKE_ACP_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ACP_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
}

if (process.env.FAKE_ACP_LIFECYCLE_FILE) {
  appendFileSync(process.env.FAKE_ACP_LIFECYCLE_FILE, `start:${process.pid}\n`);
  process.once("SIGTERM", () => {
    appendFileSync(process.env.FAKE_ACP_LIFECYCLE_FILE!, `stop:${process.pid}\n`);
    process.exit(0);
  });
}

function write(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as JsonObject;
  if (message.method === "initialize" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_HANG_INITIALIZE === "1") return;
    if (process.env.FAKE_ACP_MALFORMED_INITIALIZE === "1") {
      process.stdout.write("{not-json}\n");
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        // Agents that cannot resume a rollout must be rejected rather than
        // silently reattached to a session they have never heard of.
        agentCapabilities: { loadSession: process.env.FAKE_ACP_NO_LOAD_SESSION !== "1" },
      },
    });
    return;
  }
  if (message.method === "session/new" && typeof message.id === "number") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session" } });
    return;
  }
  if (message.method === "session/load" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_LIFECYCLE_FILE) {
      appendFileSync(process.env.FAKE_ACP_LIFECYCLE_FILE, `load:${process.pid}\n`);
    }
    if (process.env.FAKE_ACP_FAIL_LOAD_SESSION === "1") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "fake agent cannot load that session" },
      });
      return;
    }
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt" && typeof message.params === "object") {
    const text = (message.params as { prompt?: Array<{ text?: unknown }> }).prompt?.[0]?.text;
    // Exit without answering, so the bridge observes its child dying mid-turn.
    if (typeof text === "string" && text.startsWith("CRASH")) process.exit(9);
    // Answer, then close the read end of the pipe while staying alive. The
    // bridge's next write then fails with EPIPE against a child it still
    // believes is running — the exact race an unhandled stream error would
    // turn into an uncaught exception.
    if (typeof text === "string" && text.startsWith("CLOSESTDIN") && typeof message.id === "number") {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      setInterval(() => {}, 1_000);
      lines.close();
      closeSync(0);
      return;
    }
  }
  if (message.method === "session/prompt" && typeof message.id === "number") {
    const params = message.params as { prompt?: Array<{ text?: unknown }> } | undefined;
    const prompt = typeof params?.prompt?.[0]?.text === "string" ? params.prompt[0].text : "";
    if (process.env.FAKE_ACP_COUNTER_FILE) {
      appendFileSync(process.env.FAKE_ACP_COUNTER_FILE, "prompt\n");
    }
    if (prompt.startsWith("DIRECT:")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: prompt.slice("DIRECT:".length).split("\n\nReturn only")[0] } },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("OVERSIZED")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(2 * 1024 * 1024 + 128) } },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
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
            content: [{
              type: "diff",
              path: "src/example.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;\nconst ready = true;",
            }],
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
      return;
    }
    promptRequestId = message.id;
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking permission. " } },
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
    return;
  }
  if (message.method === "session/cancel" && promptRequestId !== null) {
    write({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "cancelled" } });
    promptRequestId = null;
    return;
  }
  if (message.id === 900 && typeof message.result === "object" && promptRequestId !== null) {
    const result = message.result as { outcome?: { optionId?: unknown } };
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { exitCode: 0, stdout: "ok" },
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
          content: { type: "text", text: `approved:${String(result.outcome?.optionId)}` },
        },
      },
    });
    write({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
    promptRequestId = null;
  }
});
