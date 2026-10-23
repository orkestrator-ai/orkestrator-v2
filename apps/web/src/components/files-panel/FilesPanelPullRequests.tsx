import { useCallback, useMemo } from "react";
import { Maximize2 } from "lucide-react";
import {
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { PullRequestList, PullRequestView } from "@/components/pull-requests";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { PullRequestOpenerProvider } from "@/lib/pull-request-opener";
import { useEnvironmentStore, useFilesPanelStore, useUIStore } from "@/stores";
import type { FilesPanelPullRequestTab } from "@/stores/filesPanelStore";

const EMPTY_TABS: FilesPanelPullRequestTab[] = [];

/** The project whose pull requests the panel lists for its current target. */
function useFilesPanelProject(): { projectId: string | null; environmentPrUrl: string | null } {
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const environment = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? (state.environments.find((candidate) => candidate.id === selectedEnvironmentId) ?? null)
      : null,
  );
  return {
    projectId: environment?.projectId ?? selectedProjectId ?? null,
    environmentPrUrl: environment?.prUrl ?? null,
  };
}

export function useFilesPanelPullRequestTabs(targetId: string | null): FilesPanelPullRequestTab[] {
  return useFilesPanelStore((state) =>
    targetId ? (state.pullRequestTabs[targetId] ?? EMPTY_TABS) : EMPTY_TABS,
  );
}

/**
 * Body of the panel's pull request tabs: the project's list, or one open pull
 * request. Pull requests opened from inside either (links in a description or
 * comment) open as further tabs of the same target.
 */
export function FilesPanelPullRequests({ targetId }: { targetId: string | null }) {
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const openPullRequest = useFilesPanelStore((state) => state.openPullRequest);
  const closePullRequest = useFilesPanelStore((state) => state.closePullRequest);
  const updatePullRequestTab = useFilesPanelStore((state) => state.updatePullRequestTab);
  const tabs = useFilesPanelPullRequestTabs(targetId);
  const { projectId, environmentPrUrl } = useFilesPanelProject();
  const terminal = useOptionalTerminalContext();

  const activeKey = activeTab.startsWith("pull-request:")
    ? activeTab.slice("pull-request:".length)
    : null;
  const active = activeKey ? tabs.find((tab) => tab.key === activeKey) : undefined;
  const environmentPullRequestNumber = useMemo(
    () => (environmentPrUrl ? parseGitHubPullRequestLink(environmentPrUrl)?.number : undefined),
    [environmentPrUrl],
  );

  const open = useCallback(
    (ref: GitHubPullRequestRef, view?: Parameters<typeof openPullRequest>[2]) => {
      if (targetId) openPullRequest(targetId, ref, view);
    },
    [openPullRequest, targetId],
  );

  // Moving a pull request into the main area needs the environment's panes.
  const canExpand = Boolean(terminal?.createTab) && !targetId?.startsWith("project-root:");
  const expand = useCallback(
    (tab: FilesPanelPullRequestTab) => {
      if (!targetId) return;
      const created = terminal?.createTab?.("pull-request", {
        pullRequest: { ref: tab.ref, view: tab.view },
      });
      if (created) closePullRequest(targetId, tab.key);
    },
    [closePullRequest, targetId, terminal],
  );

  if (!targetId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select a project or environment to see its pull requests.
      </div>
    );
  }

  return (
    <PullRequestOpenerProvider open={open}>
      {active ? (
        <PullRequestView
          // A new open request re-applies the requested view to a mounted tab.
          key={`${active.key}:${active.openRequest}`}
          className="min-h-0 flex-1"
          pullRequest={active.ref}
          initialView={active.view}
          layout="sidebar"
          onSummaryLoaded={(summary) => updatePullRequestTab(targetId, active.key, summary)}
          headerActions={
            canExpand ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Open in main area"
                    onClick={() => expand(active)}
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open in main area</TooltipContent>
              </Tooltip>
            ) : undefined
          }
        />
      ) : projectId ? (
        <PullRequestList
          className="min-h-0 flex-1"
          projectId={projectId}
          layout="sidebar"
          highlightNumber={environmentPullRequestNumber}
          onOpenPullRequest={(ref) => open(ref)}
        />
      ) : (
        <div className="p-4 text-sm text-muted-foreground">
          Select a project to see its pull requests.
        </div>
      )}
    </PullRequestOpenerProvider>
  );
}
