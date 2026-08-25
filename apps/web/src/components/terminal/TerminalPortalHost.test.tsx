import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useSyncExternalStore } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as realPersistentTerminal from "./PersistentTerminal";
import * as realTerminalPortalStore from "@/stores/terminalPortalStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

const persistentTerminalSnapshot = { ...realPersistentTerminal };
const terminalPortalStoreSnapshot = { ...realTerminalPortalStore };
const createTerminalMock = mock(() => {});
const disposeTerminalMock = mock(() => {});
const clearTerminalsForEnvironmentMock = mock(() => {});
const paneHost = document.createElement("div");
let terminalStoreHasTerminal = true;
let terminalStorePaneHosts = new Map<string, HTMLDivElement>();
let terminalStoreVersion = 0;
const terminalStoreListeners = new Set<() => void>();
let terminalStoreTerminals: Map<
  string,
  {
    environmentId: string;
    tabId: string;
    portalElement: HTMLDivElement;
    containerElement: HTMLDivElement;
    isOpened: boolean;
  }
> = new Map();

let lastPersistentTerminalProps:
  | {
      isReviewTab?: boolean;
      isSetupTab?: boolean;
      initialCommands?: string[];
      initialAgentModel?: string;
      initialReasoningEffort?: string;
      tabType?: string;
    }
  | undefined;

mock.module("./PersistentTerminal", () => ({
  PersistentTerminal: (props: {
    onReady?: (payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => void;
    onSetupComplete?: (payload: { persistSetupComplete: boolean }) => void;
    isReviewTab?: boolean;
    isSetupTab?: boolean;
    initialCommands?: string[];
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    tabType?: string;
  }) => {
    lastPersistentTerminalProps = props;
    return null;
  },
}));

const terminalPortalStoreState = () => ({
  paneHosts: terminalStorePaneHosts,
  terminals: terminalStoreTerminals,
  createTerminal: createTerminalMock,
  disposeTerminal: disposeTerminalMock,
  clearTerminalsForEnvironment: clearTerminalsForEnvironmentMock,
  hasTerminal: () => terminalStoreHasTerminal,
  getPaneHost: (environmentId: string, paneId: string) =>
    terminalStorePaneHosts.get(`${environmentId}::${paneId}`),
});

const useTerminalPortalStoreMock = (<T,>(
  selector?: (state: {
    paneHosts: Map<string, HTMLDivElement>;
    terminals: Map<
      string,
      {
        environmentId: string;
        tabId: string;
        portalElement: HTMLDivElement;
        containerElement: HTMLDivElement;
        isOpened: boolean;
      }
    >;
    createTerminal: typeof createTerminalMock;
    disposeTerminal: typeof disposeTerminalMock;
    clearTerminalsForEnvironment: typeof clearTerminalsForEnvironmentMock;
    hasTerminal: (environmentId: string, tabId: string) => boolean;
    getPaneHost: (environmentId: string, paneId: string) => HTMLDivElement | undefined;
  }) => T,
) => {
  useSyncExternalStore(
    (listener) => {
      terminalStoreListeners.add(listener);
      return () => terminalStoreListeners.delete(listener);
    },
    () => terminalStoreVersion,
  );
  const state = terminalPortalStoreState();

  return selector ? selector(state) : state;
}) as any;

useTerminalPortalStoreMock.getState = terminalPortalStoreState;

mock.module("@/stores/terminalPortalStore", () => ({
  createPortalTargetKey: (environmentId: string, paneId: string) => `${environmentId}::${paneId}`,
  useTerminalPortalStore: useTerminalPortalStoreMock,
}));

const { TerminalPortalHost } = await import("./TerminalPortalHost");

afterAll(() => {
  mock.module("./PersistentTerminal", () => persistentTerminalSnapshot);
  mock.module("@/stores/terminalPortalStore", () => terminalPortalStoreSnapshot);
});

describe("TerminalPortalHost", () => {
  beforeEach(() => {
    lastPersistentTerminalProps = undefined;
    createTerminalMock.mockClear();
    disposeTerminalMock.mockClear();
    clearTerminalsForEnvironmentMock.mockClear();
    terminalStoreHasTerminal = true;
    terminalStorePaneHosts = new Map([["env-1::default", paneHost]]);
    terminalStoreVersion += 1;
    terminalStoreTerminals = new Map([
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
    ]);

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "", mode: "terminal" },
              codex: { model: "", reasoningEffort: "medium", mode: "terminal" },
              claude: { mode: "terminal", claudeNativeBackend: "sdk" },
            },
          },
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
      deletingEnvironments: new Set<string>(),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    paneHost.replaceChildren();
  });

  test("creates terminals even before the pane-layout active environment is set", async () => {
    terminalStoreHasTerminal = false;
    terminalStoreTerminals = new Map();
    usePaneLayoutStore.setState((state) => ({
      ...state,
      activeEnvironmentId: null,
    }));

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(createTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "env-1",
          tabId: "default",
          containerId: "container-1",
        }),
      );
    });
  });

  test("mounts an existing terminal when its pane host registers later", async () => {
    terminalStorePaneHosts = new Map();

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);
    expect(lastPersistentTerminalProps).toBeUndefined();
    expect(paneHost.childElementCount).toBe(0);

    terminalStorePaneHosts = new Map([["env-1::default", paneHost]]);
    terminalStoreVersion += 1;
    act(() => {
      for (const listener of terminalStoreListeners) listener();
    });

    await waitFor(() => {
      expect(lastPersistentTerminalProps).toBeDefined();
      expect(paneHost.childElementCount).toBe(1);
    });
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
              initialAgentModel: "review-model",
              initialReasoningEffort: "high",
            },
          ],
        },
      });
      return { environments };
    });

    render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

    await waitFor(() => {
      expect(lastPersistentTerminalProps?.isReviewTab).toBe(true);
      expect(lastPersistentTerminalProps?.initialAgentModel).toBe("review-model");
      expect(lastPersistentTerminalProps?.initialReasoningEffort).toBe("high");
    });
  });

  test.each(["cursor", "grok", "pi"] as const)(
    "mounts %s CLI tabs as persistent terminals",
    async (tabType) => {
      usePaneLayoutStore.setState((state) => {
        const environments = new Map(state.environments);
        const current = environments.get("env-1");
        if (!current || current.root.kind !== "leaf") throw new Error("expected env-1 leaf");
        environments.set("env-1", {
          ...current,
          root: {
            ...current.root,
            tabs: [{ id: "default", type: tabType }],
          },
        });
        return { environments };
      });

      render(<TerminalPortalHost environmentId="env-1" containerId="container-1" />);

      await waitFor(() => {
        expect(lastPersistentTerminalProps?.tabType).toBe(tabType);
      });
    },
  );
});
