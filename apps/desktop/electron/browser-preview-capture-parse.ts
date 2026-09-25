/**
 * Parsing of page-runtime output in Electron main. Page output is always
 * untrusted: every field is revalidated and rebuilt from known fields only.
 */
import type {
  BrowserPreviewCaptureErrorCode,
  BrowserPreviewCaptureMode,
} from "@orkestrator/protocol/browser-preview";
import type {
  WebAnnotationCaptureInput,
  WebAnnotationPageEvidence,
  WebAnnotationRect,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationEvidence,
  isWebAnnotationRect,
  isWebAnnotationTarget,
} from "@orkestrator/protocol/web-annotations-validation";
import {
  BROWSER_PREVIEW_CAPTURE_PROBE_MAX_CHARS,
  BROWSER_PREVIEW_CAPTURE_STATUS_MAX_CHARS,
} from "./browser-preview-annotation-script.js";
import { count, finite, isRecord, parseJson } from "./browser-preview-capture-page.js";

const RECT_TOLERANCE_PX = 2;
const SCROLL_TOLERANCE_PX = 1;
export const MIN_REGION_PX = 8;

export const STALE_REASONS = {
  navigation: "The page navigated during capture; recapture to refresh the evidence.",
  targetRemoved: "The selected target was removed before the screenshot.",
  layout: "The page layout, scroll, or viewport changed during capture.",
  runtimeLost: "The page inspector stopped responding during capture.",
} as const;

export interface Viewport {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
}

export interface ParsedSelection extends Viewport {
  target: WebAnnotationCaptureInput["target"];
  evidence: WebAnnotationPageEvidence | null;
  redaction: { attributesRemoved: number; valuesMasked: number; urlParametersRemoved: number };
  title: string;
}

export type ParsedStatus =
  | { kind: "inactive" | "invalid" | "unbound" | "selecting" | "cancelled" }
  | { kind: "error"; code: BrowserPreviewCaptureErrorCode }
  | { kind: "selected"; selection: ParsedSelection };

export interface Probe extends Viewport {
  connected: boolean;
  rect: WebAnnotationRect | null;
  sensitive: WebAnnotationRect[];
}

export function parseViewport(value: Record<string, unknown>): Viewport | null {
  const viewport = value.viewport;
  const scroll = value.scroll;
  if (
    !isRecord(viewport) ||
    !finite(viewport.width, 1, 100_000) ||
    !finite(viewport.height, 1, 100_000) ||
    !isRecord(scroll) ||
    !finite(scroll.x, -1e7, 1e7) ||
    !finite(scroll.y, -1e7, 1e7) ||
    !finite(value.devicePixelRatio, 0.1, 16)
  ) {
    return null;
  }
  return {
    viewport: { width: viewport.width, height: viewport.height },
    scroll: { x: scroll.x, y: scroll.y },
    devicePixelRatio: value.devicePixelRatio,
  };
}

export function pickRect(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function pickAncestor(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    tagName: value.tagName,
    id: value.id,
    role: value.role,
    testId: value.testId,
    name: value.name,
  };
}

function pickQuote(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { exact: value.exact, prefix: value.prefix, suffix: value.suffix };
}

export function pickAnchor(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const stableId = value.stableId;
  const semantic = value.semantic;
  const scope = value.scope;
  return {
    ...(stableId === undefined
      ? {}
      : {
          stableId: isRecord(stableId) ? { kind: stableId.kind, value: stableId.value } : stableId,
        }),
    semantic: isRecord(semantic)
      ? { tagName: semantic.tagName, role: semantic.role, name: semantic.name }
      : semantic,
    text: value.text === null ? null : pickQuote(value.text),
    ancestors: Array.isArray(value.ancestors)
      ? value.ancestors.slice(0, 13).map(pickAncestor)
      : value.ancestors,
    cssPath: value.cssPath,
    scope: isRecord(scope)
      ? scope.kind === "document"
        ? { kind: "document" }
        : { kind: scope.kind, reason: scope.reason }
      : scope,
  };
}

function regionLabel(rect: WebAnnotationRect): string {
  return `Region ${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

function parseTarget(
  value: unknown,
  mode: BrowserPreviewCaptureMode,
): WebAnnotationCaptureInput["target"] | null {
  if (!isRecord(value)) return null;
  let candidate: unknown;
  if (mode === "element" && value.kind === "element") {
    candidate = {
      kind: "element",
      label: value.label,
      anchor: pickAnchor(value.anchor),
      rect: pickRect(value.rect),
    };
  } else if (mode === "text" && value.kind === "text-range") {
    candidate = {
      kind: "text-range",
      label: value.label,
      quote: pickQuote(value.quote),
      container: pickAnchor(value.container),
      rect: pickRect(value.rect),
      rects: Array.isArray(value.rects) ? value.rects.slice(0, 65).map(pickRect) : value.rects,
    };
  } else if (mode === "region" && value.kind === "region") {
    const rect = pickRect(value.rect);
    if (!isWebAnnotationRect(rect) || rect.width < MIN_REGION_PX || rect.height < MIN_REGION_PX)
      return null;
    candidate = { kind: "region", label: regionLabel(rect), rect, imageRect: null };
  } else if (mode === "page" && value.kind === "page") {
    candidate = { kind: "page", label: "Whole page" };
  } else {
    return null;
  }
  return isWebAnnotationTarget(candidate)
    ? (candidate as WebAnnotationCaptureInput["target"])
    : null;
}

function parseEvidence(
  value: unknown,
  mode: BrowserPreviewCaptureMode,
): WebAnnotationPageEvidence | null | undefined {
  if (mode === "region" || mode === "page")
    return value === null || value === undefined ? null : undefined;
  if (!isRecord(value)) return undefined;
  const record = (entry: unknown) =>
    isRecord(entry) ? Object.fromEntries(Object.entries(entry).slice(0, 49)) : entry;
  const evidence = {
    text: value.text,
    attributes: record(value.attributes),
    styles: record(value.styles),
    hierarchy: Array.isArray(value.hierarchy)
      ? value.hierarchy.slice(0, 13).map(pickAncestor)
      : value.hierarchy,
    html: value.html,
  };
  return isWebAnnotationEvidence(evidence) ? evidence : undefined;
}

export function parseCaptureRuntimeStatus(
  encoded: unknown,
  expected: { captureId: string; nonce: string; mode: BrowserPreviewCaptureMode },
): ParsedStatus {
  const parsed = parseJson(encoded, BROWSER_PREVIEW_CAPTURE_STATUS_MAX_CHARS);
  if (!isRecord(parsed)) return { kind: "invalid" };
  if (parsed.status === "inactive" && Object.keys(parsed).length === 1) return { kind: "inactive" };
  if (
    parsed.v !== 1 ||
    parsed.captureId !== expected.captureId ||
    parsed.nonce !== expected.nonce ||
    parsed.mode !== expected.mode
  ) {
    return { kind: "unbound" };
  }
  switch (parsed.status) {
    case "selecting":
      return { kind: "selecting" };
    case "cancelled":
      return { kind: "cancelled" };
    case "error": {
      const code = isRecord(parsed.error) ? parsed.error.code : null;
      return {
        kind: "error",
        code: code === "too-large" || code === "unsupported" ? code : "capture-failed",
      };
    }
    case "selected": {
      const selection = parsed.selection;
      if (!isRecord(selection)) return { kind: "invalid" };
      const target = parseTarget(selection.target, expected.mode);
      const evidence = parseEvidence(selection.evidence, expected.mode);
      const viewport = parseViewport(selection);
      const redaction = isRecord(selection.redaction) ? selection.redaction : null;
      const counts = redaction
        ? [
            count(redaction.attributesRemoved),
            count(redaction.valuesMasked),
            count(redaction.urlParametersRemoved),
          ]
        : [null];
      if (
        !target ||
        evidence === undefined ||
        !viewport ||
        counts.some((entry) => entry === null) ||
        typeof selection.title !== "string"
      ) {
        return { kind: "invalid" };
      }
      return {
        kind: "selected",
        selection: {
          target,
          evidence,
          ...viewport,
          title: selection.title.slice(0, 500),
          redaction: {
            attributesRemoved: counts[0]!,
            valuesMasked: counts[1]!,
            urlParametersRemoved: counts[2]!,
          },
        },
      };
    }
    default:
      return { kind: "invalid" };
  }
}

export function parseCaptureProbe(
  encoded: unknown,
  expected: { captureId: string; nonce: string },
): Probe | null {
  const parsed = parseJson(encoded, BROWSER_PREVIEW_CAPTURE_PROBE_MAX_CHARS);
  if (
    !isRecord(parsed) ||
    parsed.captureId !== expected.captureId ||
    parsed.nonce !== expected.nonce
  ) {
    return null;
  }
  const viewport = parseViewport(parsed);
  const rect = parsed.rect === null ? null : pickRect(parsed.rect);
  const sensitive = Array.isArray(parsed.sensitive)
    ? parsed.sensitive.slice(0, 33).map(pickRect)
    : null;
  if (
    !viewport ||
    typeof parsed.connected !== "boolean" ||
    (rect !== null && !isWebAnnotationRect(rect)) ||
    !sensitive ||
    sensitive.length > 32 ||
    !sensitive.every(isWebAnnotationRect)
  ) {
    return null;
  }
  return {
    ...viewport,
    connected: parsed.connected,
    rect: rect as WebAnnotationRect | null,
    sensitive: sensitive as WebAnnotationRect[],
  };
}

export function incoherence(before: Probe, after: Probe | null): string | null {
  if (!after) return STALE_REASONS.runtimeLost;
  if (!before.connected || !after.connected) return STALE_REASONS.targetRemoved;
  const differs = (left: number, right: number, tolerance: number) =>
    Math.abs(left - right) > tolerance;
  if (
    differs(before.viewport.width, after.viewport.width, 0.5) ||
    differs(before.viewport.height, after.viewport.height, 0.5) ||
    differs(before.scroll.x, after.scroll.x, SCROLL_TOLERANCE_PX) ||
    differs(before.scroll.y, after.scroll.y, SCROLL_TOLERANCE_PX)
  ) {
    return STALE_REASONS.layout;
  }
  if ((before.rect === null) !== (after.rect === null)) return STALE_REASONS.layout;
  if (before.rect && after.rect) {
    const keys = ["x", "y", "width", "height"] as const;
    if (keys.some((key) => differs(before.rect![key], after.rect![key], RECT_TOLERANCE_PX))) {
      return STALE_REASONS.layout;
    }
  }
  return null;
}
