import { useState } from "react";
import { MessageSquare } from "lucide-react";
import {
  parseWebAnnotationRequestMarker,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { openWebAnnotationRequest } from "@/lib/web-annotations/navigation";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

export function webAnnotationMarkerFor(text: string | null | undefined) {
  return text ? parseWebAnnotationRequestMarker(text) : null;
}

const OPERATION: Record<WebAnnotationRequestOperation, string> = {
  discuss: "discussion",
  implement: "change request",
};

/**
 * Compact link from a browser-originated chat turn back to its annotation
 * thread. Opening it selects the same thread; nothing is copied into a draft.
 */
export function WebAnnotationRequestChip({
  requestId,
  operation,
  annotationCount,
  environmentId,
}: {
  requestId: string;
  operation: WebAnnotationRequestOperation;
  annotationCount: number;
  /** Defaults to the active environment (the chat being read). */
  environmentId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 text-xs"
      data-web-annotation-request={requestId}
    >
      <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-foreground">
        <MessageSquare className="h-3 w-3" aria-hidden />
        Web annotation request · {OPERATION[operation]} · {annotationCount} note
        {annotationCount === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        className="rounded text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        disabled={opening}
        onClick={() => {
          const target = environmentId ?? usePaneLayoutStore.getState().activeEnvironmentId;
          if (!target) {
            setError("Open this environment to view the annotation.");
            return;
          }
          setOpening(true);
          setError(null);
          void openWebAnnotationRequest(target, requestId)
            .then((result) => {
              if (!result.ok) setError(result.error);
            })
            .finally(() => setOpening(false));
        }}
      >
        Open annotation
      </button>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
