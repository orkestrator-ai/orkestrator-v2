/**
 * Targets inside same-origin frames (todo 0047 task 5): the backend
 * advertises `operations.frameTargets`, stores the root path as captured,
 * refuses an unbounded or malformed one, and gives the agent each frame's
 * document path plus a selector scoped to the innermost document.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_MAX_FRAME_DEPTH,
  type WebAnnotationAnchorScope,
  type WebAnnotationCapture,
  type WebAnnotationCaptureInput,
  type WebAnnotationRootStep,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixtureCapture,
  fixtureCaptureInput,
  fixtureDestination,
  fixtureEntry,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { compileWebAnnotationBrief } from "./brief.js";
import { ENV_A, createHarness, type ServiceHarness } from "./test-support.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const FRAME: WebAnnotationRootStep = {
  boundary: "frame",
  tagName: "iframe",
  stableId: { kind: "id", value: "editor" },
  cssPath: "iframe#editor",
  documentPath: "/embed/editor.html",
};
const PATH: WebAnnotationRootStep[] = [
  FRAME,
  { boundary: "shadow", tagName: "rich-editor", cssPath: "html > body > rich-editor" },
];

function scoped(scope: WebAnnotationAnchorScope): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("element");
  if (base.target.kind !== "element") throw new Error("expected an element fixture");
  return { ...base, target: { ...base.target, anchor: { ...base.target.anchor, scope } } };
}

function scopedCapture(id: string, scope: WebAnnotationAnchorScope): WebAnnotationCapture {
  const base = fixtureCapture("element", { id });
  if (base.target.kind !== "element") throw new Error("expected an element fixture");
  return fixtureCapture("element", {
    id,
    target: { ...base.target, anchor: { ...base.target.anchor, scope } },
  });
}

function briefFor(captures: Array<{ capture: WebAnnotationCapture; body: string }>) {
  return compileWebAnnotationBrief({
    operation: "discuss",
    destination: fixtureDestination,
    annotations: captures.map(({ capture, body }, index) => ({
      annotation: fixtureAnnotation({
        id: `annotation-${index + 1}`,
        currentCaptureId: capture.id,
      }),
      capture,
      entries: [
        fixtureEntry({
          id: `entry-${index + 1}`,
          annotationId: `annotation-${index + 1}`,
          body,
        }),
      ],
      assets: [],
      desiredOutcome: null,
      allowHistoricalEvidence: false,
      previouslyDeliveredEntryIds: new Set(),
      threadSummary: null,
      previousOutcome: null,
    })),
    instruction: "",
    textOnly: false,
    capabilities: { images: true, planMode: true, resultTools: false },
  });
}

describe("frame target capability", () => {
  test("is advertised with authoring and off when authoring is off", async () => {
    harness = await createHarness();
    expect((await harness.service.capabilities(ENV_A)).operations.frameTargets).toBe(true);
    await harness.cleanup();
    harness = await createHarness({ rolloutMode: () => "read-only" });
    expect((await harness.service.capabilities(ENV_A)).operations.frameTargets).toBe(false);
  });
});

describe("frame target storage", () => {
  test("a new note keeps the root path exactly as captured", async () => {
    harness = await createHarness();
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-frame",
      capture: scoped({ kind: "frame", path: PATH }),
      body: "Inside the embedded editor.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.target.kind === "element" && capture.target.anchor.scope).toEqual({
      kind: "frame",
      path: PATH,
    });
  });

  for (const [label, path] of [
    [
      "more frames than the protocol limit",
      Array.from({ length: WEB_ANNOTATION_MAX_FRAME_DEPTH + 1 }, () => FRAME),
    ],
    ["a frame document path with a query", [{ ...FRAME, documentPath: "/embed?token=secret" }]],
    [
      "a frame document URL with an origin",
      [{ ...FRAME, documentPath: "https://other.test/embed" }],
    ],
    ["a path with no frame step", [PATH[1]!]],
  ] as const) {
    test(`${label} is refused`, async () => {
      harness = await createHarness();
      await expect(
        harness.service.create({
          environmentId: ENV_A,
          operationId: `op-${label.replaceAll(" ", "-")}`,
          capture: scoped({ kind: "frame", path: path as WebAnnotationRootStep[] }),
          body: "Refused.",
        }),
      ).rejects.toThrow();
    });
  }
});

describe("frame targets in the brief", () => {
  test("give each frame's document path and each host's tag, outermost first", () => {
    const brief = briefFor([
      {
        capture: scopedCapture("capture-annotation-1", { kind: "frame", path: PATH }),
        body: "Pad it.",
      },
    ]);
    expect(brief.body).toContain('"cssPath":"iframe#editor"');
    expect(brief.body).toContain('"cssPath":"html \\u003e body \\u003e rich-editor"');
    expect(brief.body).toContain('"stableId":{"kind":"id","value":"editor"}');
  });

  test("ID-less sibling frames retain distinct selectors in briefs", () => {
    const brief = briefFor(
      [1, 2].map((index) => ({
        capture: scopedCapture(`capture-annotation-${index}`, {
          kind: "frame",
          path: [
            {
              boundary: "frame",
              tagName: "iframe",
              cssPath: `iframe:nth-of-type(${index})`,
              documentPath: "about:srcdoc",
            },
          ],
        }),
        body: "Change this button.",
      })),
    );
    expect(brief.body).toContain("iframe:nth-of-type(1)");
    expect(brief.body).toContain("iframe:nth-of-type(2)");
  });

  test("do not conflict with a top-level target that shares their id", () => {
    const brief = briefFor([
      {
        capture: scopedCapture("capture-annotation-1", { kind: "frame", path: PATH }),
        body: "Make it blue.",
      },
      {
        capture: scopedCapture("capture-annotation-2", { kind: "document" }),
        body: "Make it red.",
      },
    ]);
    expect(brief.issues.map((issue) => issue.code)).not.toContain("conflicting-instructions");
    const same = briefFor([
      {
        capture: scopedCapture("capture-annotation-1", { kind: "document" }),
        body: "Make it blue.",
      },
      {
        capture: scopedCapture("capture-annotation-2", { kind: "document" }),
        body: "Make it red.",
      },
    ]);
    expect(same.issues.map((issue) => issue.code)).toContain("conflicting-instructions");
  });
});
