import { useRef, useState } from "react";
import { GitMerge, GitPullRequest, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { pipelineFollowUps } from "@orkestrator/protocol/build-pipeline-notes";

import { KeyInformationDocument } from "@/components/build-pipeline/PipelineKeyInformationTab";
import { PipelineNeedsALook } from "@/components/build-pipeline/PipelineNeedsALook";
import { AutoMergeToggleButton } from "@/components/layout/AutoMergeToggleButton";
import { MergePrDialog, prMergeability } from "@/components/layout/MergePrDialog";
import { armAutoMergeCleanup } from "@/components/layout/auto-merge-cleanup";
import { useAutoMergeToggle } from "@/components/layout/useAutoMergeToggle";
import { Button } from "@/components/ui/button";
import { useAutoMergeHold, useShimmerRequiresChecks } from "@/hooks/useEnvironmentNameSignal";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { localEnvironmentPrMergeReadiness } from "@/lib/pr-merge-readiness";
import { openPullRequestUrl, usePullRequestOpener } from "@/lib/pull-request-opener";
import { cn } from "@/lib/utils";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { isEnvironmentOwnedBranch } from "@orkestrator/protocol/environment-branch";
import { defaultPrTargetBranch } from "@orkestrator/protocol/git-workflow-prompts";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { TicketActionBar } from "./TicketActionBar";
import { ticketChecksLabel, ticketPrState, type TicketPrTone } from "./ticket-view-model";

const log = createLogger("web.kanban");

const TONE: Record<TicketPrTone, string> = {
  neutral: "border-border/70 bg-muted/30 text-foreground",
  good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  bad: "border-failure/40 bg-failure/10 text-failure",
  merged: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

/**
 * The ticket view's Notes tab: its build's Notes (the key information, led by
 * what needs a look), laid out as the full-tab Notes page lays them out but in
 * one column, under a bar that stays put while they scroll. The bar says
 * where the pull request stands and offers Merge, which opens the action
 * bar's Merge PR options (merge now, enabled only when GitHub reports it
 * ready, and Auto-merge & Cleanup, offered while checks are still pending),
 * and the auto-merge toggle (the same switch as the action bar's: merges when
 * ready, launching Resolve when conflicts need it). Nothing merges without a
 * click.
 */
export function TicketNotesTab({ pipeline }: { pipeline: BuildPipeline }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ticket-notes-tab">
      <TicketActionBar label="Pull request actions">
        <PullRequestBar environmentId={pipeline.environmentId} />
      </TicketActionBar>
      <div
        ref={scrollRef}
        data-testid="ticket-notes-scroll"
        className="@container min-h-0 flex-1 overflow-y-auto"
      >
        <KeyInformationDocument
          keyInformation={pipeline.keyInformation}
          scrollRef={scrollRef}
          singleColumn
          lead={<PipelineNeedsALook followUps={pipelineFollowUps(pipeline)} />}
        />
      </div>
    </div>
  );
}

function PullRequestBar({ environmentId }: { environmentId: string }) {
  const backend = useScopeBackend();
  const opener = usePullRequestOpener();
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(environmentId));
  const requireChecks = useShimmerRequiresChecks();
  const monitor = usePrMonitorStore((state) => state.states.get(environmentId) ?? null);
  const syncStatus = usePrMonitorStore((state) => state.syncStatus);
  const hold = useAutoMergeHold(environmentId, environment);
  const autoMerge = useAutoMergeToggle(environment ?? null);
  const prBaseBranch = useConfigStore((state) =>
    environment ? state.config.repositories[environment.projectId]?.prBaseBranch : undefined,
  );
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [merging, setMerging] = useState(false);

  const readiness =
    environment && environment.prUrl
      ? localEnvironmentPrMergeReadiness(environment, monitor, syncStatus, requireChecks)
      : null;
  const pr = ticketPrState({
    prUrl: environment?.prUrl,
    prState: environment?.prState,
    readiness,
    checkSummary: monitor?.checkSummary ?? null,
    holdMessage: hold?.message,
  });
  const checks =
    environment?.prState === "open" ? ticketChecksLabel(monitor?.checkSummary ?? null) : null;
  const prNumber = environment?.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  const mergeDisabledReason = !environment
    ? "The build's environment is not on this machine"
    : merging
      ? "Merge in progress…"
      : !pr.mergeable
        ? (pr.detail ?? `Not ready to merge: ${pr.label.toLowerCase()}`)
        : null;
  // The button opens the options, so it stays usable while checks run: the
  // options say why merging now is not possible and still offer Auto-merge &
  // Cleanup.
  const optionsDisabledReason = !environment
    ? "The build's environment is not on this machine"
    : merging
      ? "Merge in progress…"
      : !environment.prUrl || environment.prState !== "open"
        ? (pr.detail ?? `Not ready to merge: ${pr.label.toLowerCase()}`)
        : null;

  const merge = async () => {
    setOptionsOpen(false);
    if (!environment) return;
    setMerging(true);
    try {
      const result = await backend.mergeEnvironmentPr(environment.id, "squash", true, false);
      if (result.outcome === "merged") {
        toast.success("Pull request merged", { id: `ticket-merge-${environment.id}` });
      } else {
        toast.success(result.outcome === "pending" ? "Merge pending" : "Merge submitted", {
          id: `ticket-merge-${environment.id}`,
        });
      }
    } catch (error) {
      log.error("pr.merge-failed", { error: formatLogError(error) });
      toast.error("The pull request could not be merged", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span
          role="status"
          aria-label={`Pull request: ${pr.label}`}
          data-testid="ticket-pr-state"
          data-tone={pr.tone}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
            TONE[pr.tone],
          )}
        >
          {pr.tone === "merged" ? (
            <GitMerge aria-hidden className="size-3.5" />
          ) : (
            <GitPullRequest aria-hidden className="size-3.5" />
          )}
          {pr.label}
        </span>
        {checks ? (
          <span data-testid="ticket-pr-checks" className="text-xs text-muted-foreground">
            {checks}
          </span>
        ) : null}
        {environment?.prUrl ? (
          <button
            type="button"
            className="text-xs text-blue-400 hover:underline"
            onClick={(event) =>
              void openPullRequestUrl(environment.prUrl!, {
                external: event.metaKey || event.ctrlKey,
                opener,
              }).catch(() => toast.error("Could not open the pull request"))
            }
          >
            {prNumber ? `#${prNumber}` : "Open pull request"}
          </button>
        ) : null}
        {pr.detail && !pr.mergeable ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground @2xl:inline">
            {pr.detail}
          </span>
        ) : null}
      </div>
      <span className="inline-flex shrink-0" title={optionsDisabledReason ?? "Merge options"}>
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 px-2.5"
          disabled={optionsDisabledReason !== null}
          aria-description={optionsDisabledReason ?? undefined}
          onClick={() => setOptionsOpen(true)}
        >
          {merging ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <GitMerge aria-hidden className="size-3.5" />
          )}
          Merge
        </Button>
      </span>
      <AutoMergeToggleButton environmentId={environmentId} />
      <MergePrDialog
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        mergeability={prMergeability(environment?.hasMergeConflicts)}
        sourceBranch={prNumber ? `#${prNumber}` : "this pull request"}
        targetBranch={defaultPrTargetBranch(prBaseBranch)}
        deletesBranch={Boolean(
          environment && isEnvironmentOwnedBranch(environment.id, environment.branch),
        )}
        mergeError={null}
        merge={{
          disabledReason: mergeDisabledReason,
          onMerge: () => void merge(),
          offerCleanup: false,
        }}
        resolve={null}
        autoMergeCleanup={{
          disabledReason: environment?.projectHome
            ? "The project's home environment is never deleted; use the auto-merge toggle instead."
            : null,
          active: autoMerge.cleanup,
          saving: autoMerge.saving,
          hold,
          onArm: () => {
            setOptionsOpen(false);
            if (environment) void armAutoMergeCleanup(environment.id, autoMerge.set, hold);
          },
        }}
      />
    </>
  );
}
