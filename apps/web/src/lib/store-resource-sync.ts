import { getConfig } from "@/lib/backend";
import { onResourceChanged } from "@/lib/resource-sync";
import { hydrateLoopedReviewWorkflow } from "@/lib/looped-review-persistence";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { hydratePromptQueuesForEnvironment } from "@/lib/prompt-queue-persistence";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useSessionStore } from "@/stores/sessionStore";

/**
 * Binds the backend change feed to the stores that are read-through caches.
 *
 * Each binding refetches only when this client is actually showing the affected
 * scope — a kanban change for a project nobody has open costs nothing. Stores
 * that own no backend state (layout, selection, zoom) are absent by design.
 *
 * Projects and environments are bound separately, in the hooks that already own
 * their loaders, because those loaders carry request-generation bookkeeping that
 * must not be bypassed.
 */
export function startStoreResourceSync(): () => void {
  const unsubscribes: Array<() => void> = [];
  const promptQueueSources = createPromptQueueSources();

  unsubscribes.push(onResourceChanged("prompt-queue", ({ id: environmentId }) => {
    // Queues announce against their environment rather than their tab, so this
    // refetches every queue the environment owns. That is deliberate: a client
    // that has never opened a tab still needs its queue if it opens one next.
    if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
    void hydratePromptQueuesForEnvironment(environmentId, promptQueueSources)
      .catch((error) => {
        console.warn(
          `[store-resource-sync] Failed to refresh prompt queues for ${environmentId}:`,
          error,
        );
      });
  }));

  unsubscribes.push(onResourceChanged("config", () => {
    void getConfig()
      .then((config) => useConfigStore.getState().setConfig(config))
      .catch((error) => {
        console.warn("[store-resource-sync] Failed to refresh config:", error);
      });
  }));

  unsubscribes.push(onResourceChanged("kanban", ({ id: projectId }) => {
    // Reloading a project the user has since navigated away from would race the
    // store's own currentProjectId guard and show the wrong board.
    if (useKanbanStore.getState().currentProjectId !== projectId) return;
    void useKanbanStore.getState().loadTasks(projectId);
  }));

  unsubscribes.push(onResourceChanged("project-notes", ({ id: projectId }) => {
    if (useKanbanStore.getState().currentNotesProjectId !== projectId) return;
    void useKanbanStore.getState().loadNotes(projectId);
  }));

  unsubscribes.push(onResourceChanged("feature-plan", ({ id: projectId }) => {
    if (useFeaturePlanStore.getState().currentProjectId !== projectId) return;
    void useFeaturePlanStore.getState().loadFeatures(projectId);
  }));

  unsubscribes.push(onResourceChanged("session", ({ id: environmentId }) => {
    // Sessions are only meaningful for environments this client has loaded.
    if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
    void useSessionStore.getState().loadSessionsForEnvironment(environmentId);
  }));

  unsubscribes.push(onResourceChanged("build-pipeline", ({ id: pipelineId }) => {
    // A missing record means another client finished or deleted this build.
    // Dropping it locally is what stops a stale tab from resuming a dead
    // pipeline, so treat "not found" as authoritative rather than as an error.
    void hydrateBuildPipeline(pipelineId)
      .then((pipeline) => {
        if (pipeline) return;
        const local = useBuildPipelineStore.getState().pipelines.get(pipelineId);
        if (local?.backendRevision) {
          useBuildPipelineStore.getState().removePipeline(pipelineId);
        }
      })
      .catch((error) => {
        console.warn(
          `[store-resource-sync] Failed to refresh build pipeline ${pipelineId}:`,
          error,
        );
      });
  }));

  unsubscribes.push(onResourceChanged("looped-review", ({ id: workflowId }) => {
    // hydrate compares backend revisions against the local snapshot, so a
    // workflow this client is actively driving is not clobbered by its own echo.
    void hydrateLoopedReviewWorkflow(workflowId).catch((error) => {
      console.warn(
        `[store-resource-sync] Failed to refresh looped review ${workflowId}:`,
        error,
      );
    });
  }));

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
