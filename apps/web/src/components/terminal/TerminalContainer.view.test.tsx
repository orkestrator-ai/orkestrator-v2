import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { useEffect, useRef, type ReactNode } from "react";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { MAX_TABS, TerminalProvider, useTerminalContext } from "@/contexts";

import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";

import { useConfigStore } from "@/stores/configStore";

import { useEnvironmentStore } from "@/stores/environmentStore";

import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

import { useNativeComposeStore } from "@/stores/nativeComposeStore";

import { useBuildPipelineStore } from "@/stores/buildPipelineStore";

import { readStoredPaneSelection } from "@/lib/pane-selection-storage";

import { startPaneLayoutPersistence } from "@/lib/pane-layout-persistence";

import { useLoopedReviewStore, type LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

import { loopedReviewFixture } from "@/test/looped-review-fixture";

import { createSessionKey, useTerminalSessionStore } from "@/stores/terminalSessionStore";

import {
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  type PersistedPaneLayout,
} from "@/types/paneLayout";

import type { EnsureEnvironmentSetupResult, EnvironmentSetupSession, Session } from "@/types";

import type { CollisionDetection } from "@dnd-kit/core";

import * as realBackend from "@/lib/backend";

import * as realSetupCommands from "@/lib/setup-commands";

import * as realDndKitCore from "@dnd-kit/core";

import { buildPipelineFixture } from "@/test/build-pipeline-fixture";

import { mockToastError } from "../../../../../tests/mocks/sonner";

import * as realNativeEvents from "@/lib/native/events";

import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";

const LEGACY_SELECTION_STORAGE_KEY = "orkestrator.pane-selection.v1";

// Mirrors the production constants in TerminalContainer.tsx. They are module
// private there, so the tests keep their own copy rather than widening the
// component's public surface for a test.
const SETUP_SESSION_BIND_RETRY_DELAY_MS = 250;

const MAX_SETUP_SESSION_BIND_ATTEMPTS = 3;

type SwallowedTimer = { handle: number; delay: number; fire: () => void };

/**
 * Deterministic timer control for the setup-session bind retries.
 *
 * `swallowDelays` names the exact delays this probe takes ownership of: those
 * timers are recorded and handed back for the test to fire explicitly, and are
 * never armed for real. Every other `setTimeout` — React's, happy-dom's,
 * `waitFor`'s — passes straight through, so the probe never asserts on, or
 * interferes with, timers it does not own.
 */
function installTimerProbe(swallowDelays: number[] = []) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const swallow = new Set(swallowDelays);
  const delays: number[] = [];
  const swallowed: SwallowedTimer[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 900_001;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const scheduledDelay = typeof delay === "number" ? delay : 0;
    delays.push(scheduledDelay);
    if (swallow.has(scheduledDelay)) {
      const handle = nextHandle;
      nextHandle += 1;
      swallowed.push({
        handle,
        delay: scheduledDelay,
        fire: () => {
          if (typeof callback === "function") callback();
        },
      });
      return handle;
    }
    return Reflect.apply(originalSetTimeout, globalThis, [callback, delay, ...args]) as never;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: unknown) => {
    cleared.push(handle);
    if (swallowed.some((timer) => timer.handle === handle)) return;
    Reflect.apply(originalClearTimeout, globalThis, [handle]);
  }) as typeof globalThis.clearTimeout;

  return {
    /** Every delay passed to `setTimeout` while the probe was installed. */
    delays,
    /** Only the timers whose delay the probe was asked to own. */
    swallowed,
    cleared,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function writeStoredPaneSelection(
  environmentId: string,
  selection: { activePaneId: string; activeTabIds: Record<string, string> },
): void {
  localStorage.setItem(
    LEGACY_SELECTION_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      entries: [{ environmentId, ...selection }],
    }),
  );
}

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

const pointerWithinMock = mock<CollisionDetection>((_args) => []);

const rectIntersectionMock = mock<CollisionDetection>((_args) => []);

const closestCenterMock = mock<CollisionDetection>((_args) => []);

mock.module("@dnd-kit/core", () => ({
  ...realDndKitCoreSnapshot,
  DndContext: (props: DndContextHarnessProps) => {
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

const getSessionsByEnvironmentMock = mock(async (_environmentId: string): Promise<Session[]> => []);

const loadSessionBufferMock = mock(async (_sessionId: string): Promise<string | null> => null);

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

const seedContainerSetupCommands = (environmentId = "env-hidden") => {
  useEnvironmentStore.getState().updateEnvironment(environmentId, {
    setupPhase: "running",
  });
};

const seedUnboundSetupTabFor = (environmentId: string, containerId: string) => {
  usePaneLayoutStore.setState((state) => ({
    environments: new Map(state.environments).set(environmentId, {
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "default", type: "plain" as const, isSetupTab: true }],
        activeTabId: "default",
      },
      activePaneId: "default",
      containerId,
    }),
  }));
};

const seedUnboundSetupTab = () => {
  seedUnboundSetupTabFor("env-hidden", "container-hidden");
};

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
  getSessionsByEnvironment: getSessionsByEnvironmentMock,
  loadSessionBuffer: loadSessionBufferMock,
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

const { TerminalContainer } = await import("./TerminalContainer");

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
    getSessionsByEnvironmentMock.mockReset();
    getSessionsByEnvironmentMock.mockResolvedValue([]);
    loadSessionBufferMock.mockReset();
    loadSessionBufferMock.mockResolvedValue(null);
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

  /**
   * Restores a layout holding a single backend-managed setup tab (no
   * `initialCommands`, so `PersistentTerminal` treats it as attach-only).
   */
  const restoreBackendSetupTabLayout = (
    environmentOverrides: Record<string, unknown> = {},
    extraTabs: Array<Record<string, unknown>> = [],
  ) => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: null,
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [{ id: "default", type: "plain", isSetupTab: true }, ...extraTabs],
        activeTabId: "default",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: true,
              ...environmentOverrides,
            }
          : environment,
      ),
    }));

    return render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );
  };

  const setupTabIds = () =>
    usePaneLayoutStore
      .getState()
      .getAllTabs("env-hidden")
      .filter((tab) => tab.isSetupTab)
      .map((tab) => tab.id);

  /**
   * Put "env-hidden" in the state a mobile reload leaves behind: setup already
   * finished, the durable launch intent still set, a setup-only persisted layout,
   * and no transient options store to fall back on.
   */
  function setupDurableLaunchEnvironment(overrides: Record<string, unknown> = {}): void {
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "default", type: "plain", isSetupTab: true }],
              activeTabId: "default",
            },
            activePaneId: "default",
            containerId: "container-hidden",
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: null,
    } as never);
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              setupPhase: "ready",
              setupScriptsComplete: true,
              pendingAgentLaunch: true,
              initialPrompt: "Recover after mobile reload",
              initialAgentModel: "gpt-5.6-sol",
              initialReasoningEffort: "high",
              ...overrides,
            }
          : environment,
      ),
    }));
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });
  }

  const renderHiddenTerminal = () =>
    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

  /**
   * Wait for the durable launch to reconstruct its agent tab and assert the
   * one-shot options rode along onto it.
   *
   * The tab — not the backend flag — is the durable carrier from this point on:
   * `TerminalContainer` flushes the layout (options included) before clearing
   * `pendingAgentLaunch`, and `pane-layout-restore` reads the options back. So
   * the clear deliberately does *not* wait for a consumer to apply them; doing
   * so would strand the flag whenever an agent surface reaches a steady state
   * without applying the model.
   */
  const waitForDurableAgentTab = async (type = "agent-native") => {
    let tabId: string | undefined;
    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === type);
      expect(agentTab?.initialAgentModel).toBe("gpt-5.6-sol");
      expect(agentTab?.initialReasoningEffort).toBe("high");
      tabId = agentTab?.id;
    });
    return tabId!;
  };

  // Shared fixture for the setup -> startup-agent focus handoff: a local
  // environment whose backend-published agent tab already exists while the
  // setup terminal is still the surface the renderer keeps selected.
  function seedStartupFocusHandoffConfig(): void {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
        },
        repositories: {},
      },
    }));
  }

  function startupAgentTabFixture(environmentId: string) {
    return {
      id: "startup-agent",
      type: "agent-native",
      nativeAgentData: {
        platform: "codex",
        environmentId,
        isLocal: true,
      },
    };
  }

  function seedStartupFocusHandoffEnvironment(
    environmentId: string,
    options: { setupReady: boolean },
  ): void {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === environmentId
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: `/tmp/${environmentId}-worktree`,
              setupPhase: options.setupReady ? "ready" : "running",
              setupScriptsComplete: options.setupReady,
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
              pendingAgentLaunch: true,
              startupAgentSession: {
                tabId: "startup-agent",
                agent: "codex",
                style: "native",
                status: "starting",
              },
            }
          : environment,
      ),
    }));
  }

  test.each(["starting", "error"] as const)(
    "does not project or clear a backend-owned %s startup session",
    async (status) => {
      setupDurableLaunchEnvironment({
        agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
        pendingAgentLaunch: true,
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          ...(status === "error" ? { error: "Agent launch failed; the backend will retry." } : {}),
        },
      });

      renderHiddenTerminal();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .some((tab) => tab.id === "startup-agent"),
      ).toBe(false);
      expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
      expect(acknowledgeStartupAgentSessionMock).not.toHaveBeenCalled();
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.pendingAgentLaunch,
      ).toBe(true);
    },
  );

  test.each([
    {
      label: "Claude native",
      overrides: {
        agentSettings: { defaultAgent: "claude", platforms: { claude: { mode: "native" } } },
      },
      expectedType: "agent-native",
      model: "claude-fable-5[1m]",
    },
    {
      label: "OpenCode native",
      overrides: {
        agentSettings: { defaultAgent: "opencode", platforms: { opencode: { mode: "native" } } },
      },
      expectedType: "agent-native",
      model: "provider/review-model",
    },
    {
      label: "Claude terminal",
      overrides: {
        agentSettings: { defaultAgent: "claude", platforms: { claude: { mode: "terminal" } } },
      },
      expectedType: "claude",
      model: "sonnet",
    },
  ])(
    "carries durable model and effort onto the reconstructed $label tab and its flushed layout",
    async ({ overrides, expectedType, model }) => {
      setupDurableLaunchEnvironment({
        ...overrides,
        initialAgentModel: model,
        initialReasoningEffort: "high",
      });
      renderHiddenTerminal();

      await waitFor(() => {
        const agentTab = usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .find((tab) => tab.type === expectedType);
        expect(agentTab?.initialAgentModel).toBe(model);
        expect(agentTab?.initialReasoningEffort).toBe("high");
      });

      if (expectedType === "agent-native") {
        expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
        return;
      }
      await waitFor(() => {
        expect(setEnvironmentPendingAgentLaunchMock).toHaveBeenCalledWith("env-hidden", false);
      });
      const clearOrder = setEnvironmentPendingAgentLaunchMock.mock.invocationCallOrder[0]!;
      const flushIndex = savePaneLayoutMock.mock.invocationCallOrder.findIndex(
        (order) => order < clearOrder,
      );
      expect(flushIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(savePaneLayoutMock.mock.calls[flushIndex]?.[1])).toContain(
        `"initialAgentModel":"${model}"`,
      );
    },
  );

  test.each([null, new Error("backend unavailable")] as const)(
    "registers the pane environment after a %s first hydration so a later snapshot can apply",
    async (firstResult) => {
      if (firstResult instanceof Error) {
        getPaneLayoutMock.mockRejectedValue(firstResult);
      } else {
        getPaneLayoutMock.mockResolvedValue(firstResult);
      }
      useEnvironmentStore.setState((state) => ({
        ...state,
        environments: state.environments.map((environment) =>
          environment.id === "env-hidden"
            ? {
                ...environment,
                agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
                setupScriptsComplete: true,
                pendingAgentLaunch: true,
              }
            : environment,
        ),
      }));

      renderHiddenTerminal();

      await waitFor(() => {
        expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
        expect(usePaneLayoutStore.getState().environments.has("env-hidden")).toBe(true);
      });

      act(() => {
        usePaneLayoutStore.getState().applyAuthoritativeLayout("env-hidden", {
          containerId: "container-hidden",
          activePaneId: "default",
          backendRevision: 2,
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: "env-hidden",
                  containerId: "container-hidden",
                  sessionId: "late-session",
                },
              },
            ],
            activeTabId: "startup-agent",
          },
        });
      });

      const startupTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.id === "startup-agent");
      expect(startupTab).toMatchObject({
        type: "agent-native",
        nativeAgentData: { sessionId: "late-session" },
      });
      expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    },
  );

  test("initializes a hidden environment without changing the active pane-layout environment", async () => {
    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden).toBeDefined();
      expect(envHidden?.containerId).toBe("container-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (envHidden?.root.kind === "leaf") {
        expect(envHidden.root.tabs).toHaveLength(1);
        expect(envHidden.root.activeTabId).toBe("default");
      }
    });

    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });

  test("restores a backend pane layout before default tab seeding", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [{ id: "restored-tab", type: "plain", displayTitle: "Restored" }],
        activeTabId: "restored-tab",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const restored = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(restored?.activePaneId).toBe("restored-pane");
      expect(restored?.root).toMatchObject({
        kind: "leaf",
        tabs: [{ id: "restored-tab", displayTitle: "Restored" }],
      });
    });
    expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden");
  });

  test("discards restored panes when the container stops, so the caller must not pass daemon state", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          { id: "restored-tab", type: "plain", displayTitle: "Restored" },
          { id: "second-tab", type: "plain", displayTitle: "Second" },
        ],
        activeTabId: "restored-tab",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    const renderTerminal = (isContainerRunning: boolean) => (
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={isContainerRunning}
          isActive={false}
        />
      </TerminalProvider>
    );
    const view = render(renderTerminal(true));

    await waitFor(() => {
      const restored = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(restored?.root).toMatchObject({
        kind: "leaf",
        tabs: [{ id: "restored-tab" }, { id: "second-tab" }],
      });
    });

    view.rerender(renderTerminal(false));

    // `isContainerRunning={false}` with a live containerId means "this
    // container stopped", and the answer is to throw the panes away. That is
    // correct for a real stop and catastrophic for a false negative, which is
    // why App.tsx feeds this from the environment's own status rather than
    // from the Docker daemon probe.
    await waitFor(() => {
      const afterStop = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(afterStop?.root).toMatchObject({ kind: "leaf", id: "default", tabs: [] });
      expect(afterStop?.activePaneId).toBe("default");
    });
  });

  test("CAS-migrates sensitive restored browser history after hydration alone", async () => {
    const currentUrl = "https://example.com/current?token=current#live";
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "browser",
            type: "browser",
            browserData: {
              url: currentUrl,
              history: ["https://alice:secret@example.com/previous?token=old#private", currentUrl],
              historyIndex: 1,
            },
          },
        ],
        activeTabId: "browser",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 7,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => expect(savePaneLayoutMock).toHaveBeenCalledTimes(1));
    const [environmentId, persisted, expectedRevision] = savePaneLayoutMock.mock.calls[0]!;
    expect(environmentId).toBe("env-hidden");
    expect(expectedRevision).toBe(7);
    expect(persisted.root).toMatchObject({
      tabs: [
        {
          browserData: {
            url: currentUrl,
            history: ["https://example.com/previous", "https://example.com/current"],
            historyIndex: 1,
          },
        },
      ],
    });
  });

  test("revision-guard deletes a sensitive non-restorable generation snapshot", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      // The live test environment owns container-hidden, so this snapshot must
      // never be installed or rewritten as if its tabs belonged to that generation.
      containerId: "container-stale",
      activePaneId: "stale-pane",
      root: {
        kind: "leaf",
        id: "stale-pane",
        tabs: [
          {
            id: "browser",
            type: "browser",
            browserData: {
              url: "https://example.com/current",
              history: ["https://alice:secret@example.com/old?token=secret#private"],
              historyIndex: 0,
            },
          },
        ],
        activeTabId: "browser",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 9,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(deletePaneLayoutMock).toHaveBeenCalledWith("env-hidden", 9);
    });
    expect(savePaneLayoutMock).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "browser" })]),
    );
  });

  test("hydrates a failed local setup and renders retry and skip recovery actions", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", {
      environmentType: "local",
      containerId: null,
      worktreePath: "/tmp/failed-local-worktree",
      status: "error",
      setupScriptsComplete: false,
      setupPhase: "failed",
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isContainerRunning={false}
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
    });
    expect(screen.getByText("Environment setup failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry setup/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip setup/i })).toBeTruthy();
  });

  test("keeps setup recovery visible for a live container reported as errored", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", {
      status: "error",
      setupScriptsComplete: false,
      setupPhase: "failed",
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
    });
    expect(screen.getByText("Environment setup failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry setup/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip setup/i })).toBeTruthy();
  });

  test("hydrates and preserves a build tab inserted before the container mounts", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-pre-mount",
      environmentId: "env-hidden",
      environmentType: "containerized",
    });
    useBuildPipelineStore.getState().replacePipeline(pipeline);
    usePaneLayoutStore.getState().initialize("container-hidden", "env-hidden");
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "build-pipeline-pre-mount",
        type: "claude-build",
        buildTabData: {
          pipelineId: pipeline.id,
          environmentId: "env-hidden",
          taskId: pipeline.taskId,
          isLocal: false,
        },
      },
      "env-hidden",
    );
    expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBeUndefined();
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [{ id: "restored-tab", type: "plain", displayTitle: "Restored" }],
        activeTabId: "restored-tab",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
    });
    const hydrated = usePaneLayoutStore.getState().environments.get("env-hidden");
    expect(
      hydrated && hydrated.root.kind === "leaf" ? hydrated.root.tabs.map((tab) => tab.id) : [],
    ).toEqual(["restored-tab", "build-pipeline-pre-mount"]);
    expect(hydrated?.activePaneId).toBe("restored-pane");
    expect(hydrated?.root.kind === "leaf" ? hydrated.root.activeTabId : null).toBe(
      "build-pipeline-pre-mount",
    );
  });

  /**
   * The build supervisor inserts its tab as soon as the backend returns a
   * pipeline, which is always before the environment is running and therefore
   * always before this container's initial-layout effect can run. Counting that
   * tab as "already laid out" would skip the whole block: no default terminal,
   * no setup tab, and no initialize() to record the containerId that terminal
   * session keys are built from.
   */
  test("still seeds the initial layout for a fresh environment that already has a build tab", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-fresh",
      environmentId: "env-hidden",
      environmentType: "containerized",
    });
    useBuildPipelineStore.getState().replacePipeline(pipeline);
    // Exactly what ensureBuildTab does: create the pane state, then add the tab.
    // No initialize(), because no container has mounted for this environment.
    usePaneLayoutStore.getState().setActiveEnvironment("env-hidden");
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "build-pipeline-fresh",
        type: "claude-build",
        buildTabData: {
          pipelineId: pipeline.id,
          environmentId: "env-hidden",
          taskId: pipeline.taskId,
          isLocal: false,
        },
      },
      "env-hidden",
    );
    // A brand new environment has no persisted layout to restore.
    getPaneLayoutMock.mockResolvedValue(null);

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const state = usePaneLayoutStore.getState().environments.get("env-hidden");
      const tabs = state && state.root.kind === "leaf" ? state.root.tabs : [];
      expect(tabs.some((tab) => tab.type !== "claude-build")).toBe(true);
    });

    const seeded = usePaneLayoutStore.getState().environments.get("env-hidden")!;
    const tabIds = seeded.root.kind === "leaf" ? seeded.root.tabs.map((tab) => tab.id) : [];
    // The build tab survives the seeding rather than being replaced by it.
    expect(tabIds).toContain("build-pipeline-fresh");
    // initialize() ran, so terminal cleanup can build correct session keys.
    expect(seeded.containerId).toBe("container-hidden");
  });

  test("initialize keeps tabs added before the container mounted", () => {
    usePaneLayoutStore.getState().setActiveEnvironment("env-hidden");
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "build-early",
        type: "claude-build",
        buildTabData: {
          pipelineId: "pipeline-early",
          environmentId: "env-hidden",
          taskId: "task-1",
          isLocal: false,
        },
      },
      "env-hidden",
    );

    usePaneLayoutStore.getState().initialize("container-hidden", "env-hidden");

    const state = usePaneLayoutStore.getState().environments.get("env-hidden")!;
    const tabIds = state.root.kind === "leaf" ? state.root.tabs.map((tab) => tab.id) : [];
    // Replacing the root wholesale would drop the tab, and nothing re-adds it.
    expect(tabIds).toEqual(["build-early"]);
    expect(state.containerId).toBe("container-hidden");
  });

  test("initialize still resets an environment that has no tabs", () => {
    usePaneLayoutStore.getState().initialize("container-hidden", "env-fresh");

    const state = usePaneLayoutStore.getState().environments.get("env-fresh")!;
    expect(state.root.kind === "leaf" ? state.root.tabs : null).toEqual([]);
    expect(state.activePaneId).toBe("default");
    expect(state.containerId).toBe("container-hidden");
  });

  test("restores the backend pane and tab selection on a cold start", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "right",
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
              { id: "left-a", type: "plain" },
              { id: "left-b", type: "plain" },
            ],
            activeTabId: "left-b",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [
              { id: "right-a", type: "plain" },
              { id: "right-b", type: "plain" },
            ],
            activeTabId: "right-b",
          },
        ],
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 3,
    });
    // A stale value from versions that kept focus in localStorage must not
    // override the backend-owned selection.
    writeStoredPaneSelection("env-hidden", {
      activePaneId: "left",
      activeTabIds: { left: "left-a", right: "right-a" },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const restored = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(restored?.activePaneId).toBe("right");
      expect(restored?.root).toMatchObject({
        children: [
          { id: "left", activeTabId: "left-b" },
          { id: "right", activeTabId: "right-b" },
        ],
      });
      expect(readStoredPaneSelection("env-hidden")).toBeNull();
    });
  });

  test("migrates legacy local focus into a v2 backend layout before deleting it", async () => {
    const legacy: PersistedPaneLayout = {
      version: LEGACY_PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      // V1 intentionally persisted canonical pointers rather than real focus.
      activePaneId: "left",
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
            tabs: [{ id: "left-a", type: "plain" }],
            activeTabId: "left-a",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [
              { id: "right-a", type: "plain" },
              { id: "right-b", type: "plain" },
            ],
            activeTabId: "right-a",
          },
        ],
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 7,
    };
    getPaneLayoutMock.mockResolvedValue(legacy);
    writeStoredPaneSelection("env-hidden", {
      activePaneId: "right",
      activeTabIds: { left: "left-a", right: "right-b" },
    });
    savePaneLayoutMock.mockImplementationOnce(async (environmentId, layout) => ({
      ...layout,
      environmentId,
      updatedAt: "2026-01-02T00:00:00.000Z",
      revision: 8,
    }));
    const stopPersistence = startPaneLayoutPersistence({
      save: savePaneLayoutMock,
      load: getPaneLayoutMock,
      debounceMs: 5,
    });

    try {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        const restored = usePaneLayoutStore.getState().environments.get("env-hidden");
        expect(restored?.activePaneId).toBe("right");
        expect(restored?.root).toMatchObject({
          children: [
            { id: "left", activeTabId: "left-a" },
            { id: "right", activeTabId: "right-b" },
          ],
        });
        expect(savePaneLayoutMock).toHaveBeenCalledWith(
          "env-hidden",
          expect.objectContaining({
            version: PANE_LAYOUT_VERSION,
            activePaneId: "right",
            root: expect.objectContaining({
              children: expect.arrayContaining([
                expect.objectContaining({ id: "right", activeTabId: "right-b" }),
              ]),
            }),
          }),
          7,
        );
        expect(readStoredPaneSelection("env-hidden")).toBeNull();
      });
    } finally {
      stopPersistence();
    }
  });

  test("retains legacy focus when its v2 migration write fails", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: LEGACY_PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "first", type: "plain" },
          { id: "remembered", type: "plain" },
        ],
        activeTabId: "first",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 4,
    });
    writeStoredPaneSelection("env-hidden", {
      activePaneId: "default",
      activeTabIds: { default: "remembered" },
    });
    savePaneLayoutMock.mockRejectedValueOnce(new Error("backend unavailable"));
    const stopPersistence = startPaneLayoutPersistence({
      save: savePaneLayoutMock,
      load: getPaneLayoutMock,
      debounceMs: 5,
    });

    try {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => expect(savePaneLayoutMock).toHaveBeenCalled());
      await waitFor(() => {
        expect(readStoredPaneSelection("env-hidden")).toEqual({
          activePaneId: "default",
          activeTabIds: { default: "remembered" },
        });
      });
      expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
        "remembered",
      );
    } finally {
      stopPersistence();
    }
  });

  test("falls back to the layout's own selection when nothing was remembered", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          { id: "restored-tab", type: "plain" },
          { id: "second-tab", type: "plain" },
        ],
        activeTabId: "restored-tab",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const restored = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(restored?.activePaneId).toBe("restored-pane");
      expect(restored?.root).toMatchObject({ activeTabId: "restored-tab" });
    });
  });

  test("rebinds a restored completed setup tab before stale cleanup can replace its PTY", async () => {
    let resolveSetupSession: ((session: EnvironmentSetupSession | null) => void) | undefined;
    getEnvironmentSetupSessionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSetupSession = resolve;
        }),
    );
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: null,
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "default",
            type: "plain",
            isSetupTab: true,
          },
        ],
        activeTabId: "default",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: true,
            }
          : environment,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain", isSetupTab: true },
    ]);

    await act(async () => {
      resolveSetupSession?.({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        running: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        success: true,
        terminalRunning: true,
      });
    });

    await waitFor(() => {
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey(null, "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain", isSetupTab: true },
    ]);
  });

  test("replaces a completed setup tab that has neither a PTY nor replayable output", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
      hasOutput: false,
    });

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(setupTabIds()).toEqual([]);
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain" },
    ]);
  });

  test("rechecks an already-bound setup tab after setup finishes", async () => {
    getEnvironmentSetupSessionMock
      .mockResolvedValueOnce({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        running: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        terminalRunning: false,
        hasOutput: false,
      })
      .mockResolvedValue({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        running: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        success: true,
        terminalRunning: false,
        hasOutput: false,
      });

    restoreBackendSetupTabLayout({
      setupPhase: "running",
      setupScriptsComplete: false,
    });

    await waitFor(() => {
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey(null, "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
    });

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
      expect(setupTabIds()).toEqual([]);
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain" },
    ]);
  });

  test("keeps a completed setup transcript after its PTY exits", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
      hasOutput: true,
    });

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey(null, "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });
    expect(setupTabIds()).toEqual(["default"]);
  });

  test("keeps a completed setup tab when an older backend does not report hasOutput", async () => {
    // A backend that predates `hasOutput` says nothing about its transcript.
    // Unknown is not empty, so a rolling upgrade must not discard setup history
    // it cannot prove is gone.
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
    });

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey(null, "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });
    expect(setupTabIds()).toEqual(["default"]);
  });

  test("keeps a setup tab this renderer can still replay after the backend frees its buffer", async () => {
    // The backend drops a retained setup buffer minutes after the PTY exits, so
    // `hasOutput` goes false while PersistentTerminal can still paint the
    // transcript from `serializedBuffer`. Retiring the tab would run
    // cleanupTerminalTab and take that buffer with it.
    useTerminalSessionStore.getState().setSession(createSessionKey(null, "default", "env-hidden"), {
      sessionId: "env-hidden:setup",
      serializedBuffer: "cloning repository...\r\nsetup complete\r\n",
    });
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
      hasOutput: false,
    });

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });
    await waitFor(() => {
      expect(setupTabIds()).toEqual(["default"]);
    });
    expect(
      useTerminalSessionStore
        .getState()
        .sessions.get(createSessionKey(null, "default", "env-hidden"))?.serializedBuffer,
    ).toBe("cloning repository...\r\nsetup complete\r\n");
  });

  test("waits for durable setup history to hydrate before retiring a cold setup tab", async () => {
    let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
      hasOutput: false,
    });
    getSessionsByEnvironmentMock.mockResolvedValue([
      {
        id: "persisted-setup",
        environmentId: "env-hidden",
        containerId: "",
        tabId: "default",
        sessionType: "plain",
        status: "disconnected",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:01:00.000Z",
        order: 0,
      },
    ]);
    loadSessionBufferMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePersistentBuffer = resolve;
        }),
    );

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(getSessionsByEnvironmentMock).toHaveBeenCalledWith("env-hidden");
      expect(loadSessionBufferMock).toHaveBeenCalledWith("persisted-setup");
    });
    // An empty renderer-local store is not authoritative while the durable
    // buffer lookup remains unresolved.
    expect(setupTabIds()).toEqual(["default"]);

    await act(async () => {
      resolvePersistentBuffer?.("cold setup history\r\n");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey(null, "default", "env-hidden")),
      ).toMatchObject({
        persistentSessionId: "persisted-setup",
        serializedBuffer: "cold setup history\r\n",
      });
    });
    expect(setupTabIds()).toEqual(["default"]);
  });

  test("keeps a setup tab when durable history cannot be checked", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: false,
      hasOutput: false,
    });
    getSessionsByEnvironmentMock.mockResolvedValue([
      {
        id: "persisted-setup",
        environmentId: "env-hidden",
        containerId: "",
        tabId: "default",
        sessionType: "plain",
        status: "disconnected",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:01:00.000Z",
        order: 0,
      },
    ]);
    loadSessionBufferMock.mockRejectedValue(new Error("buffer store unavailable"));

    restoreBackendSetupTabLayout();

    await waitFor(
      () => {
        expect(loadSessionBufferMock).toHaveBeenCalledTimes(MAX_SETUP_SESSION_BIND_ATTEMPTS);
      },
      { timeout: 2_000 },
    );
    expect(setupTabIds()).toEqual(["default"]);
  });

  test("keeps a replayable setup tab when the backend has forgotten the session entirely", async () => {
    // A restarted backend can lose the session record for an environment whose
    // `setupSessionId` was never persisted. That is not evidence the transcript
    // this renderer already holds is worthless.
    useTerminalSessionStore.getState().setSession(createSessionKey(null, "default", "env-hidden"), {
      sessionId: "env-hidden:setup",
      serializedBuffer: "setup complete\r\n",
    });
    getEnvironmentSetupSessionMock.mockResolvedValue(null);

    restoreBackendSetupTabLayout();

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });
    await waitFor(() => {
      expect(setupTabIds()).toEqual(["default"]);
    });
  });

  test("re-dispatches a post-setup recheck that the in-flight guard turned away", async () => {
    // Setup finishing while a bind is still in flight used to lose the recheck:
    // the guard returned early without scheduling anything, and the settling
    // lookup had read the backend mid-run, so nothing ever re-examined the tab.
    let releaseFirstLookup: (() => void) | undefined;
    let lookups = 0;
    getEnvironmentSetupSessionMock.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstLookup = resolve;
        });
        return {
          environmentId: "env-hidden",
          sessionId: "env-hidden:setup",
          running: true,
          startedAt: "2026-01-01T00:00:00.000Z",
          terminalRunning: true,
          hasOutput: false,
        };
      }
      return {
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        running: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        success: true,
        terminalRunning: false,
        hasOutput: false,
      };
    });

    restoreBackendSetupTabLayout({
      setupPhase: "running",
      setupScriptsComplete: false,
    });

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
      expect(releaseFirstLookup).toBeDefined();
    });

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
    });

    await act(async () => {
      releaseFirstLookup!();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
      expect(setupTabIds()).toEqual([]);
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain" },
    ]);
  });

  test("binds every restored backend-managed setup tab, not just the first", async () => {
    // Binding one tab per effect run relied on the run repeating to reach the
    // next. A tab it never reached was also never settled, and stale-tab
    // cleanup skips unsettled tabs — so the extra pane could neither attach to
    // the setup PTY nor be retired.
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      success: true,
      terminalRunning: true,
    });

    restoreBackendSetupTabLayout({}, [{ id: "setup-2", type: "plain", isSetupTab: true }]);

    await waitFor(() => {
      for (const tabId of ["default", "setup-2"]) {
        expect(
          useTerminalSessionStore
            .getState()
            .sessions.get(createSessionKey(null, tabId, "env-hidden"))?.sessionId,
        ).toBe("env-hidden:setup");
      }
    });
    expect(setupTabIds()).toEqual(["default", "setup-2"]);
  });

  test("retires a restored setup tab with no backend session even when setup never completed", async () => {
    // `setupScriptsComplete` is false and setup is not running, so there is no
    // `env-hidden:setup` PTY coming. Keeping the tab would leave a pane that
    // never connects; removing it lets the initial-layout effect seed a
    // working one.
    getEnvironmentSetupSessionMock.mockResolvedValue(null);

    restoreBackendSetupTabLayout({ setupScriptsComplete: false });

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });

    await waitFor(() => {
      expect(setupTabIds()).toEqual([]);
    });
  });

  test("defers stale setup cleanup until a pending agent launch resolves", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue(null);
    // The restored layout already carries the agent tab, so the durable-launch
    // reconstruction takes its "clear the flag" branch rather than rebuilding
    // the layout. That isolates the cleanup guard: the setup tab survives only
    // because `pendingAgentLaunch` defers cleanup.
    let clearPendingLaunch: (() => void) | undefined;
    setEnvironmentPendingAgentLaunchMock.mockImplementationOnce(
      (environmentId: string) =>
        new Promise((resolve) => {
          clearPendingLaunch = () =>
            resolve({
              ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
              pendingAgentLaunch: false,
            });
        }),
    );

    restoreBackendSetupTabLayout({ pendingAgentLaunch: true }, [{ id: "agent", type: "claude" }]);

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });
    await waitFor(() => {
      expect(clearPendingLaunch).toBeDefined();
    });

    // The lookup has settled with no session, so the tab is stale by every
    // other measure — only the pending launch is holding cleanup back.
    await act(async () => {
      await Promise.resolve();
    });
    expect(setupTabIds()).toEqual(["default"]);

    await act(async () => {
      clearPendingLaunch?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(setupTabIds()).toEqual([]);
    });
    // Cleanup must retire only the dead setup placeholder, never the agent tab
    // the launch just reconstructed.
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .map((tab) => tab.id),
    ).toEqual(["agent"]);
  });

  test("restores a persisted build tab when its authoritative pipeline exists", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-restored",
      environmentId: "env-hidden",
      environmentType: "containerized",
      taskId: "task-restored",
    });
    useBuildPipelineStore.getState().replacePipeline(pipeline);
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "restored-build",
            type: "claude-build",
            buildTabData: {
              environmentId: "stale-environment",
              pipelineId: pipeline.id,
              taskId: pipeline.taskId,
              isLocal: true,
            },
          },
        ],
        activeTabId: "restored-build",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 3,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-hidden");
      expect(tabs).toHaveLength(2);
      expect(tabs).toContainEqual(
        expect.objectContaining({
          id: "restored-build",
          type: "claude-build",
          buildTabData: {
            environmentId: "env-hidden",
            pipelineId: pipeline.id,
            taskId: pipeline.taskId,
            isLocal: false,
          },
        }),
      );
      expect(tabs).toContainEqual(
        expect.objectContaining({
          id: "default",
          type: "plain",
        }),
      );
      expect(usePaneLayoutStore.getState().getPane("restored-pane", "env-hidden")).not.toBeNull();
    });
  });

  test("filters a persisted build tab when its pipeline is absent", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "orphan-build",
            type: "claude-build",
            buildTabData: {
              environmentId: "env-hidden",
              pipelineId: "missing-pipeline",
              taskId: "missing-task",
              isLocal: false,
            },
          },
        ],
        activeTabId: "orphan-build",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 3,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-hidden");
      expect(tabs.some((tab) => tab.type === "claude-build")).toBe(false);
      expect(tabs).toContainEqual(expect.objectContaining({ type: "plain" }));
    });
  });

  test("reconstructs a looped-review tab only after its authoritative workflow hydrates", async () => {
    const workflow = loopedReviewFixture({
      environmentId: "env-hidden",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
      startingAllowance: 6,
      currentAllowance: 6,
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    useLoopedReviewStore.setState({ workflows: new Map() });
    listLoopedReviewWorkflowsMock.mockResolvedValue([
      {
        version: workflow.version,
        id: workflow.id,
        environmentId: workflow.environmentId,
        snapshot: workflow,
        updatedAt: workflow.updatedAt,
        revision: 3,
      },
    ]);
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "restored-looped-review",
            type: "looped-review",
            loopedReviewTabData: {
              environmentId: "env-hidden",
              workflowId: workflow.id,
              isLocal: false,
            },
          },
        ],
        activeTabId: "restored-looped-review",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toMatchObject({
        backendRevision: 3,
        phase: "preparing",
      });
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toMatchObject([
        {
          id: "restored-looped-review",
          type: "looped-review",
          loopedReviewTabData: {
            environmentId: "env-hidden",
            workflowId: workflow.id,
          },
        },
      ]);
    });
  });

  test("preserves persisted review tabs when workflow hydration is unavailable", async () => {
    listLoopedReviewWorkflowsMock.mockRejectedValue(new Error("workflow store unavailable"));
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "restored-pane",
      root: {
        kind: "leaf",
        id: "restored-pane",
        tabs: [
          {
            id: "restored-file",
            type: "file",
            displayTitle: "README",
            fileData: {
              filePath: "README.md",
              containerId: "container-hidden",
            },
          },
          {
            id: "restored-review",
            type: "looped-review",
            loopedReviewTabData: {
              environmentId: "env-hidden",
              workflowId: "workflow-unknown",
              isLocal: false,
            },
          },
        ],
        activeTabId: "restored-file",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toMatchObject([
        { id: "restored-file", type: "file", displayTitle: "README" },
        {
          id: "restored-review",
          type: "looped-review",
          loopedReviewTabData: { workflowId: "workflow-unknown" },
        },
      ]);
    });
  });

  test("completes hydration with a default layout when restore rejects", async () => {
    getPaneLayoutMock.mockRejectedValue(new Error("backend unavailable"));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toMatchObject([
        { id: "default", type: "plain" },
      ]);
    });
  });

  test("falls back to a default layout when the persisted tree is malformed", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "broken",
      root: { kind: "leaf", id: "broken", tabs: "not-an-array" },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(usePaneLayoutStore.getState().getActivePane("env-hidden")?.id).toBe("default");
    });
  });

  test("rejects a layout for a stale container and seeds the current container", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "stale-container",
      activePaneId: "restored",
      root: {
        kind: "leaf",
        id: "restored",
        tabs: [{ id: "stale-tab", type: "plain" }],
        activeTabId: "stale-tab",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .map((tab) => tab.id),
      ).toEqual(["default"]);
      expect(usePaneLayoutStore.getState().getContainerId("env-hidden")).toBe("container-hidden");
    });
  });

  test("does not start a duplicate restore while hydration is pending", async () => {
    usePaneLayoutStore.setState((state) => ({
      ...state,
      environments: new Map(state.environments).set("env-hidden", {
        root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
      hydration: new Map(state.hydration).set("env-hidden", "pending"),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await act(async () => {});
    expect(getPaneLayoutMock).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("pending");
  });

  test("finishes an in-flight hydration if the environment is deleted", async () => {
    let resolveLayout!: (layout: PersistedPaneLayout | null) => void;
    getPaneLayoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLayout = resolve;
        }),
    );

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );
    await waitFor(() => expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden"));
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.filter((environment) => environment.id !== "env-hidden"),
    }));
    resolveLayout(null);

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
    });
  });

  test("creates a codex terminal tab when codexMode is terminal", async () => {
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
              codex: { mode: "terminal" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Review this diff",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const codexTab = envHidden.root.tabs.find((tab) => tab.type === "codex");
      expect(codexTab?.initialPrompt).toBe("Review this diff");
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });
  });

  test("saves container initial prompt attachments before creating the agent tab", async () => {
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
              codex: { mode: "terminal" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Use this screenshot",
          initialPromptAttachments: [
            {
              id: "img-1",
              name: "screen shot.png",
              previewUrl: "data:image/png;base64,QUJD",
              base64Data: "QUJD",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(writeContainerFileMock).toHaveBeenCalledWith(
        "container-hidden",
        ".orkestrator/initial-prompt/screen-shot.png",
        "QUJD",
      );
    });

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const codexTab = envHidden.root.tabs.find((tab) => tab.type === "codex");
      expect(codexTab?.initialPrompt).toContain("Use this screenshot");
      expect(codexTab?.initialPrompt).toContain(
        "/workspace/.orkestrator/initial-prompt/screen-shot.png",
      );
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });

    // The attachment references only existed in the renderer's options store, so
    // they are persisted too — otherwise a launch recovered after page eviction
    // would dispatch the raw prompt with no way to reach the saved files.
    await waitFor(() => {
      expect(setEnvironmentInitialPromptMock).toHaveBeenCalled();
    });
    const [, persistedPrompt] = setEnvironmentInitialPromptMock.mock.calls.at(-1)!;
    expect(persistedPrompt).toContain("Use this screenshot");
    expect(persistedPrompt).toContain("/workspace/.orkestrator/initial-prompt/screen-shot.png");
    expect(useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.initialPrompt).toBe(
      persistedPrompt,
    );
  });

  test("does not persist a prompt that attachment saving left unchanged", async () => {
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "No attachments here",
          initialPromptAttachments: [],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toHaveLength(1);
    });
    // Nothing was rewritten, so there is nothing to write back.
    expect(setEnvironmentInitialPromptMock).not.toHaveBeenCalled();
  });

  test("still creates the agent tab when persisting the rewritten prompt fails", async () => {
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
    setEnvironmentInitialPromptMock.mockRejectedValueOnce(new Error("offline"));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Use this screenshot",
          initialPromptAttachments: [
            {
              id: "img-1",
              name: "shot.png",
              previewUrl: "data:image/png;base64,QUJD",
              base64Data: "QUJD",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);

    try {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(setEnvironmentInitialPromptMock).toHaveBeenCalled();
      });
      // Persisting the references is a durability improvement, not a
      // precondition: the launch must still happen in this session.
      await waitFor(() => {
        const codexTab = usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .find((tab) => tab.type === "codex");
        expect(codexTab?.initialPrompt).toContain("shot.png");
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("saves local initial prompt attachments before creating the agent tab", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env,
      ),
    }));

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
              codex: { mode: "terminal" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Use local image",
          initialPromptAttachments: [
            {
              id: "img-1",
              name: "local.png",
              previewUrl: "data:image/png;base64,REVG",
              base64Data: "REVG",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(writeLocalFileMock).toHaveBeenCalledWith(
        "/tmp/env-hidden-worktree",
        ".orkestrator/initial-prompt/local.png",
        "REVG",
      );
    });

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs[0]?.type).toBe("codex");
      expect(envHidden.root.tabs[0]?.initialPrompt).toContain(
        "/tmp/env-hidden-worktree/.orkestrator/initial-prompt/local.png",
      );
      expect(writeContainerFileMock).not.toHaveBeenCalled();
    });
  });

  test("retains failed initial prompt attachments and waits for a retry", async () => {
    writeContainerFileMock.mockImplementation(async () => {
      throw new Error("disk full");
    });

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
              codex: { mode: "terminal" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Continue without image",
          initialPromptAttachments: [
            {
              id: "img-1",
              name: "failed.png",
              previewUrl: "data:image/png;base64,QUJD",
              base64Data: "QUJD",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive
        />
      </TerminalProvider>,
    );

    await waitFor(() => expect(writeContainerFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toEqual([]);
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
      expect(
        useClaudeOptionsStore.getState().getOptions("env-hidden")?.initialPromptAttachments,
      ).toEqual([expect.objectContaining({ id: "img-1", name: "failed.png" })]);
    });
  });

  test("creates a codex native tab for ready local environments when codexMode is native", async () => {
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
              codex: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env,
      ),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Ship it",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.id).toBe("startup-agent");
      expect(envHidden.root.tabs[0]?.type).toBe("agent-native");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Ship it");
    });
  });

  test("leaves initial prompt images to the backend when it owns the native launch", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupPhase: "ready",
              setupScriptsComplete: true,
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
              initialPrompt: "Inspect this screenshot",
              pendingAgentLaunch: true,
            }
          : env,
      ),
    }));
    const attachments = [
      {
        id: "img-1",
        name: "race.png",
        previewUrl: "data:image/png;base64,UkFDRQ==",
        base64Data: "UkFDRQ==",
      },
    ];
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Inspect this screenshot",
          initialPromptAttachments: attachments,
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // The backend dispatches this launch and stages the images itself, so the
    // renderer must not rewrite the prompt into a list of paths — doing so also
    // clears the stored attachments, which is what left the agent with a
    // filename instead of the image.
    expect(writeLocalFileMock).not.toHaveBeenCalled();
    expect(setEnvironmentInitialPromptMock).not.toHaveBeenCalled();
    // Optimistic projection may drop the renderer copy; the backend still owns
    // the attachments. The rewrite path would empty them and also persist paths.
    expect(
      useClaudeOptionsStore.getState().getOptions("env-hidden")?.initialPromptAttachments ??
        attachments,
    ).toEqual(attachments);
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).not.toContainEqual(
      expect.objectContaining({
        initialPrompt: expect.stringContaining(".orkestrator/initial-prompt"),
      }),
    );
  });

  test("leaves an attachment-only native launch to the backend", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupPhase: "ready",
              setupScriptsComplete: true,
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
              initialPrompt: "",
              pendingAgentLaunch: true,
            }
          : env,
      ),
    }));
    const attachments = [
      {
        id: "img-only",
        name: "image-only.png",
        previewUrl: "data:image/png;base64,SU1BR0U=",
        base64Data: "SU1BR0U=",
      },
    ];
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "",
          initialPromptAttachments: attachments,
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(writeLocalFileMock).not.toHaveBeenCalled();
    expect(setEnvironmentInitialPromptMock).not.toHaveBeenCalled();
    // Optimistic projection may drop the renderer copy; the backend still owns
    // the attachments. The rewrite path would empty them and also persist paths.
    expect(
      useClaudeOptionsStore.getState().getOptions("env-hidden")?.initialPromptAttachments ??
        attachments,
    ).toEqual(attachments);
  });

  test("still stages images itself for a tmux-backed native Claude launch", async () => {
    // `native` is not sufficient: a tmux launch needs a real tmux session, so
    // the backend leaves it to the terminal coordinator. If the renderer stood
    // down here too, nothing would deliver the image.
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupPhase: "ready",
              setupScriptsComplete: true,
              agentSettings: {
                defaultAgent: "claude",
                platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } },
              },
              initialPrompt: "Inspect this screenshot",
              pendingAgentLaunch: true,
            }
          : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Inspect this screenshot",
          initialPromptAttachments: [
            {
              id: "img-tmux",
              name: "tmux.png",
              previewUrl: "data:image/png;base64,VE1VWA==",
              base64Data: "VE1VWA==",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(writeLocalFileMock).toHaveBeenCalledWith(
        "/tmp/env-hidden-worktree",
        ".orkestrator/initial-prompt/tmux.png",
        "VE1VWA==",
      );
    });
  });

  test("stands down for a native launch the repository's agent style selects", async () => {
    // The backend resolves the Claude style through the repository tier as
    // well. The renderer has to reach the same verdict from the same tier, or
    // it rewrites a prompt the backend is about to dispatch with real images.
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
              claude: { ...state.config.global.agentSettings?.platforms?.claude, mode: "terminal" },
            },
          },
        },
        repositories: {
          ...state.config.repositories,
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            ...state.config.repositories["project-1"],
            agentSettings: { platforms: { claude: { mode: "native" as const } } },
          },
        },
      },
    }));
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              projectId: "project-1",
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupPhase: "ready",
              setupScriptsComplete: true,
              agentSettings: {
                defaultAgent: "claude",
                platforms: { claude: { mode: undefined, claudeNativeBackend: undefined } },
              },
              initialPrompt: "Inspect this screenshot",
              pendingAgentLaunch: true,
            }
          : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Inspect this screenshot",
          initialPromptAttachments: [
            {
              id: "img-repo",
              name: "repo.png",
              previewUrl: "data:image/png;base64,UkVQTw==",
              base64Data: "UkVQTw==",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(writeLocalFileMock).not.toHaveBeenCalled();
    expect(setEnvironmentInitialPromptMock).not.toHaveBeenCalled();
  });

  test("does not reconstruct a second tab while a terminal launch stages images", async () => {
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
    let resolveAttachmentWrite: ((savedPath: string) => void) | undefined;
    writeLocalFileMock.mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          resolveAttachmentWrite = resolve;
        }),
    );
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "terminal" } } },
              initialPrompt: "Inspect this screenshot",
              pendingAgentLaunch: true,
            }
          : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Inspect this screenshot",
          initialPromptAttachments: [
            {
              id: "img-1",
              name: "race.png",
              previewUrl: "data:image/png;base64,UkFDRQ==",
              base64Data: "UkFDRQ==",
            },
          ],
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    // A PTY prompt cannot carry an attachment, so this path still rewrites the
    // prompt into workspace paths — and must not seed a second tab while the
    // staging write is in flight.
    await waitFor(() => expect(writeLocalFileMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveAttachmentWrite?.("/tmp/env-hidden-worktree/.orkestrator/initial-prompt/race.png");
      await Promise.resolve();
    });

    await waitFor(() => {
      const codexTabs = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .filter((tab) => tab.type === "codex");
      expect(codexTabs).toHaveLength(1);
      expect(codexTabs[0]?.initialPrompt).toContain(
        "/tmp/env-hidden-worktree/.orkestrator/initial-prompt/race.png",
      );
    });
  });

  test("creates a Claude tmux tab for ready local environments when Claude native backend is tmux", async () => {
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

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env,
      ),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Use tmux",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("claude-tmux");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Use tmux");
      expect(envHidden.root.tabs[0]?.claudeTmuxData).toEqual({
        containerId: undefined,
        environmentId: "env-hidden",
        isLocal: true,
      });
    });
  });

  test("creates a Claude tmux tab after local setup is ready", async () => {
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

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env,
      ),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "After setup",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("claude-tmux");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("After setup");
      expect(envHidden.root.activeTabId).toBe("startup-agent");
    });
  });

  test("creates a regular terminal for a ready local environment when no agent is requested", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : environment,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
        {
          id: "default",
          type: "plain",
        },
      ]);
    });
  });

  test("creates a terminal-mode agent tab for ready local environments", async () => {
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
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : environment,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "opencode",
          initialPrompt: "Continue locally",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-hidden");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        type: "opencode",
        initialPrompt: "Continue locally",
      });
    });
  });

  test("creates Codex and OpenCode native tabs for ready local environments", async () => {
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
              codex: { mode: "native" },
              opencode: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));
    usePaneLayoutStore.setState({
      environments: new Map(),
      hydration: new Map([
        ["env-visible", "done"],
        ["env-hidden", "done"],
      ]),
      activeEnvironmentId: "env-visible",
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) => ({
        ...environment,
        containerId: null,
        environmentType: "local",
        worktreePath: `/tmp/${environment.id}-worktree`,
      })),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-visible": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Codex after setup",
        },
        "env-hidden": {
          launchAgent: true,
          agentType: "opencode",
          initialPrompt: "OpenCode after setup",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-visible" containerId={null} isActive={false} />
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")).toMatchObject([
        {
          type: "agent-native",
          initialPrompt: "Codex after setup",
          nativeAgentData: { environmentId: "env-visible", isLocal: true },
        },
      ]);
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toMatchObject([
        {
          type: "agent-native",
          initialPrompt: "OpenCode after setup",
          nativeAgentData: { environmentId: "env-hidden", isLocal: true },
        },
      ]);
    });
  });

  test("creates OpenCode native and Claude SDK initial tabs for local environments without setup", async () => {
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
              opencode: { mode: "native" },
              claude: { mode: "native", claudeNativeBackend: "sdk" },
            },
          },
        },
        repositories: {},
      },
    }));
    usePaneLayoutStore.setState({
      environments: new Map(),
      hydration: new Map([
        ["env-visible", "done"],
        ["env-hidden", "done"],
      ]),
      activeEnvironmentId: "env-visible",
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) => ({
        ...environment,
        containerId: null,
        environmentType: "local",
        worktreePath: `/tmp/${environment.id}-worktree`,
      })),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-visible": { launchAgent: true, agentType: "opencode", initialPrompt: "" },
        "env-hidden": { launchAgent: true, agentType: "claude", initialPrompt: "" },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-visible" containerId={null} isActive={false} />
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: {
          containerId: undefined,
          environmentId: "env-visible",
          isLocal: true,
        },
      });
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: {
          containerId: undefined,
          environmentId: "env-hidden",
          isLocal: true,
        },
      });
    });
  });

  test("creates OpenCode, Codex, and Claude native initial tabs for setup-complete containers", async () => {
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
              opencode: { mode: "native" },
              claude: { mode: "native", claudeNativeBackend: "sdk" },
            },
          },
        },
        repositories: {},
      },
    }));
    usePaneLayoutStore.setState({
      environments: new Map(),
      hydration: new Map([
        ["env-visible", "done"],
        ["env-hidden", "done"],
        ["env-third", "done"],
      ]),
      activeEnvironmentId: "env-visible",
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: [
        ...state.environments.map((environment) => ({
          ...environment,
          setupScriptsComplete: true,
        })),
        {
          ...state.environments[0]!,
          id: "env-third",
          name: "third",
          containerId: "container-third",
          setupScriptsComplete: true,
          order: 2,
        },
      ],
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-visible": { launchAgent: true, agentType: "opencode", initialPrompt: "" },
        "env-hidden": { launchAgent: true, agentType: "codex", initialPrompt: "" },
        "env-third": { launchAgent: true, agentType: "claude", initialPrompt: "" },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-visible"
          containerId="container-visible"
          isContainerRunning
          isActive={false}
        />
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
        <TerminalContainer
          environmentId="env-third"
          containerId="container-third"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-visible")[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: {
          containerId: "container-visible",
          environmentId: "env-visible",
          isLocal: false,
        },
      });
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: {
          containerId: "container-hidden",
          environmentId: "env-hidden",
          isLocal: false,
        },
      });
      expect(usePaneLayoutStore.getState().getAllTabs("env-third")[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: {
          containerId: "container-third",
          environmentId: "env-third",
          isLocal: false,
        },
      });
    });
  });

  test("resumes a pending container native launch after the environment remounts", async () => {
    seedContainerSetupCommands();
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });
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
              codex: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Continue after setup",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
      pendingNativeLaunches: {},
    });

    const firstRender = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
      ).toBe(true);
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeDefined();
    });

    firstRender.unmount();

    // Simulate the old timer clearing transient options while the durable
    // launch intent survives the component unmount.
    useClaudeOptionsStore.getState().clearOptions("env-hidden");
    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "ready" });
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const nativeTab = envHidden.root.tabs.find((tab) => tab.type === "agent-native");
      expect(nativeTab?.id).toBe("startup-agent");
      expect(nativeTab?.initialPrompt).toBe("Continue after setup");
      expect(nativeTab?.initialAgentModel).toBe("gpt-5.6-sol");
      expect(nativeTab?.initialReasoningEffort).toBe("high");
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
      ).toBe(false);
    });
  });

  test("launches a pending native tab when persisted setup is complete but workspaceReady is stale", async () => {
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      environments.set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "default", type: "plain", isSetupTab: true }],
          activeTabId: "default",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      });
      return { ...state, environments };
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              setupScriptsComplete: true,
            }
          : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-hidden": {
          containerId: "container-hidden",
          environmentId: "env-hidden",
          initialPrompt: "Recover from stale setup state",
          targetPaneId: "default",
          agentType: "codex",
          launchMode: "native",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const nativeTab = envHidden.root.tabs.find((tab) => tab.type === "agent-native");
      expect(nativeTab?.initialPrompt).toBe("Recover from stale setup state");
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "ready",
      ).toBe(true);
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
      ).toBe(false);
    });
  });

  test("falls back to the live active pane when a pending launch target disappeared", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "survivor",
              tabs: [{ id: "existing", type: "plain" }],
              activeTabId: "existing",
            },
            activePaneId: "survivor",
            containerId: "container-hidden",
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: null,
    } as never);
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden" ? { ...env, setupScriptsComplete: true } : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-hidden": {
          containerId: "container-hidden",
          environmentId: "env-hidden",
          targetPaneId: "removed-pane",
          agentType: "codex",
          launchMode: "native",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const survivor = usePaneLayoutStore.getState().getPane("survivor", "env-hidden");
      expect(survivor?.tabs).toContainEqual(
        expect.objectContaining({
          id: "startup-agent",
          type: "agent-native",
        }),
      );
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });
  });

  test("renders a durable native launch without consuming the backend intent", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "default", type: "plain", isSetupTab: true }],
              activeTabId: "default",
            },
            activePaneId: "default",
            containerId: "container-hidden",
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: null,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
              setupScriptsComplete: true,
              pendingAgentLaunch: true,
              initialPrompt: "Recover after mobile reload",
              initialAgentModel: "gpt-5.6-sol",
              initialReasoningEffort: "high",
            }
          : environment,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const codexTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "agent-native");
      // Every renderer must choose the same logical tab so pane-layout merging,
      // Codex session creation, and initial-prompt dispatch are idempotent.
      expect(codexTab?.id).toBe("startup-agent");
      // The backend dispatches the prompt; the renderer only represents the
      // launch and must not dispatch a second copy from the tab.
      expect(codexTab?.initialPrompt).toBeUndefined();
      expect(codexTab?.initialAgentModel).toBe("gpt-5.6-sol");
      expect(codexTab?.initialReasoningEffort).toBe("high");
    });

    // The frontend may optimistically represent the intent, but only the
    // backend may consume it after the provider session and pane are durable.
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.pendingAgentLaunch,
    ).toBe(true);
  });

  test("projects a backend-created session into one stable tab without acknowledging it", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      pendingAgentLaunch: false,
      initialPrompt: undefined,
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
      startupAgentSession: {
        tabId: "startup-agent",
        agent: "codex",
        style: "native",
        providerSessionId: "provider-session",
        status: "running",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        startedAt: "2026-07-29T12:00:00.000Z",
      },
    });
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "codex",
                environmentId: "env-hidden",
                containerId: "container-hidden",
                sessionId: "provider-session",
              },
              initialAgentModel: "gpt-5.6-sol",
              initialReasoningEffort: "high",
            },
          ],
          activeTabId: "startup-agent",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
    }));

    renderHiddenTerminal();

    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-hidden");
      expect(tabs.filter((tab) => tab.id === "startup-agent")).toHaveLength(1);
      expect(tabs.find((tab) => tab.id === "startup-agent")).toMatchObject({
        type: "agent-native",
        nativeAgentData: { sessionId: "provider-session" },
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "high",
      });
    });
    expect(acknowledgeStartupAgentSessionMock).not.toHaveBeenCalled();
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
  });

  test("activates the backend-created agent tab when local setup finishes", async () => {
    seedStartupFocusHandoffConfig();
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "default", type: "plain", isSetupTab: true },
                startupAgentTabFixture("env-hidden"),
              ],
              activeTabId: "default",
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: "env-hidden",
    } as never);
    seedStartupFocusHandoffEnvironment("env-hidden", { setupReady: false });
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
        "default",
      );
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .some((tab) => tab.id === "startup-agent"),
      ).toBe(true);
    });

    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
    });

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
        "startup-agent",
      );
    });
  });

  test("leaves a deliberately selected tab alone when local setup finishes", async () => {
    seedStartupFocusHandoffConfig();
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "default", type: "plain", isSetupTab: true },
                { id: "shell-2", type: "plain" },
                startupAgentTabFixture("env-hidden"),
              ],
              // The user clicked away from the setup terminal before it finished.
              activeTabId: "shell-2",
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: "env-hidden",
    } as never);
    seedStartupFocusHandoffEnvironment("env-hidden", { setupReady: false });
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive />
      </TerminalProvider>,
    );

    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
    });

    // Nothing here is allowed to move the selection, so settle the effects and
    // then assert the selection never left the tab the user chose.
    await act(async () => {
      await Promise.resolve();
    });
    expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
      "shell-2",
    );
  });

  test("does not hand off setup focus again when the environment is reselected", async () => {
    seedStartupFocusHandoffConfig();
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "default", type: "plain", isSetupTab: true },
                startupAgentTabFixture("env-hidden"),
              ],
              activeTabId: "default",
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
        // A second environment that also owns a startup agent. Visiting it is
        // what used to re-arm a scalar "already handed off" marker.
        [
          "env-second",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "second-shell", type: "plain" }, startupAgentTabFixture("env-second")],
              activeTabId: "second-shell",
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
      ]),
      hydration: new Map([
        ["env-hidden", "done"],
        ["env-second", "done"],
      ]),
      activeEnvironmentId: "env-hidden",
    } as never);
    seedStartupFocusHandoffEnvironment("env-hidden", { setupReady: true });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: [
        ...state.environments,
        {
          ...state.environments.find((environment) => environment.id === "env-hidden")!,
          id: "env-second",
          name: "second",
          worktreePath: "/tmp/env-second-worktree",
          setupPhase: "ready",
          setupScriptsComplete: true,
          pendingAgentLaunch: false,
          startupAgentSession: undefined,
        },
      ],
    }));
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
        "startup-agent",
      );
    });

    // The user goes back to the setup terminal, which keeps `isSetupTab` for
    // the life of the environment, then visits another environment and returns.
    await act(async () => {
      usePaneLayoutStore.getState().setActiveTab("default", "default", "env-hidden");
    });
    rerender(
      <TerminalProvider>
        <TerminalContainer environmentId="env-second" containerId={null} isActive />
      </TerminalProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive />
      </TerminalProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(usePaneLayoutStore.getState().getPane("default", "env-hidden")?.activeTabId).toBe(
      "default",
    );
  });

  test("replaces a stale renderer launch with the backend running session", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      pendingAgentLaunch: false,
      startupAgentSession: {
        tabId: "startup-agent",
        agent: "codex",
        style: "native",
        providerSessionId: "backend-provider-session",
        status: "running",
        model: "backend-model",
        reasoningEffort: "high",
        startedAt: "2026-07-29T12:00:00.000Z",
      },
    });
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "codex",
                environmentId: "env-hidden",
                containerId: "container-hidden",
                sessionId: "backend-provider-session",
              },
              initialAgentModel: "backend-model",
              initialReasoningEffort: "high",
            },
          ],
          activeTabId: "startup-agent",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
    }));
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-hidden": {
          containerId: "stale-container",
          environmentId: "env-hidden",
          initialPrompt: "stale prompt that must not be dispatched",
          targetPaneId: "default",
          agentType: "claude",
          launchMode: "native",
          providerSessionId: "stale-provider-session",
          model: "stale-model",
          reasoningEffort: "low",
        },
      },
    });

    renderHiddenTerminal();

    await waitFor(() => {
      const startupTabs = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .filter((tab) => tab.id === "startup-agent");
      expect(startupTabs).toHaveLength(1);
      expect(startupTabs[0]).toMatchObject({
        type: "agent-native",
        nativeAgentData: { sessionId: "backend-provider-session" },
        initialAgentModel: "backend-model",
        initialReasoningEffort: "high",
      });
      expect(startupTabs[0]?.initialPrompt).toBeUndefined();
    });
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .some((tab) => tab.id !== "startup-agent" && tab.type.endsWith("native")),
    ).toBe(false);
  });

  test("toasts each distinct startup error once and allows a later retry to re-report it", async () => {
    setupDurableLaunchEnvironment({
      name: "Hidden environment",
      startupAgentSession: {
        tabId: "startup-agent",
        agent: "codex",
        style: "native",
        status: "error",
        error: "Provider refused the launch",
      },
    });
    renderHiddenTerminal();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("codex could not start in Hidden environment", {
        description: "Provider refused the launch",
        duration: 10_000,
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        branch: "unrelated-render",
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "error",
          error: "Session handshake timed out",
        },
      });
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(2));

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "starting",
        },
      });
    });
    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "error",
          error: "Session handshake timed out",
        },
      });
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(3));

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "starting",
        },
      });
    });
    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "error",
        },
      });
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledTimes(4);
      expect(mockToastError).toHaveBeenLastCalledWith(
        "codex could not start in Hidden environment",
        { description: "The agent could not be started.", duration: 10_000 },
      );
    });
  });

  test("stops carrying the options once the agent surface acknowledges them", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    renderHiddenTerminal();
    const tabId = await waitForDurableAgentTab();

    await act(async () => {
      usePaneLayoutStore.getState().clearTabInitialAgentOptions(tabId, "env-hidden");
      await Promise.resolve();
    });

    const agentTab = usePaneLayoutStore
      .getState()
      .getAllTabs("env-hidden")
      .find((tab) => tab.id === tabId);
    expect(agentTab?.initialAgentModel).toBeUndefined();
    expect(agentTab?.initialReasoningEffort).toBeUndefined();
  });

  test("carries an effort-only durable launch with no model", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      initialAgentModel: undefined,
      initialReasoningEffort: "xhigh",
    });
    renderHiddenTerminal();

    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "agent-native");
      expect(agentTab?.initialReasoningEffort).toBe("xhigh");
      expect(agentTab?.initialAgentModel).toBeUndefined();
    });
  });

  test("records the durable model and effort on the pending native launch itself", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });

    // The record is consumed into a tab on the very next render, so sample every
    // value the store holds rather than polling for a state that has already
    // been cleared. The tab is built from this record, so a regression here
    // silently drops the user's choice on every consuming branch.
    const observed: Array<{ model?: string; reasoningEffort?: string }> = [];
    const unsubscribe = useClaudeOptionsStore.subscribe((state) => {
      const pending = state.pendingNativeLaunches["env-hidden"];
      if (pending)
        observed.push({ model: pending.model, reasoningEffort: pending.reasoningEffort });
    });

    try {
      renderHiddenTerminal();
      await waitForDurableAgentTab();
      expect(observed).toContainEqual({ model: "gpt-5.6-sol", reasoningEffort: "high" });
    } finally {
      unsubscribe();
    }
  });

  test("does not make a backend-owned native launch depend on renderer persistence", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    renderHiddenTerminal();
    await waitForDurableAgentTab();

    expect(savePaneLayoutMock).not.toHaveBeenCalled();
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.pendingAgentLaunch,
    ).toBe(true);
  });

  test("leaves native launch consumption to the backend across rerenders", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    renderHiddenTerminal();
    await waitForDurableAgentTab();
    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", { branch: "rerender" });
      await Promise.resolve();
    });

    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.pendingAgentLaunch,
    ).toBe(true);
  });

  test("keeps the authoritative setup phase while representing a durable launch", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });

    renderHiddenTerminal();
    await waitForDurableAgentTab();

    const environment = useEnvironmentStore.getState().getEnvironmentById("env-hidden");
    expect(environment?.pendingAgentLaunch).toBe(true);
    expect(environment?.setupPhase).toBe("ready");
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
  });

  test("does not resurrect a startup tab the user closed after the launch converged", async () => {
    // The state a converged backend launch leaves behind: the intent is
    // consumed, and the user has since closed the startup tab. Re-projecting it
    // here would recreate it on every render and make the close impossible.
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      pendingAgentLaunch: false,
      startupAgentSession: {
        tabId: "startup-agent",
        agent: "codex",
        style: "native",
        providerSessionId: "provider-session",
        status: "running",
        startedAt: "2026-07-29T12:00:00.000Z",
      },
    });

    renderHiddenTerminal();
    await act(async () => {
      await Promise.resolve();
    });
    // A rerender must not find a second chance to re-project it either.
    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", { branch: "rerender" });
      await Promise.resolve();
    });

    expect(useClaudeOptionsStore.getState().pendingNativeLaunches["env-hidden"]).toBeUndefined();
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.id === "startup-agent"),
    ).toBeUndefined();
  });

  test("still binds the backend session to a startup tab that is still open", async () => {
    // The converged-launch guard must not cost the binding that a renderer
    // which was inactive during the launch still depends on.
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      pendingAgentLaunch: false,
      startupAgentSession: {
        tabId: "startup-agent",
        agent: "codex",
        style: "native",
        providerSessionId: "provider-session",
        status: "running",
        startedAt: "2026-07-29T12:00:00.000Z",
      },
    });
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "codex",
                environmentId: "env-hidden",
                containerId: "container-hidden",
              },
            },
          ],
          activeTabId: "startup-agent",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
    }));

    renderHiddenTerminal();

    await waitFor(() => {
      const startupTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.id === "startup-agent");
      expect(startupTab?.nativeAgentData?.sessionId).toBe("provider-session");
    });
  });

  test("restores a backend-published native startup tab instead of manufacturing one", async () => {
    getPaneLayoutMock.mockResolvedValue({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-hidden",
      containerId: "container-hidden",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: {
              platform: "codex",
              environmentId: "env-hidden",
              containerId: "container-hidden",
              sessionId: "backend-provider-session",
            },
            initialAgentModel: "gpt-5.6-sol",
            initialReasoningEffort: "high",
          },
        ],
        activeTabId: "startup-agent",
      },
      updatedAt: "2026-07-29T12:00:00.000Z",
      revision: 3,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
              setupScriptsComplete: true,
              pendingAgentLaunch: true,
              initialAgentModel: "gpt-5.6-sol",
              initialReasoningEffort: "high",
            }
          : environment,
      ),
    }));

    renderHiddenTerminal();

    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-hidden");
      expect(tabs.filter((tab) => tab.id === "startup-agent")).toHaveLength(1);
      expect(tabs.find((tab) => tab.id === "startup-agent")).toMatchObject({
        type: "agent-native",
        nativeAgentData: { sessionId: "backend-provider-session" },
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "high",
      });
    });
    expect(getPaneLayoutMock).toHaveBeenCalledWith("env-hidden");
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    expect(savePaneLayoutMock).not.toHaveBeenCalled();
  });

  test("does not reconstruct a durable launch while the environment is not running", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isActive={false}
        />
      </TerminalProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(useClaudeOptionsStore.getState().pendingNativeLaunches["env-hidden"]).toBeUndefined();
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
  });

  test("does not queue a second launch when one is already pending", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    const existing = {
      containerId: "container-hidden",
      environmentId: "env-hidden",
      targetPaneId: "default",
      agentType: "claude" as const,
      launchMode: "native" as const,
      initialPrompt: "already queued",
    };
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: { "env-hidden": existing },
    });

    renderHiddenTerminal();

    // The transient launch already in flight wins; the durable path must not
    // overwrite it and produce a second agent tab.
    await waitFor(() => {
      const agentTabs = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .filter((tab) => tab.type === "agent-native");
      expect(agentTabs).toHaveLength(1);
      expect(agentTabs[0]?.type).toBe("agent-native");
      expect(agentTabs[0]?.initialPrompt).toBe("already queued");
    });
  });

  test("reconstructs a terminal-mode agent launch when the agent is not in native mode", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "terminal" } } },
    });

    renderHiddenTerminal();

    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "codex");
      expect(agentTab).toBeDefined();
      expect(agentTab?.initialPrompt).toBe("Recover after mobile reload");
    });
    // Terminal mode must not produce a native tab.
    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .some((tab) => tab.type === "agent-native"),
    ).toBe(false);
  });

  test("reconstructs a native Claude launch carrying the resolved native backend", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: {
        defaultAgent: "claude",
        platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } },
      },
    });

    renderHiddenTerminal();

    // The tmux backend selects a different tab type, so the resolved backend has
    // to reach the launch rather than being dropped.
    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "claude-tmux");
      expect(agentTab).toBeDefined();
      expect(agentTab?.claudeTmuxData?.environmentId).toBe("env-hidden");
      expect(agentTab?.initialPrompt).toBe("Recover after mobile reload");
    });
  });

  test("falls back to the global default agent when the environment has none", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { platforms: { opencode: { mode: "native" } } },
    });
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: { ...state.config.global.agentSettings, defaultAgent: "opencode" },
        },
      },
    }));

    renderHiddenTerminal();

    await waitFor(() => {
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .some((tab) => tab.type === "agent-native"),
      ).toBe(true);
    });
  });

  test("reconstructs a local environment launch with no container id", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      environmentType: "local",
      worktreePath: "/tmp/worktree-hidden",
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isContainerRunning={false}
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "agent-native");
      expect(agentTab).toBeDefined();
      expect(agentTab?.nativeAgentData?.isLocal).toBe(true);
      expect(agentTab?.nativeAgentData?.containerId).toBeUndefined();
    });
  });

  test("treats a whitespace-only stored prompt as no prompt", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      initialPrompt: "   \n  ",
    });

    renderHiddenTerminal();

    await waitFor(() => {
      const agentTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "agent-native");
      expect(agentTab).toBeDefined();
      // A blank stored prompt must not dispatch an empty turn to the agent.
      expect(agentTab?.initialPrompt).toBeUndefined();
    });
  });

  test("finds a backend-owned agent tab nested in a split pane without relaunching", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    // The agent lives in the second leaf of a split, so the check must walk the
    // whole tree rather than only the root leaf.
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "split",
              id: "split-1",
              direction: "horizontal",
              sizes: [50, 50],
              children: [
                {
                  kind: "leaf",
                  id: "left",
                  tabs: [{ id: "plain-1", type: "plain" }],
                  activeTabId: "plain-1",
                },
                {
                  kind: "leaf",
                  id: "right",
                  tabs: [{ id: "agent-1", type: "agent-native" }],
                  activeTabId: "agent-1",
                },
              ],
            },
            activePaneId: "left",
            containerId: "container-hidden",
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: null,
    } as never);

    renderHiddenTerminal();

    await act(async () => {
      await Promise.resolve();
    });
    expect(setEnvironmentPendingAgentLaunchMock).not.toHaveBeenCalled();
    expect(useClaudeOptionsStore.getState().pendingNativeLaunches["env-hidden"]).toBeUndefined();
  });

  test("does not treat a build or review tab as the launched startup agent", async () => {
    setupDurableLaunchEnvironment({
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
    });
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-hidden",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "build-1", type: "claude-build" },
                { id: "review-1", type: "looped-review" },
                { id: "browser-1", type: "browser" },
              ],
              activeTabId: "build-1",
            },
            activePaneId: "default",
            containerId: "container-hidden",
          },
        ],
      ]),
      hydration: new Map([["env-hidden", "done"]]),
      activeEnvironmentId: null,
    } as never);

    renderHiddenTerminal();

    // None of those tabs is the agent the launch asked for, so the launch must
    // still be performed rather than considered already satisfied.
    await waitFor(() => {
      expect(
        usePaneLayoutStore
          .getState()
          .getAllTabs("env-hidden")
          .some((tab) => tab.type === "agent-native"),
      ).toBe(true);
    });
  });

  test("resumes a pending OpenCode native launch with container metadata", async () => {
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "setup", type: "plain", isSetupTab: true }],
          activeTabId: "setup",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
    }));
    useEnvironmentStore.setState((state) => ({
      ...state,
    }));
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-hidden": {
          containerId: "container-hidden",
          environmentId: "env-hidden",
          initialPrompt: "Resume OpenCode",
          targetPaneId: "default",
          agentType: "opencode",
          launchMode: "native",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const openCodeTab = usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .find((tab) => tab.type === "agent-native");
      expect(openCodeTab).toMatchObject({
        initialPrompt: "Resume OpenCode",
        nativeAgentData: {
          containerId: "container-hidden",
          environmentId: "env-hidden",
          isLocal: false,
        },
      });
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });
  });

  test("launches Claude tmux after container setup when Claude native backend is tmux", async () => {
    seedContainerSetupCommands();
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });
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

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "Continue in tmux",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toEqual({
        containerId: "container-hidden",
        environmentId: "env-hidden",
        initialPrompt: "Continue in tmux",
        targetPaneId: "default",
        agentType: "claude",
        launchMode: "native",
        claudeNativeBackend: "tmux",
      });
    });

    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "ready" });
    });

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const tmuxTab = envHidden.root.tabs.find((tab) => tab.type === "claude-tmux");
      expect(tmuxTab?.initialPrompt).toBe("Continue in tmux");
      expect(tmuxTab?.claudeTmuxData).toEqual({
        containerId: "container-hidden",
        environmentId: "env-hidden",
        isLocal: false,
      });
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
      ).toBe(false);
    });
  });

  test("clears a pending native launch when the container stops", async () => {
    useClaudeOptionsStore.getState().setPendingNativeLaunch("env-hidden", {
      containerId: "container-hidden",
      environmentId: "env-hidden",
      initialPrompt: "Do not launch after stop",
      targetPaneId: "default",
      agentType: "codex",
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });
  });

  test("keeps the newly selected environment's panes when switching environments", async () => {
    // App.tsx renders TerminalContainer without a `key`, so selecting a
    // different environment reuses this instance and changes environmentId and
    // containerId together. That is an environment switch, not a container
    // restart: the environment being switched *to* has been working in the
    // background and must not be reset out from under the user.
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments)
        .set("env-hidden", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "hidden-tab", type: "plain" as const }],
            activeTabId: "hidden-tab",
          },
          activePaneId: "default",
          containerId: "container-hidden",
        })
        .set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "visible-tab", type: "plain" as const },
              { id: "visible-agent-tab", type: "codex" as const },
            ],
            activeTabId: "visible-agent-tab",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }),
    }));
    // Setup is still running for env-visible, so the pending launch stays parked
    // rather than being consumed by the launch effect the moment it is selected.
    // Anything that clears it here is the reset, which is what is under test.
    useEnvironmentStore.getState().updateEnvironment("env-visible", { setupPhase: "running" });
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-visible": {
          containerId: "container-visible",
          environmentId: "env-visible",
          targetPaneId: "default",
          agentType: "codex",
          launchMode: "native",
        },
      },
    });

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toHaveLength(1);
    });

    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-visible"
          containerId="container-visible"
          isContainerRunning
          isActive
        />
      </TerminalProvider>,
    );

    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-visible")
        .map((tab) => tab.id),
    ).toEqual(["visible-tab", "visible-agent-tab"]);
    expect(usePaneLayoutStore.getState().environments.get("env-visible")?.containerId).toBe(
      "container-visible",
    );
    expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-visible")).toBeDefined();
  });

  test("resets panes when the container id changes within one environment", async () => {
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "hidden-tab", type: "plain" as const },
            { id: "hidden-agent-tab", type: "codex" as const },
          ],
          activeTabId: "hidden-tab",
        },
        activePaneId: "default",
        containerId: "container-hidden",
      }),
    }));

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toHaveLength(2);
    });

    // A genuine restart: same environment, new container. The old tabs point at
    // PTYs that no longer exist, so they still have to go.
    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-restarted"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    expect(
      usePaneLayoutStore
        .getState()
        .getAllTabs("env-hidden")
        .map((tab) => tab.id),
    ).not.toContain("hidden-agent-tab");
  });

  test("clears a pending native launch when the container id changes", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "running" });
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
              codex: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Old container prompt",
        },
      },
      pendingNativeLaunches: {},
    });
    ensureEnvironmentSetupMock.mockImplementationOnce(async (environmentId: string) => {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
      return {
        setupStarted: true,
        setupSessionId: `${environmentId}:setup`,
        environment,
      };
    });
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeDefined();
    });

    useClaudeOptionsStore.getState().clearOptions("env-hidden");

    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-restarted"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });
  });

  test("renders the backend-owned setup session in a plain terminal", async () => {
    seedContainerSetupCommands();
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toBeUndefined();
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
    });

    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
    ).toBe(true);
  });

  test("attaches a setup tab to a backend-owned setup session", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "running" });
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
    }));

    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(getEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
    });

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().hydration.get("env-hidden")).toBe("done");
    });
    expect(getPaneLayoutMock).not.toHaveBeenCalled();

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(envHidden.root.tabs[0]?.initialCommands).toBeUndefined();
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey("container-hidden", "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });
  });

  test("keeps an unbound setup tab intact while backend session binding retries", async () => {
    awaitEnvironmentSetupSessionMock
      .mockRejectedValueOnce(new Error("bind unavailable"))
      .mockImplementationOnce(() => new Promise(() => {}));
    seedUnboundSetupTab();
    useEnvironmentStore.setState((state) => ({
      ...state,
    }));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(
      () => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000 },
    );
    expect(
      useTerminalSessionStore
        .getState()
        .sessions.get(createSessionKey("container-hidden", "default", "env-hidden")),
    ).toBeUndefined();
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain", isSetupTab: true },
    ]);
  });

  test("retries a transient setup-session lookup failure without a reconnect", async () => {
    awaitEnvironmentSetupSessionMock
      .mockRejectedValueOnce(new Error("temporary bridge failure"))
      .mockResolvedValueOnce({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        startedAt: "2026-08-05T00:00:00.000Z",
        running: true,
        terminalRunning: true,
      });
    seedUnboundSetupTab();

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(
      () => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
        expect(
          useTerminalSessionStore
            .getState()
            .sessions.get(createSessionKey("container-hidden", "default", "env-hidden"))?.sessionId,
        ).toBe("env-hidden:setup");
      },
      { timeout: 2_000 },
    );
  });

  test("settles an unavailable setup session after the bounded retry budget", async () => {
    awaitEnvironmentSetupSessionMock
      .mockRejectedValueOnce(new Error("bridge unavailable 1"))
      .mockRejectedValueOnce(new Error("bridge unavailable 2"))
      .mockRejectedValueOnce(new Error("bridge unavailable 3"));
    seedUnboundSetupTab();

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(
      () => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(3);
        expect(
          usePaneLayoutStore
            .getState()
            .getAllTabs("env-hidden")
            .some((tab) => tab.isSetupTab),
        ).toBe(false);
      },
      { timeout: 2_000 },
    );
  });

  test("cancels a pending setup-session retry when unmounted", async () => {
    awaitEnvironmentSetupSessionMock.mockRejectedValueOnce(new Error("bridge unavailable"));
    seedUnboundSetupTab();

    // The retry callback's only effect is a `setState` that React discards on an
    // unmounted tree, so "the retry never ran" is true whether or not the
    // lifecycle cleanup cancelled it. Assert on the scheduled handle instead.
    const timers = installTimerProbe([SETUP_SESSION_BIND_RETRY_DELAY_MS]);
    try {
      const rendered = render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
        expect(timers.swallowed).toHaveLength(1);
      });

      rendered.unmount();

      expect(timers.cleared).toContain(timers.swallowed[0]!.handle);
    } finally {
      timers.restore();
    }

    expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
  });

  test("retries a transient setup-session lookup failure on stream reconnect", async () => {
    let reconnect: (() => void) | undefined;
    listenMock.mockImplementation(async (event: string, handler: () => void) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) reconnect = handler;
      return () => undefined;
    });
    awaitEnvironmentSetupSessionMock
      .mockRejectedValueOnce(new Error("temporary bridge failure"))
      .mockResolvedValueOnce({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        startedAt: "2026-08-05T00:00:00.000Z",
        running: true,
        terminalRunning: true,
      });
    seedUnboundSetupTab();

    // Own the ordinary backoff timer so it can never fire. Without this the
    // 250ms retry produces the same second lookup, and the test stays green
    // even with the whole reconnect listener deleted.
    const timers = installTimerProbe([SETUP_SESSION_BIND_RETRY_DELAY_MS]);
    try {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
        expect(timers.swallowed).toHaveLength(1);
        expect(reconnect).toBeDefined();
      });
      act(() => reconnect?.());
      await waitFor(
        () => {
          expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
          expect(
            useTerminalSessionStore
              .getState()
              .sessions.get(createSessionKey("container-hidden", "default", "env-hidden"))
              ?.sessionId,
          ).toBe("env-hidden:setup");
        },
        { timeout: 2_000 },
      );
    } finally {
      timers.restore();
    }
  });

  test("does not lose a reconnect while a failed setup-session lookup is in flight", async () => {
    let reconnect: (() => void) | undefined;
    let rejectLookup: ((error: Error) => void) | undefined;
    listenMock.mockImplementation(async (event: string, handler: () => void) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) reconnect = handler;
      return () => undefined;
    });
    awaitEnvironmentSetupSessionMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectLookup = reject;
          }),
      )
      .mockResolvedValueOnce({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        startedAt: "2026-08-05T00:00:00.000Z",
        running: true,
        terminalRunning: true,
      });
    seedUnboundSetupTab();

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
      expect(reconnect).toBeDefined();
      expect(rejectLookup).toBeDefined();
    });
    act(() => reconnect?.());

    // The reconnect landed while the lookup was still in flight, so the retry
    // the failure schedules must be immediate rather than the ordinary backoff:
    // the reconnect generation moved on under it. Owning only the backoff delay
    // makes "no 250ms timer was scheduled" the falsifiable assertion.
    const timers = installTimerProbe([SETUP_SESSION_BIND_RETRY_DELAY_MS]);
    try {
      await act(async () => {
        rejectLookup?.(new Error("bridge disconnected during lookup"));
      });

      expect(timers.swallowed).toEqual([]);
      expect(timers.delays).toContain(0);
    } finally {
      timers.restore();
    }

    await waitFor(
      () => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
        expect(
          useTerminalSessionStore
            .getState()
            .sessions.get(createSessionKey("container-hidden", "default", "env-hidden"))?.sessionId,
        ).toBe("env-hidden:setup");
      },
      { timeout: 2_000 },
    );
  });

  test("continues setup-session binding when the reconnect listener rejects", async () => {
    listenMock.mockRejectedValueOnce(new Error("listener unavailable"));
    awaitEnvironmentSetupSessionMock.mockResolvedValueOnce({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      startedAt: "2026-08-05T00:00:00.000Z",
      running: true,
      terminalRunning: true,
    });
    seedUnboundSetupTab();

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith(
        NATIVE_EVENT_STREAM_CONNECTED_EVENT,
        expect.any(Function),
      );
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey("container-hidden", "default", "env-hidden"))?.sessionId,
      ).toBe("env-hidden:setup");
    });
  });

  test("releases a reconnect listener that resolves after unmount", async () => {
    const release = mock(() => undefined);
    let resolveListener: ((release: () => void) => void) | undefined;
    listenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );

    const rendered = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith(
        NATIVE_EVENT_STREAM_CONNECTED_EVENT,
        expect.any(Function),
      );
      expect(resolveListener).toBeDefined();
    });
    rendered.unmount();
    await act(async () => {
      resolveListener?.(release);
    });

    expect(release).toHaveBeenCalledTimes(1);
  });

  test("clears pending setup-session retries and binds the new environment when the environment id changes", async () => {
    awaitEnvironmentSetupSessionMock
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce({
        environmentId: "env-visible",
        sessionId: "env-visible:setup",
        startedAt: "2026-08-05T00:00:00.000Z",
        running: true,
        terminalRunning: true,
      });
    seedUnboundSetupTab();
    seedUnboundSetupTabFor("env-visible", "container-visible");

    const timers = installTimerProbe([SETUP_SESSION_BIND_RETRY_DELAY_MS]);
    try {
      const { rerender } = render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await waitFor(() => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledWith("env-hidden");
        expect(timers.swallowed).toHaveLength(1);
      });

      // A changed environment id is a lifecycle boundary, not an unmount: the
      // component keeps its refs, so the retry armed for the old environment has
      // to be cancelled here or it fires against the new one.
      rerender(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      expect(timers.cleared).toContain(timers.swallowed[0]!.handle);

      await waitFor(() => {
        expect(
          useTerminalSessionStore
            .getState()
            .sessions.get(createSessionKey("container-visible", "default", "env-visible"))
            ?.sessionId,
        ).toBe("env-visible:setup");
      });
      expect(
        useTerminalSessionStore
          .getState()
          .sessions.get(createSessionKey("container-hidden", "default", "env-hidden")),
      ).toBeUndefined();
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
      expect(timers.swallowed).toHaveLength(1);
    } finally {
      timers.restore();
    }
  });

  test("does not bind a setup session that resolves after the environment id changed", async () => {
    let resolveLookup: ((session: EnvironmentSetupSession) => void) | undefined;
    awaitEnvironmentSetupSessionMock.mockImplementationOnce(
      () =>
        new Promise<EnvironmentSetupSession>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    seedUnboundSetupTab();

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
      expect(resolveLookup).toBeDefined();
    });

    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-visible"
          containerId="container-visible"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await act(async () => {
      resolveLookup?.({
        environmentId: "env-hidden",
        sessionId: "env-hidden:setup",
        startedAt: "2026-08-05T00:00:00.000Z",
        running: true,
        terminalRunning: true,
      });
    });

    // The lookup belongs to a lifecycle the component has already left; writing
    // its result would resurrect a session key for an environment this container
    // no longer renders.
    expect(
      useTerminalSessionStore
        .getState()
        .sessions.get(createSessionKey("container-hidden", "default", "env-hidden")),
    ).toBeUndefined();
    expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
  });

  test("does not schedule a setup-session retry that fails after the environment id changed", async () => {
    let rejectLookup: ((error: Error) => void) | undefined;
    awaitEnvironmentSetupSessionMock.mockImplementationOnce(
      () =>
        new Promise<EnvironmentSetupSession>((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    seedUnboundSetupTab();

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
      expect(rejectLookup).toBeDefined();
    });

    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-visible"
          containerId="container-visible"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    const timers = installTimerProbe([SETUP_SESSION_BIND_RETRY_DELAY_MS]);
    try {
      await act(async () => {
        rejectLookup?.(new Error("bridge lost during environment change"));
      });

      expect(timers.swallowed).toEqual([]);
    } finally {
      timers.restore();
    }

    expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
    // The stale failure must not settle the old environment's tab either: a
    // settled tab with no session is what stale-tab cleanup retires.
    expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toEqual([
      { id: "default", type: "plain", isSetupTab: true },
    ]);
  });

  test("a stale setup-session bind does not release the in-flight entry of a newer bind for the same tab", async () => {
    let reconnect: (() => void) | undefined;
    listenMock.mockImplementation(async (event: string, handler: () => void) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) reconnect = handler;
      return () => undefined;
    });
    let rejectStaleLookup: ((error: Error) => void) | undefined;
    awaitEnvironmentSetupSessionMock
      .mockImplementationOnce(
        () =>
          new Promise<EnvironmentSetupSession>((_resolve, reject) => {
            rejectStaleLookup = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise<EnvironmentSetupSession>(() => {}));
    // Setup is running for both environments, so pane-layout hydration leaves
    // the seeded setup tabs alone and the second bind stays genuinely unbound.
    useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "running" });
    useEnvironmentStore.getState().updateEnvironment("env-visible", { setupPhase: "running" });
    seedUnboundSetupTab();
    seedUnboundSetupTabFor("env-visible", "container-visible");

    const { rerender } = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(1);
      expect(rejectStaleLookup).toBeDefined();
    });

    // Both environments use the tab id "default", so the stale bind and the new
    // one key the same in-flight entry.
    rerender(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-visible"
          containerId="container-visible"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
      expect(reconnect).toBeDefined();
    });

    // The stale bind settles last. Its `finally` only owns the in-flight entry
    // while the request token still matches; deleting the newer bind's entry
    // would let the next rebind start a duplicate concurrent lookup.
    await act(async () => {
      rejectStaleLookup?.(new Error("stale bridge failure"));
    });

    act(() => reconnect?.());
    await act(async () => {});

    expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(2);
  });

  test("grants a fresh setup-session retry budget when a reconnect follows an exhausted one", async () => {
    // Setup is still running, so stale-tab cleanup leaves the unbound setup tab
    // in place after the first budget is exhausted and a reconnect can reach it.
    useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "running" });
    let reconnect: (() => void) | undefined;
    listenMock.mockImplementation(async (event: string, handler: () => void) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) reconnect = handler;
      return () => undefined;
    });
    for (let attempt = 0; attempt < MAX_SETUP_SESSION_BIND_ATTEMPTS * 2; attempt += 1) {
      awaitEnvironmentSetupSessionMock.mockRejectedValueOnce(
        new Error(`bridge unavailable ${attempt + 1}`),
      );
    }
    seedUnboundSetupTab();

    const timers = installTimerProbe([
      SETUP_SESSION_BIND_RETRY_DELAY_MS,
      SETUP_SESSION_BIND_RETRY_DELAY_MS * 2,
    ]);
    const fireNextBackoff = async (index: number) => {
      await waitFor(() => expect(timers.swallowed).toHaveLength(index + 1));
      await act(async () => {
        timers.swallowed[index]!.fire();
      });
    };

    try {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-hidden"
            containerId="container-hidden"
            isContainerRunning
            isActive={false}
          />
        </TerminalProvider>,
      );

      await fireNextBackoff(0);
      await fireNextBackoff(1);
      await waitFor(() => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(
          MAX_SETUP_SESSION_BIND_ATTEMPTS,
        );
      });
      expect(timers.swallowed.map((timer) => timer.delay)).toEqual([
        SETUP_SESSION_BIND_RETRY_DELAY_MS,
        SETUP_SESSION_BIND_RETRY_DELAY_MS * 2,
      ]);

      // Exhaustion drops the attempt counter for the tab, so the reconnect that
      // follows starts a whole new budget rather than staying exhausted. The
      // first delay proves it: 250ms is attempt 1 of a fresh budget, not a
      // continuation of the old one.
      act(() => reconnect?.());
      await fireNextBackoff(2);
      await fireNextBackoff(3);

      await waitFor(() => {
        expect(awaitEnvironmentSetupSessionMock).toHaveBeenCalledTimes(
          MAX_SETUP_SESSION_BIND_ATTEMPTS * 2,
        );
      });
      expect(timers.swallowed.map((timer) => timer.delay)).toEqual([
        SETUP_SESSION_BIND_RETRY_DELAY_MS,
        SETUP_SESSION_BIND_RETRY_DELAY_MS * 2,
        SETUP_SESSION_BIND_RETRY_DELAY_MS,
        SETUP_SESSION_BIND_RETRY_DELAY_MS * 2,
      ]);
    } finally {
      timers.restore();
    }
  });

  test("rehydrates a running backend setup session for a local environment", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: false,
              setupPhase: "running",
            }
          : env,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(envHidden.root.tabs[0]?.initialCommands).toBeUndefined();
    });

    expect(
      useTerminalSessionStore
        .getState()
        .sessions.get(createSessionKey(null, "default", "env-hidden"))?.sessionId,
    ).toBe("env-hidden:setup");
    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
    ).toBe(true);
  });

  test("auto-resolves a ready local environment whose setup completed in a prior session", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: true,
            }
          : environment,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase !== "pending",
      ).toBe(true);
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden")).toMatchObject([
        { type: "plain" },
      ]);
    });
    expect(ensureEnvironmentSetupMock).not.toHaveBeenCalled();
    expect(getSetupCommandsMock).not.toHaveBeenCalled();
  });

  test("ignores stale legacy setup flags when the authoritative phase is ready", async () => {
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
              codex: { mode: "native" },
            },
          },
        },
        repositories: {},
      },
    }));
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: false,
            }
          : env,
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Review this build",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("agent-native");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBeUndefined();
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Review this build");
      expect(envHidden.root.tabs[0]?.initialAgentModel).toBe("gpt-5.6-sol");
      expect(envHidden.root.tabs[0]?.initialReasoningEffort).toBe("high");
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "running",
      ).toBe(false);
      expect(
        useEnvironmentStore.getState().getEnvironmentById("env-hidden")?.setupPhase === "ready",
      ).toBe(true);
    });
  });

  test("removes a stale blank setup placeholder after setup has completed", async () => {
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      environments.set("env-hidden", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "codex",
              type: "agent-native",
              nativeAgentData: { environmentId: "env-hidden", isLocal: true },
            },
          ],
          activeTabId: "default",
        },
        activePaneId: "default",
        containerId: null,
      });
      return { ...state, environments };
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: true,
            }
          : env,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("agent-native");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBeUndefined();
    });
    expect(ensureEnvironmentSetupMock).not.toHaveBeenCalled();
  });

  test("does not persist completion when backend setup re-run fails", async () => {
    ensureEnvironmentSetupMock.mockRejectedValue(new Error("unavailable"));

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
              setupScriptsComplete: false,
            }
          : env,
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive={false} />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBeUndefined();
    });

    expect(markSetupScriptsCompleteMock).not.toHaveBeenCalled();
  });

  test("clears applied launch options without an initial prompt via the fallback timer", async () => {
    // Local terminal-mode agent launch with NO initialPrompt and no setup
    // commands: the agent tab is created directly, so no pending native launch
    // exists and the immediate native-launch cleanup never runs. Before the
    // cleanup guard was broadened to fire for any applied options (not only
    // those with an initialPrompt), these options were never cleared.
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env,
      ),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "",
          model: "sonnet",
          reasoningEffort: "high",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isActive />
      </TerminalProvider>,
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }
      expect(envHidden.root.tabs[0]?.type).toBe("claude");
      expect(envHidden.root.tabs[0]?.initialAgentModel).toBe("sonnet");
      expect(envHidden.root.tabs[0]?.initialReasoningEffort).toBe("high");
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeUndefined();
    });

    // The fallback timer (3s) clears the now-applied options.
    await waitFor(
      () => {
        expect(useClaudeOptionsStore.getState().getOptions("env-hidden")).toBeUndefined();
      },
      { timeout: 6000 },
    );
  }, 12000);

  test("keeps launch options while a pending native launch is still outstanding", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", { setupPhase: "running" });
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive
        />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toMatchObject({
        agentType: "codex",
        launchMode: "native",
      });
    });

    // Wait past the fallback timer window; the launch is still outstanding.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
    });

    expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeDefined();
    expect(useClaudeOptionsStore.getState().getOptions("env-hidden")).toMatchObject({
      launchAgent: true,
      agentType: "codex",
    });
  }, 12000);

  test("selects and closes tabs only in the active pane and ignores invalid indices", async () => {
    function TabCommandHarness() {
      const { selectTab, closeActiveTab } = useTerminalContext();
      const didRunRef = useRef(false);
      useEffect(() => {
        if (!selectTab || !closeActiveTab || didRunRef.current) return;
        didRunRef.current = true;
        selectTab(-1);
        selectTab(99);
        selectTab(0);
        closeActiveTab();
      }, [closeActiveTab, selectTab]);
      return null;
    }

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
              tabs: [{ id: "left-only", type: "plain" }],
              activeTabId: "left-only",
            },
            {
              kind: "leaf",
              id: "right",
              tabs: [
                { id: "right-first", type: "plain" },
                { id: "right-second", type: "plain" },
              ],
              activeTabId: "right-second",
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
        <TabCommandHarness />
      </TerminalProvider>,
    );

    await waitFor(() => {
      expect(
        usePaneLayoutStore
          .getState()
          .getPane("left", "env-visible")
          ?.tabs.map((tab) => tab.id),
      ).toEqual(["left-only"]);
      expect(
        usePaneLayoutStore
          .getState()
          .getPane("right", "env-visible")
          ?.tabs.map((tab) => tab.id),
      ).toEqual(["right-second"]);
      expect(usePaneLayoutStore.getState().getPane("right", "env-visible")?.activeTabId).toBe(
        "right-second",
      );
    });
  });

  /**
   * A Multi Review workflow outlives the tab that launched it, so the launcher
   * reattaches to an already-active one rather than failing. Asking for a
   * workflow that is still on screen must surface that tab instead of stacking
   * a second copy of the same workflow.
   */
  test("reveals an open Multi Review tab instead of duplicating its workflow", async () => {
    const results: boolean[] = [];
    function MultiReviewReattachHarness() {
      const { createTab } = useTerminalContext();
      const didRunRef = useRef(false);
      useEffect(() => {
        if (!createTab || didRunRef.current) return;
        didRunRef.current = true;
        results.push(createTab("multi-review", { multiReviewId: "workflow-1" }));
        // The reviewer transcript is a different view of the same workflow, so
        // it stays a tab of its own rather than folding into the overview.
        results.push(
          createTab("multi-review", {
            multiReviewId: "workflow-1",
            multiReviewReviewerId: "reviewer-1",
          }),
        );
      }, [createTab]);
      return null;
    }

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
                  id: "open-multi-review",
                  type: "multi-review",
                  multiReviewTabData: { environmentId: "env-visible", workflowId: "workflow-1" },
                },
              ],
              activeTabId: "open-multi-review",
            },
            {
              kind: "leaf",
              id: "right",
              tabs: [{ id: "right-only", type: "plain" }],
              activeTabId: "right-only",
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
        <MultiReviewReattachHarness />
      </TerminalProvider>,
    );

    await waitFor(() => expect(results).toEqual([true, true]));
    const layout = usePaneLayoutStore.getState();
    // The overview request reused the open tab and focused its pane; only the
    // reviewer transcript was actually added.
    expect(layout.getPane("left", "env-visible")?.tabs.map((tab) => tab.id)).toEqual([
      "open-multi-review",
    ]);
    expect(layout.getPane("left", "env-visible")?.activeTabId).toBe("open-multi-review");
    expect(layout.environments.get("env-visible")?.activePaneId).toBe("left");
    expect(
      layout
        .getPane("right", "env-visible")
        ?.tabs.filter((tab) => tab.type === "multi-review")
        .map((tab) => tab.multiReviewTabData?.reviewerId),
    ).toEqual(["reviewer-1"]);
  });

  /**
   * Reuse is deliberately resolved *before* the tab limit, because surfacing a
   * tab that already exists adds nothing to the count. A full workspace is
   * exactly when reattaching matters most, so pin both halves: the open
   * workflow is still reachable at MAX_TABS, and a genuinely new one is still
   * refused there.
   */
  test("reattaches to an open Multi Review at the tab limit but still refuses a new one", async () => {
    const results: boolean[] = [];
    function TabLimitHarness() {
      const { createTab } = useTerminalContext();
      const didRunRef = useRef(false);
      useEffect(() => {
        if (!createTab || didRunRef.current) return;
        didRunRef.current = true;
        results.push(createTab("multi-review", { multiReviewId: "workflow-1" }));
        results.push(createTab("multi-review", { multiReviewId: "workflow-2" }));
      }, [createTab]);
      return null;
    }

    const filler = Array.from({ length: MAX_TABS - 1 }, (_unused, index) => ({
      id: `filler-${index}`,
      type: "plain" as const,
    }));
    usePaneLayoutStore.setState((state) => ({
      environments: new Map(state.environments).set("env-full", {
        root: {
          kind: "leaf",
          id: "only",
          tabs: [
            {
              id: "open-multi-review",
              type: "multi-review",
              multiReviewTabData: { environmentId: "env-full", workflowId: "workflow-1" },
            },
            ...filler,
          ],
          activeTabId: "filler-0",
        },
        activePaneId: "only",
        containerId: "container-full",
      }),
    }));
    mockToastError.mockClear();

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-full"
          containerId="container-full"
          isContainerRunning
          isActive
        />
        <TabLimitHarness />
      </TerminalProvider>,
    );

    await waitFor(() => expect(results).toEqual([true, false]));
    const layout = usePaneLayoutStore.getState();
    const pane = layout.getPane("only", "env-full");
    // Nothing was added: the reuse focused the existing tab and the second
    // request was rejected by the limit.
    expect(pane?.tabs).toHaveLength(MAX_TABS);
    expect(
      pane?.tabs
        .filter((tab) => tab.type === "multi-review")
        .map((tab) => tab.multiReviewTabData?.workflowId),
    ).toEqual(["workflow-1"]);
    expect(pane?.activeTabId).toBe("open-multi-review");
    // Reuse must stay silent; only the refused request warns.
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenLastCalledWith(
      "Tab limit reached",
      expect.objectContaining({
        description: `You can have up to ${MAX_TABS} tabs open. Close a tab and try again.`,
      }),
    );
  });
});
