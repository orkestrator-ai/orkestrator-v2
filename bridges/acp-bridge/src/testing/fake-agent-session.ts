import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  genericConfig,
  grokConfig,
  isObject,
  provider,
  sessionPayload,
  whenFileExists,
  write,
  type JsonObject,
} from "./fake-agent-context.js";

/**
 * Announce the command inventory in `FAKE_ACP_COMMANDS_FILE` (a JSON array of
 * raw ACP rows), when that file exists. Re-read on every call so a test can
 * change what the agent offers between announcements.
 */
export function announceCommands(sessionId: string): void {
  const path = process.env.FAKE_ACP_COMMANDS_FILE;
  if (!path || !existsSync(path)) return;
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: JSON.parse(readFileSync(path, "utf8")) as unknown,
      },
    },
  });
}

/**
 * Answers a composer RPC (`session/set_config_option`, `session/set_mode`,
 * `session/set_model`). Each request is first logged to
 * `FAKE_ACP_CONFIG_REQUEST_FILE` as `<method> <json params>`, so a test can
 * see that a patch has reached the agent. When `FAKE_ACP_HOLD_CONFIG_FILE` is
 * set the answer waits until the test creates that file, which keeps the
 * patch in flight on the bridge for as long as the test needs: a race between
 * a patch and another request then always overlaps instead of depending on
 * which loopback request the bridge happens to read first.
 */
function answerConfigRpc(message: JsonObject, answer: () => void): void {
  const requestFile = process.env.FAKE_ACP_CONFIG_REQUEST_FILE;
  if (requestFile) {
    appendFileSync(requestFile, `${String(message.method)} ${JSON.stringify(message.params)}\n`);
  }
  const holdFile = process.env.FAKE_ACP_HOLD_CONFIG_FILE;
  if (holdFile) whenFileExists(holdFile, answer);
  else answer();
}

function answerSetConfigOption(message: JsonObject): void {
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
  const option = genericConfig.configOptions.find((entry) => entry.id === configId);
  if (option) option.currentValue = params.value as never;
  write({
    jsonrpc: "2.0",
    id: message.id,
    result: { configOptions: genericConfig.configOptions },
  });
}

function answerSetMode(message: JsonObject): void {
  const params = isObject(message.params) ? message.params : {};
  const modeId = typeof params.modeId === "string" ? params.modeId : "agent";
  if (provider === "grok") grokConfig.modes.currentModeId = modeId;
  else genericConfig.modes.currentModeId = modeId;
  write({ jsonrpc: "2.0", id: message.id, result: {} });
}

function answerSetModel(message: JsonObject): void {
  const failOnceFile = process.env.FAKE_ACP_FAIL_MODEL_ONCE_FILE;
  if (failOnceFile && !existsSync(failOnceFile)) {
    appendFileSync(failOnceFile, "failed\n");
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: "fake model configuration failure" },
    });
    return;
  }
  const params = isObject(message.params) ? message.params : {};
  const modelId =
    typeof params.modelId === "string" ? params.modelId : grokConfig.models.currentModelId;
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
}

export function handleSessionMessage(message: JsonObject): boolean {
  if (message.method === "initialize" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_HANG_INITIALIZE === "1") return true;
    if (process.env.FAKE_ACP_MALFORMED_INITIALIZE === "1") {
      process.stdout.write("{not-json}\n");
      return true;
    }
    if (process.env.FAKE_ACP_INITIALIZE_REQUEST_FILE) {
      appendFileSync(process.env.FAKE_ACP_INITIALIZE_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL_VERSION || "1"),
        // Agents that cannot resume a rollout must be rejected rather than
        // silently reattached to a session they have never heard of.
        agentCapabilities: {
          loadSession: process.env.FAKE_ACP_NO_LOAD_SESSION !== "1",
          sessionCapabilities: process.env.FAKE_ACP_NO_LIST_SESSION === "1" ? {} : { list: {} },
          promptCapabilities: {
            image: process.env.FAKE_ACP_IMAGE_CAPABILITY !== "false",
            embeddedContext: process.env.FAKE_ACP_EMBEDDED_CONTEXT === "true",
          },
        },
        ...(process.env.FAKE_ACP_AUTH_METHOD
          ? { authMethods: [{ id: process.env.FAKE_ACP_AUTH_METHOD, name: "Test login" }] }
          : {}),
        // Where Grok states its build. Standard ACP `agentInfo` is read too.
        _meta: { agentVersion: "9.9.9" },
      },
    });
    return true;
  }
  // Grok's extensions a fork goes through. Recorded so a test can see the params.
  if (message.method === "_x.ai/rewind/points" && typeof message.id === "number") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { rewind_points: JSON.parse(process.env.FAKE_ACP_REWIND_POINTS ?? "[]") },
    });
    return true;
  }
  if (message.method === "_x.ai/session/fork" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_FORK_REQUEST_FILE) {
      appendFileSync(process.env.FAKE_ACP_FORK_REQUEST_FILE, `${JSON.stringify(message.params)}\n`);
    }
    if (process.env.FAKE_ACP_FAIL_FORK === "1") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "Internal error", data: "/Users/someone/private" },
      });
      return true;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result:
        process.env.FAKE_ACP_MALFORMED_FORK === "1"
          ? {}
          : { newSessionId: "forked-session", chatMessagesCopied: 2 },
    });
    return true;
  }
  if (message.method === "authenticate" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_AUTH_REQUEST_FILE) {
      appendFileSync(process.env.FAKE_ACP_AUTH_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    }
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return true;
  }
  if (message.method === "session/new" && typeof message.id === "number") {
    recordSessionRequest(message);
    if (rejectInvalidMcpServers(message)) return true;
    const releaseFile = process.env.FAKE_ACP_NEW_RELEASE_FILE;
    if (releaseFile && !existsSync(releaseFile)) {
      const timer = setInterval(() => {
        if (!existsSync(releaseFile)) return;
        clearInterval(timer);
        write({ jsonrpc: "2.0", id: message.id, result: sessionPayload() });
      }, 10);
      return true;
    }
    write({ jsonrpc: "2.0", id: message.id, result: sessionPayload() });
    // Straight after the answer, as agents do: this lands before the bridge
    // has attached a handler for the session it has only just learned about.
    announceCommands("fake-session");
    if (process.env.FAKE_ACP_VENDOR_REQUEST_FILE) {
      write({
        jsonrpc: "2.0",
        id: 901,
        method: "x.ai/ask_user_question",
        params: { sessionId: "fake-session", question: "Continue?" },
      });
    }
    return true;
  }
  if (message.method === "session/list" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_LIST_ERROR) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: process.env.FAKE_ACP_LIST_ERROR },
      });
      return true;
    }
    const params = isObject(message.params) ? message.params : {};
    const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    const listedCwd =
      process.env.FAKE_ACP_LIST_MISSING_CWD === "1"
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
          sessions: [
            {
              sessionId: "looping-session",
              ...listedCwd,
              title: "Looping ACP work",
            },
          ],
          nextCursor: "same-cursor",
        },
      });
      return true;
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
      return true;
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
    return true;
  }
  if (message.method === "session/set_config_option" && typeof message.id === "number") {
    answerConfigRpc(message, () => answerSetConfigOption(message));
    return true;
  }
  if (message.method === "session/set_mode" && typeof message.id === "number") {
    answerConfigRpc(message, () => answerSetMode(message));
    return true;
  }
  if (message.method === "session/set_model" && typeof message.id === "number") {
    answerConfigRpc(message, () => answerSetModel(message));
    return true;
  }
  if (message.method === "session/load" && typeof message.id === "number") {
    recordSessionRequest(message);
    if (rejectInvalidMcpServers(message)) return true;
    if (process.env.FAKE_ACP_LIFECYCLE_FILE) {
      appendFileSync(process.env.FAKE_ACP_LIFECYCLE_FILE, `load:${process.pid}\n`);
    }
    if (process.env.FAKE_ACP_FAIL_LOAD_SESSION === "1") {
      const fail = (): void =>
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: process.env.FAKE_ACP_LOAD_ERROR ?? "fake agent cannot load that session",
          },
        });
      const failDelayMs = Number(process.env.FAKE_ACP_FAIL_LOAD_DELAY_MS ?? "0");
      if (Number.isSafeInteger(failDelayMs) && failDelayMs > 0) {
        setTimeout(fail, failDelayMs);
      } else {
        fail();
      }
      return true;
    }
    const params = isObject(message.params) ? message.params : {};
    const replaySessionId =
      typeof params.sessionId === "string" ? params.sessionId : "external-session";
    const replay = (update: JsonObject): void =>
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: replaySessionId, update },
      });
    announceCommands(replaySessionId);
    // Replay the exact prefix copied by the fork extension, from the shared
    // fake vendor store. A new child handles session/load.
    const turnsFile = process.env.FAKE_ACP_FORK_TURNS_FILE;
    const forksFile = process.env.FAKE_ACP_FORK_REQUEST_FILE;
    if (replaySessionId === "forked-session" && turnsFile && forksFile) {
      const fork = JSON.parse(readFileSync(forksFile, "utf8").trim().split("\n").at(-1)!);
      const turns = readFileSync(turnsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const copied =
        typeof fork.targetPromptIndex === "number"
          ? turns.slice(0, fork.targetPromptIndex + 1)
          : turns;
      copied.forEach((turn, index) => {
        replay({
          sessionUpdate: "user_message_chunk",
          messageId: `fork-user-${index}`,
          content: { type: "text", text: turn.prompt },
        });
        replay({
          sessionUpdate: "agent_message_chunk",
          messageId: `fork-answer-${index}`,
          content: { type: "text", text: turn.answer },
        });
      });
    }

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
    if (process.env.FAKE_ACP_REPLAY_ROW_REVISION === "1") {
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "replay-old-call",
        title: "Old call",
        status: "in_progress",
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "New response" },
      });
      replay({
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-old-call",
        status: "completed",
        rawOutput: "late result during replay",
      });
    }
    // The `SHELLCHANGE` turn as the vendor replays it: the command, with none
    // of the measurement the bridge took around it.
    if (process.env.FAKE_ACP_REPLAY_SHELL_CHANGE === "1") {
      replay({
        sessionUpdate: "user_message_chunk",
        messageId: "shell-change-user",
        content: { type: "text", text: "SHELLCHANGE" },
      });
      replay({
        sessionUpdate: "tool_call",
        toolCallId: "shell-change-1",
        title: "Rewrite the notes",
        kind: "execute",
        status: "completed",
        rawInput: { command: "./rewrite-notes.sh" },
      });
    }
    // An agent replaying its conversation can re-describe terminal state too,
    // so the load carries usage for a turn that already ended. The numbers
    // differ from every live scenario below so a test can tell which report the
    // panel ended up showing.
    if (process.env.FAKE_ACP_REPLAY_USAGE === "1") {
      replay({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: { totalTokens: 4_321, inputTokens: 4_000, outputTokens: 321 },
      });
    }
    if (process.env.FAKE_ACP_REPLAY_USAGE_TURNS === "2") {
      replay({
        sessionUpdate: "user_message_chunk",
        messageId: "usage-user-1",
        content: { type: "text", text: "First counted question" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        messageId: "usage-agent-1",
        content: { type: "text", text: "First counted answer" },
      });
      replay({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
      });
      replay({
        sessionUpdate: "user_message_chunk",
        messageId: "usage-user-2",
        content: { type: "text", text: "Second counted question" },
      });
      replay({
        sessionUpdate: "agent_message_chunk",
        messageId: "usage-agent-2",
        content: { type: "text", text: "Second counted answer" },
      });
      replay({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          cachedReadTokens: 30,
          cachedWriteTokens: 5,
        },
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
    // The same history without provider message ids, which is all the bridge
    // gets from an agent that does not stamp them. Message boundaries then have
    // to come from chunk-versus-whole rather than from part type.
    if (process.env.FAKE_ACP_REPLAY_NO_MESSAGE_IDS === "1") {
      replay({
        sessionUpdate: "user_message",
        // Array-form content: several blocks in one update.
        content: [
          { type: "text", text: "Earlier " },
          { type: "text", text: "question" },
        ],
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
    const answer = (): void =>
      write({
        jsonrpc: "2.0",
        id: message.id as number,
        result: sessionPayload(
          typeof params.sessionId === "string" ? params.sessionId : "fake-session",
        ),
      });
    // Holds `session/load` open so a second resume for the same ACP session
    // genuinely races the first rather than finding it already finished.
    const loadDelayMs = Number(process.env.FAKE_ACP_LOAD_DELAY_MS ?? "0");
    if (Number.isSafeInteger(loadDelayMs) && loadDelayMs > 0) setTimeout(answer, loadDelayMs);
    else answer();
    return true;
  }

  return false;
}

/**
 * Grok deserializes `mcpServers` strictly and fails the whole request on a
 * malformed entry, so the fake does too: `mcpServers` must be an array and
 * remote servers need `{ name, value }[]` headers.
 */
function invalidMcpServers(message: JsonObject): boolean {
  const params = isObject(message.params) ? message.params : {};
  if (params.mcpServers === undefined) return false;
  if (!Array.isArray(params.mcpServers)) return true;
  return params.mcpServers.some(
    (server) =>
      isObject(server) &&
      (server.type === "http" || server.type === "sse") &&
      !(
        Array.isArray(server.headers) &&
        server.headers.every(
          (header) =>
            isObject(header) && typeof header.name === "string" && typeof header.value === "string",
        )
      ),
  );
}

function rejectInvalidMcpServers(message: JsonObject): boolean {
  if (!invalidMcpServers(message)) return false;
  write({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32602,
      message: "Invalid params",
      data: "data did not match any variant of untagged enum McpServer",
    },
  });
  return true;
}

function recordSessionRequest(message: JsonObject): void {
  const path = process.env.FAKE_ACP_SESSION_REQUEST_FILE;
  if (!path) return;
  const params = isObject(message.params) ? message.params : {};
  appendFileSync(
    path,
    `${JSON.stringify({
      method: message.method,
      // Which child received it, so a test can tell sibling sessions apart.
      pid: process.pid,
      ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
      mcpServers: params.mcpServers,
      ...(isObject(params._meta) ? { meta: params._meta } : {}),
    })}\n`,
  );
}
