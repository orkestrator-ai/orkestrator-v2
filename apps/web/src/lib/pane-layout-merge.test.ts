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

  test("converges concurrent additions with the same logical tab id", () => {
    const base = input(leaf("default", ["setup"]));
    const local = input(leaf("default", ["setup", "startup-agent"]));
    const remote = input(leaf("default", ["setup", "startup-agent"]));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual([
      "setup",
      "startup-agent",
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
    const malformed = (root: unknown) =>
      ({ ...valid, root }) as unknown as PersistedPaneLayoutInput;

    // Every side is a trust boundary: base and local come from this renderer's
    // own mirror, remote straight off disk.
    expect(() =>
      mergePersistedPaneLayouts(valid, valid, malformed({ kind: "leaf" }))
    ).toThrow("malformed");
    expect(() =>
      mergePersistedPaneLayouts(malformed({ kind: "leaf" }), valid, valid)
    ).toThrow("malformed");
    expect(() =>
      mergePersistedPaneLayouts(valid, malformed({ kind: "leaf" }), valid)
    ).toThrow("malformed");
  });

  test("returns the other side untouched when only one side moved", () => {
    const base = input(leaf("default", ["base"]));
    const local = input(leaf("default", ["base", "local"]));
    const remote = input(leaf("default", ["base", "remote"]));

    // An unchanged local side means this write is a no-op edit racing a real
    // remote one; adopting remote wholesale is what stops it being clobbered.
    expect(mergePersistedPaneLayouts(base, base, remote)).toEqual(remote);
    expect(mergePersistedPaneLayouts(base, local, base)).toEqual(local);
  });

  test("the retrying renderer wins a genuinely conflicting scalar edit", () => {
    const baseTab: TabInfo = {
      id: "native",
      type: "claude-native",
      displayTitle: "Original",
      claudeNativeData: {
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: "session-base",
      },
    };
    const makeInput = (tab: TabInfo) => input({
      kind: "leaf",
      id: "default",
      tabs: [tab],
      activeTabId: tab.id,
    });

    const merged = mergePersistedPaneLayouts(
      makeInput(baseTab),
      makeInput({ ...baseTab, displayTitle: "Local title" }),
      makeInput({ ...baseTab, displayTitle: "Remote title" }),
    );

    // Documented tie-break: neither value is more correct, and the renderer
    // performing the retry is the one the user is looking at.
    expect(tabs(merged.root)[0]!.displayTitle).toBe("Local title");
  });

  test("compares array-valued tab fields element-wise rather than by identity", () => {
    const baseTab: TabInfo = {
      id: "terminal",
      type: "plain",
      initialCommands: ["one", "two"],
    };
    const makeInput = (tab: TabInfo) => input({
      kind: "leaf",
      id: "default",
      tabs: [tab],
      activeTabId: tab.id,
    });

    // Local re-created an equal array, so it did not change relative to base
    // and the remote edit must survive.
    const remoteWins = mergePersistedPaneLayouts(
      makeInput(baseTab),
      makeInput({ ...baseTab, initialCommands: ["one", "two"] }),
      makeInput({ ...baseTab, initialCommands: ["remote"] }),
    );
    expect(tabs(remoteWins.root)[0]!.initialCommands).toEqual(["remote"]);

    // A different length is a real local change, so the tie-break applies.
    const localWins = mergePersistedPaneLayouts(
      makeInput(baseTab),
      makeInput({ ...baseTab, initialCommands: ["one"] }),
      makeInput({ ...baseTab, initialCommands: ["remote"] }),
    );
    expect(tabs(localWins.root)[0]!.initialCommands).toEqual(["one"]);
  });

  test("replays a local reorder over an untouched remote pane", () => {
    // A pure within-pane reorder is only detectable by the longest-common-
    // subsequence pass: nothing changed pane, so no tab looks "moved" by
    // location alone.
    const base = input(leaf("default", ["a", "b", "c", "d"]));
    const local = input(leaf("default", ["d", "a", "b", "c"]));
    const remote = input(leaf("default", ["a", "b", "c", "d", "remote"]));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual([
      "d",
      "a",
      "b",
      "c",
      "remote",
    ]);
  });

  test("replays a local reorder that moves several tabs at once", () => {
    const base = input(leaf("default", ["a", "b", "c", "d", "e"]));
    const local = input(leaf("default", ["c", "a", "e", "b", "d"]));
    const remote = input(leaf("default", ["a", "b", "c", "d", "e"]));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(tabs(merged.root).map(({ id }) => id)).toEqual([
      "c",
      "a",
      "e",
      "b",
      "d",
    ]);
  });

  test("keeps local topology and grafts surviving remote tabs when both split", () => {
    const base = input(leaf("default", ["base"]));
    const local = input(split(leaf("left", ["base"]), leaf("local-pane", ["local"])));
    const remote = input(split(
      leaf("remote-a", ["base"]),
      leaf("remote-b", ["remote"]),
    ));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    // Local topology wins the tie, so "remote-b" does not exist here. Its tab
    // still has to land somewhere rather than being silently dropped.
    expect(merged.root).toMatchObject({
      kind: "split",
      children: [
        { id: "left", tabs: [{ id: "remote" }, { id: "base" }] },
        { id: "local-pane", tabs: [{ id: "local" }] },
      ],
    });
    expect(tabs(merged.root).map(({ id }) => id).sort()).toEqual([
      "base",
      "local",
      "remote",
    ]);
  });

  test("canonicalizes selection and takes identity from the local side", () => {
    const base = input(leaf("default", ["base"]));
    const localRoot = split(leaf("left", ["base", "local"]), leaf("right", ["only"]));
    const local: PersistedPaneLayoutInput = {
      version: 1,
      containerId: "container-1",
      activePaneId: "right",
      root: localRoot,
    };
    const remote: PersistedPaneLayoutInput = {
      version: 1,
      containerId: "container-1",
      activePaneId: "default",
      root: leaf("default", ["base", "remote"]),
    };
    // Selection is renderer-local, so a merge must emit the same canonical
    // pointers `createPersistedPaneLayoutInput` writes — never another
    // client's focus.
    (localRoot as Extract<PaneNode, { kind: "split" }>).children[0] = {
      ...(localRoot as Extract<PaneNode, { kind: "split" }>).children[0],
      activeTabId: "local",
    } as PaneNode;

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(merged.version).toBe(local.version);
    expect(merged.containerId).toBe("container-1");
    // Both pointers are the canonical "first" the shared record always carries,
    // not the local side's "right"/"local" nor the remote side's "default".
    expect(merged.activePaneId).toBe("left");
    const children = (merged.root as Extract<PaneNode, { kind: "split" }>).children;
    for (const child of children) {
      const pane = child as Extract<PaneNode, { kind: "leaf" }>;
      expect(pane.activeTabId).toBe(pane.tabs[0]!.id);
    }
  });

  test("leaves an emptied pane with a null selection", () => {
    const base = input(split(leaf("left", ["gone"]), leaf("right", ["stay"])));
    const local = input(split(leaf("left", ["gone"]), leaf("right", ["stay"])));
    const remote = input(split(leaf("left", []), leaf("right", ["stay"])));

    const merged = mergePersistedPaneLayouts(base, local, remote);

    expect(merged.root).toMatchObject({
      children: [
        { id: "left", tabs: [], activeTabId: null },
        { id: "right", activeTabId: "stay" },
      ],
    });
  });
});

describe("isPaneNode", () => {
  const validLeaf = leaf("default", ["tab"]);

  test("accepts the shapes the restore path produces", () => {
    expect(isPaneNode(validLeaf)).toBe(true);
    expect(isPaneNode({ ...validLeaf, tabs: [], activeTabId: null })).toBe(true);
    expect(isPaneNode(split(validLeaf, leaf("other", ["b"])))).toBe(true);
  });

  test("rejects anything that is not a node object", () => {
    expect(isPaneNode(null)).toBe(false);
    expect(isPaneNode(undefined)).toBe(false);
    expect(isPaneNode(0)).toBe(false);
    expect(isPaneNode("leaf")).toBe(false);
    expect(isPaneNode(true)).toBe(false);
    expect(isPaneNode([validLeaf])).toBe(false);
    expect(isPaneNode({})).toBe(false);
  });

  test("rejects a node without a usable id or kind", () => {
    expect(isPaneNode({ ...validLeaf, id: undefined })).toBe(false);
    expect(isPaneNode({ ...validLeaf, id: "" })).toBe(false);
    expect(isPaneNode({ ...validLeaf, id: 7 })).toBe(false);
    expect(isPaneNode({ ...validLeaf, kind: "pane" })).toBe(false);
    expect(isPaneNode({ ...validLeaf, kind: undefined })).toBe(false);
  });

  test("rejects a leaf whose tabs or selection are malformed", () => {
    expect(isPaneNode({ ...validLeaf, tabs: undefined })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: {} })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: [null] })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: [["id", "type"]] })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: [{ type: "plain" }] })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: [{ id: "tab" }] })).toBe(false);
    expect(isPaneNode({ ...validLeaf, tabs: [{ id: 1, type: "plain" }] })).toBe(false);
    expect(isPaneNode({ ...validLeaf, activeTabId: 5 })).toBe(false);
    expect(isPaneNode({ ...validLeaf, activeTabId: undefined })).toBe(false);
  });

  test("rejects a split with the wrong direction, arity, or children", () => {
    const validSplit = split(validLeaf, leaf("other", ["b"]));
    expect(isPaneNode({ ...validSplit, direction: "diagonal" })).toBe(false);
    expect(isPaneNode({ ...validSplit, direction: undefined })).toBe(false);
    expect(isPaneNode({ ...validSplit, children: [validLeaf] })).toBe(false);
    expect(isPaneNode({
      ...validSplit,
      children: [validLeaf, validLeaf, validLeaf],
    })).toBe(false);
    expect(isPaneNode({ ...validSplit, children: {} })).toBe(false);
    expect(isPaneNode({
      ...validSplit,
      children: [validLeaf, { kind: "leaf" }],
    })).toBe(false);
  });

  test("rejects sizes that are missing, mis-shaped, or not finite", () => {
    const validSplit = split(validLeaf, leaf("other", ["b"]));
    expect(isPaneNode({ ...validSplit, sizes: undefined })).toBe(false);
    expect(isPaneNode({ ...validSplit, sizes: [50] })).toBe(false);
    expect(isPaneNode({ ...validSplit, sizes: [50, 30, 20] })).toBe(false);
    expect(isPaneNode({ ...validSplit, sizes: ["50", "50"] })).toBe(false);
    // A NaN or Infinity size survives JSON round-tripping as null, but a
    // hand-edited or in-memory record can still carry one, and it would make
    // every downstream size calculation silently produce NaN.
    expect(isPaneNode({ ...validSplit, sizes: [Number.NaN, 50] })).toBe(false);
    expect(isPaneNode({ ...validSplit, sizes: [50, Number.POSITIVE_INFINITY] })).toBe(false);
  });

  test("stops descending before an unbounded nesting depth", () => {
    const nest = (depth: number): PaneNode => {
      let node: PaneNode = leaf("deepest", ["tab"]);
      for (let level = 0; level < depth; level += 1) {
        node = split(node, leaf(`sibling-${level}`, [`tab-${level}`]));
      }
      return node;
    };

    // MAX_SPLIT_DEPTH is 9, so a tree the restore path accepts always fits.
    expect(isPaneNode(nest(9))).toBe(true);
    expect(isPaneNode(nest(11))).toBe(false);
  });
});
