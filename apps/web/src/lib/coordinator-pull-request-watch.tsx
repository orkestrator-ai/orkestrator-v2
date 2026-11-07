import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  gitHubPullRequestKey,
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { appCommandScope } from "@/lib/node-scope-slots";

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
const pending = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
export const COORDINATOR_PR_WATCH_RETRY_MS = 5_000;

/** Test hook: forget every report, so each test starts clean. */
export function resetCoordinatorPullRequestWatchReports(): void {
  reported.clear();
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
}

/**
 * Tell the backend a coordinator of `projectId` showed this pull request.
 * Best effort: a rendered link is reported once per window, an opened one
 * always (opening is the stronger signal and rare). Failed reports retry up
 * to five times with bounded exponential backoff, even if the link unmounts.
 */
export function reportCoordinatorPullRequest(
  projectId: string,
  ref: GitHubPullRequestRef,
  source: "rendered" | "opened",
  now: number = Date.now(),
  /** The coordinator's node (plan item 4007); the app's command scope when omitted. */
  scope: NodeScope = appCommandScope(),
): void {
  const key = `${scope.nodeId}\0${projectId}\0${gitHubPullRequestKey(ref)}`;
  const last = reported.get(key);
  if (
    source === "rendered" &&
    last !== undefined &&
    now - last < COORDINATOR_PR_WATCH_REPORT_TTL_MS
  )
    return;
  if (source === "rendered" && pending.has(key)) return;
  // A click upgrades a pending rendered report to an explicit open.
  const old = pending.get(key);
  if (old?.timer) clearTimeout(old.timer);
  const entry: { timer?: ReturnType<typeof setTimeout> } = {};
  pending.set(key, entry);
  while (pending.size > MAX_REMEMBERED_REPORTS) {
    const oldest = pending.keys().next().value!;
    const evicted = pending.get(oldest);
    if (evicted?.timer) clearTimeout(evicted.timer);
    pending.delete(oldest);
  }
  const attempt = (retry: number) => {
    void backendForScope(scope)
      .watchCoordinatorPullRequest(
        projectId,
        { owner: ref.owner, repo: ref.repo, number: ref.number },
        source,
      )
      .then(() => {
        if (pending.get(key) !== entry) return;
        pending.delete(key);
        reported.delete(key);
        reported.set(key, now + (Date.now() - started));
        while (reported.size > MAX_REMEMBERED_REPORTS) {
          reported.delete(reported.keys().next().value!);
        }
      })
      .catch(() => {
        if (pending.get(key) !== entry) return;
        if (retry >= 5) {
          pending.delete(key);
          return;
        }
        entry.timer = setTimeout(
          () => attempt(retry + 1),
          Math.min(COORDINATOR_PR_WATCH_RETRY_MS * 2 ** retry, 60_000),
        );
      });
  };
  const started = Date.now();
  attempt(0);
}

/**
 * For a link rendered inside a coordinator conversation: reports a pull
 * request link once it is on screen, and returns the callback that reports
 * it opened. Both do nothing outside a coordinator or for other links.
 */
export function useCoordinatorPullRequestLink(href: string | undefined): () => void {
  const watch = useContext(CoordinatorPullRequestWatchContext);
  const projectId = watch?.projectId;
  // The coordinator's node: the link reports there (plan item 4007).
  const scope = useScopesWithCommandFallback().scope;
  const ref = useMemo(
    () => (projectId && href ? parseGitHubPullRequestLink(href) : null),
    [href, projectId],
  );
  useEffect(() => {
    if (projectId && ref)
      reportCoordinatorPullRequest(projectId, ref, "rendered", Date.now(), scope);
  }, [projectId, ref, scope]);
  return useCallback(() => {
    if (projectId && ref) reportCoordinatorPullRequest(projectId, ref, "opened", Date.now(), scope);
  }, [projectId, ref, scope]);
}
