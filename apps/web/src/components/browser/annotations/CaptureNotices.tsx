import { useState } from "react";
import { Clock, X } from "lucide-react";
import type {
  BrowserPreviewExpiredCaptureNotice,
  BrowserPreviewPendingCaptureDescriptor,
} from "@orkestrator/protocol/browser-preview";
import { Button } from "@/components/ui/button";
import { CAPTURE_MODE_TARGET } from "@/lib/web-annotations/capture-intents";
import { expiresSoon, expiryLabel } from "./AnnotationCaptureCard";
import { TARGET_KIND_LABELS } from "./format";

function when(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "an unknown time";
}

/**
 * Content-free notices for captures that expired before they were saved. The
 * capture itself is gone; the notice only says what was lost and when.
 */
export function ExpiredCaptureNotices({
  notices,
  onDismiss,
}: {
  notices: readonly BrowserPreviewExpiredCaptureNotice[];
  onDismiss: (captureIds?: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (notices.length === 0) return null;
  const dismiss = (ids?: string[]) => {
    setBusy(true);
    void onDismiss(ids).finally(() => setBusy(false));
  };
  return (
    <section
      aria-label="Expired captures"
      className="shrink-0 space-y-1 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px]"
      data-expired-notices
    >
      <div className="flex items-center gap-1.5">
        <Clock className="h-3 w-3 text-amber-200" aria-hidden />
        <p className="flex-1 font-medium text-amber-200">
          {notices.length} unsaved capture{notices.length === 1 ? "" : "s"} expired
        </p>
        {notices.length > 1 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => dismiss()}
          >
            Dismiss all
          </Button>
        )}
      </div>
      <ul className="space-y-0.5">
        {notices.map((notice) => (
          <li
            key={notice.captureId}
            className="flex items-start gap-1.5"
            data-expired={notice.captureId}
          >
            <span className="min-w-0 flex-1 break-words text-muted-foreground">
              {TARGET_KIND_LABELS[CAPTURE_MODE_TARGET[notice.mode]]} capture on{" "}
              {notice.displayUrl || "a page"} from {when(notice.createdAt)} was removed{" "}
              {notice.whileClosed ? "while Orkestrator was closed" : `at ${when(notice.expiredAt)}`}{" "}
              because it was not saved within 24 hours.
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-5 w-5 shrink-0"
              disabled={busy}
              aria-label={`Dismiss expired capture notice from ${when(notice.createdAt)}`}
              onClick={() => dismiss([notice.captureId])}
            >
              <X className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pending captures other than the one in the editor, with their local expiry. */
export function OtherPendingCaptures({
  pending,
  onOpen,
}: {
  pending: readonly BrowserPreviewPendingCaptureDescriptor[];
  onOpen: (captureId: string) => void;
}) {
  if (pending.length === 0) return null;
  return (
    <div className="shrink-0 space-y-1 border-b border-border/70 px-3 py-1.5 text-[11px]">
      <p className="font-medium">Unsaved captures ({pending.length})</p>
      <p className="text-muted-foreground">
        These are only on this computer until you add a comment and save them.
      </p>
      {pending.map((descriptor) => (
        <div key={descriptor.captureId} className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1" title={expiryLabel(descriptor.expiresAt)}>
            <span className="block truncate">
              {descriptor.targetLabel || "Capture"} ·{" "}
              {descriptor.pageTitle || descriptor.displayUrl}
              {descriptor.responsive ? ` · ${descriptor.responsive.viewportWidth} px` : ""}
              {descriptor.stale ? " · stale" : ""}
            </span>
            <span
              className={
                expiresSoon(descriptor.expiresAt)
                  ? "block text-amber-200"
                  : "block text-muted-foreground"
              }
              data-capture-expiry={descriptor.captureId}
            >
              {expiresSoon(descriptor.expiresAt) ? "Expires soon — " : ""}
              {expiryLabel(descriptor.expiresAt)}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            aria-label={`Continue unsaved capture of ${descriptor.targetLabel || "a target"}`}
            onClick={() => onOpen(descriptor.captureId)}
          >
            Continue
          </Button>
        </div>
      ))}
    </div>
  );
}
