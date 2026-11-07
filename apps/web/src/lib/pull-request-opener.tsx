import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
  type GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { armPullRequestFallback } from "./pull-request-load-fallback";
import { openInBrowser } from "@/lib/backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { filesPanelStore, projectRootFilesTargetId } from "@/stores/filesPanelStore";
import { appCommandScope } from "@/lib/node-scope-slots";
import { shownNodeScope } from "@/lib/node-scope/shown-scope";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";

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
 * to the right-hand pane, with modal hosts able to close after opening.
 */
export function PullRequestOpenerProvider({
  open,
  children,
}: {
  /** Returning false declines, so the link falls back to the browser. */
  open: (ref: GitHubPullRequestRef, view?: GitHubPullRequestViewTab) => boolean | void;
  children: ReactNode;
}) {
  const opener = useMemo<PullRequestOpener>(
    () => (ref, view) => {
      if (open(ref, view) === false) return false;
      armPullRequestFallback(ref);
      return true;
    },
    [open],
  );
  return (
    <PullRequestOpenerContext.Provider value={opener}>{children}</PullRequestOpenerContext.Provider>
  );
}

/**
 * The target whose pull request tabs `scope`'s files panel shows now (the
 * command node's by default): the selected environment, or the selected
 * project's root checkout. Mirrors `useFilesPanel`. Null when nothing is
 * selected there, as while the window shows another node, whose workspace
 * has its own panel.
 */
export function currentFilesPanelTargetId(scope: NodeScope = appCommandScope()): string | null {
  const ui = scope.store(uiStore).getState();
  if (ui.selectedEnvironmentId) return ui.selectedEnvironmentId;
  if (!ui.selectedProjectId) return null;
  const project = scope
    .store(projectStore)
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
 *
 * `scope` is the node whose files panel shows it. Without one, the node the
 * window shows (`shownNodeScope`, plan item 5002): the command node, or
 * another node shown in the window's own tree. A node whose scope is not
 * open (yet) has none here, so the caller falls back to the browser.
 */
export function openPullRequestInApp(
  ref: GitHubPullRequestRef,
  view?: GitHubPullRequestViewTab,
  scope: NodeScope | null = shownNodeScope(),
): boolean {
  if (!scope) return false;
  // Null while nothing is selected on that node.
  const targetId = currentFilesPanelTargetId(scope);
  if (!targetId) return false;
  armPullRequestFallback(ref);
  scope.store(filesPanelStore).getState().openPullRequest(targetId, ref, view);
  return true;
}

/**
 * Opens a GitHub pull request URL in the app, or in the external browser when
 * it is not one the viewer can show (or nothing could host it). `external`
 * forces the browser, for explicit "Open on GitHub" actions and modifier clicks.
 * Resolves true when the pull request opened in the app.
 */
export async function openPullRequestUrl(
  url: string,
  options: { external?: boolean; opener?: PullRequestOpener } = {},
): Promise<boolean> {
  const pullRequest = options.external ? null : parseGitHubPullRequestLink(url);
  if (pullRequest && (options.opener ?? openPullRequestInApp)(pullRequest, pullRequest.view)) {
    armPullRequestFallback(pullRequest, url);
    return true;
  }
  await openInBrowser(url);
  return false;
}

/** The nearest provider's opener, else `openPullRequestInApp` on the nearest node scope. */
export function usePullRequestOpener(): PullRequestOpener {
  const provided = useContext(PullRequestOpenerContext);
  const scope = useShimNodeScope(filesPanelStore.name);
  const inScope = useMemo<PullRequestOpener>(
    () => (ref, view) => openPullRequestInApp(ref, view, scope),
    [scope],
  );
  return provided ?? inScope;
}
