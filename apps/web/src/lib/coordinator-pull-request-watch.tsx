import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  gitHubPullRequestKey,
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { watchCoordinatorPullRequest } from "@/lib/backend/coordinator";

/**
 * Pull request links a coordinator conversation shows are watched by the
 * backend until they settle (`coordinator-pr-watches.ts`), and their status
 * changes reach the main coordinator as small notices. Links render inside
 * the coordinator panel under this context; everywhere else it is absent and
 * nothing is watched.
 */
interface CoordinatorPullRequestWatch {
  projectId: string;
}

const CoordinatorPullRequestWatchContext = createContext<CoordinatorPullRequestWatch | null>(null);

export function CoordinatorPullRequestWatchProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ projectId }), [projectId]);
  return (
    <CoordinatorPullRequestWatchContext.Provider value={value}>
      {children}
    </CoordinatorPullRequestWatchContext.Provider>
  );
}

/**
 * How long a pull request reported for a project is not reported again from
 * this window. Transcripts re-render links constantly (virtualized rows,
 * streaming); the backend refreshes "last seen" at most hourly anyway.
 */
export const COORDINATOR_PR_WATCH_REPORT_TTL_MS = 15 * 60 * 1_000;
/** Bound on the remembered reports; the oldest are forgotten first. */
const MAX_REMEMBERED_REPORTS = 500;

const reported = new Map<string, number>();

/** Test hook: forget every report, so each test starts clean. */
export function resetCoordinatorPullRequestWatchReports(): void {
  reported.clear();
}

/**
 * Tell the backend a coordinator of `projectId` showed this pull request.
 * Best effort: a rendered link is reported once per window, an opened one
 * always (opening is the stronger signal and rare). Failures, including an
 * older backend without the command, are ignored.
 */
export function reportCoordinatorPullRequest(
  projectId: string,
  ref: GitHubPullRequestRef,
  source: "rendered" | "opened",
  now: number = Date.now(),
): void {
  const key = `${projectId}\0${gitHubPullRequestKey(ref)}`;
  const last = reported.get(key);
  if (
    source === "rendered" &&
    last !== undefined &&
    now - last < COORDINATOR_PR_WATCH_REPORT_TTL_MS
  )
    return;
  reported.delete(key);
  reported.set(key, now);
  while (reported.size > MAX_REMEMBERED_REPORTS) {
    const oldest = reported.keys().next().value;
    if (oldest === undefined) break;
    reported.delete(oldest);
  }
  void watchCoordinatorPullRequest(
    projectId,
    { owner: ref.owner, repo: ref.repo, number: ref.number },
    source,
  ).catch(() => undefined);
}

/**
 * For a link rendered inside a coordinator conversation: reports a pull
 * request link once it is on screen, and returns the callback that reports
 * it opened. Both do nothing outside a coordinator or for other links.
 */
export function useCoordinatorPullRequestLink(href: string | undefined): () => void {
  const watch = useContext(CoordinatorPullRequestWatchContext);
  const projectId = watch?.projectId;
  const ref = useMemo(
    () => (projectId && href ? parseGitHubPullRequestLink(href) : null),
    [href, projectId],
  );
  useEffect(() => {
    if (projectId && ref) reportCoordinatorPullRequest(projectId, ref, "rendered");
  }, [projectId, ref]);
  return useCallback(() => {
    if (projectId && ref) reportCoordinatorPullRequest(projectId, ref, "opened");
  }, [projectId, ref]);
}
