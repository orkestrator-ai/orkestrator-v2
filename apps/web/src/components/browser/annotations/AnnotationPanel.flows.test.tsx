import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useAnnotationUiTestBudget } from "@/test/web-annotation-harness";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BROWSER_PREVIEW_CAPTURE_EVENT } from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_CAPACITY,
  formatWebAnnotationError,
  type WebAnnotationEntry,
} from "@orkestrator/protocol/web-annotations";
import { fixtureEntry } from "@orkestrator/protocol/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  flush,
  panelState,
  seedBrowserLayout,
} from "@/test/web-annotation-harness";

let backend: FakeWebAnnotationBackend;
let capture: ReturnType<typeof createFakeCaptureApi>;
let bus: ReturnType<typeof installFakeOrkestrator>;
const OriginalResizeObserver = globalThis.ResizeObserver;

/** Report a fixed container width to the layout's ResizeObserver. */
function useContainerWidth(width: number) {
  class FixedResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = FixedResizeObserver as unknown as typeof ResizeObserver;
}

function entries(annotationId: string, count: number): WebAnnotationEntry[] {
  return Array.from({ length: count }, (_, index) =>
    fixtureEntry({
      id: `entry-${index + 1}`,
      annotationId,
      sequence: index + 1,
      body: `Comment number ${index + 1}`,
    }),
  );
}

describe("annotation panel flows", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = OriginalResizeObserver;
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("narrow layout: Add note shows the preview, and a capture returns to the notes", async () => {
    useContainerWidth(500);
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    const notesTab = await screen.findByRole("tab", { name: "Notes" });
    expect(notesTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    // Choosing Notes mid-selection keeps the selection running.
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await flush();
    expect(capture.mocks.cancelCapture).not.toHaveBeenCalled();
    expect(screen.getByText(/notes open when you finish/)).toBeTruthy();
    capture.complete();
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "captured",
      focus: "editor",
    });
    const comment = await screen.findByRole("textbox", { name: /Comment for/ });
    expect(screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(comment));
  });

  test("keyboard only: open a note from the list and return with Escape", async () => {
    backend.seed({ id: "annotation-k", title: "A very long title ".repeat(12).trim() });
    seedBrowserLayout({ open: true, filter: { scope: "all", state: "open" } });
    render(<AnnotationHarness />);
    const open = await screen.findByRole("button", { name: /Open note: A very long title/ });
    open.focus();
    fireEvent.click(open);
    await waitFor(() => expect(panelState()?.selectedAnnotationId).toBe("annotation-k"));
    const heading = await screen.findByRole("heading", { name: /A very long title/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.keyDown(heading, { key: "Escape" });
    await waitFor(() => expect(panelState()?.selectedAnnotationId ?? null).toBeNull());
  });

  test("a full thread offers archive-and-continue and moves the unsent reply", async () => {
    backend.seed({ id: "annotation-full", title: "Full thread" });
    backend.fail(
      "web_annotation_entry_append",
      new Error(
        formatWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} thread is full`, {
          code: "capacity",
          resource: "thread-entries",
          used: 500,
          limit: 500,
          archivable: true,
        }),
      ),
    );
    backend.capabilities!.operations.archive = true;
    const archive = mock((args: Record<string, unknown>) => {
      backend.seed({ id: "annotation-next", title: "Full thread (continued)" });
      return {
        continuation: {
          operationId: args.operationId,
          annotationId: "annotation-next",
          captureId: "capture-annotation-next",
          entryId: null,
          contentRevision: 1,
          metadataRevision: 1,
          captureRevision: 1,
          environmentRevision: backend.bump(["annotation-full", "annotation-next"]),
        },
        archivedAnnotationId: "annotation-full",
        archivedMetadataRevision: 2,
      };
    });
    backend.overrides.set("web_annotation_archive", archive);
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-full" });
    render(<AnnotationHarness />);
    const reply = await screen.findByRole("textbox", { name: "Reply to Full thread" });
    fireEvent.change(reply, { target: { value: "One more thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    const button = await screen.findByRole("button", { name: "Archive and continue" });
    expect(screen.getByText(/This discussion is full, so the reply/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("[web-annotation-error");
    fireEvent.click(button);
    await waitFor(() => expect(archive).toHaveBeenCalled());
    expect(archive.mock.calls[0]![0]).toMatchObject({
      annotationId: "annotation-full",
      body: "One more thought",
    });
    await waitFor(() => expect(panelState()?.selectedAnnotationId).toBe("annotation-next"));
  });

  test("an archived thread is read-only and links to its continuation", async () => {
    backend.seed({
      id: "annotation-old",
      title: "Old thread",
      archivedAt: "2026-09-21T12:00:00.000Z",
      continuationId: "annotation-new",
    });
    backend.seed({ id: "annotation-new", title: "New thread", continuedFromId: "annotation-old" });
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-old" });
    render(<AnnotationHarness />);
    await screen.findByText(/read-only history/);
    expect(screen.queryByRole("textbox", { name: /Reply to/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open the continued note" }));
    await waitFor(() => expect(panelState()?.selectedAnnotationId).toBe("annotation-new"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the archived earlier discussion" }),
    );
    await waitFor(() => expect(panelState()?.selectedAnnotationId).toBe("annotation-old"));
  });

  test("older history is paged with beforeSequence and merged in order", async () => {
    const all = entries("annotation-long", 60);
    backend.seed({ id: "annotation-long", title: "Long thread", lastSequence: 60 }, all);
    const get = backend.overrides;
    get.set("web_annotation_get", (args) => {
      const result = (
        backend as unknown as { get: (input: unknown) => Record<string, unknown> }
      ).get(args);
      return { ...result, entries: all.slice(10), previousEntrySequence: 11 };
    });
    get.set("web_annotation_entries", (args) => ({
      entries: all.filter((entry) => entry.sequence < Number(args.beforeSequence)),
      nextSequence: null,
      previousSequence: null,
      resetRequired: false,
    }));
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-long" });
    render(<AnnotationHarness />);
    await screen.findByText("Comment number 11");
    expect(screen.queryByText("Comment number 1") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show older entries" }));
    await screen.findByText("Comment number 1");
    const call = backend.callsOf("web_annotation_entries")[0]!.args;
    expect(call).toMatchObject({ afterSequence: 0, beforeSequence: 11 });
    const texts = Array.from(document.querySelectorAll("[data-entry-kind] p")).map(
      (node) => node.textContent,
    );
    expect(texts.indexOf("Comment number 1")).toBeLessThan(texts.indexOf("Comment number 60"));
    expect(screen.queryByRole("button", { name: "Show older entries" }) === null).toBe(true);
  });

  test("pins are re-sent after a reload and live results update labels", async () => {
    backend.seed({ id: "annotation-pin", title: "Pinned" });
    const getPinResults = mock(async () => ({
      tabId: "browser-1",
      documentGeneration: 2,
      revision: 2,
      diagnostics: null,
      results: [
        {
          annotationId: "annotation-pin",
          resolution: {
            state: "too-complex" as const,
            rule: "none" as const,
            candidateCount: 0,
            documentGeneration: 2,
            rect: null,
          },
        },
      ],
    }));
    Object.assign(capture.api, { getPinResults });
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    await waitFor(() => expect(capture.mocks.showPins).toHaveBeenCalled());
    const pinsCall = capture.mocks.showPins.mock.calls.at(-1)![0] as {
      pins: Array<{ capture?: { viewport: unknown } }>;
    };
    expect(pinsCall.pins[0]?.capture?.viewport).toBeTruthy();
    const sent = capture.mocks.showPins.mock.calls.length;
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "pins-invalidated",
      documentGeneration: 2,
    });
    await waitFor(() => expect(capture.mocks.showPins.mock.calls.length).toBe(sent + 1));
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "pins-changed",
      documentGeneration: 2,
    });
    expect(await screen.findByText(/too large to search in time/)).toBeTruthy();
  });

  test("Show on page uses the desktop flow and explains each outcome", async () => {
    backend.seed({ id: "annotation-show", title: "Show me" });
    const showOnPage = mock(async () => ({
      outcome: "timeout" as const,
      navigated: true,
      documentGeneration: 3,
      resolution: {
        state: "missing" as const,
        rule: "none" as const,
        candidateCount: 0,
        documentGeneration: 3,
        rect: null,
      },
    }));
    Object.assign(capture.api, { showOnPage });
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-show" });
    render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Show “Show me” on the page" }));
    expect((await screen.findAllByText(/did not finish loading in time/)).length).toBeGreaterThan(
      0,
    );
    expect(showOnPage).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "browser-1", timeoutMs: 10_000 }),
    );
  });

  test("an environment switch while a save is in flight keeps the draft and commits once", async () => {
    seedBrowserLayout({ open: true });
    const view = render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
    capture.complete();
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "captured",
    });
    const comment = await screen.findByRole("textbox", { name: /Comment for/ });
    fireEvent.change(comment, { target: { value: "In flight" } });
    const hold = backend.hold("web_annotation_create");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_create")).toHaveLength(1));
    // Switch away (unmount) while the backend is still answering.
    view.unmount();
    hold.release();
    await flush();
    // Returning finds the committed note and clears the local copy once.
    seedBrowserLayout({ open: true, filter: { scope: "all", state: "open" } });
    render(<AnnotationHarness />);
    await screen.findByRole("button", { name: /Open note/ });
    await waitFor(() => expect(capture.spool.size).toBe(0));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
  });
});
