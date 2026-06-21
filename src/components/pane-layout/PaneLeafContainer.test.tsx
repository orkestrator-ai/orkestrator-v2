import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import * as realClaudeChatTab from "@/components/claude/ClaudeChatTab";
import * as realClaudeTmuxChatTab from "@/components/claude/ClaudeTmuxChatTab";
import * as realCodexChatTab from "@/components/codex/CodexChatTab";
import * as realOpenCodeChatTab from "@/components/opencode/OpenCodeChatTab";

const realClaudeChatTabSnapshot = { ...realClaudeChatTab };
const realClaudeTmuxChatTabSnapshot = { ...realClaudeTmuxChatTab };
const realCodexChatTabSnapshot = { ...realCodexChatTab };
const realOpenCodeChatTabSnapshot = { ...realOpenCodeChatTab };

mock.module("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  pointerWithin: () => [],
  rectIntersection: () => [],
  closestCenter: () => [],
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
  KeyboardCode: {
    Down: "ArrowDown",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Left: "ArrowLeft",
  },
  useDroppable: () => ({
    isOver: false,
    setNodeRef: () => {},
  }),
}));

mock.module("./DraggableTabBar", () => ({
  DraggableTabBar: ({ onTabSelect }: { onTabSelect: (tabId: string) => void }) => (
    <button type="button" onClick={() => onTabSelect("tab-2")}>
      Select tab 2
    </button>
  ),
}));

mock.module("./DropZoneOverlay", () => ({
  DropZoneOverlay: () => null,
}));

// Stub the chat tabs so PaneLeafContainer rendering doesn't pull in real
// stores or backend invoke. These are *for this file only* — see CLAUDE.md
// guidance on local mock.module usage.
mock.module("@/components/claude/ClaudeChatTab", () => ({
  ClaudeChatTab: ({
    tabId,
    isReviewTab,
  }: {
    tabId: string;
    isReviewTab?: boolean;
  }) => (
    <div data-review-tab={String(Boolean(isReviewTab))} data-testid="claude-tab">
      claude:{tabId}
    </div>
  ),
}));

mock.module("@/components/claude/ClaudeTmuxChatTab", () => ({
  ClaudeTmuxChatTab: ({
    tabId,
    isReviewTab,
  }: {
    tabId: string;
    isReviewTab?: boolean;
  }) => (
    <div data-review-tab={String(Boolean(isReviewTab))} data-testid="claude-tmux-tab">
      tmux:{tabId}
    </div>
  ),
}));

mock.module("@/components/codex/CodexChatTab", () => ({
  CodexChatTab: ({
    tabId,
    isReviewTab,
  }: {
    tabId: string;
    isReviewTab?: boolean;
  }) => (
    <div data-review-tab={String(Boolean(isReviewTab))} data-testid="codex-tab">
      codex:{tabId}
    </div>
  ),
}));

mock.module("@/components/opencode/OpenCodeChatTab", () => ({
  OpenCodeChatTab: ({
    tabId,
    isReviewTab,
  }: {
    tabId: string;
    isReviewTab?: boolean;
  }) => (
    <div data-review-tab={String(Boolean(isReviewTab))} data-testid="opencode-tab">
      opencode:{tabId}
    </div>
  ),
}));

mock.module("@/stores/terminalPortalStore", () => ({
  createTerminalKey: (environmentId: string, tabId: string) => `${environmentId}::${tabId}`,
  useTerminalPortalStore: <T,>(selector: (state: {
    registerPaneHost: (environmentId: string, paneId: string, host: HTMLDivElement) => void;
    unregisterPaneHost: (environmentId: string, paneId: string) => void;
    terminals: Map<string, unknown>;
  }) => T) =>
    selector({
      registerPaneHost: () => {},
      unregisterPaneHost: () => {},
      terminals: new Map(),
    }),
}));

const { PaneLeafContainer } = await import("./PaneLeafContainer");

describe("PaneLeafContainer", () => {
  afterAll(() => {
    mock.module(
      "@/components/claude/ClaudeChatTab",
      () => realClaudeChatTabSnapshot,
    );
    mock.module(
      "@/components/claude/ClaudeTmuxChatTab",
      () => realClaudeTmuxChatTabSnapshot,
    );
    mock.module(
      "@/components/codex/CodexChatTab",
      () => realCodexChatTabSnapshot,
    );
    mock.module(
      "@/components/opencode/OpenCodeChatTab",
      () => realOpenCodeChatTabSnapshot,
    );
  });

  const hiddenPane = {
    kind: "leaf" as const,
    id: "pane-hidden",
    tabs: [
      { id: "tab-1", type: "plain" as const },
      { id: "tab-2", type: "plain" as const },
    ],
    activeTabId: "tab-1",
  };

  beforeEach(() => {
    cleanup();

    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-visible", {
          root: {
            kind: "leaf",
            id: "pane-visible",
            tabs: [{ id: "visible-tab", type: "plain" }],
            activeTabId: "visible-tab",
          },
          activePaneId: "pane-visible",
          containerId: "container-visible",
        }],
        ["env-hidden", {
          root: hiddenPane,
          activePaneId: "stale-pane",
          containerId: "container-hidden",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    useEnvironmentStore.setState({
      environments: [{
        id: "env-hidden",
        projectId: "project-1",
        name: "hidden",
        branch: "main",
        containerId: "container-hidden",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      }],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        repositories: {},
      },
    }));
  });

  test("clicking the pane scopes the active pane update to its environment", () => {
    const { container } = render(
      <PaneLeafContainer
        pane={hiddenPane}
        containerId="container-hidden"
        environmentId="env-hidden"
        isActive
      />
    );

    fireEvent.click(container.firstElementChild as HTMLElement);

    expect(usePaneLayoutStore.getState().environments.get("env-hidden")?.activePaneId).toBe("pane-hidden");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });

  test("tab selection updates the target environment without touching the active environment", () => {
    render(
      <PaneLeafContainer
        pane={hiddenPane}
        containerId="container-hidden"
        environmentId="env-hidden"
        isActive
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select tab 2" }));

    const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
    expect(envHidden?.root.kind).toBe("leaf");
    if (!envHidden || envHidden.root.kind !== "leaf") {
      throw new Error("env-hidden root should be a leaf");
    }

    expect(envHidden.root.activeTabId).toBe("tab-2");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });

  test("renders ClaudeTmuxChatTab for claude-tmux tabs", () => {
    const tmuxPane = {
      kind: "leaf" as const,
      id: "pane-tmux",
      tabs: [
        {
          id: "tab-tmux",
          type: "claude-tmux" as const,
          claudeTmuxData: { environmentId: "env-visible" },
        },
      ],
      activeTabId: "tab-tmux",
    };

    usePaneLayoutStore.setState((s) => {
      const envs = new Map(s.environments);
      envs.set("env-visible", {
        root: tmuxPane,
        activePaneId: "pane-tmux",
        containerId: "container-visible",
      });
      return { environments: envs };
    });

    render(
      <PaneLeafContainer
        pane={tmuxPane}
        containerId="container-visible"
        environmentId="env-visible"
        isActive
      />,
    );

    expect(screen.getByTestId("claude-tmux-tab")).toBeDefined();
    expect(screen.getByText("tmux:tab-tmux")).toBeDefined();
  });

  test("forwards review-tab state to native chat tabs", () => {
    const reviewPane = {
      kind: "leaf" as const,
      id: "pane-review",
      tabs: [
        {
          id: "tab-claude",
          type: "claude-native" as const,
          isReviewTab: true,
          claudeNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-tmux",
          type: "claude-tmux" as const,
          isReviewTab: true,
          claudeTmuxData: { environmentId: "env-visible" },
        },
        {
          id: "tab-codex",
          type: "codex-native" as const,
          isReviewTab: true,
          codexNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-opencode",
          type: "opencode-native" as const,
          isReviewTab: true,
          openCodeNativeData: { environmentId: "env-visible" },
        },
      ],
      activeTabId: "tab-claude",
    };

    render(
      <PaneLeafContainer
        pane={reviewPane}
        containerId="container-visible"
        environmentId="env-visible"
        isActive
      />,
    );

    expect(screen.getByTestId("claude-tab").dataset.reviewTab).toBe("true");
    expect(screen.getByTestId("claude-tmux-tab").dataset.reviewTab).toBe("true");
    expect(screen.getByTestId("codex-tab").dataset.reviewTab).toBe("true");
    expect(screen.getByTestId("opencode-tab").dataset.reviewTab).toBe("true");
  });
});
