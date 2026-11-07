/**
 * The change and resync handlers of a node's build pipelines, Multi Reviews,
 * Kanban board and feature plans (plan item 3011), registered on that node's
 * store bindings (`store-resource-sync.ts`, plan item 3014).
 *
 * Every store they write is per node scope, so these registrations run on
 * every scope: each reads its own node and writes that node's stores.
 *
 * Kept out of `store-resource-sync.ts` so the store bindings stay a list of
 * registrations. It imports the framework's types only, so
 * `store-resource-sync.ts` can import it back without a cycle.
 */
import type { ResourceManifestKind } from "@orkestrator/protocol/resource-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  buildPipelineChangeReadOptions,
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
} from "@/lib/build-pipeline-persistence";
import {
  hydrateMultiReviewWorkflow,
  hydrateMultiReviewWorkflowsForEnvironment,
} from "@/lib/multi-review-persistence";
import type { StoreResourceHandlers, StoreResourceSyncContext } from "@/lib/store-resource-sync";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { environmentStore } from "@/stores/environmentStore";
import { featurePlanStore } from "@/stores/featurePlanStore";
import { kanbanStore } from "@/stores/kanbanStore";
import { projectStore } from "@/stores/projectStore";

const log = createLogger("web.resource-sync");

/**
 * Most workflow ids a hidden window remembers to re-read. Past it the window
 * forgets the ids and reconciles both collections once it is shown again.
 */
export const MAX_DEFERRED_WORKFLOW_READS = 512;

/** Delay between attempts to hydrate acknowledged hidden-window changes. */
export const DEFERRED_WORKFLOW_RETRY_MS = 1_000;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Build pipelines and Multi Reviews, which share the hidden-window deferral:
 * a hidden window remembers the ids that changed and reads them once shown.
 * Each scope keeps its own deferred ids and retry timer.
 */
function registerWorkflows(context: StoreResourceSyncContext): void {
  const { scope } = context;
  const pipelines = scope.store(buildPipelineStore);
  const deferredPipelineReads = new Set<string>();
  const deferredMultiReviewReads = new Set<string>();
  let deferredWorkflowReadsOverflowed = false;
  let deferredWorkflowGeneration = 0;
  let workflowFlushRunning = false;
  let workflowRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Remembers a change a hidden window will read when shown; true when deferred. */
  const deferWhileHidden = (reads: Set<string>, id: string): boolean => {
    if (!documentHidden()) return false;
    deferredWorkflowGeneration += 1;
    if (deferredWorkflowReadsOverflowed) return true;
    reads.add(id);
    if (deferredPipelineReads.size + deferredMultiReviewReads.size > MAX_DEFERRED_WORKFLOW_READS) {
      deferredPipelineReads.clear();
      deferredMultiReviewReads.clear();
      deferredWorkflowReadsOverflowed = true;
    }
    return true;
  };

  const refreshBuildPipelinesForProject = async (projectId: string): Promise<void> => {
    const authoritative = await hydrateBuildPipelinesForProject(projectId, undefined, scope);
    if (context.disposed()) return;
    const authoritativeIds = new Set(authoritative.map(({ id }) => id));
    const store = pipelines.getState();
    for (const [pipelineId, pipeline] of store.pipelines) {
      if (
        pipeline.projectId === projectId &&
        pipeline.backendRevision > 0 &&
        !authoritativeIds.has(pipelineId)
      ) {
        store.removePipeline(pipelineId);
      }
    }
  };

  context.onResync("dependents", (pass) => {
    const work: Promise<unknown>[] = [];
    if (pass.includes("multi-review")) {
      for (const { id } of scope.store(environmentStore).getState().environments) {
        work.push(hydrateMultiReviewWorkflowsForEnvironment(id, scope));
      }
    }
    if (pass.includes("build-pipeline")) {
      for (const { id } of scope.store(projectStore).getState().projects) {
        work.push(refreshBuildPipelinesForProject(id));
      }
    }
    return work;
  });

  const refreshPipeline = (pipelineId: string): Promise<void> =>
    // A missing record means another client finished or deleted this build.
    // Dropping it locally is what stops a stale tab from resuming a dead
    // pipeline, so treat "not found" as authoritative rather than as an error.
    // Bodies only while a transcript of this pipeline is on screen.
    hydrateBuildPipeline(
      pipelineId,
      undefined,
      buildPipelineChangeReadOptions(pipelineId, scope),
      scope,
    )
      .then((pipeline) => {
        if (pipeline || context.disposed()) return;
        const local = pipelines.getState().pipelines.get(pipelineId);
        if (local?.backendRevision) {
          pipelines.getState().removePipeline(pipelineId);
        }
      })
      .catch((error) => {
        log.warn("build-pipeline.refresh-failed", { pipelineId, error: formatLogError(error) });
        throw error;
      });

  const refreshMultiReview = (workflowId: string): Promise<void> =>
    hydrateMultiReviewWorkflow(workflowId, scope)
      .then(() => undefined)
      .catch((error) => {
        log.warn("multi-review.refresh-failed", { workflowId, error: formatLogError(error) });
        throw error;
      });

  context.onResourceChanged("build-pipeline", ({ id: pipelineId }) => {
    if (deferWhileHidden(deferredPipelineReads, pipelineId)) return;
    return refreshPipeline(pipelineId);
  });

  context.onResourceChanged("multi-review", ({ id: workflowId }) => {
    if (deferWhileHidden(deferredMultiReviewReads, workflowId)) return;
    return refreshMultiReview(workflowId);
  });

  const flushDeferredWorkflowReads = (): void => {
    if (context.disposed() || documentHidden() || workflowFlushRunning) return;
    if (workflowRetryTimer) clearTimeout(workflowRetryTimer);
    workflowRetryTimer = null;
    const generation = deferredWorkflowGeneration;
    workflowFlushRunning = true;
    const flush = async (): Promise<void> => {
      if (deferredWorkflowReadsOverflowed) {
        await context.requestResync({
          resources: new Set<ResourceManifestKind>(["build-pipeline", "multi-review"]),
          reason: "explicit",
        });
        if (generation === deferredWorkflowGeneration) deferredWorkflowReadsOverflowed = false;
        return;
      }
      const refresh = async (ids: Set<string>, read: (id: string) => Promise<void>) => {
        await Promise.allSettled(
          Array.from(ids, async (id) => {
            await read(id);
            // A hidden-window change arriving during the read still needs replay.
            if (generation === deferredWorkflowGeneration) ids.delete(id);
          }),
        );
      };
      await Promise.all([
        refresh(deferredPipelineReads, refreshPipeline),
        refresh(deferredMultiReviewReads, refreshMultiReview),
      ]);
    };
    void flush()
      .catch(() => undefined)
      .finally(() => {
        workflowFlushRunning = false;
        if (
          !context.disposed() &&
          !documentHidden() &&
          (deferredWorkflowReadsOverflowed ||
            deferredPipelineReads.size ||
            deferredMultiReviewReads.size)
        ) {
          // Manifest delivery already acknowledged these changes. Retry independently
          // with one bounded timer, even when every subsequent manifest is unchanged.
          workflowRetryTimer = setTimeout(() => {
            workflowRetryTimer = null;
            flushDeferredWorkflowReads();
          }, DEFERRED_WORKFLOW_RETRY_MS);
        }
      });
  };
  // The document's own visibility, as before the split; the read policy's
  // host-hidden override (plan item 0003) is not consulted here yet.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", flushDeferredWorkflowReads);
    context.onStop(() =>
      document.removeEventListener("visibilitychange", flushDeferredWorkflowReads),
    );
  }

  context.onStop(() => {
    if (workflowRetryTimer) clearTimeout(workflowRetryTimer);
    workflowRetryTimer = null;
    deferredPipelineReads.clear();
    deferredMultiReviewReads.clear();
  });
}

function registerKanban(context: StoreResourceSyncContext): void {
  const kanban = context.scope.store(kanbanStore);
  context.onResync("dependents", (pass) => {
    const board = kanban.getState();
    const work: Promise<unknown>[] = [];
    if (pass.includes("kanban") && board.currentProjectId) {
      work.push(board.loadTasks(board.currentProjectId));
    }
    if (pass.includes("project-notes") && board.currentNotesProjectId) {
      work.push(board.loadNotes(board.currentNotesProjectId));
    }
    return work;
  });

  context.onResourceChanged("kanban", ({ id: projectId }) => {
    // Reloading a project the user has since navigated away from would race the
    // store's own currentProjectId guard and show the wrong board.
    if (kanban.getState().currentProjectId !== projectId) return;
    return kanban.getState().loadTasks(projectId);
  });

  context.onResourceChanged("project-notes", ({ id: projectId }) => {
    if (kanban.getState().currentNotesProjectId !== projectId) return;
    return kanban.getState().loadNotes(projectId);
  });
}

function registerFeaturePlans(context: StoreResourceSyncContext): void {
  const featurePlans = context.scope.store(featurePlanStore);
  context.onResync("dependents", (pass) => {
    const featurePlan = featurePlans.getState();
    return pass.includes("feature-plan") && featurePlan.currentProjectId
      ? featurePlan.loadFeatures(featurePlan.currentProjectId)
      : undefined;
  });
  context.onResourceChanged("feature-plan", ({ id: projectId }) => {
    if (featurePlans.getState().currentProjectId !== projectId) return;
    return featurePlans.getState().loadFeatures(projectId);
  });
}

export const workflowResourceHandlers: StoreResourceHandlers = Object.freeze({
  name: "workflows",
  runsOn: "every-scope",
  register: registerWorkflows,
});

export const kanbanResourceHandlers: StoreResourceHandlers = Object.freeze({
  name: "kanban",
  runsOn: "every-scope",
  register: registerKanban,
});

export const featurePlanResourceHandlers: StoreResourceHandlers = Object.freeze({
  name: "feature-plan",
  runsOn: "every-scope",
  register: registerFeaturePlans,
});
