import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PaneLeaf, PaneNode, TabInfo } from "@/types/paneLayout";

const teardownTab = mock(async (_input: unknown) => ({ completed: true }));

const realBackend = await import("@/lib/backend");
const realBackendSnapshot = { ...realBackend };
mock.module("@/lib/backend", () => ({ ...realBackendSnapshot, teardownTab }));
afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { getAllLeaves, paneLayoutStore } = await import("./paneLayoutStore");
const { appCommandStore } = await import("@/test/app-command-store");

const ENV = "env-design";
const design: TabInfo = {
  id: "design-1",
  type: "design-canvas",
  designCanvasData: { canvasId: "00000000-0000-4000-8000-000000000001" },
};
const agent = (id: string, embeddedIn?: string): TabInfo => ({
  id,
  type: "agent-native",
  nativeAgentData: { platform: "claude", environmentId: ENV },
  ...(embeddedIn ? { embeddedIn } : {}),
});
const leaf = (id: string, tabs: TabInfo[], activeTabId = tabs[0]?.id ?? null): PaneLeaf => ({
  kind: "leaf",
  id,
  tabs,
  activeTabId,
});

const store = () => appCommandStore(paneLayoutStore).getState();
const env = () => store().environments.get(ENV)!;
const leaves = () => getAllLeaves(env().root);
const tabIds = () => leaves().map((pane) => pane.tabs.map((tab) => tab.id));

function seed(root: PaneNode, activePaneId = "p1") {
  appCommandStore(paneLayoutStore).setState({
    activeEnvironmentId: ENV,
    hydration: new Map([[ENV, "done"]]),
    environments: new Map([[ENV, { root, activePaneId, containerId: null }]]),
  });
}

beforeEach(() => {
  teardownTab.mockClear();
});

describe("agent tabs embedded in a design tab", () => {
  test("embedding moves the agent into the design's pane and keeps the design selected", () => {
    seed({
      kind: "split",
      id: "s1",
      direction: "horizontal",
      children: [leaf("p1", [agent("agent-1"), agent("other")]), leaf("p2", [design])],
      sizes: [50, 50],
      depth: 1,
    });
    expect(store().setTabEmbedding("agent-1", "design-1", ENV)).toBe(true);
    expect(tabIds()).toEqual([["other"], ["design-1", "agent-1"]]);
    expect(leaves()[1]!.activeTabId).toBe("design-1");
    // A design shows one agent.
    expect(store().setTabEmbedding("other", "design-1", ENV)).toBe(false);
    // Only design tabs host an agent, and only agents are embedded.
    expect(store().setTabEmbedding("other", "agent-1", ENV)).toBe(false);
  });

  test("selecting the embedded agent selects its design and shows the panel", () => {
    seed(leaf("p1", [agent("plain"), design, agent("agent-1", "design-1")], "plain"));
    store().updateDesignAgentPanel("design-1", { open: false }, ENV);
    store().setActiveTab("p1", "agent-1", ENV);
    const pane = leaves()[0]!;
    expect(pane.activeTabId).toBe("design-1");
    expect(pane.tabs.find((tab) => tab.id === "design-1")?.designCanvasData?.agentPanel).toEqual({
      dock: "left",
      open: true,
    });
  });

  test("closing the design closes its agent too, through ordinary teardown", () => {
    seed(leaf("p1", [agent("plain"), design, agent("agent-1", "design-1")], "design-1"));
    store().removeTab("p1", "design-1", ENV);
    expect(tabIds()).toEqual([["plain"]]);
    expect(leaves()[0]!.activeTabId).toBe("plain");
    expect(
      teardownTab.mock.calls.some(([input]) => (input as { tabId?: string }).tabId === "agent-1"),
    ).toBe(true);
  });

  test("moving the design to another pane takes its agent along", () => {
    seed({
      kind: "split",
      id: "s1",
      direction: "horizontal",
      children: [leaf("p1", [design, agent("agent-1", "design-1")]), leaf("p2", [agent("x")])],
      sizes: [50, 50],
      depth: 1,
    });
    store().moveTab("p1", "p2", "design-1", undefined, ENV);
    // The source pane only held the agent, so it closes.
    expect(tabIds()).toEqual([["x", "design-1", "agent-1"]]);
    expect(leaves()[0]!.activeTabId).toBe("design-1");
    expect(teardownTab).not.toHaveBeenCalled();
  });

  test("popping the agent out makes it an ordinary, selected tab", () => {
    seed(leaf("p1", [design, agent("agent-1", "design-1")], "design-1"));
    expect(store().setTabEmbedding("agent-1", null, ENV)).toBe(true);
    const pane = leaves()[0]!;
    expect(pane.tabs.find((tab) => tab.id === "agent-1")?.embeddedIn).toBeUndefined();
    expect(pane.activeTabId).toBe("agent-1");
  });

  test("the panel's dock, size and visibility are kept on the design tab", () => {
    seed(leaf("p1", [design]));
    store().updateDesignAgentPanel("design-1", { dock: "bottom", size: 55 }, ENV);
    store().updateDesignAgentPanel("design-1", { size: 200 }, ENV);
    expect(leaves()[0]!.tabs[0]!.designCanvasData?.agentPanel).toEqual({
      dock: "bottom",
      open: true,
      size: 80,
    });
    store().updateDesignAgentPanel("design-1", { dock: "left", size: undefined }, ENV);
    expect(leaves()[0]!.tabs[0]!.designCanvasData?.agentPanel).toEqual({
      dock: "left",
      open: true,
    });
  });
});
