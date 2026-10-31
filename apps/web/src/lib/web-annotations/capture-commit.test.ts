import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  fixtureCapabilities,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import type { WebAnnotationSourceHint } from "@orkestrator/protocol/web-annotations";
import { useWebAnnotationStore } from "@/stores/webAnnotationStore";
import {
  commitPendingCapture,
  resultCaptureMetadata,
  withAdvertisedSourceHints,
} from "./capture-commit";
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

describe("source hint capability gate", () => {
  const hint: WebAnnotationSourceHint = {
    producer: "data-orkestrator-source",
    path: "src/Save.tsx",
    line: 12,
    verified: false,
  };

  beforeEach(() => {
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    useWebAnnotationStore.getState().reset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function hintedRecord(captureId: string) {
    const fake = createFakeCaptureApi();
    const record = seedPending(fake.spool, { captureId, image: null });
    record.capture = {
      ...record.capture,
      evidence: { ...record.capture.evidence!, sourceHints: [hint] },
    };
    return { fake, record };
  }

  function advertise(sourceHints: boolean | undefined) {
    useWebAnnotationStore.getState().update("env-1", () => ({
      capabilities: fixtureCapabilities({ sourceHints }),
      capabilityStatus: "available",
    }));
  }

  test("strips hints for a backend that does not advertise them", () => {
    const { record } = hintedRecord("cap-pure");
    expect(withAdvertisedSourceHints(record.capture, false).evidence).not.toHaveProperty(
      "sourceHints",
    );
    expect(withAdvertisedSourceHints(record.capture, true).evidence?.sourceHints).toEqual([hint]);
  });

  for (const [label, advertised, expected] of [
    ["sends hints when the backend advertises them", true, [hint]],
    ["omits hints when the backend does not advertise them", false, undefined],
    ["omits hints for an older backend without the flag", undefined, undefined],
  ] as const) {
    test(label, async () => {
      advertise(advertised);
      const { fake, record } = hintedRecord(`cap-${String(advertised)}`);
      await commitPendingCapture({
        api: fake.api,
        environmentId: "env-1",
        captureId: record.descriptor.captureId,
        record,
        input: { body: "Hinted." },
      });
      const args = backend.callsOf("web_annotation_create")[0]!.args as {
        capture: { evidence: { sourceHints?: unknown } };
      };
      expect(args.capture.evidence.sourceHints).toEqual(expected);
    });
  }
});
