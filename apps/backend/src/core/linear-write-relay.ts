/** Leases for fixed Linear writes sent from a keyless leaf to its command node. */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { getLinearIssueBoard, issueIsOnBoard } from "./linear-boards.js";
import type {
  LinearCommentsStorage,
  LinearCompletionComments,
} from "./linear-completion-comments.js";
import { addLinearIssueLabelByName } from "./linear-issue-labels.js";
import { LINEAR_MERGED_LABEL } from "./linear-merged-label.js";
import { LINEAR_WRITE_TIMEOUT_MS, linearWriteRetryDelay, raceAbort } from "./linear-write-drain.js";
import { postLinearCompletionComment, sanitizeLinearError } from "./linear.js";
import {
  isSyncableLinearLinkKey,
  linearBoardLinkKey,
  ownsLinearWrite,
  type LinearCommentOutcome,
  type LinearMergedLabelOutcome,
  type LinearStorage,
} from "./storage/index.js";

const log = createLogger("linear");

export const LINEAR_WRITE_CLAIM_MS = 5 * 60_000;
export const MAX_LINEAR_WRITES_PER_CLAIM = 8;

type WriteIdentity = { key: string; claimId: string } & (
  { kind: "merged-label" } | { kind: "completion-comment"; outcome: LinearCommentOutcome }
);

export type LinearOwedWrite = WriteIdentity & { issueId: string; boardKey: string };
type LinearWriteResult = WriteIdentity &
  (
    | { applied: LinearMergedLabelOutcome }
    | { commentId: string; postedAt?: string }
    | { error: string }
  );

type LeafStorage = LinearCommentsStorage & {
  linear: Pick<
    LinearStorage,
    | "listLinearMergedLabels"
    | "claimLinearMergedLabels"
    | "settleLinearMergedLabel"
    | "deferLinearMergedLabel"
  >;
};

type RelayStorage = {
  loadProjects(): Promise<ReadonlyArray<{ id: string; gitUrl?: string | null }>>;
  kanban: Pick<LinearCommentsStorage["kanban"], "getLinearAuth">;
  linear: Pick<LinearStorage, "getLinearBoardLink">;
};

export async function claimLinearWrites(
  storage: LeafStorage,
  owner: string,
  now = new Date(),
): Promise<LinearOwedWrite[]> {
  if ((await storage.kanban.getLinearAuth())?.apiKey) return [];
  const due = (v: { nextAttemptAt: string }) => Date.parse(v.nextAttemptAt) <= now.getTime();
  const until = new Date(now.getTime() + LINEAR_WRITE_CLAIM_MS);
  const half = MAX_LINEAR_WRITES_PER_CLAIM / 2;
  const [comments, labels] = await Promise.all([
    storage.linear.listLinearPendingComments(),
    storage.linear.listLinearMergedLabels(),
  ]);
  const hasComments = comments.some((entry) => !entry.receipt && due(entry));
  const hasLabels = labels.some((entry) => entry.status === "pending" && due(entry));
  const writes: LinearOwedWrite[] = [];
  if (hasComments) {
    for (const entry of storage.linear.claimLinearPendingComments(
      hasLabels ? half : MAX_LINEAR_WRITES_PER_CLAIM,
      until,
      now,
      owner,
    )) {
      const target = await relayTarget(storage, entry);
      if (target && entry.claim)
        writes.push({
          ...target,
          kind: "completion-comment",
          key: entry.pipelineId,
          outcome: entry.outcome,
          claimId: entry.claim.id,
        });
    }
  }
  if (hasLabels) {
    for (const entry of storage.linear.claimLinearMergedLabels(
      hasComments ? half : MAX_LINEAR_WRITES_PER_CLAIM,
      until,
      now,
      owner,
    )) {
      const target = await relayTarget(storage, entry);
      if (target && entry.claim)
        writes.push({
          ...target,
          kind: "merged-label",
          key: entry.key,
          claimId: entry.claim.id,
        });
    }
  }
  return writes;
}

async function relayTarget(
  storage: LeafStorage,
  entry: { projectId: string; issueId: string },
): Promise<{ boardKey: string; issueId: string } | null> {
  const project = await storage.getProject(entry.projectId);
  if (!project || storage.linear.isProjectWriteFenced(entry.projectId)) return null;
  const boardKey = linearBoardLinkKey(project);
  return isSyncableLinearLinkKey(boardKey) ? { boardKey, issueId: entry.issueId } : null;
}

async function findClaim(storage: LeafStorage, write: WriteIdentity) {
  if (write.kind === "merged-label") {
    return (await storage.linear.listLinearMergedLabels()).find(
      (entry) => entry.key === write.key && entry.status === "pending",
    );
  }
  return (await storage.linear.listLinearPendingComments()).find(
    (entry) => entry.pipelineId === write.key && entry.outcome === write.outcome,
  );
}

/** A fresh check after Linear reads and immediately before each mutation. */
export async function revalidateLinearWrite(
  storage: LeafStorage,
  owner: string,
  proposed: unknown,
  now = () => new Date(),
): Promise<boolean> {
  const write = parseLinearOwedWrite(proposed);
  if (!write) return false;
  const entry = await findClaim(storage, write);
  if (!entry) return false;
  const target = await relayTarget(storage, entry);
  // The project, queue entry and claim may have changed while the lookup awaited.
  const current = await findClaim(storage, write);
  return Boolean(
    current &&
    target &&
    current.projectId === entry.projectId &&
    !storage.linear.isProjectWriteFenced(current.projectId) &&
    target.boardKey === write.boardKey &&
    target.issueId === write.issueId &&
    ownsLinearWrite(current, { id: write.claimId, owner }, now()),
  );
}

export async function settleLinearWrites(
  storage: LeafStorage,
  comments: Pick<LinearCompletionComments, "recordReceipt" | "start">,
  owner: string,
  results: readonly unknown[],
  now = () => new Date(),
): Promise<number> {
  let settled = 0;
  let hasReceipt = false;
  for (const value of results.slice(0, MAX_LINEAR_WRITES_PER_CLAIM)) {
    const result = parseLinearWriteResult(value);
    if (!result) continue;
    const entry = await findClaim(storage, result);
    const claim = { id: result.claimId, owner };
    const at = now();
    if (!entry || !ownsLinearWrite(entry, claim, at)) continue;

    let changed = false;
    if ("error" in result) {
      const failure = {
        error: result.error,
        nextAttemptAt: new Date(at.getTime() + linearWriteRetryDelay(entry.attempts + 1)),
      };
      changed =
        result.kind === "merged-label"
          ? storage.linear.deferLinearMergedLabel(result.key, failure, claim, at)
          : storage.linear.deferLinearPendingComment(
              result.key,
              result.outcome,
              failure,
              claim,
              at,
            );
    } else if (result.kind === "merged-label" && "applied" in result) {
      changed = storage.linear.settleLinearMergedLabel(result.key, result.applied, at, claim);
    } else if (result.kind === "completion-comment" && "commentId" in result) {
      changed = comments.recordReceipt(storage, result.outcome, result.key, claim, result, at);
      hasReceipt ||= changed;
    }
    if (changed) settled += 1;
  }
  if (hasReceipt) {
    // Wake the local drain even on a keyless leaf. It retries bookkeeping independently.
    comments.start(storage);
  }
  return settled;
}

/** Command-side authorization and delivery use the same deadline. */
export async function performLinearWrite(
  storage: RelayStorage,
  apiKey: string,
  write: LinearOwedWrite,
  stop: AbortSignal,
  revalidate: () => Promise<boolean>,
  remainingMs: number,
): Promise<LinearWriteResult> {
  const { issueId: _suppliedIssue, boardKey, ...identity } = write;
  const signal = AbortSignal.any([
    stop,
    AbortSignal.timeout(Math.max(0, Math.min(remainingMs, LINEAR_WRITE_TIMEOUT_MS))),
  ]);
  try {
    return await raceAbort(async (abort) => {
      const authorizeBoard = async () => {
        const [board, projects, auth] = await Promise.all([
          storage.linear.getLinearBoardLink(boardKey),
          storage.loadProjects(),
          storage.kanban.getLinearAuth(),
        ]);
        if (auth?.apiKey !== apiKey) throw new Error("Linear connection changed");
        // Board changes learnt from a leaf are useful for browsing, but grant no write authority.
        if (
          !board?.teamId ||
          !board.projectId ||
          !projects.some(
            (project) => project.id === board.projectId && linearBoardLinkKey(project) === boardKey,
          )
        ) {
          throw new Error("This repository has no locally linked Linear board");
        }
        return { teamId: board.teamId, linearProjectId: board.linearProjectId };
      };
      const board = await authorizeBoard();
      abort.throwIfAborted();
      const issue = await getLinearIssueBoard(apiKey, write.issueId, abort);
      if (!issue || !issueIsOnBoard(issue, board))
        throw new Error("Linear issue is outside the authorized board");
      const beforeMutation = async () => {
        await authorizeBoard();
        const currentIssue = await getLinearIssueBoard(apiKey, issue.id, abort);
        if (!currentIssue || currentIssue.id !== issue.id || !(await revalidate())) {
          throw new Error("Linear write claim has expired or been revoked");
        }
        if (!issueIsOnBoard(currentIssue, await authorizeBoard())) {
          throw new Error("Linear issue is outside the authorized board");
        }
        abort.throwIfAborted();
      };
      if (write.kind === "merged-label") {
        const { outcome } = await addLinearIssueLabelByName(
          apiKey,
          issue.id,
          LINEAR_MERGED_LABEL,
          abort,
          beforeMutation,
        );
        return { ...identity, applied: outcome };
      }
      const body =
        write.outcome === "complete"
          ? "✅ Orkestrator build completed."
          : "❌ Orkestrator build failed.";
      const { commentId, postedAt } = await postLinearCompletionComment(
        apiKey,
        { pipelineId: write.key, issueId: issue.id, body, outcome: write.outcome },
        abort,
        beforeMutation,
      );
      return { ...identity, commentId, ...(postedAt ? { postedAt } : {}) };
    }, signal);
  } catch (error) {
    log.warn("relay.write-failed", {
      kind: write.kind,
      issue: write.issueId,
      error: formatLogError(error, { message: false }),
    });
    return { ...identity, error: sanitizeLinearError(error, apiKey) };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}

function parseIdentity(value: Record<string, unknown>): WriteIdentity | null {
  const key = text(value.key, 900);
  const claimId = text(value.claimId, 36);
  if (!key || !claimId || !/^[a-f0-9-]{36}$/.test(claimId)) return null;
  if (value.kind === "merged-label") return { kind: value.kind, key, claimId };
  if (
    value.kind === "completion-comment" &&
    /^[\w-]+$/.test(key) &&
    (value.outcome === "complete" || value.outcome === "failed")
  ) {
    return { kind: value.kind, key, claimId, outcome: value.outcome };
  }
  return null;
}

export function parseLinearOwedWrite(value: unknown): LinearOwedWrite | null {
  const write = record(value);
  if (!write) return null;
  const identity = parseIdentity(write);
  const issueId = text(write.issueId, 400);
  const boardKey = text(write.boardKey, 400);
  if (!identity || !issueId || !boardKey || !isSyncableLinearLinkKey(boardKey)) return null;
  return { ...identity, issueId, boardKey };
}

function parseLinearWriteResult(value: unknown): LinearWriteResult | null {
  const result = record(value);
  if (!result) return null;
  const identity = parseIdentity(result);
  if (!identity) return null;
  if (typeof result.error === "string" && result.error)
    return { ...identity, error: result.error.slice(0, 400) };
  if (identity.kind === "merged-label") {
    const applied = result.applied;
    return applied === "added" || applied === "created" || applied === "already-present"
      ? { ...identity, applied }
      : null;
  }
  const commentId = text(result.commentId, 400);
  const postedAt = text(result.postedAt, 40);
  return commentId
    ? {
        ...identity,
        commentId,
        ...(postedAt && !Number.isNaN(Date.parse(postedAt)) ? { postedAt } : {}),
      }
    : null;
}
