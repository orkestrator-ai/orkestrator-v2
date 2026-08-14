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
    if (prompt.startsWith("TOOLSFIRST")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "lead-1",
            title: "Plan the work",
            kind: "plan",
            status: "pending",
            rawInput: { goal: "ship it" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Led with a tool." } },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FAILTOOL")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fail-1",
            title: "Probe the network",
            kind: "probe",
            status: "pending",
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
            toolCallId: "fail-1",
            status: "failed",
            rawOutput: { error: "boom" },
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
            toolCallId: "fail-2",
            title: "Touch a file",
            kind: "touch",
            status: "pending",
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
            toolCallId: "fail-2",
            status: "failed",
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Both tools failed." } },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("STREAMTOOL")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "stream-1",
            title: "Search the codebase",
            kind: "grep",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: "Searching for references..." } }],
            rawOutput: { phase: 1 },
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
            toolCallId: "stream-1",
            status: "completed",
            rawOutput: { phase: 2 },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("PATCHTOOLS")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "clear-1",
            title: "Edit `src/stale.ts`",
            kind: "edit",
            status: "in_progress",
            rawInput: { path: "src/stale.ts" },
            rawOutput: { phase: 1 },
            locations: [{ path: "src/stale.ts" }],
            content: [{
              type: "diff",
              path: "src/stale.ts",
              oldText: "before",
              newText: "after",
            }],
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
            toolCallId: "clear-1",
            title: null,
            kind: null,
            status: null,
            rawInput: null,
            rawOutput: { phase: 2 },
            content: [],
            locations: null,
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
            toolCallId: "clear-1",
            rawOutput: null,
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("MULTIDIFF")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "multi-1",
            title: "Edit two files",
            kind: "edit",
            status: "completed",
            content: [
              {
                type: "diff",
                path: "src/first.ts",
                oldText: "const shared = true;\nconst value = 1;\nexport { value };",
                newText: "const shared = true;\nconst value = 2;\nexport { value };",
              },
              {
                type: "diff",
                path: "src/second.ts",
                oldText: "before\nkeep",
                newText: "after\nkeep",
              },
            ],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("TERMINALTOOL")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "terminal-1",
            title: "Run the checks",
            kind: "execute",
            status: "completed",
            content: [
              { type: "terminal", terminalId: "terminal-42" },
              { type: "content", content: { type: "text", text: "Checks passed" } },
            ],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("BIGTOOL")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "big-1",
            title: "Edit a huge file",
            kind: "edit",
            status: "pending",
            rawInput: { path: "huge.ts", data: "x".repeat(600 * 1024) },
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
            toolCallId: "big-1",
            status: "completed",
            content: [{
              type: "diff",
              path: "huge.ts",
              oldText: "o".repeat(300 * 1024),
              newText: "n".repeat(300 * 1024),
              diff: `--- huge.ts\n+++ huge.ts\n@@\n-old\n+new\n${" context\n".repeat(220 * 1024)}`,
            }],
            rawOutput: "y".repeat(600 * 1024),
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("MANYTOOLS")) {
      for (let index = 0; index <= 512; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `many-${index}`,
              kind: "noop",
              status: "pending",
            },
          },
        });
      }
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
