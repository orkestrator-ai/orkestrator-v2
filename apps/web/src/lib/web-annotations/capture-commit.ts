/**
 * Commit one pending desktop capture to the backend (plan step 04, steps 3–5
 * of the acknowledged transfer protocol) and acknowledge it to the spool.
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
  type WebAnnotationCaptureInput,
  type WebAnnotationOperationReceipt,
  type WebAnnotationResultCaptureMetadata,
} from "@orkestrator/protocol/web-annotations";
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
 * desktops, which the backend accepts.
 */
export function resultCaptureMetadata(
  record: Pick<BrowserPreviewPendingCapture, "result">,
): WebAnnotationResultCaptureMetadata {
  const meta = record.result;
  if (!meta) return {};
  return {
    ...(Number.isFinite(meta.zoomFactor) ? { zoomFactor: meta.zoomFactor } : {}),
    ...(Number.isFinite(meta.deviceScaleFactor)
      ? { deviceScaleFactor: meta.deviceScaleFactor }
      : {}),
    ...(meta.scroll ? { scroll: { x: meta.scroll.x, y: meta.scroll.y } } : {}),
    ...(meta.stability ? { stability: meta.stability } : {}),
    ...(Array.isArray(meta.masks)
      ? { masks: meta.masks.map((mask) => ({ source: mask.source, rect: mask.rect })) }
      : {}),
  };
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
): Promise<WebAnnotationOperationReceipt | null> {
  const { receipt } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.receipt, {
    environmentId,
    operationId: operationFor(captureId, kind),
  });
  return receipt ?? null;
}

export async function commitPendingCapture({
  api,
  environmentId,
  captureId,
  record,
  input,
  localRedaction,
}: {
  api: BrowserPreviewCaptureApi;
  environmentId: string;
  captureId: string;
  record: BrowserPreviewPendingCapture;
  input: CaptureCommitInput;
  localRedaction?: { manualRegions: number; imageExcluded: boolean };
}): Promise<CaptureCommitResult> {
  const descriptor = record.descriptor;
  const intent = captureIntent(captureId);
  const kind = captureCommitKind(record, intent, input);
  const ops = captureOperationIds(captureId);
  const operationId = operationFor(captureId, kind);

  // A previous attempt may have committed and lost its response.
  const existing = await existingCaptureReceipt(environmentId, captureId, kind);
  let annotationId: string;
  let backendCaptureId: string;
  if (existing) {
    annotationId =
      existing.annotationId || (intent?.kind === "result" ? intent.annotationId : "") || "";
    backendCaptureId = existing.captureId ?? "";
  } else {
    const assetIds: string[] = [];
    if (record.imageDataUrl) {
      const staged = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.assetStage, {
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
        const cropped = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.assetStage, {
          environmentId,
          operationId: ops.cropAsset,
          mediaType: "image/png",
          data: pngBase64FromDataUrl(crop.imageDataUrl),
        });
        if (!assetIds.includes(cropped.asset.id)) assetIds.push(cropped.asset.id);
      }
    }
    const target =
      record.capture.target.kind === "region" && record.regionCrop
        ? { ...record.capture.target, imageRect: record.regionCrop.sourceRect }
        : record.capture.target;
    const captureInput: WebAnnotationCaptureInput = {
      ...record.capture,
      target,
      assetIds,
      redaction: mergedRedaction(record.capture, localRedaction, Boolean(record.imageDataUrl)),
    };
    if (kind === "result") {
      const requestId = intent?.kind === "result" ? intent.requestId : "";
      if (!requestId) throw new Error("This result capture lost its request. Capture it again.");
      const resultAnnotationId =
        intent?.kind === "result" ? intent.annotationId : (descriptor.annotationId ?? "");
      const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.resultCapture, {
        environmentId,
        operationId,
        requestId,
        // Required for batch requests: names which selected note this shows.
        ...(resultAnnotationId ? { annotationId: resultAnnotationId } : {}),
        ...resultCaptureMetadata(record),
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
            await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.get, {
              environmentId,
              annotationId: targetAnnotationId,
            })
          ).annotation.contentRevision;
        receipt = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.captureReplace, {
          environmentId,
          operationId,
          annotationId: targetAnnotationId,
          expectedContentRevision,
          capture: captureInput,
          ...(input.body.trim() ? { body: input.body } : {}),
        });
      } else {
        receipt = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.create, {
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
