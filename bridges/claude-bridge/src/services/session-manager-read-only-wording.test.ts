import { describe, expect, test } from "bun:test";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

import { coordinatorProcessPolicy } from "./read-only-policy.js";
import { createSession, nextQueryCall, sendPrompt, track } from "./session-manager-test-harness.js";

/**
 * The read-only hook a launched CLI carries words its refusals for the
 * session's role: a graph reviewer or pipeline review (a `readOnly` turn on
 * an ordinary bridge) is not told it is a coordinator.
 */
async function refusalOf(hooks: unknown, toolName: string, toolInput: unknown = {}) {
  const preToolUse = (hooks as { PreToolUse?: Array<{ hooks: HookCallback[] }> }).PreToolUse;
  const hook = preToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("the turn registered no read-only hook");
  const output = (await hook(
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput } as never,
    undefined as never,
    { signal: new AbortController().signal } as never,
  )) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  return output.hookSpecificOutput?.permissionDecisionReason;
}

async function launchedHooks(sessionName: string): Promise<unknown> {
  const session = createSession(sessionName);
  track(session.id);
  const prompt = sendPrompt(session.id, "Review this", { readOnly: true });
  const call = await nextQueryCall();
  const hooks = call.options.hooks;
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await prompt;
  return hooks;
}

describe("read-only refusal wording", () => {
  test("a read-only review on an ordinary bridge is refused in neutral words", async () => {
    const hooks = await launchedHooks("read-only-wording-review");
    expect(await refusalOf(hooks, "Write")).toBe(
      "This session is read-only, so Write is not available.",
    );
    expect(await refusalOf(hooks, "Bash", { command: "touch notes.txt" })).toBe(
      "This session is read-only, so `touch` is not available here. It may read the checkout but not change it.",
    );
  });

  test("a coordinator keeps the coordinator wording", async () => {
    const previous = process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
    process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
    try {
      const session = createSession("read-only-wording-coordinator");
      track(session.id);
      session.executionPolicy = coordinatorProcessPolicy({});
      const prompt = sendPrompt(session.id, "Look around", {});
      const call = await nextQueryCall();
      const hooks = call.options.hooks;
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
      expect(await refusalOf(hooks, "Write")).toBe(
        "Coordinator is read-only, so Write is not available. Delegate file changes to a worker environment.",
      );
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
      else process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = previous;
    }
  });
});
