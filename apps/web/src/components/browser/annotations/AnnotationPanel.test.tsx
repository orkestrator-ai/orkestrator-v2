import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useAnnotationUiTestBudget } from "@/test/web-annotation-harness";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BROWSER_PREVIEW_CAPTURE_EVENT } from "@orkestrator/protocol/browser-preview";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { imageRedactor } from "@/lib/web-annotations/redaction";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
  PNG,
  seedPending,
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
const originalRedact = imageRedactor.redact;

async function startAndCapture(label = "button “Save”") {
  fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
  await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
  capture.complete({ label });
  bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
    tabId: "browser-1",
    captureId: null,
    status: "captured",
  });
  return screen.findByRole("textbox", { name: `Comment for ${label}` });
}

describe("annotation panel authoring", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
    backend = new FakeWebAnnotationBackend("env-1").install();
    seedBrowserLayout({ open: true });
    useNativeComposeStore.setState({ drafts: new Map() });
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    imageRedactor.redact = originalRedact;
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("creates a note without any agent session and never writes native drafts", async () => {
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    await waitFor(() => expect(document.activeElement).toBe(comment));
    expect(capture.mocks.startCapture).toHaveBeenCalledWith({
      tabId: "browser-1",
      mode: "element",
      environmentId: "env-1",
    });
    fireEvent.change(comment, { target: { value: "Give this button more room." } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalled());
    const commands = backend.calls.map((call) => call.command);
    const receiptIndex = commands.indexOf("web_annotation_operation_receipt");
    const stageIndex = commands.indexOf("web_annotation_asset_stage");
    const createIndex = commands.indexOf("web_annotation_create");
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeLessThan(stageIndex);
    expect(stageIndex).toBeLessThan(createIndex);
    const create = backend.callsOf("web_annotation_create")[0]!.args as {
      body: string;
      capture: { assetIds: string[] };
    };
    expect(create.body).toBe("Give this button more room.");
    expect(create.capture.assetIds).toHaveLength(1);
    expect(backend.callsOf("web_annotation_asset_stage")[0]!.args).toMatchObject({
      data: PNG.slice("data:image/png;base64,".length),
      mediaType: "image/png",
    });
    const annotationId = Array.from(backend.annotations.keys())[0]!;
    expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalledWith({
      captureId: "cap-1",
      annotationId,
      backendCaptureId: `capture-${annotationId}`,
    });
    // Save → saved thread.
    await waitFor(() => expect(panelState()?.selectedAnnotationId).toBe(annotationId));
    expect(await screen.findByRole("heading", { name: "button “Save”" })).toBeTruthy();
    expect(useNativeComposeStore.getState().drafts.size).toBe(0);
    expect(screen.getByText("Choose an agent to discuss or request changes.")).toBeTruthy();
  });

  test("an empty editor keeps only an unpublished draft", async () => {
    render(<AnnotationHarness />);
    await startAndCapture();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/Add a comment to publish this note/)).toBeTruthy();
    expect(backend.callsOf("web_annotation_create")).toHaveLength(0);
    expect(capture.mocks.acknowledgePendingCapture).not.toHaveBeenCalled();
    expect(capture.spool.has("cap-1")).toBe(true);
  });

  test("save and add another re-enters selection only after the backend receipt", async () => {
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    fireEvent.change(comment, { target: { value: "First note" } });
    const hold = backend.hold("web_annotation_create");
    fireEvent.click(screen.getByRole("button", { name: "Save and add another" }));
    await flush();
    expect(capture.mocks.startCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saved") === null).toBe(true);
    hold.release();
    await flush(20);
    expect(capture.mocks.startCapture).toHaveBeenCalledTimes(2);
    expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalledTimes(1);

    const second = await (async () => {
      capture.complete({ label: "link “Help”" });
      bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
        tabId: "browser-1",
        captureId: null,
        status: "captured",
      });
      return screen.findByRole("textbox", { name: "Comment for link “Help”" });
    })();
    fireEvent.change(second, { target: { value: "Second note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.annotations.size).toBe(2));
  });

  test("a lost create response is recovered from the receipt, not created twice", async () => {
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    fireEvent.change(comment, { target: { value: "Keep me" } });
    backend.fail("web_annotation_create", new Error("socket closed"), { afterCommit: true });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    const alert = await screen.findByText(/Not saved: socket closed/);
    expect(alert).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Comment for button “Save”" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep me");
    expect(capture.spool.has("cap-1")).toBe(true);
    expect(capture.mocks.acknowledgePendingCapture).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalledTimes(1));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
    expect(backend.annotations.size).toBe(1);
    const receipts = backend.callsOf("web_annotation_operation_receipt");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]!.args.operationId).toBe(receipts[1]!.args.operationId);
  });

  test("a capacity error keeps the note and capture with Retry and Discard", async () => {
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    fireEvent.change(comment, { target: { value: "Too big" } });
    backend.fail(
      "web_annotation_asset_stage",
      new Error("Web annotation capacity exceeded: image quota"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/Not saved: Capacity reached: image quota/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard capture" }));
    await waitFor(() => expect(capture.mocks.discardPendingCapture).toHaveBeenCalledWith("cap-1"));
    expect(backend.annotations.size).toBe(0);
  });

  test("resumes a pending capture after remount and shows its local expiry", async () => {
    seedPending(capture.spool, { captureId: "cap-resume", label: "heading “Plans”" });
    seedPending(capture.spool, { captureId: "cap-other-env", environmentId: "env-2" });
    const first = render(<AnnotationHarness />);
    await flush();
    first.unmount();
    render(<AnnotationHarness />);
    const resume = await screen.findByRole("button", {
      name: "Continue unsaved capture of heading “Plans”",
    });
    expect(screen.getByText("Unsaved captures (1)")).toBeTruthy();
    fireEvent.click(resume);
    expect(
      await screen.findByRole("textbox", { name: "Comment for heading “Plans”" }),
    ).toBeTruthy();
    expect(screen.getByText(/Kept on this computer until/)).toBeTruthy();
  });

  test("redaction replaces the spooled image before anything is uploaded", async () => {
    const redacted = "data:image/png;base64,UkVEQUNURUQ=";
    imageRedactor.redact = mock(async () => redacted);
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    fireEvent.click(screen.getByRole("button", { name: "Redact image…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add box" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply redaction" }));
    await waitFor(() =>
      expect(capture.mocks.replacePendingCaptureImage).toHaveBeenCalledWith("cap-1", {
        imageDataUrl: redacted,
        manualRegions: 1,
        regions: [expect.objectContaining({ width: expect.any(Number) })],
      }),
    );
    expect(backend.callsOf("web_annotation_asset_stage")).toHaveLength(0);
    fireEvent.change(comment, { target: { value: "Hide the email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_create")).toHaveLength(1));
    const staged = backend.callsOf("web_annotation_asset_stage");
    expect(staged).toHaveLength(1);
    expect(staged[0]!.args.data).toBe("UkVEQUNURUQ=");
    const created = backend.callsOf("web_annotation_create")[0]!.args as {
      capture: { redaction: { manualRegions: number } };
    };
    expect(created.capture.redaction.manualRegions).toBe(1);
  });

  test("Exclude image saves text evidence only", async () => {
    render(<AnnotationHarness />);
    const comment = await startAndCapture();
    fireEvent.click(screen.getByRole("button", { name: "Exclude image" }));
    await waitFor(() =>
      expect(capture.mocks.replacePendingCaptureImage).toHaveBeenCalledWith("cap-1", {
        imageDataUrl: null,
        manualRegions: 0,
      }),
    );
    expect(await screen.findByText(/Image excluded/)).toBeTruthy();
    fireEvent.change(comment, { target: { value: "No screenshot please" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_create")).toHaveLength(1));
    expect(backend.callsOf("web_annotation_asset_stage")).toHaveLength(0);
    const created = backend.callsOf("web_annotation_create")[0]!.args as {
      capture: { assetIds: string[]; redaction: { imageExcluded: boolean } };
    };
    expect(created.capture.assetIds).toEqual([]);
    expect(created.capture.redaction.imageExcluded).toBe(true);
  });

  test("Escape cancels selection without touching saved work; Done keeps the pending capture", async () => {
    render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    const cancel = await screen.findByRole("button", { name: "Cancel selection" });
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(capture.mocks.cancelCapture).toHaveBeenCalled());
    expect(panelState()?.open).toBe(true);

    await startAndCapture();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(capture.spool.has("cap-2")).toBe(true);
    expect(capture.mocks.discardPendingCapture).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /Continue unsaved capture/ })).toBeTruthy();
  });

  test("non-desktop clients list and review saved notes with capture unavailable", async () => {
    bus.restore();
    bus = installFakeOrkestrator();
    backend.seed({ id: "annotation-a", title: "Cramped save button" });
    render(<AnnotationHarness previewAttached={false} />);
    expect(
      await screen.findByText(/Capturing page targets needs the Orkestrator desktop app/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add note" }) === null).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Open note: Cramped save button" }));
    const reply = await screen.findByRole("textbox", { name: "Reply to Cramped save button" });
    fireEvent.change(reply, { target: { value: "Still cramped on mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_entry_append")).toHaveLength(1));
    const panel = screen.getByRole("complementary", { name: "Page annotations" });
    expect(within(panel).queryByRole("button", { name: "Reselect target" }) === null).toBe(true);
  });

  test("draws pins for open notes on this page and clears them when the panel closes", async () => {
    backend.seed({ id: "annotation-a", title: "Pinned" });
    render(<AnnotationHarness />);
    await waitFor(() => expect(capture.mocks.showPins).toHaveBeenCalled());
    const input = capture.mocks.showPins.mock.calls.at(-1)![0] as {
      tabId: string;
      pins: Array<{ annotationId: string; number: number; target: { kind: string } }>;
    };
    expect(input.tabId).toBe("browser-1");
    expect(input.pins).toEqual([
      expect.objectContaining({
        annotationId: "annotation-a",
        number: 1,
        target: expect.objectContaining({ kind: "element" }),
      }),
    ]);
    capture.mocks.clearPins.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close annotations" }));
    await waitFor(() => expect(capture.mocks.clearPins).toHaveBeenCalledWith("browser-1"));
  });

  test("closing the panel is not undone while a capture is still pending", async () => {
    render(<AnnotationHarness />);
    await startAndCapture();
    fireEvent.click(screen.getByRole("button", { name: "Close annotations" }));
    await waitFor(() => expect(panelState()?.open).toBe(false));
    await flush();
    expect(panelState()?.open).toBe(false);
    expect(capture.spool.has("cap-1")).toBe(true);

    // A new capture still opens its editor.
    fireEvent.click(screen.getByRole("button", { name: /^Annotations/ }));
    await waitFor(() => expect(panelState()?.open).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close annotations" }));
    await waitFor(() => expect(panelState()?.open).toBe(false));
    await capture.api.startCapture({ tabId: "browser-1", mode: "element", environmentId: "env-1" });
    capture.complete({ label: "link “Help”" });
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "captured",
    });
    await waitFor(() => expect(panelState()?.open).toBe(true));
  });

  test("reselecting after a reply replaces against the thread's current revision", async () => {
    backend.seed({ id: "annotation-a", title: "Header spacing" });
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-a" });
    render(<AnnotationHarness />);
    const reply = await screen.findByRole("textbox", { name: "Reply to Header spacing" });
    fireEvent.change(reply, { target: { value: "Also on mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_entry_append")).toHaveLength(1));
    const current = backend.annotations.get("annotation-a")!.contentRevision;
    expect(current).toBe(2);
    await flush();

    fireEvent.click(await screen.findByRole("button", { name: "Reselect target" }));
    await waitFor(() => expect(capture.mocks.startCapture).toHaveBeenCalled());
    capture.complete({ label: "heading “Plans”" });
    bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
      tabId: "browser-1",
      captureId: null,
      status: "captured",
    });
    await screen.findByRole("textbox", { name: "Comment for heading “Plans”" });
    fireEvent.click(screen.getByRole("button", { name: "Save new target" }));

    await waitFor(() => expect(backend.callsOf("web_annotation_capture_replace")).toHaveLength(1));
    expect(backend.callsOf("web_annotation_capture_replace")[0]!.args).toMatchObject({
      annotationId: "annotation-a",
      expectedContentRevision: current,
    });
    await waitFor(() => expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalled());
  });

  test("the toolbar control shows the open-note count and closes back to itself", async () => {
    backend.seed({ id: "annotation-a" });
    backend.seed({ id: "annotation-b" });
    render(<AnnotationHarness />);
    const button = await screen.findByRole("button", { name: "Annotations, 2 open on this page" });
    fireEvent.click(screen.getByRole("button", { name: "Close annotations" }));
    await waitFor(() => expect(panelState()?.open).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(screen.queryByRole("complementary", { name: "Page annotations" }) === null).toBe(true);
  });
});
