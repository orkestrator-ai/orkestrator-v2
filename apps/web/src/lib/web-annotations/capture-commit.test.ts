import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import { commitPendingCapture, resultCaptureMetadata } from "./capture-commit";
import { forgetCaptureIntent, rememberCaptureIntent } from "./capture-intents";

let backend: FakeWebAnnotationBackend;

describe("result capture commit", () => {
  beforeEach(() => {
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    forgetCaptureIntent("cap-result");
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("metadata is mapped field by field and absent on older desktops", () => {
    expect(resultCaptureMetadata({})).toEqual({});
    expect(
      resultCaptureMetadata({
        result: {
          zoomFactor: 1.25,
          deviceScaleFactor: 2,
          scroll: { x: 3, y: 400 },
          stability: "unstable",
          masks: [{ source: "manual", rect: { x: 1, y: 2, width: 3, height: 4 } }],
        },
      }),
    ).toEqual({
      zoomFactor: 1.25,
      deviceScaleFactor: 2,
      scroll: { x: 3, y: 400 },
      stability: "unstable",
      masks: [{ source: "manual", rect: { x: 1, y: 2, width: 3, height: 4 } }],
    });
  });

  test("names the annotation and forwards the after-image metadata", async () => {
    const fake = createFakeCaptureApi();
    const record = seedPending(fake.spool, { captureId: "cap-result" });
    record.descriptor.purpose = "result";
    record.result = {
      zoomFactor: 1,
      deviceScaleFactor: 2,
      scroll: { x: 0, y: 120 },
      stability: "stable",
      masks: [],
    };
    rememberCaptureIntent("cap-result", {
      kind: "result",
      requestId: "request-1",
      annotationId: "annotation-2",
      createdAt: Date.now(),
    });
    const committed = await commitPendingCapture({
      api: fake.api,
      environmentId: "env-1",
      captureId: "cap-result",
      record,
      input: { body: "" },
    });
    expect(committed.annotationId).toBe("annotation-2");
    const args = backend.callsOf("web_annotation_result_capture")[0]!.args;
    expect(args).toMatchObject({
      requestId: "request-1",
      annotationId: "annotation-2",
      deviceScaleFactor: 2,
      scroll: { x: 0, y: 120 },
      stability: "stable",
      masks: [],
    });
  });
});
