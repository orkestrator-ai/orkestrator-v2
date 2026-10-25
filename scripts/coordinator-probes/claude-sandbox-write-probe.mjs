// Whether a Claude coordinator turn can write the checkout through a command
// the read-only hook admits, read live through the pinned Agent SDK.
//
//   bun scripts/coordinator-probes/claude-sandbox-write-probe.mjs [command] [target]
//
// Runs one real model turn with the bridge's coordinator allowlist, its
// `PreToolUse` hook and `claudeReadOnlySandbox` (`dontAsk`, so nothing waits on
// a prompt). `PROBE_DENY_WRITE=0` leaves the checkout out of the sandbox's
// write denials, which is how the gap was first seen. The
// working directory is a fresh temporary checkout holding `in.txt`. The model
// is asked to run exactly the given command (default `uniq in.txt out.txt`,
// which needs no shell metacharacter and writes its second argument). Prints
// whether the hook admitted the command and whether `out.txt` exists after.
import { query } from "../../bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
  isReadOnlyShellCommand,
} from "../../bridges/claude-bridge/src/services/read-only-policy.ts";

const command = process.argv[2] ?? "uniq in.txt out.txt";
const target = process.argv[3] ?? "out.txt";
const directory = mkdtempSync(join(tmpdir(), "orkestrator-claude-sandbox-probe-"));
writeFileSync(join(directory, "in.txt"), "a\na\nb\n");

const policy = coordinatorProcessPolicy({});
const hook = createCoordinatorReadOnlyHook(policy, []);
const bashCalls = [];

try {
  const turn = query({
    prompt: `Run exactly this shell command with the Bash tool, once, and then reply DONE: ${command}`,
    options: {
      cwd: directory,
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: claudeReadOnlyAllowedTools({ policy }),
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      sandbox: claudeReadOnlySandbox(policy, {
        workspaces:
          process.env.PROBE_DENY_WRITE === "0" ? [] : [directory, realpathSync(directory)],
      }),
      maxTurns: 4,
      ...(process.env.CLAUDE_CLI_PATH
        ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH }
        : {}),
    },
  });
  let result = "";
  for await (const message of turn) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name === "Bash") {
          bashCalls.push({ command: block.input?.command ?? "", output: "" });
        }
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === "object" && block.type === "tool_result" && bashCalls.length > 0) {
          const content = Array.isArray(block.content)
            ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
            : String(block.content ?? "");
          bashCalls[bashCalls.length - 1].output = content.slice(0, 400);
        }
      }
    }
    if (message.type === "result") {
      result = message.subtype === "success" ? message.result : message.subtype;
    }
  }
  console.log(
    JSON.stringify(
      {
        command,
        hookVerdict: isReadOnlyShellCommand(command),
        bashCalls,
        targetWritten: existsSync(join(directory, target)),
        result: result.slice(0, 200),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
