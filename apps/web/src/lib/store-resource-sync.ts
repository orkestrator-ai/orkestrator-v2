import { getConfig, getPaneLayout } from "@/lib/backend";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import { adoptPersistedPaneLayout } from "@/lib/pane-layout-persistence";
import {
  preserveClientPaneSelection,
  reconcilePersistedLayout,
} from "@/lib/pane-layout-restore";
import {
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
} from "@/lib/looped-review-persistence";
import {
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
} from "@/lib/build-pipeline-persistence";
import { hydratePromptQueuesForEnvironment } from "@/lib/prompt-queue-persistence";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSessionStore } from "@/stores/sessionStore";

/**
 * Binds the backend change feed to the stores that are read-through caches.
 *
 * Each binding refetches only when this client is actually showing the affected
 * scope — a kanban change for a project nobody has open costs nothing.
 * Pane/tab existence is backend-owned too, while active pane/tab selection is
 * preserved locally whenever an authoritative snapshot is installed.
 *
 * Projects and environments are bound separately, in the hooks that already own
 * their loaders, because those loaders carry request-generation bookkeeping that
 * must not be bypassed.
 */
interface StoreResourceSyncOptions {
  getConfig?: typeof getConfig;
  getPaneLayout?: typeof getPaneLayout;
}

export function startStoreResourceSync(
  options: StoreResourceSyncOptions = {},
): () => void {
  const unsubscribes: Array<() => void> = [];
  const promptQueueSources = createPromptQueueSources();
  let disposed = false;
  let configRequestGeneration = 0;
  let resyncRunning = false;
  let resyncRequested = false;
  const paneLayoutRequestGenerations = new Map<string, number>();
  const deferredPaneLayoutRefreshes = new Set<string>();

  const refreshConfig = async (): Promise<void> => {
    const generation = ++configRequestGeneration;
    try {
      const config = await (options.getConfig ?? getConfig)();
      if (!disposed && generation === configRequestGeneration) {
        useConfigStore.getState().setConfig(config);
      }
    } catch (error) {
      console.warn("[store-resource-sync] Failed to refresh config:", error);
    }
  };

  const refreshBuildPipelinesForProject = async (
    projectId: string,
  ): Promise<void> => {
    const authoritative = await hydrateBuildPipelinesForProject(projectId);
    if (disposed) return;
    const authoritativeIds = new Set(authoritative.map(({ id }) => id));
    const store = useBuildPipelineStore.getState();
    for (const [pipelineId, pipeline] of store.pipelines) {
      if (
        pipeline.projectId === projectId
        && pipeline.backendRevision > 0
        && !authoritativeIds.has(pipelineId)
      ) {
        store.removePipeline(pipelineId);
      }
    }
  };

  const refreshLoopedReviewsForEnvironment = async (
    environmentId: string,
  ): Promise<void> => {
    const authoritative =
      await hydrateLoopedReviewWorkflowsForEnvironment(environmentId);
    if (disposed) return;
    const authoritativeIds = new Set(authoritative.map(({ id }) => id));
    const store = useLoopedReviewStore.getState();
    for (const [workflowId, workflow] of store.workflows) {
      if (
        workflow.environmentId === environmentId
        && workflow.backendRevision > 0
        && !authoritativeIds.has(workflowId)
      ) {
        store.removeWorkflow(workflowId);
      }
    }
  };

  const refreshPaneLayout = async (environmentId: string): Promise<void> => {
    const paneStore = usePaneLayoutStore.getState();
    const hydration = paneStore.hydration.get(environmentId);
    if (hydration === "pending") {
      deferredPaneLayoutRefreshes.add(environmentId);
      return;
    }
    if (hydration !== "done") return;

    const environment = useEnvironmentStore
      .getState()
      .getEnvironmentById(environmentId);
    if (!environment || !paneStore.environments.has(environmentId)) return;

    const generation = (paneLayoutRequestGenerations.get(environmentId) ?? 0) + 1;
    paneLayoutRequestGenerations.set(environmentId, generation);
    const saved = await (options.getPaneLayout ?? getPaneLayout)(environmentId);
    if (
      disposed
      || paneLayoutRequestGenerations.get(environmentId) !== generation
    ) {
      return;
    }

    const latestPaneStore = usePaneLayoutStore.getState();
    const current = latestPaneStore.environments.get(environmentId);
    if (
      latestPaneStore.hydration.get(environmentId) !== "done"
      || !current
    ) {
      return;
    }

    const isLocal = environment.environmentType === "local";
    const restored = reconcilePersistedLayout(saved, {
      environmentId,
      containerId: isLocal ? null : environment.containerId,
      isLocal,
      worktreePath: environment.worktreePath,
      hasBuildPipeline: (pipelineId) =>
        useBuildPipelineStore.getState().pipelines.has(pipelineId),
      hasLoopedReview: (workflowId) =>
        useLoopedReviewStore.getState().workflows.has(workflowId),
    });
    if (!restored) return;

    const selected = preserveClientPaneSelection(restored, current);
    // Prime the persistence mirror before publishing the store update so this
    // read-through snapshot does not become a redundant write-back.
    if (!adoptPersistedPaneLayout(environmentId, selected)) return;
    latestPaneStore.applyAuthoritativeLayout(environmentId, selected);
  };

  unsubscribes.push(usePaneLayoutStore.subscribe((state, previous) => {
    for (const environmentId of [...deferredPaneLayoutRefreshes]) {
      if (
        previous.hydration.get(environmentId) === "pending"
        && state.hydration.get(environmentId) === "done"
      ) {
        deferredPaneLayoutRefreshes.delete(environmentId);
        void refreshPaneLayout(environmentId).catch((error) => {
          console.warn(
            `[store-resource-sync] Failed to refresh pane layout ${environmentId}:`,
            error,
          );
        });
      }
    }
  }));

  const resyncAll = async (): Promise<void> => {
    const environments = useEnvironmentStore.getState().environments;
    const projects = useProjectStore.getState().projects;
    const kanban = useKanbanStore.getState();
    const featurePlan = useFeaturePlanStore.getState();
    const tasks: Array<Promise<unknown>> = [refreshConfig()];

    for (const { id: environmentId } of environments) {
      tasks.push(
        hydratePromptQueuesForEnvironment(environmentId, promptQueueSources),
        useSessionStore.getState().loadSessionsForEnvironment(environmentId),
        refreshLoopedReviewsForEnvironment(environmentId),
        refreshPaneLayout(environmentId),
      );
    }
    for (const { id: projectId } of projects) {
      tasks.push(refreshBuildPipelinesForProject(projectId));
    }
    if (kanban.currentProjectId) {
      tasks.push(kanban.loadTasks(kanban.currentProjectId));
    }
    if (kanban.currentNotesProjectId) {
      tasks.push(kanban.loadNotes(kanban.currentNotesProjectId));
    }
    if (featurePlan.currentProjectId) {
      tasks.push(featurePlan.loadFeatures(featurePlan.currentProjectId));
    }

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          "[store-resource-sync] Authoritative resync read failed:",
          result.reason,
        );
      }
    }
  };

  const requestFullResync = (): void => {
    if (disposed) return;
    resyncRequested = true;
    if (resyncRunning) return;
    resyncRunning = true;
    void (async () => {
      try {
        do {
          resyncRequested = false;
          await resyncAll();
        } while (!disposed && resyncRequested);
      } finally {
        resyncRunning = false;
      }
    })();
  };

  unsubscribes.push(onResourceResync(requestFullResync));

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
    void refreshConfig();
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

  unsubscribes.push(onResourceChanged("pane-layout", ({ id: environmentId }) => {
    if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
    void refreshPaneLayout(environmentId).catch((error) => {
      console.warn(
        `[store-resource-sync] Failed to refresh pane layout ${environmentId}:`,
        error,
      );
    });
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
    disposed = true;
    deferredPaneLayoutRefreshes.clear();
    paneLayoutRequestGenerations.clear();
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
