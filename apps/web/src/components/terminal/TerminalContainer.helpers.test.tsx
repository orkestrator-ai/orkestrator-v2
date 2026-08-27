import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { useEffect, useRef, type ReactNode } from "react";

import { act, cleanup, render, waitFor } from "@testing-library/react";

import {
  MAX_TABS,
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateFileTabOptions,
  type CreateTabOptions,
} from "@/contexts";

import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";

import { useConfigStore } from "@/stores/configStore";

import { useEnvironmentStore } from "@/stores/environmentStore";

import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

import { useNativeComposeStore } from "@/stores/nativeComposeStore";

import { useBuildPipelineStore } from "@/stores/buildPipelineStore";

import { useLoopedReviewStore, type LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

import { useTerminalSessionStore } from "@/stores/terminalSessionStore";

import { createSessionKey as createNativeSessionKey } from "@/lib/utils";

import { type PaneLeaf, type PersistedPaneLayout } from "@/types/paneLayout";

import type { EnsureEnvironmentSetupResult, EnvironmentSetupSession } from "@/types";

import type { CollisionDetection } from "@dnd-kit/core";

import * as realBackend from "@/lib/backend";

import * as realSetupCommands from "@/lib/setup-commands";

import { requestTerminalBrowserTab } from "@/lib/terminal-links";

import * as realDndKitCore from "@dnd-kit/core";

import { mockToastError } from "../../../../../tests/mocks/sonner";

import * as realNativeEvents from "@/lib/native/events";

import { listen } from "@/lib/native/events";

const realBackendSnapshot = { ...realBackend };

const realSetupCommandsSnapshot = { ...realSetupCommands };

const realDndKitCoreSnapshot = { ...realDndKitCore };

// `@/lib/native/events` is mocked once in tests/setup.ts and shared with every
// other suite. Snapshot it here so `afterAll` can put the module back, and
// remember the default `listen` behaviour that setup.ts installed so the
// `listenMock.mockReset()` in `beforeEach` cannot leak an implementation-less
// mock into a file that runs after this one.
const realNativeEventsSnapshot = { ...realNativeEvents };

const originalOrkestrator = window.orkestrator;

const listenMock = listen as ReturnType<typeof mock>;

const defaultListenImplementation = () => Promise.resolve(() => {});

type DndContextHarnessProps = {
  children: ReactNode;
  collisionDetection: (args: never) => Array<{ id: string }>;
  onDragStart: (event: { active: { id: string } }) => void;
  onDragOver: (event: { over: { id: string } | null }) => void;
  onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
};

let latestDndContextProps: DndContextHarnessProps | null = null;

const pointerWithinMock = mock<CollisionDetection>((_args) => []);

const rectIntersectionMock = mock<CollisionDetection>((_args) => []);

const closestCenterMock = mock<CollisionDetection>((_args) => []);

mock.module("@dnd-kit/core", () => ({
  ...realDndKitCoreSnapshot,
  DndContext: (props: DndContextHarnessProps) => {
    latestDndContextProps = props;
    return <>{props.children}</>;
  },
  pointerWithin: pointerWithinMock,
  rectIntersection: rectIntersectionMock,
  closestCenter: closestCenterMock,
}));

const markSetupScriptsCompleteMock = mock(() => {});

const getSetupCommandsMock = mock(async (): Promise<string[] | null> => null);

const ensureEnvironmentSetupMock = mock(
  async (environmentId: string): Promise<EnsureEnvironmentSetupResult> => {
    const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
    return {
      setupStarted: false,
      environment: {
        ...environment,
        setupScriptsComplete: true,
      },
    };
  },
);

const runEnvironmentSetupMock = mock(async (environmentId: string) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  setupScriptsComplete: true,
}));

const getEnvironmentSetupSessionMock = mock(
  async (_environmentId: string): Promise<EnvironmentSetupSession | null> => null,
);

const awaitEnvironmentSetupSessionMock = mock(
  async (environmentId: string): Promise<EnvironmentSetupSession | null> =>
    getEnvironmentSetupSessionMock(environmentId),
);

const setEnvironmentPendingAgentLaunchMock = mock(
  async (environmentId: string, pending: boolean) => ({
    ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
    pendingAgentLaunch: pending,
    ...(pending
      ? {}
      : {
          initialAgentModel: undefined,
          initialReasoningEffort: undefined,
        }),
  }),
);

const acknowledgeStartupAgentSessionMock = mock(async (environmentId: string) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  startupAgentSession: undefined,
}));

const setEnvironmentInitialPromptMock = mock(
  async (environmentId: string, initialPrompt: string) => ({
    ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
    initialPrompt,
  }),
);

const savePaneLayoutMock = mock(
  async (
    environmentId: string,
    layout: Parameters<typeof realBackend.savePaneLayout>[1],
    _expectedRevision: number,
  ): Promise<PersistedPaneLayout> => ({
    ...layout,
    environmentId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  }),
);

const getPaneLayoutMock = mock(
  async (_environmentId: string): Promise<PersistedPaneLayout | null> => null,
);

const deletePaneLayoutMock = mock(async (_environmentId: string, _expectedRevision?: number) => {});

const listLoopedReviewWorkflowsMock = mock(
  async (_environmentId: string) =>
    [] as Array<{
      version: number;
      id: string;
      environmentId: string;
      snapshot: LoopedReviewWorkflow;
      updatedAt: string;
      revision: number;
    }>,
);

const writeContainerFileMock = mock(
  async (_containerId: string, filePath: string, _base64Data: string) => `/workspace/${filePath}`,
);

const writeLocalFileMock = mock(
  async (worktreePath: string, filePath: string, _base64Data: string) =>
    `${worktreePath}/${filePath}`,
);

const writeInitialPromptAttachmentsMock = mock(
  async (
    environmentId: string,
    attachments: Parameters<typeof realBackend.writeInitialPromptAttachments>[1],
  ) => {
    const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const usedNames = new Set<string>();
    return Promise.all(
      attachments.map(async (attachment) => {
        const sanitized = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "-");
        const dot = sanitized.lastIndexOf(".");
        const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
        const extension = dot > 0 ? sanitized.slice(dot) : "";
        let name = sanitized;
        let suffix = 2;
        while (usedNames.has(name.toLowerCase())) {
          name = `${stem}-${suffix}${extension}`;
          suffix += 1;
        }
        usedNames.add(name.toLowerCase());
        const relativePath = `.orkestrator/initial-prompt/${name}`;
        const savedPath =
          environment.environmentType === "local"
            ? await writeLocalFileMock(
                environment.worktreePath!,
                relativePath,
                attachment.base64Data,
              )
            : await writeContainerFileMock(
                environment.containerId!,
                relativePath,
                attachment.base64Data,
              );
        return { name, path: savedPath };
      }),
    );
  },
);

mock.module("@/lib/setup-commands", () => ({
  ...realSetupCommandsSnapshot,
  shouldAutoResolveSetupCommands: ({
    isLocalEnvironment,
    isLocalEnvironmentReady,
    setupCommandsResolved,
    hasPendingCommands,
  }: {
    isLocalEnvironment: boolean;
    isLocalEnvironmentReady: boolean;
    setupCommandsResolved: boolean;
    hasPendingCommands: boolean;
  }) =>
    isLocalEnvironment && isLocalEnvironmentReady && !setupCommandsResolved && !hasPendingCommands,
  markSetupScriptsComplete: markSetupScriptsCompleteMock,
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getSetupCommands: getSetupCommandsMock,
  ensureEnvironmentSetup: ensureEnvironmentSetupMock,
  runEnvironmentSetup: runEnvironmentSetupMock,
  getEnvironmentSetupSession: getEnvironmentSetupSessionMock,
  awaitEnvironmentSetupSession: awaitEnvironmentSetupSessionMock,
  setEnvironmentPendingAgentLaunch: setEnvironmentPendingAgentLaunchMock,
  acknowledgeStartupAgentSession: acknowledgeStartupAgentSessionMock,
  setEnvironmentInitialPrompt: setEnvironmentInitialPromptMock,
  savePaneLayout: savePaneLayoutMock,
  getPaneLayout: getPaneLayoutMock,
  deletePaneLayout: deletePaneLayoutMock,
  listLoopedReviewWorkflows: listLoopedReviewWorkflowsMock,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
  writeInitialPromptAttachments: writeInitialPromptAttachmentsMock,
}));

mock.module("@/components/pane-layout", () => ({
  PaneTree: () => null,
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

mock.module("./TerminalPortalHost", () => ({
  TerminalPortalHost: () => null,
}));

mock.module("./InitializationLogs", () => ({
  InitializationLogs: ({ containerId }: { containerId: string }) => (
    <div data-testid="initialization-logs">{containerId}</div>
  ),
}));

const { TerminalContainer, createTerminalCollisionDetection, getTerminalTabDragEndAction } =
  await import("./TerminalContainer");

describe("TerminalContainer", () => {
  afterAll(() => {
    window.orkestrator = originalOrkestrator;
    mock.module("@/lib/setup-commands", () => realSetupCommandsSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
    mock.module("@dnd-kit/core", () => realDndKitCoreSnapshot);
    listenMock.mockReset();
    listenMock.mockImplementation(defaultListenImplementation);
    mock.module("@/lib/native/events", () => realNativeEventsSnapshot);
  });

  beforeEach(() => {
    cleanup();
    window.orkestrator = originalOrkestrator;
    latestDndContextProps = null;
    pointerWithinMock.mockReset();
    pointerWithinMock.mockReturnValue([]);
    rectIntersectionMock.mockReset();
    rectIntersectionMock.mockReturnValue([]);
    closestCenterMock.mockReset();
    closestCenterMock.mockReturnValue([]);
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);

    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-visible",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "visible-tab", type: "plain" }],
              activeTabId: "visible-tab",
            },
            activePaneId: "default",
            containerId: "container-visible",
          },
        ],
      ]),
      hydration: new Map(),
      activeEnvironmentId: "env-visible",
    });

    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-visible",
          projectId: "project-1",
          name: "visible",
          branch: "main",
          containerId: "container-visible",
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "containerized",
          setupPhase: "ready",
        },
        {
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
          order: 1,
          environmentType: "containerized",
          setupPhase: "ready",
        },
      ],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set(),
    });
    useTerminalSessionStore.setState({
      sessions: new Map(),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });
    useNativeComposeStore.setState({ drafts: new Map() });
    useLoopedReviewStore.setState({ workflows: new Map() });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });

    markSetupScriptsCompleteMock.mockClear();
    getSetupCommandsMock.mockReset();
    getSetupCommandsMock.mockResolvedValue(null);
    ensureEnvironmentSetupMock.mockReset();
    ensureEnvironmentSetupMock.mockImplementation(async (environmentId: string) => {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
      return {
        setupStarted: false,
        environment: {
          ...environment,
          setupScriptsComplete: true,
        },
      };
    });
    runEnvironmentSetupMock.mockReset();
    runEnvironmentSetupMock.mockImplementation(async (environmentId: string) => ({
      ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
      setupScriptsComplete: true,
    }));
    getEnvironmentSetupSessionMock.mockReset();
    getEnvironmentSetupSessionMock.mockResolvedValue(null);
    awaitEnvironmentSetupSessionMock.mockClear();
    setEnvironmentPendingAgentLaunchMock.mockReset();
    setEnvironmentPendingAgentLaunchMock.mockImplementation(
      async (environmentId: string, pending: boolean) => ({
        ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
        pendingAgentLaunch: pending,
        ...(pending
          ? {}
          : {
              initialAgentModel: undefined,
              initialReasoningEffort: undefined,
            }),
      }),
    );
    acknowledgeStartupAgentSessionMock.mockReset();
    acknowledgeStartupAgentSessionMock.mockImplementation(async (environmentId: string) => ({
      ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
      startupAgentSession: undefined,
    }));
    setEnvironmentInitialPromptMock.mockReset();
    setEnvironmentInitialPromptMock.mockImplementation(
      async (environmentId: string, initialPrompt: string) => ({
        ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
        initialPrompt,
      }),
    );
    savePaneLayoutMock.mockClear();
    getPaneLayoutMock.mockReset();
    getPaneLayoutMock.mockResolvedValue(null);
    deletePaneLayoutMock.mockReset();
    deletePaneLayoutMock.mockResolvedValue(undefined);
    localStorage.clear();
    listLoopedReviewWorkflowsMock.mockReset();
    listLoopedReviewWorkflowsMock.mockResolvedValue([]);
    writeContainerFileMock.mockReset();
    writeLocalFileMock.mockReset();
    writeInitialPromptAttachmentsMock.mockClear();
    writeContainerFileMock.mockImplementation(
      async (_containerId: string, filePath: string) => `/workspace/${filePath}`,
    );
    writeLocalFileMock.mockImplementation(
      async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`,
    );

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            platforms: {
              ...state.config.global.agentSettings?.platforms,
              opencode: { mode: "terminal" },
              claude: { mode: "terminal", claudeNativeBackend: "sdk" },
              codex: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });
  });

  describe("createFileTab", () => {
    function CreateFileTabHarness({
      calls,
    }: {
      calls: Array<{ filePath: string; options?: CreateFileTabOptions }>;
    }) {
      const { createFileTab } = useTerminalContext();
      const didRunRef = useRef(false);
      useEffect(() => {
        if (!createFileTab || didRunRef.current) return;
        didRunRef.current = true;
        for (const call of calls) {
          createFileTab(call.filePath, call.options);
        }
      }, [createFileTab, calls]);
      return null;
    }

    test("creates container file tabs with diff metadata and validated git status", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateFileTabHarness
            calls={[
              { filePath: "src/App.tsx", options: { isDiff: true, gitStatus: "M" } },
              { filePath: "src/App.tsx", options: { isDiff: false, gitStatus: "invalid" } },
            ]}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const fileTabs = env.root.tabs.filter((tab) => tab.type === "file");
        expect(fileTabs).toHaveLength(2);
        expect(fileTabs[0]?.fileData).toEqual({
          filePath: "src/App.tsx",
          containerId: "container-visible",
          worktreePath: undefined,
          isLocalEnvironment: false,
          isDiff: true,
          gitStatus: "M",
          baseBranch: undefined,
        });
        expect(fileTabs[1]?.fileData?.isDiff).toBe(false);
        expect(fileTabs[1]?.fileData?.gitStatus).toBeUndefined();
      });
    });

    test("activates an existing matching file tab instead of duplicating it", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateFileTabHarness
            calls={[
              { filePath: "src/main.tsx", options: { isDiff: true, gitStatus: "A" } },
              { filePath: "src/main.tsx", options: { isDiff: true, gitStatus: "A" } },
            ]}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const fileTabs = env.root.tabs.filter((tab) => tab.type === "file");
        expect(fileTabs).toHaveLength(1);
        expect(env.root.activeTabId).toBe(fileTabs[0]?.id ?? null);
      });
    });

    test("activates an existing matching file tab at the limit without reporting an error", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: "existing-file",
                type: "file" as const,
                fileData: {
                  filePath: "src/existing.ts",
                  containerId: "container-visible",
                  isDiff: true,
                },
              },
              ...Array.from({ length: MAX_TABS - 1 }, (_, index) => ({
                id: `tab-${index}`,
                type: "plain" as const,
              })),
            ],
            activeTabId: "tab-0",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));
      mockToastError.mockClear();

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateFileTabHarness
            calls={[{ filePath: "src/existing.ts", options: { isDiff: true } }]}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!environment || environment.root.kind !== "leaf") {
          throw new Error("expected leaf");
        }
        expect(environment.root.tabs).toHaveLength(MAX_TABS);
        expect(environment.root.activeTabId).toBe("existing-file");
      });
      expect(mockToastError).not.toHaveBeenCalled();
    });

    test("creates local file tabs with worktree metadata and no container id", async () => {
      usePaneLayoutStore.setState({
        environments: new Map([
          [
            "env-visible",
            {
              root: {
                kind: "leaf",
                id: "default",
                tabs: [{ id: "visible-tab", type: "plain" }],
                activeTabId: "visible-tab",
              },
              activePaneId: "default",
              containerId: null,
            },
          ],
        ]),
        activeEnvironmentId: "env-visible",
      });
      useEnvironmentStore.setState((state) => ({
        ...state,
        environments: state.environments.map((env) =>
          env.id === "env-visible"
            ? {
                ...env,
                containerId: null,
                environmentType: "local",
                worktreePath: "/tmp/env-visible-worktree",
              }
            : env,
        ),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer environmentId="env-visible" containerId={null} isActive />
          <CreateFileTabHarness calls={[{ filePath: "README.md", options: { gitStatus: "?" } }]} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const fileTab = env.root.tabs.find((tab) => tab.type === "file");
        expect(fileTab?.fileData).toMatchObject({
          filePath: "README.md",
          containerId: undefined,
          worktreePath: "/tmp/env-visible-worktree",
          isLocalEnvironment: true,
          gitStatus: "?",
        });
      });
    });

    test("does not create a file tab after reaching the tab limit", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: Array.from({ length: MAX_TABS }, (_, index) => ({
              id: `tab-${index}`,
              type: "plain" as const,
            })),
            activeTabId: "tab-0",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateFileTabHarness calls={[{ filePath: "src/blocked.ts" }]} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const tabs = usePaneLayoutStore.getState().getAllTabs("env-visible");
        expect(tabs).toHaveLength(MAX_TABS);
        expect(tabs.some((tab) => tab.type === "file")).toBe(false);
      });
      expect(mockToastError).toHaveBeenCalledWith("Tab limit reached", {
        description: `You can have up to ${MAX_TABS} tabs open. Close a tab and try again.`,
        id: "tab-limit-reached",
      });
    });
  });

  describe("tab drag-end decisions", () => {
    const pane = (id: string, tabIds: string[]): PaneLeaf => ({
      kind: "leaf",
      id,
      tabs: tabIds.map((tabId) => ({ id: tabId, type: "plain" })),
      activeTabId: tabIds[0] ?? null,
    });

    test("returns split, same-pane reorder, cross-pane move, and self-collision move actions", () => {
      const panes = new Map([
        ["left", pane("left", ["a", "b", "c"])],
        ["right", pane("right", ["x", "y"])],
      ]);
      const getPane = (paneId: string) => panes.get(paneId) ?? null;

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "edge:right:bottom",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({
        type: "split",
        targetPaneId: "right",
        edge: "bottom",
        tabId: "a",
        fromPaneId: "left",
      });

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tab:c:pane:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "reorder", paneId: "left", fromIndex: 0, toIndex: 2 });

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:b:pane:left",
          overId: "tab:y:pane:right",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({
        type: "move",
        fromPaneId: "left",
        toPaneId: "right",
        tabId: "b",
        toIndex: 1,
      });

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:b:pane:left",
          overId: "tab:b:pane:left",
          lastDragOverPaneId: "right",
          getPane,
        }),
      ).toEqual({
        type: "move",
        fromPaneId: "left",
        toPaneId: "right",
        tabId: "b",
      });
    });

    test("returns none for invalid drops and no-op same-pane tabbar drops", () => {
      const getPane = (paneId: string) => (paneId === "left" ? pane("left", ["a"]) : null);

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: null,
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:missing:pane:left",
          overId: "tab:a:pane:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "not-a-tab",
          overId: "tab:a:pane:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      const getTwoPanes = (paneId: string) =>
        paneId === "left" ? pane("left", ["a"]) : paneId === "right" ? pane("right", ["x"]) : null;
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tab:missing:pane:right",
          lastDragOverPaneId: null,
          getPane: getTwoPanes,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tabbar:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:missing:pane:left",
          overId: "tabbar:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "not-a-drop-target",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tab:a:pane:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tab:missing:pane:right",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
    });

    test("moves across tabbars and reorders to the end of the same pane", () => {
      const panes = new Map([
        ["left", pane("left", ["a", "b", "c"])],
        ["right", pane("right", ["x"])],
      ]);
      const getPane = (paneId: string) => panes.get(paneId) ?? null;

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tabbar:right",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({
        type: "move",
        fromPaneId: "left",
        toPaneId: "right",
        tabId: "a",
      });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tabbar:left",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "reorder", paneId: "left", fromIndex: 0, toIndex: 2 });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tabbar:missing",
          lastDragOverPaneId: null,
          getPane,
        }),
      ).toEqual({ type: "none" });
    });

    test("prioritizes tabs in pointer and rectangle collisions, then falls back to closest center", () => {
      const collisionDetection = createTerminalCollisionDetection({
        pointerDetection: pointerWithinMock,
        rectangleDetection: rectIntersectionMock,
        nearestDetection: closestCenterMock,
      });

      pointerWithinMock.mockReturnValueOnce([
        { id: "edge:left:right" },
        { id: "tab:a:pane:left" },
        { id: "tabbar:right" },
      ]);
      expect(collisionDetection({} as never)).toEqual([
        { id: "tab:a:pane:left" },
        { id: "tabbar:right" },
      ]);
      expect(rectIntersectionMock).not.toHaveBeenCalled();

      pointerWithinMock.mockReturnValueOnce([{ id: "edge:left:right" }]);
      expect(collisionDetection({} as never)).toEqual([{ id: "edge:left:right" }]);

      pointerWithinMock.mockReturnValueOnce([]);
      rectIntersectionMock.mockReturnValueOnce([
        { id: "edge:left:right" },
        { id: "tab:a:pane:left" },
      ]);
      expect(collisionDetection({} as never)).toEqual([{ id: "tab:a:pane:left" }]);

      pointerWithinMock.mockReturnValueOnce([]);
      rectIntersectionMock.mockReturnValueOnce([{ id: "edge:left:right" }]);
      expect(collisionDetection({} as never)).toEqual([{ id: "edge:left:right" }]);

      pointerWithinMock.mockReturnValueOnce([]);
      rectIntersectionMock.mockReturnValueOnce([]);
      closestCenterMock.mockReturnValueOnce([{ id: "tabbar:right" }]);
      expect(collisionDetection({} as never)).toEqual([{ id: "tabbar:right" }]);
    });

    test("wires drag-over state into self-collision cross-pane moves and ignores cancelled drops", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [
                  { id: "a", type: "plain" },
                  { id: "b", type: "plain" },
                ],
                activeTabId: "a",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "x", type: "plain" }],
                activeTabId: "x",
              },
            ],
          },
          activePaneId: "left",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(latestDndContextProps).not.toBeNull());
      act(() => {
        latestDndContextProps!.onDragStart({ active: { id: "tab:a:pane:left" } });
        latestDndContextProps!.onDragOver({ over: { id: "tab:x:pane:right" } });
      });
      act(() => {
        latestDndContextProps!.onDragEnd({
          active: { id: "tab:a:pane:left" },
          over: { id: "tab:a:pane:left" },
        });
      });

      await waitFor(() => {
        expect(
          usePaneLayoutStore
            .getState()
            .getPane("left", "env-visible")
            ?.tabs.map((tab) => tab.id),
        ).toEqual(["b"]);
        expect(
          usePaneLayoutStore
            .getState()
            .getPane("right", "env-visible")
            ?.tabs.map((tab) => tab.id),
        ).toEqual(["x", "a"]);
      });

      const beforeCancelledDrop = usePaneLayoutStore.getState().environments.get("env-visible");
      act(() => {
        latestDndContextProps!.onDragOver({ over: null });
        latestDndContextProps!.onDragEnd({
          active: { id: "tab:b:pane:left" },
          over: null,
        });
      });
      expect(usePaneLayoutStore.getState().environments.get("env-visible")).toEqual(
        beforeCancelledDrop,
      );
    });

    test("wires tabbar hover, reorder, split, and unknown hover drag events", async () => {
      usePaneLayoutStore
        .getState()
        .addTab("default", { id: "second-tab", type: "plain" }, "env-visible");
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );
      await waitFor(() => expect(latestDndContextProps).not.toBeNull());

      act(() => {
        latestDndContextProps!.onDragOver({ over: { id: "tabbar:default" } });
        latestDndContextProps!.onDragOver({ over: { id: "unknown-target" } });
        latestDndContextProps!.onDragEnd({
          active: { id: "tab:visible-tab:pane:default" },
          over: { id: "tab:second-tab:pane:default" },
        });
      });
      expect(
        usePaneLayoutStore
          .getState()
          .getPane("default", "env-visible")
          ?.tabs.map((tab) => tab.id),
      ).toEqual(["second-tab", "visible-tab"]);

      act(() => {
        latestDndContextProps!.onDragEnd({
          active: { id: "tab:visible-tab:pane:default" },
          over: { id: "edge:default:right" },
        });
      });

      await waitFor(() => {
        expect(usePaneLayoutStore.getState().environments.get("env-visible")?.root.kind).toBe(
          "split",
        );
      });
    });
  });

  describe("createTab forwards displayTitle", () => {
    function CreateTabHarness({
      onResult,
      type,
      options,
    }: {
      onResult?: (created: boolean) => void;
      type: CreatableTabType;
      options: CreateTabOptions;
    }) {
      const { createTab } = useTerminalContext();
      useEffect(() => {
        if (createTab) {
          const created = createTab(type, options);
          onResult?.(created);
        }
      }, [createTab, onResult, type, options]);
      return null;
    }

    test("reports whether a looped-review tab was actually created", async () => {
      const accepted = mock((_created: boolean) => {});
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="looped-review"
            options={{ loopedReviewId: "workflow-1" }}
            onResult={accepted}
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(accepted).toHaveBeenCalledWith(true));
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
        expect.objectContaining({
          type: "looped-review",
          loopedReviewTabData: expect.objectContaining({
            workflowId: "workflow-1",
          }),
        }),
      );
    });

    test("creates a read-only Multi Review reviewer transcript tab", async () => {
      const accepted = mock((_created: boolean) => {});
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="multi-review"
            options={{
              multiReviewId: "multi-1",
              multiReviewReviewerId: "reviewer-1",
              displayTitle: "Reviewer 1",
            }}
            onResult={accepted}
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(accepted).toHaveBeenCalledWith(true));
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
        expect.objectContaining({
          type: "multi-review",
          displayTitle: "Reviewer 1",
          multiReviewTabData: expect.objectContaining({
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
          }),
        }),
      );
    });

    test("opens a backend workflow provider session in the created native tab", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="codex"
            options={{
              agentLaunchMode: "native",
              resumeSessionId: "provider-thread-1",
              requireExistingResumeSession: true,
              isReviewTab: true,
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
          expect.objectContaining({
            type: "agent-native",
            isReviewTab: true,
            nativeAgentData: expect.objectContaining({
              sessionId: "provider-thread-1",
              requireExistingResumeSession: true,
            }),
          }),
        ),
      );
    });

    test("applies a one-shot build mode when resuming a provider session", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="codex"
            options={{
              agentLaunchMode: "native",
              resumeSessionId: "provider-thread-1",
              initialPrompt: "Please address all the issues and coverage gaps",
              initialConversationMode: "build",
              isReviewTab: true,
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
          expect.objectContaining({
            type: "agent-native",
            isReviewTab: true,
            initialPrompt: "Please address all the issues and coverage gaps",
            initialConversationMode: "build",
            nativeAgentData: expect.objectContaining({ sessionId: "provider-thread-1" }),
          }),
        ),
      );
    });

    test("propagates provider session identity to Claude native tabs", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="claude"
            options={{
              agentLaunchMode: "native",
              resumeSessionId: "provider-claude-1",
              isReviewTab: true,
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
          expect.objectContaining({
            type: "agent-native",
            isReviewTab: true,
            nativeAgentData: expect.objectContaining({ sessionId: "provider-claude-1" }),
          }),
        ),
      );
    });

    test("propagates provider session identity to OpenCode native tabs", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="opencode"
            options={{
              agentLaunchMode: "native",
              resumeSessionId: "provider-opencode-1",
              isReviewTab: true,
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toContainEqual(
          expect.objectContaining({
            type: "agent-native",
            isReviewTab: true,
            nativeAgentData: expect.objectContaining({ sessionId: "provider-opencode-1" }),
          }),
        ),
      );
    });

    test("rejects a looped-review tab without a workflow id", async () => {
      const refused = mock((_created: boolean) => {});
      const originalTabs = usePaneLayoutStore.getState().getAllTabs("env-visible");
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="looped-review" options={{}} onResult={refused} />
        </TerminalProvider>,
      );

      await waitFor(() => expect(refused).toHaveBeenCalledWith(false));
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toEqual(originalTabs);
    });

    test("reports refusal instead of claiming a looped-review tab was created", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: Array.from({ length: MAX_TABS }, (_, index) => ({
              id: `tab-${index}`,
              type: "plain" as const,
            })),
            activeTabId: "tab-0",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));
      const refused = mock((_created: boolean) => {});
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="looped-review"
            options={{ loopedReviewId: "workflow-1" }}
            onResult={refused}
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(refused).toHaveBeenCalledWith(false));
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toHaveLength(MAX_TABS);
      expect(mockToastError).toHaveBeenCalledWith("Tab limit reached", {
        description: `You can have up to ${MAX_TABS} tabs open. Close a tab and try again.`,
        id: "tab-limit-reached",
      });
    });

    test("plain terminal tabs receive displayTitle", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="plain" options={{ displayTitle: "Custom", isReviewTab: true }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "plain" && t.id !== "visible-tab");
        expect(created?.displayTitle).toBe("Custom");
        expect(created?.isReviewTab).toBe(true);
      });
    });

    test("creates a provider-neutral native tab from the dedicated native action", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="agent-native" options={{ tabId: "neutral-native" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const created = usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .find((tab) => tab.id === "neutral-native");
        expect(created).toMatchObject({
          type: "agent-native",
          nativeAgentData: {
            environmentId: "env-visible",
            platform: undefined,
          },
        });
        expect(
          useNativeComposeStore
            .getState()
            .drafts.get(createNativeSessionKey("env-visible", "neutral-native")),
        ).toBeUndefined();
      });
    });

    test.each(["grok", "pi"] as const)(
      "creates a %s terminal tab when CLI mode is explicit",
      async (platform) => {
        render(
          <TerminalProvider>
            <TerminalContainer
              environmentId="env-visible"
              containerId="container-visible"
              isContainerRunning
              isActive
            />
            <CreateTabHarness
              type={platform}
              options={{
                tabId: `${platform}-cli`,
                agentLaunchMode: "cli",
              }}
            />
          </TerminalProvider>,
        );

        await waitFor(() => {
          expect(
            usePaneLayoutStore
              .getState()
              .getAllTabs("env-visible")
              .find((tab) => tab.id === `${platform}-cli`),
          ).toMatchObject({ id: `${platform}-cli`, type: platform });
        });
      },
    );

    test("keeps Cursor on the SDK bridge when a legacy CLI override is explicit", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="cursor"
            options={{
              tabId: "cursor-legacy-cli",
              agentLaunchMode: "cli",
              initialPrompt: "Use the SDK",
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(
          usePaneLayoutStore
            .getState()
            .getAllTabs("env-visible")
            .find((tab) => tab.id === "cursor-legacy-cli"),
        ).toMatchObject({
          id: "cursor-legacy-cli",
          type: "agent-native",
          nativeAgentData: { platform: "cursor" },
        });
      });
    });

    test("creates exactly one Pi native tab when native mode is explicit", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="pi"
            options={{ tabId: "pi-native", agentLaunchMode: "native", initialPrompt: "Review" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const matches = usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .filter((tab) => tab.id === "pi-native");
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          type: "agent-native",
          initialPrompt: "Review",
          nativeAgentData: { platform: "pi", environmentId: "env-visible" },
        });
      });
    });

    test("browser tabs receive their initial backend-local address", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="browser"
            options={{ initialUrl: "  http://localhost:49152/  " }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((tab) => tab.type === "browser");
        expect(created?.browserData).toEqual({ url: "http://localhost:49152/" });
      });
    });

    test("normalizes a whitespace-only browser address to the empty start screen", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="browser" options={{ initialUrl: "   " }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const created = usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .find((tab) => tab.type === "browser");
        expect(created?.browserData).toEqual({ url: "" });
      });
    });

    test("does not create browser tabs for stopped environments", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning={false}
            isActive
          />
          <CreateTabHarness type="browser" options={{ initialUrl: "http://localhost:3000/" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(
          usePaneLayoutStore
            .getState()
            .getAllTabs("env-visible")
            .some((tab) => tab.type === "browser"),
        ).toBe(false);
      });
    });

    test("respects the tab limit when creating browser tabs", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: Array.from({ length: 9 }, (_, index) => ({
              id: `tab-${index}`,
              type: "plain" as const,
            })),
            activeTabId: "tab-0",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="browser" options={{ initialUrl: "http://localhost:3000/" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const tabs = usePaneLayoutStore.getState().getAllTabs("env-visible");
        expect(tabs).toHaveLength(9);
        expect(tabs.some((tab) => tab.type === "browser")).toBe(false);
      });
    });

    test("creates browser tabs in the active pane", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "left-tab", type: "plain" }],
                activeTabId: "left-tab",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "right-tab", type: "plain" }],
                activeTabId: "right-tab",
              },
            ],
          },
          activePaneId: "right",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="browser" options={{ initialUrl: "http://localhost:3000/" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const right = usePaneLayoutStore.getState().getPane("right", "env-visible");
        const left = usePaneLayoutStore.getState().getPane("left", "env-visible");
        expect(right?.tabs.some((tab) => tab.type === "browser")).toBe(true);
        expect(left?.tabs.some((tab) => tab.type === "browser")).toBe(false);
      });
    });

    test("opens a terminal link in a browser tab beside its source terminal", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "source-terminal", type: "plain" }],
                activeTabId: "source-terminal",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "right-tab", type: "plain" }],
                activeTabId: "right-tab",
              },
            ],
          },
          activePaneId: "right",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      act(() => {
        requestTerminalBrowserTab({
          environmentId: "env-visible",
          sourceTabId: "source-terminal",
          url: "http://localhost:3000/docs",
        });
      });

      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!environment || environment.root.kind !== "split") {
          throw new Error("expected split layout");
        }
        const leftPane = environment.root.children[0];
        const rightPane = environment.root.children[1];
        if (leftPane?.kind !== "leaf" || rightPane?.kind !== "leaf") {
          throw new Error("expected leaf panes");
        }

        expect(leftPane.tabs.find((tab) => tab.type === "browser")?.browserData).toEqual({
          url: "http://localhost:3000/docs",
        });
        expect(rightPane.tabs.some((tab) => tab.type === "browser")).toBe(false);
        expect(environment.activePaneId).toBe("left");
      });
    });

    test("opens a native preview link in a browser tab beside its source preview", async () => {
      let openLinkListener: ((event: { tabId: string; url: string }) => void) | undefined;
      window.orkestrator = {
        listen: (event: string, callback: (payload: unknown) => void) => {
          if (event === "browser-preview-open-link") {
            openLinkListener = callback as (payload: { tabId: string; url: string }) => void;
          }
          return () => undefined;
        },
      } as never;
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [
                  {
                    id: "browser-source",
                    type: "browser",
                    browserData: { url: "http://localhost:3000/" },
                  },
                ],
                activeTabId: "browser-source",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "right-tab", type: "plain" }],
                activeTabId: "right-tab",
              },
            ],
          },
          activePaneId: "right",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(openLinkListener).toBeDefined());
      act(() => {
        openLinkListener?.({
          tabId: "browser-source",
          url: "http://localhost:3000/docs",
        });
      });

      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!environment || environment.root.kind !== "split") {
          throw new Error("expected split layout");
        }
        const leftPane = environment.root.children[0];
        const rightPane = environment.root.children[1];
        if (leftPane?.kind !== "leaf" || rightPane?.kind !== "leaf") {
          throw new Error("expected leaf panes");
        }
        expect(leftPane.tabs.find((tab) => tab.id !== "browser-source")).toMatchObject({
          type: "browser",
          browserData: { url: "http://localhost:3000/docs" },
        });
        expect(rightPane.tabs.some((tab) => tab.type === "browser")).toBe(false);
        expect(environment.activePaneId).toBe("left");
      });
    });

    test("closes the live active pane tab from Electron's native menu shortcut", async () => {
      let closeTabListener: (() => void) | undefined;
      listenMock.mockImplementation(async (event: string, handler: () => void) => {
        if (event === "menu-close-tab") closeTabListener = handler;
        return () => undefined;
      });

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );
      await waitFor(() => expect(closeTabListener).toBeDefined());

      // Change the active pane after listener registration. The menu callback
      // must read current store state rather than a pane id captured at render.
      act(() => {
        usePaneLayoutStore.setState((state) => ({
          environments: new Map(state.environments).set("env-visible", {
            root: {
              kind: "split",
              id: "split",
              direction: "horizontal",
              sizes: [50, 50],
              depth: 1,
              children: [
                {
                  kind: "leaf",
                  id: "left",
                  tabs: [{ id: "left-tab", type: "plain" }],
                  activeTabId: "left-tab",
                },
                {
                  kind: "leaf",
                  id: "right",
                  tabs: [{ id: "right-tab", type: "agent-native" }],
                  activeTabId: "right-tab",
                },
              ],
            },
            activePaneId: "right",
            containerId: "container-visible",
          }),
        }));
        closeTabListener?.();
      });

      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        expect(environment?.root.kind).toBe("leaf");
        if (environment?.root.kind !== "leaf") return;
        expect(environment.root.id).toBe("left");
        expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["left-tab"]);
      });
    });

    // A browser-served client (`apps/web-public`) runs the same tree with no
    // Electron menu, so nothing would emit `menu-close-tab` and the browser
    // would close its own tab instead of the pane tab.
    test("closes the active pane tab from Command+W when no native menu owns it", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "visible-tab", type: "plain" },
              { id: "second-tab", type: "plain" },
            ],
            activeTabId: "second-tab",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );
      await waitFor(() => {
        expect(listenMock).toHaveBeenCalledWith("menu-close-tab", expect.any(Function));
      });

      const event = new KeyboardEvent("keydown", {
        key: "w",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });

      // The browser's own close-tab default must never win, even when this
      // client has no tab of its own left to close.
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (environment?.root.kind !== "leaf") throw new Error("expected leaf");
        expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab"]);
      });
    });

    test("leaves Command+W alone when it is not a bare Command chord", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );
      await waitFor(() => {
        expect(listenMock).toHaveBeenCalledWith("menu-close-tab", expect.any(Function));
      });

      for (const modifiers of [
        { metaKey: true, shiftKey: true },
        { metaKey: true, altKey: true },
        { metaKey: true, ctrlKey: true },
        { ctrlKey: true },
        {},
      ]) {
        const event = new KeyboardEvent("keydown", {
          key: "w",
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });
        act(() => {
          window.dispatchEvent(event);
        });
        expect(event.defaultPrevented, JSON.stringify(modifiers)).toBe(false);
      }

      const environment = usePaneLayoutStore.getState().environments.get("env-visible");
      if (environment?.root.kind !== "leaf") throw new Error("expected leaf");
      expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab"]);
    });

    // In Electron the accelerator normally swallows the keydown so only the
    // menu path runs. If it ever does not, both paths see the same keypress
    // and closing twice would take an unrelated tab with it.
    test("closes exactly one tab when the menu event echoes a renderer-handled Command+W", async () => {
      let closeTabListener: (() => void) | undefined;
      listenMock.mockImplementation(async (event: string, handler: () => void) => {
        if (event === "menu-close-tab") closeTabListener = handler;
        return () => undefined;
      });
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "visible-tab", type: "plain" },
              { id: "second-tab", type: "plain" },
              { id: "third-tab", type: "plain" },
            ],
            activeTabId: "third-tab",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );
      await waitFor(() => expect(closeTabListener).toBeDefined());

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "w",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        closeTabListener?.();
      });

      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (environment?.root.kind !== "leaf") throw new Error("expected leaf");
        expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab", "second-tab"]);
      });

      // The first menu event latches ownership: the renderer fallback must
      // stand down for every later press so the menu stays the only closer.
      const latched = new KeyboardEvent("keydown", {
        key: "w",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(latched);
      });
      expect(latched.defaultPrevented).toBe(true);
      const afterLatch = usePaneLayoutStore.getState().environments.get("env-visible");
      if (afterLatch?.root.kind !== "leaf") throw new Error("expected leaf");
      expect(afterLatch.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab", "second-tab"]);

      act(() => {
        closeTabListener?.();
      });
      await waitFor(() => {
        const environment = usePaneLayoutStore.getState().environments.get("env-visible");
        if (environment?.root.kind !== "leaf") throw new Error("expected leaf");
        expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab"]);
      });
    });

    test("does not close tabs from Command+W in an inactive environment", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      const event = new KeyboardEvent("keydown", {
        key: "w",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      const environment = usePaneLayoutStore.getState().environments.get("env-visible");
      if (environment?.root.kind !== "leaf") throw new Error("expected leaf");
      expect(environment.root.tabs.map((tab) => tab.id)).toEqual(["visible-tab"]);
    });

    test("ignores a native preview link whose source tab is missing or is not a browser tab", async () => {
      let openLinkListener: ((event: { tabId: string; url: string }) => void) | undefined;
      window.orkestrator = {
        listen: (event: string, callback: (payload: unknown) => void) => {
          if (event === "browser-preview-open-link") {
            openLinkListener = callback as (payload: { tabId: string; url: string }) => void;
          }
          return () => undefined;
        },
      } as never;

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(openLinkListener).toBeDefined());
      const before = usePaneLayoutStore.getState().environments.get("env-visible");
      act(() => {
        // "visible-tab" exists but is a plain terminal, and "missing-tab" has no
        // pane at all. A preview link only ever originates from a browser tab.
        openLinkListener?.({ tabId: "visible-tab", url: "http://localhost:3000/docs" });
        openLinkListener?.({ tabId: "missing-tab", url: "http://localhost:3000/docs" });
      });

      expect(usePaneLayoutStore.getState().environments.get("env-visible")).toEqual(before);
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .some((tab) => tab.type === "browser"),
      ).toBe(false);
    });

    test("ignores terminal links for other environments or missing source tabs without mutating panes", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "source-terminal", type: "plain" }],
                activeTabId: "source-terminal",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "right-tab", type: "plain" }],
                activeTabId: "right-tab",
              },
            ],
          },
          activePaneId: "right",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      const before = usePaneLayoutStore.getState().environments.get("env-visible");
      act(() => {
        requestTerminalBrowserTab({
          environmentId: "another-environment",
          sourceTabId: "source-terminal",
          url: "http://localhost:3000/foreign",
        });
        requestTerminalBrowserTab({
          environmentId: "env-visible",
          sourceTabId: "missing-terminal",
          url: "http://localhost:3000/missing",
        });
      });

      expect(usePaneLayoutStore.getState().environments.get("env-visible")).toEqual(before);
    });

    test("rejects terminal links at the tab limit without changing the active pane", async () => {
      const fillerTabs = Array.from({ length: MAX_TABS - 2 }, (_, index) => ({
        id: `filler-${index}`,
        type: "plain" as const,
      }));
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "source-terminal", type: "plain" }, ...fillerTabs],
                activeTabId: "source-terminal",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "right-tab", type: "plain" }],
                activeTabId: "right-tab",
              },
            ],
          },
          activePaneId: "right",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
        </TerminalProvider>,
      );

      act(() => {
        requestTerminalBrowserTab({
          environmentId: "env-visible",
          sourceTabId: "source-terminal",
          url: "http://localhost:3000/at-limit",
        });
      });

      const environment = usePaneLayoutStore.getState().environments.get("env-visible");
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toHaveLength(MAX_TABS);
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .some((tab) => tab.type === "browser"),
      ).toBe(false);
      expect(environment?.activePaneId).toBe("right");
      expect(mockToastError).toHaveBeenCalledWith("Tab limit reached", {
        description: `You can have up to ${MAX_TABS} tabs open. Close a tab and try again.`,
        id: "tab-limit-reached",
      });
    });

    test("rejects terminal links while stopped or locally not ready without pane mutation", async () => {
      const { unmount } = render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning={false}
            isActive
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toHaveLength(0);
      });
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "stopped-source", type: "plain" }],
            activeTabId: "stopped-source",
          },
          activePaneId: "left",
          containerId: "container-visible",
        }),
      }));
      const stoppedBefore = usePaneLayoutStore.getState().environments.get("env-visible");
      act(() => {
        requestTerminalBrowserTab({
          environmentId: "env-visible",
          sourceTabId: "stopped-source",
          url: "http://localhost:3000/stopped",
        });
      });
      expect(usePaneLayoutStore.getState().environments.get("env-visible")).toEqual(stoppedBefore);

      unmount();
      useEnvironmentStore.setState((state) => ({
        ...state,
        environments: state.environments.map((environment) =>
          environment.id === "env-visible"
            ? {
                ...environment,
                containerId: null,
                environmentType: "local",
                worktreePath: undefined,
              }
            : environment,
        ),
      }));
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "local",
            tabs: [{ id: "local-source", type: "plain" }],
            activeTabId: "local-source",
          },
          activePaneId: "local",
          containerId: null,
        }),
      }));
      render(
        <TerminalProvider>
          <TerminalContainer environmentId="env-visible" containerId={null} isActive />
        </TerminalProvider>,
      );
      const localBefore = usePaneLayoutStore.getState().environments.get("env-visible");
      act(() => {
        requestTerminalBrowserTab({
          environmentId: "env-visible",
          sourceTabId: "local-source",
          url: "http://localhost:3000/not-ready",
        });
      });
      expect(usePaneLayoutStore.getState().environments.get("env-visible")).toEqual(localBefore);
    });

    test("does not create a browser tab when the active pane id is stale", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "actual-pane",
            tabs: [{ id: "visible-tab", type: "plain" }],
            activeTabId: "visible-tab",
          },
          activePaneId: "removed-pane",
          containerId: "container-visible",
        }),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="browser"
            options={{ initialUrl: "http://localhost:3000/stale-pane" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const tabs = usePaneLayoutStore.getState().getAllTabs("env-visible");
        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.id).toBe("visible-tab");
      });
    });

    test("claude-native tabs receive displayTitle", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { ...state.config.global.agentSettings?.platforms?.claude, mode: "native" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="claude" options={{ displayTitle: "Review" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("Review");
      });
    });

    test("claude-tmux tabs are created when claudeMode is native and the native backend resolves to tmux", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { mode: "native", claudeNativeBackend: "tmux" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="claude" options={{ displayTitle: "Tmux", initialPrompt: "hi" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude-tmux");
        expect(created).toBeDefined();
        expect(created?.displayTitle).toBe("Tmux");
        expect(created?.initialPrompt).toBe("hi");
        expect(created?.claudeTmuxData?.environmentId).toBe("env-visible");
        expect(created?.claudeTmuxData?.containerId).toBe("container-visible");
        expect(created?.claudeTmuxData?.isLocal).toBe(false);
      });
    });

    test("repository Claude agent style and backend override global terminal defaults", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { mode: "terminal", claudeNativeBackend: "sdk" },
              },
            },
          },
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              agentSettings: {
                platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } },
              },
            },
          },
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="claude" options={{ displayTitle: "Repo tmux" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude-tmux");
        expect(created?.displayTitle).toBe("Repo tmux");
      });
    });

    test("codex-native tabs receive displayTitle", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                codex: { ...state.config.global.agentSettings?.platforms?.codex, mode: "native" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="codex" options={{ displayTitle: "PR", isReviewTab: true }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("PR");
        expect(created?.isReviewTab).toBe(true);
      });
    });

    test("opencode-native tabs receive displayTitle", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                opencode: {
                  ...state.config.global.agentSettings?.platforms?.opencode,
                  mode: "native",
                },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="opencode" options={{ displayTitle: "Conflict" }} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("Conflict");
      });
    });

    test("agentLaunchMode tmux opens a Claude tmux tab even when Claude defaults to terminal", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { mode: "terminal", claudeNativeBackend: "sdk" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="claude"
            options={{ agentLaunchMode: "tmux", displayTitle: "Forced tmux" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude-tmux");
        expect(created?.displayTitle).toBe("Forced tmux");
      });
    });

    test("agentLaunchMode native opens a Codex native tab even when Codex defaults to terminal", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                codex: { ...state.config.global.agentSettings?.platforms?.codex, mode: "terminal" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="codex"
            options={{ agentLaunchMode: "native", displayTitle: "Forced native" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("Forced native");
      });
    });

    test.each(["claude", "codex", "opencode", "cursor", "grok", "pi"] as const)(
      "seeds an unassigned native composer with the explicitly launched %s provider",
      async (platform) => {
        render(
          <TerminalProvider>
            <TerminalContainer
              environmentId="env-visible"
              containerId="container-visible"
              isContainerRunning
              isActive
            />
            <CreateTabHarness
              type={platform}
              options={{
                tabId: `explicit-${platform}`,
                agentLaunchMode: "native",
              }}
            />
          </TerminalProvider>,
        );

        await waitFor(() => {
          const created = usePaneLayoutStore
            .getState()
            .getAllTabs("env-visible")
            .find((tab) => tab.id === `explicit-${platform}`);
          expect(created).toMatchObject({
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-visible",
              platform: undefined,
            },
          });
          expect(
            useNativeComposeStore
              .getState()
              .drafts.get(createNativeSessionKey("env-visible", `explicit-${platform}`))?.platform,
          ).toBe(platform);
        });
      },
    );

    test("carries one-shot review model and effort settings into the created native tab", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="codex"
            options={{
              tabId: "review-tab-owned-by-launcher",
              agentLaunchMode: "native",
              displayTitle: "Review",
              initialAgentModel: "gpt-5.6-sol",
              initialReasoningEffort: "xhigh",
              initialPrompt: "Review this diff",
              isReviewTab: true,
            }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created).toMatchObject({
          id: "review-tab-owned-by-launcher",
          displayTitle: "Review",
          initialAgentModel: "gpt-5.6-sol",
          initialReasoningEffort: "xhigh",
          initialPrompt: "Review this diff",
          isReviewTab: true,
        });
      });
    });

    test("refuses a duplicate caller-owned tab id", async () => {
      const firstResult = mock((_created: boolean) => {});
      const duplicateResult = mock((_created: boolean) => {});
      const options = {
        tabId: "caller-owned-review-tab",
        agentLaunchMode: "native" as const,
        displayTitle: "Review",
      };

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness type="codex" options={options} onResult={firstResult} />
          <CreateTabHarness type="codex" options={options} onResult={duplicateResult} />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(firstResult).toHaveBeenCalledWith(true);
        expect(duplicateResult).toHaveBeenCalledWith(false);
      });
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-visible")
          .filter((tab) => tab.id === options.tabId),
      ).toHaveLength(1);
    });

    test("carries one-shot review options through every agent launch mode", async () => {
      const launchCases = [
        { type: "claude", mode: "cli", title: "Claude CLI review", expectedType: "claude" },
        {
          type: "claude",
          mode: "native",
          title: "Claude Native review",
          expectedType: "agent-native",
        },
        { type: "claude", mode: "tmux", title: "Claude Tmux review", expectedType: "claude-tmux" },
        { type: "codex", mode: "cli", title: "Codex CLI review", expectedType: "codex" },
        {
          type: "codex",
          mode: "native",
          title: "Codex Native review",
          expectedType: "agent-native",
        },
        { type: "opencode", mode: "cli", title: "OpenCode CLI review", expectedType: "opencode" },
        {
          type: "opencode",
          mode: "native",
          title: "OpenCode Native review",
          expectedType: "agent-native",
        },
      ] as const;

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          {launchCases.map((launchCase) => (
            <CreateTabHarness
              key={launchCase.title}
              type={launchCase.type}
              options={{
                agentLaunchMode: launchCase.mode,
                displayTitle: launchCase.title,
                initialAgentModel: `${launchCase.type}-review-model`,
                initialReasoningEffort: "high",
                initialPrompt: "Review this diff",
                isReviewTab: true,
              }}
            />
          ))}
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        for (const launchCase of launchCases) {
          const created = env.root.tabs.find((tab) => tab.displayTitle === launchCase.title);
          expect(created).toMatchObject({
            type: launchCase.expectedType,
            initialAgentModel: `${launchCase.type}-review-model`,
            initialReasoningEffort: "high",
            initialPrompt: "Review this diff",
            isReviewTab: true,
          });
        }
      });
    });

    test("agentLaunchMode cli opens an OpenCode CLI tab even when OpenCode defaults to native", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                opencode: {
                  ...state.config.global.agentSettings?.platforms?.opencode,
                  mode: "native",
                },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="opencode"
            options={{ agentLaunchMode: "cli", displayTitle: "Forced CLI" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "opencode");
        expect(created?.displayTitle).toBe("Forced CLI");
      });
    });

    test("agentLaunchMode cli opens a Claude CLI tab even when Claude defaults to tmux", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { mode: "native", claudeNativeBackend: "tmux" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="claude"
            options={{ agentLaunchMode: "cli", displayTitle: "Forced Claude CLI" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude");
        expect(created?.displayTitle).toBe("Forced Claude CLI");
      });
    });

    test("agentLaunchMode native opens Claude SDK native even when the native backend defaults to tmux", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                claude: { mode: "native", claudeNativeBackend: "tmux" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="claude"
            options={{ agentLaunchMode: "native", displayTitle: "Forced Claude Native" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("Forced Claude Native");
        expect(env.root.tabs.some((t) => t.type === "claude-tmux")).toBe(false);
      });
    });

    test("agentLaunchMode cli opens a Codex CLI tab even when Codex defaults to native", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                codex: { ...state.config.global.agentSettings?.platforms?.codex, mode: "native" },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="codex"
            options={{ agentLaunchMode: "cli", displayTitle: "Forced Codex CLI" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "codex");
        expect(created?.displayTitle).toBe("Forced Codex CLI");
      });
    });

    test("agentLaunchMode native opens an OpenCode native tab even when OpenCode defaults to terminal", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              ...state.config.global.agentSettings,
              platforms: {
                ...state.config.global.agentSettings?.platforms,
                opencode: {
                  ...state.config.global.agentSettings?.platforms?.opencode,
                  mode: "terminal",
                },
              },
            },
          },
          repositories: {},
        },
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="opencode"
            options={{ agentLaunchMode: "native", displayTitle: "Forced OpenCode Native" }}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "agent-native");
        expect(created?.displayTitle).toBe("Forced OpenCode Native");
      });
    });
  });
});
