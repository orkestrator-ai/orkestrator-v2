import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { GitHubPullRequestState } from "@orkestrator/protocol/github-pull-requests";
import { cn } from "@/lib/utils";

export interface PullRequestStateIconProps {
  state: GitHubPullRequestState;
  isDraft: boolean;
  className?: string;
}

export function pullRequestStateLabel(state: GitHubPullRequestState, isDraft: boolean): string {
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  return isDraft ? "Draft" : "Open";
}

/** Text colour per state: open green, draft grey, merged violet, closed red. */
export function pullRequestStateColor(state: GitHubPullRequestState, isDraft: boolean): string {
  if (state === "merged") return "text-violet-400";
  if (state === "closed") return "text-failure";
  return isDraft ? "text-muted-foreground" : "text-success";
}

/** Small state icon for list rows and hosts' tab labels. */
export function PullRequestStateIcon({ state, isDraft, className }: PullRequestStateIconProps) {
  const Icon =
    state === "merged"
      ? GitMerge
      : state === "closed"
        ? GitPullRequestClosed
        : isDraft
          ? GitPullRequestDraft
          : GitPullRequest;
  const label = pullRequestStateLabel(state, isDraft);
  return (
    <Icon
      role="img"
      aria-label={label}
      data-state={isDraft && state === "open" ? "draft" : state}
      className={cn("size-4 shrink-0", pullRequestStateColor(state, isDraft), className)}
    />
  );
}

/** Pill badge with icon and state name. */
export function PullRequestStateBadge({ state, isDraft, className }: PullRequestStateIconProps) {
  const label = pullRequestStateLabel(state, isDraft);
  return (
    <span
      data-testid="pull-request-state-badge"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        state === "merged" && "border-violet-400/40 bg-violet-400/10 text-violet-300",
        state === "closed" && "border-failure/40 bg-failure/10 text-failure",
        state === "open" && !isDraft && "border-success/40 bg-success/10 text-success",
        state === "open" && isDraft && "border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      <PullRequestStateIcon state={state} isDraft={isDraft} className="size-3 text-current" />
      {label}
    </span>
  );
}
