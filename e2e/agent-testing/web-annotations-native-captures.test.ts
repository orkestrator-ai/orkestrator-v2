import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations";
import { validateWebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations-validation";
import {
  NATIVE_CAPTURE_TARGETS,
  comparableNativeCapture,
  readNativeCaptures,
  recordNativeCapture,
  recordedNativeCapture,
  writeNativeCaptures,
} from "./web-annotations-native-captures";

function capture(overrides: { width?: number; dpr?: number } = {}): WebAnnotationCaptureInput {
  return {
    producer: "desktop-native",
    capturedAt: "2026-11-06T00:00:00.000Z",
    documentGeneration: 3,
    page: {
      service: { kind: "port", port: 41234 },
      route: "/pricing",
      displayUrl: "http://127.0.0.1:41234/pricing",
      title: "Pricing",
      requiresNavigation: false,
    },
    target: {
      kind: "element",
      label: "button “Choose Team”",
      anchor: {
        stableId: { kind: "test-id", value: "plan-cta-team" },
        semantic: { tagName: "button", role: "button", name: "Choose Team" },
        text: { exact: "Choose Team", prefix: "", suffix: "" },
        ancestors: [],
        cssPath: "main > button",
        scope: { kind: "document" },
      },
      rect: { x: 10, y: 20, width: overrides.width ?? 120, height: 40 },
    },
    geometry: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      zoomFactor: 1,
      devicePixelRatio: overrides.dpr ?? 1,
      image: { width: 1280, height: 800, scale: 1, reduced: false },
    },
    evidence: {
      text: "Choose Team",
      attributes: { "data-testid": "plan-cta-team" },
      styles: { color: "rgb(0, 0, 0)", width: `${overrides.width ?? 120}px`, height: "40px" },
      hierarchy: [],
      html: "<button>Choose Team</button>",
    },
    assetIds: ["asset-1"],
    redaction: {
      attributesRemoved: 0,
      valuesMasked: 0,
      urlParametersRemoved: 0,
      sensitiveRegionsMasked: 0,
      manualRegions: 0,
      imageExcluded: false,
    },
  } as WebAnnotationCaptureInput;
}

const team = NATIVE_CAPTURE_TARGETS[1]!;

test("a recording keeps the capture's target and evidence and drops run- and host-specific fields", () => {
  const record = recordNativeCapture(team.route, team.selector, capture());
  expect(Object.keys(record).sort()).toEqual([
    "evidence",
    "geometry",
    "redaction",
    "route",
    "selector",
    "target",
  ]);
  expect(record.geometry).not.toHaveProperty("image");
  const text = JSON.stringify(record);
  for (const volatile of ["41234", "asset-1", "2026-11-06", "documentGeneration"])
    expect(text).not.toContain(volatile);
});

test("comparison ignores font- and display-dependent geometry but not the rest", () => {
  const base = comparableNativeCapture(recordNativeCapture(team.route, team.selector, capture()));
  const wider = comparableNativeCapture(
    recordNativeCapture(team.route, team.selector, capture({ width: 131.5, dpr: 2 })),
  );
  expect(wider).toEqual(base);

  const relabelled = capture();
  relabelled.target.label = "button “Start Team trial”";
  expect(
    comparableNativeCapture(recordNativeCapture(team.route, team.selector, relabelled)),
  ).not.toEqual(base);

  const restyled = capture();
  restyled.evidence!.styles = { ...restyled.evidence!.styles, color: "rgb(1, 2, 3)" };
  expect(
    comparableNativeCapture(recordNativeCapture(team.route, team.selector, restyled)),
  ).not.toEqual(base);

  const lostRect = recordNativeCapture(team.route, team.selector, capture());
  delete (lostRect.target as { rect?: unknown }).rect;
  expect(comparableNativeCapture(lostRect)).not.toEqual(base);
});

test("a written recording reads back, and a target without one is refused by name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-captures-"));
  try {
    const file = path.join(directory, "captures.json");
    const record = recordNativeCapture(team.route, team.selector, capture());
    writeNativeCaptures([record], file);
    expect(readNativeCaptures(file).captures).toEqual([record]);
    expect(recordedNativeCapture(team.route, team.selector, file)).toEqual(record);
    expect(() => recordedNativeCapture(team.route, '[data-testid="nope"]', file)).toThrow(
      '[data-testid="nope"]',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the committed recording covers every gateway target and passes the capture contract", () => {
  const recorded = readNativeCaptures();
  expect(recorded.captures.map(({ route, selector }) => ({ route, selector }))).toEqual([
    ...NATIVE_CAPTURE_TARGETS,
  ]);
  for (const record of recorded.captures) {
    const replayed = {
      ...capture(),
      target: record.target,
      geometry: { ...record.geometry, image: null },
      evidence: record.evidence,
      redaction: record.redaction,
      assetIds: [],
    };
    const validation = validateWebAnnotationCaptureInput(replayed);
    expect(validation.ok ? "valid" : validation.error).toBe("valid");
  }
});
