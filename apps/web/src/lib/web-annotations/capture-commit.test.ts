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

describe("capture commit branches on another machine's environment", () => {
  const ROUTED_COMMANDS = [
    "web_annotation_operation_receipt",
    "web_annotation_asset_stage",
    "web_annotation_create",
    "web_annotation_get",
    "web_annotation_capture_replace",
    "web_annotation_result_capture",
  ];
  const hint: WebAnnotationSourceHint = {
    producer: "data-orkestrator-source",
    path: "src/Save.tsx",
    line: 12,
    verified: false,
  };
  const shadowScope = {
    kind: "shadow" as const,
    hosts: [{ tagName: "app-shell", cssPath: "html > body > app-shell" }],
  };
  const ENV = "env-shared";

  let windowScope: WindowScope;
  let local: FakeWebAnnotationBackend;
  let remote: FakeWebAnnotationBackend;
  let client: FakeNodeClient;
  let scope: ReturnType<WindowScope["open"]>;

  beforeEach(() => {
    // Both nodes know an environment with the same id, so only the scope
    // decides which one is used.
    local = new FakeWebAnnotationBackend(ENV).install();
    remote = new FakeWebAnnotationBackend(ENV);
    client = new FakeNodeClient({ nodeId: "bk_remote-node" as BackendId });
    for (const command of ROUTED_COMMANDS) {
      client.respond(command, (args: Readonly<Record<string, unknown>>) =>
        remote.handle(command, { ...args }),
      );
    }
    windowScope = new WindowScope();
    scope = windowScope.open({ role: "leaf", client });
  });
  afterEach(() => {
    windowScope.dispose();
    appCommandStore(webAnnotationStore).getState().reset();
    forgetCaptureIntent("cap-remote-result");
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function advertise(
    target: "local" | "remote",
    operations: { sourceHints: boolean; shadowTargets: boolean },
  ) {
    const store =
      target === "local" ? appCommandStore(webAnnotationStore) : scope.store(webAnnotationStore);
    store.getState().update(ENV, () => ({
      capabilities: fixtureCapabilities(operations),
      capabilityStatus: "available",
    }));
  }

  function hintedShadowRecord(captureId: string, annotationId: string | null = null) {
    const fake = createFakeCaptureApi();
    const record = seedPending(fake.spool, {
      captureId,
      environmentId: ENV,
      annotationId,
      image: null,
    });
    const target = record.capture.target;
    if (target.kind !== "element") throw new Error("expected an element fixture");
    record.capture = {
      ...record.capture,
      target: { ...target, anchor: { ...target.anchor, scope: shadowScope } },
      evidence: { ...record.capture.evidence!, sourceHints: [hint] },
    };
    return { fake, record };
  }

  type SentCapture = {
    capture: {
      evidence: { sourceHints?: unknown };
      target: { anchor: { scope: unknown } };
    };
  };

  for (const [label, localFlags, remoteFlags, expectedHints, expectedScope] of [
    [
      "follows the owning node's advertisement when only it advertises",
      { sourceHints: false, shadowTargets: false },
      { sourceHints: true, shadowTargets: true },
      [hint],
      shadowScope,
    ],
    [
      "ignores this window's advertisement when the owning node does not advertise",
      { sourceHints: true, shadowTargets: true },
      { sourceHints: false, shadowTargets: false },
      undefined,
      { kind: "unsupported", reason: "shadow-root" },
    ],
  ] as const) {
    test(label, async () => {
      advertise("local", localFlags);
      advertise("remote", remoteFlags);
      const { fake, record } = hintedShadowRecord(`cap-flags-${String(remoteFlags.sourceHints)}`);
      await commitPendingCapture({
        api: fake.api,
        environmentId: ENV,
        captureId: record.descriptor.captureId,
        record,
        input: { body: "Inside a component." },
        scope,
      });
      const args = client.calls("web_annotation_create")[0]!.args as unknown as SentCapture;
      expect(args.capture.evidence.sourceHints).toEqual(expectedHints);
      expect(args.capture.target.anchor.scope).toEqual(expectedScope);
      expect(local.calls).toEqual([]);
    });
  }

  test("a replace reads the current revision and replaces on the owning node", async () => {
    const annotation = remote.seed({ id: "annotation-remote", contentRevision: 3 });
    // This window's backend holds a different revision for the same id.
    local.seed({ id: "annotation-remote", contentRevision: 9 });
    local.calls.length = 0;
    const { fake, record } = hintedShadowRecord("cap-remote-replace", annotation.id);

    const committed = await commitPendingCapture({
      api: fake.api,
      environmentId: ENV,
      captureId: "cap-remote-replace",
      record,
      input: { body: "Reselected" },
      scope,
    });

    expect(committed.annotationId).toBe(annotation.id);
    expect(client.calls("web_annotation_get")).toHaveLength(1);
    expect(client.calls("web_annotation_capture_replace")[0]!.args).toMatchObject({
      environmentId: ENV,
      annotationId: annotation.id,
      expectedContentRevision: 3,
      body: "Reselected",
    });
    expect(client.calls("web_annotation_create")).toHaveLength(0);
    expect(local.calls).toEqual([]);
  });

  test("a result capture is recorded on the owning node", async () => {
    const { fake, record } = hintedShadowRecord("cap-remote-result");
    record.descriptor.purpose = "result";
    rememberCaptureIntent("cap-remote-result", {
      kind: "result",
      requestId: "request-remote",
      annotationId: "annotation-remote",
      createdAt: Date.now(),
    });

    const committed = await commitPendingCapture({
      api: fake.api,
      environmentId: ENV,
      captureId: "cap-remote-result",
      record,
      input: { body: "" },
      scope,
    });

    expect(committed.annotationId).toBe("annotation-remote");
    expect(committed.backendCaptureId).toBeTruthy();
    expect(client.calls("web_annotation_result_capture")[0]!.args).toMatchObject({
      environmentId: ENV,
      requestId: "request-remote",
      annotationId: "annotation-remote",
    });
    expect(local.calls).toEqual([]);
  });
});
