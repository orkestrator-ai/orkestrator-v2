import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// --- Module mocks (must be before component import) ---

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
  writeContainerFile: async () => {},
  writeLocalFile: async () => "/tmp/file.png",
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

// Mock readImage to prevent real clipboard access
mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: mock(() => Promise.reject(new Error("no image"))),
  readText: mock(() => Promise.resolve("")),
  writeText: mock(() => Promise.resolve()),
}));

// Stub complex child components to isolate compose bar logic
mock.module("@/components/claude/MentionableInput", () => ({
  MentionableInput: (props: { value: string; placeholder?: string; disabled?: boolean; onKeyDown?: (e: unknown) => void; onChange?: (text: string, mentions: unknown[]) => void }) => {
    return (
      <textarea
        data-testid="mentionable-input"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange?.(e.target.value, [])}
        onKeyDown={props.onKeyDown as React.KeyboardEventHandler}
      />
    );
  },
}));

mock.module("@/components/claude/SlashCommandMenu", () => ({
  SlashCommandMenu: () => null,
  parseSlashCommands: (cmds: string[]) =>
    cmds.map((c) => {
      const parts = c.split(" - ");
      return { name: parts[0] ?? c, description: parts[1] ?? "" };
    }),
}));

mock.module("@/components/claude/FileMentionMenu", () => ({
  FileMentionMenu: () => null,
}));

mock.module("@/hooks/useFileSearch", () => ({
  useFileSearch: () => ({
    searchFiles: () => [],
    error: null,
    refresh: () => {},
  }),
}));

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

mock.module("@/components/chat/ContextUsageWheel", () => ({
  ContextUsageWheel: () => null,
}));

mock.module("@/lib/canvas-utils", () => ({
  resizeCanvasIfNeeded: (c: unknown) => c,
  resizeCanvasToMaxDimension: (c: unknown) => c,
  MAX_IMAGE_DIMENSION: 4096,
}));

import { ClaudeComposeBar } from "../../../src/components/claude/ClaudeComposeBar";
import { useClaudeStore } from "../../../src/stores/claudeStore";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";

const ENV_ID = "env-compose-test";
const TAB_ID = "default";

const defaultModels = [
  { id: "opus", name: "Opus", supportsFastMode: false, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as const },
  { id: "sonnet", name: "Sonnet", supportsFastMode: true, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] as const },
];

function renderComposeBar(overrides: Partial<Parameters<typeof ClaudeComposeBar>[0]> = {}) {
  const onSend = mock(() => {});
  const onStop = mock(() => {});
  const onQueue = mock(() => {});

  const result = render(
    <ClaudeComposeBar
      environmentId={ENV_ID}
      tabId={TAB_ID}
      models={defaultModels as any}
      onSend={onSend}
      onStop={onStop}
      onQueue={onQueue}
      {...overrides}
    />
  );

  return { ...result, onSend, onStop, onQueue };
}

describe("ClaudeComposeBar", () => {
  beforeEach(() => {
    // Reset store state
    useClaudeStore.setState({
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      selectedModel: new Map(),
      effort: new Map(),
      planMode: new Map(),
      queuedMessages: new Map(),
      sessionInitData: new Map(),
      contextUsage: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders input placeholder", () => {
    renderComposeBar();
    expect(screen.getByPlaceholderText("Ask Claude anything...")).toBeTruthy();
  });

  test("renders model name in model dropdown trigger", () => {
    renderComposeBar();
    // First model should be shown as default
    expect(screen.getByText("Opus")).toBeTruthy();
  });

  test("renders effort label (defaults to 'High')", () => {
    renderComposeBar();
    // Default effort is "high"
    expect(screen.getByText("High")).toBeTruthy();
  });

  test("renders Build/Plan mode label (defaults to 'Build')", () => {
    renderComposeBar();
    expect(screen.getByText("Build")).toBeTruthy();
  });

  test("send button is disabled when input is empty", () => {
    renderComposeBar();
    const sendButton = screen.getByTitle("Send message");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });

  test("shows stop button when loading and input is empty", () => {
    renderComposeBar({ isLoading: true });
    expect(screen.getByTitle("Stop current query")).toBeTruthy();
  });

  test("shows queue indicator when queueLength > 0", () => {
    renderComposeBar({ queueLength: 3 });
    expect(screen.getByText("+3 queued")).toBeTruthy();
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

  test("EFFORT_LABELS has entry for xhigh", () => {
    // Verify the new xhigh effort level renders without error
    const sessionKey = `env-${ENV_ID}:${TAB_ID}`;
    useClaudeStore.getState().setEffort(sessionKey, "xhigh");
    renderComposeBar();
    expect(screen.getByText("Extra High")).toBeTruthy();
  });

  test("all effort levels render correctly", () => {
    const sessionKey = `env-${ENV_ID}:${TAB_ID}`;
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    const labels = ["Low", "Medium", "High", "Extra High", "Max"];

    for (let i = 0; i < levels.length; i++) {
      useClaudeStore.getState().setEffort(sessionKey, levels[i]);
      const { unmount } = renderComposeBar();
      expect(screen.getByText(labels[i])).toBeTruthy();
      unmount();
    }
  });
});
