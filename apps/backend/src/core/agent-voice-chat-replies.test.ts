import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_VOICE_CHAT_SYSTEM_PROMPT } from "@orkestrator/protocol/agent-voice-chat";
import {
  agentVoiceChatRepliesEnabled,
  createAgentVoiceChatReplier,
  generateClaudeAgentVoiceChatReply,
  generateCodexAgentVoiceChatReply,
} from "./agent-voice-chat-replies.js";
import type { CommandContext } from "./commands-context.js";
import type { SessionTitleRunInput } from "./session-title-runners.js";

/** The one-shot reply runs, with a scripted process in place of the CLI. */

type Call = { executable: string; args: string[]; cwd?: string; stdin?: string };

function fakeRun(output: (call: Call) => Promise<string> | string) {
  const calls: Call[] = [];
  const run = (async (
    executable: string,
    args: string[],
    options: { cwd?: string; stdin?: string } = {},
  ) => {
    const call = { executable, args, cwd: options.cwd, stdin: options.stdin };
    calls.push(call);
    return { stdout: await output(call), stderr: "" };
  }) as unknown as SessionTitleRunInput["run"];
  return { run, calls };
}

describe("agent voice chat reply runs", () => {
  test("Claude runs isolated, with the voice prompt and no tools", async () => {
    const { run, calls } = fakeRun(() => "**The build** is green.\n");
    const reply = await generateClaudeAgentVoiceChatReply({
      executable: "claude",
      env: {},
      source: "<message>\nIs the build green?\n</message>",
      run,
    });
    expect(reply).toBe("The build is green.");
    const call = calls[0]!;
    expect(call.stdin).toContain("Is the build green?");
    expect(call.args).toEqual(
      expect.arrayContaining(["--print", "--safe-mode", "--no-session-persistence"]),
    );
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args[call.args.indexOf("--system-prompt") + 1]).toBe(
      AGENT_VOICE_CHAT_SYSTEM_PROMPT,
    );
    // An empty temporary directory, removed afterwards.
    expect(path.basename(call.cwd!)).toStartWith("orkestrator-voice-chat-");
    expect(existsSync(call.cwd!)).toBe(false);
  });

  test("Codex writes its last message to a file, without an output schema", async () => {
    const { run, calls } = fakeRun(async (call) => {
      const output = call.args[call.args.indexOf("--output-last-message") + 1]!;
      await writeFile(output, "Two agents are working.");
      return "ignored progress";
    });
    const reply = await generateCodexAgentVoiceChatReply({
      executable: "codex",
      env: {},
      source: "<message>\nWho is working?\n</message>",
      run,
    });
    expect(reply).toBe("Two agents are working.");
    const args = calls[0]!.args;
    expect(args).not.toContain("--output-schema");
    expect(args).toEqual(
      expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--sandbox"]),
    );
  });

  test("an empty reply is a failure, not silence", async () => {
    const { run } = fakeRun(() => "  \n");
    await expect(
      generateClaudeAgentVoiceChatReply({ executable: "claude", env: {}, source: "x", run }),
    ).rejects.toThrow("empty");
  });
});

describe("the backend's agent voice chat replier", () => {
  test("validates its prompt before anything else", async () => {
    const replier = createAgentVoiceChatReplier({} as CommandContext, {});
    await expect(replier.reply({ prompt: " " })).rejects.toThrow("prompt is required");
    await expect(replier.reply({ prompt: "x".repeat(70 * 1024) })).rejects.toThrow("too long");
    await replier.shutdown();
  });

  test("never spends a login under the test runner", async () => {
    expect(agentVoiceChatRepliesEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(agentVoiceChatRepliesEnabled({ ORKESTRATOR_AGENT_VOICE_CHAT_REPLIES: "0" })).toBe(false);
    expect(agentVoiceChatRepliesEnabled({})).toBe(true);
    const replier = createAgentVoiceChatReplier({} as CommandContext, { NODE_ENV: "test" });
    await expect(replier.reply({ prompt: "hi" })).rejects.toThrow(
      "No signed-in Claude or Codex login",
    );
    await replier.shutdown();
  });
});
