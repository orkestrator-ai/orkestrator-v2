/**
 * Responsive capture sets (plan step 13): one explicit user action captures
 * the current page at a bounded set of emulated viewport widths.
 *
 * Each width is its own pending capture with its own viewport, route, time,
 * and document generation, labelled with the width and linked by a set id;
 * the images were not simultaneous and never claim to be. Widths are
 * emulated with `enableDeviceEmulation`, so the native view's geometry never
 * changes, and emulation is always disabled again when the set ends. The set
 * shares the spool's capacity and the request evidence budget
 * (`briefAttachmentBytes`), checked before and during capture.
 */
import type {
  BrowserPreviewCaptureErrorCode,
  BrowserPreviewCaptureMask,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewResponsiveSetInput,
  BrowserPreviewResponsiveSetResult,
} from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationCaptureInput,
  type WebAnnotationRect,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationRect,
  validateWebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations-validation";
import { randomUUID } from "node:crypto";
import { browserPreviewAnchorKit } from "./browser-preview-anchor-script.js";
import {
  boundedScreenshotDataUrl,
  documentMask,
  maskCaptureImage,
} from "./browser-preview-capture-image.js";
import {
  browserPreviewPageIdentity,
  CaptureFailure,
  isRecord,
  parseJson,
  runInPage,
  type CaptureNativeImageApi,
  type CapturePreviewHandle,
} from "./browser-preview-capture-page.js";
import { parseViewport, pickRect } from "./browser-preview-capture-parse.js";
import {
  BrowserPreviewCaptureSpoolError,
  createBrowserPreviewCaptureId,
  decodePngDataUrl,
} from "./browser-preview-capture-store.js";
import { responsiveSetInput } from "./browser-preview-capture-validation.js";
import type { CaptureStoreLike } from "./browser-preview-capture.js";

const PROBE_MAX_CHARS = 16_384;
export const RESPONSIVE_SETTLE = Object.freeze({ deadlineMs: 1_500, quietMs: 150 });

/**
 * Page side: wait (bounded) for fonts and a quiet layout at the emulated
 * width, then report geometry, detectable sensitive rectangles, and the
 * target's rectangle when it still resolves. Serialized with `toString`.
 */
function responsiveProbe(
  kitFactory: typeof browserPreviewAnchorKit,
  config: { target: Record<string, unknown> | null; deadlineMs: number; quietMs: number },
): Promise<string> {
  const kit = kitFactory();
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const run = async () => {
    const started = Date.now();
    let fontsReady = true;
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (fonts?.ready && typeof fonts.ready.then === "function") {
      fontsReady = await Promise.race([
        fonts.ready.then(
          () => true,
          () => false,
        ),
        sleep(config.deadlineMs).then(() => false),
      ]);
    }
    const key = () =>
      `${window.innerWidth}x${window.innerHeight}:${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`;
    let last = key();
    let quietSince = Date.now();
    let quiet = false;
    while (Date.now() - started < config.deadlineMs) {
      await sleep(Math.min(50, config.quietMs));
      const next = key();
      if (next !== last) {
        last = next;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= config.quietMs) {
        quiet = true;
        break;
      }
    }
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    let state = "none";
    if (config.target) {
      const resolution = kit.resolveTarget(config.target, kit.createBudget(40_000, 80));
      state = resolution.state;
      rect = resolution.state === "matched" ? resolution.rect : null;
    }
    return JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      devicePixelRatio: window.devicePixelRatio,
      sensitive: kit.sensitiveRects(),
      rect,
      state,
      stable: quiet && fontsReady,
    });
  };
  return run().catch(() => "null");
}

export function browserPreviewResponsiveProbeScript(config: {
  target: Record<string, unknown> | null;
  deadlineMs: number;
  quietMs: number;
}): string {
  return `/*orkestrator:responsive-probe*/(${responsiveProbe.toString()})(${browserPreviewAnchorKit.toString()}, ${JSON.stringify(config)});`;
}

interface ResponsiveProbe {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  sensitive: WebAnnotationRect[];
  rect: WebAnnotationRect | null;
}

function parseResponsiveProbe(encoded: unknown): ResponsiveProbe | null {
  const parsed = parseJson(encoded, PROBE_MAX_CHARS);
  if (!isRecord(parsed)) return null;
  const view = parseViewport(parsed);
  const sensitive = Array.isArray(parsed.sensitive)
    ? parsed.sensitive.slice(0, 33).map(pickRect)
    : null;
  const rect = parsed.rect === null ? null : pickRect(parsed.rect);
  if (
    !view ||
    !sensitive ||
    sensitive.length > 32 ||
    !sensitive.every(isWebAnnotationRect) ||
    (rect !== null && !isWebAnnotationRect(rect))
  ) {
    return null;
  }
  return {
    ...view,
    sensitive: sensitive as WebAnnotationRect[],
    rect: rect as WebAnnotationRect | null,
  };
}

function shortLabel(value: string, suffix: string): string {
  const max = WEB_ANNOTATION_LIMITS.titleChars - suffix.length;
  const base = value.length > max ? `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…` : value;
  return `${base}${suffix}`;
}

export interface ResponsiveSetDeps {
  /** Fresh handle for the tab on every call (generation advances on navigation). */
  preview: () => CapturePreviewHandle | null;
  store: CaptureStoreLike;
  nativeImage?: CaptureNativeImageApi;
  now: () => number;
  /** True while a selection is in progress on the tab. */
  busy: boolean;
  settle?: { deadlineMs: number; quietMs: number };
}

export async function captureResponsiveSet(
  deps: ResponsiveSetDeps,
  value: BrowserPreviewResponsiveSetInput,
): Promise<BrowserPreviewResponsiveSetResult> {
  const input = responsiveSetInput(value);
  const { store } = deps;
  const handle = deps.preview();
  if (!handle) throw new Error(`Browser preview ${input.tabId} is not attached`);
  const contents = handle.contents;
  const navigated = () => {
    const current = deps.preview();
    return !current || current.contents !== contents || current.generation !== startGeneration;
  };
  if (deps.busy) throw new Error("Finish or cancel the current selection first.");
  if (
    typeof contents.enableDeviceEmulation !== "function" ||
    typeof contents.disableDeviceEmulation !== "function"
  ) {
    throw new Error("Responsive capture is unavailable in this build.");
  }
  const setId = `responsive-${randomUUID()}`;
  const failures: BrowserPreviewResponsiveSetResult["failures"] = [];
  const captures: BrowserPreviewPendingCaptureDescriptor[] = [];
  const fail = (width: number, code: BrowserPreviewCaptureErrorCode) =>
    failures.push({ viewportWidth: width, code });
  if (!(await store.hasCapacity(input.tabId, { count: input.widths.length }))) {
    for (const width of input.widths) fail(width, "spool-full");
    return { setId, captures, failures };
  }
  const startGeneration = handle.generation;
  const view = handle.viewSize?.() ?? null;
  const zoom = contents.getZoomFactor?.() ?? 1;
  const hostZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const viewWidth = view ? view.width / hostZoom : null;
  const height = Math.max(200, Math.round(view ? view.height / hostZoom : 800));
  const target = input.target ?? null;
  const pageTarget =
    target && (target.kind === "element" || target.kind === "text-range")
      ? target.kind === "element"
        ? { kind: "element", anchor: target.anchor }
        : { kind: "text-range", quote: target.quote, container: target.container }
      : null;
  let evidenceBytes = 0;
  try {
    for (const [index, width] of input.widths.entries()) {
      if (contents.isDestroyed() || navigated()) {
        fail(width, "navigation");
        continue;
      }
      contents.enableDeviceEmulation({
        screenPosition: "desktop",
        screenSize: { width, height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: { width, height },
        scale: viewWidth && width > viewWidth ? viewWidth / width : 1,
      });
      const probe = parseResponsiveProbe(
        await runInPage(
          contents,
          browserPreviewResponsiveProbeScript({
            target: pageTarget,
            ...(deps.settle ?? RESPONSIVE_SETTLE),
          }),
        ).catch(() => null),
      );
      if (!probe) {
        fail(width, "capture-failed");
        continue;
      }
      let image;
      try {
        image = await contents.capturePage();
      } catch {
        fail(width, "capture-failed");
        continue;
      }
      if (navigated()) {
        // The page navigated: these pixels may show another document.
        fail(width, "navigation");
        continue;
      }
      try {
        const masked = maskCaptureImage(image, probe.sensitive, probe.viewport, deps.nativeImage);
        if (probe.sensitive.length > 0 && !masked.masked) {
          fail(width, "unsupported");
          continue;
        }
        const nativeSize = image.getSize();
        const decoded = decodePngDataUrl(boundedScreenshotDataUrl(masked.image));
        if (evidenceBytes + decoded.bytes.length > WEB_ANNOTATION_LIMITS.briefAttachmentBytes) {
          fail(width, "too-large");
          continue;
        }
        const scale = decoded.width / probe.viewport.width;
        const identity = browserPreviewPageIdentity(
          contents.getURL(),
          typeof contents.getTitle === "function" ? contents.getTitle() : "",
          handle.describeService,
        );
        const suffix = ` · ${width} px`;
        const matched = target && probe.rect ? probe.rect : null;
        const captureTarget: WebAnnotationCaptureInput["target"] =
          target && matched && target.kind === "element"
            ? { ...target, label: shortLabel(target.label, suffix), rect: matched }
            : target && matched && target.kind === "text-range"
              ? {
                  ...target,
                  label: shortLabel(target.label, suffix),
                  rect: matched,
                  rects: [matched],
                }
              : {
                  kind: "page",
                  label: target
                    ? shortLabel(`${target.label} (not found)`, suffix)
                    : `Page${suffix}`,
                };
        const masks: BrowserPreviewCaptureMask[] = probe.sensitive.map((rect) =>
          documentMask(rect, probe.scroll, "sensitive-field"),
        );
        const capture: WebAnnotationCaptureInput = {
          producer: "desktop-native",
          capturedAt: new Date(deps.now()).toISOString(),
          documentGeneration: startGeneration,
          page: identity.page,
          target: captureTarget,
          geometry: {
            viewport: { ...probe.viewport },
            scroll: { ...probe.scroll },
            zoomFactor: hostZoom,
            devicePixelRatio: probe.devicePixelRatio,
            image: {
              width: decoded.width,
              height: decoded.height,
              scale,
              reduced: decoded.width < nativeSize.width || decoded.height < nativeSize.height,
            },
          },
          evidence: null,
          assetIds: [],
          redaction: {
            attributesRemoved: 0,
            valuesMasked: 0,
            urlParametersRemoved: identity.removedParameters,
            sensitiveRegionsMasked: probe.sensitive.length,
            manualRegions: 0,
            imageExcluded: false,
          },
          responsive: { setId, index, count: input.widths.length, viewportWidth: width },
        };
        if (!validateWebAnnotationCaptureInput(capture).ok) {
          fail(width, "capture-failed");
          continue;
        }
        const descriptor = await store.create({
          captureId: createBrowserPreviewCaptureId(),
          tabId: input.tabId,
          environmentId: input.environmentId,
          annotationId: input.annotationId ?? null,
          mode:
            captureTarget.kind === "text-range"
              ? "text"
              : captureTarget.kind === "element"
                ? "element"
                : "page",
          capture,
          image: {
            png: decoded.bytes,
            width: decoded.width,
            height: decoded.height,
            reduced: decoded.width < nativeSize.width || decoded.height < nativeSize.height,
          },
          ...(masks.length > 0 ? { masks } : {}),
          responsive: { setId, index, count: input.widths.length, viewportWidth: width },
        });
        evidenceBytes += decoded.bytes.length;
        captures.push(descriptor);
      } catch (error) {
        if (error instanceof BrowserPreviewCaptureSpoolError) {
          fail(
            width,
            error.code === "spool-full" || error.code === "too-large"
              ? error.code
              : "capture-failed",
          );
        } else {
          fail(width, error instanceof CaptureFailure ? error.code : "capture-failed");
        }
      }
    }
  } finally {
    // Restore the user's preview geometry however the set ends.
    try {
      if (!contents.isDestroyed()) contents.disableDeviceEmulation();
    } catch {
      // The view may have gone away mid-set.
    }
  }
  return { setId, captures, failures };
}
