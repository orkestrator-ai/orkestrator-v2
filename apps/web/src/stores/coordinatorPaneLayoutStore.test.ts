import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_REMEMBERED_COORDINATOR_LAYOUTS,
  selectCoordinatorPaneLayout,
  useCoordinatorPaneLayoutStore as store,
} from "./coordinatorPaneLayoutStore";
import {
  focusCoordinatorPane,
  reconcileCoordinatorLayout,
  reorderCoordinatorConversations,
  resizeCoordinatorSplit,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";

const key = store.persist.getOptions().name!;
const single = () => reconcileCoordinatorLayout(null, ["main", "side-1", "side-2"]);
async function hydrate(layouts: unknown) {
  localStorage.setItem(key, JSON.stringify({ state: { layouts }, version: 0 }));
  await store.persist.rehydrate();
}
afterEach(() => {
  store.setState({ layouts: [] });
  localStorage.removeItem(key);
});

describe("coordinator pane layout persistence", () => {
  test("restores isolated projects with group order, active tabs and split sizes", async () => {
    const first = single();
    let split = splitCoordinatorPaneAtEdge(
      first,
      first.activePaneId,
      "right",
      "side-1",
      first.activePaneId,
    );
    if (split.root.kind !== "split") throw new Error("expected split");
    split = resizeCoordinatorSplit(split, split.root.id, [65, 35]);
    split = reorderCoordinatorConversations(split, first.activePaneId, 1, 0);
    split = focusCoordinatorPane(split, first.activePaneId, "side-2");
    store.getState().setLayout("first", split);
    store.getState().setLayout("second", first);
    const persisted = localStorage.getItem(key)!;
    store.setState({ layouts: [] });
    localStorage.setItem(key, persisted);
    await store.persist.rehydrate();
    expect(selectCoordinatorPaneLayout("first")(store.getState())).toEqual(split);
    expect(selectCoordinatorPaneLayout("second")(store.getState())).toEqual(first);
    store.getState().setLayout("second", single());
    expect(selectCoordinatorPaneLayout("first")(store.getState())).toEqual(split);
  });

  test("sanitizes tabs, active IDs and sizes during hydration", async () => {
    const layout = single();
    if (layout.root.kind !== "leaf") throw new Error("expected leaf");
    await hydrate([
      {
        projectId: "p",
        updatedAt: "bad",
        layout: {
          ...layout,
          activePaneId: "missing",
          root: {
            ...layout.root,
            conversationIds: ["main", "main", 12, "", "x".repeat(201)],
            activeConversationId: "missing",
          },
        },
      },
    ]);
    expect(store.getState().layouts).toEqual([
      {
        projectId: "p",
        updatedAt: 0,
        layout: {
          activePaneId: layout.root.id,
          root: { ...layout.root, conversationIds: ["main"], activeConversationId: "main" },
        },
      },
    ]);
  });

  test("rejects malformed records, oversized IDs and trees and bounds tab counts", async () => {
    const layout = single();
    let deep: unknown = layout.root;
    for (let index = 0; index < 20; index += 1) {
      deep = {
        kind: "split",
        id: `split-${index}`,
        direction: "horizontal",
        children: [deep, { kind: "leaf", id: `leaf-${index}`, conversationIds: [] }],
      };
    }
    await hydrate([
      null,
      4,
      {},
      { projectId: 7, layout },
      { projectId: "", layout },
      { projectId: "x".repeat(201), layout },
      { projectId: "bad", layout: { root: { ...layout.root, id: "x".repeat(201) } } },
      { projectId: "deep", layout: { root: deep } },
      {
        projectId: "bounded",
        layout: {
          ...layout,
          root: {
            ...layout.root,
            conversationIds: Array.from({ length: 100 }, (_, index) => `tab-${index}`),
          },
        },
      },
    ]);
    expect(store.getState().layouts).toHaveLength(1);
    const root = store.getState().layouts[0]!.layout.root;
    expect(root.kind === "leaf" && root.conversationIds.length).toBe(64);
    await hydrate({ invalid: true });
    expect(store.getState().layouts).toEqual([]);
  });

  test("retains the latest 50 projects on writes and hydration, refreshing a changed project", async () => {
    const layout = single();
    for (let index = 0; index < 55; index += 1) store.getState().setLayout(`p-${index}`, layout);
    expect(store.getState().layouts).toHaveLength(MAX_REMEMBERED_COORDINATOR_LAYOUTS);
    expect(store.getState().layouts[0]!.projectId).toBe("p-5");
    store.getState().setLayout("p-5", single());
    store.getState().setLayout("new", layout);
    expect(selectCoordinatorPaneLayout("p-6")(store.getState())).toBeUndefined();
    expect(selectCoordinatorPaneLayout("p-5")(store.getState())).toBeDefined();
    await hydrate(
      Array.from({ length: 55 }, (_, index) => ({
        projectId: `p-${index}`,
        layout,
        updatedAt: index,
      })),
    );
    expect(store.getState().layouts).toHaveLength(50);
    expect(store.getState().layouts[0]!.projectId).toBe("p-5");
    expect(store.getState().layouts.at(-1)!.projectId).toBe("p-54");
  });

  test("uses the latest persisted record for duplicate projects", async () => {
    const first = single();
    const second = focusCoordinatorPane(first, first.activePaneId, "side-2");
    await hydrate([
      { projectId: "p", layout: first },
      { projectId: "p", layout: second },
    ]);
    expect(store.getState().layouts).toHaveLength(1);
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(second);
  });

  test("setting the identical layout is a state and notification no-op", () => {
    const layout = single();
    store.getState().setLayout("p", layout);
    const state = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.getState().setLayout("p", layout);
    unsubscribe();
    expect(store.getState()).toBe(state);
    expect(notifications).toBe(0);
  });
});
