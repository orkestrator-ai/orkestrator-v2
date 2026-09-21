import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesignCanvas, DesignHistoryStatus } from "@orkestrator/protocol/design-canvas";

const canvasId = "00000000-0000-4000-8000-000000000001";
let canvas: DesignCanvas;
let history: DesignHistoryStatus;

const designAction = mock(
  async (_environmentId: string, action: string, input: Record<string, unknown>) => {
    if (action === "history_status") return history;
    if (action !== "undo" && action !== "redo") return undefined;
    expect(input).toEqual({ canvasId, expectedRevision: canvas.revision });
    canvas = { ...canvas, revision: canvas.revision + 1 };
    history =
      action === "undo"
        ? {
            revision: canvas.revision,
            undoCount: history.undoCount - 1,
            redoCount: history.redoCount + 1,
            canUndo: history.undoCount > 1,
            canRedo: true,
          }
        : {
            revision: canvas.revision,
            undoCount: history.undoCount + 1,
            redoCount: history.redoCount - 1,
            canUndo: true,
            canRedo: history.redoCount > 1,
          };
    return { canvasRevision: canvas.revision, history };
  },
);
const getCanvas = mock(async () => canvas);
const getChanges = mock(
  async (_environmentId: string, _canvasId: string, generation: string | undefined) => ({
    generation: "generation-1",
    revision: canvas.revision,
    reset: generation !== "generation-1",
    events: [],
  }),
);
const getHistory = mock(async () => history);

mock.module("./design-client", () => ({ designAction, getCanvas, getChanges, getHistory }));

const { DesignCanvasTab } = await import("./DesignCanvasTab");
const originalOrkestrator = window.orkestrator;
const originalResizeObserver = globalThis.ResizeObserver;

describe("DesignCanvasTab history", () => {
  beforeEach(() => {
    canvas = {
      format: "orkdes",
      version: 1,
      id: canvasId,
      environmentId: "env-1",
      name: "History design",
      revision: 5,
      frames: [],
    };
    history = {
      revision: 5,
      undoCount: 2,
      redoCount: 0,
      canUndo: true,
      canRedo: false,
    };
    designAction.mockClear();
    getCanvas.mockClear();
    getChanges.mockClear();
    getHistory.mockClear();
    window.orkestrator = {
      listen: mock(() => () => {}),
    } as unknown as Window["orkestrator"];
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    window.orkestrator = originalOrkestrator;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test("places undo and redo beside save and follows authoritative availability", async () => {
    render(<DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive />);

    const undo = await screen.findByRole("button", { name: "Undo design change" });
    const redo = screen.getByRole("button", { name: "Redo design change" });
    const save = screen.getByRole("button", { name: "Save design to repository" });
    await waitFor(() => expect(undo.hasAttribute("disabled")).toBe(false));
    expect(redo.hasAttribute("disabled")).toBe(true);
    expect(undo.nextElementSibling).toBe(redo);
    expect(redo.nextElementSibling).toBe(save);

    fireEvent.click(undo);
    await waitFor(() =>
      expect(designAction).toHaveBeenCalledWith("env-1", "undo", {
        canvasId,
        expectedRevision: 5,
      }),
    );
    await waitFor(() => expect(redo.hasAttribute("disabled")).toBe(false));
    fireEvent.click(redo);
    await waitFor(() =>
      expect(designAction).toHaveBeenCalledWith("env-1", "redo", {
        canvasId,
        expectedRevision: 6,
      }),
    );
  });

  test("supports undo and redo shortcuts without stealing editable-field history", async () => {
    render(<DesignCanvasTab canvasId={canvasId} environmentId="env-1" isActive />);
    const undo = await screen.findByRole("button", { name: "Undo design change" });
    await waitFor(() => expect(undo.hasAttribute("disabled")).toBe(false));

    const undoEvent = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(undoEvent);
    expect(undoEvent.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(designAction).toHaveBeenCalledWith("env-1", "undo", {
        canvasId,
        expectedRevision: 5,
      }),
    );

    const redo = screen.getByRole("button", { name: "Redo design change" });
    await waitFor(() => expect(redo.hasAttribute("disabled")).toBe(false));
    const redoEvent = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(redoEvent);
    expect(redoEvent.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(designAction).toHaveBeenCalledWith("env-1", "redo", {
        canvasId,
        expectedRevision: 6,
      }),
    );

    const calls = designAction.mock.calls.length;
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(designAction).toHaveBeenCalledTimes(calls);
    input.remove();
  });
});
