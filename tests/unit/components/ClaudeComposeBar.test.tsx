import { afterAll, describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockReadImage } from "../../mocks/clipboard";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");
const mockUpdateGlobalConfig = mock(async (global: any) => ({
  version: "1.0",
  global,
  repositories: {},
}));
const mockSerializeForLLM = mock((text: string, _mentions?: unknown[]) => text);
const mockHandleFileMentionCursorChange = mock(() => {});
const mockHandleFileMentionKeyDown = mock(() => false);
const mockCloseFileMentionMenu = mock(() => {});
const mockToastError = mock((_message: string) => {});
const mockCreateMention = mock(() => ({
  id: "mention-created",
  filename: "app.ts",
  relativePath: "src/app.ts",
}));
let mockFileMentionMenuOpen = false;

// Snapshot the real SlashCommandMenu module BEFORE we stub it below, so we
// can restore it for other test files (e.g. ClaudeTmuxChatTab.test.tsx
// renders the real SlashCommandMenu and would otherwise see this file's
// null-component stub via Bun's module cache).
import * as realSlashCommandMenu from "@/components/claude/SlashCommandMenu";
import * as realMentionableInput from "@/components/chat/MentionableInput";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realUseFileMentions from "@/hooks/useFileMentions";
import * as realUseFileSearch from "@/hooks/useFileSearch";
const realSlashCommandMenuSnapshot = { ...realSlashCommandMenu };
const realMentionableInputSnapshot = { ...realMentionableInput };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realUseFileMentionsSnapshot = { ...realUseFileMentions };
const realUseFileSearchSnapshot = { ...realUseFileSearch };

afterAll(() => {
  mock.module(
    "@/components/claude/SlashCommandMenu",
    () => realSlashCommandMenuSnapshot,
  );
  mock.module("@/components/chat/MentionableInput", () => realMentionableInputSnapshot);
  mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  mock.module("@/hooks/useFileMentions", () => realUseFileMentionsSnapshot);
  mock.module("@/hooks/useFileSearch", () => realUseFileSearchSnapshot);
});

// --- Module mocks (must be before component import) ---

mock.module("@/lib/backend", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: mockToastError },
}));

// @/lib/native/clipboard is centrally mocked in tests/setup.ts.
// Re-mocking here would replace the shared mock functions and break
// terminal-paste tests that rely on them.

// Stub complex child components to isolate compose bar logic
mock.module("@/components/chat/MentionableInput", () => ({
  MentionableInput: (props: {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    onKeyDown?: (e: unknown) => void;
    onChange?: (text: string, mentions: unknown[]) => void;
    onCursorChange?: (position: number, text: string) => void;
  }) => {
    return (
      <textarea
        data-testid="mentionable-input"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => {
          props.onChange?.(e.target.value, []);
          props.onCursorChange?.(e.target.selectionStart, e.target.value);
        }}
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

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: () => null,
}));

// @/hooks/useFileSearch is NOT mocked here: the top-level mock would leak
// into useFileSearch.test.ts via Bun's module cache. The hook is a no-op
// when containerId and worktreePath are both undefined, which is the case
// in these tests.

mock.module("@/hooks/useFileMentions", () => ({
  useFileMentions: () => ({
    isMenuOpen: mockFileMentionMenuOpen,
    selectedIndex: 0,
    filteredFiles: [],
    handleCursorChange: mockHandleFileMentionCursorChange,
    handleKeyDown: mockHandleFileMentionKeyDown,
    closeMenu: mockCloseFileMentionMenu,
    serializeForLLM: mockSerializeForLLM,
    createMention: mockCreateMention,
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
import { useConfigStore } from "../../../src/stores/configStore";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import { ADDRESS_ALL_REVIEW_PROMPT } from "../../../src/lib/review-actions";

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const ENV_ID = "env-compose-test";
const TAB_ID = "default";
const SESSION_KEY = `env-${ENV_ID}:${TAB_ID}`;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

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
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    mockUpdateGlobalConfig.mockReset();
    mockUpdateGlobalConfig.mockImplementation(async (global: any) => ({
      version: "1.0",
      global,
      repositories: {},
    }));
    mockSerializeForLLM.mockReset();
    mockSerializeForLLM.mockImplementation((text: string) => text);
    mockHandleFileMentionCursorChange.mockReset();
    mockHandleFileMentionKeyDown.mockReset();
    mockHandleFileMentionKeyDown.mockImplementation(() => false);
    mockCloseFileMentionMenu.mockReset();
    mockToastError.mockReset();
    mockCreateMention.mockReset();
    mockCreateMention.mockImplementation(() => ({
      id: "mention-created",
      filename: "app.ts",
      relativePath: "src/app.ts",
    }));
    mockFileMentionMenuOpen = false;
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: () => {},
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;

    // Reset store state
    useClaudeStore.setState({
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      selectedModel: new Map(),
      effort: new Map(),
      planMode: new Map(),
      fastMode: new Map(),
      queuedMessages: new Map(),
      sessionInitData: new Map(),
      contextUsage: new Map(),
    });
    useConfigStore.getState().updateGlobalConfig({ claudeModel: "opus" });
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
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

  test("persists selected model as the Claude global default", async () => {
    renderComposeBar();

    const modelTrigger = screen.getByText("Opus").closest("button");
    expect(modelTrigger).toBeTruthy();
    fireEvent.pointerDown(modelTrigger!);
    fireEvent.click(await screen.findByText("Sonnet"));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "sonnet" }),
      );
    });
    expect(useConfigStore.getState().config.global.claudeModel).toBe("sonnet");
  });

  test("rolls back the persisted Claude model default when saving fails", async () => {
    mockUpdateGlobalConfig.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    renderComposeBar();

    const modelTrigger = screen.getByText("Opus").closest("button");
    expect(modelTrigger).toBeTruthy();
    fireEvent.pointerDown(modelTrigger!);
    fireEvent.click(await screen.findByText("Sonnet"));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "sonnet" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe("opus");
    });
    expect(useClaudeStore.getState().getSelectedModel(SESSION_KEY)).toBe("sonnet");
    expect(mockToastError).toHaveBeenCalledWith("Failed to save Claude model default");
  });

  test("keeps the newest selected model when an older persistence request resolves later", async () => {
    let resolveFirstSave: (() => void) | undefined;
    mockUpdateGlobalConfig.mockImplementationOnce(
      (global: any) =>
        new Promise((resolve) => {
          resolveFirstSave = () => resolve({
            version: "1.0",
            global,
            repositories: {},
          });
        }),
    );
    mockUpdateGlobalConfig.mockImplementationOnce(async (global: any) => ({
      version: "1.0",
      global,
      repositories: {},
    }));

    renderComposeBar({
      models: [
        ...defaultModels,
        {
          id: "haiku",
          name: "Haiku",
          supportsFastMode: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ] as any,
    });

    const opusTrigger = screen.getByText("Opus").closest("button");
    expect(opusTrigger).toBeTruthy();
    fireEvent.pointerDown(opusTrigger!);
    fireEvent.click(await screen.findByText("Sonnet"));

    await waitFor(() => {
      expect(useConfigStore.getState().config.global.claudeModel).toBe("sonnet");
    });

    const sonnetTrigger = screen.getByText("Sonnet").closest("button");
    expect(sonnetTrigger).toBeTruthy();
    fireEvent.pointerDown(sonnetTrigger!);
    fireEvent.click(await screen.findByText("Haiku"));

    await waitFor(() => {
      expect(useConfigStore.getState().config.global.claudeModel).toBe("haiku");
    });

    resolveFirstSave?.();

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(2);
      expect(useConfigStore.getState().config.global.claudeModel).toBe("haiku");
    });
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

  test("sends the shared review follow-up prompt from Address all", () => {
    const { onSend } = renderComposeBar({ showAddressAll: true });

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    expect(onSend).toHaveBeenCalledWith(
      ADDRESS_ALL_REVIEW_PROMPT,
      [],
      "high",
      false,
      false,
    );
  });

  test("hides Address all while Claude is loading", () => {
    renderComposeBar({ showAddressAll: true, isLoading: true });

    expect(screen.queryByRole("button", { name: "Address all" })).toBeNull();
  });

  test("input is disabled when disabled prop is true", () => {
    renderComposeBar({ disabled: true });
    const input = screen.getByTestId("mentionable-input");
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  test("EFFORT_LABELS has entry for xhigh", () => {
    // Verify the new xhigh effort level renders without error
    useClaudeStore.getState().setEffort(SESSION_KEY, "xhigh");
    renderComposeBar();
    expect(screen.getByText("Extra High")).toBeTruthy();
  });

  test("all effort levels render correctly", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    const labels = ["Low", "Medium", "High", "Extra High", "Max"];

    for (let i = 0; i < levels.length; i++) {
      useClaudeStore.getState().setEffort(SESSION_KEY, levels[i]);
      const { unmount } = renderComposeBar();
      expect(screen.getByText(labels[i])).toBeTruthy();
      unmount();
    }
  });

  test("sends the current prompt and clears the draft state", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Ship the release" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Ship the release", [], "high", false, false);
    });
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("");
  });

  test("queues the prompt while Claude is loading", async () => {
    const { onQueue } = renderComposeBar({ isLoading: true });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Queue this next" } });
    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("Queue this next", [], "high", false, false);
    });
  });

  test("clicking a queued prompt restores its text, settings, and attachments for editing", async () => {
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued follow-up",
      attachments: [
        {
          id: "att-1",
          type: "image",
          path: "/workspace/screenshot.png",
          previewUrl: "data:image/png;base64,abc",
          name: "screenshot.png",
        },
      ],
      effort: "max",
      planModeEnabled: true,
    });

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued follow-up"));

    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe(
        "Queued follow-up",
      );
    });
    expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    expect(useClaudeStore.getState().getEffort(SESSION_KEY)).toBe("max");
    expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);
    expect(useClaudeStore.getState().getQueueLength(SESSION_KEY)).toBe(0);
  });

  test("serializes file mentions before sending", async () => {
    mockSerializeForLLM.mockImplementation((text, mentions) => {
      const mention = (mentions as Array<{ relativePath: string }>)[0];
      return `${text} -> ${mention?.relativePath}`;
    });
    useClaudeStore.getState().setDraftText(SESSION_KEY, "@app");
    useClaudeStore.getState().setDraftMentions(SESSION_KEY, [
      { id: "mention-1", filename: "app.ts", relativePath: "src/app.ts" },
    ]);

    const { onSend } = renderComposeBar();
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("@app -> src/app.ts", [], "high", false, false);
    });
  });

  test("passes current editable text to file mention detection", async () => {
    renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: {
        value: "Review @app",
        selectionStart: "Review @app".length,
      },
    });

    expect(mockHandleFileMentionCursorChange).toHaveBeenCalledWith(
      "Review @app".length,
      "Review @app",
    );
  });

  test("file mention key selection uses the shared select handler and skips submit", async () => {
    const selectedFile = {
      filename: "app.ts",
      relativePath: "src/app.ts",
      isDirectory: false,
    };
    mockFileMentionMenuOpen = true;
    mockHandleFileMentionKeyDown.mockImplementation((_event, onSelect) => {
      (onSelect as (file: typeof selectedFile) => void)(selectedFile);
      return true;
    });
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Review @app");

    const { onSend } = renderComposeBar();
    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    await waitFor(() => {
      expect(mockCreateMention).toHaveBeenCalledWith(selectedFile);
    });
    expect(mockCloseFileMentionMenu).toHaveBeenCalledWith({ suppressReopenFor: "app.ts" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("selects a slash command instead of sending when Enter is pressed on slash input", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "/rev" } });
    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("/rev");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("/review ");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("includes /goal in fallback slash commands", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "/go" } });
    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("/go");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("/goal ");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("adds a pasted image attachment through the shared paste hook", async () => {
    const { getByTestId } = renderComposeBar({ containerId: "container-1" });
    const input = getByTestId("mentionable-input") as HTMLTextAreaElement;
    input.focus();

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });

  test("removes queued prompts from the dialog", async () => {
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued follow-up",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
    });

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByTitle("Remove queued prompt"));

    await waitFor(() => {
      expect(useClaudeStore.getState().getQueueLength(SESSION_KEY)).toBe(0);
    });
  });

  describe("fast mode toggle", () => {
    test("hides the Fast button when the selected model does not support fast mode", () => {
      // Opus is the default (first) model and has supportsFastMode: false.
      renderComposeBar();
      expect(screen.queryByText("Fast")).toBeNull();
    });

    test("renders the Fast button when the selected model supports fast mode", () => {
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      renderComposeBar();
      expect(screen.getByText("Fast")).toBeTruthy();
    });

    test("toggles fast mode in the store when the button is clicked", async () => {
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      renderComposeBar();

      const fastButton = screen.getByText("Fast").closest("button");
      expect(fastButton).toBeTruthy();

      fireEvent.click(fastButton!);
      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(true);
      });
      expect(fastButton!.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(fastButton!);
      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
    });

    test("resets fast mode when the selected model switches to one that doesn't support it", async () => {
      // Start on a supporting model with fast mode on.
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      useClaudeStore.getState().setFastMode(SESSION_KEY, true);
      renderComposeBar();

      await waitFor(() => {
        expect(screen.getByText("Fast")).toBeTruthy();
      });

      // Switch to the non-supporting model; the component's normalization
      // effect must clear stored fast mode to keep UI and state in sync.
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "opus");

      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
      expect(screen.queryByText("Fast")).toBeNull();
    });

    test("defensively resets fast mode on mount when the selected model doesn't support it", async () => {
      // Simulate a stale preference: fast mode was set before a model list arrived
      // that excludes fast-mode support for the current selection.
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "opus");
      useClaudeStore.getState().setFastMode(SESSION_KEY, true);

      renderComposeBar();

      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
    });

    test("sends fast mode flag through when enabled on a supporting model", async () => {
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      useClaudeStore.getState().setFastMode(SESSION_KEY, true);
      const { onSend } = renderComposeBar();

      fireEvent.change(screen.getByTestId("mentionable-input"), {
        target: { value: "Go fast" },
      });
      fireEvent.click(screen.getByTitle("Send message"));

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith("Go fast", [], "high", false, true);
      });
    });
  });
});
