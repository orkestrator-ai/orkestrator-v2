/**
 * Contract suite for the single pane-level native agent tab.
 *
 * `adapter.test.ts` only checks that every platform *has* a `loadController`.
 * This file actually invokes all five of them, because the wiring they perform
 * — which module is imported, and what identity shape the controller receives
 * — is not observable from the registry alone.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import * as realClaudeChatTab from "@/components/claude/ClaudeChatTab";
import * as realCodexChatTab from "@/components/codex/CodexChatTab";
import * as realOpenCode from "@/components/opencode";
import * as realAcp from "@/components/acp";

// Snapshot before installing the stubs so the real modules are restored for
// any suite that runs after this file in the same module registry.
const realClaudeChatTabSnapshot = { ...realClaudeChatTab };
const realCodexChatTabSnapshot = { ...realCodexChatTab };
const realOpenCodeSnapshot = { ...realOpenCode };
const realAcpSnapshot = { ...realAcp };

/** Renders the identity it was handed so the projection can be asserted. */
function stubController(testId: string) {
  return ({ tabId, data }: { tabId: string; data: Record<string, unknown> }) => (
    <div data-testid={testId} data-tab-id={tabId} data-payload={JSON.stringify(data)} />
  );
}

mock.module("@/components/claude/ClaudeChatTab", () => ({
  ClaudeChatTab: stubController("claude-controller"),
}));
mock.module("@/components/codex/CodexChatTab", () => ({
  CodexChatTab: stubController("codex-controller"),
}));
mock.module("@/components/opencode", () => ({
  OpenCodeChatTab: stubController("opencode-controller"),
}));
mock.module("@/components/acp", () => ({
  AcpChatTab: stubController("acp-controller"),
}));

const { NativeAgentTab } = await import("./NativeAgentTab");

afterEach(cleanup);

afterAll(() => {
  mock.module("@/components/claude/ClaudeChatTab", () => realClaudeChatTabSnapshot);
  mock.module("@/components/codex/CodexChatTab", () => realCodexChatTabSnapshot);
  mock.module("@/components/opencode", () => realOpenCodeSnapshot);
  mock.module("@/components/acp", () => realAcpSnapshot);
});

const controllerTestIds: Record<string, string> = {
  claude: "claude-controller",
  codex: "codex-controller",
  opencode: "opencode-controller",
  cursor: "acp-controller",
  grok: "acp-controller",
};

function identity(platform: NativeAgentTabData["platform"]): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: `${platform}-session`,
    isLocal: false,
  };
}

describe("NativeAgentTab", () => {
  for (const platform of AGENT_PLATFORMS) {
    test(`loads the ${platform} controller and hands it a legacy identity`, async () => {
      render(
        <NativeAgentTab
          tabId={`tab-${platform}`}
          data={identity(platform)}
          isActive
        />,
      );

      const controller = await screen.findByTestId(controllerTestIds[platform]!);
      expect(controller.dataset.tabId).toBe(`tab-${platform}`);

      const payload = JSON.parse(controller.dataset.payload!);
      expect(payload).toMatchObject({
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: `${platform}-session`,
        isLocal: false,
      });
      // The controllers spread this straight back into their own pane record
      // when forking; `platform` must not travel with it.
      expect(payload).not.toHaveProperty("platform");
      if (platform === "cursor" || platform === "grok") {
        expect(payload.provider).toBe(platform);
      } else {
        expect(payload).not.toHaveProperty("provider");
      }
    });
  }

  test("renders a mismatch notice instead of throwing on an unknown platform", async () => {
    // A persisted record can name a platform this build does not ship. Failing
    // here would throw out of the pane and take its sibling tabs down with it.
    render(
      <NativeAgentTab
        tabId="tab-unknown"
        data={{
          platform: "gemini" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
    expect(screen.queryByTestId("claude-controller")).toBeNull();
  });

  test("does not resolve a platform through the prototype chain", async () => {
    render(
      <NativeAgentTab
        tabId="tab-proto"
        data={{
          platform: "constructor" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
  });

  test("swaps controllers when a tab's platform changes", async () => {
    const { rerender } = render(
      <NativeAgentTab tabId="tab-swap" data={identity("codex")} isActive />,
    );
    expect(await screen.findByTestId("codex-controller")).toBeTruthy();

    rerender(
      <NativeAgentTab tabId="tab-swap" data={identity("opencode")} isActive />,
    );

    expect(await screen.findByTestId("opencode-controller")).toBeTruthy();
    expect(screen.queryByTestId("codex-controller")).toBeNull();
  });
});
