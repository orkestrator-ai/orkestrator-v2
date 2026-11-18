import { useId, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  ExternalLink,
  FileDiff,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Terminal,
  TriangleAlert,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { hasEnvironmentBranchOwnership } from "@orkestrator/protocol/environment-branch";
import {
  gitHubPullRequestUrl,
  type GitHubPullRequestDetail,
  type GitHubPullRequestMergeMethod,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openInBrowser } from "@/lib/backend";
import type { GitHubPullRequestStateAction } from "@/lib/backend";
import {
  configuredPrTargetForPullRequest,
  prTargetMismatch,
  type PrTargetMismatch,
} from "@/lib/pr-target-mismatch";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import {
  MERGE_METHOD_LABELS,
  MERGE_METHOD_ORDER,
  defaultMergeMethod,
  mergeBlockedReason,
  mergeWarning,
  pluralize,
} from "./pull-request-format";
import {
  RelativeTime,
  UserAvatar,
  copyToClipboard,
  errorMessage,
  userLogin,
} from "./pull-request-shared";
import { PullRequestStateBadge } from "./PullRequestStateIcon";

function openExternal(url: string) {
  void openInBrowser(url).catch((error) => {
    toast.error(errorMessage(error, "Could not open the browser."));
  });
}

/**
 * The branch the project's settings name as the PR target, for the project
 * whose GitHub remote is this pull request's repository. `null` when no
 * project tracks the repository or its target is ambiguous.
 */
function useConfiguredPrTarget(pullRequest: GitHubPullRequestRef): string | null {
  const projects = useProjectStore((state) => state.projects);
  const repositories = useConfigStore((state) => state.config.repositories);
  return useMemo(
    () => configuredPrTargetForPullRequest(pullRequest, projects, repositories),
    [pullRequest, projects, repositories],
  );
}

export function MergeButton({
  pullRequest,
  detail,
  targetMismatch = null,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail;
  /** The PR merges into a branch other than the project's configured target. */
  targetMismatch?: PrTargetMismatch | null;
}) {
  const merge = usePullRequestsStore((state) => state.merge);
  const allowed = MERGE_METHOD_ORDER.filter((method) =>
    detail.allowedMergeMethods.includes(method),
  );
  const [chosen, setChosen] = useState<GitHubPullRequestMergeMethod | null>(null);
  const method =
    chosen && allowed.includes(chosen) ? chosen : defaultMergeMethod(detail.allowedMergeMethods);
  // Only a branch Orkestrator created for an environment may be deleted; a
  // release branch such as `dev`, or any branch made by hand, is always kept.
  // The backend applies the same rule whatever this sends.
  const environments = useEnvironmentStore((state) => state.environments);
  const canDeleteBranch =
    !detail.isCrossRepository &&
    hasEnvironmentBranchOwnership(pullRequest, detail.headRef, environments);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const shouldDeleteBranch = deleteBranch && canDeleteBranch;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const blocked = mergeBlockedReason(detail);
  const warning = blocked ? null : mergeWarning(detail);
  const reasonId = useId();
  const disabled = Boolean(blocked) || merging || !method;

  const confirm = async () => {
    if (!method) return;
    setMerging(true);
    try {
      const result = await merge(pullRequest, {
        method,
        deleteBranch: shouldDeleteBranch,
        expectedHeadSha: detail.headSha,
      });
      if (!result.merged) {
        throw new Error(result.message || "GitHub did not merge the pull request.");
      }
      setConfirmOpen(false);
      toast.success(`Merged #${pullRequest.number}`, {
        description:
          result.branchDeleted === false && shouldDeleteBranch
            ? "The head branch could not be deleted."
            : result.message,
      });
    } catch (error) {
      toast.error(errorMessage(error, "Could not merge the pull request."));
    } finally {
      setMerging(false);
    }
  };

  const tooltip =
    blocked ??
    warning ??
    (targetMismatch
      ? `Merges into ${targetMismatch.actual}, not the project's target branch ${targetMismatch.configured}`
      : method
        ? MERGE_METHOD_LABELS[method]
        : "Merge");

  return (
    <>
      <div className="flex shrink-0 items-center" data-testid="pull-request-merge">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A span keeps the tooltip working while the button is disabled. */}
            <span className="inline-flex" tabIndex={disabled ? 0 : -1}>
              <Button
                size="sm"
                className="h-7 rounded-r-none px-2.5 text-xs"
                disabled={disabled}
                data-target-mismatch={targetMismatch ? "true" : undefined}
                aria-describedby={blocked || warning ? reasonId : undefined}
                onClick={() => setConfirmOpen(true)}
              >
                {merging ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : warning ? (
                  <TriangleAlert className="size-3.5 text-amber-300" />
                ) : (
                  <GitMerge className="size-3.5" />
                )}
                Merge
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{tooltip}</TooltipContent>
        </Tooltip>
        {(blocked || warning) && (
          <span id={reasonId} className="sr-only" data-testid="merge-reason">
            {blocked ?? warning}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              aria-label="Merge options"
              className="h-7 rounded-l-none border-l border-primary-foreground/25 px-1"
              disabled={disabled}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              Merge method
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={method ?? ""}
              onValueChange={(value) => setChosen(value as GitHubPullRequestMergeMethod)}
            >
              {allowed.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} className="text-xs">
                  {MERGE_METHOD_LABELS[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={shouldDeleteBranch}
              disabled={!canDeleteBranch}
              onCheckedChange={(checked) => setDeleteBranch(checked === true)}
              onSelect={(event) => event.preventDefault()}
              className="text-xs"
            >
              Delete branch after merge
            </DropdownMenuCheckboxItem>
            {!canDeleteBranch && (
              <p
                className="px-2 pb-1.5 pl-8 text-[11px] leading-snug text-muted-foreground"
                data-testid="merge-keeps-branch-reason"
              >
                {detail.isCrossRepository
                  ? "Branches in a fork are never deleted."
                  : "Only branches created for an environment can be deleted."}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={(open) => !merging && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {targetMismatch ? (
                <>
                  <TriangleAlert className="size-5 shrink-0 text-failure" aria-hidden />
                  Merge into non-target branch?
                </>
              ) : (
                <>Merge pull request #{pullRequest.number}?</>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">
                    {method ? MERGE_METHOD_LABELS[method] : "Merge"}
                  </span>{" "}
                  <span className="font-mono text-xs">{detail.headRef}</span> into{" "}
                  <span
                    className={cn(
                      "font-mono text-xs",
                      targetMismatch && "font-semibold text-failure",
                    )}
                    data-target-mismatch={targetMismatch ? "true" : undefined}
                  >
                    {detail.baseRef}
                  </span>
                  .
                </p>
                {targetMismatch && (
                  <p
                    role="alert"
                    className="flex items-start gap-1.5 text-failure"
                    data-testid="merge-target-mismatch"
                  >
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Pull request #{pullRequest.number} targets {targetMismatch.actual}, but the
                      target branch set in this project&apos;s settings is{" "}
                      {targetMismatch.configured}. Do you wish to accept?
                    </span>
                  </p>
                )}
                <p>
                  {shouldDeleteBranch
                    ? `The ${detail.headRef} branch will be deleted after merging.`
                    : canDeleteBranch || detail.isCrossRepository
                      ? "The head branch will be kept."
                      : `The ${detail.headRef} branch will be kept: environment ownership could not be verified.`}
                </p>
                {warning && (
                  <p className="flex items-start gap-1.5 text-amber-300">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {warning}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={merging}
              className={cn(targetMismatch && buttonVariants({ variant: "destructive" }))}
              onClick={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              {merging && <Loader2 className="size-4 animate-spin" />}
              {targetMismatch ? "Accept and merge" : method ? MERGE_METHOD_LABELS[method] : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PullRequestActionsMenu({
  pullRequest,
  detail,
  onRefresh,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail | undefined;
  onRefresh: () => void;
}) {
  const updateState = usePullRequestsStore((state) => state.updateState);
  const url = detail?.htmlUrl ?? gitHubPullRequestUrl(pullRequest);
  const checkout = `gh pr checkout ${pullRequest.number} --repo ${pullRequest.owner}/${pullRequest.repo}`;
  const canChangeState = Boolean(
    detail && (detail.viewerPermissions.canWrite || detail.viewerPermissions.isAuthor),
  );

  const run = async (action: GitHubPullRequestStateAction, success: string) => {
    try {
      await updateState(pullRequest, action);
      toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the pull request."));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="More actions">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => openExternal(url)}>
          <ExternalLink />
          Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyToClipboard(url, "Link")}>
          <Link2 />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyToClipboard(checkout, "Checkout command")}>
          <Terminal />
          Copy <span className="font-mono text-xs">{checkout}</span>
        </DropdownMenuItem>
        {detail && detail.state === "open" && canChangeState && (
          <>
            <DropdownMenuSeparator />
            {detail.isDraft ? (
              <DropdownMenuItem
                onSelect={() => void run("ready-for-review", "Marked ready for review")}
              >
                <Eye />
                Mark ready for review
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void run("convert-to-draft", "Converted to draft")}>
                <GitPullRequestDraft />
                Convert to draft
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void run("close", "Pull request closed")}
            >
              <GitPullRequestClosed />
              Close pull request
            </DropdownMenuItem>
          </>
        )}
        {detail && detail.state === "closed" && canChangeState && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void run("reopen", "Pull request reopened")}>
              <RotateCcw />
              Reopen pull request
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRefresh}>
          <RefreshCw />
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PullRequestHeader({
  pullRequest,
  detail,
  headerActions,
  onRefresh,
  refreshing,
}: {
  pullRequest: GitHubPullRequestRef;
  detail: GitHubPullRequestDetail | undefined;
  headerActions?: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const url = detail?.htmlUrl ?? gitHubPullRequestUrl(pullRequest);
  const checkout = `gh pr checkout ${pullRequest.number} --repo ${pullRequest.owner}/${pullRequest.repo}`;
  const configuredTarget = useConfiguredPrTarget(pullRequest);
  const targetMismatch = prTargetMismatch({
    actualBase: detail?.baseRef,
    configuredBase: configuredTarget,
  });
  const targetWarning = targetMismatch
    ? `Not the project's target branch: settings name ${targetMismatch.configured}.`
    : null;
  const baseWarning =
    detail?.state === "open" &&
    (detail.mergeability === "dirty" || detail.mergeability === "behind")
      ? detail.mergeability === "dirty"
        ? "This branch has conflicts with the base branch."
        : "This branch is behind the base branch."
      : null;

  return (
    <header className="space-y-2 px-4 pt-3 pb-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => openExternal(url)}
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Open on GitHub"
        >
          <span className="truncate">
            {pullRequest.owner}/{pullRequest.repo}
          </span>
          <span className="shrink-0 font-medium text-success">#{pullRequest.number}</span>
          <ExternalLink className="size-3 shrink-0" />
        </button>
        {detail && <PullRequestStateBadge state={detail.state} isDraft={detail.isDraft} />}
        {refreshing && (
          <Loader2
            className="size-3 shrink-0 animate-spin text-muted-foreground"
            aria-label="Refreshing"
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail && detail.state === "open" && (
            <MergeButton
              pullRequest={pullRequest}
              detail={detail}
              targetMismatch={targetMismatch}
            />
          )}
          <PullRequestActionsMenu pullRequest={pullRequest} detail={detail} onRefresh={onRefresh} />
          {headerActions}
        </div>
      </div>
      {detail && (
        <>
          <h2 className="text-base leading-snug font-semibold break-words text-foreground">
            {detail.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <UserAvatar user={detail.author} className="size-4" />
              <span className="truncate font-medium text-foreground">
                {userLogin(detail.author)}
              </span>
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              updated <RelativeTime value={detail.updatedAt} />
            </span>
            <button
              type="button"
              onClick={() => void copyToClipboard(checkout, "Checkout command")}
              title="Copy checkout command"
              className="ml-auto flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              {checkout}
              <Copy className="size-3" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 font-mono">
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1",
                  baseWarning && "text-amber-400",
                  targetMismatch && "font-semibold text-failure",
                )}
                data-testid="pull-request-base-ref"
                data-target-mismatch={targetMismatch ? "true" : undefined}
              >
                <span className="truncate">{detail.baseRef}</span>
                {targetWarning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TriangleAlert
                        className="size-3.5 shrink-0"
                        role="img"
                        aria-label={targetWarning}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{targetWarning}</TooltipContent>
                  </Tooltip>
                )}
                {baseWarning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TriangleAlert
                        className="size-3.5 shrink-0"
                        role="img"
                        aria-label={baseWarning}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{baseWarning}</TooltipContent>
                  </Tooltip>
                )}
              </span>
              <ArrowLeft className="size-3 shrink-0 text-muted-foreground" />
              <span
                className="truncate text-muted-foreground"
                title={
                  detail.headRepositoryFullName
                    ? `${detail.headRepositoryFullName}:${detail.headRef}`
                    : detail.headRef
                }
              >
                {detail.isCrossRepository && detail.headRepositoryFullName
                  ? `${detail.headRepositoryFullName.split("/")[0]}:${detail.headRef}`
                  : detail.headRef}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <FileDiff className="size-3.5" />
              {pluralize(detail.changedFiles, "file")}
              <span className="font-mono text-success">+{detail.additions.toLocaleString()}</span>
              <span className="font-mono text-failure">−{detail.deletions.toLocaleString()}</span>
            </span>
          </div>
        </>
      )}
    </header>
  );
}
