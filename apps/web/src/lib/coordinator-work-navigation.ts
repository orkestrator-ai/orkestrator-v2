/**
 * Opens a link to a coordinator's work: a worker named by a mail tile or a
 * waiting prompt, or the work target a realm workspace request carries from
 * another node's window (which may run an older release that still sends
 * builds, reviews and graph runs). Every target reuses the path its own
 * surface already uses: the build tab activation the create
 * dialog uses, the graph run view request every launch surface uses, the PR
 * opener, and the machine-qualified workspace opener for another node's work.
 */
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { requestGraphRunView } from "@/lib/graph-run-navigation";
import { requestPaneTabActivation } from "@/lib/pane-layout-authoritative";
import { openPullRequestUrl } from "@/lib/pull-request-opener";
import { openConversationTab } from "@/lib/web-annotations/navigation";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import type { CoordinatorWorkTarget } from "./coordinator-work-items";

export interface CoordinatorWorkNavigation {
  openPullRequest: (url: string) => void;
  openRemote: (target: Extract<CoordinatorWorkTarget, { type: "remote" }>) => void;
  openBuild: (projectId: string, pipelineId: string, environmentId?: string) => void;
}

const defaultNavigation: CoordinatorWorkNavigation = {
  openPullRequest: (url) => void openPullRequestUrl(url).catch(() => undefined),
  openRemote: (target) => {
    if (target.workTarget && target.nodeId === portalStore.getState().selfId) {
      useRemoteWorkspaceStore.getState().showLocal();
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

function selectEnvironment(projectId: string, environmentId: string): void {
  const ui = useUIStore.getState();
  ui.setProjectCollapsed(projectId, false);
  ui.selectProjectAndEnvironment(projectId, environmentId);
}

/** Focuses a tab that is in the environment's layout, or asks for it once it arrives. */
function focusTab(environmentId: string, tabId: string): void {
  if (!openConversationTab(environmentId, tabId)) requestPaneTabActivation(environmentId, tabId);
}

const pendingWorkers = new Map<string, string>();
let offWorkers: (() => void) | undefined;
function reconcileWorkers(): void {
  for (const [environmentId, tabId] of Array.from(pendingWorkers)) {
    const store = usePaneLayoutStore.getState();
    if (
      store.hydration.get(environmentId) !== "done" ||
      !store.findPaneWithTab(tabId, environmentId)
    )
      continue;
    pendingWorkers.delete(environmentId);
    focusTab(environmentId, tabId);
  }
  if (!pendingWorkers.size) {
    offWorkers?.();
    offWorkers = undefined;
  }
}

// The layout can still be hydrating when Open selects another environment.
// Keep the intent outside React and let the normal layout persistence publish
// a restored tab only after the authoritative snapshot has been installed.
const pendingReviews = new Map<string, Extract<CoordinatorWorkTarget, { type: "review" }>>();
let offReviews: (() => void) | undefined;
function reconcileReviews(): void {
  for (const [environmentId, target] of Array.from(pendingReviews)) {
    const store = usePaneLayoutStore.getState();
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
    focusTab(environmentId, tabId);
  }
  if (!pendingReviews.size) {
    offReviews?.();
    offReviews = undefined;
  }
}

export function openCoordinatorWorkTarget(
  target: CoordinatorWorkTarget,
  navigation: CoordinatorWorkNavigation = defaultNavigation,
): void {
  switch (target.type) {
    case "worker-tab":
      selectEnvironment(target.projectId, target.environmentId);
      if (target.tabId) {
        pendingWorkers.set(target.environmentId, target.tabId);
        while (pendingWorkers.size > 64) pendingWorkers.delete(pendingWorkers.keys().next().value!);
        offWorkers ??= usePaneLayoutStore.subscribe(reconcileWorkers);
        reconcileWorkers();
      }
      return;
    case "build":
      navigation.openBuild(target.projectId, target.pipelineId, target.environmentId);
      return;
    case "review": {
      selectEnvironment(target.projectId, target.environmentId);
      const tab = usePaneLayoutStore
        .getState()
        .getAllTabs(target.environmentId)
        .find(
          (item) =>
            item.type === "multi-review" &&
            item.multiReviewTabData?.workflowId === target.workflowId &&
            !item.multiReviewTabData.reviewerId,
        );
      if (tab) focusTab(target.environmentId, tab.id);
      else {
        pendingReviews.set(target.environmentId, target);
        while (pendingReviews.size > 64) pendingReviews.delete(pendingReviews.keys().next().value!);
        offReviews ??= usePaneLayoutStore.subscribe(reconcileReviews);
        reconcileReviews();
      }
      return;
    }
    case "graph-run":
      selectEnvironment(target.projectId, target.environmentId);
      requestGraphRunView({
        runId: target.runId,
        projectId: target.projectId,
        environmentId: target.environmentId,
        mock: false,
        ...(target.title ? { title: target.title } : {}),
      });
      return;
    case "pull-request":
      navigation.openPullRequest(target.url);
      return;
    case "remote":
      navigation.openRemote(target);
      return;
  }
}
