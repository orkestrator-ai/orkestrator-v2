import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { X, RefreshCw } from "lucide-react";
import { useFilesPanelStore } from "@/stores";
import { useFilesPanel } from "@/hooks";
import type { FilesPanelTab } from "@/stores";

export function FilesPanelHeader() {
  const { activeTab, setActiveTab, changes, closePanel, isLoadingChanges, isLoadingTree } =
    useFilesPanelStore();
  const { refresh } = useFilesPanel();
  const changesCount = changes.length;
  const isLoading = activeTab === "changes" ? isLoadingChanges : isLoadingTree;

  return (
    <div className="flex h-12 items-center justify-between border-b border-border/80 bg-zinc-800/60 px-3">
      {/* Tab switcher */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as FilesPanelTab)}
      >
        <TabsList className="h-8 bg-zinc-900/80">
          <TabsTrigger value="changes" className="px-2 text-xs data-[state=active]:!bg-zinc-800">
            Changes
            {changesCount > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                {changesCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="all-files" className="px-2 text-xs data-[state=active]:!bg-zinc-800">
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
              onClick={refresh}
              disabled={isLoading}
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
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
