import { useState } from "react";
import { ExternalLink, Pencil } from "lucide-react";
import { toast } from "sonner";
import type {
  GitHubPullRequestComment,
  GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import {
  CommentComposer,
  MarkdownBody,
  RelativeTime,
  UserAvatar,
  errorMessage,
  userLogin,
} from "./pull-request-shared";

/** One conversation comment, editable inline when the viewer may edit it. */
export function PullRequestCommentCard({
  pullRequest,
  comment,
  className,
}: {
  pullRequest: GitHubPullRequestRef;
  comment: GitHubPullRequestComment;
  className?: string;
}) {
  const editComment = usePullRequestsStore((state) => state.editComment);
  const [editing, setEditing] = useState(false);
  return (
    <article
      data-testid="pull-request-comment"
      className={cn("rounded-lg border border-border/60 bg-card/40", className)}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs">
        <UserAvatar user={comment.author} />
        <span className="truncate font-medium text-foreground">{userLogin(comment.author)}</span>
        <RelativeTime value={comment.createdAt} />
        {comment.isEdited && <span className="text-muted-foreground">(edited)</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {comment.canEdit && !editing && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Edit comment"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3" />
            </Button>
          )}
          {comment.htmlUrl && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Open comment on GitHub"
              onClick={() =>
                void openInBrowser(comment.htmlUrl).catch((error) =>
                  toast.error(errorMessage(error, "Could not open the browser.")),
                )
              }
            >
              <ExternalLink className="size-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        {editing ? (
          <CommentComposer
            initialValue={comment.body}
            submitLabel="Save"
            ariaLabel="Edit comment"
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              await editComment(pullRequest, comment.id, body);
              setEditing(false);
              toast.success("Comment updated");
            }}
          />
        ) : (
          <MarkdownBody body={comment.body} />
        )}
      </div>
    </article>
  );
}
