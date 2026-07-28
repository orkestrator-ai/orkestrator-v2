import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import * as realBuildChatTab from "./BuildChatTab";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

const realBuildChatTabSnapshot = { ...realBuildChatTab };
const renderedDrivers = mock(
  ({ data, isActive }: Parameters<typeof realBuildChatTab.BuildChatTab>[0]) => (
    <div
      data-testid={`driver-${data.pipelineId}`}
      data-active={String(isActive)}
      data-environment={data.environmentId}
    />
  ),
);

mock.module("@/components/build-pipeline/BuildChatTab", () => ({
  BuildChatTab: renderedDrivers,
}));

const { BuildPipelineSupervisor } = await import("./BuildPipelineSupervisor");

afterAll(() => {
  mock.module("@/components/build-pipeline/BuildChatTab", () => realBuildChatTabSnapshot);
});

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "containerized",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-28T00:00:00.000Z",
    taskTitle: "Build the feature",
    taskSnapshot: {
      title: "Build the feature",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source: { type: "kanban", taskId: "task-1" },
    backendRevision: 1,
    ...overrides,
  };
}

function paneTabs() {
  const paneState = usePaneLayoutStore.getState().environments.get("env-1");
  if (!paneState || paneState.root.kind !== "leaf") {
    throw new Error("expected env-1 to have a leaf pane");
  }
  return paneState.root.tabs;
}

describe("BuildPipelineSupervisor", () => {
  beforeEach(() => {
    renderedDrivers.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline()]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: "terminal-1", type: "plain" }],
            activeTabId: "terminal-1",
          },
          activePaneId: "pane-1",
          containerId: "container-1",
        }],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });
  });

  test("mounts an inactive app-level driver without adding or focusing a tab", () => {
    render(<BuildPipelineSupervisor />);

    const driver = screen.getByTestId("driver-pipeline-1");
    expect(driver.getAttribute("data-active")).toBe("false");
    expect(driver.getAttribute("data-environment")).toBe("env-1");
    expect(paneTabs().map((tab) => tab.id)).toEqual(["terminal-1"]);

    const paneState = usePaneLayoutStore.getState().environments.get("env-1");
    expect(paneState?.root.kind === "leaf" && paneState.root.activeTabId).toBe("terminal-1");
  });

  test("does not duplicate a pipeline driver when a visible pane owns its tab", () => {
    usePaneLayoutStore.getState().addTab("pane-1", {
      id: "build-pipeline-1",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
        isLocal: false,
      },
    }, "env-1");

    render(<BuildPipelineSupervisor />);

    expect(screen.queryByTestId("driver-pipeline-1")).toBeNull();
  });

  test("does not duplicate a pane-owned pipeline in a background-mounted environment", () => {
    usePaneLayoutStore.getState().addTab("pane-1", {
      id: "build-pipeline-1",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
        isLocal: false,
      },
    }, "env-1");
    usePaneLayoutStore.setState({ activeEnvironmentId: "env-2" });

    render(<BuildPipelineSupervisor />);

    expect(screen.queryByTestId("driver-pipeline-1")).toBeNull();
  });

  test("finds a pane-owned pipeline recursively inside a split layout", () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 0,
            children: [
              {
                kind: "leaf",
                id: "pane-left",
                tabs: [{ id: "terminal-1", type: "plain" }],
                activeTabId: "terminal-1",
              },
              {
                kind: "leaf",
                id: "pane-right",
                tabs: [{
                  id: "build-pipeline-1",
                  type: "claude-build",
                  buildTabData: {
                    environmentId: "env-1",
                    pipelineId: "pipeline-1",
                    taskId: "task-1",
                    isLocal: false,
                  },
                }],
                activeTabId: "build-pipeline-1",
              },
            ],
          },
          activePaneId: "pane-right",
          containerId: "container-1",
        }],
      ]),
    });

    render(<BuildPipelineSupervisor />);

    expect(screen.queryByTestId("driver-pipeline-1")).toBeNull();
  });

  test("hands ownership to the app driver when a tab closes and back when it reopens", async () => {
    usePaneLayoutStore.getState().addTab("pane-1", {
      id: "build-pipeline-1",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
        isLocal: false,
      },
    }, "env-1");
    render(<BuildPipelineSupervisor />);
    expect(screen.queryByTestId("driver-pipeline-1")).toBeNull();

    usePaneLayoutStore.getState().removeTab("pane-1", "build-pipeline-1", "env-1");
    await waitFor(() => expect(screen.getByTestId("driver-pipeline-1")).toBeTruthy());

    usePaneLayoutStore.getState().addTab("pane-1", {
      id: "build-pipeline-1",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
        isLocal: false,
      },
    }, "env-1");
    await waitFor(() => expect(screen.queryByTestId("driver-pipeline-1")).toBeNull());
  });

  test("drives active pipelines before pane hydration while skipping terminal pipelines", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        ["complete", pipeline({ id: "complete", phase: "complete" })],
        ["failed", pipeline({ id: "failed", phase: "failed" })],
        ["pending-hydration", pipeline({ id: "pending-hydration", environmentId: "env-2" })],
      ]),
      buildEnvironmentIds: new Set(["env-1", "env-2"]),
    });

    render(<BuildPipelineSupervisor />);

    expect(screen.getByTestId("driver-pending-hydration")).toBeTruthy();
    expect(screen.queryByTestId("driver-complete")).toBeNull();
    expect(screen.queryByTestId("driver-failed")).toBeNull();
  });
});
