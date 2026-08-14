import { beforeEach, describe, expect, test } from "bun:test";
import type { AcpSessionSnapshot } from "@/lib/acp-client";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
import {
  transcriptHasUserMessage,
  useAcpPendingPromptStore,
} from "./acpPendingPromptStore";

function snapshot(roles: Array<"user" | "assistant">): AcpSessionSnapshot {
  return {
    id: "session-1",
    provider: "cursor",
    status: "idle",
    baseIndex: 0,
    revision: 1,
    composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
    messages: roles.map((role, index) => ({
      id: `message-${index}`,
      role,
      content: "text",
      parts: [{ type: "text" as const, content: "text" }],
      createdAt: "2026-08-14T00:00:00.000Z",
    })),
  };
}

beforeEach(() => {
  useAcpPendingPromptStore.setState({ pending: new Map() });
});

describe("transcriptHasUserMessage", () => {
  test("is false for a session that has not been read yet", () => {
    expect(transcriptHasUserMessage(null)).toBe(false);
  });

  test("is false for an empty transcript", () => {
    expect(transcriptHasUserMessage(snapshot([]))).toBe(false);
  });

  test("is true once the dispatched prompt is echoed", () => {
    expect(transcriptHasUserMessage(snapshot(["user"]))).toBe(true);
  });

  // Only the user's own row proves the prompt landed. Treating any growth in
  // the transcript as the echo would retire the local copy against assistant
  // output, leaving the prompt that caused it missing from the view.
  test("is false when only assistant output has arrived", () => {
    expect(transcriptHasUserMessage(snapshot(["assistant"]))).toBe(false);
  });

  test("survives history eviction that leaves a later user message", () => {
    const evicted = { ...snapshot(["assistant", "user"]), baseIndex: 12 };
    expect(transcriptHasUserMessage(evicted)).toBe(true);
  });
});

describe("useAcpPendingPromptStore", () => {
  const prompt = { text: "Implement the billing export", createdAt: "2026-08-14T00:00:00.000Z", isNaming: true };

  test("keeps prompts isolated per session key", () => {
    const { setPendingPrompt } = useAcpPendingPromptStore.getState();
    setPendingPrompt("env-1:tab-a", prompt);
    setPendingPrompt("env-1:tab-b", { ...prompt, text: "Other work" });

    const { pending } = useAcpPendingPromptStore.getState();
    expect(pending.get("env-1:tab-a")?.text).toBe("Implement the billing export");
    expect(pending.get("env-1:tab-b")?.text).toBe("Other work");
  });

  test("clears the naming flag without losing the prompt", () => {
    const { setPendingPrompt, setPendingPromptNaming } = useAcpPendingPromptStore.getState();
    setPendingPrompt("env-1:tab-a", prompt);
    setPendingPromptNaming("env-1:tab-a", false);

    expect(useAcpPendingPromptStore.getState().pending.get("env-1:tab-a")).toEqual({
      ...prompt,
      isNaming: false,
    });
  });

  // Every submit clears the flag in its `finally`, including the far more
  // common path that never renames anything. Those calls must not allocate a
  // new map and wake every subscribed tab.
  test("does not touch state when the naming flag is already correct", () => {
    const { setPendingPrompt, setPendingPromptNaming } = useAcpPendingPromptStore.getState();
    setPendingPrompt("env-1:tab-a", { ...prompt, isNaming: false });
    const before = useAcpPendingPromptStore.getState().pending;

    setPendingPromptNaming("env-1:tab-a", false);
    setPendingPromptNaming("env-1:unknown-tab", false);

    expect(useAcpPendingPromptStore.getState().pending).toBe(before);
  });

  test("clearing an unknown session key is a no-op", () => {
    const before = useAcpPendingPromptStore.getState().pending;
    useAcpPendingPromptStore.getState().clearPendingPrompt("env-1:unknown-tab");
    expect(useAcpPendingPromptStore.getState().pending).toBe(before);
  });

  test("clearing removes only the addressed session", () => {
    const { setPendingPrompt, clearPendingPrompt } = useAcpPendingPromptStore.getState();
    setPendingPrompt("env-1:tab-a", prompt);
    setPendingPrompt("env-1:tab-b", prompt);
    clearPendingPrompt("env-1:tab-a");

    const { pending } = useAcpPendingPromptStore.getState();
    expect(pending.has("env-1:tab-a")).toBe(false);
    expect(pending.has("env-1:tab-b")).toBe(true);
  });
});
