import type { ReactNode } from "react";
import { AlertTriangle, GitMerge, Loader2, Trash2 } from "lucide-react";
import { AutoMergeIcon } from "@/components/icons/AutoMergeIcon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { AutoMergeHold } from "@/lib/pr-merge-readiness";
import { cn } from "@/lib/utils";

/**
 * What GitHub last said about merging the pull request: it can merge, it has
 * conflicts, or it is still computing (`hasMergeConflicts === null`).
 */
export type PrMergeability = "mergeable" | "conflicts" | "checking";

export function prMergeability(hasMergeConflicts: boolean | null | undefined): PrMergeability {
  if (hasMergeConflicts === true) return "conflicts";
  if (hasMergeConflicts === false) return "mergeable";
  return "checking";
}

export interface MergePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mergeability: PrMergeability;
  sourceBranch: ReactNode;
  targetBranch: ReactNode;
  /** Whether the merge also deletes the feature branch on GitHub. */
  deletesBranch: boolean;
  mergeError: string | null;
  merge: {
    /** Why merging now is not possible, or null when it is. */
    disabledReason: string | null;
    onMerge: (cleanupAfterMerge: boolean) => void;
  };
  resolve: {
    disabledReason: string | null;
    busy: boolean;
    onResolve: () => void;
    /** Opens the agent picker for Resolve; absent when it cannot open. */
    onConfigure: (() => void) | null;
  };
  autoMergeCleanup: {
    disabledReason: string | null;
    /** Auto-merge & Cleanup is already armed for this pull request. */
    active: boolean;
    saving: boolean;
    /** What auto-merge would wait for, from the same rule it merges on. */
    hold: AutoMergeHold | null;
    onArm: () => void;
  };
}

/**
 * The single Merge PR button's options. Everything that ends a pull request
 * lives here: merge now (only once GitHub has confirmed the PR can merge),
 * merge and delete the environment, launch Resolve for conflicts, and arm
 * Auto-merge & Cleanup, which merges whenever GitHub reports the PR ready,
 * resolving conflicts as needed, and then deletes the environment. Plain
 * auto-merge stays on its own toggle beside the button.
 */
export function MergePrDialog({
  open,
  onOpenChange,
  mergeability,
  sourceBranch,
  targetBranch,
  deletesBranch,
  mergeError,
  merge,
  resolve,
  autoMergeCleanup,
}: MergePrDialogProps) {
  const mergeDisabled = merge.disabledReason !== null;
  const autoMergeHoldNote =
    autoMergeCleanup.hold && !autoMergeCleanup.hold.transient
      ? `Auto-merge will wait: ${autoMergeCleanup.hold.message}`
      : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Merge Pull Request</AlertDialogTitle>
          <AlertDialogDescription>
            Squash and merge {sourceBranch} into {targetBranch}.{" "}
            {mergeability === "checking"
              ? "GitHub is still checking whether this pull request can be merged."
              : mergeability === "conflicts"
                ? "This pull request has merge conflicts that need resolving first."
                : "GitHub reports that this pull request can be merged."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mergeError && (
          <div className="min-w-0 max-h-[min(16rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            Failed to merge PR: {mergeError}
          </div>
        )}
        <div role="group" aria-label="Merge options" className="flex min-w-0 flex-col gap-2">
          <MergeOption
            description={
              merge.disabledReason ??
              `Merge now. If the pull request is a draft, it will be marked ready for review first. ${
                deletesBranch
                  ? "The feature branch will be deleted after merging if it is the PR head in the same repository."
                  : "The feature branch will be kept because it is not owned by this environment."
              }`
            }
          >
            <Button
              type="button"
              size="sm"
              className="w-full shrink-0 justify-start gap-2 sm:w-52 bg-green-600 text-white hover:bg-green-700"
              disabled={mergeDisabled}
              onClick={() => merge.onMerge(false)}
            >
              <GitMerge className="h-4 w-4" />
              Merge PR
            </Button>
          </MergeOption>
          <MergeOption
            description={
              merge.disabledReason ??
              "Merge now, then permanently delete this environment, but only after the merge is confirmed successful."
            }
          >
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="w-full shrink-0 justify-start gap-2 sm:w-52"
              disabled={mergeDisabled}
              onClick={() => merge.onMerge(true)}
            >
              <Trash2 className="h-4 w-4" />
              Merge &amp; Cleanup
            </Button>
          </MergeOption>
          <MergeOption
            description={
              resolve.disabledReason ??
              (mergeability === "checking"
                ? "Launch an agent to merge the target branch into this one and fix any conflicts, without waiting for GitHub's check."
                : "Launch an agent to merge the target branch into this one and fix the conflicts.")
            }
            extra={
              resolve.onConfigure ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={resolve.onConfigure}
                >
                  Choose agent…
                </Button>
              ) : null
            }
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(
                "w-full shrink-0 justify-start gap-2 sm:w-52",
                mergeability === "conflicts" && "border-destructive text-destructive",
              )}
              disabled={resolve.disabledReason !== null || resolve.busy}
              onClick={resolve.onResolve}
            >
              {resolve.busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              Resolve
            </Button>
          </MergeOption>
          <MergeOption
            description={
              autoMergeCleanup.disabledReason ??
              (autoMergeCleanup.active
                ? "Already on: this pull request merges when ready, then this environment is deleted. Use the auto-merge toggle to turn it off."
                : "Merge as soon as GitHub reports the pull request ready, resolving conflicts as needed, then delete this environment.")
            }
            note={autoMergeCleanup.disabledReason ? null : autoMergeHoldNote}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full shrink-0 justify-start gap-2 sm:w-52 border-green-600 text-green-600 hover:text-green-700 dark:text-green-400"
              disabled={
                autoMergeCleanup.disabledReason !== null ||
                autoMergeCleanup.active ||
                autoMergeCleanup.saving
              }
              onClick={autoMergeCleanup.onArm}
            >
              {autoMergeCleanup.saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AutoMergeIcon />
              )}
              Auto-merge &amp; Cleanup
            </Button>
          </MergeOption>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MergeOption({
  children,
  description,
  extra,
  note,
}: {
  children: ReactNode;
  description: string;
  extra?: ReactNode;
  note?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 p-2 sm:flex-row sm:items-start">
      {children}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{description}</p>
        {note ? (
          <p role="note" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {note}
          </p>
        ) : null}
        {extra ? <div className="mt-1">{extra}</div> : null}
      </div>
    </div>
  );
}
