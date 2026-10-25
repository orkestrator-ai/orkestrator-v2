import { useCallback } from "react";
import { PanelRight } from "lucide-react";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { PullRequestView } from "@/components/pull-requests";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { PullRequestOpenerProvider } from "@/lib/pull-request-opener";
import { cn } from "@/lib/utils";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PullRequestTabData } from "@/types/paneLayout";

interface PullRequestPaneTabProps {
  tabId: string;
  environmentId: string;
  data: PullRequestTabData;
  isActive: boolean;
}

/** A pull request opened in the main area (expanded from the files panel). */
export function PullRequestPaneTab({
  tabId,
  environmentId,
  data,
  isActive,
}: PullRequestPaneTabProps) {
  const terminal = useOptionalTerminalContext();

  const closeTab = useCallback(() => {
    const layout = usePaneLayoutStore.getState();
    const owner = layout.findPaneWithTab(tabId, environmentId);
    if (owner) layout.removeTab(owner.id, tabId, environmentId);
  }, [environmentId, tabId]);

  const moveToSidebar = useCallback(() => {
    useFilesPanelStore.getState().openPullRequest(environmentId, data.ref, data.view);
    closeTab();
  }, [closeTab, data.ref, data.view, environmentId]);

  // Pull requests linked from this one open as further tabs beside it.
  const open = useCallback(
    (ref: GitHubPullRequestRef, view?: GitHubPullRequestViewTab) => {
      terminal?.createTab?.("pull-request", { pullRequest: { ref, view } });
    },
    [terminal],
  );

  return (
    <div
      className={cn(
        "absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      <PullRequestOpenerProvider open={open}>
        <PullRequestView
          key={data.openRequest ?? 0}
          className="min-h-0 flex-1"
          pullRequest={data.ref}
          initialView={data.view}
          layout="page"
          active={isActive}
          onSummaryLoaded={(summary) =>
            usePaneLayoutStore
              .getState()
              .updateTabPullRequest(tabId, { title: summary.title }, environmentId)
          }
          headerActions={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Move to sidebar"
                  onClick={moveToSidebar}
                >
                  <PanelRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move to sidebar</TooltipContent>
            </Tooltip>
          }
        />
      </PullRequestOpenerProvider>
    </div>
  );
}
