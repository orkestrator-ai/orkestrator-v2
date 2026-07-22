import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { mockReadImage } from "../../mocks/clipboard";
import { mockToastError } from "../../mocks/sonner";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");
const mockSerializeForLLM = mock((text: string, _mentions?: unknown[]) => text);
const mockHandleFileMentionCursorChange = mock(() => {});
const mockHandleFileMentionKeyDown = mock(() => false);
const mockCloseFileMentionMenu = mock(() => {});
const mockRefreshFileTree = mock(() => {});
const mockSearchFiles = mock(async () => []);
const mockInputFocus = mock(() => {});
const mockInsertMention = mock(() => {});
const mockCreateMention = mock(() => ({
  id: "mention-created",
  filename: "app.ts",
  relativePath: "src/app.ts",
}));
let mockFileMentionMenuOpen = false;
let mockFileSearchError: string | null = null;
let mockFilteredFiles = [{ filename: "app.ts", relativePath: "src/app.ts", isDirectory: false }];

const mockUseFileSearch = () => ({
  searchFiles: mockSearchFiles,
  error: mockFileSearchError,
  refresh: mockRefreshFileTree,
});

const mockUseFileMentions = () => ({
  isMenuOpen: mockFileMentionMenuOpen,
  selectedIndex: 0,
  filteredFiles: mockFilteredFiles,
  handleCursorChange: mockHandleFileMentionCursorChange,
  handleKeyDown: mockHandleFileMentionKeyDown,
  closeMenu: mockCloseFileMentionMenu,
  serializeForLLM: mockSerializeForLLM,
  createMention: mockCreateMention,
});

// Snapshot modules before stubbing them so later suites that exercise the
// real file mention flow do not inherit these isolated compose-bar stubs.
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realMentionableInput from "@/components/chat/MentionableInput";
import * as realContextUsageWheel from "@/components/chat/ContextUsageWheel";
import * as realOpenCodeSlashCommandMenu from "@/components/opencode/OpenCodeSlashCommandMenu";
import * as realHooks from "@/hooks";
import * as realUseFileMentions from "@/hooks/useFileMentions";
import * as realUseFileSearch from "@/hooks/useFileSearch";
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realMentionableInputSnapshot = { ...realMentionableInput };
const realContextUsageWheelSnapshot = { ...realContextUsageWheel };
const realOpenCodeSlashCommandMenuSnapshot = { ...realOpenCodeSlashCommandMenu };
const realHooksSnapshot = { ...realHooks };
const realUseFileMentionsSnapshot = { ...realUseFileMentions };
const realUseFileSearchSnapshot = { ...realUseFileSearch };

afterAll(() => {
  mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  mock.module("@/components/chat/MentionableInput", () => realMentionableInputSnapshot);
  mock.module("@/components/chat/ContextUsageWheel", () => realContextUsageWheelSnapshot);
  mock.module("@/components/opencode/OpenCodeSlashCommandMenu", () => realOpenCodeSlashCommandMenuSnapshot);
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
  MentionableInput: forwardRef(function MockMentionableInput(props: {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    onKeyDown?: (e: unknown) => void;
    onChange?: (text: string, mentions: unknown[]) => void;
    onCursorChange?: (position: number, text: string) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({
      focus: mockInputFocus,
      insertMention: mockInsertMention,
    }));
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
  }),
}));

mock.module("@/components/opencode/OpenCodeSlashCommandMenu", () => ({
  OpenCodeSlashCommandMenu: (props: {
    commands: Array<{ name: string; description?: string }>;
    selectedIndex: number;
    onSelect: (command: { name: string; description?: string }) => void;
  }) => (
    <div data-testid="slash-command-menu" data-selected-index={props.selectedIndex}>
      {props.commands.map((command) => (
        <button key={command.name} onClick={() => props.onSelect(command)}>
          {command.name}
        </button>
      ))}
    </div>
  ),
}));

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: (props: {
    files: Array<{ filename: string; relativePath: string; isDirectory: boolean }>;
    selectedIndex: number;
    onSelect: (file: { filename: string; relativePath: string; isDirectory: boolean }) => void;
  }) => (
    <div data-testid="file-mention-menu" data-selected-index={props.selectedIndex}>
      {props.files.map((file) => (
        <button key={file.relativePath} onClick={() => props.onSelect(file)}>
          {file.filename}
        </button>
      ))}
    </div>
  ),
}));

mock.module("@/components/chat/ContextUsageWheel", () => ({
  ContextUsageWheel: ({ usage }: { usage?: { percentUsed: number } }) => (
    <div data-testid="context-usage">{usage?.percentUsed ?? "none"}</div>
  ),
}));

mock.module("@/hooks/useFileSearch", () => ({ useFileSearch: mockUseFileSearch }));

mock.module("@/hooks/useFileMentions", () => ({ useFileMentions: mockUseFileMentions }));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useFileSearch: mockUseFileSearch,
  useFileMentions: mockUseFileMentions,
}));

import { OpenCodeComposeBar } from "../../../apps/web/src/components/opencode/OpenCodeComposeBar";
import { useOpenCodeStore } from "../../../apps/web/src/stores/openCodeStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import type { OpenCodeModel } from "../../../apps/web/src/lib/opencode-client";
import { ADDRESS_ALL_REVIEW_PROMPT } from "../../../apps/web/src/lib/review-actions";
import type { Environment } from "../../../apps/web/src/types";

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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createLocalEnvironment(): Environment {
  return {
    id: ENV_ID,
    projectId: "project-1",
    name: "Local environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/opencode-worktree",
  };
}

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
    mockWriteContainerFile.mockImplementation(async () => {});
    mockWriteLocalFile.mockImplementation(async () => "/tmp/file.png");
    mockSerializeForLLM.mockReset();
    mockSerializeForLLM.mockImplementation((text: string) => text);
    mockHandleFileMentionCursorChange.mockReset();
    mockHandleFileMentionKeyDown.mockReset();
    mockHandleFileMentionKeyDown.mockImplementation(() => false);
    mockCloseFileMentionMenu.mockReset();
    mockRefreshFileTree.mockReset();
    mockSearchFiles.mockReset();
    mockSearchFiles.mockImplementation(async () => []);
    mockInputFocus.mockReset();
    mockInsertMention.mockReset();
    mockToastError.mockClear();
    mockCreateMention.mockReset();
    mockCreateMention.mockImplementation(() => ({
      id: "mention-created",
      filename: "app.ts",
      relativePath: "src/app.ts",
    }));
    mockFileMentionMenuOpen = false;
    mockFileSearchError = null;
    mockFilteredFiles = [{ filename: "app.ts", relativePath: "src/app.ts", isDirectory: false }];
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
    useEnvironmentStore.setState({ environments: [] });
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

  test("focuses the mentionable input on mount", () => {
    renderComposeBar();
    expect(mockInputFocus).toHaveBeenCalledTimes(1);
  });

  test("reports file search errors for mention loading", () => {
    mockFileSearchError = "workspace unavailable";
    renderComposeBar();

    expect(mockToastError).toHaveBeenCalledWith("Failed to load files for @mentions", {
      description: "workspace unavailable",
      duration: 4000,
    });
  });

  test("refreshes the file tree when the mention menu opens", () => {
    mockFileMentionMenuOpen = true;
    renderComposeBar();

    expect(mockRefreshFileTree).toHaveBeenCalledTimes(1);
  });

  test("renders centered layout and current context usage", () => {
    useOpenCodeStore.getState().setContextUsage(SESSION_KEY, {
      usedTokens: 25,
      totalTokens: 100,
      percentUsed: 25,
    });
    const { container } = renderComposeBar({ layout: "centered" });

    expect(container.firstElementChild?.className).toContain("my-0");
    expect(container.firstElementChild?.className).not.toContain("mb-4");
    expect(screen.getByTestId("context-usage").textContent).toBe("25");
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
    const { onStop } = renderComposeBar({ isLoading: true });

    fireEvent.click(screen.getByTitle("Stop current query"));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("disables the stop button when no stop callback is available", () => {
    renderComposeBar({ isLoading: true, onStop: undefined });

    expect(screen.getByTitle("Stop current query").hasAttribute("disabled")).toBe(true);
  });

  test("shows queue indicator when queueLength > 0", () => {
    renderComposeBar({ queueLength: 5 });
    expect(screen.getByText("+5 queued")).toBeTruthy();
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
      expect(screen.getByRole("button", { name: "Address all" }).hasAttribute("disabled")).toBe(false);
    });
  });

  test("reports an Address all failure and allows retrying", async () => {
    const gate = deferred();
    const onSend = mock(() => gate.promise);
    renderComposeBar({ showAddressAll: true, onSend });

    const addressAll = screen.getByRole("button", { name: "Address all" });
    fireEvent.click(addressAll);
    fireEvent.click(addressAll);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    await act(async () => {
      gate.reject(new Error("review bridge unavailable"));
      await gate.promise.catch(() => {});
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to send prompt");
      expect(screen.getByRole("button", { name: "Address all" }).hasAttribute("disabled")).toBe(false);
    });

    onSend.mockImplementation(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Address all" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  });

  test("hides Address all while OpenCode is loading", () => {
    renderComposeBar({ showAddressAll: true, isLoading: true });

    expect(screen.queryByRole("button", { name: "Address all" })).toBeNull();
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

  test("deduplicates a pending send and clears all compose state after success", async () => {
    const gate = deferred();
    const onSend = mock(() => gate.promise);
    const attachment = {
      id: "send-attachment",
      type: "file" as const,
      path: "/workspace/report.txt",
      name: "report.txt",
    };
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Review @report");
    useOpenCodeStore.getState().setDraftMentions(SESSION_KEY, [
      { id: "mention-1", filename: "report.txt", relativePath: "report.txt" },
    ]);
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, attachment);
    renderComposeBar({ onSend });

    fireEvent.click(screen.getByTitle("Send message"));
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("Review @report");
    expect(useOpenCodeStore.getState().getDraftMentions(SESSION_KEY)).toHaveLength(1);
    expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("");
      expect(useOpenCodeStore.getState().getDraftMentions(SESSION_KEY)).toEqual([]);
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toEqual([]);
    });
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

  test("deduplicates a queue request while it is pending", async () => {
    const gate = deferred();
    const onQueue = mock(() => gate.promise);
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Queue once");
    renderComposeBar({ isLoading: true, onQueue });

    const queueButton = screen.getByTitle("Add to queue");
    fireEvent.click(queueButton);
    fireEvent.click(queueButton);

    await waitFor(() => expect(onQueue).toHaveBeenCalledTimes(1));
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("");
    });
  });

  test("queues an attachment-only prompt while OpenCode is loading", async () => {
    const attachment = {
      id: "attachment-only",
      type: "image" as const,
      path: "/workspace/attachment.png",
      previewUrl: "data:image/png;base64,abc",
      name: "attachment.png",
    };
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, attachment);
    const { onQueue } = renderComposeBar({ isLoading: true });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("", [attachment]);
    });
    expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(0);
  });

  test("falls back to onSend while loading when no queue callback is available", async () => {
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Send through fallback");
    const { onSend } = renderComposeBar({ isLoading: true, onQueue: undefined });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Send through fallback", []);
    });
  });

  test("retains the draft and re-enables sending when onSend rejects", async () => {
    const onSend = mock(async () => {
      throw new Error("bridge unavailable");
    });
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Retry this prompt");
    renderComposeBar({ onSend });

    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Retry this prompt", []);
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(false);
    });
    expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Retry this prompt",
    );
  });

  test("retains a busy draft when queueing rejects", async () => {
    const onQueue = mock(async () => {
      throw new Error("queue unavailable");
    });
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Keep queued prompt");
    renderComposeBar({ isLoading: true, onQueue });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(onQueue).toHaveBeenCalledWith("Keep queued prompt", []);
      expect(screen.getByTitle("Add to queue").hasAttribute("disabled")).toBe(false);
    });
    expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Keep queued prompt",
    );
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

  test("shows an empty queue when the indicator is stale", () => {
    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("Queue is empty.")).toBeTruthy();
  });

  test("renders queued prompt model fallbacks and metadata", () => {
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-known",
      text: "Known model",
      attachments: [
        { id: "one", type: "file", path: "/workspace/one.txt", name: "one.txt" },
      ],
      model: "gpt-5",
      variant: "high",
      mode: "plan",
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-unknown",
      text: "Unknown model",
      attachments: [
        { id: "one", type: "file", path: "/workspace/one.txt", name: "one.txt" },
        { id: "two", type: "file", path: "/workspace/two.txt", name: "two.txt" },
      ],
      model: "future-model",
      mode: "build",
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-default",
      text: "Default model task",
      attachments: [],
      mode: "build",
    });
    renderComposeBar({ queueLength: 3 });

    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText("GPT-5")).toBeTruthy();
    expect(screen.getByText("future-model")).toBeTruthy();
    expect(screen.getByText("Default model")).toBeTruthy();
    expect(screen.getByText("Planning")).toBeTruthy();
    expect(screen.getAllByText("Build").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("1 attachment")).toBeTruthy();
    expect(screen.getByText("2 attachments")).toBeTruthy();
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
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Review @app");

    const { onSend } = renderComposeBar();
    fireEvent.keyDown(screen.getByTestId("mentionable-input"), { key: "Enter" });

    await waitFor(() => {
      expect(mockCreateMention).toHaveBeenCalledWith(selectedFile);
    });
    expect(mockCloseFileMentionMenu).toHaveBeenCalledWith({ suppressReopenFor: "app.ts" });
    expect(mockInsertMention).toHaveBeenCalledWith(mockCreateMention.mock.results[0]?.value);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("renders the file mention menu and inserts a clicked file", () => {
    mockFileMentionMenuOpen = true;
    renderComposeBar();

    expect(screen.getByTestId("file-mention-menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "app.ts" }));

    expect(mockCreateMention).toHaveBeenCalledWith(mockFilteredFiles[0]);
    expect(mockCloseFileMentionMenu).toHaveBeenCalledWith({ suppressReopenFor: "app.ts" });
    expect(mockInsertMention).toHaveBeenCalledTimes(1);
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

  test("filters slash commands and closes the menu after a space", async () => {
    renderComposeBar({
      slashCommands: [
        { name: "/triage", description: "Triage the queue" },
        { name: "/review", description: "Review changes" },
      ],
    });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "/tri" } });
    await waitFor(() => {
      expect(screen.getByTestId("slash-command-menu")).toBeTruthy();
      expect(screen.getByRole("button", { name: "/triage" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "/review" })).toBeNull();
    });

    fireEvent.change(input, { target: { value: "/triage details" } });
    await waitFor(() => expect(screen.queryByTestId("slash-command-menu")).toBeNull());
  });

  test("clamps slash command arrows and selects the highlighted command with Tab", async () => {
    renderComposeBar({
      slashCommands: [
        { name: "/first", description: "First" },
        { name: "/second", description: "Second" },
      ],
    });
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/" } });
    await waitFor(() => expect(screen.getByTestId("slash-command-menu")).toBeTruthy());

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("slash-command-menu").getAttribute("data-selected-index")).toBe("0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("slash-command-menu").getAttribute("data-selected-index")).toBe("1");
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("/second ");
      expect(screen.queryByTestId("slash-command-menu")).toBeNull();
    });
  });

  test("Escape dismisses slash selection so Enter sends the literal draft", async () => {
    const { onSend } = renderComposeBar({
      slashCommands: [{ name: "/triage", description: "Triage" }],
    });
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/tri" } });
    await waitFor(() => expect(screen.getByTestId("slash-command-menu")).toBeTruthy());

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/tri", []));
  });

  test("submits unmatched slash text and ordinary text with Enter", async () => {
    const { onSend } = renderComposeBar({
      slashCommands: [{ name: "/triage", description: "Triage" }],
    });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "/unknown" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/unknown", []));

    fireEvent.change(input, { target: { value: "ordinary prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("ordinary prompt", []));
  });

  test("does not submit on Shift+Enter", () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "multiline prompt" } });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(useOpenCodeStore.getState().getDraftText(SESSION_KEY)).toBe("multiline prompt");
  });

  test("cycles mode with Shift+Tab", async () => {
    renderComposeBar();

    fireEvent.keyDown(screen.getByTestId("mentionable-input"), {
      key: "Tab",
      shiftKey: true,
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedMode(SESSION_KEY)).toBe("plan");
    });
  });

  test("cycles Planning mode back to Build with Shift+Tab", async () => {
    useOpenCodeStore.getState().setSelectedMode(SESSION_KEY, "plan");
    renderComposeBar();

    fireEvent.keyDown(screen.getByTestId("mentionable-input"), {
      key: "Tab",
      shiftKey: true,
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedMode(SESSION_KEY)).toBe("build");
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
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });

  test("renders image and file attachments and removes them independently", async () => {
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, {
      id: "image-1",
      type: "image",
      path: "/workspace/screenshot.png",
      previewUrl: "data:image/png;base64,abc",
      name: "screenshot.png",
    });
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, {
      id: "file-1",
      type: "file",
      path: "/workspace/notes.txt",
      name: "notes.txt",
    });
    renderComposeBar();

    expect(screen.getByAltText("screenshot.png")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByAltText("screenshot.png").parentElement!.querySelector("button")!);
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY).map((item) => item.id)).toEqual([
        "file-1",
      ]);
    });

    fireEvent.click(screen.getByText("notes.txt").parentElement!.querySelector("button")!);
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toEqual([]);
    });
  });

  test("opens, closes, and dismisses the attachment menu", () => {
    const { container } = renderComposeBar();
    const attachmentButton = container.querySelector(
      '[data-native-compose-controls="primary"] button',
    )!;

    fireEvent.click(attachmentButton);
    expect(screen.getByText("Attach file from workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paste image/ }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByText("Attach file from workspace"));
    expect(screen.queryByText("Attach file from workspace")).toBeNull();

    fireEvent.click(attachmentButton);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Attach file from workspace")).toBeNull();

    fireEvent.click(attachmentButton);
    fireEvent.click(attachmentButton);
    expect(screen.queryByText("Attach file from workspace")).toBeNull();
  });

  test("writes pasted images into a local worktree", async () => {
    useEnvironmentStore.setState({ environments: [createLocalEnvironment()] });
    renderComposeBar();
    const input = screen.getByTestId("mentionable-input") as HTMLTextAreaElement;
    input.focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => expect(mockWriteLocalFile).toHaveBeenCalledTimes(1));
    expect(mockWriteLocalFile).toHaveBeenCalledWith(
      "/tmp/opencode-worktree",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      "QUJD",
    );
    expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
  });

  test("selects Planning and Build from the mode menu", async () => {
    renderComposeBar();
    const modeButton = screen.getByTitle("Build mode (Shift+Tab to cycle)");

    fireEvent.pointerDown(modeButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Planning" }));
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedMode(SESSION_KEY)).toBe("plan");
    });

    fireEvent.pointerDown(screen.getByTitle("Planning mode (Shift+Tab to cycle)"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Build" }));
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedMode(SESSION_KEY)).toBe("build");
    });
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

  test("selects a model variant from the variant menu", async () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    renderComposeBar();

    fireEvent.pointerDown(screen.getByText("Default").closest("button")!);
    fireEvent.click(await screen.findByText("high"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedVariant(ENV_ID)).toBe("high");
    });
  });

  test("selects the Default model variant", async () => {
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    useOpenCodeStore.getState().setSelectedVariant(ENV_ID, "high");
    renderComposeBar();

    fireEvent.pointerDown(screen.getByText("high").closest("button")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Default/ }));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedVariant(ENV_ID)).toBeUndefined();
    });
  });

  test("preserves a selected variant when the next model supports it", async () => {
    const models: OpenCodeModel[] = [
      { id: "gpt-5", name: "GPT-5", provider: "openai", variants: ["low", "high"] },
      { id: "gpt-next", name: "GPT Next", provider: "openai", variants: ["high", "xhigh"] },
    ];
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    useOpenCodeStore.getState().setSelectedVariant(ENV_ID, "high");
    renderComposeBar({ models, favoriteModelIds: ["gpt-next"] });

    fireEvent.pointerDown(screen.getByRole("button", { name: /GPT-5/i }));
    fireEvent.click(screen.getByText("Favorites"));
    fireEvent.click(screen.getByText("GPT Next"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(ENV_ID)).toBe("gpt-next");
    });
    expect(useOpenCodeStore.getState().getSelectedVariant(ENV_ID)).toBe("high");
  });

  test("clears a variant that the next variant-capable model does not support", async () => {
    const models: OpenCodeModel[] = [
      { id: "gpt-5", name: "GPT-5", provider: "openai", variants: ["low", "high"] },
      { id: "gpt-next", name: "GPT Next", provider: "openai", variants: ["xhigh"] },
    ];
    useOpenCodeStore.getState().setSelectedModel(ENV_ID, "gpt-5");
    useOpenCodeStore.getState().setSelectedVariant(ENV_ID, "high");
    renderComposeBar({ models, favoriteModelIds: ["gpt-next"] });

    fireEvent.pointerDown(screen.getByRole("button", { name: /GPT-5/i }));
    fireEvent.click(screen.getByText("Favorites"));
    fireEvent.click(screen.getByText("GPT Next"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedVariant(ENV_ID)).toBeUndefined();
    });
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
    const moveUpButtons = screen.getAllByTitle("Move up");
    const moveDownButtons = screen.getAllByTitle("Move down");
    expect(moveUpButtons[0]?.hasAttribute("disabled")).toBe(true);
    expect(moveUpButtons[1]?.hasAttribute("disabled")).toBe(false);
    expect(moveDownButtons[0]?.hasAttribute("disabled")).toBe(false);
    expect(moveDownButtons[1]?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      moveDownButtons.find((button) => !button.hasAttribute("disabled"))!,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getQueuedMessages(SESSION_KEY)[0]?.id).toBe(
        "queue-2",
      );
    });
  });

  test("disables both reorder directions for a single queued prompt", () => {
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "only-item",
      text: "Only queued task",
      attachments: [],
      mode: "build",
    });
    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByTitle("Move up").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTitle("Move down").hasAttribute("disabled")).toBe(true);
  });

  test("renders search input in model dropdown", () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
  });

  test("renders refresh button when onRefreshModels is provided", () => {
    const onRefresh = mock(() => {});
    renderComposeBar({ onRefreshModels: onRefresh });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    expect(screen.getByTitle("Refresh models")).toBeTruthy();
  });

  test("does not render refresh button when onRefreshModels is not provided", () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    expect(screen.queryByTitle("Refresh models")).toBeNull();
  });

  test("calls onRefreshModels when refresh button is clicked", async () => {
    const onRefresh = mock(() => Promise.resolve());
    renderComposeBar({ onRefreshModels: onRefresh });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    fireEvent.click(screen.getByTitle("Refresh models"));
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  test("filters models by name in search", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    await waitFor(() => {
      expect(screen.queryByText("Claude Sonnet")).toBeNull();
    });
    fireEvent.click(screen.getByText(/openai/));
    await waitFor(() => {
      expect(screen.getByText("GPT-5")).toBeTruthy();
    });
  });

  test("filters models by provider in search", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "anthropic" } });
    await waitFor(() => {
      expect(screen.queryByText(/openai/)).toBeNull();
    });
    fireEvent.click(screen.getByText(/anthropic/));
    await waitFor(() => {
      expect(screen.getByText("Claude Sonnet")).toBeTruthy();
    });
  });

  test("shows Favorites section with count when search is empty", () => {
    renderComposeBar({ favoriteModelIds: ["claude-sonnet", "gpt-5"] });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    expect(screen.getByText("Favorites")).toBeTruthy();
    expect(screen.getByText(/\(2\)/)).toBeTruthy();
  });

  test("ignores unknown and duplicate favorite model IDs", () => {
    renderComposeBar({
      favoriteModelIds: ["missing-model", "claude-sonnet", "claude-sonnet"],
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));

    const favorites = screen.getByText("Favorites");
    expect(favorites.parentElement?.textContent).toContain("(1)");
    fireEvent.click(favorites);
    expect(screen.getAllByText("Claude Sonnet")).toHaveLength(1);
  });

  test("hides Favorites section while a search query is active", async () => {
    renderComposeBar({ favoriteModelIds: ["claude-sonnet", "gpt-5"] });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    expect(screen.getByText("Favorites")).toBeTruthy();
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    await waitFor(() => {
      expect(screen.queryByText("Favorites")).toBeNull();
    });
  });

  test("shows no matches when search yields no results", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nonexistent-model" } });
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeTruthy();
      expect(screen.getByText("0 models found")).toBeTruthy();
    });
  });

  test("shows model count when search is active", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    await waitFor(() => {
      expect(screen.getByText(/1 model found/)).toBeTruthy();
    });
  });

  test("uses the plural model count for multiple search results", async () => {
    renderComposeBar({
      models: [
        { id: "alpha-model", name: "Alpha Model", provider: "provider" },
        { id: "beta-model", name: "Beta Model", provider: "provider" },
      ],
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "model" },
    });

    await waitFor(() => expect(screen.getByText("2 models found")).toBeTruthy());
  });

  test("groups models without a provider under Other", async () => {
    renderComposeBar({
      models: [{ id: "local-model", name: "Local Model", provider: "" }],
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));

    fireEvent.click(screen.getByText("Other"));
    expect(await screen.findByText("Local Model")).toBeTruthy();
  });

  test("finds models by model ID", async () => {
    renderComposeBar({
      models: [
        { id: "provider/unique-model-id", name: "Friendly Name", provider: "provider" },
        { id: "provider/other", name: "Other Name", provider: "provider" },
      ],
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "unique-model-id" },
    });

    await waitFor(() => expect(screen.getByText("1 model found")).toBeTruthy());
    fireEvent.click(screen.getByText("provider"));
    expect(await screen.findByText("Friendly Name")).toBeTruthy();
    expect(screen.queryByText("Other Name")).toBeNull();
  });

  test("shows an explicit empty-model state", () => {
    renderComposeBar({ models: [] });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));

    expect(screen.getByText("No models available")).toBeTruthy();
  });

  test("clears search when model is selected", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    await waitFor(() => {
      expect(screen.getByText(/1 model found/)).toBeTruthy();
    });
    // Click outside to close dropdown (which also clears search via onOpenChange)
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
      const reopenedInput = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
      expect(reopenedInput.value).toBe("");
    });
  });

  test("clears search when dropdown closes", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    await waitFor(() => {
      expect(input.value).toBe("GPT");
    });
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
      const reopensInput = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
      expect(reopensInput.value).toBe("");
    });
  });

  test("Escape key in search input closes the dropdown", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    const input = screen.getByPlaceholderText("Search models...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GPT" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull();
    });
  });

  test("selecting a model updates the store", async () => {
    renderComposeBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select model/i }));
    fireEvent.click(screen.getByText(/openai/));
    await waitFor(() => {
      expect(screen.getByText("GPT-5")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("GPT-5"));
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(ENV_ID)).toBe("gpt-5");
    });
  });
});
