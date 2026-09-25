import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesignCanvas, DesignHistoryStatus } from "@orkestrator/protocol/design-canvas";
import type {
  DesignCheckpointPreview,
  DesignHistoryEntrySummary,
  DesignHistoryPage,
} from "@orkestrator/protocol/design-operations";
import { emptyProjection, type DesignIntent, type DesignProjection } from "@/stores/designStore";
import type { DesignCanvasController } from "./design-controller";
import { DesignHistoryPanel, type DesignHistoryApi } from "./DesignHistoryPanel";

const canvasId = "canvas-1";
const environmentId = "env-1";

const canvas: DesignCanvas = {
  format: "orkdes",
  version: 1,
  id: canvasId,
  environmentId,
  name: "Landing",
  revision: 7,
  frames: [
    {
      id: "hero",
      name: "Hero",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      html: "<main>New</main>",
      revision: 4,
    },
  ],
};

function entry(
  id: string,
  patch: Partial<DesignHistoryEntrySummary> = {},
): DesignHistoryEntrySummary {
  return {
    id,
    kind: "replace_frame_html",
    label: `Edit ${id}`,
    actor: "user",
    createdAt: new Date().toISOString(),
    canvasRevisionBefore: 4,
    canvasRevisionAfter: 5,
    frames: [{ frameId: "hero", name: "Hero", before: 2, after: 3 }],
    undone: false,
    protected: false,
    bytes: 2048,
    ...patch,
  };
}

function page(
  entries: DesignHistoryEntrySummary[],
  patch: Partial<DesignHistoryPage> = {},
): DesignHistoryPage {
  return {
    entries,
    total: entries.length,
    bytes: 4096,
    limits: { entries: 50, bytes: 64 * 1024 * 1024 },
    ...patch,
  };
}

function projection(
  patch: Partial<DesignProjection> = {},
  history: Partial<DesignHistoryStatus> = {},
): DesignProjection {
  return {
    ...emptyProjection("key", environmentId, canvasId),
    snapshot: "current",
    canvas,
    revision: 7,
    statusVersion: 1,
    workspace: {
      recordSequence: 1,
      statusVersion: 1,
      incarnation: "i",
      createdAt: "",
      modifiedAt: "",
      frames: {},
      sessions: [],
      history: {
        revision: 7,
        undoCount: 1,
        redoCount: 0,
        canUndo: true,
        canRedo: false,
        undoLabel: "Edit a",
        ...history,
      },
    },
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const history = mock<DesignHistoryApi["history"]>();
const checkpoint = mock<DesignHistoryApi["checkpoint"]>();
const api: DesignHistoryApi = { history, checkpoint };
const submit = mock((_input: unknown) => "intent-1");
const controller = { submit } as unknown as DesignCanvasController;
const onUseAsReference = mock((_id: string) => {});

function renderPanel(current: DesignProjection, focusFrameId: string | null = null) {
  const props = {
    controller,
    environmentId,
    canvasId: current.canvasId,
    focusFrameId,
    onClose: () => {},
    onUseAsReference,
    api,
  };
  const view = render(<DesignHistoryPanel {...props} projection={current} />);
  return {
    ...view,
    update: (next: DesignProjection, extra: Partial<typeof props> = {}) =>
      view.rerender(<DesignHistoryPanel {...props} {...extra} projection={next} />),
  };
}

function row(label: string) {
  return screen.getByText(label).closest("li") as HTMLElement;
}

beforeEach(() => {
  history.mockReset();
  checkpoint.mockReset();
  submit.mockClear();
  onUseAsReference.mockClear();
});

afterEach(() => cleanup());

describe("DesignHistoryPanel", () => {
  test("pages with Load more and labels own, agent and system edits", async () => {
    history
      .mockResolvedValueOnce(
        page([entry("a"), entry("b", { actor: "agent", label: "Agent rewrote hero" })], {
          total: 3,
          nextOffset: 2,
        }),
      )
      .mockResolvedValueOnce(
        page([entry("c", { actor: "system", label: "Migrated", undone: true })], { total: 3 }),
      );

    renderPanel(projection());

    expect(await screen.findByText("Edit a")).toBeTruthy();
    expect(history).toHaveBeenCalledWith(environmentId, canvasId, 0, 20);
    expect(within(row("Edit a")).getByText("You")).toBeTruthy();
    expect(within(row("Agent rewrote hero")).getByText("Agent")).toBeTruthy();
    expect(screen.getByText(/3 of 50 entries · 4.0 KB of 64.0 MB/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Migrated")).toBeTruthy();
    expect(history).toHaveBeenLastCalledWith(environmentId, canvasId, 2, 20);
    expect(within(row("Migrated")).getByText("System")).toBeTruthy();
    expect(within(row("Migrated")).getByText("Undone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" }) === null).toBe(true);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  test("restore asks for confirmation with the affected scope and submits the checkpoint descriptor", async () => {
    history.mockResolvedValue(page([entry("a", { label: "Recolor hero" })]));
    const view = renderPanel(projection());
    await screen.findByText("Recolor hero");

    fireEvent.click(
      within(row("Recolor hero")).getByRole("button", { name: "Restore this version" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/This replaces Hero with the version from revision 4/),
    ).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(submit).toHaveBeenCalledWith({
      descriptor: {
        input: { kind: "restore_checkpoint", entryId: "a", side: "before" },
        preconditions: { canvasRevision: 7 },
      },
      label: "Restore before “Recolor hero”",
      lane: "canvas",
    });

    const rejected: DesignIntent = {
      id: "intent-1",
      environmentId,
      canvasId,
      lane: "canvas",
      descriptor: {
        input: { kind: "restore_checkpoint", entryId: "a", side: "before" },
        preconditions: {},
      },
      label: "Restore",
      createdAt: 0,
      phase: "settled",
      outcome: "rejected",
      failure: {
        code: "conflict",
        message: "Revision conflict",
        retry: "after-refresh",
        revisions: { current: 8 },
      },
    };
    view.update(projection({ intents: [rejected] }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The design changed before this could be applied (now revision 8)",
    );
    view.update(projection({ intents: [] }));
    expect(screen.getByRole("status").textContent).toContain("no longer tracked");
    expect(screen.getByRole("status").textContent).not.toContain("applied");
    view.update(
      projection({ intents: [{ ...rejected, failure: undefined, outcome: "committed" }] }),
    );
    expect(screen.getByRole("status").textContent).toContain("applied");
  });

  test("undo submits an own-scope canvas operation at the current revision", async () => {
    history.mockResolvedValue(page([entry("a")]));
    renderPanel(projection());
    await screen.findByText("Edit a");

    fireEvent.click(screen.getByRole("button", { name: /Undo Edit a/ }));
    expect(submit).toHaveBeenCalledWith({
      descriptor: { input: { kind: "undo", scope: "own" }, preconditions: { canvasRevision: 7 } },
      label: "Undo Edit a",
      lane: "canvas",
    });
  });

  test("a blocked undo explains why and offers the checkpoint instead", async () => {
    history.mockResolvedValue(
      page([entry("agent", { actor: "agent", label: "Agent edit" }), entry("mine")]),
    );
    checkpoint.mockResolvedValue({
      entryId: "mine",
      side: "before",
      frames: [{ frameId: "hero", frame: { ...canvas.frames[0]!, html: "<main>Old</main>" } }],
    } satisfies DesignCheckpointPreview);
    renderPanel(
      projection(
        {},
        { canUndo: false, undoBlockedReason: "The agent changed Hero after your edit" },
      ),
    );
    await screen.findByText("Edit mine");

    expect(
      screen.getByText(/Undo is unavailable: The agent changed Hero after your edit/),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the checkpoint instead" }));
    await waitFor(() =>
      expect(checkpoint).toHaveBeenCalledWith(environmentId, canvasId, "mine", "before"),
    );
    expect(await screen.findByText("Checkpoint · revision 4")).toBeTruthy();
    expect(screen.getByText("Current · revision 7")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  test("preview is an explicit read and compare labels both revisions", async () => {
    history.mockResolvedValue(page([entry("a")]));
    checkpoint.mockImplementation(async (_env, _canvas, entryId, side) => ({
      entryId,
      side,
      frames: [{ frameId: "hero", frame: { ...canvas.frames[0]!, html: `<main>${side}</main>` } }],
    }));
    renderPanel(projection());
    await screen.findByText("Edit a");
    expect(checkpoint).not.toHaveBeenCalled();

    fireEvent.click(within(row("Edit a")).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Hero · revision 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "After this edit" }));
    expect(await screen.findByText("Hero · revision 5")).toBeTruthy();
    expect(checkpoint).toHaveBeenLastCalledWith(environmentId, canvasId, "a", "after");

    fireEvent.click(within(row("Edit a")).getByRole("button", { name: "Compare with current" }));
    expect(await screen.findByText("Checkpoint · revision 5")).toBeTruthy();
    expect(screen.getByText("Current · revision 7")).toBeTruthy();
    // Switching preview to compare reuses the loaded checkpoint.
    expect(checkpoint).toHaveBeenCalledTimes(2);

    fireEvent.click(
      within(row("Edit a")).getByRole("button", { name: "Use as implementation reference" }),
    );
    expect(onUseAsReference).toHaveBeenCalledWith("a");
  });

  test("ignores a late response from an older request", async () => {
    const first = deferred<DesignHistoryPage>();
    history
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page([entry("new", { label: "Newest" })]));
    const view = renderPanel(projection());

    view.update(projection({ revision: 8 }));
    expect(await screen.findByText("Newest")).toBeTruthy();
    await act(async () => first.resolve(page([entry("old", { label: "Outdated" })])));

    expect(screen.queryByText("Outdated") === null).toBe(true);
    expect(screen.getByText("Newest")).toBeTruthy();
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("ignores a response for a different canvas", async () => {
    const first = deferred<DesignHistoryPage>();
    history
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page([entry("b", { label: "Other canvas edit" })]));
    const view = renderPanel(projection());

    view.update({ ...projection(), canvasId: "canvas-2" }, { canvasId: "canvas-2" });
    expect(await screen.findByText("Other canvas edit")).toBeTruthy();
    await act(async () => first.resolve(page([entry("a", { label: "First canvas edit" })])));
    expect(screen.queryByText("First canvas edit") === null).toBe(true);
    expect(history).toHaveBeenLastCalledWith(environmentId, "canvas-2", 0, 20);
  });

  test("focuses entries that changed the requested frame", async () => {
    history.mockResolvedValue(
      page([
        entry("a", { label: "Hero change" }),
        entry("b", { label: "Footer change", frames: [{ frameId: "footer", name: "Footer" }] }),
      ]),
    );
    renderPanel(projection(), "hero");
    expect(await screen.findByText("Hero change")).toBeTruthy();
    expect(screen.queryByText("Footer change") === null).toBe(true);
    expect(screen.getByText("Showing changes to Hero")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Footer change")).toBeTruthy();
  });
});
