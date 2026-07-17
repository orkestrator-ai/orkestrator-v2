import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalProvider, useTerminalContext, type CreatableTabType, type CreateTabOptions, type CreateFileTabOptions } from "@/contexts";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createSessionKey, useTerminalSessionStore } from "@/stores/terminalSessionStore";
import type { PaneLeaf, PersistedPaneLayout } from "@/types/paneLayout";
import type { EnsureEnvironmentSetupResult, EnvironmentSetupSession } from "@/types";
import * as realBackend from "@/lib/backend";
import * as realSetupCommands from "@/lib/setup-commands";

const realBackendSnapshot = { ...realBackend };
const realSetupCommandsSnapshot = { ...realSetupCommands };

const markSetupScriptsCompleteMock = mock(() => {});
const getSetupCommandsMock = mock(async (): Promise<string[] | null> => null);
const ensureEnvironmentSetupMock = mock(async (environmentId: string): Promise<EnsureEnvironmentSetupResult> => {
  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
  return {
    setupCommands: [],
    setupManagedByBackend: true,
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
const getPaneLayoutMock = mock(async (_environmentId: string): Promise<PersistedPaneLayout | null> => null);
const writeContainerFileMock = mock(async (_containerId: string, filePath: string) => `/workspace/${filePath}`);
const writeLocalFileMock = mock(async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`);
const TEST_CONTAINER_SETUP_COMMAND = "/backend-provided/workspace-setup.sh";

const seedContainerSetupCommands = (environmentId = "env-hidden") => {
  useEnvironmentStore.getState().setPendingSetupCommands(environmentId, [
    TEST_CONTAINER_SETUP_COMMAND,
  ]);
  useEnvironmentStore.getState().setSetupCommandsResolved(environmentId, true);
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
  getPaneLayout: getPaneLayoutMock,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
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
  InitializationLogs: () => null,
}));

const { TerminalContainer, getTerminalTabDragEndAction } = await import("./TerminalContainer");

describe("TerminalContainer", () => {
  afterAll(() => {
    mock.module("@/lib/setup-commands", () => realSetupCommandsSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  beforeEach(() => {
    cleanup();

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
        },
      ],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      sessionActivated: new Set(),
    });
    useTerminalSessionStore.setState({
      sessions: new Map(),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });

    markSetupScriptsCompleteMock.mockClear();
    getSetupCommandsMock.mockReset();
    getSetupCommandsMock.mockResolvedValue(null);
    ensureEnvironmentSetupMock.mockReset();
    ensureEnvironmentSetupMock.mockImplementation(async (environmentId: string) => {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
      return {
        setupCommands: [],
        setupManagedByBackend: true,
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
    getPaneLayoutMock.mockReset();
    getPaneLayoutMock.mockResolvedValue(null);
    writeContainerFileMock.mockReset();
    writeLocalFileMock.mockReset();
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

  test("initializes a hidden environment without changing the active pane-layout environment", async () => {
    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>
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
      version: 1,
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
      version: 1,
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
      version: 1,
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
      expect(usePaneLayoutStore.getState().getAllTabs("env-hidden").map((tab) => tab.id)).toEqual(["default"]);
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
    getPaneLayoutMock.mockImplementation(() => new Promise((resolve) => {
      resolveLayout = resolve;
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
    seedContainerSetupCommands();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "terminal",
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
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual([TEST_CONTAINER_SETUP_COMMAND]);
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toEqual({
        containerId: "container-hidden",
        environmentId: "env-hidden",
        initialPrompt: "Review this diff",
        targetPaneId: "default",
        agentType: "codex",
        launchMode: "terminal",
      });
    });

    await act(async () => {
      useEnvironmentStore.getState().setWorkspaceReady("env-hidden", true);
    });

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const codexTab = envHidden.root.tabs.find((tab) => tab.type === "codex");
      expect(codexTab?.initialPrompt).toBe("Review this diff");
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
    });
  });

  test("saves container initial prompt attachments before creating the agent tab", async () => {
    seedContainerSetupCommands();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "terminal",
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(writeContainerFileMock).toHaveBeenCalledWith(
        "container-hidden",
        ".orkestrator/initial-prompt/screen-shot.png",
        "QUJD",
      );
    });

    await waitFor(() => {
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toBeDefined();
    });

    await act(async () => {
      useEnvironmentStore.getState().setWorkspaceReady("env-hidden", true);
    });

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      const codexTab = envHidden.root.tabs.find((tab) => tab.type === "codex");
      expect(codexTab?.initialPrompt).toContain("Use this screenshot");
      expect(codexTab?.initialPrompt).toContain(
        "/workspace/.orkestrator/initial-prompt/screen-shot.png",
      );
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
      expect(
        useClaudeOptionsStore.getState().getOptions("env-hidden")
      ).toBeUndefined();
    });
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
    }));

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "terminal",
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
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
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

  test("clears failed initial prompt attachments and still creates the tab", async () => {
    seedContainerSetupCommands();
    writeContainerFileMock.mockImplementation(async () => {
      throw new Error("disk full");
    });

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "terminal",
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
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual([TEST_CONTAINER_SETUP_COMMAND]);
      expect(useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")).toEqual({
        containerId: "container-hidden",
        environmentId: "env-hidden",
        initialPrompt: "Continue without image",
        targetPaneId: "default",
        agentType: "codex",
        launchMode: "terminal",
      });
      expect(
        useClaudeOptionsStore.getState().getOptions("env-hidden")?.initialPromptAttachments,
      ).toEqual([]);
    });
  });

  test("creates a codex native tab for ready local environments when codexMode is native", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "native",
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
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
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("codex-native");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Ship it");
    });

    expect(markSetupScriptsCompleteMock).toHaveBeenCalledWith("env-hidden");
  });

  test("creates a Claude tmux tab for ready local environments when Claude native backend is tmux", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeMode: "native",
          claudeNativeBackend: "tmux",
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
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
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
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

  test("creates setup and Claude tmux tabs for local environments with setup commands", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeMode: "native",
          claudeNativeBackend: "tmux",
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
          : env
      ),
      pendingSetupCommands: new Map([["env-hidden", ["bun install"]]]),
      setupCommandsResolved: new Set(["env-hidden"]),
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
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(2);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual(["bun install"]);
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(envHidden.root.tabs[1]?.type).toBe("claude-tmux");
      expect(envHidden.root.tabs[1]?.initialPrompt).toBe("After setup");
      expect(envHidden.root.activeTabId).toBe("default");
    });

    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(
      true
    );
  });

  test("resumes a pending container native launch after the environment remounts", async () => {
    seedContainerSetupCommands();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "native",
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
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual([TEST_CONTAINER_SETUP_COMMAND]);
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(true);
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeDefined();
    });

    firstRender.unmount();

    // Simulate the old timer clearing transient options while the durable
    // launch intent survives the component unmount.
    useClaudeOptionsStore.getState().clearOptions("env-hidden");
    await act(async () => {
      useEnvironmentStore.getState().setWorkspaceReady("env-hidden", true);
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const nativeTab = envHidden.root.tabs.find((tab) => tab.type === "codex-native");
      expect(nativeTab?.initialPrompt).toBe("Continue after setup");
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
      setupScriptsRunning: new Set(["env-hidden"]),
      workspaceReadyEnvironments: new Set(),
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
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      const nativeTab = envHidden.root.tabs.find((tab) => tab.type === "codex-native");
      expect(nativeTab?.initialPrompt).toBe("Recover from stale setup state");
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-hidden")).toBe(true);
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
    });
  });

  test("launches Claude tmux after container setup when Claude native backend is tmux", async () => {
    seedContainerSetupCommands();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeMode: "native",
          claudeNativeBackend: "tmux",
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
      </TerminalProvider>
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
      useEnvironmentStore.getState().setWorkspaceReady("env-hidden", true);
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
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
    });
  });

  test("clears a pending native launch when the container id changes", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "native",
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
        setupCommands: [],
        setupManagedByBackend: true,
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeDefined();
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
    });
  });

  test("runs workspace setup script in a plain container terminal", async () => {
    seedContainerSetupCommands();
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
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("plain");
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual([TEST_CONTAINER_SETUP_COMMAND]);
      expect(envHidden.root.tabs[0]?.isSetupTab).toBe(true);
    });

    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(
      true
    );
  });

  test("runs inactive container setup through the backend and opens readiness gates", async () => {
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(ensureEnvironmentSetupMock).toHaveBeenCalledWith("env-hidden");
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-hidden")).toBe(true);
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
    });
  });

  test("clears setup-running state when inactive backend setup fails", async () => {
    ensureEnvironmentSetupMock.mockRejectedValueOnce(new Error("setup exploded"));
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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(ensureEnvironmentSetupMock).toHaveBeenCalledWith("env-hidden");
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
    });
    expect(useEnvironmentStore.getState().isWorkspaceReady("env-hidden")).toBe(false);
  });

  test("attaches a setup tab to a backend-owned setup session", async () => {
    getEnvironmentSetupSessionMock.mockResolvedValue({
      environmentId: "env-hidden",
      sessionId: "env-hidden:setup",
      running: true,
      startedAt: "2024-01-01T00:00:00.000Z",
      terminalRunning: true,
    });
    useEnvironmentStore.setState((state) => ({
      ...state,
      setupCommandsResolved: new Set(["env-hidden"]),
      setupScriptsRunning: new Set(["env-hidden"]),
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
      </TerminalProvider>
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
        useTerminalSessionStore.getState().sessions.get(
          createSessionKey("container-hidden", "default", "env-hidden"),
        )?.sessionId,
      ).toBe("env-hidden:setup");
    });
  });

  test("requests backend setup for previously incomplete local environments", async () => {
    ensureEnvironmentSetupMock.mockImplementationOnce(async (environmentId: string) => {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId)!;
      return {
        setupCommands: [],
        setupManagedByBackend: true,
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
          : env
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
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

    expect(ensureEnvironmentSetupMock).toHaveBeenCalledWith("env-hidden");
    expect(getSetupCommandsMock).not.toHaveBeenCalled();
    expect(
      useTerminalSessionStore.getState().sessions.get(
        createSessionKey(null, "default", "env-hidden"),
      )?.sessionId,
    ).toBe("env-hidden:setup");
    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(
      true
    );
  });

  test("does not create a blank setup tab when backend setup is a no-op", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "native",
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
          : env
      ),
    }));
    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Review this build",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(ensureEnvironmentSetupMock).toHaveBeenCalledWith("env-hidden");
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("codex-native");
      expect(envHidden.root.tabs[0]?.isSetupTab).toBeUndefined();
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Review this build");
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(false);
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-hidden")).toBe(true);
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
              type: "codex-native",
              codexNativeData: { environmentId: "env-hidden", isLocal: true },
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("codex-native");
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
          : env
      ),
    }));

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
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
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "",
        },
      },
      pendingNativeLaunches: {},
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }
      expect(envHidden.root.tabs[0]?.type).toBe("claude");
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeUndefined();
    });

    // The fallback timer (3s) clears the now-applied options.
    await waitFor(
      () => {
        expect(
          useClaudeOptionsStore.getState().getOptions("env-hidden")
        ).toBeUndefined();
      },
      { timeout: 6000 }
    );
  }, 12000);

  test("keeps launch options while a pending native launch is still outstanding", async () => {
    // Containerized native launch rendered active: startInactiveBackendSetup
    // bails out for active environments, so the workspace never becomes ready
    // and the pending native launch is never consumed. The fallback cleanup
    // timer must NOT clear options while that launch is still outstanding.
    useEnvironmentStore.getState().setSetupCommandsResolved("env-hidden", true);

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
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toMatchObject({
        agentType: "codex",
        launchMode: "native",
      });
    });

    // Wait past the fallback timer window; the launch is still outstanding.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
    });

    expect(
      useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
    ).toBeDefined();
    expect(
      useClaudeOptionsStore.getState().getOptions("env-hidden")
    ).toMatchObject({ launchAgent: true, agentType: "codex" });
  }, 12000);

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
        </TerminalProvider>
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const fileTabs = env.root.tabs.filter((tab) => tab.type === "file");
        expect(fileTabs).toHaveLength(1);
        expect(env.root.activeTabId).toBe(fileTabs[0]?.id ?? null);
      });
    });

    test("creates local file tabs with worktree metadata and no container id", async () => {
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
            containerId: null,
          }],
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
            : env
        ),
      }));

      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId={null}
            isActive
          />
          <CreateFileTabHarness
            calls={[{ filePath: "README.md", options: { gitStatus: "?" } }]}
          />
        </TerminalProvider>
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
        })
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
        })
      ).toEqual({ type: "reorder", paneId: "left", fromIndex: 0, toIndex: 2 });

      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:b:pane:left",
          overId: "tab:y:pane:right",
          lastDragOverPaneId: null,
          getPane,
        })
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
        })
      ).toEqual({
        type: "move",
        fromPaneId: "left",
        toPaneId: "right",
        tabId: "b",
      });
    });

    test("returns none for invalid drops and no-op same-pane tabbar drops", () => {
      const getPane = (paneId: string) => paneId === "left" ? pane("left", ["a"]) : null;

      expect(
        getTerminalTabDragEndAction({
          activeId: "not-a-tab",
          overId: "tab:a:pane:left",
          lastDragOverPaneId: null,
          getPane,
        })
      ).toEqual({ type: "none" });
      expect(
        getTerminalTabDragEndAction({
          activeId: "tab:a:pane:left",
          overId: "tabbar:left",
          lastDragOverPaneId: null,
          getPane,
        })
      ).toEqual({ type: "none" });
    });
  });

  describe("createTab forwards displayTitle", () => {
    function CreateTabHarness({
      type,
      options,
    }: {
      type: CreatableTabType;
      options: CreateTabOptions;
    }) {
      const { createTab } = useTerminalContext();
      useEffect(() => {
        if (createTab) createTab(type, options);
      }, [createTab, type, options]);
      return null;
    }

    test("plain terminal tabs receive displayTitle", async () => {
      render(
        <TerminalProvider>
          <TerminalContainer
            environmentId="env-visible"
            containerId="container-visible"
            isContainerRunning
            isActive
          />
          <CreateTabHarness
            type="plain"
            options={{ displayTitle: "Custom", isReviewTab: true }}
          />
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "plain" && t.id !== "visible-tab");
        expect(created?.displayTitle).toBe("Custom");
        expect(created?.isReviewTab).toBe(true);
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
        </TerminalProvider>
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
          usePaneLayoutStore.getState().getAllTabs("env-visible").some((tab) => tab.type === "browser"),
        ).toBe(false);
      });
    });

    test("respects the tab limit when creating browser tabs", async () => {
      usePaneLayoutStore.setState((state) => ({
        environments: new Map(state.environments).set("env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: Array.from({ length: 9 }, (_, index) => ({ id: `tab-${index}`, type: "plain" as const })),
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
              { kind: "leaf", id: "left", tabs: [{ id: "left-tab", type: "plain" }], activeTabId: "left-tab" },
              { kind: "leaf", id: "right", tabs: [{ id: "right-tab", type: "plain" }], activeTabId: "right-tab" },
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

    test("claude-native tabs receive displayTitle", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: { ...state.config.global, claudeMode: "native" },
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude-native");
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
            claudeMode: "native",
            claudeNativeBackend: "tmux",
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
            options={{ displayTitle: "Tmux", initialPrompt: "hi" }}
          />
        </TerminalProvider>
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
            claudeMode: "terminal",
            claudeNativeBackend: "sdk",
          },
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              agentStyle: "native",
              claudeNativeBackend: "tmux",
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
        </TerminalProvider>
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
          global: { ...state.config.global, codexMode: "native" },
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
            options={{ displayTitle: "PR", isReviewTab: true }}
          />
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "codex-native");
        expect(created?.displayTitle).toBe("PR");
        expect(created?.isReviewTab).toBe(true);
      });
    });

    test("opencode-native tabs receive displayTitle", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: { ...state.config.global, opencodeMode: "native" },
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "opencode-native");
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
            claudeMode: "terminal",
            claudeNativeBackend: "sdk",
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
        </TerminalProvider>
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
          global: { ...state.config.global, codexMode: "terminal" },
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "codex-native");
        expect(created?.displayTitle).toBe("Forced native");
      });
    });

    test("agentLaunchMode cli opens an OpenCode CLI tab even when OpenCode defaults to native", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: { ...state.config.global, opencodeMode: "native" },
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
        </TerminalProvider>
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
            claudeMode: "native",
            claudeNativeBackend: "tmux",
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
        </TerminalProvider>
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
            claudeMode: "native",
            claudeNativeBackend: "tmux",
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "claude-native");
        expect(created?.displayTitle).toBe("Forced Claude Native");
        expect(env.root.tabs.some((t) => t.type === "claude-tmux")).toBe(false);
      });
    });

    test("agentLaunchMode cli opens a Codex CLI tab even when Codex defaults to native", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: { ...state.config.global, codexMode: "native" },
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
        </TerminalProvider>
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
          global: { ...state.config.global, opencodeMode: "terminal" },
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
        </TerminalProvider>
      );

      await waitFor(() => {
        const env = usePaneLayoutStore.getState().environments.get("env-visible");
        if (!env || env.root.kind !== "leaf") throw new Error("expected leaf");
        const created = env.root.tabs.find((t) => t.type === "opencode-native");
        expect(created?.displayTitle).toBe("Forced OpenCode Native");
      });
    });
  });
});
