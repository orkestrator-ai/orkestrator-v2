import { appendFileSync, existsSync } from "node:fs";
import {
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
import { handlePromptTools } from "./fake-agent-prompt-tools.js";

export function handlePromptStart(message: JsonObject): boolean {
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
    if (prompt.startsWith("Background subagent finished.")) {
      if (process.env.FAKE_ACP_BACKGROUND_RELAUNCH === "1") {
        state.backgroundRelaunches += 1;
        const index = state.backgroundRelaunches + 1;
        writeCursorBackgroundChild({
          toolCallId: `cursor-subagent-${index}`,
          agentId: `child-wait-${index}`,
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Validation passed. The child reported success.",
            },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
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
    if (startsRpcResourceExhaustedScenario) state.rpcResourceExhaustedScenario = true;
    if (state.rpcResourceExhaustedScenario
      && (startsRpcResourceExhaustedScenario || resumesResourceExhaustedScenario)) {
      const configuredAttempts = Number(process.env.FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS ?? "1");
      const failedAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 0
        ? configuredAttempts
        : 1;
      if (state.rpcResourceExhaustedAttempts < failedAttempts) {
        state.rpcResourceExhaustedAttempts += 1;
        writeResourceExhaustedPartial();
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "RetriableError: [resource_exhausted] Error" },
        });
        return true;
      }
      state.rpcResourceExhaustedScenario = false;
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
      return true;
    }
    const startsResourceExhaustedScenario = prompt.startsWith("RESOURCEEXHAUSTED:");
    if (startsResourceExhaustedScenario) state.flattenedResourceExhaustedScenario = true;
    if (state.flattenedResourceExhaustedScenario
      && (startsResourceExhaustedScenario || resumesResourceExhaustedScenario)) {
      const configuredAttempts = Number(
        process.env.FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS ?? "1",
      );
      const failedAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 0
        ? configuredAttempts
        : 1;
      if (state.flattenedResourceExhaustedAttempts < failedAttempts) {
        if (state.flattenedResourceExhaustedAttempts === 0) {
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
        state.flattenedResourceExhaustedAttempts += 1;
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
        return true;
      }
      state.flattenedResourceExhaustedScenario = false;
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
      return true;
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
      return true;
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
      return true;
    }
    if (prompt.startsWith("JSON_THEN_THOUGHT:")) {
      const text = prompt.slice("JSON_THEN_THOUGHT:".length).split("\n\nReturn only")[0];
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: '{"fromThought":true}' },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("THOUGHT_THEN_JSON:")) {
      const text = prompt.slice("THOUGHT_THEN_JSON:".length).split("\n\nReturn only")[0];
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "The schema requires JSON. Example {\"fromThought\":true}." },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
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
      return true;
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
      return true;
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
      return true;
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
              // `STATUS` adds a terminal status to the *launch* result. Not
              // observed on Grok today: it is the shape that would settle the
              // card the moment the spawn succeeded, and the child's real end
              // still only arrives through `subagent_finished`.
              rawOutput: prompt.startsWith("BACKGROUNDSUBAGENTSTATUS")
                ? { type: "Text", text: "Subagent started.", status: "completed" }
                : { type: "Text", text: "Subagent started." },
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
        return true;
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
      return true;
    }
    if (prompt.startsWith("CURSORBACKGROUNDNOID")) {
      writeCursorBackgroundChild({ toolCallId: "cursor-subagent-1" });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORBACKGROUNDCHILD")) {
      writeCursorBackgroundChild({
        toolCallId: "cursor-subagent-1",
        agentId: "child-wait-1",
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKWIPE")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-task-wipe",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "task" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-wipe",
          description: "Summarize two docs",
          prompt: "Read docs/upgrade-agents.md and docs/flaky-tests.md.",
          subagentType: "explore",
          model: "composer-2.5",
          agentId: "bc-wipe",
          durationMs: 1_240,
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cursor-task-wipe",
            status: "completed",
            rawInput: { _toolName: "task" },
            content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKFIRST")) {
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-first",
          description: "Explore the repo",
          prompt: "List the files that own native chat rendering.",
          subagentType: "explore",
          model: "composer-2.5",
          agentId: "bc-first",
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-task-first",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "task" },
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
            toolCallId: "cursor-task-first",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
            rawOutput: { durationMs: 42, isBackground: true },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKCAP")) {
      for (let index = 0; index < 512; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `cap-fill-${index}`,
              kind: "noop",
              status: "pending",
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-cap",
          description: "Overflow task",
          prompt: "This launch has no matching tool_call yet.",
          subagentType: "explore",
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKCHARGE")) {
      // 42 × 28 KiB completions: every third tool crosses the 64 KiB dirty
      // interval and resets it, so `cursor/task` below starts from a clean
      // counter against a transcript already sitting on the 1 MiB test floor.
      for (let index = 0; index < 42; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `charge-fill-${index}`,
              kind: "read",
              status: "completed",
              rawOutput: `${index}:`.padEnd(28 * 1024, "x"),
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-charge",
          description: "Charge the prompt",
          prompt: "P".repeat(64 * 1024),
          subagentType: "explore",
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKDURATIONS")) {
      // `durationMs` is the field that settles a sub-agent, so every shape a
      // vendor might use for "no duration yet" is exercised here alongside the
      // two that are genuinely reportable.
      const durationCases: Array<[string, unknown]> = [
        ["duration-zero", 0],
        ["duration-string", "1500"],
        ["duration-float", 12.7],
        ["duration-negative", -5],
        ["duration-null", null],
        ["duration-boolean", true],
        ["duration-empty", ""],
        ["duration-array", []],
        ["duration-text", "soon"],
      ];
      for (const [toolCallId, durationMs] of durationCases) {
        write({
          jsonrpc: "2.0",
          method: "cursor/task",
          params: {
            toolCallId,
            description: `Case ${toolCallId}`,
            subagentType: "explore",
            durationMs,
          },
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASKHELD")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-task-held",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "task" },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-held",
          description: "Held task",
          subagentType: "explore",
          // "Still running": must not be read as a completed 0ms turn.
          durationMs: null,
        },
      });
      whenReleased(() => {
        write({
          jsonrpc: "2.0",
          method: "cursor/task",
          params: { toolCallId: "cursor-task-held", durationMs: 2_400 },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      });
      return true;
    }
    if (prompt.startsWith("CURSORTASKTRIMMED")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-task-trimmed",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "task" },
          },
        },
      });
      // Enough siblings to push the launch part out of the message before its
      // metadata arrives.
      for (let index = 0; index < 512; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `trimmed-fill-${index}`,
              kind: "noop",
              status: "pending",
            },
          },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task-trimmed",
          description: "Trimmed task",
          subagentType: "explore",
          durationMs: 900,
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORPRESERVENONTASK")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "plain-tool-1",
            title: "Read File",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "/workspace/a.ts", description: "First pass", model: "m-1" },
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
            toolCallId: "plain-tool-1",
            status: "completed",
            rawInput: { path: "/workspace/b.ts" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTODOS")) {
      const todos = [
        { id: "1", content: "Set up project structure", status: "completed" },
        { id: "2", content: "Add authentication", status: "in_progress" },
        { id: "3", content: "Write unit tests", status: "pending" },
      ];
      if (prompt.startsWith("CURSORTODOSFIRST")) {
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: {
            toolCallId: "cursor-todos-first",
            todos,
            merge: false,
          },
        });
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "cursor-todos-first",
              title: "Update TODOs",
              kind: "other",
              status: "completed",
              rawInput: { _toolName: "updateTodos" },
            },
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("CURSORTODOSMERGE")) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "cursor-todos-merge-1",
              title: "Update TODOs",
              kind: "other",
              status: "completed",
              rawInput: { _toolName: "updateTodos" },
            },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: { toolCallId: "cursor-todos-merge-1", todos, merge: false },
        });
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "cursor-todos-merge-2",
              title: "Update TODOs",
              kind: "other",
              status: "completed",
              rawInput: { _toolName: "updateTodos" },
            },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: {
            toolCallId: "cursor-todos-merge-2",
            todos: [
              { id: "2", content: "Add authentication", status: "completed" },
              { id: "4", content: "Ship the feature", status: "in_progress" },
            ],
            merge: true,
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("CURSORTODOSRELOADMERGE")) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "cursor-todos-reload-merge",
              title: "Update TODOs",
              kind: "other",
              status: "completed",
              rawInput: { _toolName: "updateTodos" },
            },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: {
            toolCallId: "cursor-todos-reload-merge",
            todos: [
              { id: "2", content: "Add authentication", status: "completed" },
              { id: "4", content: "Ship the feature", status: "in_progress" },
            ],
            merge: true,
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("CURSORTODOSREPLACE")) {
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: { toolCallId: "cursor-todos-replace-1", todos, merge: false },
        });
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: {
            toolCallId: "cursor-todos-replace-2",
            todos: [{ id: "9", content: "Only this remains", status: "pending" }],
            merge: false,
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-todos-1",
            title: "Update TODOs",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "updateTodos" },
          },
        },
      });
      const todoParams = {
        toolCallId: "cursor-todos-1",
        todos,
        merge: false,
      };
      if (prompt.startsWith("CURSORTODOSREQUEST")) {
        write({
          jsonrpc: "2.0",
          id: 904,
          method: "cursor/update_todos",
          params: todoParams,
        });
      } else {
        write({
          jsonrpc: "2.0",
          method: "cursor/update_todos",
          params: todoParams,
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cursor-todos-1",
            status: "completed",
            rawInput: { _toolName: "updateTodos" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("GROKTODO") || prompt.startsWith("GROKPLAN")) {
      const grokTodos = [
        { id: "1", content: "Set up project structure", status: "completed" },
        { id: "2", content: "Add authentication", status: "in_progress" },
        { id: "3", content: "Write unit tests", status: "pending" },
      ];
      const grokPlanEntries = [
        { content: "Set up project structure", priority: "high", status: "completed" },
        { content: "Add authentication", priority: "medium", status: "in_progress" },
        { content: "Write unit tests", priority: "low", status: "pending" },
      ];
      const grokTodoMeta = {
        version: 1,
        name: "todo_write",
        kind: "other",
        namespace: "grok_build",
        label: "Todo Write",
        read_only: false,
      };
      const writeGrokTodoWrite = (toolCallId: string, todos: unknown[], merge?: boolean): void => {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: "Todo Write",
              status: "completed",
              rawInput: merge === undefined ? { todos } : { todos, merge },
              _meta: { "x.ai/tool": grokTodoMeta },
            },
          },
        });
      };
      // A real agent opens a tool call `pending` and settles it with a
      // status-only `tool_call_update` that repeats no arguments.
      const writeGrokTodoWritePending = (toolCallId: string, todos: unknown[]): void => {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: "Todo Write",
              status: "pending",
              rawInput: { todos },
              _meta: { "x.ai/tool": grokTodoMeta },
            },
          },
        });
      };
      const writeGrokToolCompleted = (toolCallId: string): void => {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "completed",
            },
          },
        });
      };
      const writeGrokPlan = (
        sessionUpdate: "plan" | "plan_update",
        entries: unknown[],
      ): void => {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "fake-session",
            update: sessionUpdate === "plan_update"
              ? { sessionUpdate, plan: { entries } }
              : { sessionUpdate, entries },
          },
        });
      };
      if (prompt.startsWith("GROKTODOINTERLEAVED")) {
        writeGrokTodoWritePending("grok-todo-write-1", grokTodos);
        writeGrokTodoWritePending("grok-todo-write-2", [
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ]);
        writeGrokToolCompleted("grok-todo-write-1");
        writeGrokToolCompleted("grok-todo-write-2");
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKTODOWRITEMERGE")) {
        writeGrokTodoWrite("grok-todo-write-1", grokTodos);
        writeGrokTodoWrite("grok-todo-write-2", [
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ]);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKTODOANDPLAN")) {
        writeGrokTodoWrite("grok-todo-write-1", grokTodos);
        writeGrokPlan("plan", [
          { content: "Ship the feature", priority: "high", status: "in_progress" },
          { content: "Write the docs", priority: "low", status: "pending" },
        ]);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKTODOWRITE")) {
        writeGrokTodoWrite("grok-todo-write-1", grokTodos);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKPLANTHENMERGE")) {
        writeGrokPlan("plan", grokPlanEntries);
        writeGrokTodoWrite("grok-todo-write-1", [
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ]);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKPLANTHENTODO")) {
        writeGrokPlan("plan", grokPlanEntries);
        writeGrokTodoWrite("grok-todo-write-1", grokTodos, false);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKPLANUPDATE")) {
        writeGrokPlan("plan_update", grokPlanEntries);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      if (prompt.startsWith("GROKPLANEMPTY")) {
        writeGrokPlan("plan", grokPlanEntries);
        writeGrokPlan("plan", []);
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return true;
      }
      writeGrokPlan("plan", grokPlanEntries);
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }
    if (prompt.startsWith("CURSORTASK")) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cursor-task-1",
            title: "Task: Subagent task",
            kind: "other",
            status: "in_progress",
            rawInput: { _toolName: "task" },
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
            toolCallId: "cursor-task-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
            rawOutput: { durationMs: 42, isBackground: true },
          },
        },
      });
      const taskParams = {
        toolCallId: "cursor-task-1",
        description: "Summarize two docs",
        prompt: "Read docs/upgrade-agents.md and docs/flaky-tests.md. Return one line each.",
        subagentType: "explore",
        model: "composer-2.5",
        agentId: "bc-abc123",
        durationMs: 1_240,
      };
      if (prompt.startsWith("CURSORTASKREQUEST")) {
        write({
          jsonrpc: "2.0",
          id: 903,
          method: "cursor/task",
          params: taskParams,
        });
      } else {
        write({
          jsonrpc: "2.0",
          method: "cursor/task",
          params: taskParams,
        });
      }
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return true;
    }

    return handlePromptTools(message, params, prompt);
  }
  return false;
}

function writeCursorBackgroundChild(options: {
  toolCallId: string;
  agentId?: string;
}): void {
  const description = "Run validation at HEAD";
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: options.toolCallId,
        title: `Task: ${description}`,
        kind: "other",
        status: "in_progress",
        rawInput: {
          _toolName: "task",
          run_in_background: true,
          description,
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
        toolCallId: options.toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Sub-agent launched." } }],
        rawOutput: {
          durationMs: 31,
          isBackground: true,
          ...(options.agentId ? { agentId: options.agentId } : {}),
        },
      },
    },
  });
  write({
    jsonrpc: "2.0",
    method: "cursor/task",
    params: {
      sessionId: "fake-session",
      toolCallId: options.toolCallId,
      description,
      prompt: "Run the validation suite at HEAD.",
      subagentType: "generalPurpose",
      durationMs: 31,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    },
  });
}

