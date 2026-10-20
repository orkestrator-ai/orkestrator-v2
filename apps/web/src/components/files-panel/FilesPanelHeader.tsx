import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { X, RefreshCw } from "lucide-react";
import { useFilesPanelStore } from "@/stores";
import type { FilesPanelTab } from "@/stores";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";

interface FilesPanelHeaderProps {
  onRefresh: () => void;
  /** Environment whose change projection counts the Changes tab. */
  changeEnvironmentId?: string | null;
}

export function FilesPanelHeader({ onRefresh, changeEnvironmentId }: FilesPanelHeaderProps) {
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

  return (
    <div className="flex h-12 items-center justify-between border-b border-border/80 bg-chrome px-3">
      {/* Tab switcher */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FilesPanelTab)}>
        {/*
          The list itself is unpainted: only the selected tab carries a surface,
          so the pair reads as one label plus one alternative rather than as a
          segmented control competing with the header band behind it.
        */}
        <TabsList className="h-8 gap-1 bg-transparent p-0">
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
        </TabsList>
      </Tabs>

      {/* Action icons */}
      <div className="flex items-center gap-1">
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
