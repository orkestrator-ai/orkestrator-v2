import { afterEach, expect, test } from "bun:test";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { getAllLeaves, paneLayoutStore } from "@/stores/paneLayoutStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { PaneNode, TabInfo } from "@/types/paneLayout";
import {
  AUTO_PIPELINE_HANDOFF_TIMEOUT_MS,
  disposeAutoPipelineHandoffs,
  handOffAutoPipelineToBuildTab,
} from "./auto-pipeline-handoff";

const windows: WindowScope[] = [];
afterEach(() => {
  disposeAutoPipelineHandoffs();
  for (const window of windows.splice(0)) window.dispose();
});

const agent: TabInfo = { id: "agent", type: "plain" };
const auto: TabInfo = {
  id: "auto",
  type: "auto-pipeline",
  autoPipelineData: { sourceTabId: "agent" },
};
const build: TabInfo = {
  id: "build-pipeline-1",
  type: "claude-build",
  buildTabData: { environmentId: "env", pipelineId: "pipeline-1", taskId: "task-1" },
};

/** A real pane layout store whose `env` layout is `root`. */
function layoutsWith(root: PaneNode, activePaneId = "pane") {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const scope = windowScope.open({ role: "command", client: new FakeNodeClient() });
  const layouts = scope.store(paneLayoutStore);
  layouts.getState().finishHydration("env", { containerId: null, activePaneId, root });
  return layouts;
}
function leaf(tabs: TabInfo[], activeTabId: string, id = "pane"): PaneNode {
  return { kind: "leaf", id, tabs, activeTabId };
}
function environment(layouts: ReturnType<typeof layoutsWith>) {
  const state = layouts.getState().environments.get("env")!;
  return { state, leaves: getAllLeaves(state.root) };
}
const handOff = (layouts: ReturnType<typeof layoutsWith>, timeoutMs?: number) =>
  handOffAutoPipelineToBuildTab({
    layouts,
    environmentId: "env",
    autoPipelineTabId: "auto",
    pipelineId: "pipeline-1",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

test("the pipeline tab is selected and the Auto-pipeline tab closes", () => {
  const layouts = layoutsWith(leaf([agent, auto, build], "auto"));
  handOff(layouts);
  const [pane] = environment(layouts).leaves;
  expect(pane!.tabs.map((tab) => tab.id)).toEqual(["agent", "build-pipeline-1"]);
  expect(pane!.activeTabId).toBe("build-pipeline-1");
});

test("a pipeline tab that reaches the layout later is still handed off to", () => {
  const layouts = layoutsWith(leaf([agent, auto], "auto"));
  handOff(layouts);
  expect(environment(layouts).leaves[0]!.tabs.map((tab) => tab.id)).toEqual(["agent", "auto"]);
  // The backend's layout, with the pipeline tab it added, arrives afterwards.
  layouts.getState().applyAuthoritativeLayout("env", {
    containerId: null,
    activePaneId: "pane",
    root: leaf([agent, auto, build], "auto"),
  });
  const [pane] = environment(layouts).leaves;
  expect(pane!.tabs.map((tab) => tab.id)).toEqual(["agent", "build-pipeline-1"]);
  expect(pane!.activeTabId).toBe("build-pipeline-1");
});

test("a pipeline tab in another pane takes focus there", () => {
  const layouts = layoutsWith(
    {
      kind: "split",
      id: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [leaf([agent, auto], "auto", "left"), leaf([build], "build-pipeline-1", "right")],
    } as PaneNode,
    "left",
  );
  handOff(layouts);
  const { state, leaves } = environment(layouts);
  expect(state.activePaneId).toBe("right");
  expect(leaves.find((pane) => pane.id === "left")!.tabs.map((tab) => tab.id)).toEqual(["agent"]);
  expect(leaves.find((pane) => pane.id === "right")!.activeTabId).toBe("build-pipeline-1");
});

test("a tab the user chose meanwhile keeps focus; the Auto-pipeline tab still closes", () => {
  const layouts = layoutsWith(leaf([agent, auto, build], "agent"));
  handOff(layouts);
  const [pane] = environment(layouts).leaves;
  expect(pane!.tabs.map((tab) => tab.id)).toEqual(["agent", "build-pipeline-1"]);
  expect(pane!.activeTabId).toBe("agent");
});

test("an Auto-pipeline tab the user already closed leaves the layout alone", () => {
  const layouts = layoutsWith(leaf([agent, build], "agent"));
  handOff(layouts);
  expect(environment(layouts).leaves[0]!.activeTabId).toBe("agent");
});

test("the wait is bounded: without a pipeline tab the Auto-pipeline tab stays open", async () => {
  expect(AUTO_PIPELINE_HANDOFF_TIMEOUT_MS).toBeGreaterThan(0);
  const layouts = layoutsWith(leaf([agent, auto], "auto"));
  handOff(layouts, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  layouts.getState().applyAuthoritativeLayout("env", {
    containerId: null,
    activePaneId: "pane",
    root: leaf([agent, auto, build], "auto"),
  });
  const [pane] = environment(layouts).leaves;
  expect(pane!.tabs.map((tab) => tab.id)).toEqual(["agent", "auto", "build-pipeline-1"]);
  expect(pane!.activeTabId).toBe("auto");
});

test("a second request for the same tab joins the pending one, and stop ends it", () => {
  const layouts = layoutsWith(leaf([agent, auto], "auto"));
  const first = handOff(layouts);
  expect(handOff(layouts)).toBe(first);
  first();
  layouts.getState().applyAuthoritativeLayout("env", {
    containerId: null,
    activePaneId: "pane",
    root: leaf([agent, auto, build], "auto"),
  });
  expect(environment(layouts).leaves[0]!.activeTabId).toBe("auto");
});
