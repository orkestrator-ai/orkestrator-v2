import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { X, RefreshCw, GitPullRequest } from "lucide-react";
import { useFilesPanelStore } from "@/stores";
import type { FilesPanelTab } from "@/stores";
import { isFilesPanelFileTab } from "@/stores/filesPanelStore";
import { PullRequestStateIcon } from "@/components/pull-requests";
import { useFilesPanelPullRequestTabs } from "./FilesPanelPullRequests";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";

interface FilesPanelHeaderProps {
  onRefresh: () => void;
  /** Environment whose change projection counts the Changes tab. */
  changeEnvironmentId?: string | null;
  /** Panel target whose pull request tabs are shown. */
  targetId?: string | null;
}

const TAB_TRIGGER_CLASS =
  "rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=active]:!bg-elevated data-[state=active]:!text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent";

export function FilesPanelHeader({
  onRefresh,
  changeEnvironmentId,
  targetId = null,
}: FilesPanelHeaderProps) {
  const closePullRequest = useFilesPanelStore((state) => state.closePullRequest);
  const pullRequestTabs = useFilesPanelPullRequestTabs(targetId);
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const setActiveTab = useFilesPanelStore((state) => state.setActiveTab);
  const changes = useFilesPanelStore((state) => state.changes);
  const closePanel = useFilesPanelStore((state) => state.closePanel);
  const isLoadingChanges = useFilesPanelStore((state) => state.isLoadingChanges);
  const isLoadingTree = useFilesPanelStore((state) => state.isLoadingTree);
  const changeProjection = useEnvironmentChangeProjection(changeEnvironmentId);
  // The backend's changed-file count when it measures the environment (an
  // unknown count shows "?", never 0); the legacy list's length otherwise.
  const changesCount: number | "?" | null = changeProjection
    ? (changeProjection.counters.changedFiles ?? (changeProjection.badge.visible ? "?" : null))
    : changes.length;
  const isLoading = activeTab === "changes" ? isLoadingChanges : isLoadingTree;
  // A pull request tab of another target falls back to this target's list.
  const shownTab: FilesPanelTab =
    activeTab.startsWith("pull-request:") &&
    !pullRequestTabs.some((tab) => activeTab === `pull-request:${tab.key}`)
      ? "pull-requests"
      : activeTab;

  return (
    <div className="flex h-12 items-center justify-between gap-2 border-b border-border/80 bg-chrome px-3">
      {/* Tab switcher */}
      <Tabs
        value={shownTab}
        onValueChange={(v) => setActiveTab(v as FilesPanelTab)}
        className="min-w-0"
      >
        {/*
          The list itself is unpainted: only the selected tab carries a surface,
          so the pair reads as one label plus one alternative rather than as a
          segmented control competing with the header band behind it.
        */}
        <TabsList className="h-8 max-w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none]">
          <TabsTrigger
            value="changes"
            className="rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=active]:!bg-elevated data-[state=active]:!text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent"
          >
            Changes
            {changesCount !== null && (changesCount === "?" || changesCount > 0) && (
              <span className="ml-1.5 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground">
                {changesCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="all-files"
            className="rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=active]:!bg-elevated data-[state=active]:!text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent"
          >
            All files
          </TabsTrigger>
          <TabsTrigger value="pull-requests" className={TAB_TRIGGER_CLASS} title="Pull requests">
            <GitPullRequest className="size-3.5" />
            PRs
          </TabsTrigger>
          {pullRequestTabs.map((tab) => {
            const label = `${tab.ref.owner}/${tab.ref.repo} #${tab.ref.number}${tab.title ? ` · ${tab.title}` : ""}`;
            return (
              <div key={tab.key} className="group relative flex shrink-0 items-center">
                <TabsTrigger
                  value={`pull-request:${tab.key}`}
                  className={`${TAB_TRIGGER_CLASS} gap-1 pr-6`}
                  title={label}
                >
                  {tab.state ? (
                    <PullRequestStateIcon
                      state={tab.state}
                      isDraft={tab.isDraft ?? false}
                      className="size-3.5"
                    />
                  ) : (
                    <GitPullRequest className="size-3.5" />
                  )}
                  #{tab.ref.number}
                </TabsTrigger>
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => targetId && closePullRequest(targetId, tab.key)}
                  className="absolute right-1 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-white/10 hover:text-foreground hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Action icons */}
      <div className="flex shrink-0 items-center gap-1">
        {isFilesPanelFileTab(shownTab) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRefresh}
                disabled={isLoading}
                aria-label="Refresh"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={closePanel}
              aria-label="Close panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close panel</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
