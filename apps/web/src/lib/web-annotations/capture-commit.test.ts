import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  fixtureCapabilities,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import type { WebAnnotationSourceHint } from "@orkestrator/protocol/web-annotations";
import { webAnnotationStore } from "@/stores/webAnnotationStore";
import {
  commitPendingCapture,
  resultCaptureMetadata,
  withAdvertisedShadowScope,
  withAdvertisedSourceHints,
} from "./capture-commit";
import { forgetCaptureIntent, rememberCaptureIntent } from "./capture-intents";
import { appCommandStore } from "@/test/app-command-store";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import type { BackendId } from "@orkestrator/protocol/federation";

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
    appCommandStore(webAnnotationStore).getState().reset();
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
    appCommandStore(webAnnotationStore)
      .getState()
      .update("env-1", () => ({
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

describe("shadow-root targets follow the backend's advertisement", () => {
  const shadowScope = {
    kind: "shadow" as const,
    hosts: [{ tagName: "app-shell", cssPath: "html > body > app-shell" }],
  };

  beforeEach(() => {
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function shadowRecord(captureId: string) {
    const fake = createFakeCaptureApi();
    const record = seedPending(fake.spool, { captureId, image: null });
    const target = record.capture.target;
    if (target.kind !== "element") throw new Error("expected an element fixture");
    record.capture = {
      ...record.capture,
      target: { ...target, anchor: { ...target.anchor, scope: shadowScope } },
    };
    return { fake, record };
  }

  test("leaves non-shadow targets alone either way", () => {
    const record = seedPending(createFakeCaptureApi().spool, { captureId: "cap-plain" });
    expect(withAdvertisedShadowScope(record.capture, false)).toBe(record.capture);
  });

  test("a text range's container follows the advertisement too", () => {
    const record = seedPending(createFakeCaptureApi().spool, { captureId: "cap-quote" });
    const element = record.capture.target;
    if (element.kind !== "element") throw new Error("expected an element fixture");
    const capture = {
      ...record.capture,
      target: {
        kind: "text-range" as const,
        label: "“Quote”",
        quote: { exact: "Quote", prefix: "", suffix: "" },
        container: { ...element.anchor, scope: shadowScope },
        rect: element.rect,
        rects: [],
      },
    };
    expect(withAdvertisedShadowScope(capture, true)).toBe(capture);
    const older = withAdvertisedShadowScope(capture, false).target;
    if (older.kind !== "text-range") throw new Error("expected a text range");
    expect(older.container.scope).toEqual({ kind: "unsupported", reason: "shadow-root" });
    expect(older.quote).toEqual(capture.target.quote);
  });

  for (const [label, advertised, expected] of [
    ["sends the root path when the backend advertises it", true, shadowScope],
    [
      "sends the older unsupported scope when the backend does not advertise it",
      false,
      { kind: "unsupported", reason: "shadow-root" },
    ],
    [
      "sends the older unsupported scope to a backend without the flag",
      undefined,
      { kind: "unsupported", reason: "shadow-root" },
    ],
  ] as const) {
    test(label, async () => {
      appCommandStore(webAnnotationStore)
        .getState()
        .update("env-1", () => ({
          capabilities: fixtureCapabilities({ shadowTargets: advertised }),
          capabilityStatus: "available",
        }));
      const { fake, record } = shadowRecord(`cap-shadow-${String(advertised)}`);
      await commitPendingCapture({
        api: fake.api,
        environmentId: "env-1",
        captureId: record.descriptor.captureId,
        record,
        input: { body: "Inside a component." },
      });
      const args = backend.callsOf("web_annotation_create")[0]!.args as {
        capture: { target: { anchor: { scope: unknown } } };
      };
      expect(args.capture.target.anchor.scope).toEqual(expected);
    });
  }
});

describe("capture commit on another machine's environment", () => {
  let windowScope: WindowScope;
  let local: FakeWebAnnotationBackend;

  beforeEach(() => {
    // This window's own backend does not know the environment.
    local = new FakeWebAnnotationBackend("env-local").install();
    windowScope = new WindowScope();
  });
  afterEach(() => {
    windowScope.dispose();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("stages, creates and reads the receipt on the environment's own node", async () => {
    const remote = new FakeWebAnnotationBackend("env-remote");
    const client = new FakeNodeClient({ nodeId: "bk_remote-node" as BackendId });
    for (const command of [
      "web_annotation_operation_receipt",
      "web_annotation_asset_stage",
      "web_annotation_create",
    ]) {
      client.respond(command, (args: Readonly<Record<string, unknown>>) =>
        remote.handle(command, { ...args }),
      );
    }
    const scope = windowScope.open({ role: "leaf", client });
    const fake = createFakeCaptureApi();
    const record = seedPending(fake.spool, {
      captureId: "cap-remote",
      environmentId: "env-remote",
    });

    const committed = await commitPendingCapture({
      api: fake.api,
      environmentId: "env-remote",
      captureId: "cap-remote",
      record,
      input: { body: "These should be in pills" },
      scope,
    });

    expect(committed.annotationId).toBeTruthy();
    expect(client.calls("web_annotation_operation_receipt")).toHaveLength(1);
    expect(client.calls("web_annotation_asset_stage")).toHaveLength(1);
    expect(client.calls("web_annotation_create")[0]!.args).toMatchObject({
      environmentId: "env-remote",
      body: "These should be in pills",
    });
    expect(local.calls).toEqual([]);
  });
});
