import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { registerReconciler, type ReconcileFunction } from "./reconciler.js";

/**
 * Restart recovery of `build.launch` and `build.cancel`.
 *
 * A launch whose request was in flight when the backend restarted is settled
 * from the pipeline store: `BuildPipelineService.start` saves the pipeline
 * under the launch's admission key (recorded in the operation's `resolved`
 * fields before anything ran), so a pipeline with that key proves the launch.
 * Nothing is ever started again during recovery; without that proof the
 * operation is `interrupted` and the caller inspects `build list` first.
 */

/** The stage a launch records once the pipeline it started (or reused) is known. */
export const BUILD_LAUNCH_SAVED_STAGE = "build-launch-saved";

function result(pipeline: BuildPipeline): Record<string, unknown> {
  return {
    pipelineId: pipeline.id,
    projectId: pipeline.projectId,
    environmentId: pipeline.environmentId || null,
    taskId: pipeline.taskId,
    phase: pipeline.phase,
  };
}

const reconcileBuild: ReconcileFunction = async (record, context) => {
  if (record.generation === context.generation) return null;
  if (record.result && record.stage === BUILD_LAUNCH_SAVED_STAGE) {
    return { state: "succeeded", stage: "completed", result: record.result };
  }
  const storage = context.command.storage;
  if (record.action === "build.launch") {
    const admissionKey = record.resolved?.admissionKey;
    const projectId = record.resources.projectId;
    const admittedAt = Date.parse(record.createdAt);
    const pipeline =
      typeof admissionKey === "string" && projectId
        ? (await storage.listBuildPipelines(projectId))
            .map((saved) => saved.snapshot)
            .filter(isBuildPipeline)
            .find(
              (candidate) =>
                candidate.admissionKey === admissionKey &&
                // The ticket's active build (which the launch reuses) or one
                // this launch created after its admission.
                ((candidate.phase !== "complete" && candidate.phase !== "failed") ||
                  Date.parse(candidate.createdAt) >= admittedAt),
            )
        : undefined;
    if (pipeline) {
      // The pipeline proves the launch; its supervisor continues provisioning
      // after the restart. That its tab opened is not proven.
      return {
        state: "partial",
        stage: "completed",
        resources: {
          projectId: pipeline.projectId,
          ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
        },
        result: result(pipeline),
        error: {
          code: "partial-failure",
          message:
            "The build pipeline was saved before the backend restarted; inspect it with build get",
        },
      };
    }
  } else {
    const pipelineId = record.scope.startsWith("build:") ? record.scope.slice(6) : undefined;
    const saved = pipelineId ? await storage.getBuildPipeline(pipelineId) : null;
    if (saved && isBuildPipeline(saved.snapshot) && saved.snapshot.phase === "failed") {
      return { state: "succeeded", stage: "completed", result: result(saved.snapshot) };
    }
  }
  return {
    state: "interrupted",
    error: {
      code: "run-interrupted",
      message:
        "The backend restarted during this build action; its effect is not confirmed. Inspect build list before issuing a new request",
    },
  };
};

for (const action of ["build.launch", "build.cancel"] as const) {
  registerReconciler(action, reconcileBuild);
}
