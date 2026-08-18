import { appendFileSync, existsSync } from "node:fs";
import {
  cursorConfig,
  grokConfig,
  holdTurnFile,
  isObject,
  provider,
  sessionPayload,
  write,
  type JsonObject,
} from "./fake-agent-context.js";

export function handleSessionMessage(message: JsonObject): boolean {
  if (message.method === "initialize" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_HANG_INITIALIZE === "1") return true;
    if (process.env.FAKE_ACP_MALFORMED_INITIALIZE === "1") {
      process.stdout.write("{not-json}\n");
      return true;
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
    return true;
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
    return true;
  }
  if (message.method === "session/list" && typeof message.id === "number") {
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
    const failOnceFile = process.env.FAKE_ACP_FAIL_CONFIG_ONCE_FILE;
    if (failOnceFile && !existsSync(failOnceFile)) {
      appendFileSync(failOnceFile, "failed\n");
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "fake configuration failure" },
      });
      return true;
    }
    const params = isObject(message.params) ? message.params : {};
    const configId = typeof params.configId === "string" ? params.configId : "";
    const option = cursorConfig.configOptions.find((entry) => entry.id === configId);
    if (option) option.currentValue = params.value as never;
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { configOptions: cursorConfig.configOptions },
    });
    return true;
  }
  if (message.method === "session/set_mode" && typeof message.id === "number") {
    const params = isObject(message.params) ? message.params : {};
    const modeId = typeof params.modeId === "string" ? params.modeId : "agent";
    if (provider === "grok") grokConfig.modes.currentModeId = modeId;
    else cursorConfig.modes.currentModeId = modeId;
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return true;
  }
  if (message.method === "session/set_model" && typeof message.id === "number") {
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
    return true;
  }
  if (message.method === "session/load" && typeof message.id === "number") {
    if (process.env.FAKE_ACP_LIFECYCLE_FILE) {
      appendFileSync(process.env.FAKE_ACP_LIFECYCLE_FILE, `load:${process.pid}\n`);
    }
    if (process.env.FAKE_ACP_FAIL_LOAD_SESSION === "1") {
      const fail = (): void =>
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "fake agent cannot load that session" },
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
        title: 'grep --include="*.json" "scripts"',
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
          : [
              {
                id: "replay-read-1",
                title: "Read first.json (1 - 40)",
                path: "/workspace/first.json",
                content: "first contents",
              },
            ]),
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
        title: 'grep --include="*.json" "scripts"',
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
          title: 'grep --include="*.json" "scripts"',
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
          title: 'grep --include="*.ts" "strict"',
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
        {
          id: "replay-huge-b",
          title: "Read huge-b.json",
          path: "/workspace/huge-b.json",
          output: "huge-b",
        },
        {
          id: "replay-huge-a",
          title: "Read huge-a.json",
          path: "/workspace/huge-a.json",
          output: "huge-a",
        },
        {
          id: "replay-huge-c",
          title: "Read huge-c.json",
          path: "/workspace/huge-c.json",
          output: "huge-c",
        },
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
