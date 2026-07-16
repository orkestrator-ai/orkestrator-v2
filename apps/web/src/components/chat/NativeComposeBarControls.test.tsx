import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ClaudeComposeBar } from "@/components/claude/ClaudeComposeBar";
import { CodexComposeBar } from "@/components/codex/CodexComposeBar";
import { OpenCodeComposeBar } from "@/components/opencode/OpenCodeComposeBar";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { useCodexStore } from "@/stores/codexStore";

const noop = () => {};
const noopAsync = async () => {};

function renderClaudeComposeBar() {
  return render(
    <ClaudeComposeBar
      environmentId="claude-environment"
      tabId="claude-tab"
      models={[]}
      onSend={noop}
    />,
  );
}

function renderCodexComposeBar(isLoading = false) {
  return render(
    <CodexComposeBar
      environmentId="codex-environment"
      sessionKey="codex-session"
      models={[]}
      selectedMode="build"
      selectedModel=""
      selectedReasoningEffort="high"
      fastModeEnabled={false}
      isLoading={isLoading}
      onSend={noopAsync}
      onStop={noopAsync}
      onModeChange={noop}
      onModelChange={noop}
      onReasoningEffortChange={noop}
      onFastModeChange={noop}
    />,
  );
}

function renderOpenCodeComposeBar(isLoading = false) {
  return render(
    <OpenCodeComposeBar
      environmentId="opencode-environment"
      tabId="opencode-tab"
      models={[]}
      isLoading={isLoading}
      onSend={noop}
      onStop={noop}
    />,
  );
}

describe("native compose bar controls", () => {
  afterEach(() => {
    cleanup();
    useCodexStore.getState().setDraftText("codex-session", "");
    useOpenCodeStore
      .getState()
      .setDraftText(createOpenCodeSessionKey("opencode-environment", "opencode-tab"), "");
  });

  test("uses two full-width control rows at mobile widths", () => {
    const { container: claude } = renderClaudeComposeBar();
    const { container: codex } = renderCodexComposeBar();
    const { container: openCode } = renderOpenCodeComposeBar();

    for (const container of [claude, codex, openCode]) {
      const toolbar = container.querySelector<HTMLElement>("[data-native-compose-toolbar]");
      const primary = container.querySelector<HTMLElement>(
        '[data-native-compose-controls="primary"]',
      );
      const secondary = container.querySelector<HTMLElement>(
        '[data-native-compose-controls="secondary"]',
      );

      expect(toolbar?.className).toContain("flex-col");
      expect(toolbar?.className).toContain("sm:flex-row");
      expect(primary?.className).toContain("w-full");
      expect(secondary?.className).toContain("w-full");
    }
  });

  test("hides a disabled send button while Stop is visible", () => {
    renderCodexComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Add to queue")).toBeNull();

    cleanup();
    renderOpenCodeComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Add to queue")).toBeNull();
  });

  test("keeps the queue send button when a busy prompt has content", () => {
    useCodexStore.getState().setDraftText("codex-session", "Queue this prompt");
    renderCodexComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();

    cleanup();
    const openCodeSessionKey = createOpenCodeSessionKey(
      "opencode-environment",
      "opencode-tab",
    );
    useOpenCodeStore.getState().setDraftText(openCodeSessionKey, "Queue this prompt");
    renderOpenCodeComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();
  });
});
