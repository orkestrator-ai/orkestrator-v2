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

mock.module("@/components/chat/ContextUsageWheel", () => ({
  ContextUsageWheel: () => null,
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

import { OpenCodeComposeBar } from "../../../src/components/opencode/OpenCodeComposeBar";
import { useOpenCodeStore } from "../../../src/stores/openCodeStore";
import type { OpenCodeModel } from "../../../src/lib/opencode-client";

const ENV_ID = "env-opencode-compose";
const TAB_ID = "default";
const SESSION_KEY = `env-${ENV_ID}:${TAB_ID}`;

const defaultModels: OpenCodeModel[] = [
  { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "openai", variants: ["low", "high"] },
];

function renderComposeBar(
  overrides: Partial<Parameters<typeof OpenCodeComposeBar>[0]> = {},
) {
  const onSend = mock(() => {});
  const onStop = mock(() => {});
  const onQueue = mock(() => {});

  const result = render(
    <OpenCodeComposeBar
      environmentId={ENV_ID}
      tabId={TAB_ID}
      models={defaultModels}
      onSend={onSend}
      onStop={onStop}
      onQueue={onQueue}
      {...overrides}
    />,
  );

  return { ...result, onSend, onStop, onQueue };
}

describe("OpenCodeComposeBar", () => {
  beforeEach(() => {
    useOpenCodeStore.setState({
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      selectedModel: new Map(),
      selectedVariant: new Map(),
      selectedMode: new Map(),
      messageQueue: new Map(),
      contextUsage: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders input placeholder", () => {
    renderComposeBar();
    expect(
      screen.getByPlaceholderText("Ask anything (⌘L), @ to mention, / for workflows"),
    ).toBeTruthy();
  });

  test("renders Build mode label by default", () => {
    renderComposeBar();
    expect(screen.getByText("Build")).toBeTruthy();
  });

  test("renders Planning mode label when store mode is 'plan'", () => {
    useOpenCodeStore.getState().setSelectedMode(SESSION_KEY, "plan");
    renderComposeBar();
    expect(screen.getByText("Planning")).toBeTruthy();
  });

  test("renders selected model name when one is set in the store", () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "claude-sonnet");
    renderComposeBar();
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
  });

  test("falls back to 'Select model' when no model is selected", () => {
    renderComposeBar();
    expect(screen.getByText("Select model")).toBeTruthy();
  });

  test("renders variant dropdown only when selected model has variants", () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    renderComposeBar();
    // "Default" is the variant-dropdown label when no variant is selected
    expect(screen.getByText("Default")).toBeTruthy();
  });

  test("does not render variant dropdown when selected model has no variants", () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "claude-sonnet");
    renderComposeBar();
    expect(screen.queryByText("Default")).toBeNull();
  });

  test("send button is disabled when input is empty and no attachments", () => {
    renderComposeBar();
    const sendButton = screen.getByTitle("Send message");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });

  test("shows stop button when loading", () => {
    renderComposeBar({ isLoading: true });
    expect(screen.getByTitle("Stop current query")).toBeTruthy();
  });

  test("shows queue indicator when queueLength > 0", () => {
    renderComposeBar({ queueLength: 5 });
    expect(screen.getByText("+5 queued")).toBeTruthy();
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

  test("renders draft text from the store", () => {
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "hello opencode");
    renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;
    expect(input.value).toBe("hello opencode");
  });

  test("compose bar wrapper has shrink-0 class", () => {
    const { container } = renderComposeBar();
    // Component renders <> <div .shrink-0> ... </div> <Dialog/> </>, so the wrapper div is the first DOM node
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).toContain("shrink-0");
  });
});
