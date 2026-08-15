#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { appendFileSync, closeSync, existsSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId: number | null = null;
let flattenedResourceExhaustedAttempts = 0;
let flattenedResourceExhaustedScenario = false;
let rpcResourceExhaustedAttempts = 0;
let rpcResourceExhaustedScenario = false;
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

function sessionPayload(sessionId = "fake-session"): JsonObject {
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

const holdTurnFile = process.env.FAKE_ACP_HOLD_TURN_FILE;

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
function whenFileExists(file: string, release: () => void): void {
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

function whenReleased(release: () => void): void {
  if (!holdTurnFile) {
    release();
    return;
  }
  whenFileExists(holdTurnFile, release);
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
          sessionCapabilities: {
            ...(process.env.FAKE_ACP_NO_LIST_SESSION === "1" ? {} : { list: {} }),
          },
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
  if (message.method === "session/list" && typeof message.id === "number") {
    const params = isObject(message.params) ? message.params : {};
    const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    const listedCwd = process.env.FAKE_ACP_LIST_MISSING_CWD === "1"
      ? {}
      : { cwd: process.env.FAKE_ACP_LIST_WRONG_CWD === "1" ? `${cwd}-other` : cwd };
    const cursor = typeof params.cursor === "string" ? params.cursor : "";
    if (process.env.FAKE_ACP_LIST_COUNTER_FILE) {
      appendFileSync(process.env.FAKE_ACP_LIST_COUNTER_FILE, `${cursor || "<none>"}\n`);
    }
    // An agent that keeps handing back a cursor it has already issued must not
    // spin the bridge forever, so this loops on one repeated page deliberately.
    if (process.env.FAKE_ACP_LIST_REPEAT_CURSOR === "1") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessions: [{
            sessionId: "looping-session",
            ...listedCwd,
            title: "Looping ACP work",
          }],
          nextCursor: "same-cursor",
        },
      });
      return;
    }
    const pages = Number(process.env.FAKE_ACP_LIST_PAGES ?? "1");
    if (Number.isSafeInteger(pages) && pages > 1) {
      const page = cursor ? Number(cursor.replace("page-", "")) : 0;
      const last = page >= pages - 1;
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessions: [
            // Repeated on every page: the bridge must return one entry, not one
            // per page, so cross-page de-duplication is what is under test.
            {
              sessionId: "external-session",
              ...listedCwd,
              title: "Previous ACP work",
              updatedAt: "2026-08-13T20:00:00.000Z",
              _meta: { messageCount: 12 },
            },
            {
              sessionId: `paged-session-${page}`,
              ...listedCwd,
              title: `Paged ACP work ${page}`,
              updatedAt: "2026-08-12T20:00:00.000Z",
            },
          ],
          ...(last ? {} : { nextCursor: `page-${page + 1}` }),
        },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessions: [
          {
            sessionId: "fake-session",
            ...listedCwd,
            title: "Current ACP work",
            updatedAt: "2026-08-14T20:00:00.000Z",
            _meta: { messageCount: 4 },
          },
          {
            sessionId: "external-session",
            ...listedCwd,
            title: "Previous ACP work",
            updatedAt: "2026-08-13T20:00:00.000Z",
            _meta: { messageCount: 12 },
          },
        ],
      },
    });
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
    const params = isObject(message.params) ? message.params : {};
    const replaySessionId = typeof params.sessionId === "string"
      ? params.sessionId
      : "external-session";
    const replay = (update: JsonObject): void => write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: replaySessionId, update },
    });
    if (process.env.FAKE_ACP_REPLAY_HISTORY === "1") {
      replay({
        sessionUpdate: "user_message_chunk",
        messageId: "history-user-1",
        content: { type: "text", text: "Earlier question" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        messageId: "history-agent-1",
        content: { type: "text", text: "Earlier answer" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        messageId: "history-agent-1",
        content: { type: "text", text: " continued" },
      });
      // A replayed tool call has to be suppressed on reconnect exactly like the
      // replayed text around it, or the transcript grows one copy per restart.
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "history-tool-1",
        title: "Read earlier file",
        status: "completed",
      });
    }
    if (process.env.FAKE_ACP_REPLAY_ACTIVE_SUBAGENT === "1") {
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "history-background-child",
        title: "Task: Historical child",
        status: "completed",
        rawInput: { _toolName: "task", description: "Historical child" },
        rawOutput: { isBackground: true },
      });
    }
    if (process.env.FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA === "1") {
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-search-1",
        title: "grep --include=\"*.json\" \"scripts\"",
        kind: "search",
        status: "pending",
        rawInput: { pattern: "scripts", path: "/workspace" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-search-1",
        status: "completed",
        rawOutput: { totalMatches: 1, truncated: false },
      });
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-read-1",
        title: "Read package.json (1 - 80)",
        kind: "read",
        status: "pending",
        rawInput: { path: "/workspace/package.json" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-read-1",
        status: "completed",
        rawOutput: { content: "package contents" },
      });
    }
    // Cursor's index only holds calls that have settled, so this replay grows
    // as the turn progresses: the read still in flight appears only once the
    // hold file releases it. Replayed in completion order, which is the
    // reverse of the launch order the live transcript carries.
    if (process.env.FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS === "1") {
      const settled = [
        {
          id: "replay-read-2",
          title: "Read second.json (1 - 20)",
          path: "/workspace/second.json",
          content: "second contents",
        },
        ...(holdTurnFile && !existsSync(holdTurnFile)
          ? []
          : [{
              id: "replay-read-1",
              title: "Read first.json (1 - 40)",
              path: "/workspace/first.json",
              content: "first contents",
            }]),
      ];
      for (const entry of settled) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: entry.id,
          title: entry.title,
          kind: "read",
          status: "pending",
          rawInput: { path: entry.path },
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: entry.id,
          status: "completed",
          rawOutput: { content: entry.content },
        });
      }
    }
    // A prior same-kind read with a title and path but no output hash, plus the
    // live turn's true entry only after the hold file exists. A live pass sized
    // to one settled target keeps that stale call as its only candidate.
    if (process.env.FAKE_ACP_REPLAY_CURSOR_STALE_KIND === "1") {
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-stale-read",
        title: "Read stale.json (1 - 10)",
        kind: "read",
        status: "pending",
        rawInput: { path: "/workspace/stale.json" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-stale-read",
        status: "completed",
      });
      if (!holdTurnFile || existsSync(holdTurnFile)) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: "replay-read-1",
          title: "Read package.json (1 - 80)",
          kind: "read",
          status: "pending",
          rawInput: { path: "/workspace/package.json" },
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: "replay-read-1",
          status: "completed",
          rawOutput: { content: "package contents" },
        });
      }
    }
    // The same first turn as above, preceded by tool calls from turns the live
    // transcript has already enriched or never held. Exercises the collector's
    // count bound: only the trailing `capacity` calls may survive.
    if (process.env.FAKE_ACP_REPLAY_CURSOR_HISTORY_TOOL_METADATA === "1") {
      for (const stale of [
        { id: "replay-stale-1", title: "Read stale-one.json", path: "/workspace/stale-one.json" },
        { id: "replay-stale-2", title: "Read stale-two.json", path: "/workspace/stale-two.json" },
      ]) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: stale.id,
          title: stale.title,
          kind: "read",
          status: "pending",
          rawInput: { path: stale.path },
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: stale.id,
          status: "completed",
          rawOutput: { content: "stale contents" },
        });
      }
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-search-1",
        title: "grep --include=\"*.json\" \"scripts\"",
        kind: "search",
        status: "pending",
        rawInput: { pattern: "scripts", path: "/workspace" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-search-1",
        status: "completed",
        rawOutput: { totalMatches: 1, truncated: false },
      });
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-read-1",
        title: "Read package.json (1 - 80)",
        kind: "read",
        status: "pending",
        rawInput: { path: "/workspace/package.json" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-read-1",
        status: "completed",
        rawOutput: { content: "package contents" },
      });
    }
    // Two complete turns' worth of tool calls, so a replay that loads late
    // enough to see the *second* turn can be caught handing its paths and
    // titles to the first turn's parts.
    if (process.env.FAKE_ACP_REPLAY_CURSOR_TWO_TURN_METADATA === "1") {
      for (const replayed of [
        {
          id: "replay-search-1",
          title: "grep --include=\"*.json\" \"scripts\"",
          kind: "search",
          rawInput: { pattern: "scripts", path: "/workspace" },
          rawOutput: { totalMatches: 1, truncated: false },
        },
        {
          id: "replay-read-1",
          title: "Read package.json (1 - 80)",
          kind: "read",
          rawInput: { path: "/workspace/package.json" },
          rawOutput: { content: "package contents" },
        },
        {
          id: "replay-read-2",
          title: "Read tsconfig.json (1 - 40)",
          kind: "read",
          rawInput: { path: "/workspace/tsconfig.json" },
          rawOutput: { content: "tsconfig contents" },
        },
        {
          id: "replay-search-2",
          title: "grep --include=\"*.ts\" \"strict\"",
          kind: "search",
          rawInput: { pattern: "strict", path: "/workspace/src" },
          rawOutput: { totalMatches: 2, truncated: false },
        },
      ]) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: replayed.id,
          title: replayed.title,
          kind: replayed.kind,
          status: "pending",
          rawInput: replayed.rawInput,
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: replayed.id,
          status: "completed",
          rawOutput: replayed.rawOutput,
        });
      }
    }
    if (process.env.FAKE_ACP_REPLAY_CURSOR_SAME_KIND_METADATA === "1") {
      for (const replayed of [
        { id: "replay-read-c", title: "Read c.json", path: "/workspace/c.json", output: "shared" },
        { id: "replay-read-b", title: "Read b.json", path: "/workspace/b.json", output: "b" },
        { id: "replay-read-d", title: "Read d.json", path: "/workspace/d.json", output: "shared" },
        { id: "replay-read-a", title: "Read a.json", path: "/workspace/a.json", output: "a" },
      ]) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: replayed.id,
          title: replayed.title,
          kind: "read",
          status: "pending",
          rawInput: { path: replayed.path },
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: replayed.id,
          status: "completed",
          rawOutput: { content: replayed.output },
        });
      }
    }
    if (process.env.FAKE_ACP_REPLAY_CURSOR_OVERSIZED_METADATA === "1") {
      for (const replayed of [
        { id: "replay-huge-b", title: "Read huge-b.json", path: "/workspace/huge-b.json", output: "huge-b" },
        { id: "replay-huge-a", title: "Read huge-a.json", path: "/workspace/huge-a.json", output: "huge-a" },
        { id: "replay-huge-c", title: "Read huge-c.json", path: "/workspace/huge-c.json", output: "huge-c" },
      ]) {
        replay({
          sessionUpdate: "tool_call",
          toolCallId: replayed.id,
          title: replayed.title,
          kind: "read",
          status: "pending",
          rawInput: { path: replayed.path, payload: "x".repeat(480 * 1024) },
        });
        replay({
          sessionUpdate: "tool_call_update",
          toolCallId: replayed.id,
          status: "completed",
          rawOutput: { content: replayed.output },
        });
      }
    }
    // The same history without provider message ids, which is all the bridge
    // gets from an agent that does not stamp them. Message boundaries then have
    // to come from chunk-versus-whole rather than from part type.
    if (process.env.FAKE_ACP_REPLAY_NO_MESSAGE_IDS === "1") {
      replay({
        sessionUpdate: "user_message",
        // Array-form content: several blocks in one update.
        content: [{ type: "text", text: "Earlier " }, { type: "text", text: "question" }],
      });
      replay({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking first" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Earlier answer" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " continued" },
      });
      // A whole-message update always starts a new turn, so this must not be
      // folded into the assistant message above.
      replay({
        sessionUpdate: "agent_message",
        content: { type: "text", text: "Second answer" },
      });
    }
    // Enough distinct provider message ids to push the bridge past its own
    // history-id bound, so eviction runs against a live transcript.
    const replayCount = Number(process.env.FAKE_ACP_REPLAY_MESSAGE_COUNT ?? "0");
    if (Number.isSafeInteger(replayCount) && replayCount > 0) {
      for (let index = 0; index < replayCount; index += 1) {
        replay({
          sessionUpdate: "agent_message_chunk",
          messageId: `bulk-agent-${index}`,
          content: { type: "text", text: `Bulk ${index}` },
        });
      }
    }
    const answer = (): void => write({
      jsonrpc: "2.0",
      id: message.id as number,
      result: sessionPayload(typeof params.sessionId === "string" ? params.sessionId : "fake-session"),
    });
    // Holds `session/load` open so a second resume for the same ACP session
    // genuinely races the first rather than finding it already finished.
    const loadDelayMs = Number(process.env.FAKE_ACP_LOAD_DELAY_MS ?? "0");
    if (Number.isSafeInteger(loadDelayMs) && loadDelayMs > 0) setTimeout(answer, loadDelayMs);
    else answer();
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
    const resumesResourceExhaustedScenario = prompt.startsWith(
      "Continue from where the interrupted turn stopped.",
    );
    // Text streamed before an attempt fails. Off by default so the scenarios
    // that assert an exact recovered transcript stay unchanged; the structured
    // cases switch it on to produce the realistic "streamed, then failed" shape.
    const resourceExhaustedPartial = process.env.FAKE_ACP_RESOURCE_EXHAUSTED_PARTIAL;
    const writeResourceExhaustedPartial = (): void => {
      if (!resourceExhaustedPartial) return;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: resourceExhaustedPartial },
          },
        },
      });
    };
    const startsRpcResourceExhaustedScenario = prompt.startsWith("RESOURCEEXHAUSTEDRPC:");
    if (startsRpcResourceExhaustedScenario) rpcResourceExhaustedScenario = true;
    if (rpcResourceExhaustedScenario
      && (startsRpcResourceExhaustedScenario || resumesResourceExhaustedScenario)) {
      const configuredAttempts = Number(process.env.FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS ?? "1");
      const failedAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 0
        ? configuredAttempts
        : 1;
      if (rpcResourceExhaustedAttempts < failedAttempts) {
        rpcResourceExhaustedAttempts += 1;
        writeResourceExhaustedPartial();
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "RetriableError: [resource_exhausted] Error" },
        });
        return;
      }
      rpcResourceExhaustedScenario = false;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: process.env.FAKE_ACP_RESOURCE_EXHAUSTED_FINAL
                ?? "Recovered from the structured RPC error.",
            },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    const startsResourceExhaustedScenario = prompt.startsWith("RESOURCEEXHAUSTED:");
    if (startsResourceExhaustedScenario) flattenedResourceExhaustedScenario = true;
    if (flattenedResourceExhaustedScenario
      && (startsResourceExhaustedScenario || resumesResourceExhaustedScenario)) {
      const configuredAttempts = Number(
        process.env.FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS ?? "1",
      );
      const failedAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 0
        ? configuredAttempts
        : 1;
      if (flattenedResourceExhaustedAttempts < failedAttempts) {
        if (flattenedResourceExhaustedAttempts === 0) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "fake-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Completed the first safe step." },
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
                toolCallId: "resource-safe-1",
                title: "Inspect repository state",
                kind: "read",
                status: "completed",
              },
            },
          });
        }
        flattenedResourceExhaustedAttempts += 1;
        writeResourceExhaustedPartial();
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                // The class name varies by provider error; `RetriableError` is
                // only the one Cursor emits today.
                text: `\n\nError: ${
                  process.env.FAKE_ACP_FLATTENED_ERROR_NAME ?? "RetriableError"
                }: [resource_exhausted] Error`,
              },
            },
          },
        });
        // Cursor's ACP bug returns success even though the model-side failure
        // was flattened into ordinary assistant text.
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        // Optionally die while the bridge is parked in backoff, so the retry
        // wakes up to a session whose child is gone.
        const dieAfterMs = Number(process.env.FAKE_ACP_RESOURCE_EXHAUSTED_DIE_AFTER_MS ?? "");
        if (Number.isSafeInteger(dieAfterMs) && dieAfterMs > 0) {
          setTimeout(() => process.exit(1), dieAfterMs);
        }
        return;
      }
      flattenedResourceExhaustedScenario = false;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: process.env.FAKE_ACP_RESOURCE_EXHAUSTED_FINAL
                ?? "Recovered and finished the original request.",
            },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    // Agents that mirror the user turn back to the client mid-prompt. The
    // bridge already holds the authoritative copy from `/session/prompt`, so
    // this must not reach the transcript in any form.
    if (process.env.FAKE_ACP_ECHO_USER_PROMPT === "1") {
      for (const update of [
        {
          sessionUpdate: "user_message_chunk",
          messageId: "live-user-1",
          content: { type: "text", text: prompt },
        },
        // The same echo without a message id, and as a whole message.
        { sessionUpdate: "user_message", content: { type: "text", text: prompt } },
      ]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "fake-session", update },
        });
      }
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
    if (prompt.startsWith("STREAMOVERFLOW")) {
      // Real agents stream in many chunks. Leave one byte under the message cap
      // before crossing it so the bridge has to reclaim already-buffered text
      // to make the truncation marker visible. Put a multi-byte code point over
      // the reclaimed boundary so the shortened prefix must remain valid UTF-8.
      const maximumBytes = 2 * 1024 * 1024;
      const markerBytes = Buffer.byteLength("\n[output truncated by Orkestrator]");
      const contentLimit = maximumBytes - markerBytes;
      const first = "x".repeat(contentLimit - 1)
        + "🙂"
        + "y".repeat(markerBytes - Buffer.byteLength("🙂"));
      for (const text of [first, "yz"]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          },
        });
      }
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
    if (prompt.startsWith("BACKGROUNDSUBAGENT")) {
      if (provider === "grok") {
        const toolMeta = {
          version: 1,
          name: "spawn_subagent",
          kind: "task",
          namespace: "grok_build",
          label: "Subagent",
          read_only: false,
        };
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "grok-subagent-tool-1",
              title: "Agent: Validate the implementation",
              rawInput: {
                background: true,
                description: "Validate the implementation",
                prompt: "Inspect the implementation and report any issues.",
                subagent_type: "explore",
              },
              _meta: {
                subagentBackground: true,
                "x.ai/tool": toolMeta,
              },
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
              toolCallId: "grok-subagent-tool-1",
              title: "Launch validation agent",
              kind: "other",
              rawInput: {
                variant: "Task",
                task_id: "",
                capability_mode: "default",
                run_in_background: true,
                description: "Validate the implementation",
                prompt: "Inspect the implementation and report any issues.",
                subagent_type: "explore",
              },
              _meta: { "x.ai/tool": toolMeta },
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
              toolCallId: "grok-subagent-tool-1",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "Subagent started." } }],
              rawOutput: { type: "Text", text: "Subagent started." },
            },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "subagent_spawned",
              subagent_id: "grok-subagent-1",
              child_session_id: "grok-child-session-1",
              parent_session_id: "fake-session",
              parent_prompt_id: "grok-parent-prompt-1",
              subagent_type: "explore",
              description: "Validate the implementation",
              model: "grok-test",
              effective_context_source: "parent",
            },
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return;
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-subagent-1",
            title: "Task: Validate the implementation",
            kind: "other",
            status: "in_progress",
            rawInput: {
              _toolName: "task",
              description: "Validate the implementation",
            },
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
            toolCallId: "cursor-subagent-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
            rawOutput: { durationMs: 42, isBackground: true },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("NESTEDSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-subagent-1",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: {
              _toolName: "task",
              description: "Subagent task",
            },
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
            toolCallId: "cursor-subagent-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
            rawOutput: { durationMs: 42, isBackground: true },
          },
        },
      });
      // One child per parent-id shape the bridge accepts. The standard ACP
      // schema has no parent field, so every vendor spelling has to be proven
      // rather than assumed — a typo in any key would otherwise ship silently.
      const nestedChildren: Array<{ id: string; title: string; parent: Record<string, unknown> }> = [
        {
          id: "cursor-child-grep-1",
          title: "Search Find",
          parent: { _meta: { parentToolCallId: "cursor-subagent-1" } },
        },
        // Titles stay deliberately non-generic: a generic Cursor title is a
        // replay-reconcile candidate, which is a different code path.
        {
          id: "cursor-child-read-2",
          title: "Inspect Manifest",
          parent: { parentToolCallId: "cursor-subagent-1" },
        },
        {
          id: "cursor-child-edit-3",
          title: "Apply Patch",
          parent: { parent_tool_call_id: "cursor-subagent-1" },
        },
        {
          id: "cursor-child-list-4",
          title: "Enumerate Modules",
          parent: { _meta: { parent_tool_call_id: "cursor-subagent-1" } },
        },
        {
          id: "cursor-child-claude-5",
          title: "Summarize Findings",
          parent: { _meta: { claudeCode: { parentToolUseId: "cursor-subagent-1" } } },
        },
        {
          id: "cursor-child-claude-6",
          title: "Collect Diagnostics",
          parent: { _meta: { claudeCode: { parent_tool_use_id: "cursor-subagent-1" } } },
        },
        // A provider that names a call as its own parent must not produce a
        // self-parented part; the frontend would group it under itself.
        {
          id: "cursor-child-self-7",
          title: "Self Referencing",
          parent: { _meta: { parentToolCallId: "cursor-child-self-7" } },
        },
      ];
      for (const child of nestedChildren) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: child.id,
              title: child.title,
              kind: "search",
              status: "in_progress",
              rawInput: { _toolName: "grep", pattern: "ActiveSubagentRail" },
              ...child.parent,
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("PENDINGSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "abandoned-subagent-1",
            title: "Task: Never launched",
            status: "in_progress",
            rawInput: { _toolName: "task", description: "Never launched" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("SUBAGENTOVERFLOW")) {
      // These are protocol frames, not child OS processes. Two arrive after
      // the 512-entry bound: one trips it and the next proves the fatal latch
      // cannot be reopened by later buffered provider output.
      for (let index = 0; index < 514; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `overflow-subagent-${index}`,
              title: `Task: Overflow child ${index}`,
              status: "completed",
              rawInput: {
                _toolName: "task",
                background: true,
                description: `Overflow child ${index}`,
              },
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FINISHCURSORSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cursor-subagent-1",
            status: "completed",
            rawOutput: { durationMs: 84, isBackground: false, status: "completed" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FAILCURSORSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cursor-subagent-1",
            status: "failed",
            rawOutput: { status: "failed", error: "child failed" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("GROKMULTISUBAGENT")) {
      for (const [suffix, description, subagentType] of [
        ["a", "Alpha task", "explore"],
        ["b", "Beta task", "review"],
      ]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `grok-multi-tool-${suffix}`,
              title: `Agent: ${description}`,
              status: "completed",
              rawInput: {
                _toolName: "task",
                run_in_background: true,
                description,
                subagent_type: subagentType,
              },
            },
          },
        });
      }
      for (const [subagentId, description, subagentType] of [
        ["grok-mismatch", "Unknown task", "explore"],
        ["grok-child-b", "Beta task", "review"],
        ["grok-child-a", "Alpha task", "explore"],
      ]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "subagent_spawned",
              subagent_id: subagentId,
              description,
              subagent_type: subagentType,
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FAILGROKSUBAGENT_B")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "subagent_finished", subagent_id: "grok-child-b", status: "failed" },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("CANCELGROKSUBAGENT_A")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "subagent_finished", subagent_id: "grok-child-a", status: "cancelled" },
        },
      });
      // A mismatched spawn must still be uncorrelated and harmless.
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "subagent_finished", subagent_id: "grok-mismatch", status: "completed" },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("EVICTGROKSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "grok-evicted-tool",
            title: "Agent: Survive transcript eviction",
            status: "completed",
            rawInput: {
              _toolName: "task",
              run_in_background: true,
              description: "Survive transcript eviction",
              subagent_type: "explore",
            },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "subagent_spawned",
            subagent_id: "grok-evicted-child",
            description: "Survive transcript eviction",
            subagent_type: "explore",
          },
        },
      });
      for (const index of [0, 1]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `grok-eviction-filler-${index}`,
              title: `Large retained output ${index}`,
              status: "completed",
              rawOutput: `${index}:`.padEnd(600 * 1024, "x"),
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FINISHEVICTEDGROKSUBAGENT")) {
      // Push the launch's already-trimmed assistant message out of the byte
      // window entirely before the terminal child notification arrives.
      for (const index of [0, 1]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `grok-late-filler-${index}`,
              title: `Late retained output ${index}`,
              status: "completed",
              rawOutput: `${index}:`.padEnd(600 * 1024, "y"),
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "subagent_finished",
            subagent_id: "grok-evicted-child",
            status: "completed",
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FINISHEVICTEDCURSORSUBAGENT")) {
      for (const index of [0, 1]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `cursor-late-filler-${index}`,
              title: `Late retained output ${index}`,
              status: "completed",
              rawOutput: `${index}:`.padEnd(600 * 1024, "z"),
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cursor-subagent-1",
            status: "completed",
            rawOutput: { isBackground: false, status: "completed" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("FINISHSUBAGENT")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "subagent_finished",
            subagent_id: "grok-subagent-1",
            child_session_id: "grok-child-session-1",
            status: "completed",
            duration_ms: 42,
            tokens_used: 12,
            tool_calls: 1,
            turns: 1,
            output: "Validation complete.",
            will_wake: true,
          },
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
    if (prompt.startsWith("TRANSCRIPTOVERFLOW")) {
      // Individually valid parts whose combined rendered transcript crosses the
      // 16 MiB budget. Each update is terminal so persistence/reload can verify
      // trimming without stale-tool reconciliation changing the snapshot.
      for (let index = 0; index < 34; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `large-${index}`,
              kind: "read",
              status: "completed",
              rawOutput: `${index}:`.padEnd(520 * 1024, "x"),
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("TRIMTOTEXT")) {
      // Two parts that together cross a lowered transcript budget, so the
      // aggregate trim empties the message down to the notice alone — the one
      // state in which the notice is also the *last* part. The text chunk that
      // follows must start a new part rather than stream into the notice.
      // Needs ACP_MAX_TRANSCRIPT_BYTES=1048576.
      for (const index of [0, 1]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `bulk-${index}`,
              // Widens each part beyond its output alone, so the pair clears
              // the budget by kilobytes rather than by JSON punctuation.
              title: `Bulk read ${index} `.padEnd(3 * 1024, "."),
              kind: "read",
              status: "completed",
              rawOutput: `${index}:`.padEnd(600 * 1024, "x"),
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered summary." },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("TRIMMEDTOOLUPDATE")) {
      // A long-running early tool whose completion lands after the volume of
      // the turn has already trimmed its part away.
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "early-1",
            title: "Start the long build",
            kind: "execute",
            status: "pending",
          },
        },
      });
      for (let index = 0; index < 520; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `filler-${index}`,
              kind: "read",
              status: "completed",
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "early-1",
            status: "completed",
            rawOutput: "build finished",
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("SATURATEDSTREAM")) {
      // Fills the per-message cap, then sends one more chunk. Overflow no
      // longer ends an interactive turn, so that chunk reaches a buffer which
      // cannot grow and has to be discarded.
      const maximumBytes = 2 * 1024 * 1024;
      const markerBytes = Buffer.byteLength("\n[output truncated by Orkestrator]");
      const contentLimit = maximumBytes - markerBytes;
      // Truncating this at the content limit lands inside the emoji, so the
      // bridge backs off a byte and the capped buffer settles one byte under
      // the cap. That single free byte is what a plain "is there room?" test
      // hands to the next chunk — placing it *after* the truncation marker.
      // The one-byte chunk has to be last: any further chunk reclaims the
      // prefix, rewrites the marker at the end, and hides the corruption.
      const first = "s".repeat(contentLimit - 1) + "🙂" + "s".repeat(64);
      for (const text of [first, "!"]) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("NOOPEDIT")) {
      // An edit tool that reports identical file states. There is no change to
      // place in a hunk, so there is nothing to render.
      const unchanged = Array.from({ length: 40 }, (_, index) => `const line_${index} = ${index};`)
        .join("\n");
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "noop-1",
            title: "Rewrite a file with the same contents",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "src/noop.ts",
              oldText: unchanged,
              newText: unchanged,
            }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
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
    if (prompt.startsWith("CONTEXTEDIT")) {
      // The shape that exhausted the transcript in the field: a one-line change
      // to a large file, sent as whole-file oldText/newText.
      const lines = Array.from({ length: 5000 }, (_, index) => `const line_${index} = ${index};`);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "context-1",
            title: "Edit one line of a large file",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "src/large.ts",
              oldText: lines.join("\n"),
              newText: lines
                .map((line, index) => index === 2500 ? `${line} // touched` : line)
                .join("\n"),
            }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt.startsWith("MULTIHUNK")) {
      const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
      const newLines = oldLines.map((line, index) =>
        index === 0 || index === 9 || index === 19 ? `${line} changed` : line
      );
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "multi-hunk-1",
            title: "Edit three distant lines",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "src/boundaries.ts",
              oldText: oldLines.join("\n"),
              newText: newLines.join("\n"),
            }],
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
    // A later turn that intentionally omits the optional breakdown from the
    // full USAGE carrier below. Its missing fields must stay missing instead of
    // leaking forward from an earlier turn.
    if (prompt.startsWith("USAGE_SPARSE")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counted again." } },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "turn_completed",
            usage: { inputTokens: 200, outputTokens: 22, totalTokens: 222 },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          _meta: { totalTokens: 222, usage: { inputTokens: 200, outputTokens: 22 } },
        },
      });
      return;
    }
    // A turn whose last usage carrier arrives *after* the prompt result has
    // already resolved, which is the only way an agent can report tokens while
    // the bridge has no turn in flight. The late field must still land on the
    // turn it describes rather than being dropped.
    if (prompt.startsWith("USAGE_LATE")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counted late." } },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          _meta: { totalTokens: 900, usage: { inputTokens: 850, outputTokens: 50 } },
        },
      });
      setTimeout(() => {
        write({
          jsonrpc: "2.0",
          method: "_x.ai/session_notification",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "turn_completed",
              usage: { reasoningTokens: 77 },
            },
          },
        });
        // Long enough that a caller polling every 20ms reliably observes the
        // turn settle first, so the test can assert both halves of the merge.
      }, 250);
      return;
    }
    // Standard ACP carriers Cursor's CLI schema already defines but does not
    // emit. The bridge must still consume them so occupancy appears the moment
    // an agent starts sending `usage_update` / `PromptResponse.usage`.
    // v2 turn-complete usage rides idle `state_update.usage`; session/prompt
    // itself returns only a stop reason, the way Cursor's empty result looks.
    if (prompt.startsWith("USAGE_STATE")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counted over state_update." } },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "state_update", state: "running" },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
            usage: {
              totalTokens: 8_000,
              inputTokens: 7_000,
              outputTokens: 1_000,
              thoughtTokens: 50,
              cachedReadTokens: 4_000,
              cachedWriteTokens: 20,
            },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" },
      });
      return;
    }
    if (prompt.startsWith("USAGE_ACP")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counted over ACP." } },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "usage_update",
            used: 15_675,
            size: 200_000,
            cost: { amount: 0.042, currency: "USD" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          usage: {
            totalTokens: 12_345,
            inputTokens: 10_000,
            outputTokens: 2_000,
            thoughtTokens: 300,
            cachedReadTokens: 5_000,
            cachedWriteTokens: 45,
          },
        },
      });
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
    // Two same-kind reads launched together, only the second of which settles
    // while the turn keeps running. Cursor indexes a call when it settles, so
    // `FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS` withholds the first read's
    // metadata until this prompt is released. A live pass must enrich the
    // settled sibling from that partial index without letting the pending one
    // claim it.
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
      return;
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
      return;
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
      return;
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
      return;
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
      return;
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
      return;
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
      const finish = () => write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: { stopReason: "end_turn" },
      });
      // Keep the authoritative turn running until the test releases it, so a
      // detached replay can prove it enriched completed calls *before* the
      // final response rather than racing it.
      if (prompt.startsWith("CURSOR_GENERIC_TOOLS_RUNNING")) whenReleased(finish);
      else finish();
      return;
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
      return;
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
      return;
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
