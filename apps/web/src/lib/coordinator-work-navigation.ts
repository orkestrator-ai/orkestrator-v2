/**
 * Where a Coordinator Work panel row's Open button goes. Every target reuses
 * the path its own surface already uses: the build tab activation the create
 * dialog uses, the graph run view request every launch surface uses, the PR
 * opener, and the machine-qualified workspace opener for another node's work.
 */
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
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
  openRemote: (target) =>
    openMachineWorkspace({
      connectionId: target.nodeId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      title: target.title,
    }),
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

export function openCoordinatorWorkTarget(
  target: CoordinatorWorkTarget,
  navigation: CoordinatorWorkNavigation = defaultNavigation,
): void {
  switch (target.type) {
    case "worker-tab":
      selectEnvironment(target.projectId, target.environmentId);
      if (target.tabId) focusTab(target.environmentId, target.tabId);
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
