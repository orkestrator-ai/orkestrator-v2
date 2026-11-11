import { GitPullRequest, Hammer, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openPullRequestUrl, usePullRequestOpener } from "@/lib/pull-request-opener";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { KanbanComment, KanbanTask } from "@/stores/kanbanStore";

/**
 * The comments and activity of a ticket: what people wrote and what its
 * builds recorded (started, validated, PR raised, merged), oldest first, with
 * the box to add one at the end.
 */
export function TicketComments({
  comments,
  commentText,
  onCommentTextChange,
  onAdd,
  onDelete,
  renderText,
}: {
  comments: readonly KanbanComment[];
  commentText: string;
  onCommentTextChange: (text: string) => void;
  onAdd: () => void;
  onDelete: (commentId: string) => void;
  renderText: (text: string) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No comments yet</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {comments.map((comment) => (
            <li key={comment.id} className="group/comment rounded-md bg-muted/40 p-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 whitespace-pre-wrap break-words text-foreground">
                  {renderText(comment.text)}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/comment:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                  onClick={() => onDelete(comment.id)}
                  aria-label="Delete comment"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              <span className="mt-1 block text-[10px] text-muted-foreground">
                {new Date(comment.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={commentText}
          onChange={(event) => onCommentTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder="Add a comment..."
          aria-label="Add a comment"
          className="flex-1"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={onAdd}
          disabled={!commentText.trim()}
          aria-label="Add comment"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

const PR_STATE_LABELS: Record<string, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

/** The pull request and build linked to a ticket, wherever they ran. */
export function ticketLinkedPullRequest(
  task: Pick<KanbanTask, "prUrl" | "prState" | "sync">,
  environment: { prUrl?: string | null; prState?: string | null } | undefined,
): { url: string; state?: string } | null {
  const url = environment?.prUrl ?? task.prUrl ?? task.sync?.work?.prUrl;
  if (!url) return null;
  const state = environment?.prUrl
    ? (environment.prState ?? undefined)
    : task.prUrl
      ? task.prState
      : task.sync?.work?.prState;
  return { url, ...(state ? { state } : {}) };
}

export function TicketLinkedWork({
  task,
  pullRequest,
  pipeline,
}: {
  task: Pick<KanbanTask, "sync">;
  pullRequest: { url: string; state?: string } | null;
  pipeline: BuildPipeline | undefined;
}) {
  const opener = usePullRequestOpener();
  const number = pullRequest?.url.match(/\/pull\/(\d+)/)?.[1];
  const remote = task.sync?.work;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {pullRequest ? (
        <div className="flex flex-wrap items-center gap-2">
          <GitPullRequest aria-hidden className="size-4 text-muted-foreground" />
          <button
            type="button"
            className="text-blue-400 hover:underline"
            onClick={(event) =>
              void openPullRequestUrl(pullRequest.url, {
                external: event.metaKey || event.ctrlKey,
                opener,
              }).catch(() => toast.error("Could not open the pull request"))
            }
          >
            {number ? `Pull request #${number}` : pullRequest.url}
          </button>
          {pullRequest.state ? (
            <span
              data-testid="ticket-linked-pr-state"
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {PR_STATE_LABELS[pullRequest.state] ?? pullRequest.state}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">No pull request yet</p>
      )}
      {pipeline ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Hammer aria-hidden className="size-3.5" />
          Build {pipeline.phase}
        </p>
      ) : remote?.buildPipelineId ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Hammer aria-hidden className="size-3.5" />
          Built on {remote.nodeName ?? "another machine"}
        </p>
      ) : null}
    </div>
  );
}
