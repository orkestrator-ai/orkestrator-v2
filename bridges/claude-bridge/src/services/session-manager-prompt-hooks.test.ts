import { describe, expect, test } from "bun:test";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  BOUNDARY_HOOK_FAILURE_REASON,
  recordingHookDenials,
} from "./session-manager-prompt-hooks.js";

const preToolUse = {
  hook_event_name: "PreToolUse",
  session_id: "s",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "rm -rf ." },
  tool_use_id: "toolu_1",
} as unknown as HookInput;

const options = { signal: new AbortController().signal };

describe("recordingHookDenials", () => {
  test("a boundary hook that throws denies the call instead of letting it run", async () => {
    const throwing: HookCallback = async () => {
      throw new Error("policy table unreadable: /secret/path");
    };
    const output = await recordingHookDenials(throwing, "conversation")(
      preToolUse,
      "toolu_1",
      options,
    );
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: BOUNDARY_HOOK_FAILURE_REASON,
      },
    });
    // The reason the model sees never carries the error text or the input.
    expect(JSON.stringify(output)).not.toContain("secret");
    expect(JSON.stringify(output)).not.toContain("rm -rf");
  });

  test("a hook that answers is passed through unchanged", async () => {
    const allow: HookCallback = async () => ({ continue: true });
    expect(
      await recordingHookDenials(allow, "conversation")(preToolUse, "toolu_1", options),
    ).toEqual({ continue: true });
  });

  test("a failure outside PreToolUse is not turned into a tool decision", async () => {
    const throwing: HookCallback = async () => {
      throw new Error("boom");
    };
    const postToolUse = { ...preToolUse, hook_event_name: "PostToolUse" } as HookInput;
    await expect(
      recordingHookDenials(throwing, "conversation")(postToolUse, "toolu_1", options),
    ).rejects.toThrow("boom");
  });
});
