/**
 * Real desktop captures of the fixture targets the gateway spec annotates.
 *
 * A browser client has no trusted capture, so the gateway spec cannot produce
 * a target or evidence record itself. Instead of building one by hand, it
 * replays what the Electron capture path produced for the same element, kept
 * in `web-annotations-native-captures.json`. The Electron spec captures the
 * same targets on every run and fails when the shape or a host-independent
 * value has drifted; rerun it with `ORKESTRATOR_AGENT_TEST_UPDATE_NATIVE_CAPTURES=1`
 * to rewrite the file, and review the diff.
 *
 * Kept: the target (kind, label, anchor, rect), the evidence (text,
 * attributes, styles, hierarchy, html, source hints), the redaction counters
 * and the view geometry. Dropped: what belongs to one run or one host: the
 * capture time, document generation, page origin and port, staged asset ids
 * and the screenshot's dimensions.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations";
import {
  ROUTE_VARIANTS,
  TEST_IDS,
} from "../../test-fixtures/agent-project/annotation-app/fixture-data";

export const NATIVE_CAPTURES_FILE = path.join(
  import.meta.dirname,
  "web-annotations-native-captures.json",
);

/** The gateway spec's targets: every `createNote` / `captureFrom` call site. */
export const NATIVE_CAPTURE_TARGETS: ReadonlyArray<{ route: string; selector: string }> = [
  { route: ROUTE_VARIANTS.pricing, selector: '[data-testid="plan-cta-starter"]' },
  { route: ROUTE_VARIANTS.pricing, selector: `[data-testid="${TEST_IDS.teamCta}"]` },
  { route: ROUTE_VARIANTS.pricing, selector: '[data-testid="plan-cta-enterprise"]' },
];

type Geometry = NonNullable<WebAnnotationCaptureInput["geometry"]>;

export interface RecordedNativeCapture {
  route: string;
  selector: string;
  target: WebAnnotationCaptureInput["target"];
  geometry: Omit<Geometry, "image">;
  evidence: NonNullable<WebAnnotationCaptureInput["evidence"]>;
  redaction: WebAnnotationCaptureInput["redaction"];
}

export interface NativeCapturesFile {
  /** Where the recording was made: `<platform>-<arch>`, for the reviewer only. */
  recordedOn: string;
  captures: RecordedNativeCapture[];
}

/** The run- and host-independent part of a desktop capture of `selector`. */
export function recordNativeCapture(
  route: string,
  selector: string,
  capture: WebAnnotationCaptureInput,
): RecordedNativeCapture {
  if (!capture.evidence) throw new Error(`Capture of ${selector} has no evidence`);
  if (!capture.geometry) throw new Error(`Capture of ${selector} has no geometry`);
  const { image: _image, ...geometry } = capture.geometry;
  return structuredClone({
    route,
    selector,
    target: capture.target,
    geometry,
    evidence: capture.evidence,
    redaction: capture.redaction,
  });
}

/**
 * Element geometry depends on the host's fonts and display (the same button is
 * wider on macOS than on Linux), and the display sets the pixel ratio. These
 * values must be present and numeric; only the rest of the record is compared.
 */
export function comparableNativeCapture(record: RecordedNativeCapture): unknown {
  const { rect, ...target } = record.target as RecordedNativeCapture["target"] & {
    rect?: unknown;
  };
  const { width, height, ...styles } = record.evidence.styles ?? {};
  const { devicePixelRatio, ...geometry } = record.geometry;
  return {
    ...record,
    target: { ...target, rect: rectShape(rect) },
    geometry: { ...geometry, devicePixelRatio: typeof devicePixelRatio },
    evidence: {
      ...record.evidence,
      styles: { ...styles, width: pixelShape(width), height: pixelShape(height) },
    },
  };
}

function rectShape(rect: unknown): string {
  if (!rect || typeof rect !== "object") return "missing";
  const values = ["x", "y", "width", "height"].map((key) => (rect as Record<string, unknown>)[key]);
  return values.every((value) => typeof value === "number" && Number.isFinite(value))
    ? "rect"
    : "malformed";
}

function pixelShape(value: unknown): string {
  if (value === undefined) return "absent";
  return typeof value === "string" && /^\d+(\.\d+)?px$/.test(value) ? "px" : String(value);
}

export function readNativeCaptures(file = NATIVE_CAPTURES_FILE): NativeCapturesFile {
  return JSON.parse(readFileSync(file, "utf8")) as NativeCapturesFile;
}

export function writeNativeCaptures(
  captures: RecordedNativeCapture[],
  file = NATIVE_CAPTURES_FILE,
): void {
  const contents: NativeCapturesFile = {
    recordedOn: `${process.platform}-${process.arch}`,
    captures,
  };
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
}

/** The recorded desktop capture of `selector` on `route`; a missing one is a test bug. */
export function recordedNativeCapture(
  route: string,
  selector: string,
  file = NATIVE_CAPTURES_FILE,
): RecordedNativeCapture {
  const found = readNativeCaptures(file).captures.find(
    (capture) => capture.route === route && capture.selector === selector,
  );
  if (!found) {
    throw new Error(
      `No recorded desktop capture of ${selector} on ${route}. Add it to NATIVE_CAPTURE_TARGETS and rerun the Electron spec with ORKESTRATOR_AGENT_TEST_UPDATE_NATIVE_CAPTURES=1.`,
    );
  }
  return structuredClone(found);
}
