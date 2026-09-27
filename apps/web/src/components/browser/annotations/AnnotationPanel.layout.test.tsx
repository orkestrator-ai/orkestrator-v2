import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BROWSER_PREVIEW_CAPTURE_EVENT } from "@orkestrator/protocol/browser-preview";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  flush,
  PAGE_URL,
  seedBrowserLayout,
  useAnnotationUiTestBudget,
} from "@/test/web-annotation-harness";

let backend: FakeWebAnnotationBackend;
let capture: ReturnType<typeof createFakeCaptureApi>;
let bus: ReturnType<typeof installFakeOrkestrator>;
const OriginalResizeObserver = globalThis.ResizeObserver;

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

function selectedTab() {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.textContent;
}

/** Two environments in the layout, each with its own browser tab. */
function seedTwoEnvironments() {
  seedBrowserLayout({ open: true });
  const first = usePaneLayoutStore.getState().environments.get("env-1")!;
  usePaneLayoutStore.setState({
    environments: new Map([
      ["env-1", first],
      [
        "env-2",
        {
          root: {
            kind: "leaf",
            id: "pane-2",
            tabs: [
              {
                id: "browser-1",
                type: "browser",
                browserData: { url: PAGE_URL, annotationPanel: { open: true } },
              },
            ],
            activeTabId: "browser-1",
          },
          activePaneId: "pane-2",
          containerId: null,
        },
      ],
    ]),
  });
}

async function captureOnce() {
  fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
  await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
  capture.complete();
  bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
    tabId: "browser-1",
    captureId: null,
    status: "captured",
    focus: "editor",
  });
  return screen.findByRole("textbox", { name: /Comment for/ });
}

describe("annotation panel layout and lifecycle", () => {
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

  test("narrow layout: cancelling a selection started from Preview stays on Preview", async () => {
    useContainerWidth(500);
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("tab", { name: "Preview" }));
    expect(selectedTab()).toBe("Preview");
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
    const cancel = (await screen.findAllByRole("button", { name: "Cancel selection" }))[0]!;
    capture.setStatus({ status: "inactive" });
    fireEvent.click(cancel);
    await waitFor(() => expect(capture.mocks.cancelCapture).toHaveBeenCalled());
    await flush();
    expect(selectedTab()).toBe("Preview");
  });

  test("keyboard only at a narrow width: Escape cancels a selection and focus returns", async () => {
    useContainerWidth(500);
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    const add = await screen.findByRole("button", { name: "Add note" });
    add.focus();
    fireEvent.click(add);
    await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
    const panel = screen.getByRole("complementary", { name: "Page annotations" });
    const cancel = await within(panel).findByRole("button", { name: "Cancel selection" });
    capture.setStatus({ status: "inactive" });
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(capture.mocks.cancelCapture).toHaveBeenCalled());
    // Escape ended only the selection; focus is back on the control that
    // started it and the panel is still open.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Add note" })),
    );
    expect(screen.getByRole("complementary", { name: "Page annotations" })).toBeTruthy();
  });

  test("switching environments mid-save commits once and the note is there on return", async () => {
    seedTwoEnvironments();
    const view = render(<AnnotationHarness environmentId="env-1" />);
    const comment = await captureOnce();
    fireEvent.change(comment, { target: { value: "Saved across a switch" } });
    const hold = backend.hold("web_annotation_create");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_create")).toHaveLength(1));
    // The same browser tab id now shows another environment.
    view.rerender(<AnnotationHarness environmentId="env-2" />);
    hold.release();
    await flush();
    view.rerender(<AnnotationHarness environmentId="env-1" />);
    await waitFor(() => expect(capture.spool.size).toBe(0));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
    expect(
      Array.from(backend.annotations.values()).some(
        (annotation) => annotation.environmentId === "env-1",
      ),
    ).toBe(true);
  });

  test("a lost save response is resumed after reload from the receipt, never duplicated", async () => {
    seedBrowserLayout({ open: true });
    const view = render(<AnnotationHarness />);
    const comment = await captureOnce();
    fireEvent.change(comment, { target: { value: "Lost response" } });
    backend.fail("web_annotation_create", new Error("socket closed"), { afterCommit: true });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_create")).toHaveLength(1));
    view.unmount();
    render(<AnnotationHarness />);
    await waitFor(() => expect(capture.spool.size).toBe(0));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
  });

  test("an empty save keeps capture-only context as a backend draft and states the expiry", async () => {
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    await captureOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_draft_save")[0]?.args).toMatchObject({
        pendingCaptureId: "cap-1",
        text: "",
      }),
    );
    expect(await screen.findByText(/Kept as an unpublished draft/)).toBeTruthy();
    expect(backend.callsOf("web_annotation_create")).toHaveLength(0);
  });

  test("unsaved captures are counted on the closed Notes control", async () => {
    seedPending(capture.spool, { captureId: "cap-9" });
    seedBrowserLayout({ open: false });
    render(<AnnotationHarness />);
    const button = await screen.findByRole("button", { name: /1 unsaved capture/ });
    expect(button.querySelector("[data-unsaved-captures]")?.textContent).toBe("1 unsaved");
  });

  test("a backend that turned annotations off still explains itself in the panel", async () => {
    backend.capabilities = { ...backend.capabilities!, mode: "disabled" };
    seedBrowserLayout({ open: true });
    render(<AnnotationHarness />);
    expect(await screen.findByText(/Web annotations are turned off on this backend/)).toBeTruthy();
    expect(document.querySelector("[data-annotations-disabled]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add note" }) === null).toBe(true);
  });
});
