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
