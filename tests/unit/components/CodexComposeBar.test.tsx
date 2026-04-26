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

import { CodexComposeBar } from "../../../src/components/codex/CodexComposeBar";
import { useCodexStore } from "../../../src/stores/codexStore";
import type { CodexModel } from "../../../src/lib/codex-client";

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

const ENV_ID = "env-codex-compose";
const SESSION_KEY = `env-${ENV_ID}:default`;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

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
  const onFastModeChange = mock(() => {});

  const result = render(
    <CodexComposeBar
      environmentId={ENV_ID}
      sessionKey={SESSION_KEY}
      models={defaultModels}
      selectedMode="build"
      selectedModel="gpt-5.3-codex"
      selectedReasoningEffort="high"
      fastModeEnabled={false}
      onSend={onSend}
      onStop={onStop}
      onQueue={onQueue}
      onModeChange={onModeChange}
      onModelChange={onModelChange}
      onReasoningEffortChange={onReasoningEffortChange}
      onFastModeChange={onFastModeChange}
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
    onFastModeChange,
  };
}

describe("CodexComposeBar", () => {
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

    useCodexStore.setState({
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
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

  test("keeps stop button available while loading with drafted text", () => {
    renderComposeBar({ isLoading: true });
    fireEvent.change(screen.getByTestId("mentionable-input"), {
      target: { value: "please continue" },
    });

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();
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

  test("sends the current prompt and clears the draft state", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Review the flaky test" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Review the flaky test", []);
    });
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("");
  });

  test("queues the prompt while Codex is loading", async () => {
    const { onQueue } = renderComposeBar({ isLoading: true });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Queue this for later" } });
    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("Queue this for later", []);
    });
  });

  test("clicking a queued prompt restores it into the draft and removes it from the queue", async () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued codex task",
      attachments: [
        {
          id: "att-1",
          type: "image",
          path: "/workspace/screenshot.png",
          previewUrl: "data:image/png;base64,abc",
          name: "screenshot.png",
        },
      ],
      model: "gpt-5.3-codex",
      mode: "plan",
      reasoningEffort: "xhigh",
    });

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued codex task"));

    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
        "Queued codex task",
      );
    });
    expect(useCodexStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    expect(useCodexStore.getState().getQueueLength(SESSION_KEY)).toBe(0);
  });

  test("serializes file mentions before sending", async () => {
    mockSerializeForLLM.mockImplementation((text, mentions) => {
      const mention = (mentions as Array<{ relativePath: string }>)[0];
      return `${text} -> ${mention?.relativePath}`;
    });
    useCodexStore.getState().setDraftText(SESSION_KEY, "@app");
    useCodexStore.getState().setDraftMentions(SESSION_KEY, [
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
      slashCommands: [{ name: "/fix", source: "prompt" }],
    });
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "/fi" } });
    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("/fi");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("/fix ");
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
      expect(useCodexStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });

  test("reorders and removes queued prompts from the dialog", async () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "First queued task",
      attachments: [],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued task",
      attachments: [],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
    });

    renderComposeBar({ queueLength: 2 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(
      screen
        .getAllByTitle("Move down")
        .find((button) => !button.hasAttribute("disabled"))!,
    );

    await waitFor(() => {
      expect(useCodexStore.getState().getQueuedMessages(SESSION_KEY)[0]?.id).toBe(
        "queue-2",
      );
    });

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[0]!);

    await waitFor(() => {
      expect(useCodexStore.getState().getQueueLength(SESSION_KEY)).toBe(1);
    });
  });
});
