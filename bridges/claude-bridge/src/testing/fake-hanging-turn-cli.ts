#!/usr/bin/env bun
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// A Claude CLI whose turns never finish: it accepts the prompt, records it in
// the rollout the SDK reads back after a bridge restart, and then waits. Only
// a killed bridge (stdin EOF) or a kill ends it. Used by the backend's Multi
// Review restart test, which needs a turn that is still running when the
// bridge dies.

const argv = process.argv.slice(2);
if (!argv.includes("stream-json")) {
  // A one-shot print-mode call (session title generation): nothing to keep.
  process.stdout.write("Restart test\n");
  process.exit(0);
}
const flag = (name: string) => {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const cwd = realpathSync(process.cwd());
const projectDir = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.type === "control_request") {
    const request = message.request as Record<string, unknown> | undefined;
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response:
          request?.subtype === "initialize"
            ? {
                commands: [],
                output_style: "default",
                available_output_styles: [],
                models: [],
                account: {},
              }
            : {},
      },
    });
    return;
  }
  if (message.type !== "user") return;
  writeFileSync(join(homedir(), "claude-test-turn.pid"), String(process.pid));
  mkdirSync(projectDir, { recursive: true });
  appendFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      sessionId,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
      message: { role: "user", content: "Multi Review restart test prompt" },
    })}\n`,
  );
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: "fake-model",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    cwd,
    uuid: crypto.randomUUID(),
  });
  // No result: the turn is still running when the bridge dies.
});
