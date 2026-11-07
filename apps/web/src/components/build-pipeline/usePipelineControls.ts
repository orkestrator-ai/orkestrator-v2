import { useState } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import type { BuildPipelineRestartSelection } from "@orkestrator/protocol/build-pipeline-restart-selection";
import { useScopeBackend } from "@/hooks/useScopeBackend";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pipeline's controls, shared by the header, the node context menus and
 * the inspector. One request at a time: every control is disabled while one
 * is in flight. Each answer is the backend's authoritative snapshot.
 *
 * `onFollow` runs after a control that opens a new session, so the view
 * follows the pipeline there rather than holding the stage being read.
 */
export function usePipelineControls(pipeline: BuildPipeline | undefined, onFollow: () => void) {
  const nodeBackend = useScopeBackend();
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const [pending, setPending] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (!pipeline || pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const runControl = (action: "pause" | "resume" | "cancel") =>
    run(async () => {
      try {
        const next =
          action === "pause"
            ? await nodeBackend.pauseBuildPipeline(pipeline!.id)
            : action === "resume"
              ? await nodeBackend.resumeBuildPipeline(pipeline!.id)
              : await nodeBackend.cancelBuildPipeline(pipeline!.id);
        replacePipeline(next);
      } catch (error) {
        toast.error(`Failed to ${action} build`, { description: describe(error) });
      }
    });

  const restartCurrentStage = (label: string | undefined) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.restartBuildPipelineCurrentStep(pipeline!.id));
        // The restart opens a new session; follow it rather than leaving the
        // user on whichever stage they were reading.
        onFollow();
        toast.success(`${label?.replace(/^Restart /, "") ?? "Stage"} restarted`);
      } catch (error) {
        toast.error("Failed to restart the stage", { description: describe(error) });
      }
    });

  const retryStage = () =>
    run(async () => {
      try {
        const updated = await nodeBackend.retryBuildPipelineStage(pipeline!.id);
        replacePipeline(updated);
        onFollow();
        if (updated.phase === "failed") {
          toast.error("Failed to restart the stage", {
            description: updated.error ?? "The stage failed again before it could restart",
          });
          return;
        }
        toast.success("Failed stage restarted");
      } catch (error) {
        toast.error("Failed to restart the stage", { description: describe(error) });
      }
    });

  const restartStage = (stageId: string) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.restartBuildPipelineStep(pipeline!.id, stageId));
        onFollow();
        toast.success("Stage restarted");
      } catch (error) {
        toast.error("Failed to restart the stage", { description: describe(error) });
      }
    });

  /**
   * "Restart in…": restarts a step on another agent or model. Resolves to the
   * error message, or null once the backend restarted it, so the dialog can
   * stay open with the reason.
   */
  const restartStageIn = async (
    stageId: string,
    selection: BuildPipelineRestartSelection,
  ): Promise<string | null> => {
    let failure: string | null = "Another pipeline control is still running";
    await run(async () => {
      try {
        replacePipeline(
          await nodeBackend.restartBuildPipelineStep(pipeline!.id, stageId, selection),
        );
        failure = null;
        onFollow();
        toast.success("Stage restarted");
      } catch (error) {
        failure = describe(error);
        toast.error("Failed to restart the stage", { description: failure });
      }
    });
    return failure;
  };

  /** Resolves true once the backend reset the code and restarted the step. */
  const rewindCode = async (stageId: string, expectedHead: string): Promise<boolean> => {
    let rewound = false;
    await run(async () => {
      try {
        replacePipeline(
          await nodeBackend.rewindBuildPipelineCode(pipeline!.id, stageId, expectedHead),
        );
        rewound = true;
        onFollow();
        toast.success("Code rewound and step restarted");
      } catch (error) {
        toast.error("Failed to rewind the code", { description: describe(error) });
      }
    });
    return rewound;
  };

  const skipStage = (stageId: string) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.skipBuildPipelineStep(pipeline!.id, stageId));
        onFollow();
        toast.success("Step skipped");
      } catch (error) {
        toast.error("Failed to skip the step", { description: describe(error) });
      }
    });

  const retryReviewer = (reviewerId: string) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.retryBuildPipelineReviewer(pipeline!.id, reviewerId));
        toast.success("Reviewer restarted");
      } catch (error) {
        toast.error("Failed to retry the reviewer", { description: describe(error) });
      }
    });

  const restartReviewer = (reviewerId: string) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.restartBuildPipelineReviewer(pipeline!.id, reviewerId));
        toast.success("Reviewer restarted");
      } catch (error) {
        toast.error("Failed to restart the reviewer", { description: describe(error) });
      }
    });

  const stopReviewer = (reviewerId: string) =>
    run(async () => {
      try {
        replacePipeline(await nodeBackend.stopBuildPipelineReviewer(pipeline!.id, reviewerId));
        toast.success("Reviewer stopped");
      } catch (error) {
        toast.error("Failed to stop the reviewer", { description: describe(error) });
      }
    });

  return {
    pending,
    pause: () => void runControl("pause"),
    resume: () => void runControl("resume"),
    cancel: () => void runControl("cancel"),
    restartCurrentStage: (label: string | undefined) => void restartCurrentStage(label),
    retryStage: () => void retryStage(),
    restartStage: (stageId: string) => void restartStage(stageId),
    restartStageIn,
    rewindCode,
    skipStage: (stageId: string) => void skipStage(stageId),
    retryReviewer: (reviewerId: string) => void retryReviewer(reviewerId),
    restartReviewer: (reviewerId: string) => void restartReviewer(reviewerId),
    stopReviewer: (reviewerId: string) => void stopReviewer(reviewerId),
  };
}

export type PipelineControls = ReturnType<typeof usePipelineControls>;
