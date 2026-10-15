import { describe, expect, test } from "bun:test";
import {
  collectCoordinatorLeaves,
  focusCoordinatorPane,
  focusedCoordinatorConversationId,
  moveCoordinatorConversation,
  reconcileCoordinatorLayout,
  reorderCoordinatorConversations,
  resizeCoordinatorSplit,
  revealCoordinatorConversation,
  sanitizeCoordinatorPaneLayout,
  splitCoordinatorPaneAtEdge,
  type CoordinatorPaneLayout,
} from "./coordinator-pane-layout";

import { MAX_SPLIT_DEPTH } from "@/types/paneLayout";

const ids = ["main", "side-1", "side-2"];

function single(): CoordinatorPaneLayout {
  return reconcileCoordinatorLayout(null, ids);
}

function leafIds(layout: CoordinatorPaneLayout): string[][] {
  return collectCoordinatorLeaves(layout.root).map((leaf) => leaf.conversationIds);
}

describe("coordinator pane layout", () => {
  test("starts as one group holding every open conversation in order", () => {
    const layout = single();
    expect(leafIds(layout)).toEqual([ids]);
    expect(focusedCoordinatorConversationId(layout)).toBe("main");
  });

  test("splitting a side agent to the right puts it in its own group beside the main", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);

    expect(split.root.kind).toBe("split");
    if (split.root.kind !== "split") return;
    expect(split.root.direction).toBe("horizontal");
    expect(leafIds(split)).toEqual([["main", "side-2"], ["side-1"]]);
    // The new group is focused with the dragged tab in front.
    expect(focusedCoordinatorConversationId(split)).toBe("side-1");
  });

  test("top and bottom edges split vertically, left and top put the new group first", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const top = splitCoordinatorPaneAtEdge(layout, paneId, "top", "side-2", paneId);
    expect(top.root.kind === "split" && top.root.direction).toBe("vertical");
    expect(leafIds(top)).toEqual([["side-2"], ["main", "side-1"]]);
  });

  test("a lone tab cannot be split off its own group", () => {
    const layout = reconcileCoordinatorLayout(null, ["main"]);
    const paneId = layout.activePaneId;
    expect(splitCoordinatorPaneAtEdge(layout, paneId, "right", "main", paneId)).toBe(layout);
  });

  test("moving the last tab out of a group closes that group", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    const [left, right] = collectCoordinatorLeaves(split.root);

    const merged = moveCoordinatorConversation(split, right!.id, left!.id, "side-1", 1);
    expect(merged.root.kind).toBe("leaf");
    expect(leafIds(merged)).toEqual([["main", "side-1", "side-2"]]);
    expect(merged.activePaneId).toBe(left!.id);
    expect(focusedCoordinatorConversationId(merged)).toBe("side-1");
  });

  test("moving a tab keeps the source group's front tab sensible", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    const [left, right] = collectCoordinatorLeaves(split.root);
    const focused = focusCoordinatorPane(split, left!.id, "side-2");

    const moved = moveCoordinatorConversation(focused, left!.id, right!.id, "side-2");
    expect(leafIds(moved)).toEqual([["main"], ["side-1", "side-2"]]);
    expect(collectCoordinatorLeaves(moved.root)[0]!.activeConversationId).toBe("main");
  });

  test("reorders within a group", () => {
    const layout = single();
    const reordered = reorderCoordinatorConversations(layout, layout.activePaneId, 2, 0);
    expect(leafIds(reordered)).toEqual([["side-2", "main", "side-1"]]);
    expect(reorderCoordinatorConversations(layout, layout.activePaneId, 0, 9)).toBe(layout);
  });

  test("reconciling drops closed conversations and collapses emptied groups", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);

    const closed = reconcileCoordinatorLayout(split, ["main", "side-2"]);
    expect(closed.root.kind).toBe("leaf");
    expect(leafIds(closed)).toEqual([["main", "side-2"]]);
  });

  test("reconciling adds new conversations to the focused group", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);

    const added = reconcileCoordinatorLayout(split, [...ids, "side-3"]);
    expect(leafIds(added)).toEqual([
      ["main", "side-2"],
      ["side-1", "side-3"],
    ]);
  });

  test("reconciling is identity-stable, including with nothing open", () => {
    const layout = single();
    expect(reconcileCoordinatorLayout(layout, ids)).toBe(layout);

    const empty = reconcileCoordinatorLayout(layout, []);
    expect(leafIds(empty)).toEqual([[]]);
    expect(reconcileCoordinatorLayout(empty, [])).toBe(empty);
  });

  test("reconciling removes a conversation listed in two groups", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    const [, right] = collectCoordinatorLeaves(split.root);
    const duplicated: CoordinatorPaneLayout = {
      ...split,
      root:
        split.root.kind === "split"
          ? {
              ...split.root,
              children: [
                split.root.children[0],
                { ...right!, conversationIds: ["side-1", "main"] },
              ],
            }
          : split.root,
    };
    expect(leafIds(reconcileCoordinatorLayout(duplicated, ids))).toEqual([
      ["main", "side-2"],
      ["side-1"],
    ]);
  });

  test("reconciling preserves one copy of a conversation repeated within a leaf", () => {
    const layout = single();
    if (layout.root.kind !== "leaf") throw new Error("expected leaf");
    layout.root.conversationIds = ["main", "main"];
    expect(leafIds(reconcileCoordinatorLayout(layout, ["main"]))).toEqual([["main"]]);
  });

  test("refuses another split at MAX_SPLIT_DEPTH", () => {
    const open = Array.from({ length: MAX_SPLIT_DEPTH + 2 }, (_, index) => `tab-${index}`);
    let layout = reconcileCoordinatorLayout(null, open);
    const paneId = layout.activePaneId;
    for (let index = 0; index < MAX_SPLIT_DEPTH; index += 1) {
      const next = splitCoordinatorPaneAtEdge(layout, paneId, "right", open[index]!, paneId);
      expect(next).not.toBe(layout);
      layout = next;
    }
    expect(splitCoordinatorPaneAtEdge(layout, paneId, "right", open.at(-1)!, paneId)).toBe(layout);
  });

  test("sanitizing deduplicates tabs and rejects repeated leaf or split IDs", () => {
    const layout = single();
    if (layout.root.kind !== "leaf") throw new Error("expected leaf");
    expect(
      sanitizeCoordinatorPaneLayout({
        ...layout,
        root: { ...layout.root, conversationIds: ["main", "main"] },
      })?.root,
    ).toEqual({ ...layout.root, conversationIds: ["main"] });
    const split = splitCoordinatorPaneAtEdge(
      layout,
      layout.activePaneId,
      "right",
      "side-1",
      layout.activePaneId,
    );
    if (split.root.kind !== "split") throw new Error("expected split");
    const [left, right] = split.root.children;
    expect(
      sanitizeCoordinatorPaneLayout({
        ...split,
        root: {
          ...split.root,
          children: [left, { ...right, id: left.id }],
        },
      }),
    ).toBeNull();
    expect(
      sanitizeCoordinatorPaneLayout({
        ...split,
        root: {
          ...split.root,
          children: [left, { ...right, id: split.root.id }],
        },
      }),
    ).toBeNull();
  });

  test("reveal brings a conversation forward in its group and focuses the group", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    const revealed = revealCoordinatorConversation(split, "side-2");
    expect(revealed.activePaneId).toBe(paneId);
    expect(focusedCoordinatorConversationId(revealed)).toBe("side-2");
    expect(revealCoordinatorConversation(revealed, "side-2")).toBe(revealed);
    expect(revealCoordinatorConversation(revealed, "unknown")).toBe(revealed);
  });

  test("resizes a split and ignores a no-op resize", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    if (split.root.kind !== "split") throw new Error("expected split");
    const resized = resizeCoordinatorSplit(split, split.root.id, [70, 30]);
    expect(resized.root.kind === "split" && resized.root.sizes).toEqual([70, 30]);
    expect(resizeCoordinatorSplit(resized, split.root.id, [70, 30])).toBe(resized);
  });

  test("sanitizing keeps a valid persisted layout and rejects malformed ones", () => {
    const layout = single();
    const paneId = layout.activePaneId;
    const split = splitCoordinatorPaneAtEdge(layout, paneId, "right", "side-1", paneId);
    expect(sanitizeCoordinatorPaneLayout(JSON.parse(JSON.stringify(split)))).toEqual(split);

    expect(sanitizeCoordinatorPaneLayout(null)).toBeNull();
    expect(sanitizeCoordinatorPaneLayout({ root: { kind: "split", id: "s" } })).toBeNull();
    expect(
      sanitizeCoordinatorPaneLayout({
        root: { kind: "leaf", id: "p", conversationIds: ["a", 7], activeConversationId: "zzz" },
        activePaneId: "missing",
      }),
    ).toEqual({
      root: { kind: "leaf", id: "p", conversationIds: ["a"], activeConversationId: "a" },
      activePaneId: "p",
    });
  });
});
