import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  REVIEW_PACKAGE_SESSION_LABEL,
} from "@orkestrator/protocol/build-pipeline";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  SESSION_ACTION_SLASH_COMMANDS,
  parseLeadingSlashCommand,
} from "@orkestrator/protocol/agent-slash-commands";
import {
  useBuildPipelineStore,
  type BuildPipeline,
  type PipelineSession,
} from "@/stores/buildPipelineStore";
import * as backend from "@/lib/backend";
import {
  hydrateBuildPipeline,
  isBuildPipelineTranscriptStale,
  isBuildPipelineTranscriptUnavailable,
} from "@/lib/build-pipeline-persistence";
import {
  hideMachineOutputText,
  hideReviewPackagePlanText,
  REVIEW_PACKAGE_PLAN_ROOT_KEYS,
  showOnlyFinalStructuredReviewMessage,
  showOnlyFinalVerificationMessage,
} from "@/lib/structured-review-messages";
import { useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { findNativeAgentAdapter } from "@/components/native-agent/adapter";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { toPipelineTranscript } from "./pipeline-transcript";
import { useWorkflowTranscriptArtifacts } from "@/hooks/useWorkflowTranscriptArtifacts";
import { RichTranscriptScopeContext } from "@/lib/chat/rich-identity";

/**
 * The stage that owns the structured review report.
 *
 * The report belongs to the review turn that produced it, so it is shown there
 * and nowhere else — appending it to whichever stage is on screen makes every
 * stage look as though it had reviewed the work. `structuredRequestId` is the
 * durable link; the newest review session is the fallback for a pipeline
 * persisted before that field existed.
 */
export function reviewReportSession(pipeline: BuildPipeline): PipelineSession | undefined {
  if (!pipeline.structuredReview) return undefined;
  const requestId = pipeline.structuredReviewRequestId;
  const linked = requestId
    ? pipeline.sessions.find((session) => session.structuredRequestId === requestId)
    : undefined;
  return (
    linked ??
    [...pipeline.sessions].reverse().find((session) => session.reviewReport !== undefined) ??
    [...pipeline.sessions].reverse().find((session) => session.phase === "review")
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
  if (session.phase === "review") return pipeline.structuredReview !== undefined;
  if (session.phase === "verify") return pipeline.verificationResult !== undefined;
  return false;
}

/**
 * Session copies are current while the fan-out is live or while its accepted
 * consolidated report still belongs to the pipeline. A retry clears both;
 * older snapshots may still carry the new session field, so do not present
 * those discarded copies as current reports.
 */
export function sessionReviewReport(pipeline: BuildPipeline, session: PipelineSession) {
  const current = Boolean(
    !pipeline.reviewRetryRequested && (pipeline.reviewFanout || pipeline.structuredReview),
  );
  const owner = reviewReportSession(pipeline);
  return (
    (current ? session.reviewReport : undefined) ??
    (owner && owner.sessionKey === session.sessionKey ? pipeline.structuredReview : undefined)
  );
}

/** Whether the pipeline takes a message for its current stage now. */
export function pipelineAcceptsMessages(pipeline: BuildPipeline): boolean {
  return (
    pipeline.phase !== "complete" &&
    pipeline.phase !== "failed" &&
    !(
      (pipeline.reviewers?.length ?? 0) > 1 &&
      (pipeline.phase === "reviewing" ||
        (pipeline.phase === "paused" && pipeline.pausedFromPhase === "reviewing"))
    )
  );
}

interface PipelineSessionTranscriptProps {
  pipeline: BuildPipeline;
  /** The session to show; the last one shown stays mounted while it is unset. */
  session: PipelineSession | undefined;
  /** Shown, as opposed to kept mounted behind another inspector view. */
  visible: boolean;
  isActive: boolean;
  ownsGlobalShortcuts: boolean;
  environmentId: string;
  containerId: string | undefined;
  /** This session is the one the pipeline is running, and takes messages. */
  composer: boolean;
}

/**
 * One stage's whole transcript, as the native agent tabs render it: the same
 * message renderer, virtualization, in-transcript find and follow-the-tail
 * behaviour, the report the stage filed, and — when the pipeline is running
 * this stage — the message box.
 *
 * The pipeline record references stage transcripts rather than embedding
 * them; the shown stage's committed body is fetched when this renderer does
 * not hold it at that revision.
 */
export function PipelineSessionTranscript({
  pipeline,
  session: requested,
  visible,
  isActive,
  ownsGlobalShortcuts,
  environmentId,
  containerId,
  composer,
}: PipelineSessionTranscriptProps) {
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  // Keeping the last session while another view is shown keeps the list, and
  // the reader's place in it, rather than emptying and remounting it.
  const [keptKey, setKeptKey] = useState(requested?.sessionKey);
  if (requested && requested.sessionKey !== keptKey) setKeptKey(requested.sessionKey);
  const session =
    requested ?? pipeline.sessions.find((candidate) => candidate.sessionKey === keptKey);
  const [draft, setDraft] = useState("");
  const [sendPending, setSendPending] = useState(false);
  // Stands in for messages that carry no time of their own when the stage has
  // no start time either; fixed so their rows do not drift on every update.
  const [transcriptFallbackCreatedAt] = useState(() => new Date().toISOString());
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive: isActive && visible,
    persistKey: `build-pipeline:${pipeline.id}`,
    environmentId,
    // A build runs unattended, so returning to the tab should show what the
    // pipeline is doing now rather than where the transcript was left: the
    // documented exception to returning readers to their place.
    activation: "latest",
  });

  const transcriptStale = isBuildPipelineTranscriptStale(session);
  const transcriptUnavailable = isBuildPipelineTranscriptUnavailable(session);
  const transcriptRequestRef = useRef<string | null>(null);
  const transcriptRetryAttemptRef = useRef(0);
  const transcriptRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transcriptRetryTick, setTranscriptRetryTick] = useState(0);
  const sessionKey = session?.sessionKey;
  const messageRevision = session?.messageRevision ?? 0;
  const loadedCount = session?.messages?.length ?? -1;
  // Once per revision, so an unreadable transcript is reported rather than
  // re-requested on every render; failures back off to at most ten seconds.
  useEffect(() => {
    if (!isActive || !visible || !transcriptStale || !sessionKey) return;
    const request = `${pipeline.id}\0${sessionKey}\0${messageRevision}\0${loadedCount}`;
    if (transcriptRequestRef.current === request) return;
    transcriptRequestRef.current = request;
    void hydrateBuildPipeline(pipeline.id, undefined, { prioritySessionKey: sessionKey })
      .then(() => {
        if (transcriptRequestRef.current !== request) return;
        transcriptRetryAttemptRef.current = 0;
        if (transcriptRetryTimerRef.current) clearTimeout(transcriptRetryTimerRef.current);
        transcriptRetryTimerRef.current = null;
      })
      .catch((error) => {
        if (transcriptRequestRef.current !== request) return;
        transcriptRequestRef.current = null;
        console.warn("[BuildChatTab] Failed to load the stage transcript:", error);
        const delay = Math.min(250 * 2 ** transcriptRetryAttemptRef.current, 10_000);
        transcriptRetryAttemptRef.current += 1;
        transcriptRetryTimerRef.current = setTimeout(() => {
          transcriptRetryTimerRef.current = null;
          setTranscriptRetryTick((tick) => tick + 1);
        }, delay);
      });
  }, [
    pipeline.id,
    isActive,
    visible,
    loadedCount,
    messageRevision,
    sessionKey,
    transcriptStale,
    transcriptRetryTick,
  ]);
  useEffect(
    () => () => {
      if (transcriptRetryTimerRef.current) clearTimeout(transcriptRetryTimerRef.current);
    },
    [],
  );

  const reportOwner = useMemo(() => reviewReportSession(pipeline), [pipeline]);
  const ownsCurrentReviewReport = Boolean(
    pipeline.structuredReview && session && reportOwner?.sessionKey === session.sessionKey,
  );
  const reviewReport = session ? sessionReviewReport(pipeline, session) : undefined;
  const sessionIndex = session ? pipeline.sessions.indexOf(session) : -1;
  // New snapshots state this authority explicitly. For old persisted builds,
  // an idle stage the pipeline has advanced past is the closest evidence, and
  // only when the pipeline's own accepted-result bookkeeping confirms it.
  const structuredResultAccepted = Boolean(
    session?.structuredResultStatus === "accepted" ||
    (session?.structuredResultStatus === undefined &&
      session?.status === "idle" &&
      sessionIndex >= 0 &&
      sessionIndex < pipeline.currentSessionIndex &&
      hasAcceptedResultEvidence(session, pipeline)),
  );
  // The harness this session actually ran on, not the pipeline's build agent:
  // steps may choose different harnesses, and decoding a Codex transcript
  // through the Claude adapter silently drops its subagent and tool-group parts.
  // Snapshots written before per-step harnesses carry no session agent.
  const agentType = session?.agent ?? pipeline.agentType;
  const stageTranscript = useMemo(() => {
    if (!agentType) return [];
    const transcript = toPipelineTranscript(
      session?.messages,
      agentType,
      session?.startedAt ?? transcriptFallbackCreatedAt,
      session?.interactionTranscript,
    );
    if (session?.label === REVIEW_PACKAGE_SESSION_LABEL) {
      return hideMachineOutputText(transcript, {
        stripTrailingPayload: true,
        trailingPayloadRootKeys: REVIEW_PACKAGE_PLAN_ROOT_KEYS,
      });
    }
    if (session?.phase === "build" || session?.phase === "fix") {
      return hideReviewPackagePlanText(transcript);
    }
    if (session?.phase === "review") {
      // Two passes, as in the Multi Review reviewer view. The first decides
      // the fate of reports that validate; the second removes what is left —
      // the half-written drafts a provider streams into the text channel
      // while composing its answer.
      return hideMachineOutputText(
        showOnlyFinalStructuredReviewMessage(transcript, structuredResultAccepted && !reviewReport),
        // A report the first pass retained as authoritative must survive the
        // second, which cannot tell an accepted result from a draft by shape.
        { retainPayloadKind: "structured-review" },
      );
    }
    if (session?.phase === "verify") {
      return hideMachineOutputText(
        showOnlyFinalVerificationMessage(transcript, structuredResultAccepted),
        { retainPayloadKind: "verification" },
      );
    }
    return transcript;
  }, [
    agentType,
    reviewReport,
    session?.messages,
    session?.phase,
    session?.startedAt,
    session?.interactionTranscript,
    session?.label,
    structuredResultAccepted,
    transcriptFallbackCreatedAt,
  ]);
  /*
   * The stage session's own key owns what its agent publishes, in the
   * pipeline's environment; a replaced provider session is a new generation.
   */
  const stageProviderSessionId = session?.sdkSessionId;
  const stageConversation = useMemo(
    () =>
      sessionKey
        ? {
            environmentId: pipeline.environmentId,
            conversationKey: sessionKey,
            generation: stageProviderSessionId ?? sessionKey,
          }
        : null,
    [pipeline.environmentId, stageProviderSessionId, sessionKey],
  );
  const { scope, messages } = useWorkflowTranscriptArtifacts(stageConversation, stageTranscript, {
    canLoadEarlier: false,
  });

  const displayedAgent = session?.agent ?? pipeline.agentType;
  const agentLabel = findNativeAgentAdapter(displayedAgent)?.label ?? displayedAgent;
  const pipelineActive = !["paused", "complete", "failed"].includes(pipeline.phase);
  // Pause/cancel abort errors can leave a session at "running" after the
  // pipeline itself has stopped, so the footer only shimmers while it runs.
  const showThinking = visible && pipelineActive && session?.status === "running";
  const queuedMessages = pipeline.pendingUserMessages?.length ?? 0;

  const sendMessage = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sendPending) return;
    // `/steer` reaches the turn the agent is running now. Queueing it like a
    // message would hold it until the agent goes idle, which in a pipeline is
    // when the stage ends and the work moves on to review.
    const command = parseLeadingSlashCommand(text);
    const steer = command?.name === "/steer";
    if (steer && !command.arguments?.trim()) {
      toast.error(SESSION_ACTION_SLASH_COMMANDS["/steer"]!.requiresArguments);
      return;
    }
    setSendPending(true);
    try {
      if (steer) {
        const result = await backend.steerBuildPipeline(pipeline.id, command.arguments!.trim());
        replacePipeline(result.pipeline);
        if (result.delivery === "steered") {
          toast.success("Sent to the active turn");
        } else {
          toast.info("Could not steer the live turn, so the message was queued.");
        }
      } else {
        replacePipeline(await backend.sendBuildPipelineMessage(pipeline.id, text));
      }
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

  const showReviewReport = visible && reviewReport !== undefined;
  return (
    <div
      hidden={!visible}
      aria-hidden={!visible}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !visible && "hidden")}
    >
      <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
        <RichTranscriptScopeContext.Provider value={scope}>
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
                agentExpansionScope={environmentId}
                platform={isAgentPlatform(displayedAgent) ? displayedAgent : undefined}
              />
            )}
            emptyState={
              <div className="py-12 text-center text-sm text-muted-foreground">
                {!session
                  ? "Waiting for the backend to start a build stage."
                  : transcriptUnavailable
                    ? "The stored transcript for this stage could not be read."
                    : transcriptStale && session.messages === undefined
                      ? "Loading this stage's transcript…"
                      : session.status === "running"
                        ? "This stage is running. Its authoritative transcript will appear here as it is synchronized."
                        : "No text transcript was produced for this stage."}
              </div>
            }
            header={
              (session?.transcript && !session.transcript.complete) ||
              session?.transcriptCheckpointError ? (
                <div className="px-3 py-2 text-center text-[11px] text-muted-foreground @sm:px-6">
                  {session.transcript && !session.transcript.complete ? (
                    <p>
                      {session.transcript.omittedMessages ?? "Some"}{" "}
                      {session.transcript.omittedMessages === 1 ? "message was" : "messages were"}{" "}
                      not kept in the stored transcript because of its size limit.
                    </p>
                  ) : null}
                  {session.transcriptCheckpointError ? (
                    <p>The newest messages of this stage could not be stored yet.</p>
                  ) : null}
                </div>
              ) : undefined
            }
            footer={
              showReviewReport || showThinking ? (
                <>
                  {showReviewReport && reviewReport ? (
                    <div className="px-3 py-3 @sm:px-6">
                      <StructuredReviewReportView
                        className="mx-auto max-w-3xl"
                        report={reviewReport}
                        heading={
                          (pipeline.reviewers?.length ?? 0) > 1
                            ? ownsCurrentReviewReport
                              ? "Consolidated Multi Review"
                              : "Reviewer report"
                            : undefined
                        }
                        collapsibleSections
                        sectionExpansionKey={`build-pipeline/${pipeline.id}/${session?.sessionKey ?? "review"}/report-section`}
                        showRawJson={false}
                      />
                    </div>
                  ) : null}
                  {showThinking ? (
                    <div className="px-2 @sm:px-4">
                      <div className="chat-status-row mx-auto max-w-3xl min-w-0">
                        <AgentThinkingIndicator agentName={agentLabel} />
                      </div>
                    </div>
                  ) : null}
                </>
              ) : undefined
            }
            scrollProps={scrollProps}
            virtuosoRef={virtuosoRef}
            find={{
              isActive: ownsGlobalShortcuts && visible,
              getSearchText: getNativeMessageSearchText,
            }}
          />
        </RichTranscriptScopeContext.Provider>
      </div>
      {visible && (composer || !isAtBottom) && (
        // The native tabs dock their composer as a floating card rather than a
        // bordered footer strip, so this matches that shape.
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
          {composer && (
            <div className="mx-auto w-full max-w-[56rem] rounded-2xl border border-border/70 bg-input-surface p-3 shadow-xl shadow-black/20">
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
                  size="icon"
                  className="h-7 w-7 rounded-lg transition-colors"
                  title="Send message"
                  aria-label="Send message"
                  disabled={sendPending || draft.trim().length === 0}
                  onClick={() => void sendMessage()}
                >
                  {sendPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
