/**
 * A review panel as the pipeline can recover it after its pass was retired.
 *
 * The live fan-out record is dropped once the next stage opens, because
 * everything downstream reads `structuredReview`. Each reviewer session keeps
 * how it ended and its report until the next review attempt, which is enough to
 * rebuild the panel when the user restarts consolidation or one reviewer of the
 * current round: the other reviewers' reports stay in use and only that step
 * runs again, as in Multi Review.
 */
import {
  boundedPipelineSessionError,
  isSupersededPipelineSession,
  pipelineIndependentReviewSlot,
  pipelineReviewerConfigs,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewFanoutState, ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { reviewLensField } from "@orkestrator/protocol/review-lens";

const CONSOLIDATION_LABEL = "Consolidation";

export function isConsolidationSession(session: Pick<PipelineSession, "label">): boolean {
  return session.label === CONSOLIDATION_LABEL;
}

/** A reviewer session of a panel, as opposed to its consolidation or a single review. */
export function isPanelReviewerSession(session: PipelineSession, passId: string): boolean {
  return (
    session.phase === "review" &&
    session.reviewPassId === passId &&
    pipelineIndependentReviewSlot(session.label) !== null
  );
}

export function reviewerStoppedByUser(
  pipeline: Pick<BuildPipeline, "stoppedReviewerIds">,
  reviewer: Pick<ReviewerRecord, "id">,
): boolean {
  return pipeline.stoppedReviewerIds?.includes(reviewer.id) ?? false;
}

export function markReviewerStopped(
  pipeline: Pick<BuildPipeline, "stoppedReviewerIds">,
  reviewer: Pick<ReviewerRecord, "id">,
): void {
  if (reviewerStoppedByUser(pipeline, reviewer)) return;
  pipeline.stoppedReviewerIds = [...(pipeline.stoppedReviewerIds ?? []), reviewer.id];
}

export function clearReviewerStopped(
  pipeline: Pick<BuildPipeline, "stoppedReviewerIds">,
  reviewer: Pick<ReviewerRecord, "id">,
): void {
  const remaining = pipeline.stoppedReviewerIds?.filter((id) => id !== reviewer.id);
  if (remaining?.length) pipeline.stoppedReviewerIds = remaining;
  else delete pipeline.stoppedReviewerIds;
}

/**
 * The reviewer id a session key names. Keys read
 * `<pipeline>:review:<round>:<reviewer>` and a retry adds `:attempt-<n>`.
 */
function reviewerIdFromSessionKey(
  pipelineId: string,
  session: Pick<PipelineSession, "iteration" | "sessionKey">,
): string | undefined {
  const prefix = `${pipelineId}:review:${session.iteration}:`;
  if (!session.sessionKey.startsWith(prefix)) return undefined;
  return session.sessionKey.slice(prefix.length).replace(/:attempt-\d+$/, "") || undefined;
}

function recordFromSession(
  pipeline: BuildPipeline,
  session: PipelineSession,
  slot: number,
  passId: string,
): ReviewerRecord | null {
  const config = pipelineReviewerConfigs(pipeline)[slot];
  const id =
    reviewerIdFromSessionKey(pipeline.id, session) ?? (slot === 0 ? passId : `${passId}:${slot}`);
  const completed =
    session.reviewerOutcome === "completed" ||
    (session.reviewerOutcome === undefined && session.reviewReport !== undefined);
  // A later review attempt discarded this report. Its panel cannot be rebuilt.
  if (completed && !session.reviewReport) return null;
  const failed = session.reviewerOutcome === "failed";
  const model = session.model ?? config?.model;
  return {
    id,
    agent: session.agent ?? config?.agent ?? pipeline.agentType,
    model: model || "default",
    ...(model ? {} : { modelUnpinned: true }),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(typeof session.fastMode === "boolean" ? { fastMode: session.fastMode } : {}),
    ...reviewLensField(config?.lens),
    status: completed ? "completed" : failed ? "failed" : "cancelled",
    sessionKey: session.sessionKey,
    providerSessionId: session.sdkSessionId,
    agentStarted: true,
    ...(session.structuredRequestId ? { requestId: session.structuredRequestId } : {}),
    ...(completed ? { report: session.reviewReport } : {}),
    ...(failed && session.error ? { error: boundedPipelineSessionError(session.error) } : {}),
    ...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
    ...(session.cacheReadTokens === undefined ? {} : { cacheReadTokens: session.cacheReadTokens }),
    startedAt: session.startedAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
  };
}

/**
 * Rebuilds the panel of the pass `anchor` belongs to, or null when it cannot be:
 * a record from before passes had an identity, or reports a later attempt
 * discarded. A reviewer with no session (stopped while queued, or one that could
 * not start) keeps its slot, so positions and source IDs stay the same.
 */
export function panelFromSessions(
  pipeline: BuildPipeline,
  anchor: PipelineSession,
): ReviewFanoutState | null {
  const passId = anchor.reviewPassId;
  if (!passId) return null;
  const newestBySlot = new Map<number, PipelineSession>();
  for (const session of pipeline.sessions) {
    if (
      session.iteration !== anchor.iteration ||
      isSupersededPipelineSession(session) ||
      session.superseded === true ||
      !isPanelReviewerSession(session, passId)
    ) {
      continue;
    }
    newestBySlot.set(pipelineIndependentReviewSlot(session.label)!, session);
  }
  if (newestBySlot.size === 0) return null;
  const sessionless = pipeline.sessions.findLast(
    (session) => session.reviewPassId === passId && isConsolidationSession(session),
  )?.sessionlessReviewers;
  const configs = pipelineReviewerConfigs(pipeline);
  const reviewers: ReviewerRecord[] = [];
  for (let slot = 0; slot < configs.length; slot += 1) {
    const session = newestBySlot.get(slot);
    if (session) {
      const record = recordFromSession(pipeline, session, slot, passId);
      if (!record) return null;
      reviewers.push(record);
      continue;
    }
    const failure = sessionless?.find((entry) => entry.slot === slot);
    const config = configs[slot]!;
    reviewers.push({
      id: failure?.id ?? (slot === 0 ? passId : `${passId}:${slot}`),
      agent: failure?.agent ?? config.agent,
      model: failure?.model ?? config.model ?? "default",
      ...((failure?.model ?? config.model) ? {} : { modelUnpinned: true }),
      ...reviewLensField(config.lens),
      status: failure ? "failed" : "cancelled",
      ...(failure ? { error: failure.error, startFailed: failure.startFailed } : {}),
    });
  }
  return { reviewers };
}
