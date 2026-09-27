import { useState } from "react";
import { Clock, EyeOff, ImageOff, RotateCcw, ScanLine, TriangleAlert } from "lucide-react";
import type {
  BrowserPreviewPendingCapture,
  BrowserPreviewPendingCaptureDescriptor,
} from "@orkestrator/protocol/browser-preview";
import { Button } from "@/components/ui/button";
import { CAPTURE_MODE_TARGET } from "@/lib/web-annotations/capture-intents";
import type { RedactionRect } from "@/lib/web-annotations/redaction";
import { formatBytes, targetPrecision } from "./format";
import { RedactionEditor } from "./RedactionEditor";

export function expiryLabel(expiresAt: string): string {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return "Kept locally until saved";
  return `Kept on this computer until ${new Date(time).toLocaleString()} unless saved`;
}

/** Within this window an unsaved capture is flagged as expiring soon. */
export const CAPTURE_EXPIRY_WARNING_MS = 2 * 60 * 60 * 1000;

export function expiresSoon(expiresAt: string, now = Date.now()): boolean {
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time - now <= CAPTURE_EXPIRY_WARNING_MS;
}

/**
 * A pending (not yet saved) capture shown in trusted UI: thumbnail, target,
 * precision, local-expiry, and privacy controls applied before upload.
 */
export function AnnotationCaptureCard({
  descriptor,
  record,
  disabled,
  onRedact,
  onExcludeImage,
  onRecapture,
  recapturing,
}: {
  descriptor: BrowserPreviewPendingCaptureDescriptor;
  record: BrowserPreviewPendingCapture | null;
  disabled?: boolean;
  onRedact: (regions: RedactionRect[]) => Promise<boolean>;
  onExcludeImage: () => Promise<boolean>;
  /** Select the same target again (desktop recapture); absent when unsupported. */
  onRecapture?: () => void;
  recapturing?: boolean;
}) {
  const [redacting, setRedacting] = useState(false);
  const [busy, setBusy] = useState(false);
  const image = record?.imageDataUrl ?? null;
  const imageSize = descriptor.image
    ? { width: descriptor.image.width, height: descriptor.image.height }
    : null;
  const excluded = record !== null && !image;

  return (
    <div
      className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2"
      data-pending-capture={descriptor.captureId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && redacting) {
          event.stopPropagation();
          setRedacting(false);
        }
      }}
    >
      <div className="flex items-start gap-2">
        <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-xs font-medium text-foreground"
            title={descriptor.targetLabel}
          >
            {descriptor.targetLabel || "Selected target"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={descriptor.displayUrl}>
            {descriptor.pageTitle || descriptor.displayUrl}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {targetPrecision(CAPTURE_MODE_TARGET[descriptor.mode])}
      </p>
      {descriptor.stale && (
        <div className="space-y-1 text-[11px] text-amber-200" data-stale-capture>
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span>
              The page changed while capturing
              {descriptor.staleReason ? `: ${descriptor.staleReason}` : ""}. This capture is marked
              stale; you can recapture the same target, save it as it is, or discard it.
            </span>
          </p>
          {onRecapture && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={disabled || recapturing}
              aria-label={`Recapture ${descriptor.targetLabel || "the selected target"}`}
              onClick={onRecapture}
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Recapture
            </Button>
          )}
        </div>
      )}
      {descriptor.responsive && (
        <p className="text-[11px] text-muted-foreground">
          Viewport width {descriptor.responsive.viewportWidth} px ({descriptor.responsive.index + 1}{" "}
          of {descriptor.responsive.count})
        </p>
      )}
      {redacting && image && imageSize ? (
        <RedactionEditor
          imageDataUrl={image}
          imageSize={imageSize}
          busy={busy}
          onCancel={() => setRedacting(false)}
          onApply={(regions) => {
            setBusy(true);
            void onRedact(regions)
              .then((ok) => {
                if (ok) setRedacting(false);
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : image ? (
        <>
          <img
            src={image}
            alt={`Capture of ${descriptor.targetLabel || "the selected target"}`}
            className="max-h-48 w-full rounded border border-border/60 object-contain"
          />
          {record?.regionCrop?.imageDataUrl && (
            <figure className="space-y-0.5">
              <img
                src={record.regionCrop.imageDataUrl}
                alt="Selected region"
                className="max-h-32 rounded border border-primary/40 object-contain"
              />
              <figcaption className="text-[10px] text-muted-foreground">
                Selected region; the full screenshot is saved with it as context.
              </figcaption>
            </figure>
          )}
        </>
      ) : (
        <div className="flex items-center gap-1.5 rounded border border-dashed border-border/70 px-2 py-2 text-[11px] text-muted-foreground">
          <ImageOff className="h-3.5 w-3.5" aria-hidden />
          {excluded ? "Image excluded — only text evidence will be saved." : "Loading capture…"}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        <span>{expiryLabel(descriptor.expiresAt)}</span>
        {descriptor.image && image && (
          <span>
            · {descriptor.image.width}×{descriptor.image.height},{" "}
            {formatBytes(descriptor.image.bytes)}
            {descriptor.image.reduced ? " (reduced)" : ""}
          </span>
        )}
      </div>
      {image && !redacting && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={disabled || !imageSize}
            onClick={() => setRedacting(true)}
          >
            Redact image…
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={disabled || busy}
            onClick={() => {
              setBusy(true);
              void onExcludeImage().finally(() => setBusy(false));
            }}
          >
            <EyeOff className="h-3 w-3" aria-hidden />
            Exclude image
          </Button>
        </div>
      )}
    </div>
  );
}
