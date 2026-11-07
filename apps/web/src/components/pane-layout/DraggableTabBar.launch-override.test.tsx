import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import { invoke } from "@/lib/native/backend";
import { coordinatorLaunchOverrideStore } from "@/stores/coordinatorLaunchOverrideStore";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import { DraggableTabBar } from "./DraggableTabBar";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

let answer: unknown;
let settledReads: Array<"answered" | "failed">;
const overrideReads = () =>
  invokeMock.mock.calls.filter(([command]) => command === COORDINATOR_LAUNCH_OVERRIDES_COMMAND);

const agentTab = (id: string): TabInfo => ({
  id,
  type: "agent-native",
  nativeAgentData: { platform: "claude", environmentId: "worker" },
});

function renderTabs(tabs: TabInfo[], environmentId = "worker") {
  const pane: PaneLeaf = { kind: "leaf", id: "pane", activeTabId: tabs[0]!.id, tabs };
  return renderInAppCommandScope(
    <DndContext>
      <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
    </DndContext>,
  );
}

beforeEach(() => {
  appCommandStore(coordinatorLaunchOverrideStore).getState().reset();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  answer = { overrides: [] };
  settledReads = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== COORDINATOR_LAUNCH_OVERRIDES_COMMAND) return undefined;
    if (answer instanceof Error) {
      settledReads.push("failed");
      throw answer;
    }
    settledReads.push("answered");
    return answer;
  });
});

afterEach(() => {
  cleanup();
  appCommandStore(coordinatorLaunchOverrideStore).getState().reset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => undefined);
});

describe("launch override marker on the tab strip", () => {
  test("marks the worker tab whose launch overrode the default, and says what was asked for", async () => {
    answer = {
      overrides: [
        { environmentId: "worker", tabId: "startup-agent", model: "opus", reasoning: "max" },
      ],
    };
    renderTabs([agentTab("startup-agent")]);
    const marker = await screen.findByTestId("tab-launch-override");
    expect(marker.textContent).toBe("requested");
    expect(marker.getAttribute("title")).toBe(
      "This launch uses opus · max. The coordinator overrode the saved default.",
    );
  });

  test("a model-only job override describes the resolved model and inherited effort", async () => {
    // launch_job resolved a requested model with the saved effort before recording it.
    answer = {
      overrides: [{ environmentId: "worker", tabId: "job-tab", model: "opus", reasoning: "high" }],
    };
    renderTabs([agentTab("job-tab")]);
    const marker = await screen.findByTestId("tab-launch-override");
    expect(marker.getAttribute("title")).toBe(
      "This launch uses opus · high. The coordinator overrode the saved default.",
    );
  });

  test("marks a freshly launched native tab whose platform is not known yet", async () => {
    answer = { overrides: [{ environmentId: "worker", tabId: "startup-agent", model: "opus" }] };
    renderTabs([{ id: "startup-agent", type: "agent-native" }]);
    expect(await screen.findByTestId("tab-launch-override")).toBeTruthy();
  });

  test("marks a terminal-mode agent tab too", async () => {
    answer = { overrides: [{ environmentId: "worker", tabId: "startup-agent", model: "opus" }] };
    renderTabs([{ id: "startup-agent", type: "claude" }]);
    expect(await screen.findByTestId("tab-launch-override")).toBeTruthy();
  });

  test("a launch with no selection left to name still says it was an override", async () => {
    answer = { overrides: [{ environmentId: "worker", tabId: "startup-agent" }] };
    renderTabs([agentTab("startup-agent")]);
    expect((await screen.findByTestId("tab-launch-override")).getAttribute("title")).toBe(
      "The coordinator overrode the saved default for this launch.",
    );
  });

  test("a worker launched on the default has no marker, while its sibling tab does", async () => {
    // The backend lists only overrides, so the default launch is the absent row.
    answer = { overrides: [{ environmentId: "worker", tabId: "job-tab", model: "opus" }] };
    const { container } = renderTabs([agentTab("startup-agent"), agentTab("job-tab")]);
    await screen.findByTestId("tab-launch-override");
    const markers = container.querySelectorAll("[data-testid='tab-launch-override']");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.parentElement?.textContent).toContain("Claude 2");
  });

  test("the same tab id in another environment is not marked", async () => {
    answer = { overrides: [{ environmentId: "other", tabId: "startup-agent", model: "opus" }] };
    renderTabs([agentTab("startup-agent")]);
    await waitFor(() => expect(settledReads).toEqual(["answered"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
  });

  test("an agent tab with no delegation shows nothing and its one shared read does not fail", async () => {
    renderTabs([agentTab("user-tab")]);
    await waitFor(() => expect(settledReads).toEqual(["answered"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
    expect(settledReads).not.toContain("failed");
    // No coordinator read is named after the tab's project or environment.
    expect(overrideReads()).toEqual([[COORDINATOR_LAUNCH_OVERRIDES_COMMAND]]);
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "get_project_coordinator",
    );
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "get_project_coordinator_view",
    );
  });

  test("a pane of tabs that cannot be workers never reads", async () => {
    renderTabs([
      { id: "terminal", type: "plain" },
      { id: "file", type: "file", fileData: { filePath: "/w/a.ts" } } as TabInfo,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overrideReads()).toHaveLength(0);
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
  });

  test("many tabs across panes make one read, however many are workers", async () => {
    answer = {
      overrides: [
        { environmentId: "worker", tabId: "tab-3", model: "opus" },
        { environmentId: "worker", tabId: "tab-29", model: "opus" },
      ],
    };
    const tabs = Array.from({ length: 40 }, (_, index) => agentTab(`tab-${index}`));
    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar
          pane={{ kind: "leaf", id: "left", activeTabId: "tab-0", tabs: tabs.slice(0, 20) }}
          environmentId="worker"
          onTabSelect={() => undefined}
        />
        <DraggableTabBar
          pane={{ kind: "leaf", id: "right", activeTabId: "tab-20", tabs: tabs.slice(20) }}
          environmentId="worker"
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );
    await waitFor(() =>
      expect(container.querySelectorAll("[data-testid='tab-launch-override']")).toHaveLength(2),
    );
    expect(overrideReads()).toHaveLength(1);
  });

  test("a backend that predates the read shows nothing and raises nothing", async () => {
    answer = new Error(`Unknown backend command: ${COORDINATOR_LAUNCH_OVERRIDES_COMMAND}`);
    renderTabs([agentTab("startup-agent")]);
    await waitFor(() => expect(settledReads).toEqual(["failed"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
    expect(screen.getByText("Claude 1")).toBeTruthy();
  });
});
