import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { hydrateLoopedReviewWorkflow } from "@/lib/looped-review-persistence";
import {
  preserveClientPaneSelection,
  preserveRendererLocalPaneFields,
  reconcilePersistedLayout,
} from "@/lib/pane-layout-restore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import {
  LEGACY_PANE_LAYOUT_VERSION,
  type PersistedPaneLayout,
} from "@/types/paneLayout";

/**
 * The one way a backend-owned pane snapshot becomes renderer state.
 *
 * Both writers of authoritative layouts — the change-feed refresh and the
 * install that follows a rebased save — go through here. `reconcilePersistedLayout`
 * is what drops a tab whose build pipeline or looped review this client cannot
 * back, so a path that skips it can graft another client's tab into the tree
 * with nothing behind it.
 */

/**
 * Depth bound is one more than `MAX_SPLIT_DEPTH`, so it never truncates a tree
 * the restore path would accept; it only stops a hostile or corrupt record from
 * driving unbounded recursion.
 */
const MAX_DEPENDENCY_SCAN_DEPTH = 10;

export function collectPaneDependencyIds(root: unknown): {
  pipelineIds: Set<string>;
  workflowIds: Set<string>;
} {
  const pipelineIds = new Set<string>();
  const workflowIds = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPENDENCY_SCAN_DEPTH
      || !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "leaf" && Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
        const candidate = tab as Record<string, unknown>;
        const build = candidate.buildTabData;
        if (build && typeof build === "object" && !Array.isArray(build)) {
          const pipelineId = (build as Record<string, unknown>).pipelineId;
          if (typeof pipelineId === "string" && pipelineId.trim()) {
            pipelineIds.add(pipelineId);
          }
        }
        const review = candidate.loopedReviewTabData;
        if (review && typeof review === "object" && !Array.isArray(review)) {
          const workflowId = (review as Record<string, unknown>).workflowId;
          if (typeof workflowId === "string" && workflowId.trim()) {
            workflowIds.add(workflowId);
          }
        }
      }
      return;
    }
    if (record.kind === "split" && Array.isArray(record.children)) {
      record.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(root, 0);
  return { pipelineIds, workflowIds };
}

/**
 * Loads any build pipeline or looped review a snapshot references but this
 * client has never seen, so `reconcilePersistedLayout` does not drop the tab
 * that carries it. Already-present records are not refetched.
 */
export async function hydratePaneLayoutDependencies(
  root: unknown,
): Promise<void> {
  const { pipelineIds, workflowIds } = collectPaneDependencyIds(root);
  const missingPipelineIds = [...pipelineIds].filter(
    (pipelineId) => !useBuildPipelineStore.getState().pipelines.has(pipelineId),
  );
  const missingWorkflowIds = [...workflowIds].filter(
    (workflowId) => !useLoopedReviewStore.getState().workflows.has(workflowId),
  );
  if (missingPipelineIds.length === 0 && missingWorkflowIds.length === 0) return;
  await Promise.all([
    ...missingPipelineIds.map((pipelineId) =>
      hydrateBuildPipeline(pipelineId).then(() => undefined)
    ),
    ...missingWorkflowIds.map((workflowId) =>
      hydrateLoopedReviewWorkflow(workflowId).then(() => undefined)
    ),
  ]);
}

/**
 * Validates a backend snapshot against this client's environment and stores,
 * then preserves only renderer-local connection fields. Pane and tab selection
 * come from the backend snapshot so reconnecting clients share the last focus.
 *
 * Returns null when the snapshot cannot be trusted for this client: the
 * environment is gone, its container generation moved on, or the record itself
 * failed reconciliation.
 */
export function reconcileAuthoritativePaneLayout(
  environmentId: string,
  saved: PersistedPaneLayout,
  current: EnvironmentPaneState,
): EnvironmentPaneState | null {
  const environment = useEnvironmentStore
    .getState()
    .getEnvironmentById(environmentId);
  if (!environment) return null;

  const isLocal = environment.environmentType === "local";
  const containerId = isLocal ? null : environment.containerId;
  if (current.containerId !== containerId) return null;

  const restored = reconcilePersistedLayout(saved, {
    environmentId,
    containerId,
    isLocal,
    worktreePath: environment.worktreePath,
    hasBuildPipeline: (pipelineId) =>
      useBuildPipelineStore.getState().pipelines.has(pipelineId),
    hasLoopedReview: (workflowId) =>
      useLoopedReviewStore.getState().workflows.has(workflowId),
  });
  if (!restored) return null;

  // V1 stored canonical first-pane/first-tab placeholders, not real focus.
  // Until its migration write succeeds, keep this renderer's selection while
  // still adopting structural changes and renderer-local connection fields.
  return saved.version === LEGACY_PANE_LAYOUT_VERSION
    ? preserveClientPaneSelection(restored, current)
    : preserveRendererLocalPaneFields(restored, current);
}
