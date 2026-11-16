import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeAgentTurnPhase } from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";
import {
  AgentNativeTab,
  defaultProjection,
  fixtureState,
  identity,
  installAgentNativeTabFixture,
  publishProjection,
  sessionProjectionMock,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

const launch: NativeMessage = {
  id: "orphan-launch",
  role: "assistant",
  content: "",
  createdAt: "2026-08-16T10:00:00.000Z",
  parts: [
    {
      type: "tool-invocation",
      content: "Agent",
      toolName: "Agent",
      toolUseId: "orphan",
      toolState: "pending",
      toolArgs: { description: "Review the bridge" },
    },
  ],
};

async function projection(phase: NativeAgentTurnPhase, messages = [launch], startedAt?: number) {
  return {
    ...(await defaultProjection({ agent: "claude", environmentId: "env-1" })),
    turn: { phase, startedAt },
    messages,
  };
}

describe("Claude launch lifecycle in the controller", () => {
  test.each(["idle", "error", "running", "blocked", "cancelling", "recovering"] as const)(
    "uses the authoritative %s phase to settle only stopped turns",
    async (phase) => {
      fixtureState.renderVirtualizedMessages = true;
      sessionProjectionMock.mockResolvedValue(await projection(phase));
      renderInAppCommandScope(
        <AgentNativeTab tabId="ended-phase" data={identity("claude")} isActive />,
      );
      const terminal = phase === "idle" || phase === "error";
      expect(await screen.findByText(terminal ? "Ended" : "Active")).toBeTruthy();
    },
  );

  test("announces ended, stays ended during unrelated work, and rehydrates after remount", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "ended-transition";
    const sessionKey = createSessionKey("env-1", tabId);
    sessionProjectionMock.mockResolvedValue(await projection("running"));
    const view = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    await screen.findByRole("status", { name: "1 sub-agent working: Review the bridge." });

    publishProjection(sessionKey, await projection("error"));
    expect(await screen.findByRole("status", { name: "Review the bridge ended." })).toBeTruthy();
    expect(await screen.findByText("Ended")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Review the bridge finished." }) === null).toBe(
      true,
    );

    const later: NativeMessage = {
      id: "next-user",
      createdAt: "2026-08-16T11:00:00.000Z",
      role: "user",
      content: "Continue",
      parts: [{ type: "text", content: "Continue" }],
    };
    publishProjection(sessionKey, {
      ...(await projection("running", [launch, later])),
      backgroundTasks: [{ id: "unrelated", status: "running", kind: "shell" }],
    });
    expect(await screen.findByText("Ended")).toBeTruthy();
    expect(screen.queryByText("Active") === null).toBe(true);
    view.unmount();
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    expect(await screen.findByText("Ended")).toBeTruthy();
  });

  test("passes the turn start through when the launch predates a paged turn", async () => {
    fixtureState.renderVirtualizedMessages = true;
    sessionProjectionMock.mockResolvedValue(
      await projection("running", [launch], Date.parse("2026-08-16T11:00:00.000Z")),
    );
    renderInAppCommandScope(
      <AgentNativeTab tabId="ended-paged" data={identity("claude")} isActive />,
    );
    expect(await screen.findByText("Ended")).toBeTruthy();
  });
});
