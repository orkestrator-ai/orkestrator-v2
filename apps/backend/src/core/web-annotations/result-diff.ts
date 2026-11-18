/**
 * Advisory region diffs between an annotation's original capture and a
 * result (after) capture (`operations.resultDiffs`; from to-do 0047 (retired) task 2).
 *
 * Computed on demand from the stored images and never stored: a diff is a
 * reading of two immutable captures, so asking again gives the same answer
 * and nothing has to be migrated or collected. The result is always labelled
 * advisory; it never resolves a note, reports an outcome or counts as a check.
 *
 * Before anything is decoded, `resultDiffPreconditions` compares the two
 * captures' recorded conditions and refuses, with every reason it finds,
 * captures that would not compare like for like: different route, service,
 * viewport, scroll, zoom, device scale or stored image size, a stale or
 * image-less capture, a page that had not settled, or an after-capture taken
 * without the unstable-region mask. Images are never resized to fit.
 *
 * Decoding is bounded: both stored sizes are known from the asset records
 * (validated at ingest) and checked against `maxPixels` before decoding; the
 * decoder is told the same limit; at most `maxConcurrent` diffs run at once
 * (more are refused as busy, never queued); and the whole diff, decode
 * included, stops at `timeoutMs`.
 */
import {
  WEB_ANNOTATION_DIFF_LIMITS,
  WEB_ANNOTATION_DIFF_REFUSALS,
  compareWebAnnotationRasters,
  webAnnotationDiffRefusal,
  type WebAnnotationRaster,
  type WebAnnotationResultDiff,
  type WebAnnotationResultDiffRefusal,
} from "@orkestrator/protocol/web-annotations-diff";
import type {
  WebAnnotationCapture,
  WebAnnotationRect,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationId } from "@orkestrator/protocol/web-annotations-validation";
import type { WebAnnotationToolScope } from "./contracts.js";
import type { WebAnnotationContext } from "./context.js";
import { WebAnnotationServiceError, notFound } from "./service-errors.js";
import type { WebAnnotationThreads } from "./service-threads.js";
import type { WebAnnotationEnvironmentStore, WebAnnotationManifest } from "./storage.js";

/** Decodes one stored PNG to 8-bit interleaved pixels, refusing more than `maxPixels`. */
export type WebAnnotationPngDecoder = (
  bytes: Buffer,
  limits: { maxPixels: number },
) => Promise<WebAnnotationRaster>;

/** The production decoder: `sharp` (already a backend dependency), loaded on first use. */
export const sharpPngDecoder: WebAnnotationPngDecoder = async (bytes, { maxPixels }) => {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels, failOn: "error" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
};

class DiffRefused extends Error {
  constructor(readonly code: WebAnnotationResultDiffRefusal) {
    super(WEB_ANNOTATION_DIFF_REFUSALS[code]);
  }
}

const REFUSAL_ORDER = Object.keys(WEB_ANNOTATION_DIFF_REFUSALS) as WebAnnotationResultDiffRefusal[];

function differs(a: number | undefined, b: number | undefined, tolerance = 0.001): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) > tolerance;
}

/** The asset holding a capture's full-viewport image (never a region crop), if any. */
export function fullImageAssetId(
  capture: Pick<WebAnnotationCapture, "assetIds" | "regionCrop">,
): string | null {
  if (capture.regionCrop) return capture.regionCrop.sourceAssetId;
  return capture.assetIds[0] ?? null;
}

/**
 * Every reason the two captures cannot be compared like for like, in the
 * fixed order of `WEB_ANNOTATION_DIFF_REFUSALS`; empty when they can.
 * `sizes` are the stored image sizes from the asset records, when known.
 */
export function resultDiffPreconditions(
  before: WebAnnotationCapture,
  after: WebAnnotationCapture,
  sizes: {
    before: { width: number; height: number } | null;
    after: { width: number; height: number } | null;
  },
): WebAnnotationResultDiffRefusal[] {
  const found = new Set<WebAnnotationResultDiffRefusal>();
  const comparison = after.comparison;
  if (!comparison || !after.resultOf) found.add("not-result-capture");
  for (const capture of [before, after]) {
    if (capture.redaction.imageExcluded) found.add("image-excluded");
    else if (!fullImageAssetId(capture) || !capture.geometry?.image) found.add("no-image");
    if (capture.state !== "complete") found.add("stale");
  }
  if (before.page.route !== after.page.route) found.add("route");
  if (JSON.stringify(before.page.service) !== JSON.stringify(after.page.service)) {
    found.add("service");
  }
  for (const difference of comparison?.differences ?? []) {
    if (difference === "route" || difference === "service") found.add(difference);
    if (difference === "viewport" || difference === "zoom" || difference === "device-scale") {
      found.add(difference);
    }
  }
  const was = before.geometry;
  const now = after.geometry;
  if (
    was &&
    now &&
    (was.viewport.width !== now.viewport.width || was.viewport.height !== now.viewport.height)
  ) {
    found.add("viewport");
  }
  const afterScroll = comparison?.scroll ?? now?.scroll;
  if (
    was &&
    afterScroll &&
    (differs(was.scroll.x, afterScroll.x, WEB_ANNOTATION_DIFF_LIMITS.scrollTolerance) ||
      differs(was.scroll.y, afterScroll.y, WEB_ANNOTATION_DIFF_LIMITS.scrollTolerance))
  ) {
    found.add("scroll");
  }
  if (differs(was?.zoomFactor, comparison?.zoomFactor ?? now?.zoomFactor)) found.add("zoom");
  if (differs(was?.devicePixelRatio, comparison?.deviceScaleFactor ?? now?.devicePixelRatio)) {
    found.add("device-scale");
  }
  const beforeImage = sizes.before ?? was?.image ?? null;
  const afterImage = sizes.after ?? now?.image ?? null;
  if (
    beforeImage &&
    afterImage &&
    (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height)
  ) {
    found.add("image-size");
  }
  if (comparison?.stability === "unstable" || comparison?.differences.includes("unstable")) {
    found.add("unstable");
  }
  if (comparison && comparison.unstableRegions === undefined) found.add("no-unstable-mask");
  return REFUSAL_ORDER.filter((code) => found.has(code));
}

/** Document CSS rectangles → pixels of an image captured at `scroll` with CSS→image `scale`. */
function toImageRects(
  rects: readonly WebAnnotationRect[],
  scroll: { x: number; y: number },
  scale: number,
): WebAnnotationRect[] {
  return rects.map((rect) => ({
    x: (rect.x - scroll.x) * scale,
    y: (rect.y - scroll.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function incomparable(
  beforeCaptureId: string | null,
  afterCaptureId: string,
  codes: readonly WebAnnotationResultDiffRefusal[],
): WebAnnotationResultDiff {
  return {
    status: "incomparable",
    advisory: true,
    beforeCaptureId,
    afterCaptureId,
    reasons: codes.map((code) => webAnnotationDiffRefusal(code)),
  };
}

function withDeadline<T>(work: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    // Keep the abandoned work's own rejection handled.
    void work.catch(() => undefined);
    return Promise.reject(new DiffRefused("timeout"));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DiffRefused("timeout")), remaining);
    timer.unref?.();
  });
  void work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface WebAnnotationResultDiffOptions {
  decode?: WebAnnotationPngDecoder;
  limits?: Partial<
    Pick<typeof WEB_ANNOTATION_DIFF_LIMITS, "maxPixels" | "timeoutMs" | "maxConcurrent">
  >;
}

export class WebAnnotationResultDiffs {
  private active = 0;

  constructor(
    private readonly ctx: WebAnnotationContext,
    private readonly threads: WebAnnotationThreads,
  ) {}

  /** `operations.resultDiffs` is on unless the host turned diffs off. */
  get enabled(): boolean {
    return this.ctx.options.resultDiffs !== false;
  }

  private limits() {
    return { ...WEB_ANNOTATION_DIFF_LIMITS, ...this.ctx.options.resultDiffOptions?.limits };
  }

  /** `web_annotation_result_diff`: the diff of one result capture against its original. */
  async diff(environmentId: string, afterCaptureId: string): Promise<WebAnnotationResultDiff> {
    if (!this.enabled) {
      throw new WebAnnotationServiceError("Advisory result diffs are not available here");
    }
    const store = await this.ctx.env(environmentId);
    const manifest = store.manifest;
    if (!isWebAnnotationId(afterCaptureId) || !manifest.captures[afterCaptureId]) {
      throw notFound("Capture");
    }
    const after = await this.threads.readCapture(store, manifest, afterCaptureId);
    if (!after) {
      throw new WebAnnotationServiceError(
        "Web annotation storage degraded: capture record is unreadable",
      );
    }
    const beforeCaptureId = after.comparison?.comparedCaptureId ?? null;
    if (!after.comparison || !after.resultOf || !beforeCaptureId) {
      return incomparable(beforeCaptureId, after.id, ["not-result-capture"]);
    }
    const before = isWebAnnotationId(beforeCaptureId)
      ? await this.threads.readCapture(store, manifest, beforeCaptureId)
      : null;
    if (!before || before.annotationId !== after.annotationId) {
      return incomparable(beforeCaptureId, after.id, ["original-unavailable"]);
    }
    const beforeAssetId = fullImageAssetId(before);
    const afterAssetId = fullImageAssetId(after);
    const beforeAsset = beforeAssetId ? manifest.assets[beforeAssetId] : undefined;
    const afterAsset = afterAssetId ? manifest.assets[afterAssetId] : undefined;
    const reasons = resultDiffPreconditions(before, after, {
      before: beforeAsset ? { width: beforeAsset.width, height: beforeAsset.height } : null,
      after: afterAsset ? { width: afterAsset.width, height: afterAsset.height } : null,
    });
    if ((!beforeAsset || !afterAsset) && !reasons.includes("image-excluded")) {
      if (!reasons.includes("no-image")) reasons.push("no-image");
    }
    if (reasons.length > 0) return incomparable(before.id, after.id, reasons);
    const limits = this.limits();
    const width = afterAsset!.width;
    const height = afterAsset!.height;
    if (width * height > limits.maxPixels) {
      return incomparable(before.id, after.id, ["too-large"]);
    }
    if (this.active >= limits.maxConcurrent) {
      return incomparable(before.id, after.id, ["busy"]);
    }
    this.active += 1;
    // The slot is held until the decode itself settles, not until the caller
    // gets its answer: a decode cannot be cancelled, so releasing on timeout
    // would let abandoned decodes pile up past `maxConcurrent`.
    let decoding: Promise<unknown> | null = null;
    const clock = () => this.ctx.nowMs();
    const deadline = clock() + limits.timeoutMs;
    try {
      const decode = this.ctx.options.resultDiffOptions?.decode ?? sharpPngDecoder;
      const read = async (assetId: string) => {
        const bytes = await store.readAsset(assetId);
        return decode(bytes, { maxPixels: limits.maxPixels });
      };
      let rasters: [WebAnnotationRaster, WebAnnotationRaster];
      const work = Promise.all([read(beforeAssetId!), read(afterAssetId!)]);
      decoding = work;
      try {
        rasters = await withDeadline(work, deadline, clock);
        decoding = null;
      } catch (error) {
        throw error instanceof DiffRefused ? error : new DiffRefused("decode-failed");
      }
      const [beforeRaster, afterRaster] = rasters;
      if (
        beforeRaster.width !== width ||
        beforeRaster.height !== height ||
        afterRaster.width !== width ||
        afterRaster.height !== height
      ) {
        throw new DiffRefused("image-size");
      }
      if (
        beforeRaster.channels !== afterRaster.channels ||
        beforeRaster.data.length !== width * height * beforeRaster.channels ||
        afterRaster.data.length !== width * height * afterRaster.channels
      ) {
        throw new DiffRefused("decode-failed");
      }
      const comparison = after.comparison;
      const scale = after.geometry!.image!.scale;
      const scroll = comparison.scroll ?? after.geometry!.scroll;
      const masks = comparison.masks ?? [];
      const unstable = comparison.unstableRegions ?? [];
      const excluded = [
        ...toImageRects(
          masks.map((mask) => mask.rect),
          scroll,
          scale,
        ),
        ...toImageRects(unstable, scroll, scale),
      ];
      const compared = compareWebAnnotationRasters(beforeRaster, afterRaster, {
        excluded,
        deadline,
        now: clock,
      });
      if (compared.timedOut) throw new DiffRefused("timeout");
      if (compared.comparedPixels === 0) throw new DiffRefused("nothing-comparable");
      return {
        status: "compared",
        advisory: true,
        beforeCaptureId: before.id,
        afterCaptureId: after.id,
        image: { width, height },
        scale,
        changedPixels: compared.changedPixels,
        comparedPixels: compared.comparedPixels,
        excludedPixels: compared.excludedPixels,
        changedRatio: round(compared.changedPixels / compared.comparedPixels, 4),
        regions: compared.regions.map((region) => ({
          rect: region.rect,
          cssRect: {
            x: round(region.rect.x / scale, 2),
            y: round(region.rect.y / scale, 2),
            width: round(region.rect.width / scale, 2),
            height: round(region.rect.height / scale, 2),
          },
          changedPixels: region.changedPixels,
        })),
        truncatedRegions: compared.truncatedRegions,
        excluded: { masks: masks.length, unstableRegions: unstable.length },
        tolerance: WEB_ANNOTATION_DIFF_LIMITS.channelTolerance,
      };
    } catch (error) {
      if (error instanceof DiffRefused) return incomparable(before.id, after.id, [error.code]);
      throw error;
    } finally {
      const release = () => {
        this.active -= 1;
      };
      if (decoding) void decoding.then(release, release);
      else release();
    }
  }

  /**
   * The agent tool's diff: the latest after-capture of `annotationId` in the
   * request assigned to `scope` (or the named one, which must be among that
   * request's result captures for the annotation; any other id is answered
   * `not-result-capture` without being read). Null when the user has not
   * captured a result for it yet.
   */
  async toolDiff(
    scope: WebAnnotationToolScope,
    requestId: string,
    annotationId: string,
    resultCaptureId?: string,
  ): Promise<WebAnnotationResultDiff | null> {
    const store = await this.ctx.env(scope.environmentId);
    const manifest = store.manifest;
    const request = isWebAnnotationId(requestId) ? manifest.requests[requestId] : undefined;
    if (!request || !scope.tabId || request.destination.tabId !== scope.tabId) {
      throw new WebAnnotationServiceError("Request is not assigned to this session");
    }
    if (!request.selections.some((selection) => selection.annotationId === annotationId)) {
      throw new WebAnnotationServiceError("Annotation is not part of this request");
    }
    const captureIds = await this.resultCapturesFor(
      store,
      manifest,
      request.resultIds,
      annotationId,
    );
    const chosen =
      resultCaptureId === undefined
        ? captureIds.at(-1)
        : captureIds.find((captureId) => captureId === resultCaptureId);
    if (resultCaptureId !== undefined && !chosen) {
      // Never diff a capture outside the assigned request, whatever it is.
      return incomparable(null, resultCaptureId, ["not-result-capture"]);
    }
    return chosen ? this.diff(scope.environmentId, chosen) : null;
  }

  /** After-captures of one annotation, oldest first, from the request's latest result. */
  private async resultCapturesFor(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    resultIds: readonly string[],
    annotationId: string,
  ): Promise<string[]> {
    const latestId = resultIds.at(-1);
    if (!latestId || !manifest.results[latestId]) return [];
    const latest: WebAnnotationResult | null = await this.threads.readResult(store, latestId);
    if (!latest) return [];
    const observed = (latest.observations ?? [])
      .filter((observation) => observation.annotationId === annotationId)
      .map((observation) => observation.captureId);
    const seen = new Set((latest.observations ?? []).map((observation) => observation.captureId));
    // Captures recorded before observations existed carry no observation;
    // the capture's own annotation says which note it shows.
    const legacy = latest.captureIds.filter(
      (captureId) =>
        !seen.has(captureId) && manifest.captures[captureId]?.annotationId === annotationId,
    );
    return [...legacy, ...observed];
  }
}
