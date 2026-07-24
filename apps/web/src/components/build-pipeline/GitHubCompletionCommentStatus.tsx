import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";

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
  const clearCompletionCommentStatus = useBuildPipelineStore(
    (state) => state.clearCompletionCommentStatus,
  );

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
        onClick={() => clearCompletionCommentStatus(pipeline.id)}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Retry comment
      </Button>
    </div>
  );
}
