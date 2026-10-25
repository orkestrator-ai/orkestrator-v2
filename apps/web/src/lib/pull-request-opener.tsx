import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useProjectPullRequestsStore } from "@/stores/projectPullRequestsStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * Opens a pull request inside the app. Returns false when there is nowhere to
 * show it, so the caller can fall back to the external browser.
 */
export type PullRequestOpener = (
  ref: GitHubPullRequestRef,
  view?: GitHubPullRequestViewTab,
) => boolean;

const PullRequestOpenerContext = createContext<PullRequestOpener | null>(null);

/**
 * Routes pull requests opened inside a subtree (a pull request view, a list)
 * to the host showing it, so a link in a sidebar PR opens beside it and one
 * on the project page opens as another project tab.
 */
export function PullRequestOpenerProvider({
  open,
  children,
}: {
  open: (ref: GitHubPullRequestRef, view?: GitHubPullRequestViewTab) => void;
  children: ReactNode;
}) {
  const opener = useMemo<PullRequestOpener>(
    () => (ref, view) => {
      open(ref, view);
      return true;
    },
    [open],
  );
  return (
    <PullRequestOpenerContext.Provider value={opener}>{children}</PullRequestOpenerContext.Provider>
  );
}

/**
 * Default routing outside any provider: an environment's pull requests open
 * in its files panel; on a project page they open as the project's tabs.
 */
export function openPullRequestInApp(
  ref: GitHubPullRequestRef,
  view?: GitHubPullRequestViewTab,
): boolean {
  const ui = useUIStore.getState();
  const environment = ui.selectedEnvironmentId
    ? useEnvironmentStore.getState().getEnvironmentById(ui.selectedEnvironmentId)
    : undefined;
  const projectId = environment?.projectId ?? ui.selectedProjectId;
  // A project home under a board tab other than "home" shows the project page.
  const showsProjectPage =
    !!projectId &&
    (!environment || (environment.projectHome === true && ui.projectBoardTab !== "home"));

  if (showsProjectPage && projectId) {
    useProjectPullRequestsStore.getState().openPullRequest(projectId, ref, view);
    ui.setProjectBoardTab("pull-requests");
    return true;
  }
  if (environment) {
    useFilesPanelStore.getState().openPullRequest(environment.id, ref, view);
    return true;
  }
  return false;
}

export function usePullRequestOpener(): PullRequestOpener {
  return useContext(PullRequestOpenerContext) ?? openPullRequestInApp;
}
