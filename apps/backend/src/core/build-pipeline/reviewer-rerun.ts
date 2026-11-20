/**
 * Rerunning one reviewer slot of a review pass that has already consolidated
 * (to-do 8103 (retired)).
 *
 * Before consolidation a reviewer retries inside the live pass
 * (`prepareReviewerRetry`). Once the pass holds a consolidated report, or the
 * pipeline has moved on to Address Findings and later, one slot can still run
 * again on its own: the restart rewinds to the panel, the other slots' reports
 * stay current, Consolidation and every later step of the round become a
 * previous attempt, and the pass consolidates again. The rewind itself is
 * `restartLocatedStage` with `rerunReviewer`; this module only says which
 * session anchors it and when it is refused.
 */
import {
  isActiveBuildPhase,
  isSupersededPipelineSession,
  pipelineIndependentReviewSlot,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewFanoutState, ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  isConsolidationSession,
  isPanelReviewerSession,
  panelFromSessions,
} from "./review-panel.js";
import { findStageSession, type RestartTarget } from "./restart-targets.js";

/** Whether `reviewer` is the one `reviewerId` (a record id or a session key) names. */
export function namesReviewer(
  reviewer: Pick<ReviewerRecord, "id" | "sessionKey">,
  reviewerId: string,
): boolean {
  return reviewer.id === reviewerId || reviewer.sessionKey === reviewerId;
}

/**
 * The session a per-slot rerun anchors its rewind on: the slot's own reviewer
 * session, or for a slot that never had one (it failed to start, or was stopped
 * while queued) its pass's Consolidation. The anchor gives the restart its
 * round and its pass; the reviewer itself is named separately.
 */
export function locateReviewerRerun(
  pipeline: BuildPipeline,
  reviewerId: string,
): Extract<RestartTarget, { kind: "session" }> | Error {
  const anchor = reviewerRerunAnchor(pipeline, reviewerId);
  if (!anchor) return new Error("This reviewer is no longer part of the current review");
  if (!anchorsPanelSlot(anchor)) {
    return new Error("Only a reviewer of a review panel can restart on its own");
  }
  return { kind: "session", session: anchor, phase: "review", forceStage: true };
}

function reviewerRerunAnchor(
  pipeline: BuildPipeline,
  reviewerId: string,
): PipelineSession | undefined {
  const live = pipeline.reviewFanout;
  const record = live?.reviewers.find((reviewer) => namesReviewer(reviewer, reviewerId));
  if (live && record) {
    const own = record.sessionKey ? findStageSession(pipeline, record.sessionKey) : undefined;
    if (own) return own;
    const passId = live.reviewers[0]?.id;
    return pipeline.sessions.findLast(
      (session) =>
        (session.sessionKey === live.consolidation?.sessionKey ||
          (passId !== undefined && session.reviewPassId === passId)) &&
        isConsolidationSession(session),
    );
  }
  const named = findStageSession(pipeline, reviewerId);
  if (named) return named;
  // A sessionless slot of a pass the pipeline has moved on from is known only
  // to the panel its Consolidation recorded.
  return pipeline.sessions.findLast(
    (session) =>
      session.iteration === pipeline.iteration &&
      session.phase === "review" &&
      isConsolidationSession(session) &&
      !isSupersededPipelineSession(session) &&
      session.superseded !== true &&
      Boolean(
        panelFromSessions(pipeline, session)?.reviewers.some(
          (reviewer) => reviewer.id === reviewerId,
        ),
      ),
  );
}

/**
 * Whether the anchor can carry a per-slot rerun: a reviewer session of a panel,
 * or a panel's Consolidation (for a sessionless slot).
 */
export function anchorsPanelSlot(session: PipelineSession): boolean {
  if (!session.reviewPassId) return false;
  return isConsolidationSession(session) || isPanelReviewerSession(session, session.reviewPassId);
}

/**
 * The refusal for rerunning a slot of `panel` now, or null. A rerun supersedes
 * Consolidation and every step after it, so while one of those steps runs the
 * user pauses the pipeline first: the rerun never stops a running step as a
 * side effect of a reviewer button, and nothing races its own supersede. The
 * live pass itself is not "a later step", even once it has consolidated.
 */
export function reviewerRerunRefusal(
  pipeline: BuildPipeline,
  panel: ReviewFanoutState,
): Error | null {
  if (panel === pipeline.reviewFanout) return null;
  if (!isActiveBuildPhase(pipeline.phase)) return null;
  return new Error(
    "A step after this review is running. Pause the pipeline, then restart the reviewer.",
  );
}

/**
 * The record of `panel` that `reviewerId` names: by record id or session key,
 * else, when the anchor is a reviewer session, the record of its slot (the
 * name of an earlier attempt still means that slot).
 */
export function rerunRecord(
  panel: ReviewFanoutState,
  anchor: PipelineSession,
  reviewerId: string,
): ReviewerRecord | undefined {
  const named = panel.reviewers.find((reviewer) => namesReviewer(reviewer, reviewerId));
  if (named) return named;
  if (!anchor.reviewPassId || !isPanelReviewerSession(anchor, anchor.reviewPassId))
    return undefined;
  return panel.reviewers[pipelineIndependentReviewSlot(anchor.label) ?? -1];
}

/** The phase a paused or failed pipeline stopped in, else its own. */
export function reviewPhaseOf(candidate: BuildPipeline): BuildPipeline["phase"] | undefined {
  return candidate.phase === "paused"
    ? candidate.pausedFromPhase
    : candidate.phase === "failed"
      ? candidate.failureContext?.phase
      : candidate.phase;
}

/** A reviewer retry or restart resumes a review that failed or paused. */
export function resumeReview(candidate: BuildPipeline): void {
  if (candidate.phase === "failed" || candidate.phase === "paused") {
    candidate.phase = "reviewing";
    delete candidate.pausedFromPhase;
    delete candidate.pauseCause;
    delete candidate.error;
    delete candidate.failureContext;
    delete candidate.cancelledAt;
    delete candidate.reconnectAttempt;
    delete candidate.stageRetryRequested;
    delete candidate.completionCommentStatus;
    delete candidate.completionCommentError;
  }
  delete candidate.stallWarning;
}
