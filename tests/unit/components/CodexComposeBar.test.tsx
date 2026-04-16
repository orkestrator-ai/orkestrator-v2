import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// --- Module mocks (must be before component import) ---

mock.module("@/lib/tauri", () => ({
  writeContainerFile: async () => {},
  writeLocalFile: async () => "/tmp/file.png",
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

// @tauri-apps/plugin-clipboard-manager is centrally mocked in tests/setup.ts.
// Re-mocking here would replace the shared mock functions and break
// terminal-paste tests that rely on them.

mock.module("@/components/chat/MentionableInput", () => ({
  MentionableInput: (props: {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    onKeyDown?: (e: unknown) => void;
    onChange?: (text: string, mentions: unknown[]) => void;
  }) => (
    <textarea
      data-testid="mentionable-input"
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange?.(e.target.value, [])}
      onKeyDown={props.onKeyDown as React.KeyboardEventHandler}
    />
  ),
}));

mock.module("@/components/opencode/OpenCodeSlashCommandMenu", () => ({
  OpenCodeSlashCommandMenu: () => null,
}));

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: () => null,
}));

// @/hooks/useFileSearch is NOT mocked here: the top-level mock would leak
// into useFileSearch.test.ts via Bun's module cache. The hook is a no-op
// when containerId and worktreePath are both undefined, which is the case
// in these tests.

mock.module("@/hooks/useFileMentions", () => ({
  useFileMentions: () => ({
    isMenuOpen: false,
    selectedIndex: 0,
    filteredFiles: [],
    handleCursorChange: () => {},
    handleKeyDown: () => false,
    closeMenu: () => {},
    serializeForLLM: (text: string) => text,
    createMention: () => ({}),
  }),
}));

mock.module("@/lib/canvas-utils", () => ({
  resizeCanvasIfNeeded: (c: unknown) => c,
  resizeCanvasToMaxDimension: (c: unknown) => c,
  MAX_IMAGE_DIMENSION: 4096,
}));

import { CodexComposeBar } from "../../../src/components/codex/CodexComposeBar";
import { useCodexStore } from "../../../src/stores/codexStore";
import type { CodexModel } from "../../../src/lib/codex-client";

const ENV_ID = "env-codex-compose";
const SESSION_KEY = `env-${ENV_ID}:default`;

const defaultModels: CodexModel[] = [
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.4",
    name: "gpt-5.4",
    reasoningEfforts: ["low", "medium", "high"],
  },
];

function renderComposeBar(
  overrides: Partial<Parameters<typeof CodexComposeBar>[0]> = {},
) {
  const onSend = mock(async () => {});
  const onStop = mock(async () => {});
  const onQueue = mock(() => {});
  const onModeChange = mock(() => {});
  const onModelChange = mock(() => {});
  const onReasoningEffortChange = mock(() => {});

  const result = render(
    <CodexComposeBar
      environmentId={ENV_ID}
      sessionKey={SESSION_KEY}
      models={defaultModels}
      selectedMode="build"
      selectedModel="gpt-5.3-codex"
      selectedReasoningEffort="high"
      onSend={onSend}
      onStop={onStop}
      onQueue={onQueue}
      onModeChange={onModeChange}
      onModelChange={onModelChange}
      onReasoningEffortChange={onReasoningEffortChange}
      {...overrides}
    />,
  );

  return {
    ...result,
    onSend,
    onStop,
    onQueue,
    onModeChange,
    onModelChange,
    onReasoningEffortChange,
  };
}

describe("CodexComposeBar", () => {
  beforeEach(() => {
    useCodexStore.setState({
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders input placeholder", () => {
    renderComposeBar();
    expect(screen.getByPlaceholderText("Ask Codex anything...")).toBeTruthy();
  });

  test("renders selected model name in dropdown trigger", () => {
    renderComposeBar();
    expect(screen.getByText("gpt-5.3-codex")).toBeTruthy();
  });

  test("falls back to 'No models' when model id not found", () => {
    renderComposeBar({ selectedModel: "unknown-model" });
    expect(screen.getByText("No models")).toBeTruthy();
  });

  test("renders Build mode label by default", () => {
    renderComposeBar();
    expect(screen.getByText("Build")).toBeTruthy();
  });

  test("renders Plan mode label when selectedMode is 'plan'", () => {
    renderComposeBar({ selectedMode: "plan" });
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  test("renders reasoning effort label from selected model", () => {
    renderComposeBar({ selectedReasoningEffort: "xhigh" });
    expect(screen.getByText("Extra high")).toBeTruthy();
  });

  test("falls back to model default reasoning effort when current effort unsupported", () => {
    // "low" is not in gpt-5.3-codex's reasoningEfforts; should fall back to defaultReasoningEffort "high"
    renderComposeBar({ selectedReasoningEffort: "low" });
    expect(screen.getByText("High")).toBeTruthy();
  });

  test("send button is disabled when input is empty and no attachments", () => {
    renderComposeBar();
    const sendButton = screen.getByTitle("Send message");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });

  test("shows stop button when loading with empty input", () => {
    renderComposeBar({ isLoading: true });
    expect(screen.getByTitle("Stop current query")).toBeTruthy();
  });

  test("shows queue indicator when queueLength > 0", () => {
    renderComposeBar({ queueLength: 2 });
    expect(screen.getByText("+2 queued")).toBeTruthy();
  });

  test("does not show queue indicator when queueLength is 0", () => {
    renderComposeBar({ queueLength: 0 });
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  test("input is disabled when disabled prop is true", () => {
    renderComposeBar({ disabled: true });
    const input = screen.getByTestId("mentionable-input");
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  test("model/mode/reasoning triggers are disabled when settingsLocked is true", () => {
    renderComposeBar({ settingsLocked: true });
    const modeTrigger = screen.getByTitle(
      "Wait for Codex to finish before changing the mode",
    );
    const modelTrigger = screen.getByTitle(
      "Wait for Codex to finish before changing the model",
    );
    const reasoningTrigger = screen.getByTitle(
      "Wait for Codex to finish before changing reasoning",
    );
    expect(modeTrigger.hasAttribute("disabled")).toBe(true);
    expect(modelTrigger.hasAttribute("disabled")).toBe(true);
    expect(reasoningTrigger.hasAttribute("disabled")).toBe(true);
  });

  test("renders draft text from the store", () => {
    useCodexStore.getState().setDraftText(SESSION_KEY, "hello codex");
    renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;
    expect(input.value).toBe("hello codex");
  });

  test("compose bar wrapper has shrink-0 class", () => {
    const { container } = renderComposeBar();
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("shrink-0");
  });
});
