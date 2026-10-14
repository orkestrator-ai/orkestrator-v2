import { describe, expect, test } from "bun:test";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";
import {
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
  OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT,
  openCodeIncompleteTurnRecoveryStrategy,
  openCodeIncompleteTurnRequestId,
} from "./opencode-turn-recovery.js";

describe("nativeAgentPlatformPolicy", () => {
  test("only OpenCode recovers incomplete turns and infers its composer selection", () => {
    for (const agent of BUILD_PIPELINE_AGENTS) {
      const policy = nativeAgentPlatformPolicy(agent);
      if (agent === "opencode") {
        expect(policy.incompleteTurnRecovery).toBe(openCodeIncompleteTurnRecoveryStrategy);
        expect(policy.infersComposerSelection).toBe(true);
      } else {
        expect(policy.incompleteTurnRecovery).toBeUndefined();
        expect(policy.infersComposerSelection).toBeUndefined();
      }
    }
  });
});

describe("openCodeIncompleteTurnRecoveryStrategy", () => {
  test("keeps OpenCode's history window, prompt and durable request id", () => {
    const strategy = openCodeIncompleteTurnRecoveryStrategy;
    expect(strategy.historyLimit).toBe(OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT);
    const recovery = strategy.inspect(
      [
        { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "go" }] },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "step-finish", reason: "unknown" },
          ],
        },
      ],
      { historyComplete: true, now: Date.now() },
    );
    expect(recovery).toMatchObject({ action: "continue", assistantMessageId: "assistant-1" });
    expect(strategy.continuationPrompt(recovery!)).toBe(OPENCODE_INCOMPLETE_TURN_CONTINUATION);
    expect(strategy.requestId(recovery!)).toBe(openCodeIncompleteTurnRequestId("assistant-1"));
  });
});
