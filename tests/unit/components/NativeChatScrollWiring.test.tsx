import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as realHooks from "@/hooks";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

const realHooksSnapshot = { ...realHooks };
const useVirtuosoScrollStateMock = mock((options: any = {}) => ({
  isAtBottom: true,
  isAtBottomRef: { current: true },
  scrollToBottom: () => {},
  virtuosoRef: { current: null },
  scrollProps: {
    followOutput: () => false,
    atBottomStateChange: () => {},
    atBottomThreshold: 50,
    totalListHeightChanged: () => {},
    restoreStateFrom: undefined,
    scrollerRef: () => {},
  },
  __options: options,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: useVirtuosoScrollStateMock,
  useElapsedTimer: () => ({ elapsedSeconds: 0, finalElapsedSeconds: null }),
  clearPersistedVirtuosoState: () => {},
}));

const { ClaudeChatTab } = await import("@/components/claude/ClaudeChatTab");
const { CodexChatTab } = await import("@/components/codex/CodexChatTab");
const { OpenCodeChatTab } = await import("@/components/opencode/OpenCodeChatTab");

describe("native chat scroll wiring", () => {
  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
  });

  beforeEach(() => {
    cleanup();
    useVirtuosoScrollStateMock.mockClear();

    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    useClaudeStore.setState({
      clients: new Map(),
      sessions: new Map(),
      pendingQuestions: new Map(),
      pendingPlanApprovals: new Map(),
      messageQueue: new Map(),
      draftText: new Map(),
      attachments: new Map(),
    });
    useCodexStore.setState({
      clients: new Map(),
      sessions: new Map(),
      messageQueue: new Map(),
      draftText: new Map(),
      attachments: new Map(),
    });
    useOpenCodeStore.setState({
      clients: new Map(),
      sessions: new Map(),
      pendingQuestions: new Map(),
      pendingPermissions: new Map(),
      messageQueue: new Map(),
      draftText: new Map(),
      attachments: new Map(),
    });
  });

  test("Claude native passes its environmentId to the Virtuoso scroll hook", () => {
    render(
      <ClaudeChatTab
        tabId="tab-claude"
        data={{ environmentId: "env-claude", containerId: "container-1" }}
        isActive={false}
      />,
    );

    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: false,
      persistKey: "env-env-claude:tab-claude",
      environmentId: "env-claude",
      stickToBottomOnActivation: true,
    });
  });

  test("Codex native passes its environmentId to the Virtuoso scroll hook", () => {
    render(
      <CodexChatTab
        tabId="tab-codex"
        data={{ environmentId: "env-codex", containerId: "container-1" }}
        isActive={false}
      />,
    );

    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: false,
      persistKey: "env-env-codex:tab-codex",
      environmentId: "env-codex",
      stickToBottomOnActivation: true,
    });
  });

  test("OpenCode native passes its environmentId to the Virtuoso scroll hook", () => {
    render(
      <OpenCodeChatTab
        tabId="tab-opencode"
        data={{ environmentId: "env-opencode", containerId: "container-1" }}
        isActive={false}
      />,
    );

    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: false,
      persistKey: "env-env-opencode:tab-opencode",
      environmentId: "env-opencode",
      stickToBottomOnActivation: true,
    });
  });
});
