/**
 * Commit one pending desktop capture to the backend (steps 3 and 4 of the
 * acknowledged transfer in "Pending spool and acknowledged transfer",
 * docs/architecture/web-page-annotations.md) and acknowledge it to the spool.
 *
 * Every backend call uses operation ids derived from the desktop capture id,
 * so a retry after a lost response, a reload, or a reconnect finds the
 * original receipt instead of creating a second annotation. The backend
 * receipt is recorded in the spool before the (possibly failing) clearing
 * acknowledgement, so a later resume only re-acknowledges.
 */
import type {
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureApi,
  BrowserPreviewPendingCapture,
} from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationAnchor,
  type WebAnnotationCaptureInput,
  type WebAnnotationOperationReceipt,
  type WebAnnotationResultCaptureMetadata,
} from "@orkestrator/protocol/web-annotations";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { getWebAnnotationCache } from "@/stores/webAnnotationStore";
import { captureIntent, type CaptureIntent } from "./capture-intents";
import { captureOperationIds, pngBase64FromDataUrl, webAnnotationCommand } from "./client";

export interface CaptureCommitInput {
  body: string;
  title?: string;
  draftId?: string;
  /**
   * Content revision the user saw, for reselect/recapture of an existing
   * annotation. When unknown, the current revision is fetched before saving.
   */
  expectedContentRevision?: number;
  /**
   * Attach to this annotation with `capture_replace` even though the capture
   * was started for a new note (later members of a responsive set).
   */
  annotationId?: string;
}

export interface CaptureCommitResult {
  annotationId: string;
  backendCaptureId: string;
  /** Backend committed, but the spool could not be cleared yet. */
  ackPending: boolean;
}

export type CaptureCommitKind = "create" | "replace" | "result";

export function captureCommitKind(
  record: Pick<BrowserPreviewPendingCapture, "descriptor">,
  intent: CaptureIntent | null,
  input: Pick<CaptureCommitInput, "annotationId"> = {},
): CaptureCommitKind {
  if (intent?.kind === "result" || record.descriptor.purpose === "result") return "result";
  return input.annotationId || record.descriptor.annotationId ? "replace" : "create";
}

function operationFor(captureId: string, kind: CaptureCommitKind) {
  const ops = captureOperationIds(captureId);
  return kind === "result" ? ops.result : kind === "replace" ? ops.replace : ops.create;
}

/** Local redaction counters, merged with the spool's own accumulated summary. */
export function mergedRedaction(
  capture: WebAnnotationCaptureInput,
  local: { manualRegions: number; imageExcluded: boolean } | undefined,
  hasImage: boolean,
): WebAnnotationCaptureInput["redaction"] {
  const redaction = capture.redaction;
  return {
    ...redaction,
    // Contract version 2 spools accumulate each pass themselves; older ones
    // may not, so the local total is a floor, never added twice.
    manualRegions: Math.max(redaction.manualRegions, local?.manualRegions ?? 0),
    imageExcluded: redaction.imageExcluded || Boolean(local?.imageExcluded) || !hasImage,
  };
}

/**
 * Desktop metadata of an after-image (zoom, device scale, scroll, stability,
 * masks) in the backend's optional result-capture fields. Absent on older
 * desktops, which the backend accepts. The unstable-region mask goes only to
 * a backend that advertises `operations.resultDiffs` (`diffsAdvertised`).
 */
export function resultCaptureMetadata(
  record: Pick<BrowserPreviewPendingCapture, "result" | "masks"> &
    Partial<Pick<BrowserPreviewPendingCapture, "imageDataUrl">>,
  diffsAdvertised = false,
): WebAnnotationResultCaptureMetadata {
  const meta = record.result;
  if (!meta) return {};
  const masks = (diffsAdvertised ? record.masks : undefined) ?? meta.masks;
  const hasMaskList = Array.isArray(masks);
  const boundedMasks = hasMaskList ? masks.slice(0, WEB_ANNOTATION_LIMITS.redactionRegions) : [];
  const hasMaskBudget = hasMaskList && boundedMasks.length === masks.length;
  return {
    ...(Number.isFinite(meta.zoomFactor) ? { zoomFactor: meta.zoomFactor } : {}),
    ...(Number.isFinite(meta.deviceScaleFactor)
      ? { deviceScaleFactor: meta.deviceScaleFactor }
      : {}),
    ...(meta.scroll ? { scroll: { x: meta.scroll.x, y: meta.scroll.y } } : {}),
    ...(meta.stability ? { stability: meta.stability } : {}),
    ...(hasMaskList ? { masks: boundedMasks.map(({ source, rect }) => ({ source, rect })) } : {}),
    ...(diffsAdvertised &&
    record.imageDataUrl !== null &&
    hasMaskBudget &&
    Array.isArray(meta.unstableRegions)
      ? {
          ...(meta.originalMasks ? { originalMasks: meta.originalMasks } : {}),
          unstableRegions: meta.unstableRegions.map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })),
        }
      : {}),
  };
}

/**
 * Development source hints go only to a backend that advertises
 * `operations.sourceHints`, which checks each path before marking it
 * verified. Any other backend gets the capture without them.
 */
export function withAdvertisedSourceHints(
  capture: WebAnnotationCaptureInput,
  advertised: boolean,
): WebAnnotationCaptureInput {
  if (advertised || !capture.evidence?.sourceHints) return capture;
  const { sourceHints: _omitted, ...evidence } = capture.evidence;
  return { ...capture, evidence };
}

function sourceHintsAdvertised(environmentId: string, scope?: NodeScope): boolean {
  return getWebAnnotationCache(environmentId, scope).capabilities?.operations.sourceHints === true;
}

/**
 * Targets inside same-origin frames carry a `frame` scope only to a backend
 * that advertises `operations.frameTargets`; an older backend would refuse
 * the scope. There the note still saves, with the scope it had before frames
 * were reachable (`unsupported`, `iframe`), and its pin reports unsupported.
 */
export function withAdvertisedFrameScope(
  capture: WebAnnotationCaptureInput,
  advertised: boolean,
): WebAnnotationCaptureInput {
  if (advertised) return capture;
  const target = capture.target;
  const downgrade = (anchor: WebAnnotationAnchor): WebAnnotationAnchor =>
    anchor.scope.kind === "frame"
      ? { ...anchor, scope: { kind: "unsupported", reason: "iframe" } }
      : anchor;
  if (target.kind === "element" && target.anchor.scope.kind === "frame") {
    return { ...capture, target: { ...target, anchor: downgrade(target.anchor) } };
  }
  if (target.kind === "text-range" && target.container.scope.kind === "frame") {
    return { ...capture, target: { ...target, container: downgrade(target.container) } };
  }
  return capture;
}

function resultDiffsAdvertised(environmentId: string, scope?: NodeScope): boolean {
  return getWebAnnotationCache(environmentId, scope).capabilities?.operations.resultDiffs === true;
}

function frameTargetsAdvertised(environmentId: string, scope?: NodeScope): boolean {
  return getWebAnnotationCache(environmentId, scope).capabilities?.operations.frameTargets === true;
}

/** Durably note the receipt, then clear the spool record (both idempotent). */
export async function acknowledgeCommittedCapture(
  api: BrowserPreviewCaptureApi,
  ack: BrowserPreviewCaptureAck,
): Promise<boolean> {
  if (api.recordPendingCaptureReceipt) {
    await api.recordPendingCaptureReceipt(ack).catch(() => null);
  }
  try {
    await api.acknowledgePendingCapture(ack);
    return true;
  } catch {
    return false;
  }
}

/** The receipt of an earlier attempt, when the backend already committed it. */
export async function existingCaptureReceipt(
  environmentId: string,
  captureId: string,
  kind: CaptureCommitKind,
  /** The node that owns the environment; this view's backend when omitted. */
  scope?: NodeScope,
): Promise<WebAnnotationOperationReceipt | null> {
  const { receipt } = await webAnnotationCommand(
    WEB_ANNOTATION_COMMANDS.receipt,
    { environmentId, operationId: operationFor(captureId, kind) },
    undefined,
    scope,
  );
  return receipt ?? null;
}

export async function commitPendingCapture({
  api,
  environmentId,
  captureId,
  record,
  input,
  localRedaction,
  scope,
}: {
  api: BrowserPreviewCaptureApi;
  environmentId: string;
  captureId: string;
  record: BrowserPreviewPendingCapture;
  input: CaptureCommitInput;
  localRedaction?: { manualRegions: number; imageExcluded: boolean };
  /**
   * The node that owns the environment. An environment on another machine
   * keeps its annotations on that machine's backend, so the commit goes
   * there; this view's backend when omitted.
   */
  scope?: NodeScope;
}): Promise<CaptureCommitResult> {
  const descriptor = record.descriptor;
  const intent = captureIntent(captureId);
  const kind = captureCommitKind(record, intent, input);
  const ops = captureOperationIds(captureId);
  const operationId = operationFor(captureId, kind);

  // A previous attempt may have committed and lost its response.
  const command: typeof webAnnotationCommand = (name, args) =>
    webAnnotationCommand(name, args, undefined, scope);
  const existing = await existingCaptureReceipt(environmentId, captureId, kind, scope);
  let annotationId: string;
  let backendCaptureId: string;
  if (existing) {
    annotationId =
      existing.annotationId || (intent?.kind === "result" ? intent.annotationId : "") || "";
    backendCaptureId = existing.captureId ?? "";
  } else {
    const assetIds: string[] = [];
    if (record.imageDataUrl) {
      const staged = await command(WEB_ANNOTATION_COMMANDS.assetStage, {
        environmentId,
        operationId: ops.asset,
        mediaType: "image/png",
        data: pngBase64FromDataUrl(record.imageDataUrl),
      });
      assetIds.push(staged.asset.id);
      // A region keeps its source screenshot as context (asset 0, which
      // `target.imageRect` addresses) and adds the crop derived from the
      // already-redacted spool image.
      const crop = record.regionCrop;
      if (crop?.imageDataUrl && record.capture.target.kind === "region") {
        const cropped = await command(WEB_ANNOTATION_COMMANDS.assetStage, {
          environmentId,
          operationId: ops.cropAsset,
          mediaType: "image/png",
          data: pngBase64FromDataUrl(crop.imageDataUrl),
        });
        if (!assetIds.includes(cropped.asset.id)) assetIds.push(cropped.asset.id);
      }
    }
    const advertised = withAdvertisedFrameScope(
      withAdvertisedSourceHints(record.capture, sourceHintsAdvertised(environmentId, scope)),
      frameTargetsAdvertised(environmentId, scope),
    );
    const target =
      advertised.target.kind === "region" && record.regionCrop
        ? { ...advertised.target, imageRect: record.regionCrop.sourceRect }
        : advertised.target;
    const captureInput: WebAnnotationCaptureInput = {
      ...advertised,
      target,
      assetIds,
      redaction: mergedRedaction(record.capture, localRedaction, Boolean(record.imageDataUrl)),
    };
    if (kind === "result") {
      const requestId = intent?.kind === "result" ? intent.requestId : "";
      if (!requestId) throw new Error("This result capture lost its request. Capture it again.");
      const resultAnnotationId =
        intent?.kind === "result" ? intent.annotationId : (descriptor.annotationId ?? "");
      const result = await command(WEB_ANNOTATION_COMMANDS.resultCapture, {
        environmentId,
        operationId,
        requestId,
        // Required for batch requests: names which selected note this shows.
        ...(resultAnnotationId ? { annotationId: resultAnnotationId } : {}),
        ...resultCaptureMetadata(record, resultDiffsAdvertised(environmentId, scope)),
        capture: captureInput,
      });
      annotationId = resultAnnotationId;
      backendCaptureId = result.captureId;
    } else {
      let receipt: WebAnnotationOperationReceipt;
      if (kind === "replace") {
        const targetAnnotationId = input.annotationId ?? descriptor.annotationId!;
        // Never guess a revision: an unknown one is read from the backend so
        // the replace is checked against current content.
        const expectedContentRevision =
          input.expectedContentRevision ??
          (
            await command(WEB_ANNOTATION_COMMANDS.get, {
              environmentId,
              annotationId: targetAnnotationId,
            })
          ).annotation.contentRevision;
        receipt = await command(WEB_ANNOTATION_COMMANDS.captureReplace, {
          environmentId,
          operationId,
          annotationId: targetAnnotationId,
          expectedContentRevision,
          capture: captureInput,
          ...(input.body.trim() ? { body: input.body } : {}),
        });
      } else {
        receipt = await command(WEB_ANNOTATION_COMMANDS.create, {
          environmentId,
          operationId,
          capture: captureInput,
          body: input.body,
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          ...(input.draftId ? { draftId: input.draftId } : {}),
        });
      }
      annotationId = receipt.annotationId;
      backendCaptureId = receipt.captureId ?? "";
    }
  }
  const acknowledged = await acknowledgeCommittedCapture(api, {
    captureId,
    annotationId,
    backendCaptureId,
  });
  return { annotationId, backendCaptureId, ackPending: !acknowledged };
}
