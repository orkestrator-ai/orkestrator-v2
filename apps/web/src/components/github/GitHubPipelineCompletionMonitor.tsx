import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores";
import { getEnvironment, postGitHubCompletionComment } from "@/lib/backend";

export async function createGitHubCompletionComment(pipeline: BuildPipeline): Promise<string> {
  const source = pipeline.source?.type === "github" ? pipeline.source : null;
  const environment = useEnvironmentStore.getState().getEnvironmentById(pipeline.environmentId)
    ?? (pipeline.environmentId ? await getEnvironment(pipeline.environmentId) : null);
  const result = pipeline.phase === "complete" ? "Complete" : "Failed";
  const issueName = source
    ? `${source.repositoryOwner}/${source.repositoryName}#${source.issueNumber}`
    : pipeline.taskTitle;
  const lines = [
    `Orkestrator build pipeline finished for ${issueName}.`,
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

/**
 * Runs at the app root so completion is reported even when the originating
 * project or issue view is not mounted.
 */
export function GitHubPipelineCompletionMonitor() {
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const setCompletionCommentStatus = useBuildPipelineStore((state) => state.setCompletionCommentStatus);
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const pipeline of pipelines.values()) {
      const source = pipeline.source;
      if (source?.type !== "github") continue;
      if (pipeline.phase !== "complete" && pipeline.phase !== "failed") continue;
      if (pipeline.completionCommentStatus) continue;
      if (inFlightRef.current.has(pipeline.id)) continue;

      inFlightRef.current.add(pipeline.id);
      setCompletionCommentStatus(pipeline.id, "posting");

      void createGitHubCompletionComment(pipeline)
        .then((body) => postGitHubCompletionComment(
          pipeline.id,
          pipeline.projectId,
          source.repositoryOwner,
          source.repositoryName,
          source.issueNumber,
          body,
        ))
        .then((result) => {
          setCompletionCommentStatus(pipeline.id, "posted", {
            commentId: result.commentId,
            postedAt: result.postedAt,
          });
        })
        .catch((error) => {
          const message = error instanceof Error
            ? error.message
            : "Failed to post GitHub completion comment";
          setCompletionCommentStatus(pipeline.id, "failed", { error: message });
          toast.error("GitHub comment failed", { description: message });
        })
        .finally(() => {
          inFlightRef.current.delete(pipeline.id);
        });
    }
  }, [pipelines, setCompletionCommentStatus]);

  return null;
}
