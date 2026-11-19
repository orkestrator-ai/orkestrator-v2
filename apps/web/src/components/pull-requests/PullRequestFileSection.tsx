import { useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import {
  gitHubPullRequestUrl,
  type GitHubPullRequestFile,
  type GitHubPullRequestFilePatch,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TruncatedPath } from "@/components/ui/truncated-path";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { PullRequestDiff } from "./PullRequestDiff";
import { PullRequestReviewThread } from "./PullRequestReviewThread";
import { pluralize, splitPath } from "./pull-request-format";
import { FILE_STATUS_ICONS } from "./pull-request-file-status";
import { errorMessage } from "./pull-request-shared";

export function openExternal(url: string) {
  void openInBrowser(url).catch((error) =>
    toast.error(errorMessage(error, "Could not open the browser.")),
  );
}

/** Where a file's deferred patch stands in the renderer's cache. */
export type FilePatchState = {
  patch: GitHubPullRequestFilePatch | undefined;
  loading: boolean;
  error: string | undefined;
};

function ViewOnGitHub({
  pullRequest,
  file,
}: {
  pullRequest: GitHubPullRequestRef;
  file: GitHubPullRequestFile;
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline"
      onClick={() => openExternal(file.blobUrl ?? `${gitHubPullRequestUrl(pullRequest)}/files`)}
    >
      View on GitHub
      <ExternalLink className="size-3" />
    </button>
  );
}

/** Conversations on a file whose diff is not shown here, so none are lost. */
function ThreadsWithoutDiff({
  pullRequest,
  threads,
  canComment,
}: {
  pullRequest: GitHubPullRequestRef;
  threads: GitHubPullRequestReviewThread[];
  canComment: boolean;
}) {
  if (threads.length === 0) return null;
  return (
    <div
      data-testid="file-threads-without-diff"
      className="space-y-2 border-t border-border/50 px-2 py-2 font-sans"
    >
      {threads.map((thread) => (
        <PullRequestReviewThread
          key={thread.id}
          pullRequest={pullRequest}
          thread={thread}
          canReply={canComment}
        />
      ))}
    </div>
  );
}

function Notice({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-2 px-3 py-3 text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

function FileBody({
  pullRequest,
  file,
  threads,
  commitId,
  canComment,
  patchState,
  onLoadPatch,
}: {
  pullRequest: GitHubPullRequestRef;
  file: GitHubPullRequestFile;
  threads: GitHubPullRequestReviewThread[];
  commitId: string;
  canComment: boolean;
  patchState: FilePatchState;
  onLoadPatch: () => void;
}) {
  const { patch, loading, error } = patchState;
  const loaded = patch?.outcome === "loaded" && patch.patchAvailable ? patch : null;
  // One stable object per loaded patch, so the diff's thread anchoring memoizes.
  const fileWithPatch = useMemo(
    () => (loaded ? { ...file, hunks: loaded.hunks, patchAvailable: true } : null),
    [file, loaded],
  );

  if (file.patchAvailable || fileWithPatch) {
    return (
      <PullRequestDiff
        pullRequest={pullRequest}
        file={fileWithPatch ?? file}
        threads={threads}
        commitId={commitId}
        canComment={canComment}
      />
    );
  }

  let notice: ReactNode;
  if (file.patchDeferred && !patch) {
    if (loading) {
      notice = (
        <Notice testId="file-patch-loading">
          <Loader2 className="size-3.5 animate-spin" />
          Loading this file’s changes…
        </Notice>
      );
    } else if (error) {
      notice = (
        <Notice testId="file-patch-error">
          <span role="alert" className="text-failure">
            {error}
          </span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onLoadPatch}>
            Retry
          </Button>
          <ViewOnGitHub pullRequest={pullRequest} file={file} />
        </Notice>
      );
    } else {
      notice = (
        <Notice testId="file-patch-deferred">
          This file’s changes load on their own in a large pull request.
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onLoadPatch}>
            Load diff
          </Button>
        </Notice>
      );
    }
  } else if (patch?.outcome === "not-found") {
    notice = (
      <Notice testId="file-patch-not-found">
        GitHub no longer lists this file in the pull request —
        <ViewOnGitHub pullRequest={pullRequest} file={file} />
      </Notice>
    );
  } else {
    notice = (
      <Notice>
        Diff not available here —
        <ViewOnGitHub pullRequest={pullRequest} file={file} />
      </Notice>
    );
  }
  return (
    <>
      {notice}
      {/* A deferred file shows its conversations on their lines once its diff
          loads, or here if it cannot. */}
      {!(file.patchDeferred && !patch && !error) && (
        <ThreadsWithoutDiff pullRequest={pullRequest} threads={threads} canComment={canComment} />
      )}
    </>
  );
}

/** One changed file: a sticky header with the viewed toggle, then its diff. */
export function PullRequestFileSection({
  pullRequest,
  file,
  threads,
  expanded,
  selected,
  onToggle,
  onViewed,
  commitId,
  canComment,
  patchState,
  onLoadPatch,
}: {
  pullRequest: GitHubPullRequestRef;
  file: GitHubPullRequestFile;
  threads: GitHubPullRequestReviewThread[];
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  commitId: string;
  canComment: boolean;
  patchState: FilePatchState;
  onLoadPatch: () => void;
}) {
  const { icon: StatusIcon, className: statusClass } = FILE_STATUS_ICONS[file.status];
  const { directory, filename } = splitPath(file.path);
  const renamed = file.previousPath && file.previousPath !== file.path ? file.previousPath : null;
  const viewed = file.viewedState === "viewed";
  const openThreads = threads.filter((thread) => !thread.isResolved).length;
  const checkboxId = `viewed-${file.path}`;
  return (
    <section
      data-testid="pull-request-file"
      data-path={file.path}
      data-selected={selected || undefined}
      className="border-b border-border/50"
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-1.5 border-l-2 bg-background py-1 pr-2 pl-0.5",
          selected ? "border-l-primary" : "border-l-transparent",
          viewed && !expanded && "opacity-70",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
          title={renamed ? `${renamed} → ${file.path}` : file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <StatusIcon className={cn("size-4 shrink-0", statusClass)} aria-label={file.status} />
          <span className="flex min-w-0 flex-1 flex-col">
            <TruncatedPath
              className="text-xs"
              directory={directory}
              filename={filename}
              directoryClassName="text-muted-foreground"
              filenameClassName="text-foreground"
            />
            {renamed && (
              <span className="truncate text-[10px] text-muted-foreground">from {renamed}</span>
            )}
          </span>
          {threads.length > 0 && (
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5 text-[11px]",
                openThreads > 0 ? "text-amber-400" : "text-muted-foreground",
              )}
              title={`${pluralize(threads.length, "conversation")}, ${openThreads} unresolved`}
            >
              <MessageSquare className="size-3" />
              {threads.length}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
            <span className="text-success">+{file.additions}</span>
            <span className="text-failure">−{file.deletions}</span>
          </span>
        </button>
        <label
          htmlFor={checkboxId}
          title={
            file.viewedState === "dismissed" ? "Changed since you last viewed it" : "Mark as viewed"
          }
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <Checkbox
            id={checkboxId}
            checked={viewed}
            aria-label={`Viewed ${file.path}`}
            onCheckedChange={(checked) => onViewed(checked === true)}
            className="size-3.5"
          />
          Viewed
        </label>
      </div>
      {expanded && (
        <div className="overflow-x-auto border-t border-border/40">
          <FileBody
            pullRequest={pullRequest}
            file={file}
            threads={threads}
            commitId={commitId}
            canComment={canComment}
            patchState={patchState}
            onLoadPatch={onLoadPatch}
          />
        </div>
      )}
    </section>
  );
}
