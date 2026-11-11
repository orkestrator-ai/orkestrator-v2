/**
 * Targets inside open shadow roots (todo 0047 task 5, todo 2580 (retired) task 2): the
 * backend advertises `operations.shadowTargets`, stores the root path as
 * captured, refuses an unbounded one, and names the host components in the brief.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_MAX_SHADOW_DEPTH,
  type WebAnnotationAnchorScope,
  type WebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixtureCapture,
  fixtureCaptureInput,
  fixtureDestination,
  fixtureEntry,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { compileWebAnnotationBrief } from "./web-annotation-brief.js";
import { ENV_A, createHarness, type ServiceHarness } from "./web-annotation-test-support.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const HOSTS = [
  {
    tagName: "app-shell",
    stableId: { kind: "id" as const, value: "shell" },
    cssPath: "app-shell#shell",
  },
  { tagName: "settings-panel", cssPath: "main > settings-panel" },
];

function scoped(scope: WebAnnotationAnchorScope): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("element");
  if (base.target.kind !== "element") throw new Error("expected an element fixture");
  return { ...base, target: { ...base.target, anchor: { ...base.target.anchor, scope } } };
}

function scopedQuote(scope: WebAnnotationAnchorScope): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("text-range");
  if (base.target.kind !== "text-range") throw new Error("expected a text fixture");
  return { ...base, target: { ...base.target, container: { ...base.target.container, scope } } };
}

describe("shadow-root target capability", () => {
  test("is advertised with authoring and off when authoring is off", async () => {
    harness = await createHarness();
    expect((await harness.service.capabilities(ENV_A)).operations.shadowTargets).toBe(true);
    await harness.cleanup();
    harness = await createHarness({ rolloutMode: () => "read-only" });
    expect((await harness.service.capabilities(ENV_A)).operations.shadowTargets).toBe(false);
  });
});

describe("shadow-root target storage", () => {
  test("a new note keeps the root path exactly as captured", async () => {
    harness = await createHarness();
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-shadow",
      capture: scoped({ kind: "shadow", hosts: HOSTS }),
      body: "Inside the settings panel.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.target.kind === "element" && capture.target.anchor.scope).toEqual({
      kind: "shadow",
      hosts: HOSTS,
    });
  });

  test("a text range keeps its quote and its container's root path as captured", async () => {
    harness = await createHarness();
    const input = scopedQuote({ kind: "shadow", hosts: HOSTS });
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-shadow-quote",
      capture: input,
      body: "Inside the settings panel.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.target).toEqual(input.target);
  });

  test("a root path past the protocol limit is refused", async () => {
    harness = await createHarness();
    const hosts = Array.from({ length: WEB_ANNOTATION_MAX_SHADOW_DEPTH + 1 }, () => HOSTS[1]!);
    await expect(
      harness.service.create({
        environmentId: ENV_A,
        operationId: "op-deep",
        capture: scoped({ kind: "shadow", hosts }),
        body: "Too deep.",
      }),
    ).rejects.toThrow();
  });
});

describe("shadow-root targets in the brief", () => {
  test("name the host components, outermost first, without their selectors", () => {
    const base = fixtureCapture("element", { id: "capture-annotation-1" });
    if (base.target.kind !== "element") throw new Error("expected an element fixture");
    const capture = fixtureCapture("element", {
      id: "capture-annotation-1",
      target: {
        ...base.target,
        anchor: { ...base.target.anchor, scope: { kind: "shadow", hosts: HOSTS } },
      },
    });
    const brief = compileWebAnnotationBrief({
      operation: "discuss",
      destination: fixtureDestination,
      annotations: [
        {
          annotation: fixtureAnnotation({
            id: "annotation-1",
            currentCaptureId: capture.id,
          }),
          capture,
          entries: [fixtureEntry({ id: "entry-1", annotationId: "annotation-1", body: "Pad it." })],
          assets: [],
          desiredOutcome: null,
          allowHistoricalEvidence: false,
          previouslyDeliveredEntryIds: new Set(),
          threadSummary: null,
          previousOutcome: null,
        },
      ],
      instruction: "",
      textOnly: false,
      capabilities: { images: true, planMode: true, resultTools: false },
    });
    expect(brief.body).toContain(
      '"scope":{"kind":"shadow","hosts":["app-shell","settings-panel"]}',
    );
    expect(brief.body).not.toContain("main > settings-panel");
  });
});
