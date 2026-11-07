import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realDndKitCore from "@dnd-kit/core";
import * as realBackend from "@/lib/backend";
import { TerminalProvider } from "@/contexts";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

const realDndKitCoreSnapshot = { ...realDndKitCore };
const realBackendSnapshot = { ...realBackend };

// A plain child of the container, so it renders exactly when the container does.
let containerRenders = 0;
mock.module("@/components/pane-layout", () => ({
  PaneTree: () => {
    containerRenders += 1;
    return null;
  },
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getSetupCommands: mock(async () => []),
  getEnvironmentSetupSession: mock(async () => null),
  getSessionsByEnvironment: mock(async () => []),
  getPaneLayout: mock(async () => null),
  savePaneLayout: mock(async () => undefined),
  listMultiReviewWorkflows: mock(async () => []),
  getBuildPipelineConditional: mock(async () => null),
}));
mock.module("./TerminalPortalHost", () => ({ TerminalPortalHost: () => null }));
mock.module("./InitializationLogs", () => ({ InitializationLogs: () => null }));
mock.module("@dnd-kit/core", () => ({
  ...realDndKitCoreSnapshot,
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { TerminalContainer } = await import("./TerminalContainer");

afterAll(() => {
  mock.module("@dnd-kit/core", () => realDndKitCoreSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "one",
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
    setupPhase: "ready",
    agentSettings: { defaultAgent: "codex" },
    startupAgentSession: {
      tabId: "startup-agent",
      agent: "codex",
      style: "native",
      status: "running",
    },
    ...overrides,
  } as Environment;
}

beforeEach(() => {
  cleanup();
  containerRenders = 0;
  appCommandStore(environmentStore).setState({ environments: [environment()] });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "tab-1", type: "plain" }],
            activeTabId: "tab-1",
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map(),
    activeEnvironmentId: "env-1",
  });
});

/** Mounts the container and lets its hydration reads finish before counting. */
async function renderContainer(): Promise<void> {
  renderInAppCommandScope(
    <TerminalProvider>
      <TerminalContainer
        environmentId="env-1"
        containerId="container-1"
        isContainerRunning
        isActive
      />
    </TerminalProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(containerRenders).toBeGreaterThan(0);
  containerRenders = 0;
}

/** Writes to env-1 that change only fields the container does not read. */
async function writeUnrelatedFields(): Promise<void> {
  const store = appCommandStore(environmentStore).getState();
  await act(async () => {
    store.updateEnvironment("env-1", { lastActivityAt: "2024-01-02T00:00:00.000Z" });
    store.updateEnvironmentStatus("env-1", "stopping");
    store.setEnvironmentPR("env-1", "https://example.com/pr/1", "open", false);
    // A snapshot decodes new objects for every nested field it carries.
    store.mergeEnvironmentsForProject("project-1", [
      structuredClone({
        ...store.getEnvironmentById("env-1")!,
        status: "running" as const,
        prUrl: "https://example.com/pr/2",
      }),
    ]);
  });
}

/** A setup terminal, selected, beside the startup agent the backend published. */
function seedStartupAgentPane(): void {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "setup", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: { platform: "codex", environmentId: "env-1" },
              },
            ],
            activeTabId: "setup",
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map([["env-1", "done"]]),
  } as never);
}

function selectedTabId(): string | null | undefined {
  return appCommandStore(paneLayoutStore).getState().getPane("default", "env-1")?.activeTabId;
}

test("an unrelated environment field does not re-render the container", async () => {
  await renderContainer();
  await writeUnrelatedFields();
  expect(containerRenders).toBe(0);
});

test("another environment in the project does not re-render the container", async () => {
  appCommandStore(environmentStore).setState({
    environments: [environment(), environment({ id: "env-2", order: 1 })],
  });
  await renderContainer();
  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .mergeEnvironmentsForProject("project-1", [
        environment(),
        environment({ id: "env-2", order: 1, status: "stopped" }),
      ]);
  });
  expect(containerRenders).toBe(0);
});

test("a field the container reads still re-renders it", async () => {
  await renderContainer();
  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment("env-1", {
        agentSettings: { defaultAgent: "claude" },
      });
  });
  expect(containerRenders).toBeGreaterThan(0);
});

test("the launch handoff moves focus once, whatever unrelated writes surround it", async () => {
  appCommandStore(environmentStore).setState({
    environments: [
      environment({
        setupPhase: "running",
        pendingAgentLaunch: true,
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          status: "starting",
        },
      }),
    ],
  });
  seedStartupAgentPane();
  await renderContainer();

  await writeUnrelatedFields();
  expect(selectedTabId()).toBe("setup");

  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment("env-1", { setupPhase: "ready" });
  });
  expect(selectedTabId()).toBe("startup-agent");

  // The launch is still pending, so only the one-shot stops a second handoff
  // taking the user off the terminal they went back to.
  await act(async () => {
    appCommandStore(paneLayoutStore).getState().setActiveTab("default", "setup", "env-1");
  });
  await writeUnrelatedFields();
  expect(selectedTabId()).toBe("setup");
});

test("the setup check still sees a user proceeding past a failed setup", async () => {
  appCommandStore(environmentStore).setState({
    environments: [environment({ setupPhase: "failed", pendingAgentLaunch: true })],
  });
  seedStartupAgentPane();
  await renderContainer();
  expect(selectedTabId()).toBe("setup");

  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment("env-1", { setupOverride: true });
  });
  expect(selectedTabId()).toBe("startup-agent");
});

test("a provider session binds when published and unrelated writes do not bind it again", async () => {
  const realUpdate = appCommandStore(paneLayoutStore).getState().updateTabNativeSessionId;
  const updateTabNativeSessionId = mock(realUpdate);
  appCommandStore(paneLayoutStore).setState({ updateTabNativeSessionId });
  try {
    seedStartupAgentPane();
    await renderContainer();
    expect(updateTabNativeSessionId).not.toHaveBeenCalled();

    await act(async () => {
      appCommandStore(environmentStore)
        .getState()
        .updateEnvironment("env-1", {
          startupAgentSession: {
            tabId: "startup-agent",
            agent: "codex",
            style: "native",
            status: "running",
            providerSessionId: "provider-session",
          },
        });
    });
    const startupTab = appCommandStore(paneLayoutStore)
      .getState()
      .getAllTabs("env-1")
      .find((tab) => tab.id === "startup-agent");
    expect(startupTab?.nativeAgentData?.sessionId).toBe("provider-session");

    const bindsAfterPublish = updateTabNativeSessionId.mock.calls.length;
    await writeUnrelatedFields();
    expect(updateTabNativeSessionId).toHaveBeenCalledTimes(bindsAfterPublish);
  } finally {
    appCommandStore(paneLayoutStore).setState({ updateTabNativeSessionId: realUpdate });
  }
});
