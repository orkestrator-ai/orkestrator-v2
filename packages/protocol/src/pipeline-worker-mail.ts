/**
 * Build pipeline workers as agent mailboxes.
 *
 * Every agent session a build pipeline runs (build, package preparation, each
 * reviewer, consolidation, address, verify, fix, PR and conflict resolution,
 * in every round) is one worker instance with its own mailbox. Its address is
 * the pipeline environment plus a tab id derived from the session's own key,
 * which the pipeline mints before the session exists and never reuses, so a
 * message always names exactly one worker and is never re-routed to another.
 *
 * Everything here is derived from the pipeline record alone, so the backend's
 * mailbox directory, the coordinator's `get_build_pipeline` summary and a
 * command node reading a leaf's pipeline all agree on the same list.
 */
import {
  BUILD_CANCELLED_ERROR,
  REVIEW_PACKAGE_SESSION_LABEL,
  isSupersededPipelineSession,
  pipelineIndependentReviewSlot,
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSession,
  type PipelineSessionPhase,
} from "./build-pipeline.js";
import type { ReviewerRecord } from "./review-fanout.js";

/** The pane-layout tab type a worker mailbox reports; no pane ever holds one. */
export const PIPELINE_WORKER_TAB_TYPE = "pipeline-worker";

const PIPELINE_WORKER_TAB_PREFIX = "pipeline-worker:";
const CONSOLIDATION_SESSION_KEY_PART = ":review-consolidation:";
const CONSOLIDATION_LABEL = "Consolidation";

/** A worker's mailbox tab id: stable, known before its session starts, never reused. */
export function pipelineWorkerTabId(sessionKey: string): string {
  return `${PIPELINE_WORKER_TAB_PREFIX}${sessionKey}`;
}

/** The session key a worker address names, or null for any other tab id. */
export function pipelineWorkerSessionKey(tabId: string): string | null {
  return tabId.startsWith(PIPELINE_WORKER_TAB_PREFIX) &&
    tabId.length > PIPELINE_WORKER_TAB_PREFIX.length
    ? tabId.slice(PIPELINE_WORKER_TAB_PREFIX.length)
    : null;
}

export function isPipelineWorkerTabId(tabId: string): boolean {
  return pipelineWorkerSessionKey(tabId) !== null;
}

/**
 * `running`: its turn is in progress. `idle`: it is still the pipeline's live
 * worker for its step but between turns (the pipeline is paused, or about to
 * hand it queued mail). The other three are final: the worker refuses new
 * mail, and mail still queued for it expires.
 */
export const PIPELINE_WORKER_STATUSES = [
  "running",
  "idle",
  "finished",
  "failed",
  "cancelled",
] as const;
export type PipelineWorkerStatus = (typeof PIPELINE_WORKER_STATUSES)[number];

export function pipelineWorkerEnded(status: PipelineWorkerStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}

/** Which part of the pipeline a worker runs. */
export type PipelineWorkerStep = PipelineSessionPhase | "preparation" | "consolidation";

export interface PipelineWorker {
  /** The mailbox tab id: `toTabId` for `send_message` and `get_tab_transcript`. */
  address: string;
  environmentId: string;
  pipelineId: string;
  /** The pipeline session's own key; the address is derived from it. */
  sessionKey: string;
  step: PipelineWorkerStep;
  /** One-based round (the pipeline's iteration + 1). */
  round: number;
  /** One-based reviewer slot, for a reviewer of a multi-reviewer review step. */
  slot?: number;
  label: string;
  agent: BuildPipelineAgent;
  model?: string;
  status: PipelineWorkerStatus;
}

function cancelledPipeline(pipeline: Pick<BuildPipeline, "phase" | "error">): boolean {
  return pipeline.phase === "failed" && (pipeline.error ?? "").startsWith(BUILD_CANCELLED_ERROR);
}

function stepOf(session: Pick<PipelineSession, "phase" | "label" | "sessionKey">): {
  step: PipelineWorkerStep;
  slot?: number;
} {
  if (session.label === REVIEW_PACKAGE_SESSION_LABEL) return { step: "preparation" };
  if (session.phase === "review") {
    if (
      session.label === CONSOLIDATION_LABEL ||
      session.sessionKey.includes(CONSOLIDATION_SESSION_KEY_PART)
    ) {
      return { step: "consolidation" };
    }
    const slot = pipelineIndependentReviewSlot(session.label);
    if (slot !== null) return { step: "review", slot: slot + 1 };
  }
  return { step: session.phase };
}

function reviewerStatus(record: Pick<ReviewerRecord, "status">, running: boolean) {
  switch (record.status) {
    case "pending":
      return running ? "running" : "idle";
    case "running":
      return "running";
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * Every worker instance a pipeline has started, oldest first, with its
 * current status. A reviewer the fan-out has queued but not yet given a
 * session is not a worker yet: mail goes to instances that exist.
 */
export function pipelineWorkers(
  pipeline: Pick<
    BuildPipeline,
    | "id"
    | "environmentId"
    | "agentType"
    | "phase"
    | "error"
    | "sessions"
    | "currentSessionIndex"
    | "reviewFanout"
  >,
): PipelineWorker[] {
  if (!pipeline.environmentId || !Array.isArray(pipeline.sessions)) return [];
  const terminal = pipeline.phase === "complete" || pipeline.phase === "failed";
  const fanout = pipeline.reviewFanout;
  const reviewers = new Map<string, { record: ReviewerRecord; slot: number }>();
  (fanout?.reviewers ?? []).forEach((record, index) => {
    if (record.sessionKey) reviewers.set(record.sessionKey, { record, slot: index + 1 });
  });
  const consolidationKey = fanout?.report ? undefined : fanout?.consolidation?.sessionKey;
  const current = pipeline.sessions[pipeline.currentSessionIndex];
  const workers: PipelineWorker[] = [];
  const seen = new Set<string>();
  for (const session of pipeline.sessions) {
    if (!session?.sessionKey || seen.has(session.sessionKey)) continue;
    seen.add(session.sessionKey);
    const { step, slot } = stepOf(session);
    const reviewer = reviewers.get(session.sessionKey);
    let status: PipelineWorkerStatus;
    if (isSupersededPipelineSession(session) || session.skipped) status = "cancelled";
    else if (
      terminal &&
      pipeline.phase === "failed" &&
      (reviewer
        ? ["pending", "running"].includes(reviewer.record.status)
        : session.sessionKey === consolidationKey ||
          session === current ||
          session.status === "running")
    ) {
      status = cancelledPipeline(pipeline) ? "cancelled" : "failed";
    } else if (reviewer) {
      status = reviewerStatus(reviewer.record, session.status === "running");
    } else if (!terminal && (session.sessionKey === consolidationKey || session === current)) {
      status = session.status === "running" ? "running" : "idle";
    } else if (session.reviewerOutcome === "cancelled") status = "cancelled";
    else if (session.status === "error" || session.reviewerOutcome === "failed") status = "failed";
    else if (terminal && session === current)
      status = cancelledPipeline(pipeline)
        ? "cancelled"
        : pipeline.phase === "failed"
          ? "failed"
          : "finished";
    else status = "finished";
    workers.push({
      address: pipelineWorkerTabId(session.sessionKey),
      environmentId: pipeline.environmentId,
      pipelineId: pipeline.id,
      sessionKey: session.sessionKey,
      step,
      round: session.iteration + 1,
      ...(reviewer ? { slot: reviewer.slot } : slot !== undefined ? { slot } : {}),
      label: session.label,
      agent: session.agent ?? pipeline.agentType,
      ...(session.model ? { model: session.model } : {}),
      status,
    });
  }
  // Reviewers running in the live pass whose session row is not mirrored yet.
  for (const [sessionKey, { record, slot }] of reviewers) {
    if (seen.has(sessionKey) || !record.providerSessionId) continue;
    seen.add(sessionKey);
    workers.push({
      address: pipelineWorkerTabId(sessionKey),
      environmentId: pipeline.environmentId,
      pipelineId: pipeline.id,
      sessionKey,
      step: "review",
      round: Number(/:review:(\d+):/.exec(sessionKey)?.[1] ?? 0) + 1,
      slot,
      label: `Reviewer ${slot}`,
      agent: record.agent as BuildPipelineAgent,
      ...(record.model && !record.modelUnpinned ? { model: record.model } : {}),
      status:
        terminal && ["pending", "running"].includes(record.status)
          ? cancelledPipeline(pipeline)
            ? "cancelled"
            : "failed"
          : reviewerStatus(record, record.status === "running"),
    });
  }
  return workers;
}

/** The worker one address names in this pipeline, or undefined. */
export function pipelineWorker(
  pipeline: Parameters<typeof pipelineWorkers>[0],
  address: string,
): PipelineWorker | undefined {
  const sessionKey = pipelineWorkerSessionKey(address);
  if (!sessionKey || !sessionKey.startsWith(`${pipeline.id}:`)) return undefined;
  return pipelineWorkers(pipeline).find((worker) => worker.sessionKey === sessionKey);
}

/** One line per worker, for refusals that must name the choices. */
export function describePipelineWorkers(workers: readonly PipelineWorker[]): string {
  return workers
    .map(
      (worker) =>
        `${worker.address} (${worker.label}, round ${worker.round}${
          worker.slot ? `, reviewer ${worker.slot}` : ""
        }, ${worker.status})`,
    )
    .join("; ");
}
