/**
 * Strict validation of renderer-supplied capture arguments. Every IPC entry
 * point and the preview manager use these; anything unexpected is rejected
 * rather than coerced.
 */
import type {
  BrowserPreviewAnchorQuery,
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureMask,
  BrowserPreviewCaptureMode,
  BrowserPreviewPinsInput,
  BrowserPreviewReplaceImageInput,
  BrowserPreviewResponsiveSetInput,
  BrowserPreviewShowOnPageInput,
  BrowserPreviewStartCaptureInput,
} from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_TARGET_KINDS,
  type WebAnnotationRect,
  type WebAnnotationTarget,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationId,
  isWebAnnotationRect,
  isWebAnnotationTarget,
} from "@orkestrator/protocol/web-annotations-validation";
import {
  isBrowserPreviewCaptureId,
  isBrowserPreviewCaptureMask,
  MAX_CAPTURE_MASKS,
} from "./browser-preview-capture-store.js";

/** Responsive capture sets: at most this many widths, each within the range below. */
export const RESPONSIVE_SET_LIMITS = Object.freeze({
  maxWidths: 4,
  minWidth: 320,
  maxWidth: 2_560,
});
const SHOW_ON_PAGE_MAX_TIMEOUT_MS = 20_000;

const MODES: readonly BrowserPreviewCaptureMode[] = ["element", "text", "region", "page"];
const ALL_TARGETS = new Set(WEB_ANNOTATION_TARGET_KINDS);
const PNG_DATA_URL_MAX_CHARS =
  "data:image/png;base64,".length + Math.ceil(WEB_ANNOTATION_LIMITS.imageBytes / 3) * 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function captureTabId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
  return value;
}

export function captureId(value: unknown): string {
  if (!isBrowserPreviewCaptureId(value)) throw new Error("Expected a pending capture ID");
  return value;
}

export function captureMode(value: unknown): BrowserPreviewCaptureMode {
  if (!MODES.includes(value as BrowserPreviewCaptureMode)) {
    throw new Error("Expected a capture mode");
  }
  return value as BrowserPreviewCaptureMode;
}

function environmentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Expected an environment ID");
  }
  return value;
}

export function captureMasks(value: unknown): BrowserPreviewCaptureMask[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CAPTURE_MASKS ||
    !value.every(isBrowserPreviewCaptureMask)
  ) {
    throw new Error("Expected bounded capture masks");
  }
  return value.map((mask) => ({
    source: mask.source,
    rect: { x: mask.rect.x, y: mask.rect.y, width: mask.rect.width, height: mask.rect.height },
  }));
}

export function startCaptureInput(value: unknown): BrowserPreviewStartCaptureInput {
  if (!isRecord(value)) throw new Error("Expected capture details");
  const { annotationId, recaptureCaptureId, purpose, result } = value;
  if (annotationId !== undefined && annotationId !== null && !isWebAnnotationId(annotationId)) {
    throw new Error("Expected an annotation ID");
  }
  if (
    recaptureCaptureId !== undefined &&
    recaptureCaptureId !== null &&
    !isBrowserPreviewCaptureId(recaptureCaptureId)
  ) {
    throw new Error("Expected a pending capture ID to recapture");
  }
  if (purpose !== undefined && purpose !== "note" && purpose !== "result") {
    throw new Error("Expected a capture purpose");
  }
  let resultStart: BrowserPreviewStartCaptureInput["result"];
  if (purpose === "result") {
    if (!isRecord(result) || !isWebAnnotationId(result.requestId)) {
      throw new Error("Expected the request of a result capture");
    }
    if (result.originalCaptureId !== undefined && !isWebAnnotationId(result.originalCaptureId)) {
      throw new Error("Expected an original capture ID");
    }
    resultStart = {
      requestId: result.requestId,
      ...(result.masks !== undefined ? { masks: captureMasks(result.masks) } : {}),
      ...(typeof result.originalCaptureId === "string"
        ? { originalCaptureId: result.originalCaptureId }
        : {}),
    };
  } else if (result !== undefined) {
    throw new Error("Result details require the result purpose");
  }
  return {
    tabId: captureTabId(value.tabId),
    mode: captureMode(value.mode),
    environmentId: environmentId(value.environmentId),
    ...(typeof annotationId === "string" ? { annotationId } : {}),
    ...(typeof recaptureCaptureId === "string" ? { recaptureCaptureId } : {}),
    ...(purpose ? { purpose } : {}),
    ...(resultStart ? { result: resultStart } : {}),
  };
}

export function replaceImageInput(value: unknown): BrowserPreviewReplaceImageInput {
  if (!isRecord(value)) throw new Error("Expected image replacement details");
  const { imageDataUrl, manualRegions, regions } = value;
  if (
    regions !== undefined &&
    (!Array.isArray(regions) ||
      regions.length > WEB_ANNOTATION_LIMITS.redactionRegions ||
      !regions.every(isWebAnnotationRect))
  ) {
    throw new Error("Expected bounded redaction rectangles");
  }
  if (
    imageDataUrl !== null &&
    (typeof imageDataUrl !== "string" || imageDataUrl.length > PNG_DATA_URL_MAX_CHARS)
  ) {
    throw new Error("Expected a bounded PNG data URL or null");
  }
  if (
    typeof manualRegions !== "number" ||
    !Number.isSafeInteger(manualRegions) ||
    manualRegions < 0 ||
    manualRegions > WEB_ANNOTATION_LIMITS.redactionRegions
  ) {
    throw new Error("Expected a bounded redaction region count");
  }
  return {
    imageDataUrl,
    manualRegions,
    ...(regions
      ? {
          regions: (regions as WebAnnotationRect[]).map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })),
        }
      : {}),
  };
}

export function captureIdList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every((entry) => isBrowserPreviewCaptureId(entry))
  ) {
    throw new Error("Expected pending capture IDs");
  }
  return [...(value as string[])];
}

export function captureAck(value: unknown): BrowserPreviewCaptureAck {
  if (!isRecord(value)) throw new Error("Expected a capture acknowledgement");
  if (!isWebAnnotationId(value.annotationId) || !isWebAnnotationId(value.backendCaptureId)) {
    throw new Error("Expected annotation and capture IDs");
  }
  return {
    captureId: captureId(value.captureId),
    annotationId: value.annotationId,
    backendCaptureId: value.backendCaptureId,
  };
}

function anchorQuery(value: unknown): BrowserPreviewAnchorQuery {
  if (!isRecord(value)) throw new Error("Expected a pin query");
  const { annotationId, number, target, route, capture } = value;
  if (!isWebAnnotationId(annotationId)) throw new Error("Expected a pin annotation ID");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 99_999
  ) {
    throw new Error("Expected a pin number");
  }
  if (typeof route !== "string" || !route.startsWith("/") || route.length > 4_000) {
    throw new Error("Expected a pin route");
  }
  if (!isWebAnnotationTarget(target, ALL_TARGETS)) throw new Error("Expected a pin target");
  let captureContext: BrowserPreviewAnchorQuery["capture"];
  if (capture !== undefined && capture !== null) {
    const viewport = isRecord(capture) ? capture.viewport : null;
    const generation = isRecord(capture) ? capture.documentGeneration : undefined;
    if (
      !isRecord(viewport) ||
      typeof viewport.width !== "number" ||
      typeof viewport.height !== "number" ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      !(generation === null || (typeof generation === "number" && Number.isSafeInteger(generation)))
    ) {
      throw new Error("Expected pin capture geometry");
    }
    captureContext = {
      documentGeneration: generation as number | null,
      viewport: { width: viewport.width, height: viewport.height },
    };
  }
  return {
    annotationId,
    number,
    target: target as WebAnnotationTarget,
    route,
    ...(captureContext ? { capture: captureContext } : {}),
  };
}

export function showOnPageInput(value: unknown): BrowserPreviewShowOnPageInput {
  if (!isRecord(value)) throw new Error("Expected Show on page details");
  const pin = anchorQuery(value.pin);
  const others = value.pins === undefined ? [] : value.pins;
  if (!Array.isArray(others) || others.length > WEB_ANNOTATION_LIMITS.visiblePins - 1) {
    throw new Error(`Expected at most ${WEB_ANNOTATION_LIMITS.visiblePins - 1} other pins`);
  }
  const pins = others.map(anchorQuery).filter((query) => query.annotationId !== pin.annotationId);
  if (new Set(pins.map((query) => query.annotationId)).size !== pins.length) {
    throw new Error("Expected unique pin annotation IDs");
  }
  const timeoutMs = value.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > SHOW_ON_PAGE_MAX_TIMEOUT_MS)
  ) {
    throw new Error("Expected a bounded Show on page timeout");
  }
  return {
    tabId: captureTabId(value.tabId),
    pin,
    pins,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

export function responsiveSetInput(value: unknown): BrowserPreviewResponsiveSetInput {
  if (!isRecord(value)) throw new Error("Expected responsive capture details");
  const { widths, target, annotationId } = value;
  if (
    !Array.isArray(widths) ||
    widths.length < 1 ||
    widths.length > RESPONSIVE_SET_LIMITS.maxWidths ||
    !widths.every(
      (width) =>
        typeof width === "number" &&
        Number.isSafeInteger(width) &&
        width >= RESPONSIVE_SET_LIMITS.minWidth &&
        width <= RESPONSIVE_SET_LIMITS.maxWidth,
    ) ||
    new Set(widths).size !== widths.length
  ) {
    throw new Error(
      `Expected 1–${RESPONSIVE_SET_LIMITS.maxWidths} distinct widths between ${RESPONSIVE_SET_LIMITS.minWidth} and ${RESPONSIVE_SET_LIMITS.maxWidth} px`,
    );
  }
  if (annotationId !== undefined && annotationId !== null && !isWebAnnotationId(annotationId)) {
    throw new Error("Expected an annotation ID");
  }
  if (
    target !== undefined &&
    target !== null &&
    !(
      isWebAnnotationTarget(target, ALL_TARGETS) &&
      ((target as WebAnnotationTarget).kind === "element" ||
        (target as WebAnnotationTarget).kind === "text-range")
    )
  ) {
    throw new Error("Expected an element or text target");
  }
  return {
    tabId: captureTabId(value.tabId),
    environmentId: environmentId(value.environmentId),
    widths: [...(widths as number[])].sort((left, right) => left - right),
    ...(typeof annotationId === "string" ? { annotationId } : {}),
    ...(target ? { target: target as WebAnnotationTarget } : {}),
  };
}

export function pinsInput(value: unknown): BrowserPreviewPinsInput {
  if (!isRecord(value)) throw new Error("Expected pin details");
  const { pins, focusedAnnotationId, scrollIntoView } = value;
  if (!Array.isArray(pins) || pins.length > WEB_ANNOTATION_LIMITS.visiblePins) {
    throw new Error(`Expected at most ${WEB_ANNOTATION_LIMITS.visiblePins} pins`);
  }
  if (
    focusedAnnotationId !== undefined &&
    focusedAnnotationId !== null &&
    !isWebAnnotationId(focusedAnnotationId)
  ) {
    throw new Error("Expected a focused annotation ID");
  }
  if (scrollIntoView !== undefined && typeof scrollIntoView !== "boolean") {
    throw new Error("Expected scrollIntoView to be a boolean");
  }
  const queries = pins.map(anchorQuery);
  if (new Set(queries.map((query) => query.annotationId)).size !== queries.length) {
    throw new Error("Expected unique pin annotation IDs");
  }
  return {
    tabId: captureTabId(value.tabId),
    pins: queries,
    focusedAnnotationId: (focusedAnnotationId as string | null | undefined) ?? null,
    scrollIntoView: scrollIntoView === true,
  };
}
