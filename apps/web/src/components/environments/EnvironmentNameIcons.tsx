import { GitMerge } from "lucide-react";
import type { PrState } from "@orkestrator/protocol/pr-monitor";
import { PipeIcon } from "@/components/icons/PipeIcon";
import { PullRequestStateIcon } from "@/components/pull-requests/PullRequestStateIcon";

/**
 * The icons that follow an environment's name: the build-pipeline pipe, then
 * the merged pull request or, until it merges, the auto-merge marker.
 *
 * Both row components render this — `EnvironmentItem` for this window's own
 * machine and `RemoteEnvironmentItem` for another machine's rows seen through
 * a command node — so a row shows the same icons however it is reached. Add a
 * new name icon here, with its field in `NodeEnvironmentSummary`, rather than
 * in either row.
 */
export function EnvironmentNameIcons({
  buildPipeline,
  prState,
  autoMerge,
}: {
  buildPipeline: boolean;
  prState: PrState | null | undefined;
  autoMerge: boolean;
}) {
  return (
    <>
      {buildPipeline && <PipeIcon className="h-3 w-3 shrink-0 translate-y-px text-white" />}
      {prState === "merged" ? (
        <PullRequestStateIcon state="merged" isDraft={false} className="h-3 w-3 translate-y-px" />
      ) : (
        autoMerge && (
          <GitMerge
            className="h-3 w-3 shrink-0 translate-y-px text-white"
            role="img"
            aria-label="Auto-merge on"
            data-testid="environment-auto-merge-icon"
          />
        )
      )}
    </>
  );
}
