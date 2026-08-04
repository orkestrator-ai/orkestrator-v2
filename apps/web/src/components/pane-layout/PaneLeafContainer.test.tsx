import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import * as realClaudeChatTab from "@/components/claude/ClaudeChatTab";
import * as realClaudeTmuxChatTab from "@/components/claude/ClaudeTmuxChatTab";
import * as realCodexChatTab from "@/components/codex/CodexChatTab";
import * as realOpenCodeChatTab from "@/components/opencode/OpenCodeChatTab";
import * as realBrowserTab from "@/components/browser/BrowserTab";
import * as realLoopedReviewTab from "@/components/review/LoopedReviewTab";
import * as realFileViewerTab from "@/components/terminal/FileViewerTab";
import * as realBuildChatTab from "@/components/build-pipeline/BuildChatTab";

const realClaudeChatTabSnapshot = { ...realClaudeChatTab };
const realClaudeTmuxChatTabSnapshot = { ...realClaudeTmuxChatTab };
const realCodexChatTabSnapshot = { ...realCodexChatTab };
const realOpenCodeChatTabSnapshot = { ...realOpenCodeChatTab };
const realBrowserTabSnapshot = { ...realBrowserTab };
const realLoopedReviewTabSnapshot = { ...realLoopedReviewTab };
const realFileViewerTabSnapshot = { ...realFileViewerTab };
const realBuildChatTabSnapshot = { ...realBuildChatTab };

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
  DraggableTabBar: ({
    onTabSelect,
    onTabRefresh,
  }: {
    onTabSelect: (tabId: string) => void;
    onTabRefresh?: (tabId: string) => void;
  }) => (
    <>
      <button type="button" onClick={() => onTabSelect("tab-2")}>
        Select tab 2
      </button>
      <button type="button" onClick={() => onTabRefresh?.("tab-claude")}>
        Refresh Claude tab
      </button>
      <button type="button" onClick={() => onTabRefresh?.("tab-tmux")}>
        Refresh tmux tab
      </button>
      <button type="button" onClick={() => onTabRefresh?.("tab-codex")}>
        Refresh Codex tab
      </button>
      <button type="button" onClick={() => onTabRefresh?.("tab-opencode")}>
        Refresh OpenCode tab
      </button>
      <button type="button" onClick={() => onTabRefresh?.("tab-browser")}>
        Refresh Browser tab
      </button>
    </>
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
    initialAgentModel,
    initialReasoningEffort,
    agentHandoffId,
    consumedAgentHandoffId,
    refreshRequestId,
    ownsGlobalShortcuts,
  }: {
    tabId: string;
    isReviewTab?: boolean;
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    agentHandoffId?: string;
    consumedAgentHandoffId?: string;
    refreshRequestId?: number;
    ownsGlobalShortcuts?: boolean;
  }) => (
    <div
      data-agent-model={initialAgentModel}
      data-agent-handoff-id={agentHandoffId}
      data-consumed-agent-handoff-id={consumedAgentHandoffId}
      data-reasoning-effort={initialReasoningEffort}
      data-refresh-request-id={refreshRequestId}
      data-review-tab={String(Boolean(isReviewTab))}
      data-owns-global-shortcuts={String(Boolean(ownsGlobalShortcuts))}
      data-testid="claude-tab"
    >
      claude:{tabId}
    </div>
  ),
}));

mock.module("@/components/claude/ClaudeTmuxChatTab", () => ({
  ClaudeTmuxChatTab: ({
    tabId,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
    refreshRequestId,
    ownsGlobalShortcuts,
  }: {
    tabId: string;
    isReviewTab?: boolean;
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    refreshRequestId?: number;
    ownsGlobalShortcuts?: boolean;
  }) => (
    <div
      data-agent-model={initialAgentModel}
      data-reasoning-effort={initialReasoningEffort}
      data-refresh-request-id={refreshRequestId}
      data-review-tab={String(Boolean(isReviewTab))}
      data-owns-global-shortcuts={String(Boolean(ownsGlobalShortcuts))}
      data-testid="claude-tmux-tab"
    >
      tmux:{tabId}
    </div>
  ),
}));

mock.module("@/components/codex/CodexChatTab", () => ({
  CodexChatTab: ({
    tabId,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
    agentHandoffId,
    consumedAgentHandoffId,
    refreshRequestId,
    ownsGlobalShortcuts,
  }: {
    tabId: string;
    isReviewTab?: boolean;
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    agentHandoffId?: string;
    consumedAgentHandoffId?: string;
    refreshRequestId?: number;
    ownsGlobalShortcuts?: boolean;
  }) => (
    <div
      data-agent-model={initialAgentModel}
      data-agent-handoff-id={agentHandoffId}
      data-consumed-agent-handoff-id={consumedAgentHandoffId}
      data-reasoning-effort={initialReasoningEffort}
      data-refresh-request-id={refreshRequestId}
      data-review-tab={String(Boolean(isReviewTab))}
      data-owns-global-shortcuts={String(Boolean(ownsGlobalShortcuts))}
      data-testid="codex-tab"
    >
      codex:{tabId}
    </div>
  ),
}));

mock.module("@/components/opencode/OpenCodeChatTab", () => ({
  OpenCodeChatTab: ({
    tabId,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
    agentHandoffId,
    consumedAgentHandoffId,
    refreshRequestId,
    ownsGlobalShortcuts,
  }: {
    tabId: string;
    isReviewTab?: boolean;
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    agentHandoffId?: string;
    consumedAgentHandoffId?: string;
    refreshRequestId?: number;
    ownsGlobalShortcuts?: boolean;
  }) => (
    <div
      data-agent-model={initialAgentModel}
      data-agent-handoff-id={agentHandoffId}
      data-consumed-agent-handoff-id={consumedAgentHandoffId}
      data-reasoning-effort={initialReasoningEffort}
      data-refresh-request-id={refreshRequestId}
      data-review-tab={String(Boolean(isReviewTab))}
      data-owns-global-shortcuts={String(Boolean(ownsGlobalShortcuts))}
      data-testid="opencode-tab"
    >
      opencode:{tabId}
    </div>
  ),
}));

mock.module("@/components/browser/BrowserTab", () => ({
  BrowserTab: ({
    tabId,
    environmentId,
    data,
    isActive,
    refreshRequestId,
  }: {
    tabId: string;
    environmentId: string;
    data: { url: string };
    isActive: boolean;
    refreshRequestId?: number;
  }) => (
    <div
      data-active={String(isActive)}
      data-environment-id={environmentId}
      data-refresh-request-id={refreshRequestId}
      data-url={data.url}
      data-testid="browser-tab"
    >
      browser:{tabId}
    </div>
  ),
}));

mock.module("@/components/review/LoopedReviewTab", () => ({
  LoopedReviewTab: ({
    data,
    isActive,
  }: {
    data: { environmentId: string; workflowId: string };
    isActive: boolean;
  }) => (
    <div
      data-testid="looped-review-tab"
      data-environment-id={data.environmentId}
      data-workflow-id={data.workflowId}
      data-active={String(isActive)}
    />
  ),
}));

mock.module("@/components/terminal/FileViewerTab", () => ({
  FileViewerTab: ({
    tabId,
    environmentId,
    filePath,
  }: {
    tabId: string;
    environmentId?: string;
    filePath: string;
  }) => (
    <div
      data-testid="file-viewer-tab"
      data-tab-id={tabId}
      data-environment-id={environmentId}
      data-file-path={filePath}
    />
  ),
}));

/** Set to make the build tab throw during render, modelling a chunk failure. */
let buildChatTabFailure: Error | null = null;

mock.module("@/components/build-pipeline/BuildChatTab", () => ({
  BuildChatTab: ({
    data,
    isActive,
    ownsGlobalShortcuts,
  }: {
    data: { pipelineId: string; environmentId: string };
    isActive: boolean;
    ownsGlobalShortcuts?: boolean;
  }) => buildChatTabFailure ? (() => { throw buildChatTabFailure; })() : (
    <div
      data-testid="build-chat-tab"
      data-pipeline-id={data.pipelineId}
      data-environment-id={data.environmentId}
      data-active={String(isActive)}
      data-owns-global-shortcuts={String(Boolean(ownsGlobalShortcuts))}
    />
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
    mock.module(
      "@/components/browser/BrowserTab",
      () => realBrowserTabSnapshot,
    );
    mock.module(
      "@/components/review/LoopedReviewTab",
      () => realLoopedReviewTabSnapshot,
    );
    mock.module(
      "@/components/terminal/FileViewerTab",
      () => realFileViewerTabSnapshot,
    );
    mock.module(
      "@/components/build-pipeline/BuildChatTab",
      () => realBuildChatTabSnapshot,
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
      deletingEnvironments: new Set(),
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

  test("renders ClaudeTmuxChatTab for claude-tmux tabs", async () => {
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

    expect(await screen.findByTestId("claude-tmux-tab")).toBeDefined();
    expect(screen.getByText("tmux:tab-tmux")).toBeDefined();
  });

  test("forwards the owning environment to file draft recovery", async () => {
    const filePane = {
      kind: "leaf" as const,
      id: "pane-file",
      tabs: [{
        id: "tab-file",
        type: "file" as const,
        fileData: {
          filePath: "src/index.ts",
          isLocalEnvironment: true,
          worktreePath: "/workspace",
        },
      }],
      activeTabId: "tab-file",
    };

    render(
      <PaneLeafContainer
        pane={filePane}
        containerId={null}
        environmentId="env-hidden"
        isActive
      />,
    );

    expect(await screen.findByTestId("file-viewer-tab")).toMatchObject({
      dataset: {
        tabId: "tab-file",
        environmentId: "env-hidden",
        filePath: "src/index.ts",
      },
    });
  });

  test("grants global shortcut ownership only to the focused pane", async () => {
    const chatPane = {
      kind: "leaf" as const,
      id: "pane-chat",
      tabs: [
        {
          id: "tab-codex",
          type: "codex-native" as const,
          codexNativeData: { environmentId: "env-visible" },
        },
      ],
      activeTabId: "tab-codex",
    };
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      environments.set("env-visible", {
        root: chatPane,
        activePaneId: "another-pane",
        containerId: "container-visible",
      });
      return { environments };
    });

    const view = render(
      <PaneLeafContainer
        pane={chatPane}
        containerId="container-visible"
        environmentId="env-visible"
        isActive
      />,
    );

    const codexTab = await screen.findByTestId("codex-tab");

    expect(codexTab.getAttribute("data-owns-global-shortcuts")).toBe("false");

    fireEvent.click(view.container.firstElementChild as HTMLElement);
    await waitFor(() => {
      expect(codexTab.getAttribute("data-owns-global-shortcuts")).toBe("true");
    });
  });

  test("forwards review-tab state to native chat tabs", async () => {
    const reviewPane = {
      kind: "leaf" as const,
      id: "pane-review",
      tabs: [
        {
          id: "tab-claude",
          type: "claude-native" as const,
          isReviewTab: true,
          agentHandoffId: "handoff-claude",
          consumedAgentHandoffId: "consumed-claude",
          initialAgentModel: "claude-review",
          initialReasoningEffort: "high",
          claudeNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-tmux",
          type: "claude-tmux" as const,
          isReviewTab: true,
          initialAgentModel: "claude-tmux-review",
          initialReasoningEffort: "xhigh",
          claudeTmuxData: { environmentId: "env-visible" },
        },
        {
          id: "tab-codex",
          type: "codex-native" as const,
          isReviewTab: true,
          agentHandoffId: "handoff-codex",
          consumedAgentHandoffId: "consumed-codex",
          initialAgentModel: "codex-review",
          initialReasoningEffort: "medium",
          codexNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-opencode",
          type: "opencode-native" as const,
          isReviewTab: true,
          agentHandoffId: "handoff-opencode",
          consumedAgentHandoffId: "consumed-opencode",
          initialAgentModel: "provider/opencode-review",
          initialReasoningEffort: "deep",
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

    expect((await screen.findByTestId("claude-tab")).dataset.reviewTab).toBe("true");
    expect((await screen.findByTestId("claude-tmux-tab")).dataset.reviewTab).toBe("true");
    expect((await screen.findByTestId("codex-tab")).dataset.reviewTab).toBe("true");
    expect((await screen.findByTestId("opencode-tab")).dataset.reviewTab).toBe("true");
    for (const provider of ["claude", "codex", "opencode"] as const) {
      const tab = await screen.findByTestId(`${provider}-tab`);
      expect(tab.dataset.agentHandoffId).toBe(`handoff-${provider}`);
      // The consumed id is what keeps a resumed tab's bootstrap prompt hidden,
      // so it has to reach the chat tab alongside the live reference.
      expect(tab.dataset.consumedAgentHandoffId).toBe(`consumed-${provider}`);
    }
    expect((await screen.findByTestId("claude-tab")).dataset).toMatchObject({
      agentModel: "claude-review",
      reasoningEffort: "high",
    });
    expect((await screen.findByTestId("claude-tmux-tab")).dataset).toMatchObject({
      agentModel: "claude-tmux-review",
      reasoningEffort: "xhigh",
    });
    expect((await screen.findByTestId("codex-tab")).dataset).toMatchObject({
      agentModel: "codex-review",
      reasoningEffort: "medium",
    });
    expect((await screen.findByTestId("opencode-tab")).dataset).toMatchObject({
      agentModel: "provider/opencode-review",
      reasoningEffort: "deep",
    });
  });

  test("renders a looped-review tab with authoritative workflow identity", async () => {
    const pane = {
      kind: "leaf" as const,
      id: "pane-looped",
      tabs: [{
        id: "tab-looped",
        type: "looped-review" as const,
        loopedReviewTabData: {
          environmentId: "env-hidden",
          workflowId: "workflow-1",
        },
      }],
      activeTabId: "tab-looped",
    };

    render(
      <PaneLeafContainer
        pane={pane}
        environmentId="env-hidden"
        containerId="container-hidden"
        isActive
      />,
    );

    expect(await screen.findByTestId("looped-review-tab")).toMatchObject({
      dataset: {
        environmentId: "env-hidden",
        workflowId: "workflow-1",
        active: "true",
      },
    });
  });

  test("shows a visible fallback while loading and renders a build tab", async () => {
    const pane = {
      kind: "leaf" as const,
      id: "pane-build",
      tabs: [{
        id: "tab-build",
        type: "claude-build" as const,
        buildTabData: {
          pipelineId: "pipeline-1",
          environmentId: "env-hidden",
          taskId: "task-1",
        },
      }],
      activeTabId: "tab-build",
    };

    render(
      <PaneLeafContainer
        pane={pane}
        environmentId="env-hidden"
        containerId="container-hidden"
        isActive
      />,
    );

    expect(screen.getByText("Loading tab...")).toBeTruthy();
    expect(await screen.findByTestId("build-chat-tab")).toMatchObject({
      dataset: {
        pipelineId: "pipeline-1",
        environmentId: "env-hidden",
        active: "true",
      },
    });
  });

  test("gives the build tab the keyboard only while its pane holds focus", async () => {
    const pane = {
      kind: "leaf" as const,
      id: "pane-build",
      tabs: [{
        id: "tab-build",
        type: "claude-build" as const,
        buildTabData: {
          pipelineId: "pipeline-1",
          environmentId: "env-visible",
          taskId: "task-1",
        },
      }],
      activeTabId: "tab-build",
    };
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      environments.set("env-visible", {
        root: pane,
        activePaneId: "another-pane",
        containerId: "container-visible",
      });
      return { environments };
    });

    const view = render(
      <PaneLeafContainer
        pane={pane}
        environmentId="env-visible"
        containerId="container-visible"
        isActive
      />,
    );

    // The build transcript's find bar listens on the document, so a pane that
    // is merely visible must not claim Cmd+F from the focused one.
    const buildTab = await screen.findByTestId("build-chat-tab");
    expect(buildTab.getAttribute("data-active")).toBe("true");
    expect(buildTab.getAttribute("data-owns-global-shortcuts")).toBe("false");

    fireEvent.click(view.container.firstElementChild as HTMLElement);
    await waitFor(() => {
      expect(buildTab.getAttribute("data-owns-global-shortcuts")).toBe("true");
    });
  });

  test("scopes a tab load failure to its own pane instead of covering the app", async () => {
    buildChatTabFailure = new Error(
      "Failed to fetch dynamically imported module: /assets/build-1234.js",
    );
    const originalError = console.error;
    console.error = mock(() => undefined) as typeof console.error;
    const pane = {
      kind: "leaf" as const,
      id: "pane-build",
      tabs: [{
        id: "tab-build",
        type: "claude-build" as const,
        buildTabData: {
          pipelineId: "pipeline-1",
          environmentId: "env-hidden",
          taskId: "task-1",
        },
      }],
      activeTabId: "tab-build",
    };

    try {
      render(
        <PaneLeafContainer
          pane={pane}
          environmentId="env-hidden"
          containerId="container-hidden"
          isActive={false}
        />,
      );

      const alert = await screen.findByRole("alert");
      expect(screen.getByText("This part of the app failed to load")).toBeTruthy();
      // The pane is not on screen, so its failure must stay inside the pane box
      // and stay hidden rather than becoming a full-screen application modal.
      const surface = alert.parentElement!;
      expect(surface.className).toContain("absolute");
      expect(surface.className).toContain("hidden");
      expect(surface.className).not.toContain("fixed");
      // The chunk URL must never reach the DOM.
      expect(screen.queryByText(/assets\/build-1234\.js/)).toBeNull();
    } finally {
      console.error = originalError;
      buildChatTabFailure = null;
    }
  });

  test("shows a visible, correctly attributed failure for an active tab that throws", async () => {
    buildChatTabFailure = new Error("Cannot read properties of undefined (reading 'steps')");
    const originalError = console.error;
    console.error = mock(() => undefined) as typeof console.error;
    const pane = {
      kind: "leaf" as const,
      id: "pane-build",
      tabs: [{
        id: "tab-build",
        type: "claude-build" as const,
        buildTabData: {
          pipelineId: "pipeline-1",
          environmentId: "env-hidden",
          taskId: "task-1",
        },
      }],
      activeTabId: "tab-build",
    };

    try {
      render(
        <PaneLeafContainer
          pane={pane}
          environmentId="env-hidden"
          containerId="container-hidden"
          isActive
        />,
      );

      const alert = await screen.findByRole("alert");
      // The module loaded fine and then threw, so reloading for a fresh copy is
      // not the diagnosis and must not be presented as one.
      expect(screen.getByText("Something went wrong in this view")).toBeTruthy();
      expect(screen.queryByText("This part of the app failed to load")).toBeNull();
      expect(alert.parentElement!.className).not.toContain("hidden");
    } finally {
      console.error = originalError;
      buildChatTabFailure = null;
    }
  });

  test("forwards independent repeated refresh requests to every refreshable tab", async () => {
    const agentPane = {
      kind: "leaf" as const,
      id: "pane-agents",
      tabs: [
        {
          id: "tab-claude",
          type: "claude-native" as const,
          claudeNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-tmux",
          type: "claude-tmux" as const,
          claudeTmuxData: { environmentId: "env-visible" },
        },
        {
          id: "tab-codex",
          type: "codex-native" as const,
          codexNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-opencode",
          type: "opencode-native" as const,
          openCodeNativeData: { environmentId: "env-visible" },
        },
        {
          id: "tab-browser",
          type: "browser" as const,
          browserData: { url: "http://localhost:3000/" },
        },
      ],
      activeTabId: "tab-claude",
    };

    render(
      <PaneLeafContainer
        pane={agentPane}
        containerId="container-visible"
        environmentId="env-visible"
        isActive
      />,
    );

    const testIds = ["claude-tab", "claude-tmux-tab", "codex-tab", "opencode-tab", "browser-tab"];
    for (const testId of testIds) {
      expect((await screen.findByTestId(testId)).dataset.refreshRequestId).toBe("0");
    }

    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh tmux tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Codex tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh OpenCode tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Browser tab" }));
    expect((await screen.findByTestId("claude-tab")).dataset.refreshRequestId).toBe("1");
    expect((await screen.findByTestId("claude-tmux-tab")).dataset.refreshRequestId).toBe("1");
    expect((await screen.findByTestId("codex-tab")).dataset.refreshRequestId).toBe("1");
    expect((await screen.findByTestId("opencode-tab")).dataset.refreshRequestId).toBe("1");
    expect((await screen.findByTestId("browser-tab")).dataset.refreshRequestId).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Browser tab" }));
    expect((await screen.findByTestId("claude-tab")).dataset.refreshRequestId).toBe("2");
    expect((await screen.findByTestId("codex-tab")).dataset.refreshRequestId).toBe("1");
    expect((await screen.findByTestId("browser-tab")).dataset.refreshRequestId).toBe("2");
  });
});
