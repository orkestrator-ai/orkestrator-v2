import { AlertCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import { retryBuildPipelineCompletionComment } from "@/lib/backend";

interface BuildCompletionStatusProps {
  pipeline: BuildPipeline;
}

/**
 * How the backend describes the terminal hand-off it failed to complete.
 *
 * Every source has one: GitHub and Linear get a comment on the originating
 * issue, and a kanban build gets its card moved. The backend records all three
 * failures the same way and never retries any of them, so all three need a
 * surface here — a kanban card silently stranded in the wrong column is exactly
 * as invisible as an unposted comment, and harder to notice.
 */
const FAILURE_COPY: Record<
  NonNullable<BuildPipeline["source"]>["type"],
  { label: string; fallback: string; retryLabel: string }
> = {
  github: {
    label: "GitHub completion comment failed",
    fallback: "GitHub did not accept the comment.",
    retryLabel: "Retry GitHub completion comment",
  },
  linear: {
    label: "Linear completion comment failed",
    fallback: "Linear did not accept the comment.",
    retryLabel: "Retry Linear completion comment",
  },
  kanban: {
    label: "Updating the task board failed",
    fallback: "The task could not be moved to its final column.",
    retryLabel: "Retry the task board update",
  },
};

/**
 * Keeps terminal-hand-off recovery available from the persisted build itself.
 * The originating issue may already be closed and absent from the open-only
 * GitHub board, and a kanban card has no other surface at all.
 */
export function BuildCompletionStatus({
  pipeline,
}: BuildCompletionStatusProps) {
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const [retryPending, setRetryPending] = useState(false);

  const source = pipeline.source;
  if (!source || pipeline.completionCommentStatus !== "failed") {
    return null;
  }
  const copy = FAILURE_COPY[source.type];

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2"
      role="alert"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-xs text-destructive">
        {copy.label}: {pipeline.completionCommentError ?? copy.fallback}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        aria-label={copy.retryLabel}
        disabled={retryPending}
        onClick={async () => {
          if (retryPending) return;
          setRetryPending(true);
          try {
            replacePipeline(
              await retryBuildPipelineCompletionComment(pipeline.id),
            );
          } catch (error) {
            toast.error(`Failed to retry: ${copy.label.toLowerCase()}`, {
              description:
                error instanceof Error ? error.message : String(error),
            });
          } finally {
            setRetryPending(false);
          }
        }}
      >
        <RefreshCw className={`h-3.5 w-3.5${retryPending ? " animate-spin" : ""}`} />
        {retryPending ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
