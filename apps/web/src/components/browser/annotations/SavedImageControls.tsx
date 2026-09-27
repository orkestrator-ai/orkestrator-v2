import { useRef, useState } from "react";
import { EyeOff } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationCapture,
  type WebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import {
  describeWebAnnotationError,
  isTransientWebAnnotationError,
  newWebAnnotationOperationId,
  pngBase64FromDataUrl,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { redactPngDataUrl, type RedactionRect } from "@/lib/web-annotations/redaction";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { useAnnotationPanel } from "./panel-context";
import { RedactionEditor } from "./RedactionEditor";

/**
 * A new capture revision carrying the same target and evidence as `capture`,
 * with a replaced (or no) image. Committed captures are immutable, so this is
 * how a saved note stops sending an image or sends a redacted one.
 */
export function capturePrivacyRevision(
  capture: WebAnnotationCapture,
  image: { assetId: string; manualRegions: number } | null,
): WebAnnotationCaptureInput | null {
  if (capture.target.kind === "legacy-unresolved" || capture.producer === "legacy-import") {
    return null;
  }
  return {
    producer: capture.producer,
    capturedAt: capture.capturedAt,
    documentGeneration: capture.documentGeneration,
    page: capture.page,
    target: capture.target,
    geometry: capture.geometry
      ? { ...capture.geometry, image: image ? capture.geometry.image : null }
      : null,
    evidence: capture.evidence,
    // Only the (redacted) source screenshot is kept. A region crop was cut
    // from the unredacted source, so carrying it forward could resurrect a
    // redacted area; the thread falls back to the source and its imageRect.
    assetIds: image ? [image.assetId] : [],
    redaction: {
      ...capture.redaction,
      manualRegions: Math.min(
        WEB_ANNOTATION_LIMITS.redactionRegions,
        capture.redaction.manualRegions + (image?.manualRegions ?? 0),
      ),
      imageExcluded: image === null,
    },
    ...(capture.state === "stale" ? { stale: { reason: capture.stateReason ?? "stale" } } : {}),
  };
}

/**
 * Privacy controls for a saved note's image: exclude it from future requests
 * or replace it with a redacted copy. The previous capture stays in this
 * note's history (the backend keeps committed evidence immutable), which the
 * UI states plainly.
 */
export function SavedImageControls({
  annotation,
  capture,
}: {
  annotation: WebAnnotation;
  capture: WebAnnotationCapture;
}) {
  const { environmentId, features, announce } = useAnnotationPanel();
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [redacting, setRedacting] = useState<{ dataUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const assetId = capture.assetIds[0];
  const image = capture.geometry?.image;
  if (!features.author || annotation.archivedAt || !assetId) return null;
  if (!capturePrivacyRevision(capture, null)) return null;

  const replace = async (label: string, input: WebAnnotationCaptureInput) => {
    operationRef.current ??= newWebAnnotationOperationId("image-privacy");
    await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.captureReplace, {
      environmentId,
      operationId: operationRef.current,
      annotationId: annotation.id,
      expectedContentRevision: annotation.contentRevision,
      capture: input,
    });
    operationRef.current = null;
    refreshWebAnnotations(environmentId, { annotationIds: [annotation.id] });
    announce(label);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      // Keep the id across a lost response so a retry is idempotent.
      if (!isTransientWebAnnotationError(actionError)) operationRef.current = null;
      setError(describeWebAnnotationError(actionError));
    } finally {
      setBusy(false);
    }
  };

  const exclude = () =>
    run(async () => {
      await replace("Image excluded from future requests", capturePrivacyRevision(capture, null)!);
      setConfirmExclude(false);
    });

  const startRedaction = () =>
    run(async () => {
      const { data } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.assetGet, {
        environmentId,
        assetId,
      });
      setRedacting({ dataUrl: `data:image/png;base64,${data}` });
    });

  const applyRedaction = (dataUrl: string, regions: RedactionRect[]) =>
    run(async () => {
      if (regions.length === 0) {
        setRedacting(null);
        return;
      }
      const redacted = await redactPngDataUrl(dataUrl, regions);
      const staged = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.assetStage, {
        environmentId,
        operationId: newWebAnnotationOperationId("redacted-asset"),
        mediaType: "image/png",
        data: pngBase64FromDataUrl(redacted),
      });
      await replace(
        "Redacted image saved",
        capturePrivacyRevision(capture, {
          assetId: staged.asset.id,
          manualRegions: regions.length,
        })!,
      );
      setRedacting(null);
    });

  return (
    <div className="space-y-1 text-[11px]" data-saved-image-controls>
      {redacting && image ? (
        <RedactionEditor
          imageDataUrl={redacting.dataUrl}
          imageSize={{ width: image.width, height: image.height }}
          busy={busy}
          onCancel={() => setRedacting(null)}
          onApply={(regions) => void applyRedaction(redacting.dataUrl, regions)}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {image && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void startRedaction()}
            >
              Redact image…
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={busy}
            onClick={() => setConfirmExclude(true)}
          >
            <EyeOff className="h-3 w-3" aria-hidden />
            Exclude image
          </Button>
        </div>
      )}
      {confirmExclude && (
        <div role="alert" className="space-y-1 rounded border border-border/60 p-1.5">
          <p>
            Future requests will not include this image. Requests already sent keep theirs, and the
            original stays in this note's history.
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void exclude()}
            >
              Exclude image
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setConfirmExclude(false)}
            >
              Keep
            </Button>
          </div>
        </div>
      )}
      {redacting && (
        <p className="text-muted-foreground">
          The redacted copy becomes the note's current image. The original stays in this note's
          history.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
