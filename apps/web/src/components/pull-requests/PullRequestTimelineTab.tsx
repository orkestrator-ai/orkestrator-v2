import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MessageSquareDiff,
  Pencil,
  RotateCcw,
  Tag,
  Trash2,
  Upload,
  UserRound,
  Users,
  X,
  CircleDot,
} from "lucide-react";
import { toast } from "sonner";
import type {
  GitHubPullRequestComment,
  GitHubPullRequestRef,
  GitHubPullRequestReviewState,
  GitHubPullRequestTimeline,
  GitHubPullRequestTimelineItem,
} from "@orkestrator/protocol/github-pull-requests";
import { gitHubPullRequestUrl } from "@orkestrator/protocol/github-pull-requests";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { PullRequestCommentCard } from "./PullRequestCommentCard";
import { firstLine, pluralize, shortSha } from "./pull-request-format";
import {
  MarkdownBody,
  RelativeTime,
  UserAvatar,
  errorMessage,
  userLogin,
} from "./pull-request-shared";
import type { SortOrder } from "./PullRequestSummaryTab";

type CommitItem = Extract<GitHubPullRequestTimelineItem, { kind: "commit" }>;
type ReviewItem = Extract<GitHubPullRequestTimelineItem, { kind: "review" }>;
type EventItem = Extract<GitHubPullRequestTimelineItem, { kind: "event" }>;

type TimelineEntry =
  | { kind: "comments"; id: string; comments: GitHubPullRequestComment[] }
  | CommitItem
  | ReviewItem
  | EventItem;

/** Consecutive conversation comments collapse into one expandable group. */
export function groupTimeline(items: GitHubPullRequestTimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (item.kind === "comment") {
      const last = entries.at(-1);
      if (last?.kind === "comments") last.comments.push(item.comment);
      else entries.push({ kind: "comments", id: item.id, comments: [item.comment] });
    } else {
      entries.push(item);
    }
  }
  return entries;
}

function openExternal(url: string) {
  void openInBrowser(url).catch((error) =>
    toast.error(errorMessage(error, "Could not open the browser.")),
  );
}

const EVENT_TEXT: Record<string, (detail?: string) => string> = {
  opened: () => "opened this pull request",
  closed: () => "closed this",
  reopened: () => "reopened this",
  merged: (detail) => (detail ? `merged commit ${detail}` : "merged this"),
  "ready-for-review": () => "marked this ready for review",
  "converted-to-draft": () => "converted this to a draft",
  "head-ref-force-pushed": () => "force-pushed the head branch",
  "head-ref-deleted": () => "deleted the head branch",
  "base-ref-changed": (detail) =>
    detail ? `changed the base branch to ${detail}` : "changed the base branch",
  labeled: (detail) => `added label ${detail ?? ""}`.trim(),
  unlabeled: (detail) => `removed label ${detail ?? ""}`.trim(),
  "review-requested": (detail) =>
    detail ? `requested review from ${detail}` : "requested a review",
  "review-request-removed": (detail) =>
    detail ? `removed review request for ${detail}` : "removed a review request",
  assigned: (detail) => (detail ? `assigned ${detail}` : "assigned someone"),
  unassigned: (detail) => (detail ? `unassigned ${detail}` : "unassigned someone"),
  renamed: (detail) => (detail ? `renamed this to “${detail}”` : "renamed this"),
};

export function describeTimelineEvent(event: string, detail?: string): string {
  const describe = EVENT_TEXT[event];
  if (describe) return describe(detail);
  return detail || "updated this";
}

function eventIcon(event: string): ReactNode {
  const className = "size-3.5";
  switch (event) {
    case "opened":
      return <GitPullRequest className={cn(className, "text-success")} />;
    case "closed":
      return <GitPullRequestClosed className={cn(className, "text-failure")} />;
    case "reopened":
      return <RotateCcw className={cn(className, "text-success")} />;
    case "merged":
      return <GitMerge className={cn(className, "text-violet-400")} />;
    case "ready-for-review":
      return <Eye className={className} />;
    case "converted-to-draft":
      return <GitPullRequestDraft className={className} />;
    case "head-ref-force-pushed":
      return <Upload className={className} />;
    case "head-ref-deleted":
      return <Trash2 className={className} />;
    case "base-ref-changed":
      return <GitBranch className={className} />;
    case "labeled":
    case "unlabeled":
      return <Tag className={className} />;
    case "review-requested":
    case "review-request-removed":
      return <Users className={className} />;
    case "assigned":
    case "unassigned":
      return <UserRound className={className} />;
    case "renamed":
      return <Pencil className={className} />;
    default:
      return <CircleDot className={className} />;
  }
}

const REVIEW_TEXT: Record<GitHubPullRequestReviewState, string> = {
  approved: "approved these changes",
  "changes-requested": "requested changes",
  commented: "reviewed",
  dismissed: "left a dismissed review",
  pending: "started a review",
};

function reviewIcon(state: GitHubPullRequestReviewState): ReactNode {
  switch (state) {
    case "approved":
      return <CircleCheck className="size-3.5 text-success" />;
    case "changes-requested":
      return <MessageSquareDiff className="size-3.5 text-failure" />;
    case "dismissed":
      return <X className="size-3.5" />;
    default:
      return <Eye className="size-3.5" />;
  }
}

function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
      {children}
    </div>
  );
}

function CommentGroup({
  pullRequest,
  comments,
}: {
  pullRequest: GitHubPullRequestRef;
  comments: GitHubPullRequestComment[];
}) {
  const [open, setOpen] = useState(false);
  const authors = new Set(comments.map((comment) => userLogin(comment.author)));
  const latest = comments.at(-1)!;
  return (
    <li className="flex gap-3" data-testid="timeline-comments">
      <Rail>
        <UserAvatar user={comments[0]!.author} className="size-6" />
      </Rail>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 rounded-md py-1 text-left hover:bg-muted/30"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">
              {pluralize(comments.length, "comment")}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {pluralize(authors.size, "author")} · <RelativeTime value={latest.createdAt} />
            </span>
          </span>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        {open && (
          <div className="mt-1 space-y-2">
            {comments.map((comment) => (
              <PullRequestCommentCard
                key={comment.id}
                pullRequest={pullRequest}
                comment={comment}
              />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function CommitRow({ item }: { item: CommitItem }) {
  const content = (
    <>
      <span className="block truncate text-xs font-medium text-foreground" title={item.message}>
        {firstLine(item.message) || "(no message)"}
      </span>
      <span className="flex items-center gap-2 text-[11px]">
        <span className="font-mono text-muted-foreground">{shortSha(item.sha)}</span>
        <span className="truncate text-muted-foreground">
          {item.author?.login ?? item.authorName ?? "unknown"}
        </span>
        <RelativeTime value={item.createdAt} />
      </span>
    </>
  );
  return (
    <li className="flex gap-3" data-testid="timeline-commit">
      <Rail>
        <UserAvatar user={item.author} className="size-6" />
      </Rail>
      {item.htmlUrl ? (
        <button
          type="button"
          onClick={() => openExternal(item.htmlUrl!)}
          title="Open commit on GitHub"
          className="min-w-0 flex-1 rounded-md py-1 text-left hover:bg-muted/30"
        >
          {content}
        </button>
      ) : (
        <div className="min-w-0 flex-1 py-1">{content}</div>
      )}
    </li>
  );
}

function ReviewRow({ item }: { item: ReviewItem }) {
  return (
    <li className="flex gap-3" data-testid="timeline-review">
      <Rail>{reviewIcon(item.state)}</Rail>
      <div className="min-w-0 flex-1 space-y-1.5 py-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs">
          <UserAvatar user={item.author} className="size-4" />
          <span className="font-medium text-foreground">{userLogin(item.author)}</span>
          <span className="text-muted-foreground">{REVIEW_TEXT[item.state]}</span>
          <RelativeTime value={item.createdAt} className="text-[11px]" />
          {item.inlineCommentsCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <MessageSquare className="size-3" />
              {pluralize(item.inlineCommentsCount, "inline comment")}
            </span>
          )}
        </div>
        {item.body.trim() && (
          <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <MarkdownBody body={item.body} />
          </div>
        )}
      </div>
    </li>
  );
}

function EventRow({ item }: { item: EventItem }) {
  return (
    <li className="flex gap-3" data-testid="timeline-event">
      <Rail>{eventIcon(item.event)}</Rail>
      <div className="min-w-0 flex-1 py-1 text-xs">
        <span className="font-medium text-foreground">{userLogin(item.actor)}</span>{" "}
        <span className="text-muted-foreground">
          {describeTimelineEvent(item.event, item.detail)}
        </span>
        <div className="text-[11px]">
          <RelativeTime value={item.createdAt} />
        </div>
      </div>
    </li>
  );
}

export function PullRequestTimelineTab({
  pullRequest,
  timeline,
  order,
}: {
  pullRequest: GitHubPullRequestRef;
  timeline: GitHubPullRequestTimeline;
  order: SortOrder;
}) {
  const entries = useMemo(() => {
    const grouped = groupTimeline(timeline.items);
    return order === "newest" ? grouped.reverse() : grouped;
  }, [order, timeline.items]);

  if (entries.length === 0) {
    return <p className="py-6 text-center text-xs text-muted-foreground">No activity yet.</p>;
  }

  const truncatedNotice = timeline.truncated && (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Only part of the timeline is shown.{" "}
      <button
        type="button"
        className="text-primary hover:underline"
        onClick={() => openExternal(gitHubPullRequestUrl(pullRequest))}
      >
        View the full history on GitHub
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      {order === "newest" && truncatedNotice}
      <ol
        data-testid="pull-request-timeline"
        className="relative space-y-3 before:absolute before:top-3 before:bottom-3 before:left-[13px] before:w-px before:bg-border"
      >
        {entries.map((entry) => {
          switch (entry.kind) {
            case "comments":
              return (
                <CommentGroup key={entry.id} pullRequest={pullRequest} comments={entry.comments} />
              );
            case "commit":
              return <CommitRow key={entry.id} item={entry} />;
            case "review":
              return <ReviewRow key={entry.id} item={entry} />;
            case "event":
              return <EventRow key={entry.id} item={entry} />;
          }
        })}
      </ol>
      {order === "oldest" && truncatedNotice}
    </div>
  );
}
