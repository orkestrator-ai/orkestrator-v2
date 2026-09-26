import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "./design-client";
import { FakeBackend, canvasId, deferred, frameA, frameB } from "./design-test-backend";

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
      expect(document.querySelector(`[data-frame-id="${frameA}"]`)).toBeNull(),
    );
    expect(document.querySelector(`[data-frame-id="${frameB}"]`)).not.toBeNull();
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
    await waitFor(() => expect(frame()).toBeNull());
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
