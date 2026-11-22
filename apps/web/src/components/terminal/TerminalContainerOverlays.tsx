import { lazy, useState, type MouseEvent } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { LazyLaunchPromptPending } from "@/components/native-agent/LazyLaunchPromptPending";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FilePlus2, Play, Terminal as TerminalIcon } from "lucide-react";
import { InitializationLogs } from "./InitializationLogs";
import { LazyLoadBoundary, LazyLoadInlineErrorFallback } from "@/components/LazyLoadBoundary";
import type { EnvironmentLifecycleRemedy } from "@orkestrator/protocol/contract/domains/environments";
import { StartFailureNotice } from "./StartFailureNotice";

// Shown only after a failed setup, and it renders a transcript message.
const LazySetupPendingOverlay = lazy(async () => ({
  default: (await import("@/components/setup/SetupPendingOverlay")).SetupPendingOverlay,
}));

type SetupPhase = "pending" | "running" | "ready" | "failed";

interface TerminalContainerOverlaysProps {
  environmentId: string;
  containerId: string | null;
  isLocalEnvironment: boolean;
  isEnvironmentRunning: boolean;
  showNoEnvironmentOverlay: boolean;
  showCreatingOverlay: boolean;
  showNotRunningOverlay: boolean;
  /** Why the last start failed, from the environment record; null when it did not. */
  lifecycleError?: string | null;
  lifecycleRemedy?: EnvironmentLifecycleRemedy | null;
  projectId?: string | null;
  setupPhase: SetupPhase;
  createScriptPrompt: string;
  onStartContainer?: () => void;
  onCreateScript?: (initialPrompt: string) => void;
  onStartOverlayClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A launch's opening prompt, drawn while the environment is created; "" when none. */
  launchPrompt?: string;
  launchAgent?: AgentPlatform;
}

export function TerminalContainerOverlays({
  environmentId,
  containerId,
  isLocalEnvironment,
  isEnvironmentRunning,
  showNoEnvironmentOverlay,
  showCreatingOverlay,
  showNotRunningOverlay,
  lifecycleError = null,
  lifecycleRemedy = null,
  projectId = null,
  setupPhase,
  createScriptPrompt,
  onStartContainer,
  onCreateScript,
  onStartOverlayClick,
  launchPrompt = "",
  launchAgent,
}: TerminalContainerOverlaysProps) {
  const [showContainerLogs, setShowContainerLogs] = useState(false);
  const creatingWithPrompt = showCreatingOverlay && launchPrompt !== "";
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

      {showCreatingOverlay && containerId && (!creatingWithPrompt || showContainerLogs) && (
        <div className="absolute inset-0 bg-background">
          <InitializationLogs containerId={containerId} className="h-full" />
        </div>
      )}

      {showCreatingOverlay && isLocalEnvironment && !containerId && !creatingWithPrompt && (
        <CreatingWorktree />
      )}

      {/*
        A launch with an opening prompt keeps it on screen while the workspace is
        created, laid out as the agent tab that will replace it. Container logs
        stay one click away.
      */}
      {creatingWithPrompt && !showContainerLogs && (containerId || isLocalEnvironment) && (
        <div className="absolute inset-0 bg-background">
          <LazyLaunchPromptPending
            environmentId={environmentId}
            platform={launchAgent}
            prompt={launchPrompt}
            stage={containerId ? "starting-container" : "creating-worktree"}
            detail={
              containerId ? (
                <button
                  type="button"
                  className="rounded-sm text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-hairline focus-hairline-outset"
                  onClick={() => setShowContainerLogs(true)}
                >
                  View container logs
                </button>
              ) : undefined
            }
            fallback={
              containerId ? (
                <InitializationLogs containerId={containerId} className="h-full" />
              ) : (
                <CreatingWorktree />
              )
            }
          />
        </div>
      )}

      {showNotRunningOverlay && (
        <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-background p-4">
          <div className="w-full text-center">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-50" />
            <p className="mb-4 text-muted-foreground">
              {isLocalEnvironment ? "Environment not started" : "Container is not running"}
            </p>
            {lifecycleError && (
              <StartFailureNotice
                message={lifecycleError}
                remedy={lifecycleRemedy}
                projectId={projectId}
                onRetry={onStartContainer}
              />
            )}
            {onStartContainer && (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <span className="inline-flex">
                    <Button onClick={onStartOverlayClick} variant="outline">
                      <Play className="mr-2 h-4 w-4" />
                      {isLocalEnvironment ? "Start environment" : "Start container"}
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
                    Create script
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
          </div>
        </div>
      )}

      {/* Laid-out tab content is z-10, so recovery must sit above it or a tab's own setup overlay shows through. */}
      {setupPhase === "failed" && isEnvironmentRunning && (
        <div className="absolute inset-0 z-20 bg-background">
          <LazyLoadBoundary renderError={(details) => <LazyLoadInlineErrorFallback {...details} />}>
            <LazySetupPendingOverlay
              environmentId={environmentId}
              setupPhase={setupPhase}
              subtext="Retry setup, or skip it to continue with the current workspace."
            />
          </LazyLoadBoundary>
        </div>
      )}
    </>
  );
}

function CreatingWorktree() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="text-center text-muted-foreground">
        <TerminalIcon className="mx-auto mb-4 h-12 w-12 opacity-50 animate-pulse" />
        <p>Creating worktree...</p>
      </div>
    </div>
  );
}
