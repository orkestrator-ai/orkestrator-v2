import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
  type GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { openInBrowser } from "@/lib/backend";
import { projectRootFilesTargetId, useFilesPanelStore } from "@/stores/filesPanelStore";
import { useProjectStore } from "@/stores/projectStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
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
 * on the project's Pull requests page opens as another tab of that page.
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
 * The target whose pull request tabs the right-hand files panel shows now:
 * the selected environment, or the selected project's root checkout. Mirrors
 * `useFilesPanel`. Null when nothing is selected, as under another machine's
 * workspace, which clears this window's selection and has its own panel.
 */
export function currentFilesPanelTargetId(): string | null {
  const ui = useUIStore.getState();
  if (ui.selectedEnvironmentId) return ui.selectedEnvironmentId;
  if (!ui.selectedProjectId) return null;
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === ui.selectedProjectId);
  return project ? projectRootFilesTargetId(project.id) : null;
}

/**
 * Default routing outside any provider: the pull request opens in the
 * right-hand files panel of whatever the main view shows, whichever project
 * or environment the pull request belongs to. Nothing in the main view
 * changes (no selection, board tab or pane tab), so closing the panel returns
 * the user exactly where they were.
 */
export function openPullRequestInApp(
  ref: GitHubPullRequestRef,
  view?: GitHubPullRequestViewTab,
): boolean {
  if (useRemoteWorkspaceStore.getState().active) return false;
  const targetId = currentFilesPanelTargetId();
  if (!targetId) return false;
  useFilesPanelStore.getState().openPullRequest(targetId, ref, view);
  return true;
}

/**
 * Opens a GitHub pull request URL in the app, or in the external browser when
 * it is not one the viewer can show (or nothing could host it). `external`
 * forces the browser, for explicit "Open on GitHub" actions and modifier clicks.
 */
export function openPullRequestUrl(
  url: string,
  options: { external?: boolean; opener?: PullRequestOpener } = {},
): Promise<void> {
  const pullRequest = options.external ? null : parseGitHubPullRequestLink(url);
  if (pullRequest && (options.opener ?? openPullRequestInApp)(pullRequest, pullRequest.view)) {
    return Promise.resolve();
  }
  return openInBrowser(url);
}

export function usePullRequestOpener(): PullRequestOpener {
  return useContext(PullRequestOpenerContext) ?? openPullRequestInApp;
}
