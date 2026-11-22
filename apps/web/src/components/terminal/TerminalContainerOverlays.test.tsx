import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { type ReactNode } from "react";

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";

import { TerminalProvider } from "@/contexts";

import { claudeOptionsStore } from "@/stores/claudeOptionsStore";

import { configStore } from "@/stores/configStore";

import { environmentStore } from "@/stores/environmentStore";

import { paneLayoutStore } from "@/stores/paneLayoutStore";

import { nativeComposeStore } from "@/stores/nativeComposeStore";

import { buildPipelineStore } from "@/stores/buildPipelineStore";

import { terminalSessionStore } from "@/stores/terminalSessionStore";

import { type PersistedPaneLayout } from "@/types/paneLayout";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import type { EnsureEnvironmentSetupResult, EnvironmentSetupSession } from "@/types";

import type { CollisionDetection } from "@dnd-kit/core";

import * as realBackend from "@/lib/backend";

import * as realSetupCommands from "@/lib/setup-commands";

import * as realDndKitCore from "@dnd-kit/core";

import * as realNativeEvents from "@/lib/native/events";

import { listen } from "@/lib/native/events";
import { appCommandStore } from "@/test/app-command-store";

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
    const environment = appCommandStore(environmentStore)
      .getState()
      .getEnvironmentById(environmentId)!;
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
  ...appCommandStore(environmentStore).getState().getEnvironmentById(environmentId)!,
  setupScriptsComplete: true,
}));

const getEnvironmentSetupSessionMock = mock(
  async (_environmentId: string): Promise<EnvironmentSetupSession | null> => null,
);

const awaitEnvironmentSetupSessionMock = mock(
  async (environmentId: string): Promise<EnvironmentSetupSession | null> =>
    getEnvironmentSetupSessionMock(environmentId),
);

const acknowledgeStartupAgentSessionMock = mock(async (environmentId: string) => ({
  ...appCommandStore(environmentStore).getState().getEnvironmentById(environmentId)!,
  startupAgentSession: undefined,
}));

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
    const environment = appCommandStore(environmentStore)
      .getState()
      .getEnvironmentById(environmentId);
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
  acknowledgeStartupAgentSession: acknowledgeStartupAgentSessionMock,
  savePaneLayout: savePaneLayoutMock,
  getPaneLayout: getPaneLayoutMock,
  deletePaneLayout: deletePaneLayoutMock,
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

    appCommandStore(paneLayoutStore).setState({
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

    appCommandStore(environmentStore).setState({
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
    appCommandStore(terminalSessionStore).setState({
      sessions: new Map(),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });
    appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });

    markSetupScriptsCompleteMock.mockClear();
    getSetupCommandsMock.mockReset();
    getSetupCommandsMock.mockResolvedValue(null);
    ensureEnvironmentSetupMock.mockReset();
    ensureEnvironmentSetupMock.mockImplementation(async (environmentId: string) => {
      const environment = appCommandStore(environmentStore)
        .getState()
        .getEnvironmentById(environmentId)!;
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
      ...appCommandStore(environmentStore).getState().getEnvironmentById(environmentId)!,
      setupScriptsComplete: true,
    }));
    getEnvironmentSetupSessionMock.mockReset();
    getEnvironmentSetupSessionMock.mockResolvedValue(null);
    awaitEnvironmentSetupSessionMock.mockClear();
    acknowledgeStartupAgentSessionMock.mockReset();
    acknowledgeStartupAgentSessionMock.mockImplementation(async (environmentId: string) => ({
      ...appCommandStore(environmentStore).getState().getEnvironmentById(environmentId)!,
      startupAgentSession: undefined,
    }));
    savePaneLayoutMock.mockClear();
    getPaneLayoutMock.mockReset();
    getPaneLayoutMock.mockResolvedValue(null);
    deletePaneLayoutMock.mockReset();
    deletePaneLayoutMock.mockResolvedValue(undefined);
    localStorage.clear();
    writeContainerFileMock.mockReset();
    writeLocalFileMock.mockReset();
    writeInitialPromptAttachmentsMock.mockClear();
    writeContainerFileMock.mockImplementation(
      async (_containerId: string, filePath: string) => `/workspace/${filePath}`,
    );
    writeLocalFileMock.mockImplementation(
      async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`,
    );

    appCommandStore(configStore).setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeBackend: "sdk",
          codexMode: "native",
        },
        repositories: {},
      },
    }));

    appCommandStore(claudeOptionsStore).setState({
      options: {},
    });
  });

  test("shows the stopped overlay and clears panes for a stopped failed setup", async () => {
    appCommandStore(environmentStore).getState().updateEnvironment("env-hidden", {
      status: "stopped",
      setupScriptsComplete: false,
      setupPhase: "failed",
    });
    appCommandStore(paneLayoutStore).setState((state) => {
      const environments = new Map(state.environments);
      environments.set("env-hidden", {
        root: {
          kind: "leaf",
          id: "stale-pane",
          tabs: [{ id: "stale-tab", type: "plain" }],
          activeTabId: "stale-tab",
        },
        activePaneId: "stale-pane",
        containerId: "container-hidden",
      });
      return { environments };
    });

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isActive={false}
        />
      </TerminalProvider>,
    );

    expect(screen.getByText("Container is not running")).toBeTruthy();
    expect(screen.queryByText("Environment setup failed.") === null).toBe(true);
    await waitFor(() => {
      const panes = appCommandStore(paneLayoutStore).getState().environments.get("env-hidden");
      expect(panes?.containerId).toBeNull();
      expect(panes?.root).toMatchObject({
        kind: "leaf",
        tabs: [],
      });
    });
  });

  test("start overlay ignores modifier clicks, starts normally, and creates scripts from the context menu", async () => {
    const onStartContainer = mock(() => {});
    const onCreateScript = mock((_prompt: string) => {});

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isActive
          onStartContainer={onStartContainer}
          onCreateScript={onCreateScript}
        />
      </TerminalProvider>,
    );

    const startButton = screen.getByRole("button", { name: /start container/i });
    fireEvent.click(startButton, { ctrlKey: true });
    expect(onStartContainer).not.toHaveBeenCalled();

    fireEvent.click(startButton);
    expect(onStartContainer).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /create script/i }));
    expect(onCreateScript).toHaveBeenCalledTimes(1);
    expect(onCreateScript.mock.calls[0]?.[0]).toContain("setup");
  });

  test("renders the no-environment and container-creation overlay variants", () => {
    const noEnvironment = renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="missing-environment"
          containerId={null}
          isContainerRunning={false}
        />
      </TerminalProvider>,
    );
    expect(screen.getByText("Select an environment from the sidebar to get started.")).toBeTruthy();
    noEnvironment.unmount();

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isContainerCreating
          onStartContainer={mock(() => {})}
        />
      </TerminalProvider>,
    );
    expect(screen.getByTestId("initialization-logs").textContent).toBe("container-hidden");
    expect(screen.queryByRole("button", { name: /start container/i }) === null).toBe(true);
  });

  test("renders local creation and stopped overlays with environment wording", () => {
    appCommandStore(environmentStore).setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: undefined,
            }
          : environment,
      ),
    }));
    const creating = renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isContainerCreating />
      </TerminalProvider>,
    );
    expect(screen.getByText("Creating worktree...")).toBeTruthy();
    creating.unmount();

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isContainerCreating={false}
          onStartContainer={mock(() => {})}
        />
      </TerminalProvider>,
    );
    expect(screen.getByText("Environment not started")).toBeTruthy();
    expect(screen.getByRole("button", { name: /start environment/i })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /create script/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  test("keeps a launch's opening prompt on screen while the worktree is created", async () => {
    appCommandStore(environmentStore).setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: undefined,
              pendingAgentLaunch: true,
              initialPrompt: "Add a dark mode toggle",
              initialAgentPlatform: "codex",
            }
          : environment,
      ),
    }));
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer environmentId="env-hidden" containerId={null} isContainerCreating />
      </TerminalProvider>,
    );

    expect(await screen.findByTestId("launch-prompt-pending")).toBeTruthy();
    expect(screen.getByText("Add a dark mode toggle")).toBeTruthy();
    expect(screen.getByText("Creating worktree…")).toBeTruthy();
    expect(screen.getByText("Message Codex")).toBeTruthy();
    expect(screen.queryByText("Creating worktree...") === null).toBe(true);
  });

  test("shows a Docker prompt before allocation and scopes log selection to the current launch", async () => {
    appCommandStore(environmentStore).getState().updateEnvironment("env-hidden", {
      pendingAgentLaunch: true,
      initialPrompt: "Add a dark mode toggle",
      initialAgentPlatform: "claude",
    });
    const creating = (environmentId: string, containerId: string | null) => (
      <TerminalProvider>
        <TerminalContainer
          environmentId={environmentId}
          containerId={containerId}
          isContainerRunning={false}
          isContainerCreating
        />
      </TerminalProvider>
    );
    const view = renderInAppCommandScope(creating("env-hidden", null));

    expect(await screen.findByText("Starting container…")).toBeTruthy();
    expect(screen.getByText("Add a dark mode toggle")).toBeTruthy();
    expect(screen.queryByText(/Select an environment/) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "View container logs" }) === null).toBe(true);
    view.rerender(creating("env-hidden", "container-hidden"));
    expect(screen.getByText("Add a dark mode toggle")).toBeTruthy();
    expect(screen.queryByTestId("initialization-logs") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "View container logs" }));
    expect(screen.getByTestId("initialization-logs").textContent).toBe("container-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Back to opening prompt" }));
    expect(await screen.findByText("Add a dark mode toggle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View container logs" }));

    appCommandStore(environmentStore).getState().updateEnvironment("env-visible", {
      pendingAgentLaunch: true,
      initialPrompt: "Check the deployment",
    });
    view.rerender(creating("env-visible", "container-visible"));
    expect(await screen.findByText("Check the deployment")).toBeTruthy();
    expect(screen.queryByTestId("initialization-logs") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "View container logs" }));

    appCommandStore(environmentStore).getState().updateEnvironment("env-hidden", {
      environmentType: "local",
      containerId: null,
      worktreePath: undefined,
    });
    view.rerender(creating("env-hidden", null));
    expect(await screen.findByText("Creating worktree…")).toBeTruthy();
    expect(screen.getByText("Add a dark mode toggle")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View container logs" }) === null).toBe(true);
  });

  test("shows the preparing prompt after allocation while the running environment has no tabs", async () => {
    appCommandStore(environmentStore).getState().updateEnvironment("env-hidden", {
      status: "running",
      pendingAgentLaunch: true,
      initialPrompt: "Check the deployment",
      initialAgentPlatform: "codex",
      setupPhase: "pending",
    });
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
        />
      </TerminalProvider>,
    );
    expect(await screen.findByText("Preparing environment…")).toBeTruthy();
    expect(screen.getByText("Check the deployment")).toBeTruthy();
  });

  test("preserves a provisional startup layout until the backend publishes the allocated container", async () => {
    appCommandStore(environmentStore).getState().updateEnvironment("env-hidden", {
      status: "running",
      containerId: "container-hidden",
      pendingAgentLaunch: true,
      initialPrompt: "Check the deployment",
      setupPhase: "running",
    });
    getPaneLayoutMock.mockResolvedValue({
      environmentId: "env-hidden",
      version: PANE_LAYOUT_VERSION,
      revision: 1,
      updatedAt: "2026-11-01T00:00:00.000Z",
      activePaneId: "pane",
      containerId: null,
      root: {
        kind: "leaf",
        id: "pane",
        activeTabId: "startup-agent",
        tabs: [{ id: "startup-agent", type: "agent-native" }],
      },
    });
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
        />
      </TerminalProvider>,
    );
    await waitFor(() => {
      expect(appCommandStore(paneLayoutStore).getState().hydration.get("env-hidden")).toBe("done");
    });
    expect(deletePaneLayoutMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Check the deployment")).toBeTruthy();
  });
});
