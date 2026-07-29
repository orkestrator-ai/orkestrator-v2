import { describe, expect, test } from "bun:test";
import type {
  PaneNode,
  PersistedPaneLayoutInput,
  TabInfo,
} from "@/types/paneLayout";
import {
  isPaneNode,
  mergePersistedPaneLayouts,
} from "./pane-layout-merge";

function leaf(id: string, tabs: string[]): PaneNode {
  return {
    kind: "leaf",
    id,
    tabs: tabs.map((tabId) => ({ id: tabId, type: "plain" })),
    activeTabId: tabs[0] ?? null,
  };
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    kind: "split",
    id: "split",
    direction: "horizontal",
    children: [left, right],
    sizes: [50, 50],
    depth: 1,
  };
}

function input(root: PaneNode): PersistedPaneLayoutInput {
  return {
    version: 1,
    containerId: null,
    activePaneId: root.kind === "leaf" ? root.id : "left",
    root,
  };
}

function tabs(root: unknown): TabInfo[] {
  if (!isPaneNode(root)) throw new Error("invalid test root");
  if (root.kind === "leaf") return root.tabs;
  return [...tabs(root.children[0]), ...tabs(root.children[1])];
}

describe("mergePersistedPaneLayouts", () => {
  test("unions distinct concurrent additions", () => {
    const base = input(leaf("default", ["base"]));
    const local = input(leaf("default", ["base", "local"]));
    const remote = input(leaf("default", ["base", "remote"]));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual([
      "base",
      "remote",
      "local",
    ]);
  });

  test("a deletion wins over a concurrent metadata update", () => {
    const base = input(leaf("default", ["base", "closed"]));
    const local = input(leaf("default", ["base"]));
    const remoteRoot = leaf("default", ["base", "closed"]);
    (remoteRoot as Extract<PaneNode, { kind: "leaf" }>).tabs[1]!.displayTitle =
      "remote rename";

    const merged = mergePersistedPaneLayouts(base, local, input(remoteRoot));

    expect(tabs(merged.root).map(({ id }) => id)).toEqual(["base"]);
  });

  test("merges independent concurrent fields on the same native tab", () => {
    const baseTab: TabInfo = {
      id: "native",
      type: "codex-native",
      initialAgentModel: "gpt-5.6-sol",
      displayTitle: "Original",
      codexNativeData: {
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: "session-old",
      },
    };
    const makeInput = (tab: TabInfo) => input({
      kind: "leaf",
      id: "default",
      tabs: [tab],
      activeTabId: tab.id,
    });
    const { initialAgentModel: _consumed, ...localTab } = baseTab;
    const remoteTab: TabInfo = {
      ...baseTab,
      displayTitle: "Remote title",
      codexNativeData: {
        ...baseTab.codexNativeData!,
        sessionId: "session-new",
      },
    };

    const merged = mergePersistedPaneLayouts(
      makeInput(baseTab),
      makeInput(localTab),
      makeInput(remoteTab),
    );

    expect(tabs(merged.root)).toEqual([{
      id: "native",
      type: "codex-native",
      displayTitle: "Remote title",
      codexNativeData: {
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: "session-new",
      },
    }]);
  });

  test("a remote deletion wins over a local move", () => {
    const base = input(split(leaf("left", ["base", "moving"]), leaf("right", ["stay"])));
    const local = input(split(leaf("left", ["base"]), leaf("right", ["stay", "moving"])));
    const remote = input(split(leaf("left", ["base"]), leaf("right", ["stay"])));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual(["base", "stay"]);
  });

  test("replays a local move while retaining a remote-only addition", () => {
    const base = input(split(leaf("left", ["base", "moving"]), leaf("right", ["stay"])));
    const local = input(split(leaf("left", ["base"]), leaf("right", ["moving", "stay"])));
    const remote = input(split(
      leaf("left", ["base", "moving", "remote"]),
      leaf("right", ["stay"]),
    ));

    const merged = mergePersistedPaneLayouts(base, local, remote);
    expect(merged.root).toMatchObject({
      children: [
        { id: "left", tabs: [{ id: "base" }, { id: "remote" }] },
        { id: "right", tabs: [{ id: "moving" }, { id: "stay" }] },
      ],
    });
  });

  test("preserves a remote reorder when a local cross-pane move shifts indexes", () => {
    const base = input(split(
      leaf("left", ["x", "y"]),
      leaf("right", ["a", "b", "c"]),
    ));
    const local = input(split(
      leaf("left", ["y"]),
      leaf("right", ["x", "a", "b", "c"]),
    ));
    const remote = input(split(
      leaf("left", ["x", "y"]),
      leaf("right", ["c", "a", "b"]),
    ));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(merged.root).toMatchObject({
      children: [
        { id: "left", tabs: [{ id: "y" }] },
        {
          id: "right",
          tabs: [
            { id: "c" },
            { id: "x" },
            { id: "a" },
            { id: "b" },
          ],
        },
      ],
    });
  });

  test("preserves a remote reorder when a local deletion shifts indexes", () => {
    const base = input(leaf("default", ["x", "a", "b", "c"]));
    const local = input(leaf("default", ["a", "b", "c"]));
    const remote = input(leaf("default", ["x", "c", "a", "b"]));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });

  test("keeps remote topology when only the remote side split panes", () => {
    const base = input(leaf("default", ["base"]));
    const local = input(leaf("default", ["base", "local"]));
    const remote = input(split(leaf("left", ["base"]), leaf("right", ["remote"])));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(merged.root).toMatchObject({
      kind: "split",
      children: [
        { tabs: [{ id: "base" }, { id: "local" }] },
        { tabs: [{ id: "remote" }] },
      ],
    });
  });

  test("rejects malformed roots instead of guessing at a merge", () => {
    const valid = input(leaf("default", ["base"]));
    expect(() =>
      mergePersistedPaneLayouts(
        valid,
        valid,
        {
          ...valid,
          root: { kind: "leaf" },
        } as unknown as PersistedPaneLayoutInput,
      )
    ).toThrow("malformed");
  });
});
