import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores";
import { postLinearCompletionComment } from "@/lib/backend";

function createCompletionComment(pipeline: BuildPipeline): string {
  const source = pipeline.source?.type === "linear" ? pipeline.source : null;
  const environment = useEnvironmentStore.getState().getEnvironmentById(pipeline.environmentId);
  const result = pipeline.phase === "complete" ? "Complete" : "Failed";
  const lines = [
    `Orkestrator build pipeline finished for ${source?.issueIdentifier ?? pipeline.taskTitle}.`,
    "",
    `Result: ${result}`,
    `Pipeline: ${pipeline.id}`,
    `Agent: ${pipeline.agentType}`,
  ];

  if (environment?.name) lines.push(`Environment: ${environment.name}`);
  if (environment?.prUrl) lines.push(`Pull request: ${environment.prUrl}`);
  if (pipeline.verificationResult) {
    lines.push(`Verification: ${pipeline.verificationResult === "pass" ? "Passed" : "Failed"}`);
  }
  if (pipeline.error) lines.push(`Error: ${pipeline.error}`);
  if (pipeline.verificationFeedback) {
    lines.push("", "Latest verification feedback:", pipeline.verificationFeedback);
  }

  return lines.join("\n");
}

export function LinearPipelineCompletionMonitor() {
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const setCompletionCommentStatus = useBuildPipelineStore((state) => state.setCompletionCommentStatus);
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const pipeline of pipelines.values()) {
      if (pipeline.source?.type !== "linear") continue;
      if (pipeline.phase !== "complete" && pipeline.phase !== "failed") continue;
      if (pipeline.completionCommentStatus) continue;
      if (inFlightRef.current.has(pipeline.id)) continue;

      inFlightRef.current.add(pipeline.id);
      setCompletionCommentStatus(pipeline.id, "posting");

      void postLinearCompletionComment(
        pipeline.id,
        pipeline.source.issueId,
        createCompletionComment(pipeline),
      )
        .then((result) => {
          setCompletionCommentStatus(pipeline.id, "posted", {
            commentId: result.commentId,
            postedAt: result.postedAt,
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Failed to post Linear completion comment";
          setCompletionCommentStatus(pipeline.id, "failed", { error: message });
          toast.error("Linear comment failed", { description: message });
        })
        .finally(() => {
          inFlightRef.current.delete(pipeline.id);
        });
    }
  }, [pipelines, setCompletionCommentStatus]);

  return null;
}
