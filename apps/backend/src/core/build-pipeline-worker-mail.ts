/**
 * The pipeline's side of agent mail to its workers
 * (docs/architecture/coordinator.md, "Pipeline worker mailboxes").
 *
 * The agent mail store owns every message and its placement. The pipeline
 * owns its workers' turns, so it answers three questions for the mail drain
 * and does one thing at a turn boundary:
 *
 * - `state`: is this worker running a turn, between turns, or ended;
 * - `steer`: put a `deliverNow` message into the worker's running turn, under
 *   the pipeline lock so no pass can advance the stage in between;
 * - `reconcileDelivery` / `reconcileSteer`: after a restart, did a claimed
 *   delivery reach the worker;
 * - at turn end (`BuildPipelineSupervisor`), queued mail for the current
 *   session becomes that session's next turn before the pipeline advances,
 *   through the same at-most-once prompt attempt every stage prompt uses.
 *
 * A worker's identity is its session key, so mail is never moved to a later
 * session of the same step.
 */
import { randomUUID } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  pipelineWorker,
  pipelineWorkerEnded,
  pipelineWorkerSessionKey,
  pipelineWorkerTabId,
  type PipelineWorkerStatus,
} from "@orkestrator/protocol/pipeline-worker-mail";
import {
  isBuildPipeline,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import { PromptRejectedError } from "./build-pipeline-provider.js";
import { discardPreparationResult, resumablePhase } from "./build-pipeline-service-helpers.js";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import type { MailSteerDispatchOutcome } from "./native-agent-service-shared.js";

const log = createLogger("build-pipeline");

/** The bound on how many recent mail deliveries a session remembers for restart reconciliation. */
export const MAX_PIPELINE_SESSION_MAIL_DELIVERIES = 20;

/** What the mail drain asks a pipeline about one of its worker mailboxes. */
export interface PipelineWorkerMailPort {
  /** The worker's status, or null when no pipeline in that environment has it. */
  state(environmentId: string, tabId: string): Promise<PipelineWorkerStatus | null>;
  steer(input: {
    environmentId: string;
    tabId: string;
    text: string;
    requestId: string;
  }): Promise<MailSteerDispatchOutcome>;
  reconcileDelivery(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown">;
  reconcileSteer(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown">;
}

export class BuildPipelineWorkerMail implements PipelineWorkerMailPort {
  constructor(
    private readonly ctx: BuildPipelineContext,
    private readonly agents: BuildPipelineAgents,
  ) {}

  private async pipelineFor(environmentId: string, tabId: string): Promise<BuildPipeline | null> {
    const sessionKey = pipelineWorkerSessionKey(tabId);
    if (!sessionKey) return null;
    const records = await this.ctx.storage.listBuildPipelineWorkers(environmentId);
    const owner = records.find((entry) =>
      entry.workers.some((worker) => worker.sessionKey === sessionKey),
    );
    if (!owner) return null;
    const record = await this.ctx.storage.getBuildPipeline(owner.pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return null;
    const pipeline = record.snapshot;
    pipeline.backendRevision = record.revision;
    return pipeline;
  }

  async state(environmentId: string, tabId: string): Promise<PipelineWorkerStatus | null> {
    const pipeline = await this.pipelineFor(environmentId, tabId);
    return pipeline ? (pipelineWorker(pipeline, tabId)?.status ?? null) : null;
  }

  /** The provider session and harness a live worker runs on. */
  private liveSession(pipeline: BuildPipeline, tabId: string) {
    const worker = pipelineWorker(pipeline, tabId);
    if (!worker || pipelineWorkerEnded(worker.status)) return null;
    const session = pipeline.sessions.find(
      (candidate) => candidate.sessionKey === worker.sessionKey,
    );
    const reviewer = pipeline.reviewFanout?.reviewers.find(
      (candidate) => candidate.sessionKey === worker.sessionKey,
    );
    const sessionId = session?.sdkSessionId ?? reviewer?.providerSessionId;
    if (!sessionId) return null;
    return { worker, session, sessionId, agent: worker.agent };
  }

  /**
   * Steer into the worker's running turn. Runs under the pipeline lock, so no
   * supervisor pass ends the turn and advances the stage between reading it
   * and steering it. `idle` means nothing was sent: the turn is over, and the
   * pipeline hands the mail over as the worker's next turn instead.
   */
  async steer(input: {
    environmentId: string;
    tabId: string;
    text: string;
    requestId: string;
  }): Promise<MailSteerDispatchOutcome> {
    const located = await this.pipelineFor(input.environmentId, input.tabId);
    if (!located) return { outcome: "refused", reason: "steer-refused" };
    return this.ctx.withLock(located.id, async () => {
      const pipeline = await this.pipelineFor(input.environmentId, input.tabId);
      const live = pipeline ? this.liveSession(pipeline, input.tabId) : null;
      if (!pipeline || !live) return { outcome: "refused", reason: "steer-refused" } as const;
      if (live.worker.status !== "running") return { outcome: "idle" } as const;
      // A prompt whose dispatch is unconfirmed has not started its turn yet;
      // steering now would reach the turn before it.
      if (pipeline.pendingPromptAttempt?.sessionId === live.sessionId)
        return { outcome: "refused", reason: "steer-refused" } as const;
      const provider = await this.agents.provider(pipeline, live.agent);
      if (!provider.steerSupported || !provider.activeSteerRun || !provider.performSessionAction)
        return { outcome: "refused", reason: "steer-unsupported" } as const;
      if (!(await provider.steerSupported(live.sessionId).catch(() => false)))
        return { outcome: "refused", reason: "steer-unsupported" } as const;
      const active = await provider.activeSteerRun(live.sessionId).catch(() => undefined);
      if (active?.state !== "running") return { outcome: "idle" } as const;
      const discardPreparation = async () => {
        // A steered build or fix may change the work a preparation result
        // described, exactly as a steer from the pipeline tab does. Saved
        // here, under the lock this steer already holds.
        if (!live.session || (pipeline.phase !== "building" && pipeline.phase !== "fixing")) return;
        const record = await this.ctx.requireRecord(pipeline.id);
        const fresh = record.snapshot as BuildPipeline;
        fresh.backendRevision = record.revision;
        const session = fresh.sessions.find((item) => item.sessionKey === live.session!.sessionKey);
        if (!session) return;
        discardPreparationResult(session);
        await this.ctx.save(fresh, fresh.backendRevision);
      };
      let outcome;
      try {
        outcome = await provider.performSessionAction(live.sessionId, {
          kind: "steer",
          text: input.text,
          requestId: input.requestId,
          expectedRunId: active.runId,
        });
      } catch (error) {
        if (error instanceof PromptRejectedError)
          return { outcome: "refused", reason: "steer-refused" } as const;
        return { outcome: "unknown" } as const;
      }
      switch (outcome.outcome) {
        case "applied":
          await discardPreparation().catch(() => undefined);
          return { outcome: "applied" } as const;
        case "rejected":
          return { outcome: "refused", reason: "steer-refused" } as const;
        case "unknown":
          return { outcome: "unknown" } as const;
        default:
          return { outcome: "idle" } as const;
      }
    });
  }

  /**
   * A claimed delivery from before a restart: the supervisor records every
   * mail turn's request id on the session in the same save that journals the
   * prompt attempt, so its presence proves the pipeline owns the delivery.
   */
  async reconcileDelivery(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const pipeline = await this.pipelineFor(environmentId, tabId).catch(() => null);
    if (!pipeline) return "unknown";
    const sessionKey = pipelineWorkerSessionKey(tabId);
    const session = pipeline.sessions.find((candidate) => candidate.sessionKey === sessionKey);
    if (!session) return "unknown";
    return session.mailDeliveries?.includes(requestId) ||
      pipeline.pendingPromptAttempt?.requestId === requestId
      ? "dispatched"
      : "not-dispatched";
  }

  async reconcileSteer(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const pipeline = await this.pipelineFor(environmentId, tabId).catch(() => null);
    const live = pipeline ? this.liveSession(pipeline, tabId) : null;
    if (!pipeline || !live) return "unknown";
    try {
      const provider = await this.agents.provider(pipeline, live.agent);
      if (!provider.steerStatus) return "unknown";
      const status = await provider.steerStatus(live.sessionId, requestId);
      return status === "dispatched"
        ? "dispatched"
        : status === "absent"
          ? "not-dispatched"
          : "unknown";
    } catch {
      return "unknown";
    }
  }
}

/**
 * Hands the mail queued for the current session's worker mailbox to that
 * session as one turn, the way a queued user message is: journaled as the
 * pending prompt attempt (with its id on the session, for restart
 * reconciliation) before it is sent, so it is delivered at most once.
 * Returns whether a turn was started. A worker in a fan-out review, or a
 * build whose validation runs against a fixed snapshot, gets none: its
 * queued mail expires when it ends, and the sender is told.
 */
export async function dispatchWorkerMailTurn(
  ctx: BuildPipelineContext,
  pipeline: BuildPipeline,
  session: PipelineSession,
  dispatchPending: () => Promise<void>,
): Promise<boolean> {
  const mailbox = ctx.workerMailbox;
  const phase = resumablePhase(pipeline.phase);
  if (!mailbox || !phase || pipeline.reviewFanout) return false;
  if (pipeline.validationRun && !pipeline.reviewPackage) return false;
  const tabId = pipelineWorkerTabId(session.sessionKey);
  const requestId = randomUUID();
  const claim = await mailbox
    .claim(pipeline.environmentId, tabId, requestId)
    .catch((error: unknown) => {
      log.warn("worker-mail.claim-failed", {
        pipelineId: pipeline.id,
        error: formatLogError(error),
      });
      return null;
    });
  if (!claim) return false;
  try {
    if (phase === "building" || phase === "fixing") discardPreparationResult(session);
    const startedAt = new Date().toISOString();
    pipeline.pendingPromptAttempt = {
      dispatchVersion: 1,
      id: requestId,
      sessionId: session.sdkSessionId,
      requestId,
      phase,
      prompt: claim.text,
      useTaskImages: false,
      startedAt,
    };
    session.mailDeliveries = [...(session.mailDeliveries ?? []), requestId].slice(
      -MAX_PIPELINE_SESSION_MAIL_DELIVERIES,
    );
    session.turnStartedAt = startedAt;
    delete session.completedAt;
    delete session.usageFinalizationPolls;
    delete pipeline.stallWarning;
    await ctx.save(pipeline, pipeline.backendRevision);
  } catch (error) {
    // Nothing was journaled: the mail goes back to the queue.
    await mailbox
      .settle(pipeline.environmentId, tabId, claim.messageIds, "returned")
      .catch(() => undefined);
    throw error;
  }
  // The journaled attempt owns delivery from here: it is sent, resent only on
  // the provider's proof it never arrived, or failed with the stage, and a
  // stage retry resends this same attempt. Returning the mail to the queue as
  // well could deliver it twice.
  await mailbox
    .settle(pipeline.environmentId, tabId, claim.messageIds, "accepted")
    .catch(() => undefined);
  await dispatchPending();
  return true;
}
