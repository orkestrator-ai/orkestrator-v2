import { describe, expect, test } from "bun:test";
import type { DesignHierarchyPage, DesignLayer } from "@orkestrator/protocol/design-canvas";
import {
  ancestorBranches,
  applyPage,
  autoExpandOnce,
  beginLoad,
  canAppend,
  createLayerTree,
  failLoad,
  filterLoadedRows,
  flattenRows,
  loadedTotals,
  MAX_FILTER_RESULTS,
  MAX_LOADED_BYTES,
  MAX_LOADED_ROWS,
  pendingLoads,
  resetFrame,
  revealPath,
  ROOT_BRANCH,
  setExpanded,
  syncFrameKeys,
  type LayerTreeState,
} from "./design-layer-model";

function layers(parent: string, count: number, start = 0, childCount = 0): DesignLayer[] {
  return Array.from({ length: count }, (_, index) => ({
    selector: `${parent} > :nth-child(${start + index + 1})`,
    tag: "div",
    label: `item-${start + index + 1}`,
    depth: 1,
    childCount,
  }));
}

function page(items: DesignLayer[], extra: Partial<DesignHierarchyPage> = {}): DesignHierarchyPage {
  return { layers: items, total: items.length, truncated: false, bytes: 0, ...extra };
}

function load(
  state: LayerTreeState,
  frameId: string,
  branch: string,
  items: DesignLayer[],
  extra: Partial<DesignHierarchyPage> = {},
  append = false,
): LayerTreeState {
  const started = beginLoad(state, frameId, branch, append);
  expect(started.request).not.toBeNull();
  return applyPage(started.state, started.request!, page(items, extra));
}

const ready = () => "ready" as const;

describe("design layer model", () => {
  test("closed frame roots need no hierarchy request", () => {
    const state = syncFrameKeys(createLayerTree(), [
      ["a", "s1"],
      ["b", "s1"],
    ]);
    expect(pendingLoads(state, ["a", "b"], ready)).toEqual([]);
    expect(flattenRows(state, ["a", "b"], ready).map((row) => row.kind)).toEqual([
      "frame",
      "frame",
    ]);
  });

  test("expanding a root requests it; loading and collapsing are reflected in rows", () => {
    let state = syncFrameKeys(createLayerTree(), [["a", "s1"]]);
    state = setExpanded(state, "a", ROOT_BRANCH, true);
    expect(pendingLoads(state, ["a"], ready)).toEqual([{ frameId: "a", branch: ROOT_BRANCH }]);
    expect(pendingLoads(state, ["a"], () => "unavailable")).toEqual([]);
    expect(flattenRows(state, ["a"], () => "unavailable")[1]).toMatchObject({
      kind: "status",
      state: "unavailable",
      message: "Bring into view to load layers",
    });
    state = load(state, "a", ROOT_BRANCH, layers("body", 2, 0, 3));
    const rows = flattenRows(state, ["a"], ready);
    expect(rows.map((row) => row.kind)).toEqual(["frame", "layer", "layer"]);
    expect(rows[1]).toMatchObject({
      level: 2,
      expandable: true,
      expanded: false,
      posinset: 1,
      setsize: 2,
    });
    state = setExpanded(state, "a", "body > :nth-child(1)", true);
    expect(pendingLoads(state, ["a"], ready)).toEqual([
      { frameId: "a", branch: "body > :nth-child(1)" },
    ]);
    state = load(state, "a", "body > :nth-child(1)", layers("body > :nth-child(1)", 3));
    expect(flattenRows(state, ["a"], ready).filter((row) => row.level === 3)).toHaveLength(3);
    state = setExpanded(state, "a", ROOT_BRANCH, false);
    expect(flattenRows(state, ["a"], ready)).toHaveLength(1);
  });

  test("load more appends pages, dedupes, and exposes counts", () => {
    let state = setExpanded(
      syncFrameKeys(createLayerTree(), [["a", "s1"]]),
      "a",
      ROOT_BRANCH,
      true,
    );
    state = load(state, "a", ROOT_BRANCH, layers("body", 200), {
      total: 450,
      truncated: true,
      nextCursor: "fp:200",
    });
    let more = flattenRows(state, ["a"], ready).at(-1)!;
    expect(more).toMatchObject({ kind: "more", loaded: 200, total: 450, limited: false });
    const started = beginLoad(state, "a", ROOT_BRANCH, true);
    expect(started.request?.cursor).toBe("fp:200");
    expect(beginLoad(started.state, "a", ROOT_BRANCH, true).request).toBeNull();
    state = applyPage(
      started.state,
      started.request!,
      // One duplicate of an already-loaded row is dropped rather than rendered twice.
      page([...layers("body", 1, 199), ...layers("body", 199, 200)], {
        total: 450,
        nextCursor: "fp:399",
      }),
    );
    more = flattenRows(state, ["a"], ready).at(-1)!;
    expect(more).toMatchObject({ kind: "more", loaded: 399, total: 450 });
    state = load(state, "a", ROOT_BRANCH, layers("body", 51, 399), { total: 450 }, true);
    const rows = flattenRows(state, ["a"], ready);
    expect(rows.filter((row) => row.kind === "layer")).toHaveLength(450);
    expect(rows.some((row) => row.kind === "more")).toBe(false);
  });

  test("structure change drops cached branches and ignores old responses", () => {
    let state = setExpanded(
      syncFrameKeys(createLayerTree(), [["a", "s1"]]),
      "a",
      ROOT_BRANCH,
      true,
    );
    state = load(state, "a", ROOT_BRANCH, layers("body", 3, 0, 2));
    state = setExpanded(state, "a", "body > :nth-child(2)", true);
    const inflight = beginLoad(state, "a", "body > :nth-child(2)", false);
    state = syncFrameKeys(inflight.state, [["a", "s2"]]);
    expect(state.frames.a!.epoch).toBe(1);
    expect(state.frames.a!.branches).toEqual({});
    expect(applyPage(state, inflight.request!, page(layers("body > :nth-child(2)", 2)))).toBe(
      state,
    );
    expect(failLoad(state, inflight.request!, "boom")).toBe(state);
    // Expanded intent survives and is reloaded from the root first; no old paths are merged.
    expect(pendingLoads(state, ["a"], ready)).toEqual([{ frameId: "a", branch: ROOT_BRANCH }]);
    expect(flattenRows(state, ["a"], ready).map((row) => row.kind)).toEqual(["frame", "status"]);
    expect(syncFrameKeys(state, [["a", "s2"]])).toBe(state);
  });

  test("resetFrame invalidates cursors and superseded requests", () => {
    let state = setExpanded(
      syncFrameKeys(createLayerTree(), [["a", "s1"]]),
      "a",
      ROOT_BRANCH,
      true,
    );
    state = load(state, "a", ROOT_BRANCH, layers("body", 200), {
      total: 300,
      nextCursor: "old:200",
    });
    const more = beginLoad(state, "a", ROOT_BRANCH, true);
    state = resetFrame(more.state, "a");
    expect(applyPage(state, more.request!, page(layers("body", 100, 200)))).toBe(state);
    const fresh = beginLoad(state, "a", ROOT_BRANCH, false);
    expect(fresh.request?.cursor).toBeUndefined();
  });

  test("removed frames are dropped", () => {
    const state = syncFrameKeys(createLayerTree(), [
      ["a", "s1"],
      ["b", "s1"],
    ]);
    expect(Object.keys(syncFrameKeys(state, [["b", "s1"]]).frames)).toEqual(["b"]);
  });

  test("errors are shown and only retryable first pages are retried after a render", () => {
    let state = setExpanded(
      syncFrameKeys(createLayerTree(), [["a", "s1"]]),
      "a",
      ROOT_BRANCH,
      true,
    );
    const started = beginLoad(state, "a", ROOT_BRANCH, false);
    state = failLoad(started.state, started.request!, "Could not load layers: nope");
    expect(flattenRows(state, ["a"], ready)[1]).toMatchObject({ kind: "status", state: "error" });
    expect(pendingLoads(state, ["a"], ready, true)).toEqual([]);
    const again = beginLoad(state, "a", ROOT_BRANCH, false);
    state = failLoad(again.state, again.request!, "stale", true);
    expect(pendingLoads(state, ["a"], ready, false)).toEqual([]);
    expect(pendingLoads(state, ["a"], ready, true)).toEqual([
      { frameId: "a", branch: ROOT_BRANCH },
    ]);
  });

  test("eviction keeps rows and bytes bounded, evicting collapsed branches first", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `f${index}`);
    let state = syncFrameKeys(
      createLayerTree(),
      ids.map((id) => [id, "s"] as const),
    );
    for (const id of ids) {
      state = setExpanded(state, id, ROOT_BRANCH, true);
      state = load(state, id, ROOT_BRANCH, layers("body", 200));
      if (id === "f0") state = setExpanded(state, "f0", ROOT_BRANCH, false);
      const totals = loadedTotals(state);
      expect(totals.rows).toBeLessThanOrEqual(MAX_LOADED_ROWS);
      expect(totals.bytes).toBeLessThanOrEqual(MAX_LOADED_BYTES);
    }
    // f0 was collapsed, so it went first even though f1 is equally old.
    expect(state.frames.f0!.branches[ROOT_BRANCH]).toBeUndefined();
    expect(state.frames.f11!.branches[ROOT_BRANCH]?.layers).toHaveLength(200);
    // A visible branch that had to go is collapsed so it is not immediately refetched.
    const evictedVisible = ids.slice(1).filter((id) => !state.frames[id]!.branches[ROOT_BRANCH]);
    expect(evictedVisible.length).toBeGreaterThan(0);
    for (const id of evictedVisible)
      expect(state.frames[id]!.expanded[ROOT_BRANCH]).toBeUndefined();
    expect(pendingLoads(state, ids, ready)).toEqual([]);
  });

  test("a single branch cannot page past the loaded-row bound", () => {
    let state = setExpanded(syncFrameKeys(createLayerTree(), [["a", "s"]]), "a", ROOT_BRANCH, true);
    state = load(state, "a", ROOT_BRANCH, layers("body", 200), {
      total: 5000,
      nextCursor: "c:200",
    });
    for (let pageIndex = 1; pageIndex < 10; pageIndex++) {
      const branch = state.frames.a!.branches[ROOT_BRANCH]!;
      if (!canAppend(branch)) break;
      state = load(
        state,
        "a",
        ROOT_BRANCH,
        layers("body", 200, pageIndex * 200),
        {
          total: 5000,
          nextCursor: `c:${(pageIndex + 1) * 200}`,
        },
        true,
      );
    }
    expect(loadedTotals(state).rows).toBe(MAX_LOADED_ROWS);
    expect(beginLoad(state, "a", ROOT_BRANCH, true).request).toBeNull();
    expect(flattenRows(state, ["a"], ready).at(-1)).toMatchObject({
      kind: "more",
      limited: true,
      loaded: 2000,
    });
  });

  test("sanitizes page content and bounds labels", () => {
    let state = setExpanded(syncFrameKeys(createLayerTree(), [["a", "s"]]), "a", ROOT_BRANCH, true);
    const started = beginLoad(state, "a", ROOT_BRANCH, false);
    state = applyPage(started.state, started.request!, {
      layers: [
        { selector: "body > :nth-child(1)", tag: "h1", label: "x".repeat(500), depth: 1 },
        { selector: "", tag: "p", label: "bad", depth: 1 },
        null as unknown as DesignLayer,
      ],
      total: 3,
      truncated: false,
      bytes: 0,
      nextCursor: "c".repeat(1000),
    });
    const branch = state.frames.a!.branches[ROOT_BRANCH]!;
    expect(branch.layers).toHaveLength(1);
    expect(branch.layers[0]!.label).toHaveLength(100);
    expect(branch.nextCursor).toBeUndefined();
    expect(branch.truncated).toBe(true);
  });

  test("reveal and auto-expand helpers", () => {
    expect(ancestorBranches("body > :nth-child(2) > :nth-child(1)")).toEqual([
      "body",
      "body > :nth-child(2)",
    ]);
    expect(ancestorBranches("html > :nth-child(1)")).toEqual([]);
    let state = syncFrameKeys(createLayerTree(), [["a", "s"]]);
    state = revealPath(state, "a", "body > :nth-child(2) > :nth-child(1)");
    expect(Object.keys(state.frames.a!.expanded).sort()).toEqual(["body", "body > :nth-child(2)"]);
    state = syncFrameKeys(createLayerTree(), [["a", "s"]]);
    state = autoExpandOnce(state, "a");
    state = setExpanded(state, "a", ROOT_BRANCH, false);
    expect(autoExpandOnce(state, "a")).toBe(state);
  });

  test("filter searches only loaded rows, bounded", () => {
    let state = setExpanded(
      syncFrameKeys(createLayerTree(), [
        ["a", "s"],
        ["b", "s"],
      ]),
      "a",
      ROOT_BRANCH,
      true,
    );
    state = load(state, "a", ROOT_BRANCH, layers("body", 3, 0, 1));
    state = load(state, "a", "body > :nth-child(1)", [
      {
        selector: "body > :nth-child(1) > :nth-child(1)",
        tag: "h1",
        label: "title",
        depth: 1,
        childCount: 0,
      },
    ]);
    // Loaded but collapsed branches are still searched.
    state = setExpanded(state, "a", "body > :nth-child(1)", false);
    const result = filterLoadedRows(state, ["a", "b"], "TIT");
    expect(result.matches).toBe(1);
    expect(result.searched).toBe(4);
    expect(result.rows.map((row) => row.kind)).toEqual(["frame", "layer"]);
    state = setExpanded(state, "b", ROOT_BRANCH, true);
    state = load(state, "b", ROOT_BRANCH, layers("body", 200), { nextCursor: "c:200" });
    for (let index = 1; index < 4; index++)
      state = load(
        state,
        "b",
        ROOT_BRANCH,
        layers("body", 200, index * 200),
        { nextCursor: `c:${index}` },
        true,
      );
    const many = filterLoadedRows(state, ["a", "b"], "item");
    expect(many.matches).toBe(MAX_FILTER_RESULTS);
    expect(many.limited).toBe(true);
    expect(many.rows.filter((row) => row.kind === "layer")).toHaveLength(MAX_FILTER_RESULTS);
  });
});
