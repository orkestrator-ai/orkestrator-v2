import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import { TerminalProvider } from "@/contexts";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { keyInformation } from "@/components/build-pipeline/key-information-test-fixture";
import type { Environment } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

const backendSnapshot = { ...realBackend };
mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getSetupCommands: mock(async () => []),
  getEnvironmentSetupSession: mock(async () => null),
  getSessionsByEnvironment: mock(async () => []),
  getPaneLayout: mock(async () => null),
  savePaneLayout: mock(async () => undefined),
  listMultiReviewWorkflows: mock(async () => []),
  getBuildPipelineConditional: mock(async () => null),
}));
afterAll(() => mock.module("@/lib/backend", () => backendSnapshot));
afterEach(cleanup);
const { TerminalContainer } = await import("./TerminalContainer");

test("Notes activation creates and renders a real pane tab, and reopening reuses it", async () => {
  const pipeline = buildPipelineFixture({ phase: "complete", keyInformation });
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "fixture",
        branch: "main",
        environmentType: "local",
        worktreePath: "/fixture",
        status: "running",
        containerId: null,
        createdAt: pipeline.createdAt,
      } as Environment,
    ],
  });
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map([[pipeline.id, pipeline]]),
    buildEnvironmentIds: new Set(["env-1"]),
  });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            activeTabId: "build",
            tabs: [
              {
                id: "build",
                type: "claude-build",
                buildTabData: {
                  environmentId: "env-1",
                  pipelineId: pipeline.id,
                  taskId: pipeline.taskId,
                },
              },
            ],
          },
          activePaneId: "default",
          containerId: null,
        },
      ],
    ]),
    hydration: new Map(),
    activeEnvironmentId: "env-1",
  });
  renderInAppCommandScope(
    <TerminalProvider>
      <TerminalContainer environmentId="env-1" containerId={null} isContainerRunning isActive />
    </TerminalProvider>,
  );
  const notes = await screen.findByRole("tab", { name: /^Notes/ });
  fireEvent.doubleClick(notes);
  const tab = await screen.findByTestId("pipeline-key-information-tab");
  expect(within(tab).getByRole("region", { name: "Needs a look" })).toBeTruthy();
  expect(within(tab).getByText(keyInformation.summary!)).toBeTruthy();
  const store = appCommandStore(paneLayoutStore).getState();
  const opened = store.getAllTabs("env-1").find((t) => t.type === "key-information")!;
  expect(opened.keyInformationTabData).toEqual({
    environmentId: "env-1",
    pipelineId: pipeline.id,
    view: "notes",
  });
  expect(store.getActivePane("env-1")?.activeTabId).toBe(opened.id);
  act(() => store.setActiveTab("default", "build", "env-1"));
  // The opened tab is itself a "Notes" tab now, so ask the pipeline for its node.
  const pipelineGraph = await screen.findByRole("tablist", { name: "Build pipeline" });
  fireEvent.doubleClick(within(pipelineGraph).getByRole("tab", { name: /^Notes/ }));
  await waitFor(() =>
    expect(appCommandStore(paneLayoutStore).getState().getActivePane("env-1")?.activeTabId).toBe(
      opened.id,
    ),
  );
  expect(store.getAllTabs("env-1").filter((t) => t.type === "key-information")).toHaveLength(1);
});
