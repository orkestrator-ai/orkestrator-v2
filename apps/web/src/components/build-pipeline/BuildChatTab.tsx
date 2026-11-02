import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  isActiveBuildPhase,
  REVIEW_PACKAGE_SESSION_LABEL,
  reviewValidationStage,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { BuildTabData } from "@/types/paneLayout";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { useMediaQuery } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { findNativeAgentAdapter } from "@/components/native-agent/adapter";
import { BuildCompletionStatus } from "./BuildCompletionStatus";
import { PipelineFlowView } from "./PipelineFlowView";
import { PipelineKeyInformationButton } from "./PipelineKeyInformation";
import { usePipelineControls } from "./usePipelineControls";

interface BuildChatTabProps {
  data: BuildTabData;
  /** This tab is the visible one in its pane. Drives transcript scroll state. */
  isActive?: boolean;
  /**
   * This tab's pane also holds the layout focus. Document-level shortcuts —
   * Cmd+F for the in-transcript find — are claimed on this and not on
   * visibility, because a split layout shows several panes at once and only the
   * focused one may answer the keyboard.
   */
  ownsGlobalShortcuts?: boolean;
  /** Forces the graph's layout; otherwise the measured width decides. */
  layout?: "graph" | "stacked";
}

const PHASE_LABELS: Record<string, string> = {
  "creating-environment": "Creating environment",
  "starting-environment": "Starting environment",
  "waiting-for-setup": "Running setup",
  building: "Building",
  reviewing: "Reviewing",
  addressing: "Addressing review",
  verifying: "Verifying",
  fixing: "Fixing",
  "creating-pr": "Creating pull request",
  "resolving-conflicts": "Resolving conflicts",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
};

const RETRY_STAGE_LABELS: Record<ResumableBuildPhase, string> = {
  "creating-environment": "Retry Environment Creation",
  "starting-environment": "Retry Environment Start",
  "waiting-for-setup": "Retry Setup",
  building: "Retry Build Stage",
  reviewing: "Retry Review Stage",
  addressing: "Retry Address Stage",
  verifying: "Retry Verification Stage",
  fixing: "Retry Fix Stage",
  "creating-pr": "Retry PR Stage",
  "resolving-conflicts": "Retry Conflict Resolution",
};

/** Phases that run an agent stage, which is what the header's restart replaces. */
const RESTART_STAGE_LABELS: Partial<Record<ResumableBuildPhase, string>> = {
  building: "Restart Build Stage",
  reviewing: "Restart Review Stage",
  addressing: "Restart Address Stage",
  verifying: "Restart Verification Stage",
  fixing: "Restart Fix Stage",
  "creating-pr": "Restart PR Stage",
  "resolving-conflicts": "Restart Conflict Resolution",
};

/** Viewports narrower than this get the compact header. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * A build pipeline: its header and controls, then the pipeline as a flow
 * graph across the top with an inspector for the selected step below.
 */
export function BuildChatTab({
  data,
  isActive = false,
  ownsGlobalShortcuts = isActive,
  layout,
}: BuildChatTabProps) {
  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(data.pipelineId));
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  // Distinguishes "the user picked this step" from "we follow the pipeline".
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const controls = usePipelineControls(pipeline, () => setPinnedId(null));
  const hydrationAttemptedFor = useRef<string | null>(null);
  // The flow view renders the step count, elapsed time and graph toggle here.
  const [progressSlot, setProgressSlot] = useState<HTMLSpanElement | null>(null);
  const [graphToggleSlot, setGraphToggleSlot] = useState<HTMLDivElement | null>(null);

  // The store is a cache of a backend-owned record, and the only other loader
  // is App's one-shot per-project hydration. If that failed or has not run for
  // this project, the tab would otherwise sit on "Loading build pipeline…"
  // forever, so fetch the authoritative snapshot on mount.
  useEffect(() => {
    if (pipeline || hydrationAttemptedFor.current === data.pipelineId) return;
    hydrationAttemptedFor.current = data.pipelineId;
    void hydrateBuildPipeline(data.pipelineId).catch((error) => {
      console.warn("[BuildChatTab] Failed to hydrate build pipeline:", error);
    });
  }, [data.pipelineId, pipeline]);

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading build pipeline…
      </div>
    );
  }

  const phaseLabel = PHASE_LABELS[pipeline.phase] ?? pipeline.phase;
  const active = !["paused", "complete", "failed"].includes(pipeline.phase);
  const interactionFailure =
    pipeline.phase === "failed" && pipeline.failureContext?.kind === "interactive-request";
  const canRetryStage =
    pipeline.phase === "failed" && Boolean(pipeline.failureContext) && !interactionFailure;
  // A paused pipeline's stage is the one it paused in; resuming via restart
  // must not jump anywhere else.
  const currentStagePhase =
    pipeline.phase === "paused"
      ? pipeline.pausedFromPhase
      : isActiveBuildPhase(pipeline.phase)
        ? (pipeline.phase as ResumableBuildPhase)
        : undefined;
  const validationRestartTarget = reviewValidationStage(pipeline, currentStagePhase);
  const currentStageSession = pipeline.sessions[pipeline.currentSessionIndex];
  const dedicatedPreparationRunning =
    (currentStagePhase === "building" || currentStagePhase === "fixing") &&
    currentStageSession?.phase === (currentStagePhase === "building" ? "build" : "fix") &&
    currentStageSession.label === REVIEW_PACKAGE_SESSION_LABEL;
  const restartCurrentStageLabel =
    validationRestartTarget === "validation"
      ? "Restart Validation"
      : validationRestartTarget === "review-package" || dedicatedPreparationRunning
        ? "Restart Review Preparation"
        : currentStagePhase
          ? RESTART_STAGE_LABELS[currentStagePhase]
          : undefined;
  const canRestartCurrentStage =
    Boolean(restartCurrentStageLabel) &&
    pipeline.sessions.length > 0 &&
    Boolean(pipeline.environmentId);
  // The header names the build agent; each stage's own harness is on its node.
  const agentLabel = findNativeAgentAdapter(pipeline.agentType)?.label ?? pipeline.agentType;
  // The banner asserts the stage "is still running", so it belongs to an active
  // pipeline only. The backend clears the warning on every terminal and paused
  // transition; gating here as well keeps a snapshot written by an older build
  // from making that claim about a stopped one.
  const showStallWarning = active && Boolean(pipeline.stallWarning);
  const stalledSession = showStallWarning
    ? pipeline.sessions.find((session) => session.sdkSessionId === pipeline.stallWarning?.sessionId)
    : undefined;

  /**
   * The pipeline controls, as data rather than markup. The label is shared by
   * the tooltip and accessible name so those descriptions cannot drift apart.
   */
  const headerControls: Array<{
    key: string;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
  }> = [];
  if (canRetryStage) {
    headerControls.push({
      key: "retry-stage",
      label: RETRY_STAGE_LABELS[pipeline.failureContext!.phase],
      icon: RefreshCw,
      onClick: controls.retryStage,
    });
  }
  if (canRestartCurrentStage) {
    headerControls.push({
      key: "restart-stage",
      label: restartCurrentStageLabel!,
      icon: RefreshCw,
      onClick: () => controls.restartCurrentStage(restartCurrentStageLabel),
    });
  }
  if (active) {
    headerControls.push({ key: "pause", label: "Pause", icon: Pause, onClick: controls.pause });
  }
  if (pipeline.phase === "paused") {
    headerControls.push({ key: "resume", label: "Resume", icon: Play, onClick: controls.resume });
  }
  if (active || pipeline.phase === "paused") {
    headerControls.push({ key: "cancel", label: "Cancel", icon: Square, onClick: controls.cancel });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        data-testid="build-pipeline-header"
        className={cn(
          "relative z-20 flex items-center gap-3 border-b border-border/40 bg-zinc-900/40 px-4 py-3",
          isMobile && "flex-wrap gap-2 px-3 py-2",
        )}
      >
        <div data-testid="build-pipeline-header-summary" className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{pipeline.taskTitle}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <div
              data-testid="build-pipeline-header-phase-agent"
              className="flex min-w-0 items-center gap-1.5"
            >
              {active ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : pipeline.phase === "complete" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
              ) : pipeline.phase === "failed" ? (
                <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
              ) : (
                <Circle className="h-3 w-3 shrink-0" />
              )}
              <span data-testid="build-pipeline-header-phase" className="min-w-0 truncate">
                {phaseLabel}
              </span>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span
                data-testid="build-pipeline-header-agent"
                className="min-w-0 max-w-1/2 shrink-0 truncate"
              >
                {agentLabel}
              </span>
            </div>
            {!isMobile && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  ref={setProgressSlot}
                  data-testid="build-pipeline-header-progress"
                  className="flex min-w-0"
                />
              </>
            )}
          </div>
        </div>
        <div
          data-testid="build-pipeline-header-actions"
          className="flex shrink-0 items-center gap-1.5"
        >
          {headerControls.length > 0 && (
            <div data-testid="build-pipeline-header-controls" className="flex items-center gap-1.5">
              {headerControls.map(({ key, label, icon: Icon, onClick }) => (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={label}
                      disabled={controls.pending}
                      onClick={onClick}
                    >
                      <Icon className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={5}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
          <PipelineKeyInformationButton keyInformation={pipeline.keyInformation} />
          <div ref={setGraphToggleSlot} className="flex size-9 shrink-0" />
        </div>
        {isMobile && (
          <div
            ref={setProgressSlot}
            data-testid="build-pipeline-header-progress"
            className="flex min-w-0 basis-full"
          />
        )}
      </div>

      <PipelineFlowView
        pipeline={pipeline}
        environmentId={data.environmentId}
        isActive={isActive}
        ownsGlobalShortcuts={ownsGlobalShortcuts}
        controls={controls}
        pinnedId={pinnedId}
        onPin={setPinnedId}
        layout={layout}
        headerSlots={{ progress: progressSlot, graphToggle: graphToggleSlot }}
        visibleError={interactionFailure ? undefined : pipeline.error}
        notices={
          <>
            {pipeline.error && !interactionFailure && (
              <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {pipeline.error}
              </div>
            )}
            {showStallWarning && (
              <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
                {stalledSession?.label ?? "The active stage"} is still running, but its transcript
                has not changed for an extended period. It was not stopped automatically.
              </div>
            )}
            <BuildCompletionStatus pipeline={pipeline} />
          </>
        }
      />
    </div>
  );
}
