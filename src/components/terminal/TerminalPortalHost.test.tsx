import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as realPersistentTerminal from "./PersistentTerminal";
import * as realTerminalPortalStore from "@/stores/terminalPortalStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

const persistentTerminalSnapshot = { ...realPersistentTerminal };
const terminalPortalStoreSnapshot = { ...realTerminalPortalStore };
const markSetupScriptsCompleteMock = mock(() => {});
const createTerminalMock = mock(() => {});
const disposeTerminalMock = mock(() => {});
const clearTerminalsForEnvironmentMock = mock(() => {});
const paneHost = document.createElement("div");

let terminalBehavior:
  | ((props: {
      onReady?: (payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => void;
      onSetupComplete?: (payload: { persistSetupComplete: boolean }) => void;
    }) => void)
  | undefined;
let lastPersistentTerminalProps:
  | {
      isReviewTab?: boolean;
      isSetupTab?: boolean;
      initialCommands?: string[];
    }
  | undefined;

mock.module("@/lib/setup-commands", () => ({
  shouldAutoResolveSetupCommands: () => false,
  markSetupScriptsComplete: markSetupScriptsCompleteMock,
}));

mock.module("./PersistentTerminal", () => ({
  PersistentTerminal: (props: {
    onReady?: (payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => void;
    onSetupComplete?: (payload: { persistSetupComplete: boolean }) => void;
    isReviewTab?: boolean;
    isSetupTab?: boolean;
    initialCommands?: string[];
  }) => {
    lastPersistentTerminalProps = props;
    useEffect(() => {
      terminalBehavior?.(props);
    }, [props]);
    return null;
  },
}));

const terminalPortalStoreState = () => ({
  terminals: new Map([
    [
      "env-1::default",
      {
        environmentId: "env-1",
        tabId: "default",
        portalElement: document.createElement("div"),
        containerElement: document.createElement("div"),
        isOpened: true,
      },
    ],
  ]),
  createTerminal: createTerminalMock,
  disposeTerminal: disposeTerminalMock,
  clearTerminalsForEnvironment: clearTerminalsForEnvironmentMock,
  hasTerminal: () => true,
  getPaneHost: () => paneHost,
});

const useTerminalPortalStoreMock = (<T,>(selector?: (state: {
    terminals: Map<string, {
      environmentId: string;
      tabId: string;
      portalElement: HTMLDivElement;
      containerElement: HTMLDivElement;
      isOpened: boolean;
    }>;
    createTerminal: typeof createTerminalMock;
    disposeTerminal: typeof disposeTerminalMock;
    clearTerminalsForEnvironment: typeof clearTerminalsForEnvironmentMock;
    hasTerminal: (environmentId: string, tabId: string) => boolean;
    getPaneHost: (environmentId: string, paneId: string) => HTMLDivElement | undefined;
  }) => T) => {
    const state = terminalPortalStoreState();

    return selector ? selector(state) : state;
  }) as any;

useTerminalPortalStoreMock.getState = terminalPortalStoreState;

mock.module("@/stores/terminalPortalStore", () => ({
  useTerminalPortalStore: useTerminalPortalStoreMock,
}));

const { TerminalPortalHost } = await import("./TerminalPortalHost");

afterAll(() => {
  mock.module("./PersistentTerminal", () => persistentTerminalSnapshot);
  mock.module("@/stores/terminalPortalStore", () => terminalPortalStoreSnapshot);
});

describe("TerminalPortalHost", () => {
  beforeEach(() => {
    terminalBehavior = undefined;
    lastPersistentTerminalProps = undefined;
    markSetupScriptsCompleteMock.mockClear();
    createTerminalMock.mockClear();
    disposeTerminalMock.mockClear();
    clearTerminalsForEnvironmentMock.mockClear();

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          defaultAgent: "claude",
          opencodeModel: "",
          codexModel: "",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeBackend: "sdk",
          codexMode: "terminal",
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {},
      },
    });

    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "default", type: "plain", isSetupTab: true }],
              activeTabId: "default",
            },
            activePaneId: "default",
            containerId: "container-1",
          },
        ],
      ]),
      activeEnvironmentId: "env-1",
    });

    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "env-1",
          branch: "main",
          containerId: "container-1",
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "containerized",
        },
      ],
      workspaceReadyEnvironments: new Set<string>(),
      deletingEnvironments: new Set<string>(),
      pendingSetupCommands: new Map<string, string[]>(),
      setupCommandsResolved: new Set<string>(),
      setupScriptsRunning: new Set<string>(["env-1"]),
      sessionActivated: new Set<string>(),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    paneHost.replaceChildren();
  });

  test("persists completion when a container terminal reports successful readiness", async () => {
    terminalBehavior = ({ onReady }) => {
      onReady?.({ persistSetupComplete: true });
    };

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(true);
    });

    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-1")).toBe(false);
    expect(markSetupScriptsCompleteMock).toHaveBeenCalledWith("env-1");
  });

  test("does not persist completion when a local terminal only becomes shell-ready", async () => {
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) => ({
        ...environment,
        environmentType: "local",
        containerId: null,
      })),
    }));

    terminalBehavior = ({ onReady }) => {
      onReady?.({ persistSetupComplete: false });
    };

    render(<TerminalPortalHost environmentId="env-1" containerId={null} />);

    await waitFor(() => {
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(true);
    });

    expect(markSetupScriptsCompleteMock).not.toHaveBeenCalled();
  });

  test("does not mark a container workspace ready from a terminal reconnection", async () => {
    let reconnected = false;
    terminalBehavior = ({ onReady }) => {
      reconnected = true;
      onReady?.({ persistSetupComplete: false, workspaceReady: false });
    };

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(reconnected).toBe(true);
    });

    expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(false);
    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-1")).toBe(true);
    expect(markSetupScriptsCompleteMock).not.toHaveBeenCalled();
  });

  test("keeps manual setup completion runtime-only", async () => {
    terminalBehavior = ({ onSetupComplete }) => {
      onSetupComplete?.({ persistSetupComplete: false });
    };

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-1")).toBe(false);
    });

    expect(markSetupScriptsCompleteMock).not.toHaveBeenCalled();
  });

  test("persists automatic setup completion", async () => {
    terminalBehavior = ({ onSetupComplete }) => {
      onSetupComplete?.({ persistSetupComplete: true });
    };

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-1")).toBe(false);
    });

    expect(markSetupScriptsCompleteMock).toHaveBeenCalledWith("env-1");
  });

  test("forwards review-tab state to persistent terminals", async () => {
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      const current = environments.get("env-1");
      if (!current || current.root.kind !== "leaf") {
        throw new Error("expected env-1 leaf");
      }
      environments.set("env-1", {
        ...current,
        root: {
          ...current.root,
          tabs: [
            {
              id: "default",
              type: "plain",
              isReviewTab: true,
            },
          ],
        },
      });
      return { environments };
    });

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(lastPersistentTerminalProps?.isReviewTab).toBe(true);
    });
  });
});
