import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  BROWSER_PREVIEW_CAPTURE_EVENT,
  type BrowserPreviewExpiredCaptureNotice,
} from "@orkestrator/protocol/browser-preview";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import { useAnnotationCapture } from "./useAnnotationCapture";

let backend: FakeWebAnnotationBackend;
let capture: ReturnType<typeof createFakeCaptureApi>;
let bus: ReturnType<typeof installFakeOrkestrator>;
type ApiExtras = Record<string, ReturnType<typeof mock>>;

function extend(extras: ApiExtras) {
  Object.assign(capture.api, extras);
}

function renderCapture() {
  return renderHook(() =>
    useAnnotationCapture({
      tabId: "browser-1",
      environmentId: "env-1",
      isActive: true,
      enabled: true,
    }),
  );
}

describe("capture resume and contract version 2", () => {
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    window.localStorage.clear();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a record with a recorded receipt is only re-acknowledged, never committed again", async () => {
    const record = seedPending(capture.spool, { captureId: "cap-done" });
    record.descriptor.receipt = { annotationId: "annotation-9", backendCaptureId: "capture-9" };
    const { result } = renderCapture();
    await waitFor(() =>
      expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalledWith({
        captureId: "cap-done",
        annotationId: "annotation-9",
        backendCaptureId: "capture-9",
      }),
    );
    expect(backend.callsOf("web_annotation_create")).toHaveLength(0);
    expect(backend.callsOf("web_annotation_asset_stage")).toHaveLength(0);
    await waitFor(() => expect(result.current.pending).toHaveLength(0));
  });

  test("a save interrupted by a disconnect finishes on reconnect with the same ids", async () => {
    seedPending(capture.spool, { captureId: "cap-net" });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    backend.fail("web_annotation_create", new Error("Gateway disconnected"));
    await act(async () => {
      const outcome = await result.current.save("cap-net", { body: "Keep this" });
      expect(outcome.ok).toBe(false);
    });
    expect(result.current.saveState("cap-net")).toMatchObject({
      status: "error",
      retrying: true,
    });
    await act(async () => {
      bus.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    });
    await waitFor(() => expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalled());
    const creates = backend.callsOf("web_annotation_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]!.args.operationId).toBe(creates[1]!.args.operationId);
    expect((creates[1]!.args as { body: string }).body).toBe("Keep this");
    expect(result.current.saveState("cap-net").status).toBe("saved");
    expect(result.current.lastCommitted).toMatchObject({ automatic: true });
  });

  test("a domain failure is not retried in the background", async () => {
    seedPending(capture.spool, { captureId: "cap-cap" });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    backend.fail("web_annotation_create", new Error("Web annotation capacity exceeded: full"));
    await act(async () => {
      await result.current.save("cap-cap", { body: "Too many" });
    });
    expect(result.current.saveState("cap-cap")).toMatchObject({ status: "error", retrying: false });
    await act(async () => {
      bus.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
  });

  test("the receipt is recorded before a failing acknowledgement, and re-acked later", async () => {
    const recordReceipt = mock(
      async (ack: { captureId: string; annotationId: string; backendCaptureId: string }) => {
        const record = capture.spool.get(ack.captureId);
        if (record) {
          record.descriptor.receipt = {
            annotationId: ack.annotationId,
            backendCaptureId: ack.backendCaptureId,
          };
        }
        return record?.descriptor ?? null;
      },
    );
    extend({ recordPendingCaptureReceipt: recordReceipt });
    seedPending(capture.spool, { captureId: "cap-ack" });
    capture.mocks.acknowledgePendingCapture.mockImplementationOnce(async () => {
      throw new Error("spool busy");
    });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(async () => {
      await result.current.save("cap-ack", { body: "Saved once" });
    });
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(result.current.saveState("cap-ack")).toMatchObject({
      status: "saved",
      ackPending: true,
    });
    await act(async () => {
      bus.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    });
    await waitFor(() => expect(capture.spool.has("cap-ack")).toBe(false));
    expect(backend.callsOf("web_annotation_create")).toHaveLength(1);
  });

  test("recapture starts from the stale record and result captures ask for stability", async () => {
    const record = seedPending(capture.spool, { captureId: "cap-stale" });
    record.descriptor.stale = true;
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(async () => {
      await result.current.recapture("cap-stale");
    });
    expect(capture.mocks.startCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ recaptureCaptureId: "cap-stale", mode: "element" }),
    );
    await act(async () => {
      await result.current.cancel();
      await result.current.start("page", {
        intent: { kind: "result", requestId: "request-1", annotationId: "a", createdAt: 1 },
        result: { requestId: "request-1", originalCaptureId: "capture-a" },
      });
    });
    expect(capture.mocks.startCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        purpose: "result",
        result: { requestId: "request-1", originalCaptureId: "capture-a" },
      }),
    );
  });

  test("focus requests, expired notices and dismissal", async () => {
    const notice: BrowserPreviewExpiredCaptureNotice = {
      captureId: "cap-old",
      tabId: "browser-1",
      environmentId: "env-1",
      annotationId: null,
      mode: "element",
      displayUrl: "http://localhost:5173/settings",
      createdAt: "2026-09-20T10:00:00.000Z",
      expiredAt: "2026-09-21T10:00:00.000Z",
      whileClosed: true,
    };
    let notices = [notice, { ...notice, captureId: "cap-other", environmentId: "env-2" }];
    const dismiss = mock(async (ids?: string[]) => {
      notices = notices.filter((item) => !(ids ?? []).includes(item.captureId));
    });
    extend({
      listExpiredCaptureNotices: mock(async () => notices),
      dismissExpiredCaptureNotices: dismiss,
    });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.expired).toHaveLength(1));
    const before = result.current.editorFocusRequest;
    await act(async () => {
      bus.emit(BROWSER_PREVIEW_CAPTURE_EVENT, {
        tabId: "browser-1",
        captureId: null,
        status: "captured",
        focus: "editor",
      });
    });
    expect(result.current.editorFocusRequest).toBe(before + 1);
    await act(async () => {
      await result.current.dismissExpired(["cap-old"]);
    });
    expect(dismiss).toHaveBeenCalledWith(["cap-old"]);
    expect(result.current.expired).toHaveLength(0);
  });
});
