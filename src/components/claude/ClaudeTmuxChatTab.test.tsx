import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createClaudeTmuxStateKey, useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { ClaudeMessage } from "@/lib/claude-client";

import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: mockIsAtBottom,
    isAtBottomRef: { current: mockIsAtBottom },
    scrollToBottom: mockScrollToBottom,
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer }: any) => (
    <div>
      {messages.length > 0
        ? messages.map((message: any, index: number) => (
            <div key={message.id}>
              {renderMessage(index, message, index > 0 ? messages[index - 1] : null)}
            </div>
          ))
        : emptyState}
      {footer}
    </div>
  ),
}));

mock.module("@/lib/claude-tmux-client", () => ({
  startSession: mock(async () => {}),
  stopSession: mock(async () => {}),
  interruptSession: mock(async () => {}),
  getStatus: mock(async () => null),
  getTranscript: mock(async () => []),
  getPendingHooks: mock(async () => []),
  submit: mock(async () => {}),
  switchModel: mock(async () => {}),
  switchEffort: mock(async () => {}),
  sendText: mock(async () => {}),
  sendKeys: mock(async () => {}),
  capturePane: mock(async () => ""),
  replyHook: mock(async () => {}),
  answerPreToolUse: mock(async () => {}),
  listPreviousSessions: mock(async () => []),
  subscribe: mock(async () => () => {}),
  resize: mock(async () => {}),
  CLAUDE_TMUX_EVENT: "claude-tmux:event",
}));

mock.module("@/lib/tauri", () => ({
  renameEnvironmentFromPrompt: mock(async () => {}),
  updateGlobalConfig: mock(async (config: any) => config),
  getFileTree: mock(async () => []),
  getLocalFileTree: mock(async () => []),
  writeContainerFile: mock(async () => {}),
  writeLocalFile: mock(async () => "/tmp/file.png"),
}));

import { ClaudeTmuxChatTab } from "./ClaudeTmuxChatTab";
import type { ClaudeTmuxData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const STATE_KEY = createClaudeTmuxStateKey(ENVIRONMENT_ID, TAB_ID);

function createData(overrides: Partial<ClaudeTmuxData> = {}): ClaudeTmuxData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function resetStores(): void {
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    effortLevels: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name: "test-env",
        branch: "main",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T10:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

function seedMessage(msg: Partial<ClaudeMessage> = {}): void {
  useClaudeTmuxStore.getState().setRunning(STATE_KEY, true, {
    environmentId: ENVIRONMENT_ID,
    sessionId: "session-1",
  });
  useClaudeTmuxStore.setState((state) => {
    const tabs = new Map(state.tabs);
    const existing = tabs.get(STATE_KEY)!;
    tabs.set(STATE_KEY, {
      ...existing,
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
          parts: [{ type: "text", content: "Hello" }],
          timestamp: "2026-04-15T10:00:00.000Z",
          ...msg,
        } as ClaudeMessage,
      ],
    });
    return { tabs };
  });
}

describe("ClaudeTmuxChatTab", () => {
  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
    mock.module(
      "@/components/chat/VirtualizedMessageList",
      () => realVirtualizedMessageListSnapshot,
    );
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    mockIsAtBottom = true;
    mockScrollToBottom.mockClear();
  });

  test("does not show scroll button when at bottom", () => {
    act(() => { seedMessage(); });

    render(
      <ClaudeTmuxChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Scroll to bottom of conversation" }),
    ).toBeNull();
  });

  test("shows scroll button inside compose dock when not at bottom, and scrolls on click", () => {
    mockIsAtBottom = false;
    act(() => { seedMessage(); });

    render(
      <ClaudeTmuxChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const scrollButton = screen.getByRole("button", {
      name: "Scroll to bottom of conversation",
    });
    expect(scrollButton.closest('[data-testid="compose-dock"]')).not.toBeNull();

    fireEvent.click(scrollButton);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });
});
