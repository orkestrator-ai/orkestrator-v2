import { beforeEach, expect, test } from "bun:test";
import { MAX_REMEMBERED_FLOW_VIEWS, useFlowGraphViewStore } from "./flowGraphViewStore";

beforeEach(() => useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() }));
const view = (zoom = 1) => ({ zoom, scrollLeft: 120, scrollTop: 35, width: 960 });

test("restores independent workflow viewport and collapsed state", () => {
  const store = useFlowGraphViewStore.getState();
  store.saveView("build", view(1.5));
  store.saveView("pass", view(0.75));
  store.setCollapsed("build", true);
  expect(useFlowGraphViewStore.getState().views.get("build")).toEqual(view(1.5));
  expect(useFlowGraphViewStore.getState().views.get("pass")).toEqual(view(0.75));
  expect(useFlowGraphViewStore.getState().collapsed.has("build")).toBe(true);
  expect(useFlowGraphViewStore.getState().collapsed.has("pass")).toBe(false);
  store.setCollapsed("build", false);
  store.clearView("build");
  expect(useFlowGraphViewStore.getState().views.has("build")).toBe(false);
  expect(useFlowGraphViewStore.getState().views.has("pass")).toBe(true);
  expect(useFlowGraphViewStore.getState().collapsed.size).toBe(0);
});

test("evicts the least recently changed view and reinserts a changed save last", () => {
  const store = useFlowGraphViewStore.getState();
  for (let i = 0; i < MAX_REMEMBERED_FLOW_VIEWS; i++) store.saveView(String(i), view());
  store.saveView("0", view(2));
  expect([...useFlowGraphViewStore.getState().views.keys()].at(-1)).toBe("0");
  store.saveView("new", view());
  expect(useFlowGraphViewStore.getState().views.size).toBe(MAX_REMEMBERED_FLOW_VIEWS);
  expect(useFlowGraphViewStore.getState().views.has("1")).toBe(false);
  expect(useFlowGraphViewStore.getState().views.get("0")).toEqual(view(2));
  const unchanged = useFlowGraphViewStore.getState();
  store.saveView("0", view(2));
  expect(useFlowGraphViewStore.getState()).toBe(unchanged);
});

test("bounds collapsed entries and makes a re-collapsed workflow newest", () => {
  const store = useFlowGraphViewStore.getState();
  for (let i = 0; i < MAX_REMEMBERED_FLOW_VIEWS; i++) store.setCollapsed(String(i), true);
  store.setCollapsed("0", false);
  store.setCollapsed("0", true);
  store.setCollapsed("new", true);
  expect(useFlowGraphViewStore.getState().collapsed.size).toBe(MAX_REMEMBERED_FLOW_VIEWS);
  expect(useFlowGraphViewStore.getState().collapsed.has("1")).toBe(false);
  expect(useFlowGraphViewStore.getState().collapsed.has("0")).toBe(true);
});
