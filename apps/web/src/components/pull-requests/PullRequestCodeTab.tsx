import { useMemo, useState, type ComponentType } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  MessageSquare,
  SquareArrowRight,
  SquareDot,
  SquareMinus,
  SquarePlus,
  SquareSlash,
} from "lucide-react";
import { toast } from "sonner";
import type { ChangeFileStatus } from "@orkestrator/protocol/change-resources";
import {
  gitHubPullRequestUrl,
  type GitHubPullRequestFile,
  type GitHubPullRequestFiles,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TruncatedPath } from "@/components/ui/truncated-path";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { PullRequestDiff } from "./PullRequestDiff";
import { pluralize, splitPath } from "./pull-request-format";
import { errorMessage } from "./pull-request-shared";

/** Above this many files every file starts collapsed. */
export const AUTO_EXPAND_FILE_LIMIT = 20;

const STATUS_ICONS: Record<
  ChangeFileStatus,
  { icon: ComponentType<{ className?: string }>; className: string }
> = {
  added: { icon: SquarePlus, className: "text-success" },
  modified: { icon: SquareDot, className: "text-amber-400" },
  deleted: { icon: SquareMinus, className: "text-failure" },
  renamed: { icon: SquareArrowRight, className: "text-sky-400" },
  copied: { icon: SquareArrowRight, className: "text-sky-400" },
  "mode-changed": { icon: SquareSlash, className: "text-muted-foreground" },
  "type-changed": { icon: SquareSlash, className: "text-muted-foreground" },
  unknown: { icon: SquareDot, className: "text-muted-foreground" },
};

function openExternal(url: string) {
  void openInBrowser(url).catch((error) =>
    toast.error(errorMessage(error, "Could not open the browser.")),
  );
}

function initialExpanded(files: GitHubPullRequestFile[]): Set<string> {
  if (files.length > AUTO_EXPAND_FILE_LIMIT) return new Set();
  return new Set(files.filter((file) => file.viewedState !== "viewed").map((file) => file.path));
}

function FileRow({
  pullRequest,
  file,
  threads,
  expanded,
  onToggle,
  onViewed,
  commitId,
  canComment,
}: {
  pullRequest: GitHubPullRequestRef;
  file: GitHubPullRequestFile;
  threads: GitHubPullRequestReviewThread[];
  expanded: boolean;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  commitId: string;
  canComment: boolean;
}) {
  const { icon: StatusIcon, className: statusClass } = STATUS_ICONS[file.status];
  const { directory, filename } = splitPath(file.path);
  const renamed = file.previousPath && file.previousPath !== file.path ? file.previousPath : null;
  const viewed = file.viewedState === "viewed";
  const openThreads = threads.filter((thread) => !thread.isResolved).length;
  const checkboxId = `viewed-${file.path}`;
  return (
    <section
      data-testid="pull-request-file"
      data-path={file.path}
      className="border-b border-border/50"
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-1.5 bg-background py-1 pr-2 pl-1",
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
              className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
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
          {file.patchAvailable ? (
            <PullRequestDiff
              pullRequest={pullRequest}
              file={file}
              threads={threads}
              commitId={commitId}
              canComment={canComment}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              Diff not available here —
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                onClick={() =>
                  openExternal(file.blobUrl ?? `${gitHubPullRequestUrl(pullRequest)}/files`)
                }
              >
                View on GitHub
                <ExternalLink className="size-3" />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function PullRequestCodeTab({
  pullRequest,
  files,
  canComment,
}: {
  pullRequest: GitHubPullRequestRef;
  files: GitHubPullRequestFiles;
  canComment: boolean;
}) {
  const setFileViewed = usePullRequestsStore((state) => state.setFileViewed);
  const [expanded, setExpanded] = useState(() => initialExpanded(files.files));
  const threadsByPath = useMemo(() => {
    const map = new Map<string, GitHubPullRequestReviewThread[]>();
    for (const thread of files.threads) {
      map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);
    }
    return map;
  }, [files.threads]);
  const viewedCount = files.files.filter((file) => file.viewedState === "viewed").length;

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const markViewed = (path: string, viewed: boolean) => {
    // Like GitHub, marking a file viewed folds it away.
    if (viewed) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
    void setFileViewed(pullRequest, path, viewed).catch((error) => {
      toast.error(errorMessage(error, "Could not update the viewed state."));
    });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
        <span>{pluralize(files.files.length, "file")}</span>
        <span>·</span>
        <span data-testid="viewed-count">
          {viewedCount} / {files.files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="Expand all files"
            title="Expand all"
            onClick={() => setExpanded(new Set(files.files.map((file) => file.path)))}
          >
            <ChevronsUpDown className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="Collapse all files"
            title="Collapse all"
            onClick={() => setExpanded(new Set())}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
        </div>
      </div>
      {files.truncated && (
        <div
          role="note"
          className="border-b border-border/60 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
        >
          GitHub only lists the first {files.files.length.toLocaleString()} files of this pull
          request.{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => openExternal(`${gitHubPullRequestUrl(pullRequest)}/files`)}
          >
            View all on GitHub
          </button>
        </div>
      )}
      {files.files.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">No changed files.</p>
      ) : (
        <div>
          {files.files.map((file) => (
            <FileRow
              key={file.path}
              pullRequest={pullRequest}
              file={file}
              threads={threadsByPath.get(file.path) ?? []}
              expanded={expanded.has(file.path)}
              onToggle={() => toggle(file.path)}
              onViewed={(viewed) => markViewed(file.path, viewed)}
              commitId={files.headSha}
              canComment={canComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
