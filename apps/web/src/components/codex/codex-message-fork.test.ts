import { describe, expect, test } from "bun:test";
import type { MessageForkPlanEntry } from "@/components/chat/message-fork";
import { CodexForkError } from "@/lib/codex-client";
import { requireCodexForkPlanEntry } from "./codex-message-fork";

const promptPlan: MessageForkPlanEntry = {
  kind: "prompt",
  boundary: { type: "session-start" },
  draftText: "Edit this prompt",
  droppedAttachmentCount: 0,
};

describe("requireCodexForkPlanEntry", () => {
  test("returns the current plan entry when the action still matches", () => {
    const plan = new Map([["prompt-1", promptPlan]]);

    expect(requireCodexForkPlanEntry(plan, "prompt-1", "prompt")).toBe(promptPlan);
  });

  test.each([
    ["a message removed by a transcript refresh", new Map<string, MessageForkPlanEntry>(), "prompt"],
    ["an action whose kind changed", new Map([["prompt-1", promptPlan]]), "response"],
  ] as const)("rejects %s with actionable stale-message copy", (_label, plan, kind) => {
    expect(() => requireCodexForkPlanEntry(plan, "prompt-1", kind)).toThrow(
      "The selected message is no longer in this session",
    );

    try {
      requireCodexForkPlanEntry(plan, "prompt-1", kind);
      throw new Error("Expected a stale fork plan to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexForkError);
      expect((error as CodexForkError).status).toBe(404);
    }
  });
});
