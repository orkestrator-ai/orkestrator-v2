import { useCallback } from "react";
import { PanelRight } from "lucide-react";
import { PullRequestView } from "@/components/pull-requests";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNodeScope } from "@/lib/node-scope/providers";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
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
  // The environment's node keeps its pane layout (plan item 3013).
  const paneLayouts = useNodeScope().store(paneLayoutStore);
  const closeTab = useCallback(() => {
    const layout = paneLayouts.getState();
    const owner = layout.findPaneWithTab(tabId, environmentId);
    if (owner) layout.removeTab(owner.id, tabId, environmentId);
  }, [environmentId, paneLayouts, tabId]);

  // The environment's node keeps its files panel tabs.
  const filesPanel = useNodeScope().store(filesPanelStore);
  const moveToSidebar = useCallback(() => {
    filesPanel.getState().openPullRequest(environmentId, data.ref, data.view);
    closeTab();
  }, [closeTab, data.ref, data.view, environmentId, filesPanel]);

  return (
    <div
      className={cn(
        "absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      {/* Pull requests linked from this one open in the right-hand PR pane
          (the default opener), so this tab stays the one in view. */}
      <PullRequestView
        key={data.openRequest ?? 0}
        className="min-h-0 flex-1"
        pullRequest={data.ref}
        initialView={data.view}
        layout="page"
        active={isActive}
        onSummaryLoaded={(summary) =>
          paneLayouts
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
    </div>
  );
}
