import { useState } from "react";
import type { BuildPipelineRestartSelection } from "@orkestrator/protocol/build-pipeline-restart-selection";
import type { BuildPipelineAgent, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { ModelRestartDialog } from "@/components/review/MultiReviewRestartDialog";

interface RestartInRequest {
  stageId: string;
  title: string;
  selection: BuildPipelineRestartSelection;
}

/**
 * "Restart in…" for a pipeline step: the same agent and model picker Multi
 * Review's steps use, opened on the session's own selection. The dialog stays
 * open with the backend's reason when the restart is refused.
 */
export function usePipelineRestartIn(
  catalog: AgentModelCatalog,
  restart: (stageId: string, selection: BuildPipelineRestartSelection) => Promise<string | null>,
  pending: boolean,
  fallbackAgent: BuildPipelineAgent,
) {
  const [request, setRequest] = useState<RestartInRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (session: PipelineSession, title: string) => {
    setError(null);
    setRequest({
      stageId: session.sdkSessionId,
      title,
      selection: {
        agent: session.agent ?? fallbackAgent,
        // An unpinned session opens on the harness's default model.
        model: session.model ?? "",
        ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
        ...(typeof session.fastMode === "boolean" ? { fastMode: session.fastMode } : {}),
      },
    });
  };

  const close = () => {
    setRequest(null);
    setError(null);
  };

  const dialog = request ? (
    <ModelRestartDialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      stepLabel={request.title}
      description={`Choose the agent and model ${request.title} runs on from now on. Every later step is reset, as with Restart from here.`}
      catalog={catalog}
      defaultSelection={request.selection}
      error={error}
      busy={pending}
      onSubmit={async (selection) => {
        const failure = await restart(request.stageId, selection);
        if (failure) setError(failure);
        else close();
      }}
    />
  ) : null;

  return { open, dialog };
}
