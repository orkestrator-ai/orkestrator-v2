/**
 * Linear writes a leaf owes but cannot make, landed by its command node
 * (docs/architecture/tickets.md, "Builds on a machine without Linear").
 *
 * A Linear-sourced build may run on any machine, but the Linear key stays on
 * the machines the user connected. The `merged` labels
 * (`linear-merged-label.ts`) and completion comments
 * (`linear-completion-comments.ts`) such a machine owes stay in its own
 * queues. A leaf never reaches its command node, so the command node takes
 * them over the link at its sync passes (`nodes/node-linear-sync.ts`): it
 * claims a few, writes each with its own key, and reports each back. The key
 * never travels, and only these two fixed kinds of write do.
 *
 * A claim defers its records for `LINEAR_WRITE_CLAIM_MS`, so two command nodes
 * do not write the same one; a claim whose node went away is due again after
 * it. Repeating a write is safe: a label already there and a comment already
 * posted (found by its marker) are left alone.
 */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { addLinearIssueLabelByName } from "./linear-issue-labels.js";
import { LINEAR_MERGED_LABEL, type LinearMergedLabelStorage } from "./linear-merged-label.js";
import type {
  LinearCommentsStorage,
  LinearCompletionComments,
} from "./linear-completion-comments.js";
import { LINEAR_WRITE_TIMEOUT_MS, linearWriteRetryDelay, raceAbort } from "./linear-write-drain.js";
import { postLinearCompletionComment, sanitizeLinearError } from "./linear.js";
import {
  MAX_LINEAR_COMMENT_BODY,
  type LinearCommentOutcome,
  type LinearMergedLabelOutcome,
  type LinearStorage,
} from "./storage/index.js";

const log = createLogger("linear");

/** How long a claimed write is the claiming node's. */
export const LINEAR_WRITE_CLAIM_MS = 5 * 60_000;
/** Writes per claim: each gets at most `LINEAR_WRITE_TIMEOUT_MS`, inside the claim. */
export const MAX_LINEAR_WRITES_PER_CLAIM = 8;

export type LinearOwedWrite =
  | { kind: "merged-label"; key: string; issueId: string }
  | {
      kind: "completion-comment";
      key: string;
      issueId: string;
      outcome: LinearCommentOutcome;
      body: string;
    };

export type LinearWriteResult =
  | { kind: "merged-label"; key: string; applied: LinearMergedLabelOutcome }
  | {
      kind: "completion-comment";
      key: string;
      outcome: LinearCommentOutcome;
      commentId: string;
      postedAt?: string;
    }
  | { kind: "merged-label"; key: string; error: string }
  | {
      kind: "completion-comment";
      key: string;
      outcome: LinearCommentOutcome;
      error: string;
    };

type LeafStorage = LinearCommentsStorage & {
  linear: Pick<
    LinearStorage,
    | "listLinearMergedLabels"
    | "claimLinearMergedLabels"
    | "settleLinearMergedLabel"
    | "deferLinearMergedLabel"
  >;
  kanban: LinearMergedLabelStorage["kanban"];
};

/** Leaf: due writes this machine has no key for. Empty when it can make them itself. */
export async function claimLinearWrites(
  storage: LeafStorage,
  now: Date = new Date(),
): Promise<LinearOwedWrite[]> {
  if ((await storage.kanban.getLinearAuth())?.apiKey) return [];
  const isDue = (record: { nextAttemptAt: string }) =>
    Date.parse(record.nextAttemptAt) <= now.getTime();
  const until = new Date(now.getTime() + LINEAR_WRITE_CLAIM_MS);
  const writes: LinearOwedWrite[] = [];
  // Each queue is read first: an idle pass, the usual one, writes nothing.
  const comments = await storage.linear.listLinearPendingComments();
  if (comments.some(isDue)) {
    for (const record of storage.linear.claimLinearPendingComments(
      MAX_LINEAR_WRITES_PER_CLAIM,
      until,
      now,
    )) {
      writes.push({
        kind: "completion-comment",
        key: record.pipelineId,
        issueId: record.issueId,
        outcome: record.outcome,
        body: record.body,
      });
    }
  }
  const room = MAX_LINEAR_WRITES_PER_CLAIM - writes.length;
  const labels = await storage.linear.listLinearMergedLabels();
  if (room > 0 && labels.some((record) => record.status === "pending" && isDue(record))) {
    for (const record of storage.linear.claimLinearMergedLabels(room, until, now)) {
      writes.push({ kind: "merged-label", key: record.key, issueId: record.issueId });
    }
  }
  return writes;
}

/** Leaf: what became of claimed writes. Unknown keys and malformed results are ignored. */
export async function settleLinearWrites(
  storage: LeafStorage,
  comments: Pick<LinearCompletionComments, "settle">,
  results: readonly unknown[],
  now: Date = new Date(),
): Promise<number> {
  let settled = 0;
  for (const value of results.slice(0, MAX_LINEAR_WRITES_PER_CLAIM)) {
    const result = parseLinearWriteResult(value);
    if (!result) continue;
    if (result.kind === "merged-label") {
      const record = (await storage.linear.listLinearMergedLabels()).find(
        (entry) => entry.key === result.key && entry.status === "pending",
      );
      if (!record) continue;
      const issue = record.issueIdentifier ?? record.issueId;
      const { pipelineId } = record;
      if ("applied" in result) {
        storage.linear.settleLinearMergedLabel(record.key, result.applied, now);
        log.info("merged-label.applied", { pipelineId, issue, outcome: result.applied });
      } else {
        const attempts = record.attempts + 1;
        const delay = linearWriteRetryDelay(attempts);
        storage.linear.deferLinearMergedLabel(record.key, {
          error: result.error,
          nextAttemptAt: new Date(now.getTime() + delay),
        });
        log.warn("merged-label.failed", {
          pipelineId,
          issue,
          attempts,
          retryInMs: delay,
          reason: result.error,
        });
      }
    } else {
      const record = (await storage.linear.listLinearPendingComments()).find(
        (entry) => entry.pipelineId === result.key && entry.outcome === result.outcome,
      );
      if (!record) continue;
      const issue = record.issueIdentifier ?? record.issueId;
      const { pipelineId, outcome } = record;
      if ("commentId" in result) {
        await comments.settle(
          storage,
          record.issueId,
          {
            pipelineId,
            outcome,
            commentId: result.commentId,
            ...(result.postedAt ? { postedAt: result.postedAt } : {}),
          },
          true,
        );
        log.info("completion-comment.posted", { pipelineId, issue });
      } else {
        const attempts = record.attempts + 1;
        const delay = linearWriteRetryDelay(attempts);
        storage.linear.deferLinearPendingComment(pipelineId, outcome, {
          error: result.error,
          nextAttemptAt: new Date(now.getTime() + delay),
        });
        log.warn("completion-comment.failed", {
          pipelineId,
          issue,
          attempts,
          retryInMs: delay,
          reason: result.error,
        });
      }
    }
    settled += 1;
  }
  return settled;
}

/** Command node: makes one leaf's write with this machine's key. Never throws. */
export async function performLinearWrite(
  apiKey: string,
  write: LinearOwedWrite,
  stop: AbortSignal,
): Promise<LinearWriteResult> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(LINEAR_WRITE_TIMEOUT_MS)]);
  try {
    if (write.kind === "merged-label") {
      const { outcome } = await raceAbort(
        (abort) => addLinearIssueLabelByName(apiKey, write.issueId, LINEAR_MERGED_LABEL, abort),
        signal,
      );
      return { kind: write.kind, key: write.key, applied: outcome };
    }
    const result = await raceAbort(
      (abort) =>
        postLinearCompletionComment(
          apiKey,
          {
            pipelineId: write.key,
            issueId: write.issueId,
            body: write.body,
            outcome: write.outcome,
          },
          abort,
        ),
      signal,
    );
    return {
      kind: write.kind,
      key: write.key,
      outcome: write.outcome,
      commentId: result.commentId,
      ...(result.postedAt ? { postedAt: result.postedAt } : {}),
    };
  } catch (error) {
    const reason = sanitizeLinearError(error, apiKey);
    log.warn("relay.write-failed", {
      kind: write.kind,
      issue: write.issueId,
      error: formatLogError(error, { message: false }),
    });
    return write.kind === "merged-label"
      ? { kind: write.kind, key: write.key, error: reason }
      : { kind: write.kind, key: write.key, outcome: write.outcome, error: reason };
  }
}

const MAX_KEY = 900;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commentOutcome(value: unknown): LinearCommentOutcome | undefined {
  return value === "complete" || value === "failed" ? value : undefined;
}

/** Command node: a write a leaf asked for, or null when it is not one this node makes. */
export function parseLinearOwedWrite(value: unknown): LinearOwedWrite | null {
  const write = record(value);
  const key = text(write?.key, MAX_KEY);
  const issueId = text(write?.issueId, 400);
  if (!write || !key || !issueId) return null;
  if (write.kind === "merged-label") return { kind: "merged-label", key, issueId };
  const outcome = commentOutcome(write.outcome);
  const body = text(write.body, MAX_LINEAR_COMMENT_BODY);
  // The key becomes part of the comment's hidden marker.
  if (write.kind !== "completion-comment" || !outcome || !body || !/^[\w-]+$/.test(key)) {
    return null;
  }
  return { kind: "completion-comment", key, issueId, outcome, body };
}

const LABEL_OUTCOMES: readonly unknown[] = [
  "added",
  "created",
  "already-present",
] satisfies LinearMergedLabelOutcome[];

function parseLinearWriteResult(value: unknown): LinearWriteResult | null {
  const result = record(value);
  const key = text(result?.key, MAX_KEY);
  if (!result || !key) return null;
  const error = typeof result.error === "string" ? result.error.slice(0, 400) : undefined;
  if (result.kind === "merged-label") {
    if (LABEL_OUTCOMES.includes(result.applied)) {
      return {
        kind: "merged-label",
        key,
        applied: result.applied as LinearMergedLabelOutcome,
      };
    }
    return error ? { kind: "merged-label", key, error } : null;
  }
  const outcome = commentOutcome(result.outcome);
  if (result.kind !== "completion-comment" || !outcome) return null;
  const commentId = text(result.commentId, 400);
  const postedAt = text(result.postedAt, 40);
  if (commentId) {
    return {
      kind: "completion-comment",
      key,
      outcome,
      commentId,
      ...(postedAt && !Number.isNaN(Date.parse(postedAt)) ? { postedAt } : {}),
    };
  }
  return error ? { kind: "completion-comment", key, outcome, error } : null;
}
