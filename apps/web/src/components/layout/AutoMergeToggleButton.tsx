import { Loader2 } from "lucide-react";
import { AutoMergeIcon } from "@/components/icons/AutoMergeIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutoMergeHold } from "@/hooks/useEnvironmentNameSignal";
import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores";
import { useAutoMergeToggle } from "./useAutoMergeToggle";

/**
 * The auto-merge switch for surfaces outside the action bar (the ticket
 * view's pull request bar): the same durable flag as the action bar's toggle,
 * shown only while the pull request is open. The tooltip names what
 * auto-merge is waiting for, from the rule it merges on (`useAutoMergeHold`).
 */
export function AutoMergeToggleButton({
  environmentId,
  className,
}: {
  environmentId: string;
  className?: string;
}) {
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(environmentId));
  const autoMerge = useAutoMergeToggle(environment ?? null);
  const hold = useAutoMergeHold(environmentId, environment);
  if (!environment?.prUrl || environment.prState !== "open") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className={cn(
              "size-7",
              autoMerge.enabled &&
                "border-green-600 bg-green-600/15 text-white hover:bg-green-600/25 hover:text-white",
              className,
            )}
            aria-label="Auto-merge"
            aria-pressed={autoMerge.enabled}
            disabled={autoMerge.saving}
            onClick={() => void autoMerge.toggle()}
          >
            {autoMerge.saving ? <Loader2 className="size-4 animate-spin" /> : <AutoMergeIcon />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>
        {environment.autoMergeError ? (
          <p>Auto-merge: {environment.autoMergeError}</p>
        ) : (
          <>
            <p>
              {autoMerge.enabled
                ? `${autoMerge.cleanup ? "Auto-merge & Cleanup" : "Auto-merge"} is on: merges as soon as GitHub reports it ready. Click to turn off.`
                : "Merge this PR automatically once it is ready, resolving conflicts as needed"}
            </p>
            {hold ? (
              <p className="text-xs text-muted-foreground">
                {autoMerge.enabled ? "Waiting: " : "Not ready yet: "}
                {hold.message}
              </p>
            ) : null}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
