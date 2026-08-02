import { afterAll, describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { mockReadImage } from "../../mocks/clipboard";
import {
  emitViewportChange,
  restoreMatchMedia,
  setMobileViewport,
} from "../../mocks/match-media";
import { mockToastError } from "../../mocks/sonner";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");
const mockGetFileTree = mock(async () => []);
const mockGetLocalFileTree = mock(async () => []);
const mockUpdateAgentModelDefault = mock(async (key: string, modelId: string) => ({
  version: "1.0",
  global: { [key]: modelId },
  repositories: {},
}));
const mockSerializeForLLM = mock((text: string, _mentions?: unknown[]) => text);
const mockHandleFileMentionCursorChange = mock(() => {});
const mockHandleFileMentionKeyDown = mock(() => false);
const mockCloseFileMentionMenu = mock(() => {});
const mockCreateMention = mock(() => ({
  id: "mention-created",
  filename: "app.ts",
  relativePath: "src/app.ts",
}));
const mockInputFocus = mock(() => {});
const mockRemovePromptQueueMessage = mock(
  async (
    _queueKey: string,
    _environmentId: string,
    _messageId: string,
  ): Promise<{
    removed: unknown | null;
    queue: {
      queueKey: string;
      environmentId: string;
      messages: unknown[];
      updatedAt: string;
      revision: number;
    } | null;
  }> => ({ removed: null, queue: null }),
);
const mockMovePromptQueueMessage = mock(
  async (
    _queueKey: string,
    _environmentId: string,
    _messageId: string,
    _direction: "up" | "down",
  ): Promise<{
    queueKey: string;
    environmentId: string;
    messages: unknown[];
    updatedAt: string;
    revision: number;
  } | null> => null,
);
const mockTransferPromptQueueMessageToComposeDraft = mock(
  async (
    _queueKey: string,
    _environmentId: string,
    _messageId: string,
    _draftKey: string,
    _ownerType: "environment" | "project",
    _ownerId: string,
  ): Promise<{
    removed: unknown | null;
    queue: {
      queueKey: string;
      environmentId: string;
      messages: unknown[];
      updatedAt: string;
      revision: number;
    } | null;
    draft: unknown | null;
  }> => ({ removed: null, queue: null, draft: null }),
);
let mockPromptQueueRevision = 0;
let mockFileMentionMenuOpen = false;

// Snapshot the real SlashCommandMenu module BEFORE we stub it below, so we
// can restore it for other test files (e.g. ClaudeTmuxChatTab.test.tsx
// renders the real SlashCommandMenu and would otherwise see this file's
// null-component stub via Bun's module cache).
import * as realSlashCommandMenu from "@/components/chat/SlashCommandMenu";
import * as realMentionableInput from "@/components/chat/MentionableInput";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realUseFileMentions from "@/hooks/useFileMentions";
import * as realUseFileSearch from "@/hooks/useFileSearch";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";
const realSlashCommandMenuSnapshot = { ...realSlashCommandMenu };
const realMentionableInputSnapshot = { ...realMentionableInput };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realUseFileMentionsSnapshot = { ...realUseFileMentions };
const realUseFileSearchSnapshot = { ...realUseFileSearch };

afterAll(() => {
  mock.module(
    "@/components/chat/SlashCommandMenu",
    () => realSlashCommandMenuSnapshot,
  );
  mock.module("@/components/chat/MentionableInput", () => realMentionableInputSnapshot);
  mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  mock.module("@/hooks/useFileMentions", () => realUseFileMentionsSnapshot);
  mock.module("@/hooks/useFileSearch", () => realUseFileSearchSnapshot);
  restoreMatchMedia();
});

// --- Module mocks (must be before component import) ---

mock.module("@/lib/backend", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
  updateAgentModelDefault: mockUpdateAgentModelDefault,
  getFileTree: mockGetFileTree,
  getLocalFileTree: mockGetLocalFileTree,
  removePromptQueueMessage: mockRemovePromptQueueMessage,
  movePromptQueueMessage: mockMovePromptQueueMessage,
  transferPromptQueueMessageToComposeDraft:
    mockTransferPromptQueueMessageToComposeDraft,
}));

// @/lib/native/clipboard is centrally mocked in tests/setup.ts.
// Re-mocking here would replace the shared mock functions and break
// terminal-paste tests that rely on them.

// Stub complex child components to isolate compose bar logic
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
      insertMention: () => {},
      insertMentionAtCursor: () => {},
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

mock.module("@/components/chat/SlashCommandMenu", () => ({
  SlashCommandMenu: () => null,
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

import { ClaudeComposeBar } from "../../../apps/web/src/components/claude/ClaudeComposeBar";
import {
  hydratePromptQueue,
  promptQueueKey,
  resetPromptQueueRevisions,
  type PromptQueueSource,
} from "../../../apps/web/src/lib/prompt-queue-persistence";
import { useClaudeStore } from "../../../apps/web/src/stores/claudeStore";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
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

const ENV_ID = "env-compose-test";
const TAB_ID = "default";
const SESSION_KEY = `env-${ENV_ID}:${TAB_ID}`;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

function sessionKeyFromQueueKey(queueKey: string): string {
  return queueKey.slice(queueKey.indexOf("\u0000") + 1);
}

function claudeQueueSnapshot(
  queueKey: string,
  environmentId: string,
  messages: unknown[],
) {
  return {
    queueKey,
    environmentId,
    messages,
    updatedAt: new Date().toISOString(),
    revision: ++mockPromptQueueRevision,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Latches the durable dispatch error the backend writes when it parks this
 * queue. `observeDispatchError` is module-private, so the latch is published
 * through the real change-feed entry point with a recording source, which keeps
 * the Claude store out of it.
 */
async function parkQueue(message: string) {
  const queueKey = promptQueueKey("claude", SESSION_KEY);
  const source: PromptQueueSource = {
    agent: "claude",
    getQueues: () => new Map(),
    setQueue: () => {},
    subscribe: () => () => {},
    environmentIdFor: () => ENV_ID,
  };
  await act(async () => {
    await hydratePromptQueue(queueKey, [source], async () => ({
      queueKey,
      environmentId: ENV_ID,
      messages: [{ id: "queue-1" }],
      dispatchError: {
        requestId: "req-1",
        messageId: "queue-1",
        messageFingerprint: "fingerprint-1",
        message,
        failedAt: "2026-07-30T00:00:00.000Z",
      },
      updatedAt: "2026-07-30T00:00:00.000Z",
      revision: 1,
    }));
  });
}

const defaultModels = [
  { id: "opus", name: "Opus", supportsFastMode: false, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as const },
  { id: "sonnet", name: "Sonnet", supportsFastMode: true, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] as const },
];

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
    createdAt: "2026-07-26T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/claude-worktree",
  };
}

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
    setMobileViewport(false);
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    mockGetFileTree.mockReset();
    mockGetFileTree.mockResolvedValue([]);
    mockGetLocalFileTree.mockReset();
    mockGetLocalFileTree.mockResolvedValue([]);
    mockUpdateAgentModelDefault.mockReset();
    mockUpdateAgentModelDefault.mockImplementation(async (key: string, modelId: string) => ({
      version: "1.0",
      global: { [key]: modelId },
      repositories: {},
    }));
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
    mockInputFocus.mockReset();
    mockRemovePromptQueueMessage.mockReset();
    mockRemovePromptQueueMessage.mockImplementation(
      async (queueKey, environmentId, messageId) => {
        const messages = [
          ...(useClaudeStore.getState().messageQueue.get(
            sessionKeyFromQueueKey(queueKey),
          ) ?? []),
        ];
        const removed = messages.find((message) => message.id === messageId) ?? null;
        return {
          removed,
          queue: claudeQueueSnapshot(
            queueKey,
            environmentId,
            messages.filter((message) => message.id !== messageId),
          ),
        };
      },
    );
    mockMovePromptQueueMessage.mockReset();
    mockMovePromptQueueMessage.mockImplementation(
      async (queueKey, environmentId, messageId, direction) => {
        const messages = [
          ...(useClaudeStore.getState().messageQueue.get(
            sessionKeyFromQueueKey(queueKey),
          ) ?? []),
        ];
        const fromIndex = messages.findIndex((message) => message.id === messageId);
        const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
        if (fromIndex >= 0 && toIndex >= 0 && toIndex < messages.length) {
          [messages[fromIndex], messages[toIndex]] = [
            messages[toIndex]!,
            messages[fromIndex]!,
          ];
        }
        return claudeQueueSnapshot(queueKey, environmentId, messages);
      },
    );
    mockTransferPromptQueueMessageToComposeDraft.mockReset();
    mockTransferPromptQueueMessageToComposeDraft.mockImplementation(
      async (queueKey, environmentId, messageId, draftKey, ownerType, ownerId) => {
        const messages = [
          ...(useClaudeStore.getState().messageQueue.get(
            sessionKeyFromQueueKey(queueKey),
          ) ?? []),
        ];
        const removed = messages.find((message) => message.id === messageId) ?? null;
        return {
          removed,
          queue: claudeQueueSnapshot(
            queueKey,
            environmentId,
            messages.filter((message) => message.id !== messageId),
          ),
          draft: removed
            ? {
                draftKey,
                ownerType,
                ownerId,
                value: {
                  text: removed.text,
                  mentions: [],
                  attachments: removed.attachments,
                },
                updatedAt: new Date().toISOString(),
                revision: 1,
              }
            : null,
        };
      },
    );
    mockToastError.mockClear();
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
      // The shared native-chat slice stores the queue under `messageQueue`;
      // resetting anything else leaves queued prompts leaking between tests.
      messageQueue: new Map(),
      sessionInitData: new Map(),
      contextUsage: new Map(),
    });
    useEnvironmentStore.setState({ environments: [] });
    useConfigStore.getState().updateGlobalConfig({ claudeModel: "opus" });
    // The dispatch-error latch is module state shared by every test in this file.
    resetPromptQueueRevisions();
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

  test("focuses the mentionable input on desktop mount", () => {
    renderComposeBar();

    expect(mockInputFocus).toHaveBeenCalledTimes(1);
  });

  test("does not focus the mentionable input on mobile mount", () => {
    setMobileViewport(true);
    renderComposeBar();

    expect(mockInputFocus).not.toHaveBeenCalled();
  });

  test("does not focus when the viewport widens past the mobile breakpoint", () => {
    setMobileViewport(true);
    renderComposeBar();
    expect(mockInputFocus).not.toHaveBeenCalled();

    act(() => emitViewportChange(false));

    expect(mockInputFocus).not.toHaveBeenCalled();
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
      expect(mockUpdateAgentModelDefault).toHaveBeenCalledWith("claudeModel", "sonnet");
    });
    expect(useConfigStore.getState().config.global.claudeModel).toBe("sonnet");
  });

  test("rolls back the persisted Claude model default when saving fails", async () => {
    mockUpdateAgentModelDefault.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    renderComposeBar();

    const modelTrigger = screen.getByText("Opus").closest("button");
    expect(modelTrigger).toBeTruthy();
    fireEvent.pointerDown(modelTrigger!);
    fireEvent.click(await screen.findByText("Sonnet"));

    await waitFor(() => {
      expect(mockUpdateAgentModelDefault).toHaveBeenCalledWith("claudeModel", "sonnet");
      expect(useConfigStore.getState().config.global.claudeModel).toBe("opus");
    });
    expect(useClaudeStore.getState().getSelectedModel(SESSION_KEY)).toBe("sonnet");
  });

  test("keeps the newest selected model when an older persistence request resolves later", async () => {
    let resolveFirstSave: (() => void) | undefined;
    mockUpdateAgentModelDefault.mockImplementationOnce(
      (key: string, modelId: string) =>
        new Promise((resolve) => {
          resolveFirstSave = () => resolve({
            version: "1.0",
            global: { [key]: modelId },
            repositories: {},
          });
        }),
    );
    mockUpdateAgentModelDefault.mockImplementationOnce(async (key: string, modelId: string) => ({
      version: "1.0",
      global: { [key]: modelId },
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
      expect(mockUpdateAgentModelDefault).toHaveBeenCalledTimes(2);
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

  test("keeps the stop button visible while typing during a running turn", () => {
    renderComposeBar({ isLoading: true });
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "Follow-up while running" } });

    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTitle("Add to queue")).toBeTruthy();
  });

  test("disables the stop button when no stop callback is available", () => {
    renderComposeBar({ isLoading: true, onStop: undefined });

    expect(screen.getByTitle("Stop current query").hasAttribute("disabled")).toBe(true);
  });

  test("shows queue indicator when queueLength > 0", () => {
    renderComposeBar({ queueLength: 3 });
    expect(screen.getByText("+3 queued")).toBeTruthy();
  });

  test("does not show queue indicator when queueLength is 0", () => {
    renderComposeBar({ queueLength: 0 });
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  test("keeps the queue indicator neutral while the queue is draining", () => {
    renderComposeBar({ queueLength: 2 });

    const indicator = screen.getByTitle("View queued prompts");
    expect(indicator.className).not.toContain("destructive");
    expect(indicator.getAttribute("aria-label")).toBeNull();
  });

  test("marks the queue indicator as blocked when the backend rejected a queued prompt", async () => {
    await parkQueue("Claude session is gone.");

    renderComposeBar({ queueLength: 2 });

    // The backend stops draining a parked queue until a human retries, so the
    // reason has to be reachable without opening the dialog.
    const indicator = await screen.findByRole("button", {
      name: "2 queued prompts blocked: Claude session is gone.",
    });
    expect(indicator.getAttribute("title")).toBe(
      "Queued prompt was not sent: Claude session is gone.",
    );
    expect(indicator.className).toContain("text-destructive");
    expect(indicator.className).toContain("bg-destructive/10");
    expect(screen.queryByTitle("View queued prompts")).toBeNull();
  });

  test("surfaces the dispatch error and its retry inside the queue dialog", async () => {
    act(() => {
      useClaudeStore.setState((state) => ({
        messageQueue: new Map(state.messageQueue).set(SESSION_KEY, [{
          id: "queue-1",
          text: "Queued follow-up",
          attachments: [],
          effort: "high",
          planModeEnabled: false,
        }]),
      }));
    });
    await parkQueue("Claude session is gone.");

    const { unmount } = renderComposeBar({ queueLength: 1 });
    fireEvent.click(
      screen.getByRole("button", {
        name: "1 queued prompts blocked: Claude session is gone.",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claude session is gone.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    unmount();
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

  test("reports an Address all failure and allows retrying", async () => {
    const onSend = mock(async () => {
      throw new Error("review bridge unavailable");
    });
    renderComposeBar({ showAddressAll: true, onSend });
    const addressAll = screen.getByRole("button", { name: "Address all" });

    fireEvent.click(addressAll);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to send prompt", {
        description: "review bridge unavailable",
      });
      expect(addressAll.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(addressAll);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
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

  test.each([
    ["send", false, "Send message"],
    ["queue", true, "Add to queue"],
  ] as const)(
    "preserves newer compose state while a %s request is pending",
    async (_kind, isLoading, buttonTitle) => {
      const gate = deferred();
      const pending = mock(() => gate.promise);
      const submittedAttachment = {
        id: "submitted-attachment",
        type: "file" as const,
        path: "/workspace/submitted.txt",
        name: "submitted.txt",
      };
      const nextAttachment = {
        id: "next-attachment",
        type: "image" as const,
        path: "/workspace/next.png",
        name: "next.png",
      };
      const submittedMention = {
        id: "submitted-mention",
        filename: "submitted.ts",
        relativePath: "src/submitted.ts",
      };
      const nextMention = {
        id: "next-mention",
        filename: "next.ts",
        relativePath: "src/next.ts",
      };
      const store = useClaudeStore.getState();
      store.setDraftText(SESSION_KEY, "Submit this");
      store.setDraftMentions(SESSION_KEY, [submittedMention]);
      store.addAttachment(SESSION_KEY, submittedAttachment);
      renderComposeBar({
        isLoading,
        ...(isLoading ? { onQueue: pending } : { onSend: pending }),
      });

      fireEvent.click(screen.getByTitle(buttonTitle));
      await waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("mentionable-input").hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByRole("button", { name: "Add attachment" }).hasAttribute("disabled"),
      ).toBe(true);

      act(() => {
        const latest = useClaudeStore.getState();
        latest.setDraftText(SESSION_KEY, "Compose next");
        latest.setDraftMentions(SESSION_KEY, [nextMention]);
        latest.addAttachment(SESSION_KEY, nextAttachment);
      });

      await act(async () => {
        gate.resolve();
        await gate.promise;
      });

      await waitFor(() => {
        const latest = useClaudeStore.getState();
        expect(latest.getDraftText(SESSION_KEY)).toBe("Compose next");
        expect(latest.getDraftMentions(SESSION_KEY)).toEqual([nextMention]);
        expect(latest.getAttachments(SESSION_KEY)).toEqual([nextAttachment]);
      });
      expect(pending).toHaveBeenCalledWith(
        "Submit this",
        [submittedAttachment],
        "high",
        false,
        false,
      );
    },
  );

  test("preserves same-text draft state when mention metadata changes during send", async () => {
    const gate = deferred();
    const onSend = mock(() => gate.promise);
    const submittedMention = {
      id: "mention-1",
      filename: "app.ts",
      relativePath: "src/app.ts",
    };
    const updatedMention = {
      ...submittedMention,
      relativePath: "packages/app.ts",
    };
    const store = useClaudeStore.getState();
    store.setDraftText(SESSION_KEY, "Review @app.ts");
    store.setDraftMentions(SESSION_KEY, [submittedMention]);
    renderComposeBar({ onSend });

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    act(() => {
      useClaudeStore.getState().setDraftMentions(SESSION_KEY, [updatedMention]);
    });

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe(
        "Review @app.ts",
      );
      expect(useClaudeStore.getState().getDraftMentions(SESSION_KEY)).toEqual([
        updatedMention,
      ]);
    });
  });

  test("closes and disables an open attachment picker while sending", async () => {
    const gate = deferred();
    const onSend = mock(() => gate.promise);
    useEnvironmentStore.setState({ environments: [createLocalEnvironment()] });
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Send while picker is open");
    renderComposeBar({ onSend });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Add attachment" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  test("sends an attachment-only prompt", async () => {
    const attachment = {
      id: "attachment-only",
      type: "image" as const,
      path: "/workspace/attachment.png",
      previewUrl: "data:image/png;base64,abc",
      name: "attachment.png",
    };
    useClaudeStore.getState().addAttachment(SESSION_KEY, attachment);
    const { onSend } = renderComposeBar();

    const sendButton = screen.getByTitle("Send message");
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("", [attachment], "high", false, false);
    });
    expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(0);
  });

  test("retains the draft and reports an error when sending fails", async () => {
    const onSend = mock(async () => {
      throw new Error("bridge unavailable");
    });
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Keep this prompt");
    renderComposeBar({ onSend });

    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(false);
    });
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("Keep this prompt");
  });

  test("retains a busy draft and reports an error when queueing fails", async () => {
    const onQueue = mock(async () => {
      throw new Error("queue unavailable");
    });
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Keep queued prompt");
    renderComposeBar({ isLoading: true, onQueue });

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(screen.getByTitle("Add to queue").hasAttribute("disabled")).toBe(false);
    });
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Keep queued prompt",
    );
  });

  test("falls back to onSend while loading when no queue callback is available", async () => {
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Send through fallback");
    const { onSend } = renderComposeBar({ isLoading: true, onQueue: undefined });

    fireEvent.click(screen.getByTitle("Add to queue"));

    // Claude does not refuse a busy submit: without a queue callback the
    // prompt is dispatched immediately rather than dropped.
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        "Send through fallback",
        [],
        "high",
        false,
        false,
      );
    });
    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("");
    });
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
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
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

  test("keeps the queue and draft unchanged when restoring a queued prompt fails", async () => {
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
      id: "queue-rejected-edit",
      text: "Queued follow-up",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
    });
    mockTransferPromptQueueMessageToComposeDraft.mockRejectedValueOnce(
      new Error("Queue storage is unavailable"),
    );

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued follow-up"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not confirm the prompt queue update",
    );
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("");
    expect(useClaudeStore.getState().getQueueLength(SESSION_KEY)).toBe(1);
    expect(screen.getByText("Queued follow-up")).toBeTruthy();
  });

  test("explains that an occupied composer blocks editing instead of overwriting it", async () => {
    /**
     * This used to discard whatever the user had typed. The backend now refuses
     * to overwrite a draft it did not create, so without a local guard the click
     * failed with the generic "wait for the queue to refresh" banner — advice
     * that would never resolve the situation.
     */
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Existing draft");
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
      id: "queue-blocked-edit",
      text: "Queued follow-up",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
    });

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued follow-up"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Send or clear it before editing a queued prompt",
    );
    expect(mockTransferPromptQueueMessageToComposeDraft).not.toHaveBeenCalled();
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe(
      "Existing draft",
    );
    expect(useClaudeStore.getState().getQueueLength(SESSION_KEY)).toBe(1);
  });

  test("translates the backend's occupied-draft refusal into the same guidance", async () => {
    // A draft record can outlive the local composer for as long as the compose
    // bar's debounced discard is still in flight.
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
      id: "queue-stale-draft",
      text: "Queued follow-up",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
    });
    mockTransferPromptQueueMessageToComposeDraft.mockRejectedValueOnce(
      new Error("Compose draft already exists"),
    );

    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));
    fireEvent.click(screen.getByText("Queued follow-up"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Send or clear it before editing a queued prompt",
    );
    expect(useClaudeStore.getState().getQueueLength(SESSION_KEY)).toBe(1);
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

  test("navigates slash commands with arrows and selects with Tab", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/" } });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("/clear ");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("Escape closes slash selection so Enter sends the literal draft", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");
    fireEvent.change(input, { target: { value: "/rev" } });

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("/rev", [], "high", false, false);
    });
  });

  test("Shift+Enter preserves a multiline draft without submitting", () => {
    const { onSend, onQueue } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");

    fireEvent.change(input, { target: { value: "first line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("first line");
  });

  test("toggles plan mode with Shift+Tab without submitting", async () => {
    const { onSend } = renderComposeBar();
    const input = screen.getByTestId("mentionable-input");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    await waitFor(() => {
      expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);
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

  test("portals the attachment menu and attaches a workspace file", async () => {
    useEnvironmentStore.setState({ environments: [createLocalEnvironment()] });
    mockGetLocalFileTree.mockResolvedValue([{
      name: "requirements.md",
      path: "docs/requirements.md",
      isDirectory: false,
      extension: ".md",
    }]);
    const { container } = renderComposeBar();
    const toolbar = container.querySelector("[data-native-compose-toolbar]")!;

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    const menu = await screen.findByRole("menu");
    expect(toolbar.contains(menu)).toBe(false);

    fireEvent.click(screen.getByRole("menuitem", { name: "Attach file from workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: /requirements\.md/ }));

    await waitFor(() => {
      expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toEqual([
        expect.objectContaining({
          type: "file",
          path: "/tmp/claude-worktree/docs/requirements.md",
          name: "requirements.md",
        }),
      ]);
    });
  });

  test("rejects an invalid workspace selection without adding an attachment", async () => {
    useEnvironmentStore.setState({ environments: [createLocalEnvironment()] });
    mockGetLocalFileTree.mockResolvedValue([{
      name: "secret.txt",
      path: "../secret.txt",
      isDirectory: false,
      extension: ".txt",
    }]);
    renderComposeBar();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /secret\.txt/ }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Cannot attach file",
        expect.objectContaining({
          description: "Environment not properly configured for attachments",
        }),
      );
    });
    expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toEqual([]);
  });

  test("attaches and forwards a container image, then restores input focus", async () => {
    mockGetFileTree.mockResolvedValue([{
      name: "diagram.PNG",
      path: "assets/diagram.PNG",
      isDirectory: false,
      extension: ".PNG",
    }]);
    const { onSend } = renderComposeBar({ containerId: "container-1" });
    const focusCountAfterMount = mockInputFocus.mock.calls.length;

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /diagram\.PNG/ }));

    await waitFor(() => {
      expect(mockInputFocus.mock.calls.length).toBeGreaterThan(focusCountAfterMount);
      expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toEqual([
        expect.objectContaining({
          type: "image",
          path: "/workspace/assets/diagram.PNG",
          name: "diagram.PNG",
        }),
      ]);
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        "",
        [
          expect.objectContaining({
            type: "image",
            path: "/workspace/assets/diagram.PNG",
          }),
        ],
        "high",
        false,
        false,
      );
    });
  });

  test("reports file search failures", async () => {
    mockGetLocalFileTree.mockRejectedValue(new Error("tree unavailable"));
    useEnvironmentStore.setState({ environments: [createLocalEnvironment()] });
    renderComposeBar();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to load files for @mentions",
        expect.objectContaining({ description: "tree unavailable" }),
      );
    });
  });

  test("stops loading and removes an attachment", async () => {
    const { onStop } = renderComposeBar({ isLoading: true });

    fireEvent.click(screen.getByTitle("Stop current query"));
    act(() => {
      useClaudeStore.getState().addAttachment(SESSION_KEY, {
        id: "remove-me",
        type: "file",
        path: "/workspace/remove-me.txt",
        name: "remove-me.txt",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove remove-me.txt" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toEqual([]);
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
      expect(useClaudeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1);
    });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });

  test("removes queued prompts from the dialog", async () => {
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
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

  test("shows an empty queue when the indicator count is stale", () => {
    // queueLength is supplied by the chat tab; the dialog reads the store, so a
    // stale indicator must not render phantom rows.
    renderComposeBar({ queueLength: 1 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("Queue is empty.")).toBeTruthy();
  });

  test("renders queued prompt metadata and attachment pluralization", () => {
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
      id: "metadata-one",
      text: "Plan carefully",
      attachments: [{
        id: "one",
        type: "image",
        path: "/workspace/one.png",
        previewUrl: "data:image/png;base64,abc",
        name: "one.png",
      }],
      effort: "max",
      planModeEnabled: true,
      fastModeEnabled: true,
    });
    seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
      id: "metadata-two",
      text: "Build carefully",
      attachments: [
        {
          id: "two",
          type: "image",
          path: "/workspace/two.png",
          previewUrl: "data:image/png;base64,abc",
          name: "two.png",
        },
        {
          id: "three",
          type: "image",
          path: "/workspace/three.png",
          previewUrl: "data:image/png;base64,abc",
          name: "three.png",
        },
      ],
      effort: "low",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    const { unmount } = renderComposeBar({ queueLength: 2 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("Effort: Max")).toBeTruthy();
    expect(screen.getByText("Effort: Low")).toBeTruthy();
    // Plan and fast mode are only labelled for the prompt that enabled them.
    expect(screen.getAllByText("Plan mode")).toHaveLength(1);
    expect(screen.getAllByText("Fast mode")).toHaveLength(1);
    expect(screen.getByText("1 attachment")).toBeTruthy();
    expect(screen.getByText("2 attachments")).toBeTruthy();

    // The dialog is portalled outside the render container; unmount explicitly
    // so its rows cannot leak into the next test's queries.
    unmount();
  });

  test("enforces queue movement boundaries and reorders queued prompts", async () => {
    for (const [id, text] of [
      ["queue-1", "First queued prompt"],
      ["queue-2", "Second queued prompt"],
    ] as const) {
      seedQueuedPrompt(useClaudeStore.getState(), SESSION_KEY, {
        id,
        text,
        attachments: [],
        effort: "high",
        planModeEnabled: false,
      });
    }

    renderComposeBar({ queueLength: 2 });
    fireEvent.click(screen.getByTitle("View queued prompts"));

    expect(screen.getAllByTitle("Move up")[0]?.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByTitle("Move down")[1]?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getAllByTitle("Move down")[0]!);

    await waitFor(() => {
      expect(useClaudeStore.getState().getQueuedMessages(SESSION_KEY)[0]?.id).toBe(
        "queue-2",
      );
    });
  });

  describe("fast mode toggle", () => {
    test("disables speed choices when the selected model does not support fast mode", () => {
      // Opus is the default (first) model and has supportsFastMode: false.
      renderComposeBar();
      fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
      expect(screen.getByRole("menuitemradio", { name: /^Fast/ }).hasAttribute("data-disabled"))
        .toBe(true);
      expect(screen.getByRole("menuitemradio", { name: /^Normal/ }).hasAttribute("data-disabled"))
        .toBe(true);
    });

    test("renders the Fast button when the selected model supports fast mode", () => {
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      renderComposeBar();
      fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
      expect(screen.getByText("Fast")).toBeTruthy();
    });

    test("toggles fast mode in the store when the button is clicked", async () => {
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      renderComposeBar();

      fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
      const fastButton = screen.getByRole("menuitemradio", { name: /^Fast Lower latency/ });
      expect(fastButton).toBeTruthy();

      fireEvent.click(fastButton!);
      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(true);
      });
      expect(screen.getByLabelText(/Sonnet \(High ⚡\)/)).toBeTruthy();

      fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^Normal Standard speed/ }));
      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
    });

    test("resets fast mode when the selected model switches to one that doesn't support it", async () => {
      // Start on a supporting model with fast mode on.
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "sonnet");
      useClaudeStore.getState().setFastMode(SESSION_KEY, true);
      renderComposeBar();

      expect(screen.getByLabelText(/Sonnet \(High ⚡\)/)).toBeTruthy();

      // Switch to the non-supporting model; the component's normalization
      // effect must clear stored fast mode to keep UI and state in sync.
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "opus");

      await waitFor(() => {
        expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
      expect(screen.queryByLabelText(/⚡/)).toBeNull();
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
