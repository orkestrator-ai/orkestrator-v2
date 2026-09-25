import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DesignFrame,
  DesignHierarchyPage,
  DesignOperation,
} from "@orkestrator/protocol/design-canvas";
import type { DesignFrameMeta } from "@orkestrator/protocol/design-operations";
import {
  DesignLayerTree,
  type DesignLayerTreeProps,
  type HierarchyLoader,
} from "./DesignLayerTree";
import type { DesignFrameBridge } from "./frame-bridge";

afterEach(cleanup);

type Spec = Record<string, Array<{ label: string; tag?: string; children?: number }>>;

/** Children of `branch` paged like the runtime: 200 per page, cursor bound to a fingerprint. */
function pageFor(
  spec: Spec,
  fingerprint: string,
  rootSelector = "body",
  cursor?: string,
): DesignHierarchyPage {
  const children = spec[rootSelector] ?? [];
  let offset = 0;
  if (cursor) {
    const [expected, value] = cursor.split(":");
    if (expected !== fingerprint) throw new Error("Hierarchy changed; reload this branch");
    offset = Number(value);
  }
  const slice = children.slice(offset, offset + 200);
  const end = offset + slice.length;
  return {
    layers: slice.map((child, index) => ({
      selector: `${rootSelector} > :nth-child(${offset + index + 1})`,
      tag: child.tag ?? "div",
      label: child.label,
      depth: 1,
      childCount: child.children ?? 0,
    })),
    total: children.length,
    truncated: end < children.length,
    bytes: 0,
    ...(end < children.length ? { nextCursor: `${fingerprint}:${end}` } : {}),
  };
}

function fakeBridge(contentId: string, spec: Spec, fingerprint = "fp") {
  const ask = mock(async (operation: DesignOperation) => {
    if (operation.op !== "hierarchyPage") throw new Error("unexpected op");
    return pageFor(spec, fingerprint, operation.rootSelector, operation.cursor);
  });
  const bridge = {
    renderedContentId: contentId,
    closed: false,
    ask,
  } as unknown as DesignFrameBridge;
  return { bridge, ask };
}

function frame(id: string, name = id, revision = 1): DesignFrame {
  return { id, name, x: 0, y: 0, width: 400, height: 300, html: "", revision };
}

function meta(
  frameId: string,
  structureId: string,
  contentId = `c-${structureId}`,
  state: "valid" | "invalid" = "valid",
): DesignFrameMeta {
  return {
    contentId,
    structureId,
    viewportId: "v1",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    validation: {
      frameId,
      contentId,
      runtimeVersion: 1,
      state,
      reasons: [],
      truncated: false,
      elementCount: 7,
    },
  };
}

function setup(overrides: Partial<DesignLayerTreeProps> = {}) {
  const callbacks = {
    onFocusFrame: mock((_frameId: string) => {}),
    onSelectElement: mock((_frameId: string, _selector: string) => {}),
    onFrameAction: mock((_frameId: string, _action: string) => {}),
  };
  const props: DesignLayerTreeProps = {
    environmentId: "env",
    canvasId: "canvas",
    frames: [],
    metas: {},
    legacy: false,
    getBridge: () => undefined,
    liveFrames: new Set(),
    renderedVersion: 0,
    selection: null,
    focusedFrameId: null,
    loadHierarchy: mock(async () => {
      throw new Error("backend not expected");
    }),
    ...callbacks,
    ...overrides,
  };
  const view = render(<DesignLayerTree {...props} />);
  const rerender = (next: Partial<DesignLayerTreeProps>) => {
    Object.assign(props, next);
    view.rerender(<DesignLayerTree {...props} />);
  };
  return { ...callbacks, props, rerender };
}

const flush = () => act(async () => {});

function treeItem(name: string) {
  return screen.getByRole("treeitem", { name });
}

describe("DesignLayerTree", () => {
  test("renders the hierarchy landmark and auto-expands a live frame on a small canvas", async () => {
    const { bridge, ask } = fakeBridge("c-s1", {
      body: [{ label: "title", tag: "h1" }, { label: "target" }],
    });
    const { onSelectElement } = setup({
      frames: [frame("f1", "Homepage")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    const nav = screen.getByRole("navigation", { name: "Design hierarchy" });
    expect(within(nav).getByRole("heading", { name: "Layers" })).toBeTruthy();
    expect(within(nav).getByRole("tree")).toBeTruthy();
    const title = await screen.findByRole("button", { name: "title" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toEqual({ op: "hierarchyPage", maxNodes: 200, maxDepth: 1 });
    const item = treeItem("title (h1)");
    expect(item.getAttribute("aria-level")).toBe("2");
    expect(item.getAttribute("aria-setsize")).toBe("2");
    expect(item.getAttribute("aria-posinset")).toBe("1");
    fireEvent.click(title);
    expect(onSelectElement).toHaveBeenCalledWith("f1", "body > :nth-child(1)");
  });

  test("closed roots on large canvases make no hierarchy request until expanded", async () => {
    const spec: Spec = {
      body: [{ label: "hero", children: 2 }],
      "body > :nth-child(1)": [{ label: "cta" }],
    };
    const bridges = new Map(
      ["a", "b", "c", "d", "e"].map((id) => [id, fakeBridge(`c-${id}`, spec)] as const),
    );
    setup({
      frames: ["a", "b", "c", "d", "e"].map((id) => frame(id)),
      metas: Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, meta(id, id)])),
      getBridge: (id) => bridges.get(id)?.bridge,
      liveFrames: new Set(["a", "b", "c", "d", "e"]),
    });
    await flush();
    for (const { ask } of bridges.values()) expect(ask).not.toHaveBeenCalled();
    const root = treeItem("c, 7 elements");
    expect(root.getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(root);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "hero" });
    expect(bridges.get("c")!.ask).toHaveBeenCalledTimes(1);
    expect(bridges.get("a")!.ask).not.toHaveBeenCalled();
    // Element branches load lazily with their selector as the root.
    fireEvent.keyDown(document.activeElement ?? root, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "cta" });
    expect(bridges.get("c")!.ask.mock.calls[1]![0]).toEqual({
      op: "hierarchyPage",
      rootSelector: "body > :nth-child(1)",
      maxNodes: 200,
      maxDepth: 1,
    });
  });

  test("offscreen frames page from the backend; legacy offscreen frames ask to be brought into view", async () => {
    const loadHierarchy = mock<HierarchyLoader>(async (_env, _canvas, _frameId, query) => ({
      revision: 1,
      structureId: "s1",
      page: pageFor(
        { body: [{ label: "offscreen-heading" }] },
        "fp",
        query.rootSelector,
        query.cursor,
      ),
    }));
    setup({
      frames: [frame("f1", "Offscreen")],
      metas: { f1: meta("f1", "s1") },
      focusedFrameId: "f1",
      loadHierarchy,
    });
    await screen.findByRole("button", { name: "offscreen-heading" });
    expect(loadHierarchy).toHaveBeenCalledWith("env", "canvas", "f1", {
      maxNodes: 200,
      maxDepth: 1,
    });

    cleanup();
    const legacy = setup({ frames: [frame("f2", "Legacy")], legacy: true, focusedFrameId: "f2" });
    const status = await screen.findByRole("treeitem", { name: "Bring into view to load layers" });
    fireEvent.click(within(status).getByRole("button", { name: "Show" }));
    expect(legacy.onFocusFrame).toHaveBeenCalledWith("f2");
    // Once the frame renders live, the bridge loads it.
    const { bridge } = fakeBridge("revision:1", { body: [{ label: "now-live" }] });
    legacy.rerender({ getBridge: () => bridge, liveFrames: new Set(["f2"]), renderedVersion: 1 });
    await screen.findByRole("button", { name: "now-live" });
  });

  test("keyboard navigation follows the WAI-ARIA tree pattern with roving tabindex", async () => {
    const spec: Spec = {
      body: [{ label: "header", children: 1 }, { label: "main" }],
      "body > :nth-child(1)": [{ label: "logo", tag: "img" }],
    };
    const { bridge } = fakeBridge("c-s1", spec);
    const { onFocusFrame, onSelectElement } = setup({
      frames: [frame("f1", "Home")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "header" });
    const root = treeItem("Home, 7 elements");
    expect(root.tabIndex).toBe(0);
    expect(screen.getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toHaveLength(1);
    act(() => root.focus());
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeItem("header (div)"));
    expect(treeItem("header (div)").tabIndex).toBe(0);
    expect(root.tabIndex).toBe(-1);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "logo" });
    expect(treeItem("header (div)").getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(treeItem("logo (img)"));
    expect(treeItem("logo (img)").getAttribute("aria-level")).toBe("3");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSelectElement).toHaveBeenCalledWith("f1", "body > :nth-child(1) > :nth-child(1)");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(treeItem("header (div)"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(treeItem("header (div)").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "logo" }) === null).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(treeItem("main (div)"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: " " });
    expect(onFocusFrame).toHaveBeenCalledWith("f1");
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(root.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  });

  test("selected element is revealed and marked aria-selected", async () => {
    const spec: Spec = {
      body: [{ label: "header", children: 1 }],
      "body > :nth-child(1)": [{ label: "logo", tag: "img" }],
    };
    const { bridge } = fakeBridge("c-s1", spec);
    setup({
      frames: [frame("f1", "Home"), ...["b", "c", "d", "e"].map((id) => frame(id))],
      metas: { f1: meta("f1", "s1") },
      getBridge: (id) => (id === "f1" ? bridge : undefined),
      liveFrames: new Set(["f1"]),
      selection: {
        frameId: "f1",
        revision: 1,
        structureId: "s1",
        element: {
          selector: "body > :nth-child(1) > :nth-child(1)",
          tag: "img",
          text: "",
          attributes: {},
          styles: {},
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      },
    });
    await screen.findByRole("button", { name: "logo" });
    const logo = treeItem("logo (img)");
    expect(logo.getAttribute("aria-selected")).toBe("true");
    expect(logo.tabIndex).toBe(0);
    expect(treeItem("header (div)").getAttribute("aria-selected")).toBe("false");
  });

  test("load more pages with the cursor and reports how much is shown", async () => {
    const spec: Spec = {
      body: Array.from({ length: 450 }, (_, index) => ({ label: `row-${index + 1}` })),
    };
    const { bridge, ask } = fakeBridge("c-s1", spec);
    setup({
      frames: [frame("f1", "Long")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "row-1" });
    const tree = screen.getByRole("tree");
    // Scroll to the end so the paging row is mounted.
    tree.scrollTop = 200 * 24;
    fireEvent.scroll(tree);
    const more = await screen.findByRole("treeitem", { name: "Showing 200 of 450" });
    fireEvent.click(within(more).getByRole("button", { name: "Load more" }));
    await screen.findByRole("treeitem", { name: "Showing 400 of 450" });
    expect(ask.mock.calls[1]![0]).toMatchObject({ op: "hierarchyPage", cursor: "fp:200" });
    tree.scrollTop = 450 * 24;
    fireEvent.scroll(tree);
    fireEvent.click(
      within(screen.getByRole("treeitem", { name: "Showing 400 of 450" })).getByRole("button", {
        name: "Load more",
      }),
    );
    await screen.findByRole("button", { name: "row-450" });
    expect(screen.queryByRole("button", { name: "Load more" }) === null).toBe(true);
  });

  test("a structure change resets cached branches and ignores late responses", async () => {
    const pending: Array<(page: DesignHierarchyPage) => void> = [];
    let structure = "s1";
    const ask = mock((operation: DesignOperation) => {
      if (operation.op !== "hierarchyPage") return Promise.reject(new Error("unexpected"));
      if (structure === "slow")
        return new Promise<DesignHierarchyPage>((resolve) => pending.push(resolve));
      return Promise.resolve(
        pageFor({ body: [{ label: `${structure}-a` }, { label: `${structure}-b` }] }, structure),
      );
    });
    const bridge = {
      renderedContentId: "c-s1",
      closed: false,
      ask,
    } as unknown as DesignFrameBridge;
    const { rerender } = setup({
      frames: [frame("f1", "Home")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "s1-a" });
    // Structure s2 starts loading slowly; s3 supersedes it before the s2 reply arrives.
    structure = "slow";
    (bridge as { renderedContentId: string }).renderedContentId = "c-s2";
    rerender({ metas: { f1: meta("f1", "s2") }, renderedVersion: 1 });
    await flush();
    expect(screen.queryByRole("button", { name: "s1-a" }) === null).toBe(true);
    expect(screen.getByRole("treeitem", { name: "Loading layers…" })).toBeTruthy();
    structure = "s3";
    (bridge as { renderedContentId: string }).renderedContentId = "c-s3";
    rerender({ metas: { f1: meta("f1", "s3") }, renderedVersion: 2 });
    await screen.findByRole("button", { name: "s3-a" });
    await act(async () => pending[0]!(pageFor({ body: [{ label: "stale-row" }] }, "s2")));
    expect(screen.queryByRole("button", { name: "stale-row" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "s3-b" })).toBeTruthy();
    // Every reload after a structure change starts from the root without a cursor.
    for (const call of ask.mock.calls) expect(call[0]).not.toHaveProperty("cursor");
  });

  test("a rejected cursor restarts the frame from its root", async () => {
    let fingerprint = "one";
    const spec: Spec = {
      body: Array.from({ length: 250 }, (_, index) => ({ label: `n-${index + 1}` })),
    };
    const ask = mock(async (operation: DesignOperation) =>
      operation.op === "hierarchyPage"
        ? pageFor(spec, fingerprint, operation.rootSelector, operation.cursor)
        : null,
    );
    const bridge = {
      renderedContentId: "c-s1",
      closed: false,
      ask,
    } as unknown as DesignFrameBridge;
    setup({
      frames: [frame("f1")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "n-1" });
    const tree = screen.getByRole("tree");
    tree.scrollTop = 200 * 24;
    fireEvent.scroll(tree);
    fingerprint = "two";
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await flush();
    await flush();
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2]![0]).not.toHaveProperty("cursor");
    await screen.findByRole("treeitem", { name: "Showing 200 of 250" });
  });

  test("virtualizes 1,000 loaded layers and keeps the focused row mounted", async () => {
    const spec: Spec = {
      body: Array.from({ length: 1000 }, (_, index) => ({ label: `layer-${index + 1}` })),
    };
    const { bridge } = fakeBridge("c-s1", spec);
    setup({
      frames: [frame("f1", "Big")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "layer-1" });
    const tree = screen.getByRole("tree");
    for (let loaded = 200; loaded < 1000; loaded += 200) {
      tree.scrollTop = loaded * 24;
      fireEvent.scroll(tree);
      const more = await screen.findByRole("treeitem", { name: `Showing ${loaded} of 1000` });
      fireEvent.click(within(more).getByRole("button", { name: "Load more" }));
      tree.scrollTop = (loaded + 190) * 24;
      fireEvent.scroll(tree);
      await screen.findByRole("button", { name: `layer-${loaded + 200}` });
    }
    const mountedAtEnd = screen.getAllByRole("treeitem");
    expect(mountedAtEnd.length).toBeLessThan(60);
    // The spacer still represents every row.
    expect((tree.firstElementChild as HTMLElement).style.height).toBe(`${1001 * 24}px`);
    // Focus a row, scroll far away: the focused row stays mounted and focused.
    const focused = treeItem("layer-990 (div)");
    act(() => focused.focus());
    tree.scrollTop = 0;
    fireEvent.scroll(tree);
    expect(screen.getByRole("button", { name: "layer-1" })).toBeTruthy();
    expect(document.activeElement).toBe(treeItem("layer-990 (div)"));
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(60);
    // Keyboard navigation scrolls the window to the target row.
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(treeItem("layer-1000 (div)"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(treeItem("Big, 7 elements"));
  });

  test("frame roots expose pending/invalid states and a frame actions menu", async () => {
    const { onFrameAction } = setup({
      frames: [frame("f1", "Home"), frame("f2", "Broken")],
      metas: { f1: meta("f1", "s1"), f2: meta("f2", "s2", "c2", "invalid") },
      pendingFrames: new Set(["f1"]),
      loadHierarchy: mock(async () => ({ structureId: "x", page: pageFor({}, "fp") })),
    });
    expect(treeItem("Home (saving), 7 elements")).toBeTruthy();
    const broken = treeItem("Broken (needs repair), 7 elements");
    act(() => broken.focus());
    fireEvent.keyDown(broken, { key: "ContextMenu" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(onFrameAction).toHaveBeenCalledWith("f2", "rename");
    fireEvent.contextMenu(treeItem("Home (saving), 7 elements"));
    const menu = await screen.findByRole("menu");
    for (const name of ["Rename", "Duplicate", "Properties", "Ask agent", "Delete"])
      expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Ask agent" }));
    expect(onFrameAction).toHaveBeenCalledWith("f1", "ask-agent");
  });

  test("filter searches only loaded layers and says so", async () => {
    const spec: Spec = {
      body: [{ label: "title", tag: "h1" }, { label: "subtitle" }, { label: "footer" }],
    };
    const { bridge } = fakeBridge("c-s1", spec);
    setup({
      frames: [frame("f1", "Home")],
      metas: { f1: meta("f1", "s1") },
      getBridge: () => bridge,
      liveFrames: new Set(["f1"]),
    });
    await screen.findByRole("button", { name: "footer" });
    expect(screen.getByText("Filter searches only loaded layers (3 loaded).")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter loaded layers" }), {
      target: { value: "TITLE" },
    });
    expect(
      screen.getByText("2 matches in 3 loaded layers. Only loaded layers are searched."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "subtitle" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "footer" }) === null).toBe(true);
  });
});
