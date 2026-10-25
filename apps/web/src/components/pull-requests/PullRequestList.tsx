import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquare, RefreshCw, Search } from "lucide-react";
import type {
  GitHubPullRequestChecksState,
  GitHubPullRequestListFilter,
  GitHubPullRequestListItem,
  GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { usePullRequestList } from "@/hooks/usePullRequestData";
import { cn } from "@/lib/utils";
import { LabelChip, CheckConclusionIcon } from "./PullRequestSummaryTab";
import { PullRequestStateIcon } from "./PullRequestStateIcon";
import { checksStateLabel } from "./pull-request-format";
import { ErrorNotice, RelativeTime, SkeletonLines, userLogin } from "./pull-request-shared";

export interface PullRequestListProps {
  projectId: string;
  layout: "sidebar" | "page";
  onOpenPullRequest: (ref: GitHubPullRequestRef) => void;
  /** Highlight (e.g. the current environment's PR) and pin it at the top. */
  highlightNumber?: number;
  active?: boolean;
  className?: string;
}

export const PULL_REQUEST_SEARCH_DEBOUNCE_MS = 300;

const FILTER_OPTIONS: { value: GitHubPullRequestListFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "mine", label: "Mine" },
  { value: "review-requested", label: "Review requested" },
  { value: "closed", label: "Closed" },
];

const EMPTY_TEXT: Record<GitHubPullRequestListFilter, string> = {
  open: "No open pull requests.",
  mine: "You haven't opened any pull requests here.",
  "review-requested": "No pull requests are waiting for your review.",
  closed: "No closed pull requests.",
};

function ChecksIcon({ state }: { state: GitHubPullRequestChecksState }) {
  const conclusion =
    state === "success"
      ? "success"
      : state === "failure"
        ? "failure"
        : state === "pending"
          ? "pending"
          : state === "neutral"
            ? "neutral"
            : null;
  if (!conclusion) return null;
  return (
    <span title={checksStateLabel(state)} className="inline-flex">
      <CheckConclusionIcon conclusion={conclusion} />
    </span>
  );
}

function PullRequestRow({
  item,
  layout,
  highlighted,
  onOpen,
}: {
  item: GitHubPullRequestListItem;
  layout: "sidebar" | "page";
  highlighted: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="pull-request-row"
        data-number={item.number}
        aria-current={highlighted ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
          highlighted && "bg-selected/50 ring-1 ring-selected-edge",
        )}
      >
        <PullRequestStateIcon state={item.state} isDraft={item.isDraft} className="mt-0.5" />
        <span className="min-w-0 flex-1 space-y-0.5">
          {highlighted && (
            <span className="block text-[10px] font-medium tracking-wide text-primary uppercase">
              This environment
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-foreground">{item.title}</span>
            {item.isDraft && (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                Draft
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">#{item.number}</span>
            <span>·</span>
            <span className="truncate">{userLogin(item.author)}</span>
            <span>·</span>
            <RelativeTime value={item.updatedAt} />
            {layout === "page" && (
              <span className="truncate font-mono" title={`${item.headRef} → ${item.baseRef}`}>
                · {item.headRef} → {item.baseRef}
              </span>
            )}
            {item.labels.slice(0, layout === "page" ? 4 : 2).map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </span>
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {item.checksState && <ChecksIcon state={item.checksState} />}
          {item.commentsCount > 0 && (
            <span className="flex items-center gap-0.5" title="Comments">
              <MessageSquare className="size-3" />
              {item.commentsCount}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export function PullRequestList({
  projectId,
  layout,
  onOpenPullRequest,
  highlightNumber,
  active = true,
  className,
}: PullRequestListProps) {
  const [filter, setFilter] = useState<GitHubPullRequestListFilter>("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), PULL_REQUEST_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const { list, loading, error, reload } = usePullRequestList(projectId, filter, query, active);

  const rows = useMemo(() => {
    const items = list?.pullRequests ?? [];
    if (highlightNumber === undefined) return items;
    const pinned = items.find((item) => item.number === highlightNumber);
    return pinned ? [pinned, ...items.filter((item) => item !== pinned)] : items;
  }, [highlightNumber, list?.pullRequests]);

  const open = (item: GitHubPullRequestListItem) => {
    if (!list) return;
    onOpenPullRequest({
      owner: list.repository.owner,
      repo: list.repository.repo,
      number: item.number,
    });
  };

  const pageWidth = layout === "page" ? "mx-auto w-full max-w-5xl" : "w-full";

  return (
    <div
      data-testid="pull-request-list"
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <div className="shrink-0 border-b border-border/60">
        <div className={cn("space-y-2 px-3 py-2", pageWidth)}>
          <SegmentedSelector
            ariaLabel="Pull request filter"
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={setFilter}
            className="flex w-full"
            buttonClassName="h-7 flex-1 px-2 text-xs"
          />
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search pull requests"
                aria-label="Search pull requests"
                className="h-7 w-full rounded-md border border-border/70 bg-input-surface pr-2 pl-7 text-xs placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Refresh pull requests"
              onClick={() => void reload()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("px-2 py-2", pageWidth)}>
          {error && (
            <ErrorNotice
              className="mx-1 mb-2"
              message={error}
              onRetry={() => void reload()}
              retrying={loading}
            />
          )}
          {!list && !error && <SkeletonLines className="px-2 py-2" lines={6} />}
          {list && rows.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {query ? `No pull requests match “${query}”.` : EMPTY_TEXT[filter]}
            </p>
          )}
          {rows.length > 0 && (
            <ul className="space-y-0.5" aria-label="Pull requests">
              {rows.map((item) => (
                <PullRequestRow
                  key={item.number}
                  item={item}
                  layout={layout}
                  highlighted={item.number === highlightNumber}
                  onOpen={() => open(item)}
                />
              ))}
            </ul>
          )}
          {list?.hasMore && (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              Showing the first {list.pullRequests.length} results. Search to narrow the list.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
