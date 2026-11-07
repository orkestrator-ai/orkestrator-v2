/**
 * Opens a link to a coordinator's work: a worker named by a mail tile or a
 * waiting prompt, or the work target another node's workspace request
 * carries (`WorkspaceRequest.workTarget`). Every target reuses the path its own
 * surface already uses: the build tab activation the create
 * dialog uses, the graph run view request every launch surface uses, the PR
 * opener, and the machine-qualified workspace opener for another node's work.
 */
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { requestGraphRunView } from "@/lib/graph-run-navigation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { requestPaneTabActivation } from "@/lib/pane-layout-authoritative";
import { openPullRequestUrl } from "@/lib/pull-request-opener";
import { openConversationTab } from "@/lib/web-annotations/navigation";
import { paneLayoutStore, type PaneLayoutState } from "@/stores/paneLayoutStore";
import type { StoreApi } from "zustand/vanilla";
import { uiStore } from "@/stores/uiStore";
import type { CoordinatorWorkTarget } from "./coordinator-work-items";

export interface CoordinatorWorkNavigation {
  openPullRequest: (url: string) => void;
  openRemote: (target: Extract<CoordinatorWorkTarget, { type: "remote" }>) => void;
  openBuild: (
    projectId: string,
    pipelineId: string,
    environmentId: string | undefined,
    scope: NodeScope,
  ) => void;
}

const defaultNavigation: CoordinatorWorkNavigation = {
  openPullRequest: (url) => void openPullRequestUrl(url).catch(() => undefined),
  openRemote: (target) => {
    if (target.workTarget && target.nodeId === portalStore.getState().selfId) {
      useRemoteWorkspaceStore.getState().showLocal();
      // This window's own node: the command scope.
      openCoordinatorWorkTarget(target.workTarget);
      return;
    }
    openMachineWorkspace({
      connectionId: target.nodeId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      title: target.title,
      workTarget: target.workTarget,
    });
  },
  openBuild: scheduleBuildPipelineTabActivation,
};

function selectEnvironment(scope: NodeScope, projectId: string, environmentId: string): void {
  const ui = scope.store(uiStore).getState();
  ui.setProjectCollapsed(projectId, false);
  ui.selectProjectAndEnvironment(projectId, environmentId);
}

/** Focuses a tab that is in the environment's layout, or asks for it once it arrives. */
function focusTab(scope: NodeScope, environmentId: string, tabId: string): void {
  if (!openConversationTab(environmentId, tabId, scope))
    requestPaneTabActivation(environmentId, tabId, scope);
}

type ReviewTarget = Extract<CoordinatorWorkTarget, { type: "review" }>;

/**
 * One node's open requests still waiting for their environment's layout:
 * worker tabs and reviews, by environment, and the layout subscriptions
 * while any is pending (plan item 3011). The layout they wait for is the
 * node's own pane-layout store (plan item 3013).
 */
interface CoordinatorNavigationState {
  readonly scope: NodeScope;
  readonly layouts: StoreApi<PaneLayoutState>;
  readonly pendingWorkers: Map<string, string>;
  offWorkers: (() => void) | undefined;
  // The layout can still be hydrating when Open selects another environment.
  // Keep the intent outside React and let the normal layout persistence publish
  // a restored tab only after the authoritative snapshot has been installed.
  readonly pendingReviews: Map<string, ReviewTarget>;
  offReviews: (() => void) | undefined;
}

const navigationState = defineScopedSlot<CoordinatorNavigationState>(
  "coordinator-work-navigation",
  (scope) => {
    const state: CoordinatorNavigationState = {
      scope,
      layouts: scope.store(paneLayoutStore),
      pendingWorkers: new Map(),
      offWorkers: undefined,
      pendingReviews: new Map(),
      offReviews: undefined,
    };
    scope.onDispose("coordinator-work-navigation", () => {
      state.offWorkers?.();
      state.offWorkers = undefined;
      state.offReviews?.();
      state.offReviews = undefined;
      state.pendingWorkers.clear();
      state.pendingReviews.clear();
    });
    return state;
  },
);

function reconcileWorkers(state: CoordinatorNavigationState): void {
  const { pendingWorkers } = state;
  for (const [environmentId, tabId] of Array.from(pendingWorkers)) {
    const store = state.layouts.getState();
    if (
      store.hydration.get(environmentId) !== "done" ||
      !store.findPaneWithTab(tabId, environmentId)
    )
      continue;
    pendingWorkers.delete(environmentId);
    focusTab(state.scope, environmentId, tabId);
  }
  if (!pendingWorkers.size) {
    state.offWorkers?.();
    state.offWorkers = undefined;
  }
}

function reconcileReviews(state: CoordinatorNavigationState): void {
  const { pendingReviews } = state;
  for (const [environmentId, target] of Array.from(pendingReviews)) {
    const store = state.layouts.getState();
    if (store.hydration.get(environmentId) !== "done") continue;
    const paneId = store.getActivePaneId(environmentId);
    if (!paneId) continue;
    pendingReviews.delete(environmentId);
    const existing = store
      .getAllTabs(environmentId)
      .find(
        (tab) =>
          tab.type === "multi-review" &&
          tab.multiReviewTabData?.workflowId === target.workflowId &&
          !tab.multiReviewTabData.reviewerId,
      );
    const tabId = existing?.id ?? `multi-review:${target.workflowId}`;
    if (!existing)
      store.addTab(
        paneId,
        {
          id: tabId,
          type: "multi-review",
          multiReviewTabData: { environmentId, workflowId: target.workflowId },
        },
        environmentId,
      );
    focusTab(state.scope, environmentId, tabId);
  }
  if (!pendingReviews.size) {
    state.offReviews?.();
    state.offReviews = undefined;
  }
}

/**
 * Opens `target` on `scope`'s node (the app's command scope when omitted:
 * the mail tiles and prompts that call this name none yet).
 */
export function openCoordinatorWorkTarget(
  target: CoordinatorWorkTarget,
  navigation: CoordinatorWorkNavigation = defaultNavigation,
  scope: NodeScope = appCommandScope(),
): void {
  switch (target.type) {
    case "worker-tab":
      selectEnvironment(scope, target.projectId, target.environmentId);
      if (target.tabId) {
        const state = navigationState(scope);
        const { pendingWorkers } = state;
        pendingWorkers.set(target.environmentId, target.tabId);
        while (pendingWorkers.size > 64) pendingWorkers.delete(pendingWorkers.keys().next().value!);
        state.offWorkers ??= state.layouts.subscribe(() => reconcileWorkers(state));
        reconcileWorkers(state);
      }
      return;
    case "build":
      navigation.openBuild(target.projectId, target.pipelineId, target.environmentId, scope);
      return;
    case "review": {
      selectEnvironment(scope, target.projectId, target.environmentId);
      const tab = scope
        .store(paneLayoutStore)
        .getState()
        .getAllTabs(target.environmentId)
        .find(
          (item) =>
            item.type === "multi-review" &&
            item.multiReviewTabData?.workflowId === target.workflowId &&
            !item.multiReviewTabData.reviewerId,
        );
      if (tab) focusTab(scope, target.environmentId, tab.id);
      else {
        const state = navigationState(scope);
        const { pendingReviews } = state;
        pendingReviews.set(target.environmentId, target);
        while (pendingReviews.size > 64) pendingReviews.delete(pendingReviews.keys().next().value!);
        state.offReviews ??= state.layouts.subscribe(() => reconcileReviews(state));
        reconcileReviews(state);
      }
      return;
    }
    case "graph-run":
      selectEnvironment(scope, target.projectId, target.environmentId);
      requestGraphRunView(
        {
          runId: target.runId,
          projectId: target.projectId,
          environmentId: target.environmentId,
          mock: false,
          ...(target.title ? { title: target.title } : {}),
        },
        scope,
      );
      return;
    case "pull-request":
      navigation.openPullRequest(target.url);
      return;
    case "remote":
      navigation.openRemote(target);
      return;
  }
}
