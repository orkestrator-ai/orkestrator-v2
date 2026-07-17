import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ClaudeComposeBar } from "@/components/claude/ClaudeComposeBar";
import { CodexComposeBar } from "@/components/codex/CodexComposeBar";
import { OpenCodeComposeBar } from "@/components/opencode/OpenCodeComposeBar";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { useCodexStore } from "@/stores/codexStore";

const noop = () => {};
const noopAsync = async () => {};

function renderClaudeComposeBar(
  overrides: Partial<Parameters<typeof ClaudeComposeBar>[0]> = {},
) {
  return render(
    <ClaudeComposeBar
      environmentId="claude-environment"
      tabId="claude-tab"
      models={[]}
      onSend={noop}
      {...overrides}
    />,
  );
}

function renderCodexComposeBar(
  isLoading = false,
  overrides: Partial<Parameters<typeof CodexComposeBar>[0]> = {},
) {
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
      onQueue={noop}
      onStop={noopAsync}
      onModeChange={noop}
      onModelChange={noop}
      onReasoningEffortChange={noop}
      onFastModeChange={noop}
      {...overrides}
    />,
  );
}

function renderOpenCodeComposeBar(
  isLoading = false,
  overrides: Partial<Parameters<typeof OpenCodeComposeBar>[0]> = {},
) {
  return render(
    <OpenCodeComposeBar
      environmentId="opencode-environment"
      tabId="opencode-tab"
      models={[]}
      isLoading={isLoading}
      onSend={noop}
      onQueue={noop}
      onStop={noop}
      {...overrides}
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
      expect(toolbar?.className).toContain("overflow-x-auto");
      expect(toolbar?.className).toContain("[scrollbar-width:none]");
      expect(toolbar?.className).toContain("[&>*]:shrink-0");
      expect(primary?.className).toContain("w-full");
      expect(secondary?.className).toContain("w-full");
    }
  });

  test("keeps every optional action reachable with long model labels", () => {
    const longModelName = "A deliberately long model name for responsive coverage";
    const { container: claude } = renderClaudeComposeBar({
      models: [{
        id: "long-claude-model",
        name: longModelName,
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      }],
      queueLength: 123,
      showAddressAll: true,
    });
    const { container: codex } = renderCodexComposeBar(false, {
      models: [{
        id: "long-codex-model",
        name: longModelName,
        reasoningEfforts: ["medium", "high"],
      }],
      selectedModel: "long-codex-model",
      queueLength: 123,
      showAddressAll: true,
    });
    useOpenCodeStore
      .getState()
      .setSelectedModel("opencode-environment", "long-opencode-model");
    const { container: openCode } = renderOpenCodeComposeBar(false, {
      models: [{
        id: "long-opencode-model",
        name: longModelName,
        provider: "test-provider",
        variants: ["a-deliberately-long-variant"],
      }],
      queueLength: 123,
      showAddressAll: true,
    });

    for (const container of [claude, codex, openCode]) {
      const toolbar = container.querySelector<HTMLElement>("[data-native-compose-toolbar]");
      expect(toolbar?.className).toContain("overflow-x-auto");
      expect(container.textContent).toContain("+123 queued");
      expect(container.textContent).toContain("Address all");
      expect(
        Array.from(container.querySelectorAll<HTMLElement>(".truncate"))
          .some((element) => element.textContent === longModelName),
      ).toBe(true);
    }
  });

  test("keeps the Codex Fast toggle beside the reasoning selector", () => {
    const { container } = renderCodexComposeBar();
    const primary = container.querySelector<HTMLElement>(
      '[data-native-compose-controls="primary"]',
    );
    const secondary = container.querySelector<HTMLElement>(
      '[data-native-compose-controls="secondary"]',
    );
    const reasoning = container.querySelector<HTMLButtonElement>(
      'button[title="Choose reasoning effort"]',
    );
    const fast = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');

    expect(primary?.contains(fast ?? null)).toBe(true);
    expect(secondary?.contains(fast ?? null)).toBe(false);
    expect(reasoning?.nextElementSibling).toBe(fast);
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

  test("hides the queue action when a busy compose bar is disabled", () => {
    useCodexStore.getState().setDraftText("codex-session", "Queue this prompt");
    renderCodexComposeBar(true, { disabled: true });
    expect(screen.queryByTitle("Add to queue")).toBeNull();

    cleanup();
    const openCodeSessionKey = createOpenCodeSessionKey(
      "opencode-environment",
      "opencode-tab",
    );
    useOpenCodeStore.getState().setDraftText(openCodeSessionKey, "Queue this prompt");
    renderOpenCodeComposeBar(true, { disabled: true });
    expect(screen.queryByTitle("Add to queue")).toBeNull();
  });
});
