import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import * as realDndKitCore from "@dnd-kit/core";
import * as realBackend from "@/lib/backend";
import { TerminalProvider } from "@/contexts";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";

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
  useEnvironmentStore.setState({ environments: [environment()] });
  usePaneLayoutStore.setState({
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
  render(
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

test("an unrelated environment field does not re-render the container", async () => {
  await renderContainer();
  const store = useEnvironmentStore.getState();
  await act(async () => {
    store.updateEnvironment("env-1", { lastActivityAt: "2024-01-02T00:00:00.000Z" });
    store.updateEnvironmentStatus("env-1", "stopping");
    store.setEnvironmentPR("env-1", "https://example.com/pr/1", "open", false);
    // A snapshot decodes new objects for every nested field it carries.
    store.mergeEnvironmentsForProject("project-1", [
      environment({ status: "running", prUrl: "https://example.com/pr/2" }),
    ]);
  });
  expect(containerRenders).toBe(0);
});

test("another environment in the project does not re-render the container", async () => {
  useEnvironmentStore.setState({
    environments: [environment(), environment({ id: "env-2", order: 1 })],
  });
  await renderContainer();
  await act(async () => {
    useEnvironmentStore
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
    useEnvironmentStore.getState().updateEnvironment("env-1", {
      agentSettings: { defaultAgent: "claude" },
    });
  });
  expect(containerRenders).toBeGreaterThan(0);
});
