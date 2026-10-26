import {
  CheckCircle2,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  XCircle,
} from "lucide-react";
import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { Button } from "@/components/ui/button";
import { usePullRequest } from "@/hooks/usePullRequest";
import { cn } from "@/lib/utils";
import type { PipelinePullRequest } from "./pipeline-flow";

/**
 * The pipeline environment's pull request, as the backend PR monitor already
 * tracks it. Nothing new is read: the monitor owns the polling (and its
 * bounds), and this only mirrors what it last saw.
 */
export function usePipelinePullRequest(environmentId: string | null): PipelinePullRequest | null {
  const { prUrl, prState, checkSummary } = usePullRequest({ environmentId });
  return prUrl ? { url: prUrl, state: prState, checks: checkSummary } : null;
}

export type PipelineCheckState = "passing" | "failing" | "pending";

export function pipelineCheckState(checks: PrCheckSummary): PipelineCheckState {
  const failed = checks.total - checks.passed - checks.pending;
  if (failed > 0) return "failing";
  return checks.pending > 0 ? "pending" : "passing";
}

/** "2 of 4 checks passed · 1 failing · 1 pending", in the PR monitor's terms. */
export function pipelineCheckSummary(checks: PrCheckSummary): string {
  if (checks.total === 0) return "No CI checks reported";
  const failed = checks.total - checks.passed - checks.pending;
  return [
    `${checks.passed} of ${checks.total} checks passed`,
    failed > 0 ? `${failed} failing` : null,
    checks.pending > 0 ? `${checks.pending} pending` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const CHECK_TONE: Record<PipelineCheckState, string> = {
  passing: "text-green-400",
  failing: "text-failure",
  pending: "text-amber-400",
};

/** The checks row on the PR node's face. */
export function PipelinePullRequestChecks({ checks }: { checks: PrCheckSummary | null }) {
  if (!checks || checks.total === 0) {
    return (
      <span className="mt-1 text-[11px] text-muted-foreground">
        {checks ? "No CI checks" : "CI status not known yet"}
      </span>
    );
  }
  const state = pipelineCheckState(checks);
  const Icon = state === "failing" ? XCircle : state === "pending" ? Loader2 : CheckCircle2;
  return (
    <span
      data-pr-checks={state}
      className={cn("mt-1 flex items-center gap-1 text-[11px] tabular-nums", CHECK_TONE[state])}
    >
      <Icon className={cn("size-3 shrink-0", state === "pending" && "animate-spin")} />
      CI {state} · {checks.passed}/{checks.total}
    </span>
  );
}

const STATE_LABEL = { open: "Open", merged: "Merged", closed: "Closed" } as const;

/** The PR node's inspector: the link, its state and its CI checks. */
export function PipelinePullRequestView({
  environmentId,
  pullRequest,
  shipped,
}: {
  environmentId: string;
  pullRequest: PipelinePullRequest | null;
  /** The pipeline reached Ship, so the environment's PR is its own. */
  shipped: boolean;
}) {
  const { viewPR } = usePullRequest({ environmentId });
  if (!pullRequest || !shipped) {
    return (
      <p className="text-sm text-muted-foreground">
        {shipped
          ? "The pull request has not been detected yet. It appears here once GitHub reports it."
          : "The pull request is created at the end of the pipeline, once verification passes."}
      </p>
    );
  }
  const Icon = pullRequest.state === "merged" ? GitMerge : GitPullRequest;
  return (
    <div data-testid="pipeline-pr-details" className="flex min-w-0 flex-col gap-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <a
          href={pullRequest.url}
          className="min-w-0 truncate text-primary underline-offset-2 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            void viewPR();
          }}
        >
          {pullRequest.url}
        </a>
        {pullRequest.state ? (
          <span
            data-testid="pipeline-pr-state"
            className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground"
          >
            {STATE_LABEL[pullRequest.state]}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">CI checks</dt>
        <dd data-testid="pipeline-pr-checks">
          {pullRequest.checks ? pipelineCheckSummary(pullRequest.checks) : "Not known yet"}
        </dd>
      </dl>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void viewPR()}>
          View PR
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void viewPR({ external: true })}
        >
          <ExternalLink className="size-3.5" />
          Open on GitHub
        </Button>
      </div>
    </div>
  );
}
