#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const markerFile = process.env.CLAUDE_SDK_BACKGROUND_MARKER_FILE;
if (!markerFile) process.exit(2);

const taskId = "contract-background-task";
const toolUseId = "contract-background-tool";
let launched = false;
let childFinished = false;
let stdinEnded = false;
const lines = createInterface({ input: process.stdin });

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.type === "control_request") {
    const request = message.request as Record<string, unknown>;
    if (request?.subtype === "initialize") {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            commands: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
    return;
  }

  if (message.type !== "user" || launched) return;
  launched = true;
  const sessionId = typeof message.session_id === "string"
    ? message.session_id
    : "contract-background-session";
  const child = spawn(process.execPath, [
    "-e",
    `await Bun.sleep(150); await Bun.write(process.env.CLAUDE_SDK_BACKGROUND_MARKER_FILE, "completed")`,
  ], {
    env: { ...process.env, CLAUDE_SDK_BACKGROUND_MARKER_FILE: markerFile },
    stdio: "ignore",
  });

  process.stdin.once("end", () => {
    stdinEnded = true;
    if (!childFinished) {
      child.kill("SIGTERM");
      void writeFile(markerFile, "killed");
    }
  });

  write({
    type: "assistant",
    message: {
      id: "contract-background-assistant",
      role: "assistant",
      model: "claude-contract",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "contract delay", run_in_background: true },
      }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000010",
  });
  write({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `Command running in background with ID: ${taskId}`,
      }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000011",
    tool_use_result: { backgroundTaskId: taskId },
  });
  write({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: taskId, task_type: "bash", description: "Contract delay" }],
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000012",
  });
  write({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: "background task launched",
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000013",
  });

  child.once("exit", async (code) => {
    childFinished = true;
    if (stdinEnded || code !== 0) return;
    write({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: toolUseId,
      status: "completed",
      summary: "Contract task completed",
      session_id: sessionId,
      uuid: "00000000-0000-4000-8000-000000000014",
    });
    write({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      session_id: sessionId,
      uuid: "00000000-0000-4000-8000-000000000015",
    });
    lines.close();
  });
});
