import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockReadImage } from "../../mocks/clipboard";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");
const mockSerializeForLLM = mock((text: string, _mentions?: unknown[]) => text);

// --- Module mocks (must be before component import) ---

mock.module("@/lib/tauri", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
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
    serializeForLLM: mockSerializeForLLM,
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

const ENV_ID = "env-opencode-compose";
const TAB_ID = "default";
const SESSION_KEY = `env-${ENV_ID}:${TAB_ID}`;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

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
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    mockSerializeForLLM.mockReset();
    mockSerializeForLLM.mockImplementation((text: string) => text);
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: () => {},
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;

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
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
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

  test("sends the current prompt and clears the draft state", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Inspect the deployment logs" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Inspect the deployment logs", []);
    });
    expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("");
  });

  test("queues the prompt while OpenCode is loading", async () => {
    const { onQueue } = renderComposeBar({ isLoading: true });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Queue this prompt" } });
    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("Queue this prompt", []);
    });
  });

  test("removes queued prompts from the dialog", async () => {
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued openCode task",
      attachments: [],
      model: "gpt-5",
      mode: "build",
    });

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByTitle("Remove queued prompt"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getQueueLength(SESSION_KEY)).toBe(0);
    });
  });

  test("serializes file mentions before sending", async () => {
    mockSerializeForLLM.mockImplementation((text, mentions) => {
      const mention = (mentions as Array<{ relativePath: string }>)[0];
      return `${text} -> ${mention?.relativePath}`;
    });
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "@app");
    useOpenCodeStore.getState().setDraftMentions(SESSION_KEY, [
      { id: "mention-1", filename: "app.ts", relativePath: "src/app.ts" },
    ]);

    const { onSend } = renderComposeBar();
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("@app -> src/app.ts", []);
    });
  });

  test("selects a slash command instead of sending when Enter is pressed on slash input", async () => {
    const { onSend } = renderComposeBar({
      slashCommands: [{ name: "/triage", description: "Triage the queue" }],
    });
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "/tri" } });
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("/tri");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("/triage ");
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
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });

  test("clears an incompatible variant when switching to a model without variants", async () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    useOpenCodeStore.getState().setSelectedVariant(ENV_ID, "high");
    renderComposeBar({ favoriteModelIds: ["claude-sonnet"] });

    fireEvent.pointerDown(screen.getByRole("button", { name: /GPT-5/i }));
    fireEvent.click(screen.getByText("Favorites"));
    fireEvent.click(screen.getByText("Claude Sonnet"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(ENV_ID)).toBe("claude-sonnet");
    });
    expect(useOpenCodeStore.getState().getSelectedVariant(ENV_ID)).toBeUndefined();
  });

  test("reorders queued prompts from the dialog", async () => {
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "First queued task",
      attachments: [],
      model: "gpt-5",
      variant: "high",
      mode: "build",
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued task",
      attachments: [],
      model: "claude-sonnet",
      mode: "plan",
    });

    renderComposeBar({ queueLength: 2 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(
      screen
        .getAllByTitle("Move down")
        .find((button) => !button.hasAttribute("disabled"))!,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getQueuedMessages(SESSION_KEY)[0]?.id).toBe(
        "queue-2",
      );
    });
  });
});
