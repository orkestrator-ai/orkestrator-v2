import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { DesignOperationDescriptor } from "@orkestrator/protocol/design-operations";
import { invoke } from "@/lib/native/backend";
import { designController, resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "@/lib/design-client";
import { FakeBackend, canvasId, deferred, frameA, frameB } from "./design-test-backend";

const { DesignCanvasTab } = await import("./DesignCanvasTab");
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const originalOrkestrator = window.orkestrator;
const originalResizeObserver = globalThis.ResizeObserver;
let backend: FakeBackend;

/**
 * The canvas opens at the default view (zoom 0.65, pan 45/65) because the
 * mocked layout never measures a size to restore a saved one into.
 */
const ZOOM = 0.65;
const screenDelta = (canvas: number) => canvas * ZOOM;

function frameMoves() {
  return backend.calls
    .filter((call) => call.command === "design_intent_run")
    .map(
      (call) =>
        (call.args.intent as { descriptor: DesignOperationDescriptor }).descriptor.input as {
          kind: string;
          frameId?: string;
          patch?: Record<string, number>;
        },
    )
    .filter((input) => input.kind === "update_frame");
}

const frameSection = (id: string) =>
  document.querySelector<HTMLElement>(`section[data-frame-id="${id}"]`)!;
const selected = (id: string) => frameSection(id).hasAttribute("data-selected");
const guides = () => document.querySelectorAll('[data-testid="design-snap-guide"]');

describe("design canvas gestures", () => {
  beforeEach(() => {
    backend = new FakeBackend();
    // B sits to the right of A, with the same size.
    const b = backend.frames.get(frameB)!;
    b.frame = { ...b.frame, x: 600, y: 100 };
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

  test("dragging a frame beside another snaps top and bottom together with red guides", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    expect(document.querySelector('[data-testid="design-snap-grid"]') === null).toBe(true);

    fireEvent.pointerDown(title, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    // The grid shows for as long as the frame is held.
    expect(document.querySelector('[data-testid="design-snap-grid"]')).not.toBeNull();
    // 103 canvas px down: within reach of B's top (100), so A's top and bottom
    // both meet B's, and both get a line running between the frames.
    fireEvent.pointerMove(title, {
      pointerId: 1,
      clientX: screenDelta(4),
      clientY: screenDelta(103),
    });
    await waitFor(() => expect(guides()).toHaveLength(2));
    const lines = Array.from(guides()) as HTMLElement[];
    expect(lines.map((line) => line.dataset.axis)).toEqual(["y", "y"]);
    expect(lines.map((line) => line.className.includes("bg-red-500"))).toEqual([true, true]);
    expect(lines.map((line) => [line.style.left, line.style.width])).toEqual([
      ["0px", "1000px"],
      ["0px", "1000px"],
    ]);
    await waitFor(() => expect(frameSection(frameA).style.top).toBe("100px"));
    // Away from B's edges the corner rides the 10 px grid instead.
    expect(frameSection(frameA).style.left).toBe("0px");

    fireEvent.pointerUp(title, { pointerId: 1 });
    await waitFor(() => expect(frameMoves()).toHaveLength(1));
    expect(frameMoves()[0]).toEqual({
      kind: "update_frame",
      frameId: frameA,
      patch: { x: 0, y: 100 },
    });
    expect(guides()).toHaveLength(0);
    expect(document.querySelector('[data-testid="design-snap-grid"]') === null).toBe(true);
  });

  test("away from other frames a drag snaps to the grid, and Alt moves freely", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    fireEvent.pointerDown(title, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(title, {
      pointerId: 1,
      clientX: screenDelta(-37),
      clientY: screenDelta(-1004),
    });
    fireEvent.pointerUp(title, { pointerId: 1 });
    await waitFor(() => expect(frameMoves()).toHaveLength(1));
    expect(frameMoves()[0]!.patch).toEqual({ x: -40, y: -1000 });

    const titleB = screen.getByRole("button", { name: "Move frame B" });
    fireEvent.pointerDown(titleB, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(titleB, {
      pointerId: 2,
      clientX: screenDelta(7),
      clientY: screenDelta(3),
      altKey: true,
    });
    fireEvent.pointerUp(titleB, { pointerId: 2 });
    await waitFor(() => expect(frameMoves()).toHaveLength(2));
    expect(frameMoves()[1]).toEqual({
      kind: "update_frame",
      frameId: frameB,
      patch: { x: 607, y: 103 },
    });
  });

  test("Shift-drag draws a selection box that selects frames, and the group moves together", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const titleA = await screen.findByRole("button", { name: "Move frame A" });
    const viewport = screen.getByRole("main", { name: "Canvas viewport" });

    // A press alone is not a box yet.
    fireEvent.pointerDown(viewport, {
      button: 0,
      pointerId: 3,
      shiftKey: true,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 1, clientY: 1 });
    expect(document.querySelector('[data-testid="design-marquee"]') === null).toBe(true);
    // Over A only (canvas x up to about 200).
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 175, clientY: 200 });
    const box = document.querySelector<HTMLElement>('[data-testid="design-marquee"]')!;
    expect(box).not.toBeNull();
    expect([box.style.width, box.style.height]).toEqual(["175px", "200px"]);
    await waitFor(() => expect(selected(frameA)).toBe(true));
    expect(selected(frameB)).toBe(false);
    // Grown over B as well.
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 500, clientY: 300 });
    await waitFor(() => expect(selected(frameB)).toBe(true));
    fireEvent.pointerUp(viewport, { pointerId: 3 });
    expect(document.querySelector('[data-testid="design-marquee"]') === null).toBe(true);
    expect(await screen.findByText("2 frames selected")).toBeTruthy();
    expect(selected(frameA)).toBe(true);

    // Dragging one selected frame carries the other with it.
    fireEvent.pointerDown(titleA, { button: 0, pointerId: 4, clientX: 0, clientY: 0 });
    expect(selected(frameB)).toBe(true);
    fireEvent.pointerMove(titleA, { pointerId: 4, clientX: screenDelta(21), clientY: 0 });
    await waitFor(() => expect(frameSection(frameB).style.left).toBe("620px"));
    fireEvent.pointerUp(titleA, { pointerId: 4 });
    await waitFor(() => expect(frameMoves()).toHaveLength(2));
    expect(frameMoves()).toEqual([
      { kind: "update_frame", frameId: frameA, patch: { x: 20, y: 0 } },
      { kind: "update_frame", frameId: frameB, patch: { x: 620, y: 100 } },
    ]);
    expect(selected(frameA) && selected(frameB)).toBe(true);

    // A click without a drag on one of the group selects only it.
    fireEvent.pointerDown(titleA, { button: 0, pointerId: 5, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(titleA, { pointerId: 5 });
    fireEvent.click(titleA, { detail: 1 });
    await waitFor(() => expect(selected(frameB)).toBe(false));
    expect(selected(frameA)).toBe(true);
  });

  test.each([0, 1, 2.9])(
    "off-grid selection clicks with %s screen px of travel do not move a group",
    async (travel) => {
      const a = backend.frames.get(frameA)!;
      a.frame = { ...a.frame, x: 13, y: 7 };
      renderInAppCommandScope(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const title = await screen.findByRole("button", { name: "Move frame A" });
      fireEvent.click(title);
      // Single-frame click, including an explicit zero-length pointermove.
      fireEvent.pointerDown(title, { button: 0, pointerId: 11, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(title, { pointerId: 11, clientX: 20 + travel, clientY: 20 });
      fireEvent.pointerUp(title, { pointerId: 11 });
      expect(frameMoves()).toHaveLength(0);
      expect(frameSection(frameA).style.left).toBe("13px");
      fireEvent.click(screen.getByRole("button", { name: "Move frame B" }), { shiftKey: true });
      expect(selected(frameA) && selected(frameB)).toBe(true);
      fireEvent.pointerDown(title, { button: 0, pointerId: 12, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(title, { pointerId: 12, clientX: 20 + travel, clientY: 20 });
      fireEvent.pointerUp(title, { pointerId: 12 });
      expect(frameMoves()).toHaveLength(0);
      expect(selected(frameA)).toBe(true);
      expect(selected(frameB)).toBe(false);
      expect(frameSection(frameA).style.left).toBe("13px");
      expect(frameSection(frameB).style.left).toBe("600px");
    },
  );

  test("a real off-grid drag snaps after activation, and Escape reverts every group member", async () => {
    const a = backend.frames.get(frameA)!;
    a.frame = { ...a.frame, x: 13 };
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    fireEvent.click(title);
    fireEvent.click(screen.getByRole("button", { name: "Move frame B" }), { shiftKey: true });
    fireEvent.pointerDown(title, { button: 0, pointerId: 13, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(title, { pointerId: 13, clientX: screenDelta(21), clientY: 0 });
    await waitFor(() => expect(frameSection(frameA).style.left).toBe("30px"));
    expect(frameSection(frameB).style.left).toBe("617px");
    fireEvent.keyDown(title, { key: "Escape" });
    fireEvent.pointerUp(title, { pointerId: 13 });
    await waitFor(() => expect(frameSection(frameA).style.left).toBe("13px"));
    expect(frameSection(frameB).style.left).toBe("600px");
    expect(frameMoves()).toHaveLength(0);
    expect(selected(frameA) && selected(frameB)).toBe(true);
  });

  test("a refreshed companion move during a held drag conflicts instead of being overwritten", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const title = await screen.findByRole("button", { name: "Move frame A" });
    fireEvent.click(title);
    fireEvent.click(screen.getByRole("button", { name: "Move frame B" }), { shiftKey: true });
    fireEvent.pointerDown(title, { button: 0, pointerId: 14, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(title, { pointerId: 14, clientX: screenDelta(20), clientY: 0 });
    const b = backend.frames.get(frameB)!;
    b.frame = { ...b.frame, x: 900, revision: b.frame.revision + 1 };
    backend.revision++;
    await act(() => designController("env-1", canvasId).refresh());
    fireEvent.pointerUp(title, { pointerId: 14 });
    await waitFor(() => expect(frameMoves()).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getAllByText(/revision conflict/i).length).toBeGreaterThan(0),
    );
    expect(backend.frames.get(frameB)!.frame.x).toBe(900);
    const companion = backend.calls
      .filter((call) => call.command === "design_intent_run")
      .map((call) => (call.args.intent as { descriptor: DesignOperationDescriptor }).descriptor)
      .find(
        (descriptor) =>
          descriptor.input.kind === "update_frame" && descriptor.input.frameId === frameB,
      )!;
    expect(companion.preconditions.frameRevision).toBe(1);
  });

  test("a companion's own pending move can acknowledge during the drag and still rebase", async () => {
    const gate = deferred();
    backend.executeBarrier = async (descriptor) => {
      if (descriptor.input.kind === "update_frame" && descriptor.input.patch.x === 610)
        await gate.promise;
    };
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const titleA = await screen.findByRole("button", { name: "Move frame A" });
    const titleB = screen.getByRole("button", { name: "Move frame B" });
    fireEvent.keyDown(titleB, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(frameSection(frameB).style.left).toBe("610px"));
    fireEvent.click(titleA);
    fireEvent.click(titleB, { shiftKey: true });
    fireEvent.pointerDown(titleA, { button: 0, pointerId: 15, clientX: 0, clientY: 0 });
    await act(async () => gate.resolve());
    await waitFor(() => expect(backend.frames.get(frameB)!.frame.x).toBe(610));
    await act(() => designController("env-1", canvasId).refresh());
    fireEvent.pointerMove(titleA, { pointerId: 15, clientX: screenDelta(20), clientY: 0 });
    fireEvent.pointerUp(titleA, { pointerId: 15 });
    await waitFor(() => expect(backend.frames.get(frameB)!.frame.x).toBe(630));
    expect(backend.frames.get(frameB)!.frame.revision).toBe(3);
    expect(backend.frames.get(frameA)!.frame.x).toBe(20);
  });

  test.each([
    { dx: 17, dy: 13, free: false, width: 420, height: 310 },
    { dx: 17, dy: 13, free: true, width: 417, height: 313 },
    { dx: 199, dy: 99, free: false, width: 600, height: 400 },
    { dx: -1000, dy: -1000, free: false, width: 32, height: 32 },
    { dx: 10000, dy: 10000, free: false, width: 4096, height: 4096 },
  ])(
    "the resize handle snaps or bypasses and clamps dimensions: %j",
    async ({ dx, dy, free, width, height }) => {
      renderInAppCommandScope(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const handle = await screen.findByRole("button", { name: "Resize frame A" });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 15, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, {
        pointerId: 15,
        clientX: screenDelta(dx),
        clientY: screenDelta(dy),
        altKey: free,
      });
      await waitFor(() => expect(frameSection(frameA).style.width).toBe(`${width}px`));
      expect(frameSection(frameA).style.height).toBe(`${height}px`);
      fireEvent.pointerUp(handle, { pointerId: 15 });
      await waitFor(() => expect(frameMoves()).toHaveLength(1));
      expect(frameMoves()[0]!.patch).toEqual({ width, height });
    },
  );

  test.each(["Escape", "pointerCancel", "lostPointerCapture"])(
    "resize cancellation by %s submits nothing",
    async (cancel) => {
      renderInAppCommandScope(
        <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
      );
      const handle = await screen.findByRole("button", { name: "Resize frame A" });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 16, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, {
        pointerId: 16,
        clientX: screenDelta(50),
        clientY: screenDelta(50),
      });
      await waitFor(() => expect(frameSection(frameA).style.width).toBe("450px"));
      if (cancel === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
      else if (cancel === "pointerCancel") fireEvent.pointerCancel(handle, { pointerId: 16 });
      else fireEvent.lostPointerCapture(handle, { pointerId: 16 });
      fireEvent.pointerUp(handle, { pointerId: 16 });
      await waitFor(() => expect(frameSection(frameA).style.width).toBe("400px"));
      expect(frameMoves()).toHaveLength(0);
    },
  );

  test("Escape drops a selection box and restores the selection it started from", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    await screen.findByRole("button", { name: "Move frame A" });
    const viewport = screen.getByRole("main", { name: "Canvas viewport" });
    fireEvent.pointerDown(viewport, {
      button: 0,
      pointerId: 6,
      shiftKey: true,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(viewport, { pointerId: 6, clientX: 500, clientY: 300 });
    await waitFor(() => expect(selected(frameA) && selected(frameB)).toBe(true));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(selected(frameA) || selected(frameB)).toBe(false));
    expect(document.querySelector('[data-testid="design-marquee"]') === null).toBe(true);
    // The rest of the press does nothing more.
    fireEvent.pointerMove(viewport, { pointerId: 6, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(viewport, { pointerId: 6 });
    expect(selected(frameA) || selected(frameB)).toBe(false);
  });

  test("a Shift-press without a drag keeps the selection", async () => {
    renderInAppCommandScope(
      <DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive ownsGlobalShortcuts />,
    );
    const titleA = await screen.findByRole("button", { name: "Move frame A" });
    fireEvent.click(titleA);
    await waitFor(() => expect(selected(frameA)).toBe(true));
    const viewport = screen.getByRole("main", { name: "Canvas viewport" });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, shiftKey: true });
    fireEvent.pointerUp(viewport, { pointerId: 7 });
    expect(selected(frameA)).toBe(true);
    // A plain press on the background still clears it.
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 8 });
    await waitFor(() => expect(selected(frameA)).toBe(false));
  });
});
