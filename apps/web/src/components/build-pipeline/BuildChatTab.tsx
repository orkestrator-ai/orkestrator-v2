import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { MAX_PIPELINE_USER_MESSAGE_LENGTH } from "@orkestrator/protocol/build-pipeline";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { BuildTabData } from "@/types/paneLayout";
import {
  useBuildPipelineStore,
  type BuildPipeline,
  type PipelineSession,
} from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import {
  showOnlyFinalStructuredReviewMessage,
  showOnlyFinalVerificationMessage,
} from "@/lib/structured-review-messages";
import { useMediaQuery, useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { BuildCompletionStatus } from "./BuildCompletionStatus";
import { toPipelineTranscript } from "./pipeline-transcript";

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

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

const RETRY_STAGE_LABELS: Record<string, string> = {
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

/**
 * Where each key moves the stage selection.
 *
 * Both axes are bound, not just the vertical one the list is drawn on: the
 * ARIA tabs pattern expects the orientation's own arrows, and binding the other
 * pair too costs nothing and spares a user who guessed the wrong axis.
 */
const STAGE_TAB_KEYS: Record<string, number | "first" | "last"> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

/** Viewports narrower than this get the one-at-a-time layout. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * The two halves of the desktop split, which a phone shows one at a time.
 *
 * A 240px stage rail beside a transcript leaves neither readable on a ~390px
 * screen, so on mobile each takes the full width and a tab bar chooses between
 * them. Both stay mounted: hiding is a CSS concern, and unmounting the
 * transcript would throw away its virtualized scroll position every time the
 * user glanced at the stage list.
 */
const MOBILE_VIEWS = ["stages", "transcript"] as const;

type MobileView = (typeof MOBILE_VIEWS)[number];

/**
 * The stage that owns the structured review report.
 *
 * The report belongs to the review turn that produced it, so it is shown there
 * and nowhere else — appending it to whichever stage is on screen makes every
 * stage look as though it had reviewed the work. `structuredRequestId` is the
 * durable link; the newest review session is the fallback for a pipeline
 * persisted before that field existed.
 */
function reviewReportSession(
  pipeline: BuildPipeline,
): PipelineSession | undefined {
  if (!pipeline.structuredReview) return undefined;
  const requestId = pipeline.structuredReviewRequestId;
  const linked = requestId
    ? pipeline.sessions.find(
        (session) => session.structuredRequestId === requestId,
      )
    : undefined;
  return (
    linked
      ?? [...pipeline.sessions].reverse().find(
        (session) => session.phase === "review",
      )
  );
}

/**
 * Whether the pipeline's own bookkeeping confirms a legacy session's structured
 * result was accepted.
 *
 * `structuredResultStatus` predates old snapshots, so an idle stage the
 * pipeline has advanced past is the only pointer — but it is not enough on its
 * own: a retry or cancellation can advance the pipeline past a stage whose
 * result was never accepted, and revealing that stage's last provisional
 * payload would look like a real verdict. The report and verdict fields are
 * exactly the record of an accepted outcome, and a retry clears both, so their
 * presence is that confirmation.
 */
function hasAcceptedResultEvidence(
  session: PipelineSession | undefined,
  pipeline: BuildPipeline | undefined,
): boolean {
  if (!session || !pipeline) return false;
  if (session.phase === "review") {
    return pipeline.structuredReview !== undefined;
  }
  if (session.phase === "verify") {
    return pipeline.verificationResult !== undefined;
  }
  return false;
}

function issueCountLabel(count: number): string {
  return `${count} issue${count === 1 ? "" : "s"}`;
}

function SessionStateIcon({ session }: { session: PipelineSession }) {
  if (session.status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (session.status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
}

export function BuildChatTab({
  data,
  isActive = false,
  ownsGlobalShortcuts = isActive,
}: BuildChatTabProps) {
  const instanceId = useId();
  const pipeline = useBuildPipelineStore(
    (state) => state.pipelines.get(data.pipelineId),
  );
  const replacePipeline = useBuildPipelineStore(
    (state) => state.replacePipeline,
  );
  // Images the agent wrote inside a Dockerised environment are readable only
  // through its container, exactly as in the native tabs.
  const containerId = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId)?.containerId,
  ) ?? undefined;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [sendPending, setSendPending] = useState(false);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  // The transcript, not the stage list, is what a build tab is opened to read —
  // it runs unattended, so the useful thing on arrival is what the agent is
  // doing now. The stage list is one tap away.
  const [mobileView, setMobileView] = useState<MobileView>("transcript");
  const stagesVisible = !isMobile || mobileView === "stages";
  const transcriptVisible = !isMobile || mobileView === "transcript";
  // Distinguishes "the user picked this stage" from "we auto-followed the
  // pipeline". Without it the first automatic pick — the build stage — pins the
  // transcript there for the rest of the run, because it stays a valid session.
  const pinnedSessionRef = useRef(false);
  const hydrationAttemptedFor = useRef<string | null>(null);
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } =
    useVirtuosoScrollState({
      // Switching to the stage list on a phone hides the transcript as
      // completely as switching tabs does, so it deactivates the same way —
      // which is also what makes coming back re-lock to the live bottom.
      isActive: isActive && transcriptVisible,
      persistKey: `build-pipeline:${data.pipelineId}`,
      environmentId: data.environmentId,
      // A build runs unattended, so returning to the tab should show what the
      // pipeline is doing now rather than where the transcript was left.
      stickToBottomOnActivation: true,
    });

  // A `useId` value is legal in an id and in an ARIA reference whatever
  // punctuation React puts in it; only a CSS selector would object, which is
  // why the keyboard handlers below reach for `getElementById` rather than
  // `querySelector`.
  const transcriptPanelId = `${instanceId}transcript`;
  const stagesPanelId = `${instanceId}stages`;
  const stageTabId = (sessionKey: string) => `${instanceId}stage-${sessionKey}`;
  const mobileViewTabId = (view: MobileView) => `${instanceId}view-${view}`;
  const mobileViewPanelId = (view: MobileView) =>
    view === "stages" ? stagesPanelId : transcriptPanelId;

  const pinSession = useCallback((sessionId: string) => {
    pinnedSessionRef.current = true;
    setSelectedSessionId(sessionId);
  }, []);

  const selectSession = (
    sessionId: string,
    disappearingTrigger?: HTMLElement,
  ) => {
    pinSession(sessionId);
    // Choosing a stage is a request to read it, so on a phone the transcript
    // comes forward with it. Only an explicit choice does this: the effect
    // below re-selects as the pipeline advances, and following the pipeline
    // must not yank the user out of the stage list they are reading. Arrow-key
    // navigation is the same — it browses the list, so it uses `pinSession`.
    setMobileView("transcript");
    if (!isMobile) return;
    // The stage list is about to be hidden, and hiding the element that holds
    // focus drops focus to `<body>` — the next Tab would restart from the top
    // of the document, which loses a keyboard user's place entirely. Hand it
    // instead to the tab that now names what is on screen. Do this only when
    // the stage list or a caller-supplied disappearing trigger actually held
    // focus: a tap can leave focus elsewhere, and moving it then would be a
    // change the user did not ask for.
    const focused = document.activeElement;
    const focusWillDisappear = Boolean(
      focused
        && (
          document.getElementById(stagesPanelId)?.contains(focused)
          || focused === disappearingTrigger
        ),
    );
    if (!focusWillDisappear) {
      return;
    }
    document.getElementById(mobileViewTabId("transcript"))?.focus();
  };

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

  useEffect(() => {
    if (!pipeline?.sessions.length) {
      setSelectedSessionId(null);
      pinnedSessionRef.current = false;
      return;
    }
    const selectionExists = selectedSessionId !== null
      && pipeline.sessions.some(
        (session) => session.sdkSessionId === selectedSessionId,
      );
    // A pinned selection that vanished from the snapshot is no longer a choice
    // the user can hold on to, so release the pin and follow the pipeline again.
    if (!selectionExists) pinnedSessionRef.current = false;
    if (selectionExists && pinnedSessionRef.current) return;
    const following = pipeline.sessions[pipeline.currentSessionIndex]?.sdkSessionId
      ?? pipeline.sessions.at(-1)?.sdkSessionId
      ?? null;
    if (following !== selectedSessionId) setSelectedSessionId(following);
  }, [pipeline?.currentSessionIndex, pipeline?.sessions, selectedSessionId]);

  const selectedSession = pipeline?.sessions.find(
    (session) => session.sdkSessionId === selectedSessionId,
  );
  const selectedSessionIndex = pipeline?.sessions.findIndex(
    (session) => session.sdkSessionId === selectedSessionId,
  ) ?? -1;
  const reportSession = pipeline ? reviewReportSession(pipeline) : undefined;
  const ownsCurrentReviewReport = Boolean(
    pipeline?.structuredReview
      && selectedSession
      && reportSession
      && selectedSession.sessionKey === reportSession.sessionKey,
  );
  // New snapshots state this authority explicitly. For old persisted builds,
  // an idle stage the pipeline has advanced past is the closest evidence, and
  // only when the pipeline's own accepted-result bookkeeping confirms it — a
  // retry or cancellation can advance the pipeline past a stage whose result
  // was never accepted, and the current stage is excluded because pause,
  // cancellation and result-finalization waits all leave it idle too.
  const structuredResultAccepted = Boolean(
    selectedSession?.structuredResultStatus === "accepted"
      || (
        selectedSession?.structuredResultStatus === undefined
        && selectedSession?.status === "idle"
        && selectedSessionIndex >= 0
        && selectedSessionIndex < (pipeline?.currentSessionIndex ?? -1)
        && hasAcceptedResultEvidence(selectedSession, pipeline)
      ),
  );
  // The harness this session actually ran on, not the pipeline's build agent:
  // steps may choose different harnesses, and decoding a Codex transcript
  // through the Claude adapter silently drops its subagent and tool-group parts.
  // Snapshots written before per-step harnesses carry no session agent.
  const agentType = selectedSession?.agent ?? pipeline?.agentType;
  const messages = useMemo(
    () => {
      if (!agentType) return [];
      const transcript = toPipelineTranscript(
        selectedSession?.messages,
        agentType,
        selectedSession?.startedAt ?? new Date().toISOString(),
        selectedSession?.interactionTranscript,
      );
      if (selectedSession?.phase === "review") {
        return showOnlyFinalStructuredReviewMessage(
          transcript,
          structuredResultAccepted && !ownsCurrentReviewReport,
        );
      }
      if (selectedSession?.phase === "verify") {
        return showOnlyFinalVerificationMessage(
          transcript,
          structuredResultAccepted,
        );
      }
      return transcript;
    },
    [
      agentType,
      ownsCurrentReviewReport,
      selectedSession?.messages,
      selectedSession?.phase,
      selectedSession?.startedAt,
      selectedSession?.interactionTranscript,
      structuredResultAccepted,
    ],
  );

  const runControl = async (
    action: "pause" | "resume" | "cancel",
  ): Promise<void> => {
    if (!pipeline || controlPending) return;
    setControlPending(true);
    try {
      const next = action === "pause"
        ? await backend.pauseBuildPipeline(pipeline.id)
        : action === "resume"
          ? await backend.resumeBuildPipeline(pipeline.id)
          : await backend.cancelBuildPipeline(pipeline.id);
      replacePipeline(next);
    } catch (error) {
      toast.error(`Failed to ${action} build`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setControlPending(false);
    }
  };

  const retryReview = async (): Promise<void> => {
    if (!pipeline || controlPending) return;
    setControlPending(true);
    try {
      replacePipeline(await backend.retryBuildPipelineReview(pipeline.id));
      // The retry starts a new review session; follow it rather than leaving
      // the user on whichever stage they were reading.
      pinnedSessionRef.current = false;
      toast.success("Review restarted");
    } catch (error) {
      toast.error("Failed to restart the review", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setControlPending(false);
    }
  };

  const retryStage = async (): Promise<void> => {
    if (!pipeline || controlPending) return;
    setControlPending(true);
    try {
      const updated = await backend.retryBuildPipelineStage(pipeline.id);
      replacePipeline(updated);
      pinnedSessionRef.current = false;
      if (updated.phase === "failed") {
        toast.error("Failed to restart the stage", {
          description: updated.error ?? "The stage failed again before it could restart",
        });
        return;
      }
      toast.success("Failed stage restarted");
    } catch (error) {
      toast.error("Failed to restart the stage", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setControlPending(false);
    }
  };

  const sendMessage = async (): Promise<void> => {
    const text = draft.trim();
    if (!pipeline || !text || sendPending) return;
    setSendPending(true);
    try {
      replacePipeline(await backend.sendBuildPipelineMessage(pipeline.id, text));
      // Cleared only after the backend has durably queued it, so a failed send
      // leaves the user's text in the box to retry rather than losing it.
      setDraft("");
    } catch (error) {
      toast.error("Failed to send the message", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSendPending(false);
    }
  };

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading build pipeline…
      </div>
    );
  }

  const phaseLabel = PHASE_LABELS[pipeline.phase] ?? pipeline.phase;
  const active = !["paused", "complete", "failed"].includes(pipeline.phase);
  const interactionFailure = pipeline.phase === "failed"
    && pipeline.failureContext?.kind === "interactive-request";
  const canRetryStage = pipeline.phase === "failed"
    && Boolean(pipeline.failureContext)
    && !interactionFailure;
  const canRetryReview = pipeline.phase !== "complete"
    && pipeline.phase !== "failed"
    && !interactionFailure
    && pipeline.sessions.length > 0
    && Boolean(pipeline.environmentId);
  const canSendMessage = pipeline.phase !== "complete"
    && pipeline.phase !== "failed";
  const queuedMessages = pipeline.pendingUserMessages?.length ?? 0;
  // Names the harness of the session on screen, which per-step configuration
  // can make different from the pipeline's build agent.
  const displayedAgent = selectedSession?.agent ?? pipeline.agentType;
  const agentLabel = AGENT_LABELS[displayedAgent] ?? displayedAgent;
  // The banner asserts the stage "is still running", so it belongs to an active
  // pipeline only. The backend clears the warning on every terminal and paused
  // transition; gating here as well keeps a snapshot written by an older build
  // from making that claim about a stopped one.
  const showStallWarning = active && Boolean(pipeline.stallWarning);
  const stalledSession = showStallWarning
    ? pipeline.sessions.find(
        (session) => session.sdkSessionId === pipeline.stallWarning?.sessionId,
      )
    : undefined;
  const showReviewReport = ownsCurrentReviewReport;
  // The report lives on the stage that produced it, but the tab follows the
  // pipeline past review, so by the time a build finishes nothing on screen
  // would say a review had happened at all.
  const reviewReportHint = pipeline.structuredReview && reportSession
    && !showReviewReport
    ? {
        session: reportSession,
        label: issueCountLabel(pipeline.structuredReview.issues.length),
      }
    : undefined;
  const mobileViewLabels: Record<MobileView, string> = {
    stages: "Stages",
    // Naming the stage on the tab is the only thing that says which transcript
    // is behind it — the header shows the pipeline's phase, not the selection.
    transcript: selectedSession?.label ?? "Transcript",
  };

  /**
   * Move the selection to another stage from the keyboard.
   *
   * Taking `role="tab"` is a promise that arrow keys move between stages and
   * that only the selected stage is in the page tab sequence — a promise
   * `aria-orientation="vertical"` repeats. Focus follows selection, which is the
   * correct pattern here because showing a stage is cheap and has no side
   * effect beyond rendering its transcript.
   */
  const moveStageFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = STAGE_TAB_KEYS[event.key];
    if (step === undefined || pipeline.sessions.length === 0) return;
    // Consumed even when the selection does not move (a single-stage pipeline,
    // or Home on the first stage): a tablist owns these keys, and letting one
    // fall through to scroll the stage list instead is the inconsistency the
    // pattern exists to remove.
    event.preventDefault();
    const current = pipeline.sessions.findIndex(
      (session) => session.sdkSessionId === selectedSessionId,
    );
    const next = step === "first"
      ? 0
      : step === "last"
        ? pipeline.sessions.length - 1
        // A tablist wraps at both ends, and `current` of -1 (nothing selected
        // yet) must still land on a real stage rather than off the front.
        : (Math.max(current, 0) + step + pipeline.sessions.length)
          % pipeline.sessions.length;
    const target = pipeline.sessions[next];
    if (!target || target.sdkSessionId === selectedSessionId) return;
    pinSession(target.sdkSessionId);
    document.getElementById(stageTabId(target.sessionKey))?.focus();
  };

  /**
   * Move between the two mobile views from the keyboard.
   *
   * Same contract as the stage list: taking `role="tab"` promises arrow keys,
   * and with two tabs both directions simply wrap onto the other one.
   */
  const moveMobileViewFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = STAGE_TAB_KEYS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const current = MOBILE_VIEWS.indexOf(mobileView);
    const next = step === "first"
      ? 0
      : step === "last"
        ? MOBILE_VIEWS.length - 1
        : (current + step + MOBILE_VIEWS.length) % MOBILE_VIEWS.length;
    const target = MOBILE_VIEWS[next];
    if (!target || target === mobileView) return;
    setMobileView(target);
    document.getElementById(mobileViewTabId(target))?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-zinc-900/40 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{pipeline.taskTitle}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {active ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : pipeline.phase === "complete" ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : pipeline.phase === "failed" ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : (
              <Circle className="h-3 w-3" />
            )}
            <span>{phaseLabel}</span>
            <span>·</span>
            <span className="capitalize">{displayedAgent}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canRetryStage && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void retryStage()}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {RETRY_STAGE_LABELS[pipeline.failureContext!.phase]
                ?? "Retry Failed Stage"}
            </Button>
          )}
          {canRetryReview && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void retryReview()}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry Review
            </Button>
          )}
          {active && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void runControl("pause")}
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          )}
          {pipeline.phase === "paused" && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void runControl("resume")}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {(active || pipeline.phase === "paused") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={controlPending}
              onClick={() => void runControl("cancel")}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {pipeline.error && !interactionFailure && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {pipeline.error}
        </div>
      )}
      {showStallWarning && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
          {stalledSession?.label ?? "The active stage"} is still running, but its transcript has not changed for an extended period. It was not stopped automatically.
        </div>
      )}
      <BuildCompletionStatus pipeline={pipeline} />

      {reviewReportHint && (
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b border-cyan-500/20 bg-cyan-500/5 px-4 py-2 text-left text-xs text-cyan-200/90 transition-colors hover:bg-cyan-500/10"
          onClick={(event) =>
            selectSession(
              reviewReportHint.session.sdkSessionId,
              event.currentTarget,
            )}
        >
          <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            The review reported {reviewReportHint.label} — open{" "}
            {reviewReportHint.session.label} to read the report.
          </span>
        </button>
      )}

      {isMobile && (
        <div
          role="tablist"
          aria-label="Build view"
          className="flex shrink-0 gap-1 border-b border-border/40 bg-zinc-900/40 p-1"
          onKeyDown={moveMobileViewFocus}
        >
          {MOBILE_VIEWS.map((view) => {
            const selected = mobileView === view;
            return (
              <button
                key={view}
                id={mobileViewTabId(view)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={mobileViewPanelId(view)}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  "min-h-9 min-w-0 flex-1 truncate rounded px-3 text-xs transition-colors",
                  selected
                    ? "bg-zinc-800/85 text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
                onClick={() => setMobileView(view)}
              >
                {mobileViewLabels[view]}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea
          id={stagesPanelId}
          hidden={!stagesVisible}
          // On mobile this half is a panel of the view switcher above. On
          // desktop nothing selects it, so it takes no tab semantics there.
          {...(isMobile
            ? {
                role: "tabpanel",
                "aria-labelledby": mobileViewTabId("stages"),
              }
            : {})}
          className={cn(
            "bg-zinc-900/40",
            // `hidden` has to be the utility, not just the attribute: the
            // attribute's base-layer rule loses to any display utility.
            !stagesVisible && "hidden",
            isMobile ? "w-full" : "w-60 shrink-0 border-r border-border/40",
          )}
        >
          <div
            className="space-y-1 p-2"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Build stages"
            onKeyDown={moveStageFocus}
          >
            {pipeline.sessions.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                The backend is preparing the first stage.
              </div>
            ) : pipeline.sessions.map((session, index) => {
              const isSelected = selectedSessionId === session.sdkSessionId;
              const ownsReport = Boolean(
                reportSession && session.sessionKey === reportSession.sessionKey,
              );
              return (
                <button
                  key={session.sessionKey}
                  id={stageTabId(session.sessionKey)}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={transcriptPanelId}
                  // One stop for the whole list, then arrow keys within it —
                  // otherwise Tab walks every stage before reaching the
                  // transcript. The first stage stands in for the frame before
                  // the following effect has chosen one.
                  tabIndex={isSelected || (selectedSessionId === null && index === 0)
                    ? 0
                    : -1}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-2 py-2 text-left transition-colors",
                    isSelected
                      ? "border-zinc-700/70 bg-zinc-800/85"
                      : "border-transparent hover:bg-zinc-800/55",
                  )}
                  onClick={() => selectSession(session.sdkSessionId)}
                >
                  <SessionStateIcon session={session} />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block truncate text-xs font-medium",
                        isSelected ? "text-foreground" : "text-foreground/80",
                      )}
                    >
                      {session.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Iteration {session.iteration + 1}
                    </span>
                    {(session.autoDeclineCount ?? 0) > 0 && (
                      <span className="mt-1 block text-[10px] text-muted-foreground">
                        {session.autoDeclineCount} input request{session.autoDeclineCount === 1 ? "" : "s"} auto-declined
                      </span>
                    )}
                    {ownsReport && pipeline.structuredReview && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-200/90">
                        <ClipboardCheck className="h-2.5 w-2.5" />
                        Report ·{" "}
                        {issueCountLabel(pipeline.structuredReview.issues.length)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        <div
          className={cn(
            "@container relative min-w-0 flex-1",
            transcriptVisible ? "flex flex-col" : "hidden",
          )}
          id={transcriptPanelId}
          hidden={!transcriptVisible}
          role="tabpanel"
          // A tabpanel is named by its own tab; only the no-selection case,
          // which has no tab to point at, needs a literal label. On mobile the
          // view switcher's tab already names it after the same stage.
          {...(selectedSession
            ? { "aria-labelledby": stageTabId(selectedSession.sessionKey) }
            : { "aria-label": "Build stage transcript" })}
        >
          {/*
            The transcript list the native agent tabs use: the same message
            renderer, the same virtualization, the same in-transcript find, and
            the same follow-the-tail behaviour while a stage streams.
          */}
          <VirtualizedMessageList
            messages={messages}
            computeItemKey={(_index, message) => message.id}
            resolvePreviousMessage={findPreviousNativeMessage}
            renderMessage={(_index, message, previous) => (
              <NativeMessage
                message={message}
                previousMessage={previous}
                assistantLabel={agentLabel}
                containerId={containerId}
                agentExpansionScope={data.environmentId}
                platform={isAgentPlatform(displayedAgent) ? displayedAgent : undefined}
              />
            )}
            emptyState={
              <div className="py-12 text-center text-sm text-muted-foreground">
                {!selectedSession
                  ? "Waiting for the backend to start a build stage."
                  : selectedSession.status === "running"
                    ? "This stage is running. Its authoritative transcript will appear here as it is synchronized."
                    : "No text transcript was produced for this stage."}
              </div>
            }
            footer={
              showReviewReport && pipeline.structuredReview ? (
                <div className="px-3 py-3 @sm:px-6">
                  <StructuredReviewReportView
                    className="mx-auto max-w-3xl"
                    report={pipeline.structuredReview}
                    collapsibleSections
                    showRawJson={false}
                  />
                </div>
              ) : undefined
            }
            scrollProps={scrollProps}
            virtuosoRef={virtuosoRef}
            find={{
              isActive: ownsGlobalShortcuts,
              getSearchText: getNativeMessageSearchText,
            }}
          />
        </div>
      </div>

      {transcriptVisible && (canSendMessage || !isAtBottom) && (
        // The native tabs dock their composer as a floating card rather than a
        // bordered footer strip, so this matches that shape instead of drawing
        // another rule across the pane. It addresses the transcript, so on a
        // phone it goes with it rather than eating a third of the stage list.
        <div className="shrink-0 px-3 pt-2 pb-4">
          {!isAtBottom && (
            <div className="mx-auto mb-1 flex w-full max-w-[56rem] justify-end">
              <button
                type="button"
                onClick={scrollToBottom}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
                aria-label="Scroll to bottom of transcript"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                <span>Scroll down</span>
              </button>
            </div>
          )}
          {canSendMessage && (
            <div className="mx-auto w-full max-w-[56rem] rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20">
              {queuedMessages > 0 && (
                <div className="mb-1.5 text-[11px] text-muted-foreground">
                  {queuedMessages === 1
                    ? "1 message queued — it will be delivered when the agent is next idle."
                    : `${queuedMessages} messages queued — they will be delivered one at a time as the agent goes idle.`}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={MAX_PIPELINE_USER_MESSAGE_LENGTH}
                  rows={2}
                  className="min-h-0 resize-none border-none bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
                  placeholder="Send a message to the agent..."
                  aria-label="Send a message to the agent"
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    void sendMessage();
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="rounded-full"
                  title="Send message"
                  aria-label="Send message"
                  disabled={sendPending || draft.trim().length === 0}
                  onClick={() => void sendMessage()}
                >
                  {sendPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
