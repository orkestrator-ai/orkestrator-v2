import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  ExternalLink,
  Loader2,
  MessageSquare,
  MessageSquareDiff,
  Tag,
  Tags,
  UserRoundPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckConclusion,
  GitHubPullRequestDetail,
  GitHubPullRequestLabel,
  GitHubPullRequestRef,
  GitHubPullRequestReviewEvent,
  GitHubPullRequestReviewer,
  GitHubRepositoryMemberOption,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import {
  listGitHubRepositoryAssignableUsers,
  listGitHubRepositoryLabels,
  openInBrowser,
} from "@/lib/backend";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { PullRequestCommentCard } from "./PullRequestCommentCard";
import { labelChipStyle } from "./pull-request-format";
import { CommentComposer, MarkdownBody, UserAvatar, errorMessage } from "./pull-request-shared";

export type SortOrder = "newest" | "oldest";

function openExternal(url: string) {
  void openInBrowser(url).catch((error) =>
    toast.error(errorMessage(error, "Could not open the browser.")),
  );
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-start gap-2 text-xs">
      <div className="flex w-24 shrink-0 items-center gap-1.5 pt-1 text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pt-0.5">{children}</div>
    </div>
  );
}

const REVIEW_STATE_META: Record<
  NonNullable<GitHubPullRequestReviewer["state"]> | "requested",
  { label: string; icon: ReactNode }
> = {
  approved: { label: "approved", icon: <Check className="size-3 text-success" /> },
  "changes-requested": {
    label: "requested changes",
    icon: <MessageSquareDiff className="size-3 text-failure" />,
  },
  commented: {
    label: "commented",
    icon: <MessageSquare className="size-3 text-muted-foreground" />,
  },
  dismissed: { label: "review dismissed", icon: <X className="size-3 text-muted-foreground" /> },
  pending: {
    label: "review pending",
    icon: <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />,
  },
  requested: {
    label: "review requested",
    icon: <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />,
  },
};

function reviewerMeta(reviewer: GitHubPullRequestReviewer) {
  // An outstanding re-request outranks an older submitted review.
  return REVIEW_STATE_META[reviewer.requested ? "requested" : (reviewer.state ?? "requested")];
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="p-1 pb-1.5">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Keep Radix typeahead from stealing keystrokes; Escape still closes.
          if (event.key !== "Escape") event.stopPropagation();
        }}
        className="h-7 w-full rounded-md border border-border/70 bg-input-surface px-2 text-xs placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
      />
    </div>
  );
}

function useLazyOptions<T>(loader: () => Promise<T[]>) {
  const [options, setOptions] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (loading || options) return;
    setLoading(true);
    setError(null);
    try {
      setOptions(await loader());
    } catch (loadError) {
      setError(errorMessage(loadError, "Could not load options."));
    } finally {
      setLoading(false);
    }
  };
  return { options, loading, error, load };
}

function ReviewersRow({
  pullRequest,
  detail,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail;
}) {
  const setReviewers = usePullRequestsStore((state) => state.setReviewers);
  const busy = usePullRequestsStore((state) =>
    Array.from(state.mutations).some((key) => key.startsWith("reviewers:")),
  );
  const [search, setSearch] = useState("");
  const users = useLazyOptions<GitHubRepositoryMemberOption>(() =>
    listGitHubRepositoryAssignableUsers({ owner: pullRequest.owner, repo: pullRequest.repo }),
  );
  const requested = new Set(
    detail.reviewers
      .filter((reviewer) => reviewer.kind === "user" && reviewer.requested)
      .map((reviewer) => reviewer.login.toLowerCase()),
  );
  const author = detail.author?.login.toLowerCase();
  const filtered = (users.options ?? []).filter(
    (user) =>
      user.login.toLowerCase() !== author &&
      user.login.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = async (login: string) => {
    const isRequested = requested.has(login.toLowerCase());
    try {
      await setReviewers(pullRequest, {
        add: isRequested ? [] : [login],
        remove: isRequested ? [login] : [],
      });
    } catch (error) {
      toast.error(errorMessage(error, "Could not update reviewers."));
    }
  };

  return (
    <MetaRow icon={<Users className="size-3.5" />} label="Reviewers">
      {detail.reviewers.length === 0 && <span className="text-muted-foreground">None</span>}
      {detail.reviewers.map((reviewer) => {
        const meta = reviewerMeta(reviewer);
        return (
          <span
            key={`${reviewer.kind}:${reviewer.login}`}
            data-testid="pull-request-reviewer"
            title={`${reviewer.login}: ${meta.label}`}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/40 py-0.5 pr-2 pl-0.5"
          >
            {reviewer.kind === "team" ? (
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted">
                <Users className="size-2.5 text-muted-foreground" />
              </span>
            ) : (
              <UserAvatar user={reviewer} className="size-4" />
            )}
            <span className="truncate text-foreground">{reviewer.login}</span>
            <span className="inline-flex items-center" aria-label={meta.label}>
              {meta.icon}
            </span>
          </span>
        );
      })}
      {detail.viewerPermissions.canWrite && detail.state === "open" && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) void users.load();
            else setSearch("");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Edit reviewers"
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <UserRoundPlus className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <SearchInput value={search} onChange={setSearch} placeholder="Request a review" />
            {users.loading && (
              <DropdownMenuItem disabled className="text-xs">
                <Loader2 className="animate-spin" /> Loading people…
              </DropdownMenuItem>
            )}
            {users.error && (
              <DropdownMenuItem disabled className="text-xs text-destructive">
                {users.error}
              </DropdownMenuItem>
            )}
            {users.options && filtered.length === 0 && (
              <DropdownMenuItem disabled className="text-xs">
                No matching people
              </DropdownMenuItem>
            )}
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((user) => (
                <DropdownMenuCheckboxItem
                  key={user.login}
                  checked={requested.has(user.login.toLowerCase())}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => void toggle(user.login)}
                  disabled={busy}
                  className="text-xs"
                >
                  <UserAvatar user={user} className="size-4" />
                  <span className="truncate">{user.login}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </MetaRow>
  );
}

export function LabelChip({ label }: { label: GitHubPullRequestLabel }) {
  return (
    <span
      title={label.description || label.name}
      style={labelChipStyle(label.color)}
      className="inline-flex max-w-full items-center truncate rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] leading-4 text-foreground"
    >
      {label.name}
    </span>
  );
}

function LabelsRow({
  pullRequest,
  detail,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail;
}) {
  const changeLabel = usePullRequestsStore((state) => state.changeLabel);
  const busy = usePullRequestsStore((state) =>
    Array.from(state.mutations).some((key) => key.startsWith("labels:")),
  );
  const [search, setSearch] = useState("");
  const labels = useLazyOptions<GitHubPullRequestLabel>(() =>
    listGitHubRepositoryLabels({ owner: pullRequest.owner, repo: pullRequest.repo }),
  );
  const current = new Set(detail.labels.map((label) => label.name));
  const filtered = (labels.options ?? []).filter((label) =>
    label.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = async (name: string) => {
    try {
      await changeLabel(pullRequest, name, !current.has(name));
    } catch (error) {
      toast.error(errorMessage(error, "Could not update labels."));
    }
  };

  return (
    <MetaRow icon={<Tag className="size-3.5" />} label="Labels">
      {detail.labels.length === 0 && <span className="text-muted-foreground">None</span>}
      {detail.labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
      {detail.viewerPermissions.canWrite && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) void labels.load();
            else setSearch("");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Edit labels"
              disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Tags className="size-3.5" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <SearchInput value={search} onChange={setSearch} placeholder="Filter labels" />
            {labels.loading && (
              <DropdownMenuItem disabled className="text-xs">
                <Loader2 className="animate-spin" /> Loading labels…
              </DropdownMenuItem>
            )}
            {labels.error && (
              <DropdownMenuItem disabled className="text-xs text-destructive">
                {labels.error}
              </DropdownMenuItem>
            )}
            {labels.options && filtered.length === 0 && (
              <DropdownMenuItem disabled className="text-xs">
                No matching labels
              </DropdownMenuItem>
            )}
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((label) => (
                <DropdownMenuCheckboxItem
                  key={label.name}
                  checked={current.has(label.name)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => void toggle(label.name)}
                  disabled={busy}
                  className="text-xs"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full border border-border"
                    style={label.color ? { backgroundColor: `#${label.color}` } : undefined}
                    aria-hidden
                  />
                  <span className="truncate">{label.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </MetaRow>
  );
}

function SectionToggle({
  open,
  title,
  extra,
}: {
  open: boolean;
  title: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <CollapsibleTrigger className="flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
        {title}
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </CollapsibleTrigger>
      {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
    </div>
  );
}

export function CheckConclusionIcon({
  conclusion,
  className,
}: {
  conclusion: GitHubPullRequestCheckConclusion;
  className?: string;
}) {
  const base = cn("size-3.5 shrink-0", className);
  switch (conclusion) {
    case "success":
      return <CircleCheck className={cn(base, "text-success")} aria-label="Passed" />;
    case "failure":
    case "timed-out":
    case "action-required":
    case "cancelled":
      return <CircleX className={cn(base, "text-failure")} aria-label="Failed" />;
    case "pending":
      return <CircleDot className={cn(base, "text-amber-400")} aria-label="Pending" />;
    case "skipped":
    case "neutral":
    case "stale":
      return <CircleMinus className={cn(base, "text-muted-foreground")} aria-label="Skipped" />;
  }
}

function CheckRow({ check }: { check: GitHubPullRequestCheck }) {
  return (
    <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/40">
      <CheckConclusionIcon conclusion={check.conclusion} />
      <span className="min-w-0 flex-1 truncate" title={check.summary || check.name}>
        <span className="text-foreground">{check.name}</span>
        {check.context && check.context !== check.name && (
          <span className="text-muted-foreground"> · {check.context}</span>
        )}
      </span>
      {check.detailsUrl && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={`Open details for ${check.name}`}
          onClick={() => openExternal(check.detailsUrl!)}
        >
          <ExternalLink className="size-3" />
        </Button>
      )}
    </li>
  );
}

const CHECK_ORDER: Record<GitHubPullRequestCheckConclusion, number> = {
  failure: 0,
  "timed-out": 0,
  "action-required": 0,
  cancelled: 1,
  pending: 2,
  success: 3,
  neutral: 4,
  skipped: 4,
  stale: 4,
};

const REVIEW_OPTIONS: { value: GitHubPullRequestReviewEvent; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

export function ReviewDialog({
  pullRequest,
  detail,
  open,
  onOpenChange,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submitReview = usePullRequestsStore((state) => state.submitReview);
  const options = detail.viewerPermissions.isAuthor
    ? REVIEW_OPTIONS.filter((option) => option.value === "COMMENT")
    : REVIEW_OPTIONS;
  const [event, setEvent] = useState<GitHubPullRequestReviewEvent>("COMMENT");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit review</DialogTitle>
          <DialogDescription>
            Review #{pullRequest.number} at {detail.headSha.slice(0, 7)}.
            {detail.viewerPermissions.isAuthor &&
              " You authored this pull request, so you can only comment."}
          </DialogDescription>
        </DialogHeader>
        {options.length > 1 && (
          <SegmentedSelector
            ariaLabel="Review type"
            value={event}
            options={options}
            onValueChange={setEvent}
            buttonClassName="h-7 px-2.5 text-xs"
          />
        )}
        <CommentComposer
          autoFocus
          placeholder={event === "APPROVE" ? "Optional comment" : "Leave a review comment"}
          ariaLabel="Review body"
          submitLabel={REVIEW_OPTIONS.find((option) => option.value === event)?.label ?? "Submit"}
          allowEmpty={event === "APPROVE"}
          onSubmit={async (body) => {
            await submitReview(pullRequest, { event, body, commitId: detail.headSha });
            onOpenChange(false);
            toast.success("Review submitted");
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function PullRequestSummaryTab({
  pullRequest,
  detail,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail;
}) {
  const addComment = usePullRequestsStore((state) => state.addComment);
  const [descriptionOpen, setDescriptionOpen] = useState(true);
  const hasProblem = detail.checks.some((check) => CHECK_ORDER[check.conclusion] <= 2);
  const [checksOpen, setChecksOpen] = useState(hasProblem);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [order, setOrder] = useState<SortOrder>("newest");
  const [reviewOpen, setReviewOpen] = useState(false);
  const checks = useMemo(
    () =>
      [...detail.checks].sort(
        (left, right) =>
          CHECK_ORDER[left.conclusion] - CHECK_ORDER[right.conclusion] ||
          left.name.localeCompare(right.name),
      ),
    [detail.checks],
  );
  const comments = useMemo(
    () => (order === "newest" ? [...detail.comments].reverse() : detail.comments),
    [detail.comments, order],
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <ReviewersRow pullRequest={pullRequest} detail={detail} />
        <LabelsRow pullRequest={pullRequest} detail={detail} />
      </div>

      <Collapsible open={descriptionOpen} onOpenChange={setDescriptionOpen} className="space-y-2">
        <SectionToggle open={descriptionOpen} title="Description" />
        <CollapsibleContent>
          {detail.body.trim() ? (
            <MarkdownBody body={detail.body} />
          ) : (
            <p className="text-xs italic text-muted-foreground">No description provided.</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={checksOpen} onOpenChange={setChecksOpen} className="space-y-1">
        <SectionToggle
          open={checksOpen}
          title={`Checks${checks.length ? ` (${checks.length})` : ""}`}
        />
        <CollapsibleContent>
          {checks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No checks reported for the head commit.</p>
          ) : (
            <ul className="space-y-0.5" data-testid="pull-request-checks">
              {checks.map((check, index) => (
                <CheckRow key={`${check.name}:${check.context ?? ""}:${index}`} check={check} />
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={commentsOpen} onOpenChange={setCommentsOpen} className="space-y-2">
        <SectionToggle
          open={commentsOpen}
          title={`Comments (${detail.comments.length})`}
          extra={
            detail.comments.length > 1 && (
              <button
                type="button"
                onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowUpDown className="size-3" />
                {order === "newest"
                  ? "Loaded comments: newest first"
                  : "Loaded comments: oldest first"}
              </button>
            )
          }
        />
        <CollapsibleContent className="space-y-2">
          {detail.commentsTruncated && (
            <p className="text-xs text-muted-foreground">
              Showing the first {detail.comments.length} comments. Newer comments are omitted.{" "}
              <a href={detail.htmlUrl} target="_blank" rel="noreferrer" className="underline">
                Read the full conversation on GitHub
              </a>
              .
            </p>
          )}
          {comments.length === 0 && (
            <p className="text-xs text-muted-foreground">No comments yet.</p>
          )}
          {comments.map((comment) => (
            <PullRequestCommentCard key={comment.id} pullRequest={pullRequest} comment={comment} />
          ))}
        </CollapsibleContent>
      </Collapsible>

      <div className="rounded-lg border border-border/60 bg-card/30 p-2">
        <CommentComposer
          ariaLabel="New comment"
          extraActions={
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setReviewOpen(true)}
            >
              <CircleDashed className="size-3.5" />
              Review…
            </Button>
          }
          onSubmit={async (body) => {
            await addComment(pullRequest, body);
          }}
        />
      </div>
      <ReviewDialog
        pullRequest={pullRequest}
        detail={detail}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
      />
    </div>
  );
}
