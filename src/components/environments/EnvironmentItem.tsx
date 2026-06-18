import { useState, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Trash2, Play, Square, Container, Laptop, Shield, Globe, Settings2, RotateCw, Loader2, Network, Copy } from "lucide-react";
import { toast } from "sonner";
import type { Environment } from "@/types";
import { useAgentActivityStore, useEnvironmentStore, useEnvironmentDiffStore, useBuildPipelineStore } from "@/stores";
import { EnvironmentSettingsDialog } from "./EnvironmentSettingsDialog";
import { cn } from "@/lib/utils";
import * as tauri from "@/lib/tauri";
import { getEnvironmentPortAddress } from "@/lib/environment-address";

interface EnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onUpdate?: (environment: Environment) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
}

export function EnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  isMultiSelectMode = false,
  isChecked = false,
}: EnvironmentItemProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  // Local state to track transitioning - ensures spinner shows immediately
  const [isLocalTransitioning, setIsLocalTransitioning] = useState(false);

  // Get Claude activity state for this environment
  // For terminal-based Claude, state is keyed by containerId
  // For native Claude mode, state is keyed by environmentId
  const containerStates = useAgentActivityStore((s) => s.containerStates);
  const agentActivityState =
    containerStates[environment.id] ||  // Check by environmentId first (native mode)
    (environment.containerId ? containerStates[environment.containerId] : null) ||  // Then by containerId (terminal mode)
    "idle";

  // Check if this environment is being deleted
  const isEnvironmentDeleting = useEnvironmentStore((s) => s.isDeleting(environment.id));

  // Get diff stats for this environment
  const diffStats = useEnvironmentDiffStore((s) => s.stats.get(environment.id));

  // Check if this is a build pipeline environment (O(1) Set lookup, stable reference)
  const isBuildEnvironment = useBuildPipelineStore((s) => s.buildEnvironmentIds.has(environment.id));

  const isLocalEnvironment = environment.environmentType === "local";
  // Local environments are always considered "running" - they exist or they don't
  const isRunning = isLocalEnvironment || environment.status === "running";
  const isCreating = environment.status === "creating";
  const isStopping = environment.status === "stopping";
  // Use local state OR prop status for transitioning (not applicable for local environments)
  const isTransitioning = !isLocalEnvironment && (isLocalTransitioning || isCreating || isStopping);

  // Clear local transitioning state when environment status changes to non-transitioning
  useEffect(() => {
    if (!isCreating && !isStopping && isLocalTransitioning) {
      setIsLocalTransitioning(false);
    }
  }, [environment.status, isCreating, isStopping, isLocalTransitioning]);

  const confirmDelete = () => {
    onDelete(environment.id);
    setShowDeleteDialog(false);
  };

  const handleEnvironmentUpdate = (updated: Environment) => {
    // Set local transitioning state for immediate spinner feedback
    if (updated.status === "creating" || updated.status === "stopping") {
      setIsLocalTransitioning(true);
    } else {
      setIsLocalTransitioning(false);
    }
    onUpdate?.(updated);
  };

  // Get network mode with null safety (defaults to "restricted")
  const networkMode = environment.networkAccessMode ?? "restricted";

  const handleCheckboxChange = () => {
    // Toggle individual item selection (Cmd/Ctrl+Click behavior)
    onSelect(environment.id, { metaKey: true });
  };

  const handleSelect = (modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => {
    onSelect(environment.id, modifiers);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Pass modifier key states to parent for multi-select handling
    // metaKey covers Cmd on Mac, ctrlKey covers Ctrl on Windows/Linux
    handleSelect({
      shiftKey: e.shiftKey,
      metaKey: e.metaKey || e.ctrlKey
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // For keyboard navigation, we don't have modifier key context
      // Default behavior is simple selection
      handleSelect({
        shiftKey: e.shiftKey,
        metaKey: e.metaKey || e.ctrlKey
      });
    }
  };

  const localAddress = getEnvironmentPortAddress(environment);
  const initialPrompt = environment.initialPrompt?.trim();

  const copyAddress = () => {
    if (!localAddress) return;
    navigator.clipboard.writeText(localAddress).then(() => {
      toast.success("Copied address", { description: localAddress });
    }).catch(() => {
      toast.error("Failed to copy address");
    });
  };

  const copyInitialPrompt = () => {
    if (!initialPrompt) return;
    navigator.clipboard.writeText(initialPrompt).then(() => {
      toast.success("Initial prompt copied to clipboard");
    }).catch(() => {
      toast.error("Failed to copy initial prompt");
    });
  };

  const createdDate = new Date(environment.createdAt).toLocaleDateString();

  return (
    <>
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-2 py-1.5 pr-2 text-left text-[13px] transition-colors",
                  isSelected && !isMultiSelectMode
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  isChecked && isMultiSelectMode && "bg-zinc-800/50",
                  (isStopping || isEnvironmentDeleting) && "opacity-60"
                )}
              >
                {isEnvironmentDeleting ? (
                  // Show red spinner when deleting (priority over multi-select checkbox)
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
                ) : isMultiSelectMode ? (
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={handleCheckboxChange}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 shrink-0"
                  />
                ) : isTransitioning ? (
                  // Show spinner when creating/stopping
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
                ) : (
                  // Show Laptop for local environments, Container for containerized
                  environment.environmentType === "local" ? (
                    <Laptop className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      !isRunning && "text-muted-foreground",
                      isRunning && agentActivityState === "waiting" && "text-amber-500 animate-pulse",
                      isRunning && agentActivityState === "working" && "text-blue-500 animate-pulse",
                      isRunning && agentActivityState === "idle" && "text-green-500"
                    )} />
                  ) : (
                    <Container className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      !isRunning && "text-muted-foreground",
                      isRunning && agentActivityState === "waiting" && "text-amber-500 animate-pulse",
                      isRunning && agentActivityState === "working" && "text-blue-500 animate-pulse",
                      isRunning && agentActivityState === "idle" && "text-green-500"
                    )} />
                  )
                )}
                <span className={cn("flex-1 truncate font-medium", isBuildEnvironment && "text-yellow-400")}>
                  {isBuildEnvironment ? environment.name.replace(/^Build:\s*/, "") : environment.name}
                </span>
                {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0 || diffStats.filesChanged > 0) && (
                  <span className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
                    {diffStats.additions > 0 && (
                      <span className="text-green-500">+{diffStats.additions}</span>
                    )}
                    {diffStats.deletions > 0 && (
                      <span className="text-red-400">-{diffStats.deletions}</span>
                    )}
                    {diffStats.additions === 0 && diffStats.deletions === 0 && diffStats.filesChanged > 0 && (
                      <span className="text-muted-foreground">{diffStats.filesChanged}F</span>
                    )}
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" sideOffset={4}>
            <div className="space-y-1">
              <p className="font-medium">{environment.name}</p>
              <p className="text-xs text-muted-foreground">Created: {createdDate}</p>
              {isLocalEnvironment ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Laptop className="h-3 w-3" />
                  Local worktree
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {networkMode === "full" ? (
                    <>
                      <Globe className="h-3 w-3" />
                      Full network access
                    </>
                  ) : (
                    <>
                      <Shield className="h-3 w-3" />
                      Restricted network
                    </>
                  )}
                </p>
              )}
              {!isLocalEnvironment && environment.entryPort && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Network className="h-3 w-3" />
                  {environment.hostEntryPort
                    ? <>Port: <span
                        role="button"
                        className="underline decoration-dotted cursor-pointer hover:text-foreground transition-colors"
                        onClick={(e) => { e.stopPropagation(); copyAddress(); }}
                      >localhost:{environment.hostEntryPort}</span> → {environment.entryPort}/tcp</>
                    : <>Port: {environment.entryPort}/tcp (not mapped)</>
                  }
                </p>
              )}
              {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0 || diffStats.filesChanged > 0) && (
                <div className="border-t border-border/50 pt-1 mt-1">
                  <p className="text-xs text-muted-foreground">
                    {diffStats.filesChanged} file{diffStats.filesChanged !== 1 ? "s" : ""} changed
                  </p>
                  <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                    {diffStats.additions > 0 && (
                      <span className="text-green-500">+{diffStats.additions} added</span>
                    )}
                    {diffStats.deletions > 0 && (
                      <span className="text-red-400">-{diffStats.deletions} removed</span>
                    )}
                  </div>
                </div>
              )}
              {environment.prUrl && (
                <p className="text-xs text-blue-400">PR: {environment.prUrl}</p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setShowSettingsDialog(true)}>
            <Settings2 className="h-4 w-4 mr-2" />
            Settings
          </ContextMenuItem>
          {localAddress && (
            <ContextMenuItem onClick={copyAddress}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Address
            </ContextMenuItem>
          )}
          {initialPrompt && (
            <ContextMenuItem onClick={copyInitialPrompt}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Initial Prompt
            </ContextMenuItem>
          )}
          {/* Start/Stop/Restart only applicable for containerized environments */}
          {!isLocalEnvironment && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => isRunning ? onStop(environment.id) : onStart(environment.id)} disabled={isTransitioning}>
                {isRunning ? (
                  <>
                    <Square className="h-4 w-4 mr-2" />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Start
                  </>
                )}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRestart(environment.id)} disabled={!isRunning || isTransitioning}>
                <RotateCw className="h-4 w-4 mr-2" />
                Restart
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Environment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{environment.name}</strong>?
              {isLocalEnvironment ? (
                <span className="block mt-2 text-orange-500">
                  This will delete the git worktree from your machine.
                </span>
              ) : (
                isRunning && (
                  <span className="block mt-2 text-orange-500">
                    Warning: This environment is currently running. It will be stopped before deletion.
                  </span>
                )
              )}
              {environment.prUrl && (
                <span className="block mt-2">
                  This environment has an associated PR that will remain open.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Environment Settings Dialog */}
      <EnvironmentSettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
        environment={environment}
        onUpdate={handleEnvironmentUpdate}
        onRestart={tauri.recreateEnvironment}
      />
    </>
  );
}
