#!/usr/bin/env bun
import { createInterface } from "node:readline";

// Answers `initialize`, starts the turn, then dies by the signal the test
// names, the way the OOM killer or a user's `pkill` ends a real CLI mid-turn.
const signal = process.env.CLAUDE_SDK_CONTRACT_SIGNAL;
if (signal !== "SIGKILL" && signal !== "SIGTERM") process.exit(2);

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
  if (message.type === "user") {
    write({
      type: "system",
      subtype: "init",
      session_id: "contract-session",
      tools: [],
      mcp_servers: [],
      model: "contract-model",
      permissionMode: "default",
      slash_commands: [],
      apiKeySource: "none",
      cwd: process.cwd(),
      uuid: "00000000-0000-4000-8000-0000000000aa",
    });
    process.kill(process.pid, signal);
  }
});
