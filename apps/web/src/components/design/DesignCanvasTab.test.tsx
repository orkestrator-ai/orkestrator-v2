import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesignElement } from "@orkestrator/protocol/design-canvas";
import { invoke } from "@/lib/native/backend";
import { useDesignStore } from "@/stores/designStore";
import { designController, resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "./design-client";
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
  });
});
