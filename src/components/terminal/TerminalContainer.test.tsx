import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import * as realTauri from "@/lib/tauri";

const realTauriSnapshot = { ...realTauri };

const markSetupScriptsCompleteMock = mock(() => {});
const getSetupCommandsMock = mock(async (): Promise<string[] | null> => null);
const writeContainerFileMock = mock(async (_containerId: string, filePath: string) => `/workspace/${filePath}`);
const writeLocalFileMock = mock(async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`);

mock.module("@/lib/setup-commands", () => ({
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

mock.module("@/lib/tauri", () => ({
  ...realTauriSnapshot,
  getSetupCommands: getSetupCommandsMock,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
}));

mock.module("@/components/pane-layout", () => ({
  PaneTree: () => null,
}));

mock.module("./TerminalPortalHost", () => ({
  TerminalPortalHost: () => null,
}));

mock.module("./InitializationLogs", () => ({
  InitializationLogs: () => null,
}));

const { TerminalContainer } = await import("./TerminalContainer");

describe("TerminalContainer", () => {
  afterAll(() => {
    mock.module("@/lib/tauri", () => realTauriSnapshot);
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

    markSetupScriptsCompleteMock.mockClear();
    getSetupCommandsMock.mockReset();
    getSetupCommandsMock.mockResolvedValue(null);
    writeContainerFileMock.mockReset();
    writeLocalFileMock.mockReset();
    writeContainerFileMock.mockImplementation(async (_containerId: string, filePath: string) => `/workspace/${filePath}`);
    writeLocalFileMock.mockImplementation(async (worktreePath: string, filePath: string) => `${worktreePath}/${filePath}`);

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
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

  test("creates a codex terminal tab when codexMode is terminal", async () => {
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
      expect(envHidden.root.tabs[0]?.type).toBe("codex");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Review this diff");
    });
  });

  test("saves container initial prompt attachments before creating the agent tab", async () => {
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
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs[0]?.type).toBe("codex");
      expect(envHidden.root.tabs[0]?.initialPrompt).toContain("Use this screenshot");
      expect(envHidden.root.tabs[0]?.initialPrompt).toContain(
        "/workspace/.orkestrator/initial-prompt/screen-shot.png",
      );
      expect(
        useClaudeOptionsStore.getState().getOptions("env-hidden")?.initialPromptAttachments,
      ).toEqual([]);
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

      expect(envHidden.root.tabs[0]?.type).toBe("codex");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Continue without image");
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

  test("resumes a pending container native launch after the environment remounts", async () => {
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
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(true);
      expect(
        useClaudeOptionsStore.getState().getPendingNativeLaunch("env-hidden")
      ).toBeDefined();
    });

    firstRender.unmount();

    // Simulate the old timer clearing transient options while the durable
    // launch intent survives the component unmount.
    useClaudeOptionsStore.getState().clearOptions("env-hidden");
    useEnvironmentStore.getState().setWorkspaceReady("env-hidden", true);

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

  test("re-runs setup commands for previously incomplete local environments", async () => {
    getSetupCommandsMock.mockResolvedValue(["bun install"]);

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
      expect(envHidden.root.tabs[0]?.initialCommands).toEqual(["bun install"]);
    });

    expect(getSetupCommandsMock).toHaveBeenCalledWith("env-hidden");
    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-hidden")).toBe(
      true
    );
  });

  test("does not persist completion when rerun setup command fetch fails", async () => {
    getSetupCommandsMock.mockRejectedValue(new Error("unavailable"));

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
});
