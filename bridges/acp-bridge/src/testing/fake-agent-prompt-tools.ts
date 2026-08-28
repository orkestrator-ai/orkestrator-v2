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
  writeIgnoredCursorTaskMarker,
  type JsonObject,
} from "./fake-agent-context.js";
import { handlePromptCursor } from "./fake-agent-prompt-cursor.js";

export function handlePromptTools(
  message: JsonObject,
  params: JsonObject,
  prompt: string,
): boolean {
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
    return true;
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
    return true;
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
    return true;
  }
  if (prompt.startsWith("FINISHCURSORSUBAGENTSTATUS")) {
    // Real Cursor keeps `isBackground: true` on the launch result and reports
    // completion through a later status field rather than flipping the flag.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "cursor-subagent-1",
          status: "completed",
          rawOutput: { durationMs: 84, isBackground: true, status: "completed" },
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
  }
  if (prompt.startsWith("FINISHCURSORTASKREQUEST")) {
    write({
      jsonrpc: "2.0",
      id: 903,
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        prompt: "Validate the implementation",
        subagentType: "explore",
        durationMs: 84,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("FINISHCURSORTASK")) {
    // Cursor first publishes the terminal tool result, then sends the
    // cursor/task extension frame carrying the same real child duration.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "cursor-subagent-1",
          status: "completed",
          rawOutput: { durationMs: 84, isBackground: true, status: "completed" },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        prompt: "Validate the implementation",
        subagentType: "explore",
        durationMs: 84,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("FAILCURSORTASKREQUEST")) {
    write({
      jsonrpc: "2.0",
      id: 903,
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        outcome: { outcome: "cancelled" },
        durationMs: 12,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("FAILCURSORTASK")) {
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        outcome: { outcome: "cancelled" },
        durationMs: 12,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  // The `cursor/task` frames below carry a `status`/`outcome` field. Real
  // Cursor (2026.08.11-e8db854) sends neither — its payload is toolCallId,
  // description, prompt, subagentType, model, agentId, durationMs — so these
  // model the version that starts reporting a state, not today's contract.
  // They exist to pin which values settle a child and which must not.
  if (prompt.startsWith("REJECTCURSORTASK")) {
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        status: "rejected",
        durationMs: 12,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  // Forward-compat, as above: a `cursor/task` that names a non-terminal state
  // is a progress report, so nothing may settle.
  if (prompt.startsWith("RUNNINGCURSORTASK")) {
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        status: "running",
        durationMs: 12,
      },
    });
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        outcome: { outcome: "in_progress" },
      },
    });
    writeIgnoredCursorTaskMarker();
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  // Same terminal frame, addressed to a different ACP session. A superseded
  // or unrelated conversation must not settle this one's child.
  if (prompt.startsWith("OTHERSESSIONCURSORTASK")) {
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "some-other-session",
        toolCallId: "cursor-subagent-1",
        description: "Validate the implementation",
        durationMs: 84,
      },
    });
    writeIgnoredCursorTaskMarker();
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  // Terminal frames for ids that are not live children: an ordinary finished
  // tool call, and an id this session has never seen.
  if (prompt.startsWith("UNKNOWNCURSORTASK")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "cursor-plain-tool-1",
          title: "Read file",
          kind: "read",
          status: "completed",
          rawInput: { _toolName: "read", path: "notes.md" },
        },
      },
    });
    for (const toolCallId of ["cursor-plain-tool-1", "cursor-never-seen-1"]) {
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          sessionId: "fake-session",
          toolCallId,
          description: "Validate the implementation",
          durationMs: 84,
        },
      });
    }
    writeIgnoredCursorTaskMarker();
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("FINISHEVICTEDCURSORTASK")) {
    for (const index of [0, 1]) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `cursor-task-late-filler-${index}`,
            title: `Late retained output ${index}`,
            status: "completed",
            rawOutput: `${index}:`.padEnd(600 * 1024, "z"),
          },
        },
      });
    }
    write({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: {
        sessionId: "fake-session",
        toolCallId: "cursor-subagent-1",
        durationMs: 84,
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
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
    return true;
  }
  if (prompt.startsWith("FAILGROKSUBAGENT_B")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "grok-child-b",
          status: "failed",
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("CANCELGROKSUBAGENT_A")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "grok-child-a",
          status: "cancelled",
        },
      },
    });
    // A mismatched spawn must still be uncorrelated and harmless.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "grok-mismatch",
          status: "completed",
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
  }
  if (prompt.startsWith("FAILCREDITSSUBAGENT")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "grok-subagent-1",
          status: "failed",
          error: `Session error: Internal error: ${JSON.stringify({
            message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
            http_status: 402,
            promptUsage: { inputTokens: 1_081_795, outputTokens: 4_052 },
          })}`,
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Both tools failed." },
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
          content: [
            { type: "content", content: { type: "text", text: "Searching for references..." } },
          ],
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
    return true;
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
          content: [
            {
              type: "diff",
              path: "src/stale.ts",
              oldText: "before",
              newText: "after",
            },
          ],
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
    return true;
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
    return true;
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
    return true;
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
          content: [
            {
              type: "diff",
              path: "huge.ts",
              oldText: "o".repeat(300 * 1024),
              newText: "n".repeat(300 * 1024),
              diff: `--- huge.ts\n+++ huge.ts\n@@\n-old\n+new\n${" context\n".repeat(220 * 1024)}`,
            },
          ],
          rawOutput: "y".repeat(600 * 1024),
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
  }
  if (prompt.startsWith("NOOPEDIT")) {
    // An edit tool that reports identical file states. There is no change to
    // place in a hunk, so there is nothing to render.
    const unchanged = Array.from(
      { length: 40 },
      (_, index) => `const line_${index} = ${index};`,
    ).join("\n");
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
          content: [
            {
              type: "diff",
              path: "src/noop.ts",
              oldText: unchanged,
              newText: unchanged,
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
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
    return true;
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
    return true;
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
          content: [
            {
              type: "diff",
              path: "oversized.ts",
              oldText: "o".repeat(300 * 1024),
              newText: "n".repeat(300 * 1024),
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
    return true;
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
          content: [
            {
              type: "diff",
              path: "src/large.ts",
              oldText: lines.join("\n"),
              newText: lines
                .map((line, index) => (index === 2500 ? `${line} // touched` : line))
                .join("\n"),
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("MULTIHUNK")) {
    const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const newLines = oldLines.map((line, index) =>
      index === 0 || index === 9 || index === 19 ? `${line} changed` : line,
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
          content: [
            {
              type: "diff",
              path: "src/boundaries.ts",
              oldText: oldLines.join("\n"),
              newText: newLines.join("\n"),
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  }
  if (prompt.startsWith("WIDEEDIT")) {
    // More changed lines than the Myers search is allowed to explore, but well
    // inside the inline byte limit, so the bounded fallback has to produce it.
    const oldLines = Array.from(
      { length: 4000 },
      (_, index) => `const before_${index} = ${index};`,
    );
    const newLines = Array.from(
      { length: 4000 },
      (_, index) => `const after_${index} = ${index * 2};`,
    );
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
          content: [
            {
              type: "diff",
              path: "src/wide.ts",
              oldText: ["const keep = true;", ...oldLines, "export {};"].join("\n"),
              newText: ["const keep = true;", ...newLines, "export {};"].join("\n"),
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
          content: [
            {
              type: "diff",
              path: "src/empty.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;",
              // Present but never filled in. It says nothing, so it must not
              // shadow oldText/newText.
              diff: "",
            },
          ],
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
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
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Counted again." },
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
    return true;
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
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Counted late." },
        },
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
    return true;
  }
  // v2 turn-complete usage rides idle `state_update.usage`; session/prompt
  // itself returns only a stop reason, the way Cursor's empty result looks.
  // The running frame already carries the cache-write count the idle one
  // omits, so a turn's partial reports have to merge rather than replace.
  if (prompt.startsWith("USAGE_STATE")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Counted over state_update." },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "state_update",
          state: "running",
          usage: { cachedWriteTokens: 20 },
        },
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
          },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return true;
  }
  // The same occupancy carrier spelled with `type` instead of
  // `sessionUpdate`. The bridge routes an update on either discriminator, so
  // the parser has to read either one too, or the frame reaches the usage
  // path and is dropped there as a generic `used`/`size` pair.
  if (prompt.startsWith("USAGE_TYPED")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: { type: "usage_update", used: 1_500, size: 30_000 },
      },
    });
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return true;
  }
  // Standard ACP carriers Cursor's CLI schema already defines but does not
  // emit. The bridge must still consume them so occupancy appears the moment
  // an agent starts sending `usage_update` / `PromptResponse.usage`.
  if (prompt.startsWith("USAGE_ACP")) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Counted over ACP." },
        },
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
    return true;
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
          {
            name: "context7",
            command: "npx",
            args: ["-y", "@upstash/context7-mcp", "--api-key", "secret"],
          },
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
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Counted." },
        },
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
    return true;
  }
  // Two same-kind reads launched together, only the second of which settles
  // while the turn keeps running. Cursor indexes a call when it settles, so
  // `FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS` withholds the first read's
  // metadata until this prompt is released. A live pass must enrich the
  // settled sibling from that partial index without letting the pending one
  // claim it.

  return handlePromptCursor(message, params, prompt);
}
