import { createSessionKey } from "@/lib/utils";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ClaudeComposeBar } from "@/components/claude/ClaudeComposeBar";
import { CodexComposeBar } from "@/components/codex/CodexComposeBar";
import { OpenCodeComposeBar } from "@/components/opencode/OpenCodeComposeBar";
import {useOpenCodeStore} from "@/stores/openCodeStore";
import {useCodexStore} from "@/stores/codexStore";
import {useClaudeStore} from "@/stores/claudeStore";
import {
  restoreMatchMedia,
  setMobileViewport,
} from "../../../../../tests/mocks/match-media";

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
    restoreMatchMedia();
    useCodexStore.getState().setDraftText("codex-session", "");
    useCodexStore.getState().setContextUsage("codex-session", null);
    useOpenCodeStore
      .getState()
      .setDraftText(createSessionKey("opencode-environment", "opencode-tab"), "");
    useOpenCodeStore
      .getState()
      .setContextUsage(createSessionKey("opencode-environment", "opencode-tab"), null);
    useClaudeStore
      .getState()
      .setDraftText(createSessionKey("claude-environment", "claude-tab"), "");
    useClaudeStore
      .getState()
      .setContextUsage(createSessionKey("claude-environment", "claude-tab"), null);
  });

  test("keeps all compose controls on one row at mobile widths", () => {
    setMobileViewport(true);
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

      expect(toolbar?.className).toContain("items-center");
      expect(toolbar?.className).not.toContain("flex-col");
      expect(toolbar?.className).toContain("overflow-x-auto");
      expect(toolbar?.className).toContain("[scrollbar-width:none]");
      expect(primary?.className).toContain("flex-1");
      expect(primary?.className).toContain("min-w-0");
      expect(primary?.className).not.toContain("w-full");
      expect(secondary?.className).toContain("shrink-0");
      expect(secondary?.className).not.toContain("w-full");
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
      .setSelectedModel(
        createSessionKey("opencode-environment", "opencode-tab"),
        "long-opencode-model",
      );
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

  test("uses one combined Codex model, reasoning, and speed control", () => {
    const { container } = renderCodexComposeBar();
    const primary = container.querySelector<HTMLElement>(
      '[data-native-compose-controls="primary"]',
    );
    const secondary = container.querySelector<HTMLElement>(
      '[data-native-compose-controls="secondary"]',
    );
    const picker = container.querySelector<HTMLButtonElement>(
      'button[title="Choose model, reasoning, and speed"]',
    );

    expect(primary?.contains(picker ?? null)).toBe(true);
    expect(secondary?.contains(picker ?? null)).toBe(false);
    expect(container.querySelector('button[aria-pressed="false"]')).toBeNull();
  });

  test("hides a disabled send button while Stop is visible", () => {
    renderCodexComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Add to queue")).toBeNull();

    cleanup();
    renderOpenCodeComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Add to queue")).toBeNull();

    cleanup();
    renderClaudeComposeBar({ isLoading: true, onStop: noop, onQueue: noop });

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Add to queue")).toBeNull();
  });

  test("keeps the queue send button when a busy prompt has content", () => {
    useCodexStore.getState().setDraftText("codex-session", "Queue this prompt");
    renderCodexComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();

    cleanup();
    const openCodeSessionKey = createSessionKey(
      "opencode-environment",
      "opencode-tab",
    );
    useOpenCodeStore.getState().setDraftText(openCodeSessionKey, "Queue this prompt");
    renderOpenCodeComposeBar(true);

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();

    cleanup();
    const claudeSessionKey = createSessionKey("claude-environment", "claude-tab");
    useClaudeStore.getState().setDraftText(claudeSessionKey, "Queue this prompt");
    renderClaudeComposeBar({ isLoading: true, onStop: noop, onQueue: noop });

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();
  });

  test("shows the Codex context usage wheel from the store", () => {
    setMobileViewport(false);
    useCodexStore.getState().setContextUsage("codex-session", {
      usedTokens: 50_000,
      totalTokens: 100_000,
      percentUsed: 50,
      source: "codex",
    });
    renderCodexComposeBar();

    expect(screen.getByLabelText("Context window 50% used")).toBeTruthy();

    cleanup();
    useCodexStore.getState().setContextUsage("codex-session", null);
    renderCodexComposeBar();

    expect(screen.queryByLabelText(/Context window/)).toBeNull();
  });

  test("keeps context usage wheels visible on mobile", () => {
    setMobileViewport(true);
    const usage = {
      usedTokens: 50_000,
      totalTokens: 100_000,
      percentUsed: 50,
    };
    useCodexStore.getState().setContextUsage("codex-session", usage);
    useClaudeStore.getState().setContextUsage(
      createSessionKey("claude-environment", "claude-tab"),
      usage,
    );
    useOpenCodeStore.getState().setContextUsage(
      createSessionKey("opencode-environment", "opencode-tab"),
      usage,
    );

    const { container: claude } = renderClaudeComposeBar();
    const { container: codex } = renderCodexComposeBar();
    const { container: openCode } = renderOpenCodeComposeBar();

    for (const container of [claude, codex, openCode]) {
      expect(container.querySelector('[aria-label^="Context window"]')).not.toBeNull();
    }
  });

  test("hides the queue action when a busy compose bar is disabled", () => {
    useCodexStore.getState().setDraftText("codex-session", "Queue this prompt");
    renderCodexComposeBar(true, { disabled: true });
    expect(screen.queryByTitle("Add to queue")).toBeNull();

    cleanup();
    const openCodeSessionKey = createSessionKey(
      "opencode-environment",
      "opencode-tab",
    );
    useOpenCodeStore.getState().setDraftText(openCodeSessionKey, "Queue this prompt");
    renderOpenCodeComposeBar(true, { disabled: true });
    expect(screen.queryByTitle("Add to queue")).toBeNull();
  });
});
