import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { hydrateLoopedReviewWorkflow } from "@/lib/looped-review-persistence";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import {
  preserveClientPaneSelection,
  preserveRendererLocalPaneFields,
  reconcilePersistedLayout,
} from "@/lib/pane-layout-restore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { usePaneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { LEGACY_PANE_LAYOUT_VERSION, type PersistedPaneLayout } from "@/types/paneLayout";
import { applyStoredPaneSelection, readWindowPaneSelection } from "@/lib/pane-selection-storage";

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
const MAX_PENDING_TAB_ACTIVATIONS = 64;

export interface PaneTabActivationRequest {
  readonly environmentId: string;
}

// Backend-owned jobs publish their tabs through pane-layout reconciliation.
// Electron windows intentionally preserve their own selection while adopting
// that shared structure, so an action initiated in this renderer needs a
// renderer-local handoff to focus its resulting tab. Keep only the latest
// request per environment: a later foreground action supersedes an earlier one.
const pendingTabActivations = new Map<string, string>();
const latestTabActivationRequests = new Map<string, PaneTabActivationRequest>();

function boundActivationMap<T>(map: Map<string, T>): void {
  while (map.size > MAX_PENDING_TAB_ACTIVATIONS) {
    const oldestEnvironmentId = map.keys().next().value;
    if (typeof oldestEnvironmentId !== "string") break;
    map.delete(oldestEnvironmentId);
  }
}

/**
 * Claim the next backend-created tab activation before its asynchronous launch.
 *
 * The object identity is the ordering token. Keeping it here, outside React,
 * makes launch order authoritative across every mounted controller instance.
 */
export function beginPaneTabActivationRequest(environmentId: string): PaneTabActivationRequest {
  const request = { environmentId };
  latestTabActivationRequests.delete(environmentId);
  latestTabActivationRequests.set(environmentId, request);
  // A newer foreground action also supersedes an older tab which finished
  // launching but has not appeared in the authoritative layout yet.
  pendingTabActivations.delete(environmentId);
  boundActivationMap(latestTabActivationRequests);
  return request;
}

function activateTabInState(
  state: EnvironmentPaneState,
  tabId: string,
): EnvironmentPaneState | null {
  const visit = (node: EnvironmentPaneState["root"]): string | null => {
    if (node.kind === "leaf") {
      return node.tabs.some((tab) => tab.id === tabId) ? node.id : null;
    }
    return visit(node.children[0]) ?? visit(node.children[1]);
  };
  const paneId = visit(state.root);
  if (!paneId) return null;

  const select = (node: EnvironmentPaneState["root"]): EnvironmentPaneState["root"] => {
    if (node.kind === "leaf") {
      return node.id === paneId ? { ...node, activeTabId: tabId } : node;
    }
    return {
      ...node,
      children: [select(node.children[0]), select(node.children[1])],
    };
  };
  return { ...state, root: select(state.root), activePaneId: paneId };
}

/**
 * Focus a backend-created tab in the Electron window that launched it.
 *
 * If the resource announcement is still in flight, reconciliation consumes
 * the pending request when the exact tab arrives. Browser clients already use
 * the backend's shared selection and need no renderer-local override.
 */
export function requestPaneTabActivation(
  environmentId: string,
  tabId: string,
  request?: PaneTabActivationRequest,
): void {
  if (request) {
    if (
      request.environmentId !== environmentId ||
      latestTabActivationRequests.get(environmentId) !== request
    ) {
      return;
    }
    latestTabActivationRequests.delete(environmentId);
  } else {
    // Preserve the original immediate API for non-launch callers. An explicit
    // request is itself newer than any unresolved launch for this environment.
    latestTabActivationRequests.delete(environmentId);
    pendingTabActivations.delete(environmentId);
  }
  if (!window.orkestrator?.isolatedViewState) return;

  const store = usePaneLayoutStore.getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (pane) {
    pendingTabActivations.delete(environmentId);
    store.setActiveTab(pane.id, tabId, environmentId);
    return;
  }

  pendingTabActivations.delete(environmentId);
  pendingTabActivations.set(environmentId, tabId);
  boundActivationMap(pendingTabActivations);
}

function applyPendingTabActivation(
  environmentId: string,
  state: EnvironmentPaneState,
): EnvironmentPaneState {
  const tabId = pendingTabActivations.get(environmentId);
  if (!tabId) return state;
  const activated = activateTabInState(state, tabId);
  if (!activated) return state;
  pendingTabActivations.delete(environmentId);
  return activated;
}

export function collectPaneDependencyIds(root: unknown): {
  pipelineIds: Set<string>;
  workflowIds: Set<string>;
} {
  const pipelineIds = new Set<string>();
  const workflowIds = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPENDENCY_SCAN_DEPTH ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
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

function collectMultiReviewIds(root: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPENDENCY_SCAN_DEPTH ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return;
    const record = value as Record<string, unknown>;
    if (record.kind === "leaf" && Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
        const data = (tab as Record<string, unknown>).multiReviewTabData;
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        const id = (data as Record<string, unknown>).workflowId;
        if (typeof id === "string" && id.trim()) ids.add(id);
      }
      return;
    }
    if (record.kind === "split" && Array.isArray(record.children)) {
      record.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(root, 0);
  return ids;
}

/**
 * Loads any build pipeline or looped review a snapshot references but this
 * client has never seen, so `reconcilePersistedLayout` does not drop the tab
 * that carries it. Already-present records are not refetched.
 */
export async function hydratePaneLayoutDependencies(root: unknown): Promise<void> {
  const { pipelineIds, workflowIds } = collectPaneDependencyIds(root);
  const multiReviewIds = collectMultiReviewIds(root);
  const missingPipelineIds = [...pipelineIds].filter(
    (pipelineId) => !useBuildPipelineStore.getState().pipelines.has(pipelineId),
  );
  const missingWorkflowIds = [...workflowIds].filter(
    (workflowId) => !useLoopedReviewStore.getState().workflows.has(workflowId),
  );
  const missingMultiReviewIds = [...multiReviewIds].filter(
    (workflowId) => !useMultiReviewStore.getState().workflows.has(workflowId),
  );
  if (
    missingPipelineIds.length === 0 &&
    missingWorkflowIds.length === 0 &&
    missingMultiReviewIds.length === 0
  )
    return;
  await Promise.all([
    ...missingPipelineIds.map((pipelineId) =>
      hydrateBuildPipeline(pipelineId).then(() => undefined),
    ),
    ...missingWorkflowIds.map((workflowId) =>
      hydrateLoopedReviewWorkflow(workflowId).then(() => undefined),
    ),
    ...missingMultiReviewIds.map((workflowId) =>
      hydrateMultiReviewWorkflow(workflowId).then(() => undefined),
    ),
  ]);
}

/**
 * Validates a backend snapshot against this client's environment and stores,
 * then preserves renderer-local fields. Electron windows keep pane and tab
 * selection in their isolated renderer partition; browser clients continue to
 * adopt the backend selection.
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
  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
  if (!environment) return null;

  const isLocal = environment.environmentType === "local";
  const containerId = isLocal ? null : environment.containerId;
  if (current.containerId !== containerId) return null;

  const restored = reconcilePersistedLayout(saved, {
    environmentId,
    containerId,
    isLocal,
    worktreePath: environment.worktreePath,
    hasBuildPipeline: (pipelineId) => useBuildPipelineStore.getState().pipelines.has(pipelineId),
    hasLoopedReview: (workflowId) => useLoopedReviewStore.getState().workflows.has(workflowId),
    hasMultiReview: (workflowId) => useMultiReviewStore.getState().workflows.has(workflowId),
  });
  if (!restored) return null;

  if (window.orkestrator?.isolatedViewState) {
    const selected = applyStoredPaneSelection(
      preserveClientPaneSelection(restored, current),
      environmentId,
      readWindowPaneSelection(environmentId),
    );
    return applyPendingTabActivation(environmentId, selected);
  }

  // V1 stored canonical first-pane/first-tab placeholders, not real focus.
  // Until its migration write succeeds, keep this renderer's selection while
  // still adopting structural changes and renderer-local connection fields.
  return saved.version === LEGACY_PANE_LAYOUT_VERSION
    ? preserveClientPaneSelection(restored, current)
    : preserveRendererLocalPaneFields(restored, current);
}
