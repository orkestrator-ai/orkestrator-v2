import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Reply, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { pluralize } from "./pull-request-format";
import {
  CommentComposer,
  MarkdownBody,
  RelativeTime,
  UserAvatar,
  errorMessage,
  userLogin,
} from "./pull-request-shared";

/** An inline review conversation: comments, reply box and resolve toggle. */
export function PullRequestReviewThread({
  pullRequest,
  thread,
  canReply,
}: {
  pullRequest: GitHubPullRequestRef;
  thread: GitHubPullRequestReviewThread;
  canReply: boolean;
}) {
  const replyToThread = usePullRequestsStore((state) => state.replyToThread);
  const setThreadResolved = usePullRequestsStore((state) => state.setThreadResolved);
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const first = thread.comments[0];

  const toggleResolved = async () => {
    setResolving(true);
    try {
      await setThreadResolved(pullRequest, thread.id, !thread.isResolved);
      if (!thread.isResolved) setExpanded(false);
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the conversation."));
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      data-testid="review-thread"
      data-thread-id={thread.id}
      data-resolved={thread.isResolved || undefined}
      className={cn(
        "rounded-lg border bg-card/60 font-sans text-sm",
        thread.isResolved ? "border-border/50" : "border-border",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          {thread.isResolved && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
          <span className="truncate">
            {thread.isResolved ? "Resolved conversation" : "Conversation"} ·{" "}
            {pluralize(thread.comments.length, "comment")}
            {!expanded && first && ` · ${userLogin(first.author)}`}
          </span>
        </button>
        {thread.viewerCanResolve && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => void toggleResolved()}
            disabled={resolving}
          >
            {resolving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : thread.isResolved ? (
              <RotateCcw className="size-3" />
            ) : (
              <CheckCircle2 className="size-3" />
            )}
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-border/50 px-2.5 py-2">
          {thread.comments.map((comment) => (
            <div key={comment.id} className="space-y-1" data-testid="review-thread-comment">
              <div className="flex items-center gap-1.5 text-xs">
                <UserAvatar user={comment.author} className="size-4" />
                <span className="font-medium text-foreground">{userLogin(comment.author)}</span>
                <RelativeTime value={comment.createdAt} className="text-[11px]" />
              </div>
              <MarkdownBody body={comment.body} className="pl-5.5" />
            </div>
          ))}
          {canReply &&
            (replying ? (
              <CommentComposer
                autoFocus
                placeholder="Reply…"
                ariaLabel="Reply to conversation"
                submitLabel="Reply"
                onCancel={() => setReplying(false)}
                onSubmit={async (body) => {
                  await replyToThread(pullRequest, thread.id, body);
                  setReplying(false);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="flex w-full items-center gap-1.5 rounded-md border border-border/60 bg-input-surface px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <Reply className="size-3" />
                Reply…
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
