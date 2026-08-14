#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { appendFileSync, closeSync, existsSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId: number | null = null;
const provider = process.env.ACP_PROVIDER === "grok" ? "grok" : "cursor";

const cursorConfig = {
  sessionId: "fake-session",
  modes: {
    currentModeId: "agent",
    availableModes: [
      { id: "agent", name: "Agent", description: "Full tool access" },
      { id: "plan", name: "Plan", description: "Read-only planning" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "composer-2.5",
      options: [
        { value: "composer-2.5", name: "Composer 2.5" },
        { value: "gpt-5.5", name: "GPT-5.5" },
      ],
    },
    {
      id: "thought_level",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    {
      id: "fast",
      name: "Fast",
      category: "model_config",
      type: "boolean",
      currentValue: false,
    },
  ],
};

const grokConfig = {
  sessionId: "fake-session",
  modes: {
    currentModeId: "agent",
    availableModes: [
      { id: "agent", name: "Agent" },
      { id: "plan", name: "Plan" },
    ],
  },
  models: {
    currentModelId: "grok-build",
    availableModels: [
      {
        modelId: "grok-build",
        name: "Grok Build",
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "xhigh" }],
        },
      },
      { modelId: "grok-composer-2.5-fast", name: "Composer 2.5 Fast" },
    ],
  },
};

function sessionPayload(): JsonObject {
  return (provider === "grok" ? grokConfig : cursorConfig) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
        agentCapabilities: {
          loadSession: process.env.FAKE_ACP_NO_LOAD_SESSION !== "1",
          ...(process.env.FAKE_ACP_IMAGE_CAPABILITY
            ? { promptCapabilities: { image: process.env.FAKE_ACP_IMAGE_CAPABILITY === "true" } }
            : {}),
        },
        // Where Grok states its build. Standard ACP `agentInfo` is read too.
        _meta: { agentVersion: "9.9.9" },
      },
    });
    return;
  }
  if (message.method === "session/new" && typeof message.id === "number") {
    write({ jsonrpc: "2.0", id: message.id, result: sessionPayload() });
    if (process.env.FAKE_ACP_VENDOR_REQUEST_FILE) {
      write({
        jsonrpc: "2.0",
        id: 901,
        method: "x.ai/ask_user_question",
        params: { sessionId: "fake-session", question: "Continue?" },
      });
    }
    return;
  }
  if (message.method === "session/set_config_option" && typeof message.id === "number") {
    const failOnceFile = process.env.FAKE_ACP_FAIL_CONFIG_ONCE_FILE;
    if (failOnceFile && !existsSync(failOnceFile)) {
      appendFileSync(failOnceFile, "failed\n");
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "fake configuration failure" },
      });
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    const configId = typeof params.configId === "string" ? params.configId : "";
    const option = cursorConfig.configOptions.find((entry) => entry.id === configId);
    if (option) option.currentValue = params.value as never;
    write({ jsonrpc: "2.0", id: message.id, result: { configOptions: cursorConfig.configOptions } });
    return;
  }
  if (message.method === "session/set_mode" && typeof message.id === "number") {
    const params = isObject(message.params) ? message.params : {};
    const modeId = typeof params.modeId === "string" ? params.modeId : "agent";
    if (provider === "grok") grokConfig.modes.currentModeId = modeId;
    else cursorConfig.modes.currentModeId = modeId;
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_model" && typeof message.id === "number") {
    const params = isObject(message.params) ? message.params : {};
    const modelId = typeof params.modelId === "string" ? params.modelId : grokConfig.models.currentModelId;
    grokConfig.models.currentModelId = modelId;
    const meta = isObject(params._meta) ? params._meta : {};
    const current = grokConfig.models.availableModels.find((model) => model.modelId === modelId);
    if (current && typeof meta.reasoningEffort === "string" && current._meta) {
      current._meta.reasoningEffort = meta.reasoningEffort;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { _meta: { model: { Ok: modelId } } },
    });
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
    // Emitted on prompt rather than on session/new: the bridge only binds its
    // vendor handler once session/new has returned, so a catalogue update
    // racing that return would be dropped by the bridge, not by the transport.
    if (provider === "grok" && (
      process.env.FAKE_ACP_EMIT_MODEL_UPDATE === "1"
      || process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE
    )) {
      grokConfig.models.availableModels.push({
        modelId: "grok-next",
        name: "Grok Next",
      });
      write({
        jsonrpc: "2.0",
        // The same payload in the request form some vendor extensions use. The
        // bridge must apply it and answer, not reject it as unimplemented.
        ...(process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE ? { id: 902 } : {}),
        method: "x.ai/models/update",
        params: {
          sessionId: "fake-session",
          currentModelId: "grok-next",
          models: grokConfig.models.availableModels,
        },
      });
    }
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
    if (process.env.FAKE_ACP_PROMPT_BLOCKS_FILE) {
      appendFileSync(
        process.env.FAKE_ACP_PROMPT_BLOCKS_FILE,
        `${JSON.stringify(params?.prompt ?? [])}\n`,
      );
    }
    // An image-only prompt carries no text block, so none of the keyword
    // branches below can match it. Ending the turn is what a real agent does;
    // falling through would park it on a permission request and hide whatever
    // blocks the bridge actually sent.
    if (!params?.prompt?.some((block) => typeof block.text === "string")) {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
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
    if (prompt.startsWith("HANGTOOL")) {
      // Ends the turn with a tool still in flight. ACP has no cancelled tool
      // status, so this is what an interrupted or abandoned tool looks like.
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "hang-1",
            title: "Run a long job",
            kind: "execute",
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
            sessionUpdate: "tool_call",
            toolCallId: "hang-done",
            title: "Already finished",
            kind: "read",
            status: "completed",
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "cancelled" } });
      return;
    }
    if (prompt.startsWith("DIETOOL")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "crash-1",
            title: "Work that never lands",
            kind: "execute",
            status: "in_progress",
          },
        },
      });
      // Die mid-turn without answering the prompt: the bridge learns about the
      // orphaned tool only through the child's close handler.
      setTimeout(() => process.exit(1), 10);
      return;
    }
    if (prompt.startsWith("ODDSTATUS")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "odd-1",
            title: "Tool with a future status",
            kind: "execute",
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
            toolCallId: "odd-1",
            // A status no current protocol revision defines. It must not erase
            // the state the tool already had.
            status: "cancelled",
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("HUGEEDIT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "hugeedit-1",
            title: "Rewrite an oversized file",
            kind: "edit",
            status: "completed",
            // Both sides exceed the inline limit and the agent supplies no diff
            // of its own, so nothing can be rendered but a placeholder.
            content: [{
              type: "diff",
              path: "oversized.ts",
              oldText: "o".repeat(300 * 1024),
              newText: "n".repeat(300 * 1024),
            }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("MIXEDSTATS")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "mixed-1",
            title: "Edit two files, one uncountable",
            kind: "edit",
            status: "completed",
            content: [
              {
                type: "diff",
                path: "src/counted.ts",
                oldText: "before",
                newText: "after",
              },
              {
                // No newText and an oversized oldText: nothing to count and
                // nothing to render but a placeholder.
                type: "diff",
                path: "src/uncounted.ts",
                oldText: "x".repeat(300 * 1024),
              },
            ],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("WIDEEDIT")) {
      // More changed lines than the Myers search is allowed to explore, but well
      // inside the inline byte limit, so the bounded fallback has to produce it.
      const oldLines = Array.from({ length: 4000 }, (_, index) => `const before_${index} = ${index};`);
      const newLines = Array.from({ length: 4000 }, (_, index) => `const after_${index} = ${index * 2};`);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "wide-1",
            title: "Rewrite every line",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "src/wide.ts",
              oldText: ["const keep = true;", ...oldLines, "export {};"].join("\n"),
              newText: ["const keep = true;", ...newLines, "export {};"].join("\n"),
            }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("EMPTYDIFF")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "empty-1",
            title: "Edit with an unfilled diff field",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "src/empty.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;",
              // Present but never filled in. It says nothing, so it must not
              // shadow oldText/newText.
              diff: "",
            }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    // A turn that reports everything the agent info panel can show: the MCP
    // inventory and command list as notifications, then the same token counts
    // Grok repeats across a session notification and the prompt result.
    if (prompt.startsWith("USAGE")) {
      write({
        jsonrpc: "2.0",
        method: "_x.ai/mcp/servers_updated",
        params: {
          mcpServers: [
            { name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp", "--api-key", "secret"] },
            { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp"] },
          ],
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "review", description: "Review changes" },
              { name: "commit", description: "Commit changes" },
              { name: "test", description: "Run tests" },
            ],
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counted." } },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "response_completed",
            // Only this carrier reports the cache split, and it spells the
            // fields differently from the two that follow.
            usage: { input_tokens: 9_751, output_tokens: 36, cache_read_input_tokens: 5_888 },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "turn_completed",
            usage: {
              inputTokens: 15_639,
              outputTokens: 36,
              totalTokens: 15_675,
              reasoningTokens: 31,
              apiDurationMs: 1_448,
            },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          _meta: { totalTokens: 15_675, usage: { inputTokens: 15_639, outputTokens: 36 } },
        },
      });
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
    return;
  }
  if (message.id === 901 && process.env.FAKE_ACP_VENDOR_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_VENDOR_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return;
  }
  if (message.id === 902 && process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
  }
});
