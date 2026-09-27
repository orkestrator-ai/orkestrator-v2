import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { imageRedactor } from "@/lib/web-annotations/redaction";
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
const originalRedact = imageRedactor.redact;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

describe("useAnnotationCapture", () => {
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    imageRedactor.redact = originalRedact;
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a save during redaction waits and uploads only the redacted image", async () => {
    const redacted = "data:image/png;base64,UkVEQUNURUQ=";
    imageRedactor.redact = mock(async () => redacted);
    seedPending(capture.spool, { captureId: "cap-r" });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    // The render-time copy holds the original pixels.
    act(() => result.current.openPending("cap-r"));
    await waitFor(() => expect(result.current.activeCapture).not.toBeNull());

    const gate = deferred();
    const replace = capture.mocks.replacePendingCaptureImage.getMockImplementation()!;
    capture.mocks.replacePendingCaptureImage.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return replace(...args);
    });

    let redaction!: Promise<boolean>;
    let save!: ReturnType<typeof result.current.save>;
    await act(async () => {
      redaction = result.current.applyRedaction("cap-r", [{ x: 0, y: 0, width: 10, height: 10 }]);
      await Promise.resolve();
      save = result.current.save("cap-r", { body: "Hide the email" });
      await Promise.resolve();
    });
    expect(result.current.imageChanging("cap-r")).toBe(true);
    expect(backend.callsOf("web_annotation_asset_stage")).toHaveLength(0);

    await act(async () => {
      gate.resolve();
      expect(await redaction).toBe(true);
      expect(await save).toMatchObject({ ok: true });
    });
    const staged = backend.callsOf("web_annotation_asset_stage");
    expect(staged).toHaveLength(1);
    expect(staged[0]!.args.data).toBe("UkVEQUNURUQ=");
    expect(result.current.imageChanging("cap-r")).toBe(false);
  });

  test("a save during image exclusion uploads no image", async () => {
    seedPending(capture.spool, { captureId: "cap-x" });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    act(() => result.current.openPending("cap-x"));
    await waitFor(() => expect(result.current.activeCapture).not.toBeNull());

    const gate = deferred();
    const replace = capture.mocks.replacePendingCaptureImage.getMockImplementation()!;
    capture.mocks.replacePendingCaptureImage.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return replace(...args);
    });

    await act(async () => {
      const exclusion = result.current.excludeImage("cap-x");
      const save = result.current.save("cap-x", { body: "No screenshot" });
      gate.resolve();
      expect(await exclusion).toBe(true);
      expect(await save).toMatchObject({ ok: true });
    });
    expect(backend.callsOf("web_annotation_asset_stage")).toHaveLength(0);
    const created = backend.callsOf("web_annotation_create")[0]!.args as {
      capture: { assetIds: string[]; redaction: { imageExcluded: boolean } };
    };
    expect(created.capture.assetIds).toEqual([]);
    expect(created.capture.redaction.imageExcluded).toBe(true);
  });

  test("a replace without a known content revision reads it instead of guessing", async () => {
    const annotation = backend.seed({ id: "annotation-a", contentRevision: 4 });
    seedPending(capture.spool, { captureId: "cap-re", annotationId: annotation.id });
    const { result } = renderCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    let outcome!: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => {
      outcome = await result.current.save("cap-re", { body: "" });
    });

    expect(outcome).toMatchObject({ ok: true, annotationId: "annotation-a" });
    const commands = backend.calls.map((call) => call.command);
    expect(commands.indexOf("web_annotation_get")).toBeLessThan(
      commands.indexOf("web_annotation_capture_replace"),
    );
    expect(backend.callsOf("web_annotation_capture_replace")[0]!.args).toMatchObject({
      annotationId: "annotation-a",
      expectedContentRevision: 4,
    });
  });
});
