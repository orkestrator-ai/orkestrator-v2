import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FilePlus2, Play, Terminal as TerminalIcon } from "lucide-react";
import { InitializationLogs } from "./InitializationLogs";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";

type SetupPhase = "pending" | "running" | "ready" | "failed";

interface TerminalContainerOverlaysProps {
  environmentId: string;
  containerId: string | null;
  isLocalEnvironment: boolean;
  isEnvironmentRunning: boolean;
  showNoEnvironmentOverlay: boolean;
  showCreatingOverlay: boolean;
  showNotRunningOverlay: boolean;
  setupPhase: SetupPhase;
  createScriptPrompt: string;
  onStartContainer?: () => void;
  onCreateScript?: (initialPrompt: string) => void;
  onStartOverlayClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function TerminalContainerOverlays({
  environmentId,
  containerId,
  isLocalEnvironment,
  isEnvironmentRunning,
  showNoEnvironmentOverlay,
  showCreatingOverlay,
  showNotRunningOverlay,
  setupPhase,
  createScriptPrompt,
  onStartContainer,
  onCreateScript,
  onStartOverlayClick,
}: TerminalContainerOverlaysProps) {
  return (
    <>
      {showNoEnvironmentOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center text-muted-foreground">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p>Select an environment from the sidebar to get started.</p>
          </div>
        </div>
      )}

      {showCreatingOverlay && containerId && (
        <div className="absolute inset-0 bg-background">
          <InitializationLogs containerId={containerId} className="h-full" />
        </div>
      )}

      {showCreatingOverlay && isLocalEnvironment && !containerId && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center text-muted-foreground">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 opacity-50 animate-pulse" />
            <p>Creating worktree...</p>
          </div>
        </div>
      )}

      {showNotRunningOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-50" />
            <p className="mb-4 text-muted-foreground">
              {isLocalEnvironment ? "Environment not started" : "Container is not running"}
            </p>
            {onStartContainer && (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <span className="inline-flex">
                    <Button onClick={onStartOverlayClick} variant="outline">
                      <Play className="mr-2 h-4 w-4" />
                      {isLocalEnvironment ? "Start Environment" : "Start Container"}
                    </Button>
                  </span>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={onStartContainer}>
                    <Play className="mr-2 h-4 w-4" />
                    Start
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => onCreateScript?.(createScriptPrompt)}
                    disabled={!onCreateScript}
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Create Script
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
          </div>
        </div>
      )}

      {setupPhase === "failed" && isEnvironmentRunning && (
        <div className="absolute inset-0 bg-background">
          <SetupPendingOverlay
            environmentId={environmentId}
            setupPhase={setupPhase}
            subtext="Retry setup, or skip it to continue with the current workspace."
          />
        </div>
      )}
    </>
  );
}
