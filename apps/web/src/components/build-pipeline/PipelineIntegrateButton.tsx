import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { defaultPrTargetBranch } from "@orkestrator/protocol/git-workflow-prompts";
import { AutoMergeIcon } from "@/components/icons/AutoMergeIcon";
import { useAutoMergeToggle } from "@/components/layout/useAutoMergeToggle";
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
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useConfigStore, useEnvironmentStore } from "@/stores";

/**
 * The key information's Integrate button: a confirmed way to turn on the
 * environment's auto-merge (`pr-auto-merge.ts`). The backend then merges the
 * open pull request as soon as GitHub reports it ready, and launches Resolve
 * to fix merge conflicts, merging once they are gone. "Auto-merge & Cleanup"
 * also deletes the environment after the merge is confirmed, like the Merge
 * PR dialog's "Merge & Cleanup".
 *
 * Everything is durable backend state, so closing the panel or switching
 * environments does not stop it; the button reads the environment record and
 * shows whether integration is already armed.
 */
export function PipelineIntegrateButton({ environmentId }: { environmentId: string }) {
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(environmentId));
  const repositoryBaseBranch = useConfigStore((state) =>
    environment ? state.config.repositories[environment.projectId]?.prBaseBranch : undefined,
  );
  const autoMerge = useAutoMergeToggle(environment ?? null);
  const [open, setOpen] = useState(false);

  const prOpen = !!environment?.prUrl && environment.prState === "open";
  const disabledReason = !environment
    ? "Environment not found"
    : environment.prState === "merged"
      ? "The pull request has been merged"
      : environment.prState === "closed"
        ? "The pull request was closed without merging"
        : !prOpen
          ? "Integrate needs an open pull request"
          : null;
  const canCleanup = environment?.projectHome !== true;
  const sourceBranch = environment?.branch || "this branch";
  const targetBranch = environment?.prBaseBranch || defaultPrTargetBranch(repositoryBaseBranch);

  const integrate = async (cleanupAfterMerge: boolean) => {
    setOpen(false);
    const on = await autoMerge.set(true, cleanupAfterMerge);
    if (on) {
      toast.success(cleanupAfterMerge ? "Integrating, then cleaning up" : "Integrating", {
        description: cleanupAfterMerge
          ? "Merges when ready and resolves conflicts, then deletes this environment."
          : "Merges when ready and resolves conflicts as needed.",
        id: `integrate-${environmentId}`,
      });
    }
  };

  const stop = async () => {
    setOpen(false);
    await autoMerge.set(false);
  };

  const label = autoMerge.enabled ? "Integrating" : "Integrate";
  const tooltip: ReactNode =
    disabledReason ??
    (autoMerge.enabled
      ? autoMerge.cleanup
        ? "Auto-merge & Cleanup is on: merges when ready, then deletes this environment"
        : "Auto-merge is on: merges when ready, resolving conflicts as needed"
      : "Merge when ready, resolving conflicts as needed");

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button receives no pointer events, so the wrapper
              carries the tooltip that explains why. */}
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              size="sm"
              className={cn(
                "h-7 gap-1.5 bg-green-600 px-2.5 text-white hover:bg-green-700",
                autoMerge.enabled && "ring-1 ring-green-300/60",
              )}
              aria-label={label}
              aria-haspopup="dialog"
              disabled={disabledReason !== null || autoMerge.saving}
              onClick={() => setOpen(true)}
            >
              {autoMerge.saving ? <Loader2 className="size-4 animate-spin" /> : <AutoMergeIcon />}
              <span>{label}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={5}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Integrate Pull Request</AlertDialogTitle>
            <AlertDialogDescription>
              Auto-merge squashes and merges <BranchName>{sourceBranch}</BranchName> into{" "}
              <BranchName>{targetBranch}</BranchName> as soon as GitHub reports it ready. If it has
              merge conflicts, a Resolve tab is launched to fix them, and the merge follows once
              they are resolved.
              {canCleanup
                ? " Auto-merge & Cleanup also permanently deletes this environment, but only after the merge is confirmed successful."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {autoMerge.enabled ? (
            <div className="flex items-center gap-3 rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                {autoMerge.cleanup ? "Auto-merge & Cleanup" : "Auto-merge"} is already on for this
                pull request. Choosing again replaces it.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void stop()}
              >
                Turn Off
              </Button>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void integrate(false)}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              Auto-merge
            </AlertDialogAction>
            {canCleanup ? (
              <AlertDialogAction
                onClick={() => void integrate(true)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Auto-merge &amp; Cleanup
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A branch name styled like inline code, as in the Merge PR dialog. */
function BranchName({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-primary/12 px-1.5 py-0.5 font-mono text-xs text-blue-300 break-all">
      {children}
    </code>
  );
}
