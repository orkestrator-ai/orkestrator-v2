/**
 * The completion comment of a Linear-sourced build (docs/architecture/tickets.md,
 * "Completion comments on Linear issues").
 *
 * The build stages its ending in `linear-pending-comments` before posting.
 * The queue survives restart and environment removal. The local drain and
 * attached command node use the same lease, and the queue keeps a delivery
 * receipt until the pipeline status has been reconciled.
 *
 * Posting is safe to repeat: each run's comment carries a hidden marker per
 * ending, and every attempt looks for it first.
 */
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { IntegrationLocks } from "./integration-locks.js";
import {
  postLinearCompletionComment,
  sanitizeLinearError,
  type LinearCompletionCommentResult,
} from "./linear.js";
import {
  LINEAR_NOT_CONNECTED_HERE,
  LINEAR_WRITE_MAX_RETRY_MS,
  LINEAR_WRITE_RETRY_MS,
  LINEAR_WRITE_TIMEOUT_MS,
  raceAbort,
  LinearDrainLoop,
  linearWriteRetryDelay,
  type LinearDrainClock,
} from "./linear-write-drain.js";
import {
  ownsLinearWrite,
  type KanbanStorage,
  type LinearCommentOutcome,
  type LinearStorage,
  type LinearPendingComment,
  type LinearWriteClaimRef,
} from "./storage/index.js";

const log = createLogger("linear");

/** How long this machine's own attempt holds a comment; past it, it is due again. */
const LINEAR_LOCAL_CLAIM_MS = 2 * LINEAR_WRITE_TIMEOUT_MS;
const LINEAR_LOCAL_OWNER = "local";

export interface LinearCommentsStorage {
  getProject(projectId: string): Promise<{ id: string } | null>;
  kanban: Pick<
    KanbanStorage,
    "getLinearAuth" | "getLinearCompletionComment" | "saveLinearCompletionComment"
  >;
  linear: Pick<
    LinearStorage,
    | "listLinearPendingComments"
    | "enqueueLinearPendingComment"
    | "claimLinearPendingComments"
    | "recordLinearPendingCommentReceipt"
    | "finishLinearPendingComment"
    | "isProjectWriteFenced"
    | "deferLinearPendingComment"
  >;
}

export type LinearCompletionCommentInput = {
  pipelineId: string;
  issueId: string;
  body: string;
  outcome?: LinearCommentOutcome;
};

export type LinearCommentPosted = {
  pipelineId: string;
  outcome: LinearCommentOutcome;
  commentId: string;
  postedAt?: string;
};

/**
 * Posts a run's comment and records it, unless this ending's is already
 * recorded. Runs after the pipeline's previous attempt on this machine.
 */
export function postRecordedLinearCompletionComment(
  storage: Pick<LinearCommentsStorage, "kanban"> & {
    linear?: Pick<LinearStorage, "listLinearPendingComments">;
  },
  locks: Pick<IntegrationLocks, "withLinearCompletionComment">,
  requireApiKey: () => Promise<string>,
  { pipelineId, issueId, body, outcome }: LinearCompletionCommentInput,
  signal?: AbortSignal,
): Promise<LinearCompletionCommentResult> {
  return locks.withLinearCompletionComment(pipelineId, async () => {
    const requireUnqueued = async () => {
      const pending = await storage.linear?.listLinearPendingComments();
      if (pending?.some((entry) => entry.pipelineId === pipelineId)) {
        throw new Error("The Linear completion comment is already queued for delivery.");
      }
    };
    await requireUnqueued();
    const existing = await storage.kanban.getLinearCompletionComment(pipelineId);
    // A failed run's comment says nothing about the completion that followed it.
    if (existing?.status === "posted" && existing.commentId && existing.outcome === outcome) {
      return {
        status: "already-posted",
        commentId: existing.commentId,
        postedAt: existing.postedAt,
      };
    }
    const apiKey = await requireApiKey();
    const ending = outcome ? { outcome } : {};
    try {
      const result = await postLinearCompletionComment(
        apiKey,
        { pipelineId, issueId, body, ...ending },
        signal,
        requireUnqueued,
      );
      await storage.kanban.saveLinearCompletionComment({
        pipelineId,
        issueId,
        ...ending,
        status: "posted",
        commentId: result.commentId,
        postedAt: result.postedAt ?? new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const message = sanitizeLinearError(error, apiKey);
      if (existing?.status !== "posted") {
        await storage.kanban.saveLinearCompletionComment({
          pipelineId,
          issueId,
          ...ending,
          status: "failed",
          error: message,
        });
      }
      throw new Error(message);
    }
  });
}

/**
 * One backend's queue of unposted completion comments and its drain timer.
 * Owned by `BackendRuntime` as `linearCompletionComments`; `shutdown()` stops it.
 */
export class LinearCompletionComments {
  private storage: LinearCommentsStorage | null = null;
  private readonly stop = new AbortController();
  private readonly loop: LinearDrainLoop;
  private posted: ((comment: LinearCommentPosted) => Promise<void>) | null = null;

  constructor(
    private readonly locks: Pick<IntegrationLocks, "withLinearCompletionComment">,
    clock: LinearDrainClock = {},
  ) {
    this.loop = new LinearDrainLoop(
      () => this.drain(),
      (error) => log.warn("completion-comment.queue-failed", { error: formatLogError(error) }),
      clock,
    );
  }

  /** Restarts the drain for comments an earlier process left queued. */
  start(storage: LinearCommentsStorage): void {
    this.storage = storage;
    this.loop.request();
  }

  /** Told of each comment posted from the queue, so the pipeline can show it. */
  onPosted(listener: (comment: LinearCommentPosted) => Promise<void>): void {
    this.posted = listener;
  }

  /** Stage the ending before attempting any mutation, including manual retries. */
  async submit(
    storage: LinearCommentsStorage,
    pipeline: Pick<BuildPipeline, "id" | "projectId" | "source">,
    ending: { outcome: LinearCommentOutcome; body: string },
  ): Promise<LinearCompletionCommentResult> {
    if (!(await this.enqueue(storage, pipeline, ending))) {
      throw new Error("The Linear completion comment could not be queued");
    }
    try {
      const apiKey = (await storage.kanban.getLinearAuth())?.apiKey;
      if (!apiKey) {
        throw new Error(
          `${LINEAR_NOT_CONNECTED_HERE}. The comment is queued until this machine or its command node can post it.`,
        );
      }
      const now = this.loop.now();
      const [record] = storage.linear.claimLinearPendingComments(
        1,
        new Date(now + LINEAR_LOCAL_CLAIM_MS),
        new Date(now),
        LINEAR_LOCAL_OWNER,
        { pipelineId: pipeline.id, outcome: ending.outcome },
      );
      if (!record) {
        throw new Error("The Linear completion comment is already queued for delivery.");
      }
      try {
        const signal = AbortSignal.any([
          this.stop.signal,
          AbortSignal.timeout(LINEAR_WRITE_TIMEOUT_MS),
        ]);
        return await raceAbort((abort) => this.post(storage, apiKey, record, abort), signal);
      } catch (error) {
        throw new Error(
          `${this.defer(storage, record, error, apiKey).replace(/[.\s]+$/, "")}. The comment is queued and will be retried.`,
        );
      }
    } finally {
      this.loop.request();
    }
  }

  /** Restore a retained ending without forcing a retry or changing an existing queue entry. */
  async restore(
    storage: LinearCommentsStorage,
    pipeline: Pick<BuildPipeline, "id" | "projectId" | "source">,
    ending: { outcome: LinearCommentOutcome; body: string },
  ): Promise<void> {
    if (!(await this.enqueue(storage, pipeline, ending))) return;
    const recorded = await storage.kanban.getLinearCompletionComment(pipeline.id);
    if (
      recorded?.status !== "posted" ||
      recorded.outcome !== ending.outcome ||
      !recorded.commentId ||
      pipeline.source?.type !== "linear" ||
      recorded.issueId !== pipeline.source.issueId
    )
      return;
    const now = this.loop.now();
    const [record] = storage.linear.claimLinearPendingComments(
      1,
      new Date(now + LINEAR_LOCAL_CLAIM_MS),
      new Date(now),
      LINEAR_LOCAL_OWNER,
      { pipelineId: pipeline.id, outcome: ending.outcome },
    );
    if (record?.claim) {
      this.recordReceipt(
        storage,
        record.outcome,
        pipeline.id,
        record.claim,
        {
          commentId: recorded.commentId,
          postedAt: recorded.postedAt,
        },
        new Date(now),
      );
    }
  }

  private async enqueue(
    storage: LinearCommentsStorage,
    pipeline: Pick<BuildPipeline, "id" | "projectId" | "source">,
    ending: { outcome: LinearCommentOutcome; body: string },
  ): Promise<boolean> {
    if (this.loop.closed || pipeline.source?.type !== "linear") return false;
    const source = pipeline.source;
    if (!(await storage.getProject(pipeline.projectId)) || this.loop.closed) return false;
    this.storage = storage;
    const now = new Date(this.loop.now());
    const queued = storage.linear.enqueueLinearPendingComment(
      {
        ...ending,
        pipelineId: pipeline.id,
        projectId: pipeline.projectId,
        issueId: source.issueId,
        ...(source.issueIdentifier ? { issueIdentifier: source.issueIdentifier } : {}),
      },
      { error: "", nextAttemptAt: now },
      now,
    );
    return queued === "queued";
  }

  recordReceipt(
    storage: LinearCommentsStorage,
    outcome: LinearCommentOutcome,
    pipelineId: string,
    claim: LinearWriteClaimRef,
    result: { commentId: string; postedAt?: string },
    now: Date,
  ): boolean {
    return storage.linear.recordLinearPendingCommentReceipt(
      pipelineId,
      outcome,
      claim,
      {
        commentId: result.commentId,
        postedAt: result.postedAt ?? now.toISOString(),
      },
      now,
    );
  }

  /** Reconcile a persisted receipt even on a keyless machine. Retain it on storage failure. */
  async reconcileReceipts(storage: LinearCommentsStorage): Promise<void> {
    for (const record of await storage.linear.listLinearPendingComments()) {
      const { receipt, pipelineId, outcome, issueId } = record;
      if (!receipt || this.loop.closed || storage.linear.isProjectWriteFenced(record.projectId))
        continue;
      await this.locks.withLinearCompletionComment(pipelineId, async () => {
        const current = (await storage.linear.listLinearPendingComments()).find(
          (entry) =>
            entry.pipelineId === pipelineId &&
            entry.outcome === outcome &&
            entry.receipt?.commentId === receipt.commentId,
        );
        if (!current || storage.linear.isProjectWriteFenced(record.projectId)) return;
        const existing = await storage.kanban.getLinearCompletionComment(pipelineId);
        if (
          existing?.status === "posted" &&
          existing.outcome === "complete" &&
          outcome === "failed"
        )
          return;
        await storage.kanban.saveLinearCompletionComment({
          pipelineId,
          issueId,
          outcome,
          status: "posted",
          ...receipt,
        });
      });
      await this.posted?.({ pipelineId, outcome, ...receipt });
      storage.linear.finishLinearPendingComment(pipelineId, outcome, receipt.commentId);
    }
  }

  requestDrain(): void {
    if (this.storage) this.loop.request();
  }

  shutdown(): void {
    this.stop.abort(new Error("Completion comment queue stopped"));
    this.loop.stop("Completion comment queue stopped");
  }

  async idle(): Promise<void> {
    while (this.loop.running) await this.loop.running;
  }

  private async drain(): Promise<number> {
    const storage = this.storage;
    if (!storage) return Number.POSITIVE_INFINITY;
    await this.reconcileReceipts(storage);
    while (!this.loop.closed) {
      const now = this.loop.now();
      const pending = await storage.linear.listLinearPendingComments();
      const next = Math.min(
        Infinity,
        ...pending.map((record) =>
          storage.linear.isProjectWriteFenced(record.projectId)
            ? now + LINEAR_WRITE_RETRY_MS
            : Date.parse(record.nextAttemptAt),
        ),
      );
      if (next > now) return next;
      const apiKey = (await storage.kanban.getLinearAuth())?.apiKey;
      // Keep it due for the command node.
      if (!apiKey) return now + LINEAR_WRITE_MAX_RETRY_MS;
      const [record] = storage.linear.claimLinearPendingComments(
        1,
        new Date(now + LINEAR_LOCAL_CLAIM_MS),
        new Date(now),
        LINEAR_LOCAL_OWNER,
      );
      if (!record) return now + LINEAR_WRITE_RETRY_MS;
      try {
        await this.loop.bounded((signal) => this.post(storage, apiKey, record, signal));
      } catch (error) {
        if (!this.loop.closed) this.defer(storage, record, error, apiKey);
        continue;
      }
      await this.reconcileReceipts(storage);
    }
    return Number.POSITIVE_INFINITY;
  }

  private async post(
    storage: LinearCommentsStorage,
    apiKey: string,
    record: LinearPendingComment,
    signal: AbortSignal,
  ): Promise<LinearCompletionCommentResult> {
    const { claim, pipelineId, outcome, issueId, body } = record;
    if (!claim) throw new Error("Missing Linear comment claim");
    const check = async () => {
      const auth = await storage.kanban.getLinearAuth();
      const pending = (await storage.linear.listLinearPendingComments()).find(
        (entry) => entry.pipelineId === pipelineId && entry.outcome === outcome,
      );
      if (
        !pending ||
        storage.linear.isProjectWriteFenced(record.projectId) ||
        !ownsLinearWrite(pending, claim, new Date(this.loop.now()))
      ) {
        throw new Error("Linear comment claim has expired or been revoked");
      }
      if (auth?.apiKey !== apiKey) throw new Error("Linear connection changed");
      signal.throwIfAborted();
    };
    return this.locks.withLinearCompletionComment(pipelineId, async () => {
      await check();
      const existing = await storage.kanban.getLinearCompletionComment(pipelineId);
      const result =
        existing?.status === "posted" &&
        existing.commentId &&
        existing.issueId === issueId &&
        (existing.outcome === outcome || existing.outcome === "complete")
          ? {
              status: "already-posted" as const,
              commentId: existing.commentId,
              postedAt: existing.postedAt,
            }
          : await postLinearCompletionComment(
              apiKey,
              { pipelineId, issueId, body, outcome },
              signal,
              check,
            );
      signal.throwIfAborted();
      if (
        !this.recordReceipt(storage, outcome, pipelineId, claim, result, new Date(this.loop.now()))
      ) {
        throw new Error("Linear comment claim has expired or been revoked");
      }
      return result;
    });
  }

  private defer(
    storage: LinearCommentsStorage,
    record: LinearPendingComment,
    error: unknown,
    apiKey: string,
  ): string {
    const reason = sanitizeLinearError(error, apiKey);
    if (!record.claim) return reason;
    const now = new Date(this.loop.now());
    const attempts = record.attempts + 1;
    const delay = linearWriteRetryDelay(attempts);
    storage.linear.deferLinearPendingComment(
      record.pipelineId,
      record.outcome,
      {
        error: reason,
        nextAttemptAt: new Date(now.getTime() + delay),
      },
      record.claim,
      now,
    );
    log.warn("completion-comment.failed", {
      pipelineId: record.pipelineId,
      issue: record.issueIdentifier ?? record.issueId,
      attempts,
      retryInMs: delay,
    });
    return reason;
  }
}
