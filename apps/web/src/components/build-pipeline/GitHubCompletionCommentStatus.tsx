import { AlertCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import { retryBuildPipelineCompletionComment } from "@/lib/backend";

interface GitHubCompletionCommentStatusProps {
  pipeline: BuildPipeline;
}

/**
 * Keeps GitHub completion-comment recovery available from the persisted build
 * itself. The originating issue may already be closed and absent from the
 * open-only GitHub board.
 */
export function GitHubCompletionCommentStatus({
  pipeline,
}: GitHubCompletionCommentStatusProps) {
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const [retryPending, setRetryPending] = useState(false);

  if (
    pipeline.source?.type !== "github"
    || pipeline.completionCommentStatus !== "failed"
  ) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2"
      role="alert"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-xs text-destructive">
        GitHub completion comment failed:{" "}
        {pipeline.completionCommentError ?? "GitHub did not accept the comment."}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        aria-label="Retry GitHub completion comment"
        disabled={retryPending}
        onClick={async () => {
          if (retryPending) return;
          setRetryPending(true);
          try {
            replacePipeline(
              await retryBuildPipelineCompletionComment(pipeline.id),
            );
          } catch (error) {
            toast.error("Failed to retry GitHub completion comment", {
              description:
                error instanceof Error ? error.message : String(error),
            });
          } finally {
            setRetryPending(false);
          }
        }}
      >
        <RefreshCw className={`h-3.5 w-3.5${retryPending ? " animate-spin" : ""}`} />
        {retryPending ? "Retrying…" : "Retry comment"}
      </Button>
    </div>
  );
}
