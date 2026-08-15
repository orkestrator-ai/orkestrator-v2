import {
  getConfig,
  getEnvironmentSnapshots,
  getPaneLayout,
  getProjects,
} from "@/lib/backend";
import {
  onResourceChanged,
  onResourceResync,
  type ResourceResyncRequest,
} from "@/lib/resource-sync";
import { listen, type UnlistenFn } from "@/lib/native/events";
import {
  adoptPersistedPaneLayout,
  onPaneLayoutWriteSettled,
} from "@/lib/pane-layout-persistence";
import {
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
} from "@/lib/pane-layout-authoritative";
import {
  hydrateLoopedReviewWorkflowsForEnvironment,
  resolveLoopedReviewWorkflow,
} from "@/lib/looped-review-persistence";
import {
  hydrateMultiReviewWorkflow,
  hydrateMultiReviewWorkflowsForEnvironment,
} from "@/lib/multi-review-persistence";
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
import {
  applyProjectSnapshot,
  getProjectMutationVersion,
  useProjectStore,
} from "@/stores/projectStore";
import { useSessionStore } from "@/stores/sessionStore";
import type { ResourceManifestKind } from "@orkestrator/protocol/resource-events";

/**
 * Binds the backend change feed to the stores that are read-through caches.
 *
 * Each binding refetches only when this client is actually showing the affected
 * scope — a kanban change for a project nobody has open costs nothing.
 * Pane/tab existence is backend-owned too, while active pane/tab selection is
 * preserved locally whenever an authoritative snapshot is installed.
 *
 * Live project/environment changes are also consumed by their UI hooks for
 * low-latency updates. Manifest/full reconciliation owns those collections
 * here as well so convergence never depends on the sidebar being mounted.
 */
interface StoreResourceSyncOptions {
  getConfig?: typeof getConfig;
  getProjects?: typeof getProjects;
  getEnvironmentSnapshots?: typeof getEnvironmentSnapshots;
  getPaneLayout?: typeof getPaneLayout;
  adoptPaneLayout?: typeof adoptPersistedPaneLayout;
  onPaneLayoutWriteSettled?: typeof onPaneLayoutWriteSettled;
  listen?: typeof listen;
}

/** Only the identity is needed here; the environment body is read authoritatively. */
interface EnvironmentSetupCompletePayload {
  environment_id: string;
}

interface DeferredPaneLayoutRefresh {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function startStoreResourceSync(
  options: StoreResourceSyncOptions = {},
): () => void {
  const unsubscribes: Array<() => void> = [];
  const promptQueueSources = createPromptQueueSources();
  let disposed = false;
  let configRequestGeneration = 0;
  let pendingResyncResources: Set<ResourceManifestKind> | null | undefined;
  let resyncPromise: Promise<void> | null = null;
  const paneLayoutRequestGenerations = new Map<string, number>();
  const deferredPaneLayoutRefreshes = new Map<
    string,
    DeferredPaneLayoutRefresh
  >();
  const declinedPaneLayoutRefreshes = new Set<string>();

  const refreshConfig = async (): Promise<void> => {
    const generation = ++configRequestGeneration;
    try {
      const config = await (options.getConfig ?? getConfig)();
      if (!disposed && generation === configRequestGeneration) {
        useConfigStore.getState().setConfig(config);
      }
    } catch (error) {
      console.warn("[store-resource-sync] Failed to refresh config:", error);
      throw error;
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
      const existing = deferredPaneLayoutRefreshes.get(environmentId);
      if (existing) return existing.promise;

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      deferredPaneLayoutRefreshes.set(environmentId, {
        promise,
        resolve,
        reject,
      });
      return promise;
    }
    if (hydration !== "done") return;

    const environment = useEnvironmentStore
      .getState()
      .getEnvironmentById(environmentId);
    if (!environment) return;
    const requestedContainerId = environment.environmentType === "local"
      ? null
      : environment.containerId;
    const requestedEnvironmentType = environment.environmentType;
    const requestedWorktreePath = environment.worktreePath;

    const generation = (paneLayoutRequestGenerations.get(environmentId) ?? 0) + 1;
    paneLayoutRequestGenerations.set(environmentId, generation);
    const saved = await (options.getPaneLayout ?? getPaneLayout)(environmentId);
    if (
      disposed
      || paneLayoutRequestGenerations.get(environmentId) !== generation
    ) {
      return;
    }

    if (saved) {
      await hydratePaneLayoutDependencies(saved.root);
      if (
        disposed
        || paneLayoutRequestGenerations.get(environmentId) !== generation
      ) {
        return;
      }
    }

    const latestPaneStore = usePaneLayoutStore.getState();
    const current = latestPaneStore.environments.get(environmentId);
    const latestEnvironment = useEnvironmentStore
      .getState()
      .getEnvironmentById(environmentId);
    if (
      latestPaneStore.hydration.get(environmentId) !== "done"
      || !latestEnvironment
    ) {
      return;
    }
    const latestContainerId = latestEnvironment.environmentType === "local"
      ? null
      : latestEnvironment.containerId;
    if (
      latestEnvironment.environmentType !== requestedEnvironmentType
      || latestContainerId !== requestedContainerId
      || latestEnvironment.worktreePath !== requestedWorktreePath
      || (current != null && current.containerId !== latestContainerId)
    ) {
      return;
    }

    if (!saved) return;
    const selected = reconcileAuthoritativePaneLayout(
      environmentId,
      saved,
      current ?? {
        root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        activePaneId: "default",
        containerId: latestContainerId,
      },
    );
    if (!selected) return;

    // Prime the persistence mirror before publishing the store update so this
    // read-through snapshot does not become a redundant write-back.
    if (!(options.adoptPaneLayout ?? adoptPersistedPaneLayout)(
      environmentId,
      selected,
    )) {
      // The layout we just fetched is dropped in favour of a local write that
      // has not landed yet. That write announces its own revision on success —
      // but if it fails, nothing else would ever come back for this snapshot.
      declinedPaneLayoutRefreshes.add(environmentId);
      return;
    }
    declinedPaneLayoutRefreshes.delete(environmentId);
    latestPaneStore.applyAuthoritativeLayout(environmentId, selected);
  };

  const requestPaneLayoutRefresh = (environmentId: string): void => {
    void refreshPaneLayout(environmentId).catch((error) => {
      console.warn(
        `[store-resource-sync] Failed to refresh pane layout ${environmentId}:`,
        error,
      );
    });
  };

  unsubscribes.push((options.onPaneLayoutWriteSettled ?? onPaneLayoutWriteSettled)(
    (environmentId) => {
      if (disposed || !declinedPaneLayoutRefreshes.has(environmentId)) return;
      declinedPaneLayoutRefreshes.delete(environmentId);
      requestPaneLayoutRefresh(environmentId);
    },
  ));

  // Setup completion is the one moment the backend deliberately moves the
  // authoritative selection off the setup terminal and onto the build surface
  // (build-pipeline-service `waiting-for-setup` -> `ensureBuildPipelineTab`).
  // That handoff is published as an ordinary `pane-layout` announcement, so a
  // client that was mid-write, mid-hydration or briefly disconnected can miss
  // the single frame that carries it and sit on the setup tab while the agent
  // works out of sight. Re-read the authoritative layout on the completion
  // event itself so the handoff never depends on one frame surviving.
  {
    let unlisten: UnlistenFn | null = null;
    void (options.listen ?? listen)<EnvironmentSetupCompletePayload>(
      "environment-setup-complete",
      ({ payload }) => {
        if (disposed) return;
        requestPaneLayoutRefresh(payload.environment_id);
      },
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => {
      console.warn(
        "[store-resource-sync] Failed to observe setup completion:",
        error,
      );
    });
    unsubscribes.push(() => unlisten?.());
  }

  unsubscribes.push(usePaneLayoutStore.subscribe((state, previous) => {
    for (const [environmentId, deferred] of [...deferredPaneLayoutRefreshes]) {
      if (
        previous.hydration.get(environmentId) === "pending"
        && state.hydration.get(environmentId) === "done"
      ) {
        void refreshPaneLayout(environmentId).then(
          () => deferred.resolve(),
          (error) => deferred.reject(error),
        ).finally(() => {
          if (deferredPaneLayoutRefreshes.get(environmentId) === deferred) {
            deferredPaneLayoutRefreshes.delete(environmentId);
          }
        });
      }
    }
    // An environment that left the pane store will never settle a write or
    // finish hydrating, so its queued replays would be retained forever.
    for (const [environmentId, deferred] of [...deferredPaneLayoutRefreshes]) {
      if (!state.hydration.has(environmentId)) {
        deferredPaneLayoutRefreshes.delete(environmentId);
        deferred.resolve();
      }
    }
    for (const environmentId of [...declinedPaneLayoutRefreshes]) {
      if (!state.environments.has(environmentId)) {
        declinedPaneLayoutRefreshes.delete(environmentId);
        paneLayoutRequestGenerations.delete(environmentId);
      }
    }
  }));

  const queueSelectiveResync = (resource: ResourceManifestKind): void => {
    // A full request already subsumes this retry. Otherwise keep it in the
    // same serialized resync loop so the manifest handler does not resolve —
    // and acknowledge its revision — until a non-stale snapshot is applied.
    if (pendingResyncResources === null) return;
    pendingResyncResources ??= new Set();
    pendingResyncResources.add(resource);
  };

  const resyncAll = async (
    resources: ReadonlySet<ResourceManifestKind> | null,
  ): Promise<void> => {
    const includes = (
      resource: ResourceManifestKind,
    ): boolean => resources === null || resources.has(resource);
    const tasks: Array<Promise<unknown>> = [];
    const paneEnvironmentIds: string[] = [];
    let failed = false;

    if (includes("project")) {
      const projectStoreAtRequest = useProjectStore.getState();
      const projectsAtRequest = projectStoreAtRequest.projects;
      const mutationVersion = getProjectMutationVersion();
      try {
        const projects = await (options.getProjects ?? getProjects)();
        // A live refresh, local mutation, or newer manifest read may have
        // installed a newer collection while this request was in flight. Both
        // guards are needed: the mutation version covers optimistic writes,
        // while array identity orders concurrent authoritative reads.
        const accepted = (
          !disposed
          && useProjectStore.getState().projects === projectsAtRequest
          && applyProjectSnapshot(projects, mutationVersion)
        );
        if (!disposed && !accepted) {
          queueSelectiveResync("project");
        }
      } catch (error) {
        failed = true;
        console.warn("[store-resource-sync] Authoritative project resync failed:", error);
      }
    }
    if (includes("environment")) {
      const environmentsAtRequest = useEnvironmentStore.getState().environments;
      try {
        // This phase runs after the project phase, so it sees projects added or
        // removed while the renderer was inactive. Install all project scopes
        // atomically: one failed read must not leave a half-new environment set.
        const projectIds = useProjectStore.getState().projects.map(({ id }) => id);
        const snapshots = await Promise.all(projectIds.map((projectId) =>
          (options.getEnvironmentSnapshots ?? getEnvironmentSnapshots)(projectId)
        ));
        const accepted = (
          !disposed
          && useEnvironmentStore.getState().environments === environmentsAtRequest
        );
        if (accepted) {
          useEnvironmentStore.getState().setEnvironments(snapshots.flat());
        } else if (!disposed) {
          queueSelectiveResync("environment");
        }
      } catch (error) {
        failed = true;
        console.warn("[store-resource-sync] Authoritative environment resync failed:", error);
      }
    }

    const environments = useEnvironmentStore.getState().environments;
    const projects = useProjectStore.getState().projects;
    const kanban = useKanbanStore.getState();
    const featurePlan = useFeaturePlanStore.getState();
    if (includes("config")) tasks.push(refreshConfig());

    for (const { id: environmentId } of environments) {
      if (includes("prompt-queue")) {
        tasks.push(hydratePromptQueuesForEnvironment(environmentId, promptQueueSources));
      }
      if (includes("session")) {
        tasks.push(useSessionStore.getState().loadSessionsForEnvironment(environmentId));
      }
      if (includes("looped-review")) {
        tasks.push(refreshLoopedReviewsForEnvironment(environmentId));
      }
      if (includes("multi-review")) {
        tasks.push(hydrateMultiReviewWorkflowsForEnvironment(environmentId));
      }
      if (includes("pane-layout")) paneEnvironmentIds.push(environmentId);
    }
    if (includes("build-pipeline")) {
      for (const { id: projectId } of projects) {
        tasks.push(refreshBuildPipelinesForProject(projectId));
      }
    }
    if (includes("kanban") && kanban.currentProjectId) {
      tasks.push(kanban.loadTasks(kanban.currentProjectId));
    }
    if (includes("project-notes") && kanban.currentNotesProjectId) {
      tasks.push(kanban.loadNotes(kanban.currentNotesProjectId));
    }
    if (includes("feature-plan") && featurePlan.currentProjectId) {
      tasks.push(featurePlan.loadFeatures(featurePlan.currentProjectId));
    }

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        failed = true;
        console.warn(
          "[store-resource-sync] Authoritative resync read failed:",
          result.reason,
        );
      }
    }
    const paneResults = await Promise.allSettled(
      paneEnvironmentIds.map(refreshPaneLayout),
    );
    for (const result of paneResults) {
      if (result.status === "rejected") {
        failed = true;
        console.warn(
          "[store-resource-sync] Authoritative pane resync failed:",
          result.reason,
        );
      }
    }
    if (failed) throw new Error("One or more authoritative resync reads failed");
  };

  const requestStoreResync = (
    request: ResourceResyncRequest,
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (request.resources === null) {
      pendingResyncResources = null;
    } else if (pendingResyncResources !== null) {
      pendingResyncResources ??= new Set();
      for (const resource of request.resources) {
        pendingResyncResources.add(resource);
      }
    }
    if (resyncPromise) return resyncPromise;
    resyncPromise = (async () => {
      try {
        while (!disposed && pendingResyncResources !== undefined) {
          const resources = pendingResyncResources;
          pendingResyncResources = undefined;
          await resyncAll(resources);
        }
      } finally {
        resyncPromise = null;
      }
    })();
    return resyncPromise;
  };

  unsubscribes.push(onResourceResync(requestStoreResync));

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
    void refreshConfig().catch(() => undefined);
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
    void resolveLoopedReviewWorkflow(workflowId)
      .then((result) => {
        // Only an authoritative "no such record" removes the projection. A
        // snapshot this bundle cannot read still exists and is very likely
        // still being advanced, so dropping it would delete the user's tab
        // over a version skew.
        if (result.status === "missing") {
          useLoopedReviewStore.getState().removeWorkflow(workflowId);
          return;
        }
        if (result.status === "unreadable") {
          console.warn(
            `[store-resource-sync] Keeping looped review ${workflowId}: its snapshot could not be read`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[store-resource-sync] Failed to refresh looped review ${workflowId}:`,
          error,
        );
      });
  }));

  unsubscribes.push(onResourceChanged("multi-review", ({ id: workflowId }) => {
    void hydrateMultiReviewWorkflow(workflowId).catch((error) => {
      console.warn(
        `[store-resource-sync] Failed to refresh multi review ${workflowId}:`,
        error,
      );
    });
  }));

  return () => {
    disposed = true;
    for (const deferred of deferredPaneLayoutRefreshes.values()) {
      deferred.resolve();
    }
    deferredPaneLayoutRefreshes.clear();
    declinedPaneLayoutRefreshes.clear();
    paneLayoutRequestGenerations.clear();
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
