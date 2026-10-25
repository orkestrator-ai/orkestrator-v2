import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  CircleCheck,
  CircleDot,
  CircleX,
  GitCommitHorizontal,
  MessageSquare,
} from "lucide-react";
import {
  gitHubPullRequestKey,
  type GitHubPullRequestDetail,
  type GitHubPullRequestRef,
  type GitHubPullRequestState,
  type GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import {
  usePullRequestDetail,
  usePullRequestFiles,
  usePullRequestTimeline,
  useStablePullRequestRef,
} from "@/hooks/usePullRequestData";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import { PullRequestHeader } from "./PullRequestHeader";
import { PullRequestSummaryTab, type SortOrder } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { checksSummaryLabel, tallyChecks } from "./pull-request-format";
import { ErrorNotice, SkeletonLines } from "./pull-request-shared";

export interface PullRequestViewProps {
  pullRequest: GitHubPullRequestRef;
  initialView?: GitHubPullRequestViewTab;
  layout: "sidebar" | "page";
  /** Host buttons (expand-to-main-area / move-to-sidebar) rendered top-right next to the ⋯ menu. */
  headerActions?: ReactNode;
  /** Polling only runs while active (visible). Default true. */
  active?: boolean;
  /** Called when the view learns the PR title/state, so hosts can label their tab. */
  onSummaryLoaded?: (summary: {
    title: string;
    state: GitHubPullRequestState;
    isDraft: boolean;
  }) => void;
  className?: string;
}

const TAB_OPTIONS: { value: GitHubPullRequestViewTab; label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

function ChecksContext({ detail }: { detail: GitHubPullRequestDetail }) {
  const tally = tallyChecks(detail.checks);
  const label = checksSummaryLabel(detail.checks, detail.checksState);
  const icon =
    tally.failed > 0 || (tally.total === 0 && detail.checksState === "failure") ? (
      <CircleX className="size-3.5 text-failure" />
    ) : tally.pending > 0 || (tally.total === 0 && detail.checksState === "pending") ? (
      <CircleDot className="size-3.5 text-amber-400" />
    ) : tally.total > 0 || detail.checksState === "success" ? (
      <CircleCheck className="size-3.5 text-success" />
    ) : null;
  return (
    <span className="flex items-center gap-1.5 truncate" data-testid="checks-summary">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function OrderToggle({
  order,
  onChange,
}: {
  order: SortOrder;
  onChange: (order: SortOrder) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(order === "newest" ? "oldest" : "newest")}
      className="flex shrink-0 items-center gap-1 hover:text-foreground"
    >
      <ArrowUpDown className="size-3" />
      {order === "newest" ? "Newest first" : "Oldest first"}
    </button>
  );
}

export function PullRequestView({
  pullRequest,
  initialView = "summary",
  layout,
  headerActions,
  active = true,
  onSummaryLoaded,
  className,
}: PullRequestViewProps) {
  const ref = useStablePullRequestRef(pullRequest);
  const [tab, setTab] = useState<GitHubPullRequestViewTab>(initialView);
  const [visited, setVisited] = useState(() => new Set<GitHubPullRequestViewTab>([initialView]));
  const [timelineOrder, setTimelineOrder] = useState<SortOrder>("newest");
  const { detail, loading, error, reload } = usePullRequestDetail(ref, active);
  const timeline = usePullRequestTimeline(ref, visited.has("timeline"));
  const files = usePullRequestFiles(ref, visited.has("code"));
  const refreshAll = usePullRequestsStore((state) => state.refreshAll);

  const selectTab = (next: GitHubPullRequestViewTab) => {
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
  };

  // A host re-targeting the same view (e.g. a deep link to /files) switches tab.
  const lastInitialView = useRef(initialView);
  useEffect(() => {
    if (lastInitialView.current === initialView) return;
    lastInitialView.current = initialView;
    setTab(initialView);
    setVisited((current) => new Set(current).add(initialView));
  }, [initialView]);

  const onSummaryLoadedRef = useRef(onSummaryLoaded);
  useEffect(() => {
    onSummaryLoadedRef.current = onSummaryLoaded;
  });
  const title = detail?.title;
  const state = detail?.state;
  const isDraft = detail?.isDraft;
  useEffect(() => {
    if (title === undefined || state === undefined || isDraft === undefined) return;
    onSummaryLoadedRef.current?.({ title, state, isDraft });
  }, [title, state, isDraft]);

  // When GitHub reports a new update or head commit, refresh what is loaded.
  const signature = detail ? `${detail.updatedAt}|${detail.headSha}` : null;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (!signature) return;
    const previous = lastSignature.current;
    lastSignature.current = signature;
    if (!previous || previous === signature) return;
    const store = usePullRequestsStore.getState();
    const key = gitHubPullRequestKey(ref);
    if (store.timelines.has(key)) void store.loadTimeline(ref);
    if (store.files.has(key)) void store.loadFiles(ref);
  }, [ref, signature]);

  const pageWidth = layout === "page" ? "mx-auto w-full max-w-5xl" : "w-full";

  let body: ReactNode;
  if (!detail) {
    body =
      error && !loading ? (
        <ErrorNotice message={error} onRetry={() => void reload()} />
      ) : (
        <SkeletonLines lines={6} />
      );
  } else if (tab === "summary") {
    body = <PullRequestSummaryTab pullRequest={ref} detail={detail} />;
  } else if (tab === "timeline") {
    body = timeline.timeline ? (
      <PullRequestTimelineTab
        pullRequest={ref}
        timeline={timeline.timeline}
        order={timelineOrder}
      />
    ) : timeline.error ? (
      <ErrorNotice
        message={timeline.error}
        onRetry={() => void timeline.reload()}
        retrying={timeline.loading}
      />
    ) : (
      <SkeletonLines lines={8} />
    );
  } else {
    body = files.files ? (
      <PullRequestCodeTab
        key={gitHubPullRequestKey(ref)}
        pullRequest={ref}
        files={files.files}
        canComment
      />
    ) : files.error ? (
      <ErrorNotice
        message={files.error}
        onRetry={() => void files.reload()}
        retrying={files.loading}
      />
    ) : (
      <SkeletonLines lines={8} />
    );
  }

  const staleError =
    detail && error ? (
      <ErrorNotice
        className="mb-3 py-2 text-xs"
        message={error}
        onRetry={() => void reload()}
        retrying={loading}
      />
    ) : null;
  const tabStaleError =
    tab === "timeline" && timeline.timeline && timeline.error
      ? { message: timeline.error, retry: timeline.reload, loading: timeline.loading }
      : tab === "code" && files.files && files.error
        ? { message: files.error, retry: files.reload, loading: files.loading }
        : null;

  return (
    <div
      data-testid="pull-request-view"
      data-layout={layout}
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <div className="shrink-0 border-b border-border/60">
        <div className={pageWidth}>
          <PullRequestHeader
            pullRequest={ref}
            detail={detail}
            headerActions={headerActions}
            refreshing={loading && Boolean(detail)}
            onRefresh={() => void refreshAll(ref)}
          />
        </div>
      </div>
      <div className="shrink-0 border-b border-border/60">
        <div className={cn("flex items-center gap-3 px-4 py-2", pageWidth)}>
          <SegmentedSelector
            semantics="tabs"
            ariaLabel="Pull request sections"
            value={tab}
            options={TAB_OPTIONS}
            onValueChange={selectTab}
            buttonClassName="h-7 px-2.5 text-xs"
          />
          <div className="ml-auto flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            {detail && tab === "summary" && <ChecksContext detail={detail} />}
            {detail && tab === "timeline" && (
              <>
                <span className="flex items-center gap-1" title="Comments">
                  <MessageSquare className="size-3.5" />
                  {detail.commentsCount}
                </span>
                <span className="flex items-center gap-1" title="Commits">
                  <GitCommitHorizontal className="size-3.5" />
                  {detail.commitsCount}
                </span>
                <OrderToggle order={timelineOrder} onChange={setTimelineOrder} />
              </>
            )}
          </div>
        </div>
      </div>
      <div role="tabpanel" aria-label={tab} className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(pageWidth, tab === "code" && detail ? "pb-6" : "px-4 py-3 pb-6")}>
          {tab === "code" && detail ? (
            <>
              {(staleError || tabStaleError) && (
                <div className="px-4 pt-3">
                  {staleError}
                  {tabStaleError && (
                    <ErrorNotice
                      className="py-2 text-xs"
                      message={tabStaleError.message}
                      onRetry={() => void tabStaleError.retry()}
                      retrying={tabStaleError.loading}
                    />
                  )}
                </div>
              )}
              {files.files ? body : <div className="px-4 py-3">{body}</div>}
            </>
          ) : (
            <>
              {staleError}
              {tabStaleError && (
                <ErrorNotice
                  className="mb-3 py-2 text-xs"
                  message={tabStaleError.message}
                  onRetry={() => void tabStaleError.retry()}
                  retrying={tabStaleError.loading}
                />
              )}
              {body}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
