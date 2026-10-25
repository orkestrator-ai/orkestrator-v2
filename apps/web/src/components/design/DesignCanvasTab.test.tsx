import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesignElement } from "@orkestrator/protocol/design-canvas";
import { invoke } from "@/lib/native/backend";
import { useDesignStore } from "@/stores/designStore";
import { designController, resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "@/lib/design-client";
import { FakeBackend, canvasId, deferred, frameA, frameB } from "./design-test-backend";
import { DesignFrameBridge } from "./frame-bridge";

const { DesignCanvasTab } = await import("./DesignCanvasTab");
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const originalOrkestrator = window.orkestrator;
const originalResizeObserver = globalThis.ResizeObserver;
let backend: FakeBackend;

function prepared(kind: string) {
  return backend.calls.filter(
    (call) =>
      call.command === "design_prepare" &&
      (call.args.descriptor as { input: { kind: string } }).input.kind === kind,
  );
}

describe("DesignCanvasTab", () => {
  beforeEach(() => {
    backend = new FakeBackend();
    backend.history = { undoCount: 2, redoCount: 0 };
    resetCapabilities();
    window.localStorage.clear();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) =>
      backend.handle(command, args ?? {}),
    );
    window.orkestrator = { listen: mock(() => () => {}) } as unknown as Window["orkestrator"];
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resetDesignControllers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    window.orkestrator = originalOrkestrator;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test("undo and redo follow authoritative availability and submit own-scope operations", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const undo = await screen.findByRole("button", { name: "Undo design change" });
    const redo = screen.getByRole("button", { name: "Redo design change" });
    await waitFor(() => expect(undo.hasAttribute("disabled")).toBe(false));
    expect(redo.hasAttribute("disabled")).toBe(true);

    fireEvent.click(undo);
    await waitFor(() => expect(prepared("undo")).toHaveLength(1));
    expect(prepared("undo")[0]!.args.descriptor).toMatchObject({
      canvasId,
      input: { kind: "undo", scope: "own" },
      preconditions: { canvasRevision: 1 },
    });
    await waitFor(() => expect(redo.hasAttribute("disabled")).toBe(false));
    fireEvent.click(redo);
    await waitFor(() => expect(prepared("redo")).toHaveLength(1));
    expect(prepared("redo")[0]!.args.descriptor).toMatchObject({
      preconditions: { canvasRevision: 2 },
    });
  });

  test("shortcuts route to design undo only for the owning pane and never from text fields", async () => {
    render(
      <>
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />
        <DesignCanvasTab
          canvasId={canvasId}
          environmentId="env-1"
          isActive
          ownsGlobalShortcuts={false}
        />
      </>,
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "Undo design change" })
          .every((button) => !button.hasAttribute("disabled")),
      ).toBe(true),
    );
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(prepared("undo")).toHaveLength(1));

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepared("undo")).toHaveLength(1);
    input.remove();
  });

  test("Ctrl/⌘+0 resets the owning canvas to 100% ahead of the app-wide zoom shortcut", async () => {
    // Stands in for App's window listener, which is registered before any canvas mounts.
    const appZoomReset = mock((event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "0") event.preventDefault();
    });
    window.addEventListener("keydown", appZoomReset);
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const title = await screen.findByRole("button", { name: "Move frame A" });
      const zoomLabel = () =>
        screen
          .getByRole("button", { name: /^Zoom \d+%\. Reset to 100%$/ })
          .getAttribute("aria-label");
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      await waitFor(() => expect(zoomLabel()).not.toBe("Zoom 100%. Reset to 100%"));

      title.focus();
      const event = new KeyboardEvent("keydown", {
        key: "0",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        title.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(zoomLabel()).toBe("Zoom 100%. Reset to 100%"));
      expect(appZoomReset).toHaveBeenCalledTimes(1);

      // In a text field the key stays the app's.
      const input = document.createElement("input");
      document.body.append(input);
      fireEvent.keyDown(input, { key: "0", ctrlKey: true });
      expect(appZoomReset.mock.calls.at(-1)![0].defaultPrevented).toBe(true);
      input.remove();
    } finally {
      window.removeEventListener("keydown", appZoomReset);
    }
  });

  test("selecting a frame title outlines the frame and Delete removes it", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    const frame = () => document.querySelector(`[data-frame-id="${frameA}"]`)!;
    const other = document.querySelector(`[data-frame-id="${frameB}"]`)!;
    expect(frame().hasAttribute("data-selected")).toBe(false);

    fireEvent.pointerDown(title, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(title, { button: 0, pointerId: 1 });
    await waitFor(() => expect(frame().hasAttribute("data-selected")).toBe(true));
    expect(frame().querySelector('[data-testid="frame-selection-outline"]')).not.toBeNull();
    expect(title.getAttribute("aria-pressed")).toBe("true");
    expect(other.hasAttribute("data-selected")).toBe(false);
    expect(document.activeElement).toBe(title);

    fireEvent.keyDown(title, { key: "Delete" });
    await waitFor(() => expect(prepared("delete_frame")).toHaveLength(1));
    expect(prepared("delete_frame")[0]!.args.descriptor).toMatchObject({
      canvasId,
      input: { kind: "delete_frame", frameId: frameA },
      preconditions: { frameRevision: 1, canvasRevision: 1 },
    });
    await waitFor(() =>
      expect(document.querySelector(`[data-frame-id="${frameA}"]`) === null).toBe(true),
    );
    expect(document.querySelector(`[data-frame-id="${frameB}"]`)).not.toBeNull();
    expect(screen.getByText("Deleted A. Undo with Ctrl/⌘ + Z")).toBeTruthy();
    // Removing the focused title must leave a usable keyboard target in the workspace.
    await waitFor(() => {
      const active = document.activeElement;
      expect(active?.isConnected).toBe(true);
      expect(active === document.body).toBe(false);
      expect(active?.closest('[aria-label="Design canvas"]')).not.toBeNull();
      expect(
        active?.getAttribute("role") === "treeitem" ||
          active?.getAttribute("aria-label") === "Toggle layers",
      ).toBe(true);
    });
  });

  test("Backspace deletes the selected frame; Escape and the canvas background deselect it", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame B" });
    const frame = () => document.querySelector(`[data-frame-id="${frameB}"]`);
    const select = () => {
      fireEvent.pointerDown(title, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(title, { button: 0, pointerId: 1 });
    };

    // Nothing selected: Delete is ignored.
    fireEvent.keyDown(title, { key: "Delete" });
    select();
    await waitFor(() => expect(frame()?.hasAttribute("data-selected")).toBe(true));
    fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(frame()?.hasAttribute("data-selected")).toBe(false));
    fireEvent.keyDown(title, { key: "Backspace" });

    select();
    await waitFor(() => expect(frame()?.hasAttribute("data-selected")).toBe(true));
    fireEvent.pointerDown(screen.getByRole("main", { name: "Canvas viewport" }), {
      button: 0,
      pointerId: 2,
    });
    await waitFor(() => expect(frame()?.hasAttribute("data-selected")).toBe(false));
    fireEvent.keyDown(title, { key: "Backspace" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepared("delete_frame")).toHaveLength(0);

    // Keyboard activation (Enter/Space → click) selects too.
    fireEvent.click(title);
    await waitFor(() => expect(frame()?.hasAttribute("data-selected")).toBe(true));
    // Typing in a text field never deletes the frame.
    const input = document.createElement("input");
    screen.getByRole("main", { name: "Canvas viewport" }).append(input);
    fireEvent.keyDown(input, { key: "Backspace" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepared("delete_frame")).toHaveLength(0);
    input.remove();

    fireEvent.keyDown(title, { key: "Backspace" });
    await waitFor(() => expect(prepared("delete_frame")).toHaveLength(1));
    await waitFor(() => expect(frame() === null).toBe(true));
  });

  test("focusing another title or a Layers row cannot delete the previously selected frame", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const titleA = await screen.findByRole("button", { name: "Move frame A" });
    const titleB = screen.getByRole("button", { name: "Move frame B" });
    fireEvent.click(titleA);
    await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("true"));
    act(() => titleB.focus());
    await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("false"));
    fireEvent.keyDown(titleB, { key: "Delete" });
    expect(prepared("delete_frame")).toHaveLength(0);

    fireEvent.click(titleA);
    const layersFrameB = await screen.findByRole("treeitem", { name: /^B/ });
    act(() => layersFrameB.focus());
    await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("false"));
    fireEvent.keyDown(layersFrameB, { key: "Delete" });
    expect(prepared("delete_frame")).toHaveLength(0);
  });

  test("a late hit test cannot clear a newer frame-title selection", async () => {
    const hit = deferred<DesignElement | null>();
    const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(
      (operation) =>
        (operation.op === "hitTest" ? hit.promise : Promise.resolve(undefined)) as Promise<never>,
    );
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const titleB = await screen.findByRole("button", { name: "Move frame B" });
      fireEvent.load(screen.getByTitle("A"));
      await waitFor(() =>
        expect(ask.mock.calls.some(([operation]) => operation.op === "render")).toBe(true),
      );
      fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
      await waitFor(() =>
        expect(ask.mock.calls.some(([operation]) => operation.op === "hitTest")).toBe(true),
      );
      fireEvent.click(titleB);
      await waitFor(() => expect(titleB.getAttribute("aria-pressed")).toBe("true"));
      await act(async () => hit.resolve(null));
      expect(titleB.getAttribute("aria-pressed")).toBe("true");
      expect(
        document.querySelector(`[data-frame-id="${frameB}"]`)?.hasAttribute("data-selected"),
      ).toBe(true);
    } finally {
      ask.mockRestore();
    }
  });

  test("selecting an element clears board selection so Delete cannot remove its frame", async () => {
    const element: DesignElement = {
      selector: "body > p",
      tag: "p",
      text: "x",
      attributes: {},
      styles: {},
      rect: { x: 0, y: 0, width: 20, height: 20 },
    };
    const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(
      (operation) =>
        Promise.resolve(operation.op === "hitTest" ? element : undefined) as Promise<never>,
    );
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const title = await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.load(screen.getByTitle("A"));
      await waitFor(() =>
        expect(ask.mock.calls.some(([operation]) => operation.op === "render")).toBe(true),
      );
      act(() => title.focus());
      fireEvent.click(title);
      await waitFor(() => expect(title.getAttribute("aria-pressed")).toBe("true"));
      fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
      await waitFor(() => expect(title.getAttribute("aria-pressed")).toBe("false"));
      fireEvent.keyDown(title, { key: "Delete" });
      expect(prepared("delete_frame")).toHaveLength(0);
    } finally {
      ask.mockRestore();
    }
  });

  test("a Layers element on an unready frame clears an older board selection", async () => {
    const bridges = new Set<DesignFrameBridge>();
    const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(function (
      this: DesignFrameBridge,
      operation,
    ) {
      if (operation.op === "render") bridges.add(this);
      if (operation.op === "hierarchyPage")
        return Promise.resolve({
          layers: [
            {
              selector: "body > :nth-child(1)",
              tag: "p",
              label: "target",
              depth: 1,
              childCount: 0,
            },
          ],
          total: 1,
          truncated: false,
          bytes: 0,
        }) as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const titleA = await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.load(screen.getByTitle("B"));
      const layer = (await screen.findAllByRole("button", { name: "target" })).find((button) =>
        button.closest('[role="treeitem"]')?.getAttribute("data-row-key")?.startsWith(frameB),
      );
      expect(layer !== undefined).toBe(true);
      fireEvent.click(titleA);
      await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("true"));
      const bridge = Array.from(bridges).find(
        (candidate) => candidate.renderedContentId === backend.frames.get(frameB)!.contentId,
      );
      expect(bridge !== undefined).toBe(true);
      bridge!.renderedContentId = null;
      fireEvent.click(layer!);
      await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("false"));
      expect(ask.mock.calls.some(([operation]) => operation.op === "inspectElement")).toBe(false);
      fireEvent.keyDown(layer!, { key: "Delete" });
      expect(prepared("delete_frame")).toHaveLength(0);
    } finally {
      ask.mockRestore();
    }
  });

  describe("deferred layer selection", () => {
    const target: DesignElement = {
      selector: "body > :nth-child(1)",
      tag: "p",
      text: "target",
      attributes: {},
      styles: {},
      rect: { x: 0, y: 0, width: 20, height: 20 },
    };
    let ask: ReturnType<typeof spyOn<DesignFrameBridge, "ask">>;
    let renderGate: ReturnType<typeof deferred<void>>;
    let inspectGate: ReturnType<typeof deferred<DesignElement>> | undefined;
    let hitGate: ReturnType<typeof deferred<DesignElement>>;
    let waitingBridge: DesignFrameBridge | undefined;
    let layer: HTMLElement;
    const inspector = () => screen.queryByRole("complementary", { name: "Element inspector" });
    const announcement = () => document.querySelector('p.sr-only[role="status"]')!.textContent;
    const inspections = () => ask.mock.calls.filter(([op]) => op.op === "inspectElement");
    const refresh = () => act(() => designController("env-1", canvasId).refresh());
    const finishRender = () =>
      act(async () => {
        renderGate.resolve();
      });

    async function setup(narrow = false, legacy = false) {
      globalThis.ResizeObserver = class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(element: Element) {
          if (element.getAttribute("aria-label") === "Design canvas") {
            Object.defineProperty(element, "clientWidth", {
              value: narrow ? 600 : 1200,
              configurable: true,
            });
            this.callback([], this as unknown as ResizeObserver);
          }
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      if (legacy) {
        invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
          if (command === "design_capabilities")
            return Promise.reject(new Error("Unknown backend command: design_capabilities"));
          if (command === "design_changes")
            return Promise.resolve({
              generation: "legacy",
              revision: backend.revision,
              reset: true,
              events: [],
            });
          if (command === "design_action")
            return Promise.resolve({
              canvas: backend.canvas(),
              history: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
            });
          return backend.handle(command, args ?? {});
        });
      }
      renderGate = deferred();
      hitGate = deferred<DesignElement>();
      inspectGate = undefined;
      waitingBridge = undefined;
      const bridgesByFrame = new Map<string, DesignFrameBridge>();
      backend.frames.get(frameB)!.frame.html = "<p>B</p>";
      ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(function (
        this: DesignFrameBridge,
        operation,
      ) {
        if (operation.op === "render") {
          if (operation.html.startsWith("<p>B</p>")) bridgesByFrame.set(frameB, this);
          if (this === waitingBridge) return renderGate.promise as Promise<never>;
        }
        if (operation.op === "hitTest") return hitGate.promise as Promise<never>;
        if (operation.op === "inspectElement")
          return (inspectGate?.promise ?? Promise.resolve(target)) as Promise<never>;
        if (operation.op === "hierarchyPage")
          return Promise.resolve({
            layers: [
              { selector: target.selector, tag: "p", label: "target", depth: 1, childCount: 0 },
              {
                selector: "body > :nth-child(2)",
                tag: "p",
                label: "other",
                depth: 1,
                childCount: 0,
              },
            ],
            total: 2,
            truncated: false,
            bytes: 0,
          }) as Promise<never>;
        return Promise.resolve(undefined) as Promise<never>;
      });
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.load(screen.getByTitle("A"));
      fireEvent.load(screen.getByTitle("B"));
      layer = (await screen.findAllByRole("button", { name: "target" })).find((button) =>
        button.closest('[role="treeitem"]')?.getAttribute("data-row-key")?.startsWith(frameB),
      )!;
      await waitFor(() =>
        expect(bridgesByFrame.get(frameB)?.renderedContentId).toBe(
          legacy ? "revision:1" : backend.frames.get(frameB)!.contentId,
        ),
      );
      waitingBridge = bridgesByFrame.get(frameB);
      if (legacy) waitingBridge!.renderedContentId = null;
      else await styleUpdate();
    }
    async function styleUpdate() {
      const entry = backend.frames.get(frameB)!;
      entry.frame = {
        ...entry.frame,
        html: entry.frame.html + "<!--style-->",
        revision: entry.frame.revision + 1,
      };
      entry.contentId = `style-${entry.frame.revision}`;
      backend.revision++;
      await refresh();
      await waitFor(() => expect(waitingBridge!.renderedContentId).toBeNull());
    }
    afterEach(() => {
      ask?.mockRestore();
      jest.useRealTimers();
    });

    test("delayed rendering of the same structure selects after one activation, including a style update", async () => {
      await setup();
      fireEvent.click(layer);
      expect(announcement()).toBe("Loading B; the layer is selected when it appears");
      expect(inspections()).toHaveLength(0);
      await styleUpdate();
      await finishRender();
      expect(inspections()).toHaveLength(1);
      expect(inspector()).not.toBeNull();
    });

    test.each([false, true])(
      "a changed structure or legacy revision cancels positional selection (legacy=%s)",
      async (legacy) => {
        await setup(false, legacy);
        fireEvent.click(layer);
        backend.externalReplace(frameB);
        await refresh();
        expect(announcement()).toBe("The frame structure changed; select the layer again");
        await finishRender();
        expect(inspections()).toHaveLength(0);
        expect(inspector() === null).toBe(true);
      },
    );

    test.each([false, true])(
      "a newer hit test wins before or during layer inspection (inspecting=%s)",
      async (inspecting) => {
        await setup();
        inspectGate = deferred<DesignElement>();
        fireEvent.click(layer);
        if (inspecting) await finishRender();
        fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
        expect(ask.mock.calls.some(([op]) => op.op === "hitTest")).toBe(true);
        await finishRender();
        expect(inspections()).toHaveLength(inspecting ? 1 : 0);
        await act(async () => inspectGate!.resolve(target));
        expect(inspector() === null).toBe(true);
        await act(async () => hitGate.resolve({ ...target, tag: "h1" }));
        expect(within(inspector()!).getByRole("heading", { name: "h1" })).toBeTruthy();
      },
    );

    test("a structural replacement during inspection discards the old reply", async () => {
      await setup();
      inspectGate = deferred<DesignElement>();
      fireEvent.click(layer);
      await finishRender();
      expect(inspections()).toHaveLength(1);
      backend.externalReplace(frameB);
      await refresh();
      await act(async () => inspectGate!.resolve(target));
      expect(announcement()).toBe("The frame structure changed; select the layer again");
      expect(inspector() === null).toBe(true);
    });

    test.each([false, true])(
      "Escape dismisses a narrow pending layer before or during inspection (inspecting=%s)",
      async (inspecting) => {
        await setup(true);
        inspectGate = deferred<DesignElement>();
        act(() => layer.focus());
        fireEvent.click(layer);
        if (inspecting) await finishRender();
        fireEvent.keyDown(layer, { key: "Escape" });
        expect(screen.queryByRole("navigation", { name: "Design hierarchy" }) === null).toBe(true);
        expect(
          screen.getByRole("button", { name: "Toggle layers" }).getAttribute("aria-pressed"),
        ).toBe("false");
        await finishRender();
        await act(async () => inspectGate!.resolve(target));
        expect(inspector() === null).toBe(true);
        expect(screen.queryByRole("navigation", { name: "Design hierarchy" }) === null).toBe(true);
        expect(inspections()).toHaveLength(inspecting ? 1 : 0);
      },
    );

    test("same-frame row focus preserves the first activation while inspection is in flight", async () => {
      await setup();
      inspectGate = deferred<DesignElement>();
      fireEvent.click(layer);
      await finishRender();
      expect(inspections()).toHaveLength(1);
      const other = screen
        .getAllByRole("button", { name: "other" })
        .find((button) =>
          button.closest('[role="treeitem"]')?.getAttribute("data-row-key")?.startsWith(frameB),
        )!;
      act(() => (other.closest('[role="treeitem"]') as HTMLElement).focus());
      await act(async () => inspectGate!.resolve(target));
      expect(inspector()).not.toBeNull();
      expect(layer.closest('[role="treeitem"]')!.getAttribute("aria-selected")).toBe("true");
    });

    test("the ten-second expiry announces failure and ignores a late render", async () => {
      await setup();
      jest.useFakeTimers();
      fireEvent.click(layer);
      act(() => jest.advanceTimersByTime(9_999));
      expect(announcement()).toBe("Loading B; the layer is selected when it appears");
      act(() => jest.advanceTimersByTime(1));
      expect(announcement()).toBe("B did not finish loading; nothing was selected");
      await finishRender();
      expect(inspections()).toHaveLength(0);
      expect(inspector() === null).toBe(true);
    });

    test("replacing a request clears its timer and the replacement can still select", async () => {
      await setup();
      jest.useFakeTimers();
      const clear = spyOn(globalThis, "clearTimeout");
      try {
        fireEvent.click(layer);
        act(() => jest.advanceTimersByTime(5_000));
        const other = screen
          .getAllByRole("button", { name: "other" })
          .find((button) =>
            button.closest('[role="treeitem"]')?.getAttribute("data-row-key")?.startsWith(frameB),
          )!;
        clear.mockClear();
        fireEvent.click(other);
        expect(clear).toHaveBeenCalled();
        act(() => jest.advanceTimersByTime(5_000));
        expect(announcement()).toBe("Loading B; the layer is selected when it appears");
        await finishRender();
        expect(inspections()).toHaveLength(1);
        expect(inspections()[0]![0]).toMatchObject({ selector: "body > :nth-child(2)" });
        act(() => jest.advanceTimersByTime(5_000));
        expect(announcement()).not.toContain("did not finish loading");
        expect(inspector()).not.toBeNull();
      } finally {
        clear.mockRestore();
      }
    });

    test("unmount clears the waiting timer", async () => {
      await setup();
      jest.useFakeTimers();
      const clear = spyOn(globalThis, "clearTimeout");
      try {
        fireEvent.click(layer);
        clear.mockClear();
        cleanup();
        expect(clear).toHaveBeenCalled();
        act(() => jest.advanceTimersByTime(10_000));
        await finishRender();
        expect(inspections()).toHaveLength(0);
      } finally {
        clear.mockRestore();
      }
    });

    test("removing the waiting frame cancels immediately and clears its timer", async () => {
      await setup();
      jest.useFakeTimers();
      fireEvent.click(layer);
      backend.removeFrame(frameB);
      await refresh();
      expect(announcement()).toBe("The frame was removed; nothing was selected");
      act(() => jest.advanceTimersByTime(10_000));
      expect(announcement()).toBe("The frame was removed; nothing was selected");
      await finishRender();
      expect(inspections()).toHaveLength(0);
      expect(inspector() === null).toBe(true);
    });
  });

  test("a Layers element waiting for its frame is dropped when another frame takes focus", async () => {
    const bridges = new Set<DesignFrameBridge>();
    const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(function (
      this: DesignFrameBridge,
      operation,
    ) {
      if (operation.op === "render") bridges.add(this);
      if (operation.op === "hierarchyPage")
        return Promise.resolve({
          layers: [
            {
              selector: "body > :nth-child(1)",
              tag: "p",
              label: "target",
              depth: 1,
              childCount: 0,
            },
          ],
          total: 1,
          truncated: false,
          bytes: 0,
        }) as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const titleA = await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.load(screen.getByTitle("B"));
      const layer = (await screen.findAllByRole("button", { name: "target" })).find((button) =>
        button.closest('[role="treeitem"]')?.getAttribute("data-row-key")?.startsWith(frameB),
      )!;
      Array.from(bridges).find(
        (candidate) => candidate.renderedContentId === backend.frames.get(frameB)!.contentId,
      )!.renderedContentId = null;
      fireEvent.click(layer);
      // The user moves on to frame A before B renders.
      fireEvent.click(titleA);
      await waitFor(() => expect(titleA.getAttribute("aria-pressed")).toBe("true"));
      backend.externalReplace(frameB);
      await act(() => designController("env-1", canvasId).refresh());
      await waitFor(() =>
        expect(
          ask.mock.calls.filter(([operation]) => operation.op === "render").length,
        ).toBeGreaterThan(2),
      );
      expect(ask.mock.calls.some(([operation]) => operation.op === "inspectElement")).toBe(false);
      expect(screen.queryByRole("complementary", { name: "Element inspector" }) === null).toBe(
        true,
      );
    } finally {
      ask.mockRestore();
    }
  });

  test("legacy Delete asks for confirmation, and non-editable canvases ignore it", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    const controller = designController("env-1", canvasId);
    act(() => title.focus());
    fireEvent.click(title);
    act(() =>
      useDesignStore.getState().update(controller.key, (projection) => ({
        ...projection,
        snapshot: "loading",
      })),
    );
    fireEvent.keyDown(title, { key: "Delete" });
    expect(prepared("delete_frame")).toHaveLength(0);

    act(() =>
      useDesignStore.getState().update(controller.key, (projection) => ({
        ...projection,
        snapshot: "current",
        legacy: true,
      })),
    );
    fireEvent.keyDown(title, { key: "Delete" });
    const dialog = await screen.findByRole("alertdialog");
    expect(prepared("delete_frame")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete frame" }));
    await waitFor(() => expect(prepared("delete_frame")).toHaveLength(1));
  });

  test("a rejected delete leaves the frame selected and never announces success", async () => {
    const gate = deferred();
    backend.executeBarrier = (descriptor) =>
      descriptor.input.kind === "delete_frame" ? gate.promise : Promise.resolve();
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    act(() => title.focus());
    fireEvent.click(title);
    fireEvent.keyDown(title, { key: "Delete" });
    await waitFor(() => expect(prepared("delete_frame")).toHaveLength(1));
    expect(title.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Deleted A. Undo with Ctrl/⌘ + Z") === null).toBe(true);
    backend.frames.get(frameA)!.frame.revision++;
    await act(async () => gate.resolve());
    await waitFor(() =>
      expect(screen.getByText(/Delete A: Design revision conflict/)).toBeTruthy(),
    );
    expect(title.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Deleted A. Undo with Ctrl/⌘ + Z") === null).toBe(true);
  });

  test("two views of one canvas share one projection", async () => {
    render(
      <>
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />
        <DesignCanvasTab
          canvasId={canvasId}
          environmentId="env-1"
          isActive
          ownsGlobalShortcuts={false}
        />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("Revision 1")).toHaveLength(2));
    const snapshots = backend.calls.filter((call) => call.command === "design_snapshot").length;
    expect(snapshots).toBe(1);
  });

  test("an edit finishing while the tab is unmounted appears on return", async () => {
    const gate = deferred();
    backend.executeBarrier = () => gate.promise;
    const first = render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const undo = await screen.findByRole("button", { name: "Undo design change" });
    await waitFor(() => expect(undo.hasAttribute("disabled")).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(prepared("undo")).toHaveLength(1));
    first.unmount();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(backend.revision).toBe(2));
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    expect(await screen.findByText("Revision 2")).toBeTruthy();
  });

  test("a deleted canvas shows a recoverable deleted state even without a deletion hint", async () => {
    backend.deleted = true;
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    expect(await screen.findByText(/was deleted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore design" })).toBeTruthy();
    expect(screen.queryByRole("main", { name: "Canvas viewport" }) === null).toBe(true);
  });

  test("workspace persistence and repository export are labelled separately", async () => {
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    expect(await screen.findByText("Saved in workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export design to repository" })).toBeTruthy();
    // The save state is a polite live region, so acknowledgements are announced.
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("status").textContent).toBe("Saved in workspace");
  });

  test("a short pane (about 400% zoom) collapses the tools into one menu", async () => {
    globalThis.ResizeObserver = class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("aria-label") === "Design canvas") {
          Object.defineProperty(target, "clientWidth", { value: 320, configurable: true });
          Object.defineProperty(target, "clientHeight", { value: 225, configurable: true });
          this.callback([], this as unknown as ResizeObserver);
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    render(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const toolbar = await screen.findByRole("toolbar", { name: "Design tools" });
    await waitFor(() =>
      expect(within(toolbar).getByRole("button", { name: "More design tools" })).toBeTruthy(),
    );
    expect(document.querySelector('[aria-label="Design canvas"]')?.hasAttribute("data-short")).toBe(
      true,
    );
    // Panel toggles stay inline; every other tool moves into the menu.
    expect(within(toolbar).getByRole("button", { name: "Toggle layers" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "Toggle inspector" })).toBeTruthy();
    expect(within(toolbar).queryByRole("button", { name: "Zoom in" }) === null).toBe(true);
    const exportButton = within(toolbar).queryByRole("button", {
      name: "Export design to repository",
    });
    expect(exportButton === null).toBe(true);
  });

  test.each([false, true])(
    "inspector re-keying restores focus to its new fields (narrow=%s)",
    async (narrow) => {
      globalThis.ResizeObserver = class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          if (target.getAttribute("aria-label") === "Design canvas") {
            Object.defineProperty(target, "clientWidth", {
              value: narrow ? 600 : 1200,
              configurable: true,
            });
            this.callback([], this as unknown as ResizeObserver);
          }
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      let selector = "body > p";
      const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(
        (operation) =>
          Promise.resolve(
            operation.op === "hitTest"
              ? {
                  selector,
                  tag: "p",
                  text: "x",
                  attributes: {},
                  styles: {},
                  rect: { x: 0, y: 0, width: 20, height: 20 },
                }
              : undefined,
          ) as Promise<never>,
      );
      try {
        render(
          <DesignCanvasTab
            canvasId={canvasId}
            environmentId="env-1"
            isActive
            ownsGlobalShortcuts
          />,
        );
        await screen.findByRole("button", { name: "Move frame A" });
        fireEvent.load(screen.getByTitle("A"));
        await waitFor(() =>
          expect(ask.mock.calls.some(([operation]) => operation.op === "render")).toBe(true),
        );
        expect(
          document.querySelector('[aria-label="Design canvas"]')?.hasAttribute("data-narrow"),
        ).toBe(narrow);
        if (narrow) {
          expect(
            document.querySelector('[aria-label="Design canvas"]')?.getAttribute("data-narrow"),
          ).toBe("true");
          const row = screen.getAllByRole("treeitem")[0]!;
          act(() => row.focus());
          expect(document.activeElement).toBe(row);
          fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
          const inspector = await screen.findByRole("complementary", { name: "Element inspector" });
          await waitFor(() => expect(inspector.contains(document.activeElement)).toBe(true));
          expect(screen.queryByRole("navigation", { name: "Design hierarchy" }) === null).toBe(
            true,
          );
        } else {
          fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
        }
        const inspector = await screen.findByRole("complementary", { name: "Element inspector" });
        const field = inspector.querySelector<HTMLInputElement>("[data-inspector-fields] input")!;
        expect(field).not.toBeNull();
        act(() => field.focus());
        selector = "body > h1";
        fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
        await waitFor(() => expect(field.isConnected).toBe(false));
        const replacement = screen.getByRole("complementary", { name: "Element inspector" });
        expect(replacement.contains(document.activeElement)).toBe(true);
        expect(
          document.activeElement?.matches(
            "[data-inspector-fields] input, [data-inspector-fields] button",
          ),
        ).toBe(true);
      } finally {
        ask.mockRestore();
      }
    },
  );

  test("closing the inspector by keyboard keeps focus in the workspace, not on <body>", async () => {
    const element: DesignElement = {
      selector: "body > p",
      tag: "p",
      text: "x",
      attributes: {},
      styles: {},
      rect: { x: 0, y: 0, width: 20, height: 20 },
    };
    const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(
      (operation) =>
        Promise.resolve(operation.op === "hitTest" ? element : undefined) as Promise<never>,
    );
    try {
      render(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.load(screen.getByTitle("A"));
      await waitFor(() =>
        expect(ask.mock.calls.some(([operation]) => operation.op === "render")).toBe(true),
      );
      fireEvent.click(screen.getByRole("button", { name: "Select element in A" }));
      const close = await screen.findByRole("button", { name: "Close inspector" });
      act(() => close.focus());
      fireEvent.click(close);
      await waitFor(() =>
        expect(screen.queryByRole("complementary", { name: "Element inspector" }) === null).toBe(
          true,
        ),
      );
      const active = document.activeElement;
      expect(active === null || active === document.body).toBe(false);
      expect(
        active?.getAttribute("role") === "treeitem" ||
          active?.getAttribute("aria-label") === "Toggle layers",
      ).toBe(true);
    } finally {
      ask.mockRestore();
    }
  });
});
