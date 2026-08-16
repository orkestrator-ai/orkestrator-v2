import { afterAll,beforeEach,describe,expect,mock,test } from "bun:test";


import { type ReactNode } from "react";


import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";


import { TerminalProvider } from "@/contexts";


import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";


import { useConfigStore } from "@/stores/configStore";


import { useEnvironmentStore } from "@/stores/environmentStore";


import { usePaneLayoutStore } from "@/stores/paneLayoutStore";


import { useNativeComposeStore } from "@/stores/nativeComposeStore";


import { useBuildPipelineStore } from "@/stores/buildPipelineStore";






import {
useLoopedReviewStore,
type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";




import { useTerminalSessionStore } from "@/stores/terminalSessionStore";




import {
type PersistedPaneLayout
} from "@/types/paneLayout";


import type { EnsureEnvironmentSetupResult,EnvironmentSetupSession } from "@/types";


import type { CollisionDetection } from "@dnd-kit/core";


import * as realBackend from "@/lib/backend";


import * as realSetupCommands from "@/lib/setup-commands";




import * as realDndKitCore from "@dnd-kit/core";






import * as realNativeEvents from "@/lib/native/events";


import {
listen
} from "@/lib/native/events";



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


const ensureEnvironmentSetupMock = mock(async (environmentId: string): Promise<EnsureEnvironmentSetupResult> => {
  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
  return {
    setupStarted: false,
    environment: {
      ...environment,
      setupScriptsComplete: true,
    },
  };
});


const runEnvironmentSetupMock = mock(async (environmentId: string) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  setupScriptsComplete: true,
}));


const getEnvironmentSetupSessionMock = mock(async (_environmentId: string): Promise<EnvironmentSetupSession | null> => null);


const awaitEnvironmentSetupSessionMock = mock(
  async (environmentId: string): Promise<EnvironmentSetupSession | null> =>
    getEnvironmentSetupSessionMock(environmentId),
);


const setEnvironmentPendingAgentLaunchMock = mock(async (environmentId: string, pending: boolean) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  pendingAgentLaunch: pending,
  ...(pending
    ? {}
    : {
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
      }),
}));


const acknowledgeStartupAgentSessionMock = mock(async (environmentId: string) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  startupAgentSession: undefined,
}));


const setEnvironmentInitialPromptMock = mock(async (environmentId: string, initialPrompt: string) => ({
  ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
  initialPrompt,
}));


const savePaneLayoutMock = mock(async (
  environmentId: string,
  layout: Parameters<typeof realBackend.savePaneLayout>[1],
  _expectedRevision: number,
): Promise<PersistedPaneLayout> => ({
  ...layout,
  environmentId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
}));


const getPaneLayoutMock = mock(async (_environmentId: string): Promise<PersistedPaneLayout | null> => null);


const deletePaneLayoutMock = mock(async (
  _environmentId: string,
  _expectedRevision?: number,
) => {});


const listLoopedReviewWorkflowsMock = mock(async (_environmentId: string) => [] as Array<{
  version: number;
  id: string;
  environmentId: string;
  snapshot: LoopedReviewWorkflow;
  updatedAt: string;
  revision: number;
}>);


const writeContainerFileMock = mock(async (
  _containerId: string,
  filePath: string,
  _base64Data: string,
) => `/workspace/${filePath}`);


const writeLocalFileMock = mock(async (
  worktreePath: string,
  filePath: string,
  _base64Data: string,
) => `${worktreePath}/${filePath}`);


const writeInitialPromptAttachmentsMock = mock(async (
  environmentId: string,
  attachments: Parameters<typeof realBackend.writeInitialPromptAttachments>[1],
) => {
  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const usedNames = new Set<string>();
  return Promise.all(attachments.map(async (attachment) => {
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
    const savedPath = environment.environmentType === "local"
      ? await writeLocalFileMock(environment.worktreePath!, relativePath, attachment.base64Data)
      : await writeContainerFileMock(environment.containerId!, relativePath, attachment.base64Data);
    return { name, path: savedPath };
  }));
});



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
    isLocalEnvironment &&
    isLocalEnvironmentReady &&
    !setupCommandsResolved &&
    !hasPendingCommands,
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
        ["env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "visible-tab", type: "plain" }],
            activeTabId: "visible-tab",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }],
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
    setEnvironmentPendingAgentLaunchMock.mockImplementation(async (environmentId: string, pending: boolean) => ({
      ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
      pendingAgentLaunch: pending,
      ...(pending
        ? {}
        : {
            initialAgentModel: undefined,
            initialReasoningEffort: undefined,
          }),
    }));
    acknowledgeStartupAgentSessionMock.mockReset();
    acknowledgeStartupAgentSessionMock.mockImplementation(async (environmentId: string) => ({
      ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
      startupAgentSession: undefined,
    }));
    setEnvironmentInitialPromptMock.mockReset();
    setEnvironmentInitialPromptMock.mockImplementation(async (environmentId: string, initialPrompt: string) => ({
      ...useEnvironmentStore.getState().getEnvironmentById(environmentId)!,
      initialPrompt,
    }));
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
    writeContainerFileMock.mockImplementation(async (_containerId: string, filePath: string) => `/workspace/${filePath}`);
    writeLocalFileMock.mockImplementation(async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`);

    useConfigStore.setState((state) => ({
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

    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
    });
  });



  test("shows the stopped overlay and clears panes for a stopped failed setup", async () => {
    useEnvironmentStore.getState().updateEnvironment("env-hidden", {
      status: "stopped",
      setupScriptsComplete: false,
      setupPhase: "failed",
    });
    usePaneLayoutStore.setState((state) => {
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

    expect(screen.getByText("Container is not running")).toBeTruthy();
    expect(screen.queryByText("Environment setup failed.") === null).toBe(true);
    await waitFor(() => {
      const panes = usePaneLayoutStore.getState().environments.get("env-hidden");
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

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning={false}
          isActive
          onStartContainer={onStartContainer}
          onCreateScript={onCreateScript}
        />
      </TerminalProvider>
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
    const noEnvironment = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="missing-environment"
          containerId={null}
          isContainerRunning={false}
        />
      </TerminalProvider>,
    );
    expect(screen.getByText("Select an environment from the sidebar to get started."))
      .toBeTruthy();
    noEnvironment.unmount();

    render(
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
    expect(screen.getByTestId("initialization-logs").textContent)
      .toBe("container-hidden");
    expect(screen.queryByRole("button", { name: /start container/i }) === null).toBe(true);
  });



  test("renders local creation and stopped overlays with environment wording", () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-hidden"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: undefined,
            }
          : environment
      ),
    }));
    const creating = render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isContainerCreating
        />
      </TerminalProvider>,
    );
    expect(screen.getByText("Creating worktree...")).toBeTruthy();
    creating.unmount();

    render(
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
      (screen.getByRole("button", { name: /create script/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

});
