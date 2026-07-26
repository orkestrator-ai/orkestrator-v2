import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentInfoButton } from "./AgentInfoButton";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";

afterEach(() => {
  cleanup();
  useClaudeStore.setState({
    contextUsage: new Map(),
    selectedModel: new Map(),
  });
});

describe("AgentInfoButton", () => {
  test("surfaces provider-reported context, tokens, and cost for the active tab", () => {
    const sessionKey = createClaudeSessionKey("env-1", "tab-1");
    useClaudeStore.setState({
      contextUsage: new Map([[
        sessionKey,
        {
          usedTokens: 25_000,
          totalTokens: 100_000,
          percentUsed: 25,
          inputTokens: 20_000,
          outputTokens: 5_000,
          sessionTokens: 30_000,
          costUsd: 1.25,
          estimated: false,
          source: "claude",
          updatedAt: "2026-07-26T12:00:00.000Z",
        },
      ]]),
      selectedModel: new Map([[sessionKey, "claude-opus"]]),
    });

    render(
      <AgentInfoButton
        activeTab={{
          id: "tab-1",
          type: "claude-native",
          claudeNativeData: { environmentId: "env-1", sessionId: "session-1" },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
    expect(screen.getByRole("dialog", { name: "Agent information" })).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("Provider reported")).toBeTruthy();
  });
});
