/**
 * The completion comment of a Linear-sourced build (docs/architecture/tickets.md,
 * "Completion comments on Linear issues").
 *
 * The build posts it as it ends (`post_linear_completion_comment`). When that
 * fails (Linear is down, or this machine holds no Linear key) the comment is
 * queued in `linear-pending-comments`, which outlives the pipeline and its
 * environment. The drain here posts it once this machine can reach Linear;
 * on a machine with no key it stays due and the attached command node posts it
 * with its own (`linear-write-relay.ts`).
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
  LinearDrainLoop,
  linearWriteRetryDelay,
  type LinearDrainClock,
} from "./linear-write-drain.js";
import type { KanbanStorage, LinearCommentOutcome, LinearStorage } from "./storage/index.js";

const log = createLogger("linear");

/** How long this machine's own attempt holds a comment; past it, it is due again. */
const LOCAL_CLAIM_MS = 2 * LINEAR_WRITE_TIMEOUT_MS;

export interface LinearCommentsStorage {
  kanban: Pick<
    KanbanStorage,
    "getLinearAuth" | "getLinearCompletionComment" | "saveLinearCompletionComment"
  >;
  linear: Pick<
    LinearStorage,
    | "listLinearPendingComments"
    | "enqueueLinearPendingComment"
    | "claimLinearPendingComments"
    | "settleLinearPendingComment"
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
  storage: Pick<LinearCommentsStorage, "kanban">,
  locks: Pick<IntegrationLocks, "withLinearCompletionComment">,
  requireApiKey: () => Promise<string>,
  { pipelineId, issueId, body, outcome }: LinearCompletionCommentInput,
  signal?: AbortSignal,
): Promise<LinearCompletionCommentResult> {
  return locks.withLinearCompletionComment(pipelineId, async () => {
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
      await storage.kanban.saveLinearCompletionComment({
        pipelineId,
        issueId,
        ...ending,
        status: "failed",
        error: message,
      });
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

  /**
   * A finished Linear-sourced build could not post its comment: keeps it.
   * Returns what to tell the user, or null when it was not queued. Never throws.
   */
  async queue(
    storage: LinearCommentsStorage,
    pipeline: Pick<BuildPipeline, "id" | "projectId" | "source">,
    comment: { outcome: LinearCommentOutcome; body: string; error: string },
  ): Promise<string | null> {
    const source = pipeline.source;
    if (this.loop.closed || source?.type !== "linear") return null;
    this.storage = storage;
    try {
      const connected = Boolean((await storage.kanban.getLinearAuth())?.apiKey);
      const now = this.loop.now();
      const queued = storage.linear.enqueueLinearPendingComment(
        {
          pipelineId: pipeline.id,
          projectId: pipeline.projectId,
          issueId: source.issueId,
          ...(source.issueIdentifier ? { issueIdentifier: source.issueIdentifier } : {}),
          outcome: comment.outcome,
          body: comment.body,
        },
        {
          error: connected ? comment.error : LINEAR_NOT_CONNECTED_HERE,
          // With no key here there is nothing to back off from: the command
          // node may take it at its next pass.
          nextAttemptAt: new Date(connected ? now + LINEAR_WRITE_RETRY_MS : now),
        },
        new Date(now),
      );
      log.warn(
        queued === "queued" ? "completion-comment.queued" : "completion-comment.queue-full",
        {
          pipelineId: pipeline.id,
          issue: source.issueIdentifier ?? source.issueId,
          connected,
          reason: connected ? comment.error : LINEAR_NOT_CONNECTED_HERE,
        },
      );
      if (queued !== "queued") return null;
      this.loop.request();
      return connected
        ? `${comment.error.replace(/[.\s]+$/, "")}. The comment is queued and will be retried.`
        : `${LINEAR_NOT_CONNECTED_HERE}. The comment is queued until this machine or its command node can post it.`;
    } catch (error) {
      log.warn("completion-comment.queue-failed", {
        pipelineId: pipeline.id,
        error: formatLogError(error),
      });
      return null;
    }
  }

  /** The comment is in Linear, whoever posted it: drops it from the queue and tells the pipeline. */
  async settle(
    storage: LinearCommentsStorage,
    issueId: string,
    comment: LinearCommentPosted,
    record = false,
  ): Promise<void> {
    if (!storage.linear.settleLinearPendingComment(comment.pipelineId, comment.outcome)) return;
    if (record) {
      await storage.kanban.saveLinearCompletionComment({
        pipelineId: comment.pipelineId,
        issueId,
        outcome: comment.outcome,
        status: "posted",
        commentId: comment.commentId,
        postedAt: comment.postedAt ?? new Date(this.loop.now()).toISOString(),
      });
    }
    await this.posted?.(comment).catch((error: unknown) => {
      log.warn("completion-comment.status-failed", {
        pipelineId: comment.pipelineId,
        error: formatLogError(error),
      });
    });
  }

  /** Starts a drain now, or once the running one finishes. */
  requestDrain(): void {
    if (this.storage) this.loop.request();
  }

  /** Stops the drain timer; later calls do nothing. */
  shutdown(): void {
    this.loop.stop("Completion comment queue stopped");
  }

  /** Resolves once the current drain (and any it queued) settles. Tests use it. */
  async idle(): Promise<void> {
    while (this.loop.running) await this.loop.running;
  }

  private async drain(): Promise<number> {
    const storage = this.storage;
    if (!storage) return Number.POSITIVE_INFINITY;
    const pending = await storage.linear.listLinearPendingComments();
    if (pending.length === 0) return Number.POSITIVE_INFINITY;
    const due = pending.some((record) => Date.parse(record.nextAttemptAt) <= this.loop.now());
    if (due) {
      const apiKey = (await storage.kanban.getLinearAuth())?.apiKey;
      // Left due: the attached command node may claim it, and connecting here
      // drains at once.
      if (!apiKey) return this.loop.now() + LINEAR_WRITE_MAX_RETRY_MS;
      for (;;) {
        if (this.loop.closed) return Number.POSITIVE_INFINITY;
        const now = this.loop.now();
        const [record] = storage.linear.claimLinearPendingComments(
          1,
          new Date(now + LOCAL_CLAIM_MS),
          new Date(now),
        );
        if (!record) break;
        await this.post(storage, apiKey, record);
      }
    }
    const left = await storage.linear.listLinearPendingComments();
    return Math.min(
      Number.POSITIVE_INFINITY,
      ...left.map((record) => Date.parse(record.nextAttemptAt)),
    );
  }

  private async post(
    storage: LinearCommentsStorage,
    apiKey: string,
    record: Awaited<ReturnType<LinearStorage["listLinearPendingComments"]>>[number],
  ): Promise<void> {
    const issue = record.issueIdentifier ?? record.issueId;
    try {
      const result = await this.loop.bounded((signal) =>
        postRecordedLinearCompletionComment(
          storage,
          this.locks,
          async () => apiKey,
          record,
          signal,
        ),
      );
      await this.settle(storage, record.issueId, {
        pipelineId: record.pipelineId,
        outcome: record.outcome,
        commentId: result.commentId,
        ...(result.postedAt ? { postedAt: result.postedAt } : {}),
      });
      log.info("completion-comment.posted", { pipelineId: record.pipelineId, issue });
    } catch (error) {
      if (this.loop.closed) return;
      const attempts = record.attempts + 1;
      const delay = linearWriteRetryDelay(attempts);
      const reason = sanitizeLinearError(error, apiKey);
      storage.linear.deferLinearPendingComment(record.pipelineId, record.outcome, {
        error: reason,
        nextAttemptAt: new Date(this.loop.now() + delay),
      });
      log.warn("completion-comment.failed", {
        pipelineId: record.pipelineId,
        issue,
        attempts,
        retryInMs: delay,
        reason,
      });
    }
  }
}
