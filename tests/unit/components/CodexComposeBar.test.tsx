import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockReadImage } from "../../mocks/clipboard";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");
const mockSerializeForLLM = mock((text: string, _mentions?: unknown[]) => text);
const mockHandleFileMentionCursorChange = mock(() => {});
const mockHandleFileMentionKeyDown = mock(() => false);
const mockCloseFileMentionMenu = mock(() => {});
const mockCreateMention = mock(() => ({
  id: "mention-created",
  filename: "app.ts",
  relativePath: "src/app.ts",
}));
const mockRefreshFileTree = mock(() => {});
const mockSearchFiles = mock(() => []);
let mockFileMentionMenuOpen = false;
let mockFileSearchError: string | null = null;

// Snapshot modules before stubbing them so later suites that exercise the
// real file mention flow do not inherit these isolated compose-bar stubs.
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realHooks from "@/hooks";
import * as realUseFileMentions from "@/hooks/useFileMentions";
import * as realUseFileSearch from "@/hooks/useFileSearch";
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realHooksSnapshot = { ...realHooks };
const realUseFileMentionsSnapshot = { ...realUseFileMentions };
const realUseFileSearchSnapshot = { ...realUseFileSearch };

afterAll(() => {
  mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/hooks/useFileMentions", () => realUseFileMentionsSnapshot);
  mock.module("@/hooks/useFileSearch", () => realUseFileSearchSnapshot);
});

// --- Module mocks (must be before component import) ---

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

// @/lib/native/clipboard is centrally mocked in tests/setup.ts.
// Re-mocking here would replace the shared mock functions and break
// terminal-paste tests that rely on them.

mock.module("@/components/chat/MentionableInput", () => ({
  MentionableInput: (props: {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    onKeyDown?: (e: unknown) => void;
    onChange?: (text: string, mentions: unknown[]) => void;
    onCursorChange?: (position: number, text: string) => void;
  }) => (
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
  ),
}));

mock.module("@/components/opencode/OpenCodeSlashCommandMenu", () => ({
  OpenCodeSlashCommandMenu: () => null,
}));

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: () => null,
}));

mock.module("@/hooks/useFileSearch", () => ({
  useFileSearch: () => ({
    flatFiles: [],
    searchFiles: mockSearchFiles,
    isLoading: false,
    error: mockFileSearchError,
    refresh: mockRefreshFileTree,
    isAvailable: true,
  }),
}));

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

// CodexComposeBar imports these hooks through the barrel. Snapshotting and
// restoring the barrel keeps this suite isolated from later hook tests.
mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useFileSearch: () => ({
    flatFiles: [],
    searchFiles: mockSearchFiles,
    isLoading: false,
    error: mockFileSearchError,
    refresh: mockRefreshFileTree,
    isAvailable: true,
  }),
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

import { CodexComposeBar } from "../../../apps/web/src/components/codex/CodexComposeBar";
import { useCodexStore } from "../../../apps/web/src/stores/codexStore";
import type { CodexModel } from "../../../apps/web/src/lib/codex-client";
import { ADDRESS_ALL_REVIEW_PROMPT } from "../../../apps/web/src/lib/review-actions";

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
    reasoningEfforts: ["medium", "high", "xhigh", "max", "ultra"],
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
    mockHandleFileMentionCursorChange.mockReset();
    mockHandleFileMentionKeyDown.mockReset();
    mockHandleFileMentionKeyDown.mockImplementation(() => false);
    mockCloseFileMentionMenu.mockReset();
    mockCreateMention.mockReset();
    mockCreateMention.mockImplementation(() => ({
      id: "mention-created",
      filename: "app.ts",
      relativePath: "src/app.ts",
    }));
    mockRefreshFileTree.mockReset();
    mockSearchFiles.mockReset();
    mockSearchFiles.mockImplementation(() => []);
    mockFileMentionMenuOpen = false;
    mockFileSearchError = null;
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

  test.each([
    ["max", "Max"],
    ["ultra", "Ultra"],
  ] as const)("renders the %s reasoning effort from the CLI model catalog", (effort, label) => {
    renderComposeBar({ selectedReasoningEffort: effort });
    expect(screen.getByText(label)).toBeTruthy();
  });

  test.each([
    ["max", "Max"],
    ["ultra", "Ultra"],
  ] as const)("selects the %s reasoning effort from the model menu", async (effort, label) => {
    const { onReasoningEffortChange } = renderComposeBar();
    fireEvent.pointerDown(screen.getByTitle("Choose reasoning effort"));
    fireEvent.click(await screen.findByText(label));

    expect(onReasoningEffortChange).toHaveBeenCalledWith(effort);
  });

  test("falls back to model default reasoning effort when current effort unsupported", () => {
    // "low" is not in gpt-5.3-codex's reasoningEfforts; should fall back to defaultReasoningEffort "high"
    renderComposeBar({ selectedReasoningEffort: "low" });
    expect(screen.getByText("High")).toBeTruthy();
  });

  test("uses custom reasoning option labels and descriptions", async () => {
    const models: CodexModel[] = [{
      id: "custom-model",
      name: "Custom model",
      reasoningEfforts: ["low", "high"],
      reasoningOptions: [
        { effort: "low", label: "Quick", description: "Short analysis" },
        { effort: "high", label: "Thorough", description: "Deep analysis" },
      ],
    }];
    const { onReasoningEffortChange } = renderComposeBar({
      models,
      selectedModel: "custom-model",
      selectedReasoningEffort: "low",
    });

    expect(screen.getByText("Quick")).toBeTruthy();
    fireEvent.pointerDown(screen.getByTitle("Choose reasoning effort"));
    expect(await screen.findByText("Short analysis")).toBeTruthy();
    expect(screen.getByText("Deep analysis")).toBeTruthy();
    fireEvent.click(screen.getByText("Thorough"));
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });

  test("falls back to standard medium/high reasoning when the model catalog is empty", async () => {
    const models: CodexModel[] = [{
      id: "empty-model",
      name: "Empty model",
      reasoningEfforts: [],
      reasoningOptions: [],
    }];
    renderComposeBar({
      models,
      selectedModel: "empty-model",
      selectedReasoningEffort: "minimal",
    });

    expect(screen.getByText("Medium")).toBeTruthy();
    fireEvent.pointerDown(screen.getByTitle("Choose reasoning effort"));
    expect(await screen.findByText("Balances speed and reasoning depth for everyday tasks")).toBeTruthy();
    expect(screen.getByText("Greater reasoning depth for complex problems")).toBeTruthy();
  });

  test("uses the standard effort label when custom options omit the effective effort", () => {
    renderComposeBar({
      models: [{
        id: "partial-options",
        name: "Partial options",
        reasoningEfforts: ["low"],
        reasoningOptions: [{ effort: "medium", label: "Balanced" }],
      }],
      selectedModel: "partial-options",
      selectedReasoningEffort: "low",
    });

    expect(screen.getByText("Low")).toBeTruthy();
  });

  test("forwards mode and model selections", async () => {
    const { onModeChange, onModelChange } = renderComposeBar();

    fireEvent.pointerDown(screen.getByTitle("Choose mode"));
    fireEvent.click(await screen.findByText("Plan"));
    expect(onModeChange).toHaveBeenCalledWith("plan");

    fireEvent.pointerDown(screen.getByTitle("Choose model"));
    fireEvent.click(await screen.findByText("gpt-5.4"));
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.4");
  });

  test("send button is disabled when input is empty and no attachments", () => {
    renderComposeBar();
    const sendButton = screen.getByTitle("Send message");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });

  test("shows stop button when loading with empty input", () => {
    const { onStop } = renderComposeBar({ isLoading: true });
    const stopButton = screen.getByTitle("Stop current query");

    fireEvent.click(stopButton);

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("disables the stop button when no stop callback is available", () => {
    renderComposeBar({ isLoading: true, onStop: undefined });

    expect(screen.getByTitle("Stop current query").hasAttribute("disabled")).toBe(true);
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

  test("sends the shared review follow-up prompt from Address all", async () => {
    const { onSend } = renderComposeBar({ showAddressAll: true });

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(ADDRESS_ALL_REVIEW_PROMPT, []);
    });
  });

  test("re-enables Address all and reports an error when the follow-up rejects", async () => {
    const onSend = mock(async () => {
      throw new Error("review bridge unavailable");
    });
    renderComposeBar({ showAddressAll: true, onSend });

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(ADDRESS_ALL_REVIEW_PROMPT, []);
      expect(screen.getByRole("button", { name: "Address all" }).hasAttribute("disabled")).toBe(false);
    });
  });

  test("hides Address all while Codex is loading", () => {
    renderComposeBar({ showAddressAll: true, isLoading: true });

    expect(screen.queryByRole("button", { name: "Address all" })).toBeNull();
  });

  test("input and Fast control are disabled when disabled prop is true", () => {
    renderComposeBar({ disabled: true });
    const input = screen.getByTestId("mentionable-input");
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Fast").closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("model/mode/reasoning/fast controls are disabled when settingsLocked is true", () => {
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
    expect(screen.getByText("Fast").closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("renders draft text from the store", () => {
    useCodexStore.getState().setDraftText(SESSION_KEY, "hello codex");
    renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;
    expect(input.value).toBe("hello codex");
  });

  test("reports file-search errors and refreshes when the mention menu opens", async () => {
    mockFileSearchError = "file service unavailable";
    const { rerender } = renderComposeBar();

    await waitFor(() => expect(screen.getByTestId("mentionable-input")).toBeTruthy());
    expect(mockRefreshFileTree).not.toHaveBeenCalled();

    mockFileMentionMenuOpen = true;
    rerender(
      <CodexComposeBar
        environmentId={ENV_ID}
        sessionKey={SESSION_KEY}
        models={defaultModels}
        selectedMode="build"
        selectedModel="gpt-5.3-codex"
        selectedReasoningEffort="high"
        fastModeEnabled={false}
        onSend={async () => {}}
        onModeChange={() => {}}
        onModelChange={() => {}}
        onReasoningEffortChange={() => {}}
        onFastModeChange={() => {}}
      />,
    );

    await waitFor(() => expect(mockRefreshFileTree).toHaveBeenCalledTimes(1));

    rerender(
      <CodexComposeBar
        environmentId={ENV_ID}
        sessionKey={SESSION_KEY}
        models={defaultModels}
        selectedMode="plan"
        selectedModel="gpt-5.3-codex"
        selectedReasoningEffort="high"
        fastModeEnabled={false}
        onSend={async () => {}}
        onModeChange={() => {}}
        onModelChange={() => {}}
        onReasoningEffortChange={() => {}}
        onFastModeChange={() => {}}
      />,
    );
    expect(mockRefreshFileTree).toHaveBeenCalledTimes(1);
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

  test("queues an attachment-only prompt while Codex is loading", async () => {
    const attachment = {
      id: "attachment-only",
      type: "image" as const,
      path: "/workspace/attachment.png",
      previewUrl: "data:image/png;base64,abc",
      name: "attachment.png",
    };
    useCodexStore.getState().addAttachment(SESSION_KEY, attachment);
    const { onQueue } = renderComposeBar({ isLoading: true });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("", [attachment]);
    });
    expect(useCodexStore.getState().getAttachments(SESSION_KEY)).toHaveLength(0);
  });

  test("prevents another queue submission while the first is pending", async () => {
    let resolveQueue!: () => void;
    const onQueue = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveQueue = resolve;
        }),
    );
    useCodexStore.getState().setDraftText(SESSION_KEY, "Queue once");
    renderComposeBar({ isLoading: true, onQueue });

    const addButton = screen.getByTitle("Add to queue");
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledTimes(1);
      expect(screen.queryByTitle("Add to queue")).toBeNull();
    });

    fireEvent.click(addButton);
    expect(onQueue).toHaveBeenCalledTimes(1);

    resolveQueue();
    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("");
    });
  });

  test("keeps a busy draft when no queue callback is available", () => {
    useCodexStore.getState().setDraftText(SESSION_KEY, "Do not discard this");
    renderComposeBar({ isLoading: true, onQueue: undefined });

    expect(screen.queryByTitle("Add to queue")).toBeNull();
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Do not discard this",
    );
  });

  test("keyboard submit keeps a busy draft when no queue callback is available", () => {
    useCodexStore.getState().setDraftText(SESSION_KEY, "Still busy");
    const { onSend } = renderComposeBar({ isLoading: true, onQueue: undefined });

    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("Still busy");
  });

  test("keyboard submit ignores an empty prompt", () => {
    const { onSend } = renderComposeBar();

    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
  });

  test("retains the draft and re-enables sending when onSend rejects", async () => {
    const onSend = mock(async () => {
      throw new Error("bridge unavailable");
    });
    useCodexStore.getState().setDraftText(SESSION_KEY, "Retry this prompt");
    renderComposeBar({ onSend });

    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Retry this prompt", []);
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(false);
    });
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Retry this prompt",
    );
  });

  test("retains a busy draft when queueing rejects", async () => {
    const onQueue = mock(async () => {
      throw new Error("queue unavailable");
    });
    useCodexStore.getState().setDraftText(SESSION_KEY, "Keep queued prompt");
    renderComposeBar({ isLoading: true, onQueue });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("Keep queued prompt", []);
      expect(screen.getByTitle("Add to queue").hasAttribute("disabled")).toBe(false);
    });
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Keep queued prompt",
    );
  });

  test("clicking a queued prompt restores it into the draft and removes it from the queue", async () => {
    useCodexStore.getState().setDraftMentions(SESSION_KEY, [
      { id: "old-mention", filename: "old.ts", relativePath: "src/old.ts" },
    ]);
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
      fastMode: true,
    });

    const { onFastModeChange } = renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued codex task"));

    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
        "Queued codex task",
      );
    });
    expect(useCodexStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    expect(useCodexStore.getState().getDraftMentions(SESSION_KEY)).toEqual([]);
    expect(onFastModeChange).toHaveBeenCalledWith(true);
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
    useCodexStore.getState().setDraftText(SESSION_KEY, "Review @app");

    const { onSend } = renderComposeBar();
    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    await waitFor(() => {
      expect(mockCreateMention).toHaveBeenCalledWith(selectedFile);
    });
    expect(mockCloseFileMentionMenu).toHaveBeenCalledWith({ suppressReopenFor: "app.ts" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("continues to ordinary keyboard handling when the file mention menu declines the key", async () => {
    mockFileMentionMenuOpen = true;
    mockHandleFileMentionKeyDown.mockImplementation(() => false);
    useCodexStore.getState().setDraftText(SESSION_KEY, "Send despite menu");
    const { onSend } = renderComposeBar();

    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Send despite menu", []));
    expect(mockHandleFileMentionKeyDown).toHaveBeenCalledTimes(1);
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

  test("wraps slash-command selection upward and downward", async () => {
    const slashCommands = [
      { name: "/one", source: "prompt" as const },
      { name: "/two", source: "prompt" as const },
      { name: "/three", source: "prompt" as const },
    ];
    const first = renderComposeBar({ slashCommands });
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("/three ");
    });
    expect(first.onSend).not.toHaveBeenCalled();

    first.unmount();
    useCodexStore.getState().setDraftText(SESSION_KEY, "");
    const second = renderComposeBar({ slashCommands });
    const secondInput = screen.getByTestId("mentionable-input");
    fireEvent.change(secondInput, { target: { value: "/" } });
    fireEvent.keyDown(secondInput, { key: "ArrowDown" });
    fireEvent.keyDown(secondInput, { key: "ArrowDown" });
    fireEvent.keyDown(secondInput, { key: "ArrowDown" });
    fireEvent.keyDown(secondInput, { key: "Enter" });
    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("/one ");
    });
    expect(second.onSend).not.toHaveBeenCalled();
  });

  test("Escape closes the slash menu so Enter submits the slash text", async () => {
    const { onSend } = renderComposeBar({
      slashCommands: [{ name: "/fix", source: "prompt" }],
    });
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/", []));
  });

  test.each([
    ["/fix now", "command text containing a space"],
    ["/unknown", "a slash command with no matches"],
  ])("submits %s when it is %s", async (text, _case) => {
    const { onSend } = renderComposeBar({
      slashCommands: [{ name: "/fix", source: "prompt" }],
    });
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(text, []));
  });

  test("Shift+Enter preserves a multiline draft without submitting", () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "first line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("first line");
  });

  test.each([
    ["build", "plan"],
    ["plan", "build"],
  ] as const)("Shift+Tab changes %s mode to %s", (selectedMode, expectedMode) => {
    const { onModeChange } = renderComposeBar({ selectedMode });
    fireEvent.keyDown(screen.getByTestId("mentionable-input"), {
      key: "Tab",
      shiftKey: true,
    });

    expect(onModeChange).toHaveBeenCalledWith(expectedMode);
  });

  test("Enter submits an ordinary keyboard-authored prompt", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "Submit from keyboard" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Submit from keyboard", []);
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe("");
    });
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

  test("renders preview and file-only attachments and removes each one", async () => {
    useCodexStore.getState().addAttachment(SESSION_KEY, {
      id: "preview",
      type: "image",
      path: "/workspace/preview.png",
      previewUrl: "data:image/png;base64,abc",
      name: "preview.png",
    });
    useCodexStore.getState().addAttachment(SESSION_KEY, {
      id: "file-only",
      type: "image",
      path: "/workspace/file-only.png",
      name: "file-only.png",
    });
    renderComposeBar();

    expect(screen.getByAltText("preview.png")).toBeTruthy();
    expect(screen.queryByAltText("file-only.png")).toBeNull();

    fireEvent.click(screen.getByText("file-only.png").parentElement!.querySelector("button")!);
    await waitFor(() => {
      expect(useCodexStore.getState().getAttachments(SESSION_KEY).map(({ id }) => id)).toEqual([
        "preview",
      ]);
    });
    fireEvent.click(screen.getByText("preview.png").parentElement!.querySelector("button")!);
    await waitFor(() => {
      expect(useCodexStore.getState().getAttachments(SESSION_KEY)).toEqual([]);
    });
  });

  test("toggles and dismisses the attachment menu and removes its outside listener", () => {
    const removeEventListener = spyOn(document, "removeEventListener");
    const { container, unmount } = renderComposeBar();
    const plusButton = container.querySelector(
      '[data-native-compose-controls="primary"] button',
    )!;

    fireEvent.click(plusButton);
    expect(screen.getByText("Attach file from workspace")).toBeTruthy();
    expect(screen.getByText("Paste image (Cmd+V)")).toBeTruthy();

    fireEvent.click(plusButton);
    expect(screen.queryByText("Attach file from workspace")).toBeNull();

    fireEvent.click(plusButton);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Attach file from workspace")).toBeNull();

    fireEvent.click(plusButton);
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function));
    removeEventListener.mockRestore();
  });

  test("reorders and removes queued prompts from the dialog", async () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "First queued task",
      attachments: [],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
      fastMode: false,
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued task",
      attachments: [],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
      fastMode: false,
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

  test("shows an empty queue when the indicator count is stale", () => {
    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("Queue is empty.")).toBeTruthy();
  });

  test("disables both reorder controls for a single queued prompt", () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "only",
      text: "Only queued task",
      attachments: [],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
      fastMode: false,
    });
    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByTitle("Move up").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTitle("Move down").hasAttribute("disabled")).toBe(true);
  });

  test("renders queued prompt metadata and attachment pluralization", () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "metadata-one",
      text: "Plan quickly",
      attachments: [{
        id: "one",
        type: "image",
        path: "/workspace/one.png",
        name: "one.png",
      }],
      model: "gpt-5.4",
      mode: "plan",
      reasoningEffort: "xhigh",
      fastMode: true,
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "metadata-two",
      text: "Build carefully",
      attachments: [
        { id: "two", type: "image", path: "/workspace/two.png", name: "two.png" },
        { id: "three", type: "image", path: "/workspace/three.png", name: "three.png" },
      ],
      model: "gpt-5.3-codex",
      mode: "build",
      reasoningEffort: "high",
      fastMode: false,
    });
    renderComposeBar({ queueLength: 2 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getAllByText("Build").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Extra high")).toBeTruthy();
    expect(screen.getAllByText("High").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Fast mode")).toBeTruthy();
    expect(screen.getByText("1 attachment")).toBeTruthy();
    expect(screen.getByText("2 attachments")).toBeTruthy();
    const moveUpButtons = screen.getAllByTitle("Move up");
    const moveDownButtons = screen.getAllByTitle("Move down");
    expect(moveUpButtons[0]!.hasAttribute("disabled")).toBe(true);
    expect(moveUpButtons[1]!.hasAttribute("disabled")).toBe(false);
    expect(moveDownButtons[0]!.hasAttribute("disabled")).toBe(false);
    expect(moveDownButtons[1]!.hasAttribute("disabled")).toBe(true);
  });

  test("forwards fast-mode changes", () => {
    const { onFastModeChange } = renderComposeBar({ fastModeEnabled: false });

    fireEvent.click(screen.getByText("Fast").closest("button")!);

    expect(onFastModeChange).toHaveBeenCalledWith(true);
  });

  test("turns fast mode off when it is already enabled", () => {
    const { onFastModeChange } = renderComposeBar({ fastModeEnabled: true });
    const fastButton = screen.getByText("Fast").closest("button")!;

    expect(fastButton.getAttribute("aria-pressed")).toBe("true");
    expect(fastButton.getAttribute("title")).toContain("Fast mode on");
    fireEvent.click(fastButton);

    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });
});
