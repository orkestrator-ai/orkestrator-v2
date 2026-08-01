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
import type { BuildTabData } from "@/types/paneLayout";
import {
  useBuildPipelineStore,
  type BuildPipeline,
  type PipelineSession,
} from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
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
  // Distinguishes "the user picked this stage" from "we auto-followed the
  // pipeline". Without it the first automatic pick — the build stage — pins the
  // transcript there for the rest of the run, because it stays a valid session.
  const pinnedSessionRef = useRef(false);
  const hydrationAttemptedFor = useRef<string | null>(null);
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } =
    useVirtuosoScrollState({
      isActive,
      persistKey: `build-pipeline:${data.pipelineId}`,
      environmentId: data.environmentId,
      // A build runs unattended, so returning to the tab should show what the
      // pipeline is doing now rather than where the transcript was left.
      stickToBottomOnActivation: true,
    });

  const selectSession = useCallback((sessionId: string) => {
    pinnedSessionRef.current = true;
    setSelectedSessionId(sessionId);
  }, []);

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
  // The harness this session actually ran on, not the pipeline's build agent:
  // steps may choose different harnesses, and decoding a Codex transcript
  // through the Claude adapter silently drops its subagent and tool-group parts.
  // Snapshots written before per-step harnesses carry no session agent.
  const agentType = selectedSession?.agent ?? pipeline?.agentType;
  const messages = useMemo(
    () =>
      agentType
        ? toPipelineTranscript(
            selectedSession?.messages,
            agentType,
            selectedSession?.startedAt ?? new Date().toISOString(),
          )
        : [],
    [agentType, selectedSession?.messages, selectedSession?.startedAt],
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
  const canRetryReview = pipeline.phase !== "complete"
    && pipeline.sessions.length > 0
    && Boolean(pipeline.environmentId);
  const canSendMessage = pipeline.phase !== "complete"
    && pipeline.phase !== "failed";
  const queuedMessages = pipeline.pendingUserMessages?.length ?? 0;
  // Names the harness of the session on screen, which per-step configuration
  // can make different from the pipeline's build agent.
  const displayedAgent = selectedSession?.agent ?? pipeline.agentType;
  const agentLabel = AGENT_LABELS[displayedAgent] ?? displayedAgent;
  const reportSession = reviewReportSession(pipeline);
  const showReviewReport = Boolean(
    pipeline.structuredReview
      && selectedSession
      && reportSession
      && selectedSession.sessionKey === reportSession.sessionKey,
  );
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
  // A `useId` value is legal in an id and in an ARIA reference whatever
  // punctuation React puts in it; only a CSS selector would object, which is
  // why the keyboard handler below reaches for `getElementById` rather than
  // `querySelector`.
  const transcriptPanelId = `${instanceId}transcript`;
  const stageTabId = (sessionKey: string) => `${instanceId}stage-${sessionKey}`;

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
    selectSession(target.sdkSessionId);
    document.getElementById(stageTabId(target.sessionKey))?.focus();
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

      {pipeline.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {pipeline.error}
        </div>
      )}
      <BuildCompletionStatus pipeline={pipeline} />

      {reviewReportHint && (
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b border-cyan-500/20 bg-cyan-500/5 px-4 py-2 text-left text-xs text-cyan-200/90 transition-colors hover:bg-cyan-500/10"
          onClick={() => selectSession(reviewReportHint.session.sdkSessionId)}
        >
          <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            The review reported {reviewReportHint.label} — open{" "}
            {reviewReportHint.session.label} to read the report.
          </span>
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-60 shrink-0 border-r border-border/40 bg-zinc-900/40">
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
          className="@container relative flex min-w-0 flex-1 flex-col"
          id={transcriptPanelId}
          role="tabpanel"
          // A tabpanel is named by its own tab; only the no-selection case,
          // which has no tab to point at, needs a literal label.
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
            renderMessage={(_index, message, previous) => (
              <NativeMessage
                message={message}
                previousMessage={previous}
                assistantLabel={agentLabel}
                containerId={containerId}
                agentExpansionScope={data.environmentId}
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

      {(canSendMessage || !isAtBottom) && (
        // The native tabs dock their composer as a floating card rather than a
        // bordered footer strip, so this matches that shape instead of drawing
        // another rule across the pane.
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
