/**
 * A feature-plan build against a backend older than `start_feature_plan_build`.
 *
 * Such a backend has only the individual steps, so this renderer sequences them
 * as it did before the backend took that over: create the ticket, claim the
 * plan, start the pipeline, record the link, and roll back on failure. Frozen
 * compatibility code; new behaviour goes in the backend's `feature-plan-build.ts`.
 * Listed in `docs/architecture/version-compatibility.md`; delete it when its row
 * retires.
 */
import type { FeaturePlan } from "@/lib/backend";
import { formatFeatureStoriesForBuild } from "@/lib/feature-planner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useKanbanStore, type KanbanTask } from "@/stores/kanbanStore";
import type { EnvironmentType } from "@/types";

export const FEATURE_BUILD_ALREADY_ACTIVE = "This feature already has an active build";

export interface LegacyFeaturePlanBuildDeps {
  projectId: string;
  environmentType: EnvironmentType;
  addTask: (projectId: string, title: string, description: string) => Promise<string | undefined>;
  deleteTask: (taskId: string) => Promise<unknown>;
  claimFeatureBuild: (
    featureId: string,
    taskId: string,
  ) => Promise<{ claimed: boolean; feature: FeaturePlan } | undefined>;
  updateFeature: (
    featureId: string,
    updates: Partial<FeaturePlan>,
  ) => Promise<FeaturePlan | undefined>;
  startBuild: (
    task: KanbanTask,
    environmentType: EnvironmentType,
    agent: "codex",
    options: { existingEnvironmentId?: string; featurePlanId: string },
  ) => Promise<unknown>;
}

/** Runs the sequence; throws what a caller shows. An already-built plan throws the shared message. */
export async function legacyStartFeaturePlanBuild(
  feature: FeaturePlan,
  deps: LegacyFeaturePlanBuildDeps,
): Promise<void> {
  const { addTask, claimFeatureBuild, deleteTask, startBuild, updateFeature } = deps;
  let ownsBuildReservation = false;
  let unreservedTaskId: string | null = null;
  try {
    const taskDetails = formatFeatureStoriesForBuild(feature);
    const taskId = await addTask(deps.projectId, taskDetails.title, taskDetails.description);
    if (!taskId) throw new Error("Failed to create Kanban task for feature build");
    unreservedTaskId = taskId;

    const task = useKanbanStore.getState().tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Created build task was not found in the Kanban store");

    // Persist the feature→task half of the launch before navigation can
    // unmount the view. A restarted client now sees an in-progress feature
    // instead of offering a duplicate build while the pipeline is being created.
    const reservation = await claimFeatureBuild(feature.id, taskId);
    if (!reservation) {
      await deleteTask(taskId);
      unreservedTaskId = null;
      throw new Error("Failed to reserve the feature build");
    }
    if (!reservation.claimed) {
      await deleteTask(taskId);
      unreservedTaskId = null;
      throw new Error(FEATURE_BUILD_ALREADY_ACTIVE);
    }
    ownsBuildReservation = true;
    unreservedTaskId = null;

    await startBuild(task, deps.environmentType, "codex", {
      existingEnvironmentId: feature.codexEnvironmentId,
      featurePlanId: feature.id,
    });
    const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(taskId);
    if (!pipeline || pipeline.phase === "failed") {
      // startBuild surfaces its own error toast and clears or fails the
      // pipeline when it cannot start. Undo the durable reservation so the
      // feature does not remain stuck in "building" with no live pipeline.
      await updateFeature(feature.id, {
        status: feature.status,
        buildTaskId: feature.buildTaskId,
        buildPipelineId: feature.buildPipelineId,
      }).catch(() => undefined);
      ownsBuildReservation = false;
      return;
    }
    const updated = await updateFeature(feature.id, {
      status: "building",
      buildTaskId: taskId,
      buildPipelineId: pipeline.id,
      ...(pipeline.environmentId ? { codexEnvironmentId: pipeline.environmentId } : {}),
    });
    if (!updated) throw new Error("Failed to persist the feature build state");
  } catch (error) {
    if (unreservedTaskId) await deleteTask(unreservedTaskId);
    if (ownsBuildReservation) {
      await updateFeature(feature.id, {
        status: feature.status,
        buildTaskId: feature.buildTaskId,
        buildPipelineId: feature.buildPipelineId,
      }).catch(() => undefined);
    }
    throw error;
  }
}
