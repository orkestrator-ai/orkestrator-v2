import type { ReactNode } from "react";
import { CloudOff, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { WebAnnotationFeatureFlags } from "@/lib/web-annotations/client";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import type { WebAnnotationEnvironmentCache } from "@/stores/webAnnotationStore";

/**
 * Transport and capability notices, kept apart from domain state: being
 * offline never changes how a note or request is labelled.
 */
export function AnnotationStatus({
  environmentId,
  cache,
  features,
  desktopCapture,
  announcement,
}: {
  environmentId: string;
  cache: WebAnnotationEnvironmentCache;
  features: WebAnnotationFeatureFlags;
  desktopCapture: boolean;
  announcement: string;
}) {
  const notices: Array<{ key: string; tone: "info" | "warning"; node: ReactNode }> = [];
  if (cache.capabilityStatus === "unavailable") {
    notices.push({
      key: "unavailable",
      tone: "warning",
      node:
        cache.capabilityReason ??
        "This backend does not support web annotations. Update the backend to use them.",
    });
  } else if (features.mode === "disabled") {
    notices.push({
      key: "rollout-disabled",
      tone: "warning",
      node: "Web annotations are turned off on this backend. Saved notes are kept and come back when they are turned on again.",
    });
  } else if (features.mode === "read-only") {
    notices.push({
      key: "rollout-read-only",
      tone: "warning",
      node: "Read-only recovery mode: you can read and resolve notes, keep drafts, and stop or recover requests already sent. New notes, replies, and requests are paused.",
    });
  }
  if (
    cache.capabilityStatus !== "unavailable" &&
    cache.capabilities &&
    cache.capabilities.storage !== "ready"
  ) {
    notices.push({
      key: "degraded",
      tone: "warning",
      node: `Annotation storage is ${cache.capabilities.storage}${
        cache.capabilityReason ? `: ${cache.capabilityReason}` : ""
      }. Saved notes stay readable; changes are disabled.`,
    });
  }
  if (cache.sync.status === "error" || cache.capabilityStatus === "error") {
    notices.push({
      key: "offline",
      tone: "warning",
      node: (
        <span className="flex flex-wrap items-center gap-2">
          <span>
            Disconnected from the backend
            {cache.sync.lastSyncedAt
              ? ` — showing notes from ${formatRelativeTime(cache.sync.lastSyncedAt)}`
              : ""}
            . Unsaved text is kept.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => refreshWebAnnotations(environmentId, { full: true })}
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </span>
      ),
    });
  }
  if (
    cache.capabilityStatus === "available" &&
    features.mode === "enabled" &&
    features.author &&
    !features.capture
  ) {
    notices.push({
      key: "capture",
      tone: "info",
      node: desktopCapture
        ? cache.capabilities?.operations.captureAccept
          ? "Open a page in this preview to capture targets. Saved notes stay available."
          : "Capture is not enabled by this backend yet. You can still read, reply, discuss, and review notes."
        : "Capturing page targets needs the Orkestrator desktop app. You can still read, reply, discuss, and review saved notes here.",
    });
  }
  if (cache.migration && cache.migration.importedAnnotations > 0) {
    notices.push({
      key: "migration",
      tone: "info",
      node: `${cache.migration.importedAnnotations} older browser note${
        cache.migration.importedAnnotations === 1 ? " was" : "s were"
      } imported. Use the “Imported browser notes” filter to review them.`,
    });
  }

  return (
    <div className="shrink-0">
      {notices.map((notice) => (
        <div
          key={notice.key}
          data-annotation-notice={notice.key}
          className={
            notice.tone === "warning"
              ? "flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
              : "flex items-start gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
          }
        >
          {notice.key === "offline" ? (
            <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : notice.tone === "warning" ? (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <div className="min-w-0 flex-1 break-words">{notice.node}</div>
        </div>
      ))}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
