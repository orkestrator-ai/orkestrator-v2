import { createInterface } from "node:readline";
import { appendFileSync, closeSync, existsSync } from "node:fs";

export type JsonObject = Record<string, unknown>;

export const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
export const provider = process.env.ACP_PROVIDER === "grok" ? "grok" : "cursor";

export const cursorConfig = {
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

export const grokConfig = {
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


export interface FakeAgentState {
  provider: typeof provider;
  cursorConfig: typeof cursorConfig;
  grokConfig: typeof grokConfig;
  promptRequestId: number | null;
  flattenedResourceExhaustedAttempts: number;
  flattenedResourceExhaustedScenario: boolean;
  rpcResourceExhaustedAttempts: number;
  rpcResourceExhaustedScenario: boolean;
}

export const state: FakeAgentState = {
  provider,
  cursorConfig,
  grokConfig,
  promptRequestId: null,
  flattenedResourceExhaustedAttempts: 0,
  flattenedResourceExhaustedScenario: false,
  rpcResourceExhaustedAttempts: 0,
  rpcResourceExhaustedScenario: false,
};

export function sessionPayload(sessionId = "fake-session"): JsonObject {
  const config = provider === "grok" ? grokConfig : cursorConfig;
  // An agent that advertises no model option at all. The bridge must then leave
  // the composer with no selection rather than inventing one, and assistant
  // messages must carry no model attribution.
  const withoutModel = provider !== "grok" && process.env.FAKE_ACP_NO_MODEL_OPTION === "1"
    ? {
        ...cursorConfig,
        configOptions: cursorConfig.configOptions.filter((option) => option.id !== "model"),
      }
    : config;
  return {
    ...withoutModel,
    sessionId,
  } as JsonObject;
}

export function isObject(value: unknown): value is JsonObject {
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

export function write(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Text a test waits for to prove an ignored `cursor/task` was already read. */
export const IGNORED_CURSOR_TASK_MARKER = "Cursor task frame delivered.";

/**
 * Emitted after a `cursor/task` the bridge is expected to ignore. The bridge
 * reads this stream in order, so a transcript containing the marker proves the
 * preceding frame was processed — without it, "the child is still active" could
 * just mean the test read before the frame arrived.
 */
export function writeIgnoredCursorTaskMarker(): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: IGNORED_CURSOR_TASK_MARKER },
      },
    },
  });
}

export const holdTurnFile = process.env.FAKE_ACP_HOLD_TURN_FILE;

/**
 * Runs `release` once the test creates `FAKE_ACP_HOLD_TURN_FILE`, or straight
 * away when no hold file is configured.
 *
 * Tests that need a turn to still be running while the bridge does detached
 * work must not pick a duration for it: that work spawns a child, initializes
 * it and loads a session, which is exactly the kind of thing a loaded CI host
 * makes slower than any timer a test would guess. The deadline is only a
 * backstop so a failing test cannot leave the process hanging.
 */
export function whenFileExists(file: string, release: () => void): void {
  const deadline = Date.now() + 30_000;
  const poll = (): void => {
    if (existsSync(file) || Date.now() > deadline) {
      release();
      return;
    }
    setTimeout(poll, 20);
  };
  poll();
}

export function whenReleased(release: () => void): void {
  if (!holdTurnFile) {
    release();
    return;
  }
  whenFileExists(holdTurnFile, release);
}



export function closeInput(): void {
  lines.close();
  closeSync(0);
}
