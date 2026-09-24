import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { resetDesignControllers } from "./design-controller";
import { resetCapabilities } from "./design-client";
import { FakeBackend, canvasId } from "./design-test-backend";

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
