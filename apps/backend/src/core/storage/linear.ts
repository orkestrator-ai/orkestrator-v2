/**
 * Linear boards (docs/architecture/tickets.md, "Linear"): which Linear board
 * each project uses, the disconnects other machines must apply, the
 * issues `create_linear_issue` has already created, and what is still owed to
 * issues whose build ended: the `merged` label once its pull request merged, and
 * the completion comment when it could not be posted. The sign-in itself stays
 * in `KanbanRepository` (`linear-auth`).
 *
 * A board link is keyed by the project's repository (`repo:<hint>`), so the
 * same repository's project on every machine shares it and sync can carry it;
 * a project without a Git remote is keyed by its id (`project:<id>`) and stays
 * on this machine. A cleared link is kept as a tombstone so the clear syncs.
 * Nothing here holds a credential: a disconnect is recorded by the key's
 * fingerprint only.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "@orkestrator/protocol/logger";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import type { StorageContext } from "./context.js";
import { isRecord, nowIso } from "./shared-core.js";

const log = createLogger("linear");

export type LinearBoardLink = {
  key: string;
  repositoryHint?: string;
  projectId?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  linearProjectId?: string;
  linearProjectName?: string;
  updatedAt: string;
  cleared?: boolean;
  /**
   * On a tombstone: the key of the link that kept this board when two of
   * this machine's projects were linked to it on different machines.
   */
  supersededBy?: string;
};

export type LinearRevocation = {
  keyFingerprint: string;
  revokedAt: string;
};

export type LinearIssueCreateRecord = {
  requestKey: string;
  linkKey: string;
  issueId: string;
  createdAt: string;
};

/**
 * A Linear-sourced build whose pull request merged and whose issue must get
 * the `merged` label (`linear-merged-label.ts`). Kept until the label lands,
 * retried with backoff; one record per issue and pull request, so a replayed
 * merge never labels twice.
 */
export type LinearWriteClaim = { id: string; owner: string; expiresAt: string };
export type LinearWriteClaimRef = Pick<LinearWriteClaim, "id" | "owner">;
type LinearCommentReceipt = { commentId: string; postedAt: string };

export function ownsLinearWrite(
  record: { claim?: LinearWriteClaim },
  claim: LinearWriteClaimRef,
  now: Date,
): boolean {
  return (
    record.claim?.id === claim.id &&
    record.claim.owner === claim.owner &&
    Date.parse(record.claim.expiresAt) > now.getTime()
  );
}

function readClaim(value: unknown): LinearWriteClaim | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedString(value.id);
  const owner = boundedString(value.owner);
  return id && owner && isIsoDate(value.expiresAt)
    ? { id, owner, expiresAt: value.expiresAt }
    : undefined;
}

export type LinearMergedLabelRecord = {
  key: string;
  issueId: string;
  issueIdentifier?: string;
  pipelineId: string;
  projectId: string;
  prUrl: string;
  status: "pending" | "applied";
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastError?: string;
  claim?: LinearWriteClaim;
  appliedAt?: string;
  /** How it landed: the label was added, created then added, or already on the issue. */
  outcome?: LinearMergedLabelOutcome;
};

export type LinearMergedLabelOutcome = "added" | "created" | "already-present";

export type LinearMergedLabelInput = Pick<
  LinearMergedLabelRecord,
  "issueId" | "issueIdentifier" | "pipelineId" | "projectId" | "prUrl"
>;

/** How a run ended, as its Linear comment says it. */
export type LinearCommentOutcome = "complete" | "failed";

/**
 * A finished Linear-sourced build's latest comment (`linear-completion-comments.ts`).
 * One per pipeline, kept until delivery and status reconciliation succeed.
 */
export type LinearPendingComment = {
  pipelineId: string;
  projectId: string;
  issueId: string;
  issueIdentifier?: string;
  outcome: LinearCommentOutcome;
  body: string;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastError?: string;
  claim?: LinearWriteClaim;
  receipt?: LinearCommentReceipt;
};

export type LinearPendingCommentInput = Pick<
  LinearPendingComment,
  "pipelineId" | "projectId" | "issueId" | "issueIdentifier" | "outcome" | "body"
>;

/** Board links one machine keeps, tombstones included; the oldest tombstones go first. */
export const MAX_LINEAR_BOARD_LINKS = 1_000;
/** Disconnects kept for machines that were offline; the oldest go first. */
export const MAX_LINEAR_REVOCATIONS = 50;
/** How long a disconnect is kept for a machine that has not been seen. */
export const LINEAR_REVOCATION_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
/** Issue creations remembered for retries; the oldest go first. */
export const MAX_LINEAR_ISSUE_CREATES = 500;
/** Retained history target; applied records go first, pending obligations are never evicted. */
export const MAX_LINEAR_MERGED_LABELS = 500;
/** Completion comments waiting to be posted; a further one is refused, never an older one dropped. */
export const MAX_LINEAR_PENDING_COMMENTS = 500;
/** The longest queued comment; a longer one is cut. */
export const MAX_LINEAR_COMMENT_BODY = 10_000;
/** The longest stored failure reason. */
const MAX_LINEAR_WRITE_ERROR = 400;

const MAX_FIELD_LENGTH = 400;

/** The link key of a project: its repository when it has a remote, else its id. */
export function linearBoardLinkKey(project: { id: string; gitUrl?: string | null }): string {
  const hint = repositoryHint(project.gitUrl ?? undefined);
  return hint ? `repo:${hint}` : `project:${project.id}`;
}

/** Whether a key can travel to other machines (only repository keys can). */
export function isSyncableLinearLinkKey(key: string): boolean {
  return key.startsWith("repo:");
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : undefined;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

/** A link read from storage or another machine, or `null` when it is not one. */
export function parseLinearBoardLink(value: unknown): LinearBoardLink | null {
  if (!isRecord(value)) return null;
  const key = boundedString(value.key);
  if (!key || !(key.startsWith("repo:") || key.startsWith("project:"))) return null;
  if (!isIsoDate(value.updatedAt)) return null;
  const cleared = value.cleared === true;
  const teamId = boundedString(value.teamId);
  if (!cleared && !teamId) return null;
  const link: LinearBoardLink = { key, updatedAt: value.updatedAt };
  const fields = [
    "repositoryHint",
    "projectId",
    "teamKey",
    "teamName",
    "linearProjectId",
    "linearProjectName",
  ] as const;
  if (!cleared) {
    link.teamId = teamId;
    for (const field of fields) {
      const text = boundedString(value[field]);
      if (text) link[field] = text;
    }
  } else {
    link.cleared = true;
    const hint = boundedString(value.repositoryHint);
    if (hint) link.repositoryHint = hint;
    const supersededBy = boundedString(value.supersededBy);
    if (supersededBy) link.supersededBy = supersededBy;
  }
  return link;
}

export function parseLinearRevocation(value: unknown): LinearRevocation | null {
  if (!isRecord(value)) return null;
  const keyFingerprint = boundedString(value.keyFingerprint);
  if (!keyFingerprint || !/^[a-f0-9]{8,64}$/.test(keyFingerprint)) return null;
  if (!isIsoDate(value.revokedAt)) return null;
  return { keyFingerprint, revokedAt: value.revokedAt };
}

/** Two live links name the same board when their teams match and either covers the other. */
export function sameLinearBoard(a: LinearBoardLink, b: LinearBoardLink): boolean {
  if (a.cleared || b.cleared || !a.teamId || a.teamId !== b.teamId) return false;
  return !a.linearProjectId || !b.linearProjectId || a.linearProjectId === b.linearProjectId;
}

function newer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/** Now, or just after `after` when this machine's clock is behind it, so the change wins. */
function stampAfter(after: string): string {
  const now = Date.now();
  const floor = Date.parse(after) + 1;
  return new Date(Number.isNaN(floor) ? now : Math.max(now, floor)).toISOString();
}

/** A tombstone for a link that lost its board to `winner`. */
function supersededTombstone(link: LinearBoardLink, winner: string): LinearBoardLink {
  return {
    key: link.key,
    ...(link.repositoryHint ? { repositoryHint: link.repositoryHint } : {}),
    updatedAt: stampAfter(link.updatedAt),
    cleared: true,
    supersededBy: winner,
  };
}

/** The record key of an issue's merged-label job for one pull request. */
export function linearMergedLabelKey(issueId: string, prUrl: string): string {
  return `${issueId} ${prUrl}`;
}

const MERGED_LABEL_OUTCOMES: readonly string[] = ["added", "created", "already-present"];

export function parseLinearMergedLabelRecord(value: unknown): LinearMergedLabelRecord | null {
  if (!isRecord(value)) return null;
  const issueId = boundedString(value.issueId);
  const pipelineId = boundedString(value.pipelineId);
  const projectId = boundedString(value.projectId);
  const prUrl = boundedString(value.prUrl);
  if (!issueId || !pipelineId || !projectId || !prUrl) return null;
  if (value.key !== linearMergedLabelKey(issueId, prUrl)) return null;
  if (value.status !== "pending" && value.status !== "applied") return null;
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.nextAttemptAt)) return null;
  const attempts =
    typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0
      ? value.attempts
      : 0;
  const record: LinearMergedLabelRecord = {
    key: value.key,
    issueId,
    pipelineId,
    projectId,
    prUrl,
    status: value.status,
    attempts,
    createdAt: value.createdAt,
    nextAttemptAt: value.nextAttemptAt,
  };
  const claim = readClaim(value.claim);
  if (claim) record.claim = claim;
  const identifier = boundedString(value.issueIdentifier);
  if (identifier) record.issueIdentifier = identifier;
  const lastError = boundedString(value.lastError);
  if (lastError) record.lastError = lastError;
  if (isIsoDate(value.appliedAt)) record.appliedAt = value.appliedAt;
  if (typeof value.outcome === "string" && MERGED_LABEL_OUTCOMES.includes(value.outcome)) {
    record.outcome = value.outcome as LinearMergedLabelOutcome;
  }
  return record;
}

function parseLinearPendingComment(value: unknown): LinearPendingComment | null {
  if (!isRecord(value)) return null;
  const pipelineId = boundedString(value.pipelineId);
  const projectId = boundedString(value.projectId);
  const issueId = boundedString(value.issueId);
  if (!pipelineId || !projectId || !issueId) return null;
  if (value.outcome !== "complete" && value.outcome !== "failed") return null;
  if (typeof value.body !== "string" || !value.body.trim()) return null;
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.nextAttemptAt)) return null;
  const record: LinearPendingComment = {
    pipelineId,
    projectId,
    issueId,
    outcome: value.outcome,
    body: value.body.slice(0, MAX_LINEAR_COMMENT_BODY),
    attempts:
      typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0
        ? value.attempts
        : 0,
    createdAt: value.createdAt,
    nextAttemptAt: value.nextAttemptAt,
  };
  const claim = readClaim(value.claim);
  if (claim) record.claim = claim;
  const identifier = boundedString(value.issueIdentifier);
  if (identifier) record.issueIdentifier = identifier;
  const lastError = boundedString(value.lastError);
  if (lastError) record.lastError = lastError;
  const receipt = value.receipt;
  if (isRecord(receipt) && isIsoDate(receipt.postedAt)) {
    const commentId = boundedString(receipt.commentId);
    if (commentId) record.receipt = { commentId, postedAt: receipt.postedAt };
  }
  return record;
}

function maySettleLabel(
  record: LinearMergedLabelRecord,
  claim: LinearWriteClaimRef | undefined,
  now: Date,
): boolean {
  return claim ? ownsLinearWrite(record, claim, now) : !record.claim;
}

function boundLinks(links: LinearBoardLink[]): void {
  if (links.length <= MAX_LINEAR_BOARD_LINKS) return;
  const tombstones = links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => link.cleared)
    .sort((a, b) => Date.parse(a.link.updatedAt) - Date.parse(b.link.updatedAt));
  const drop = new Set<number>();
  for (const { index } of tombstones) {
    if (links.length - drop.size <= MAX_LINEAR_BOARD_LINKS) break;
    drop.add(index);
  }
  const kept = links.filter((_, index) => !drop.has(index));
  links.splice(0, links.length, ...kept.slice(-MAX_LINEAR_BOARD_LINKS));
}

function boundRevocations(revocations: LinearRevocation[], now: number): LinearRevocation[] {
  const byFingerprint = new Map<string, LinearRevocation>();
  for (const revocation of revocations) {
    if (now - Date.parse(revocation.revokedAt) > LINEAR_REVOCATION_TTL_MS) continue;
    const existing = byFingerprint.get(revocation.keyFingerprint);
    if (!existing || newer(revocation.revokedAt, existing.revokedAt)) {
      byFingerprint.set(revocation.keyFingerprint, revocation);
    }
  }
  return [...byFingerprint.values()]
    .sort((a, b) => Date.parse(a.revokedAt) - Date.parse(b.revokedAt))
    .slice(-MAX_LINEAR_REVOCATIONS);
}

type LinearSyncDocument = { revocations: LinearRevocation[] };

export class LinearRepository {
  private readonly removingProjects = new Map<string, number>();

  fenceProjectWrites(projectId: string): void {
    this.removingProjects.set(projectId, (this.removingProjects.get(projectId) ?? 0) + 1);
  }

  releaseProjectWriteFence(projectId: string): void {
    const owners = this.removingProjects.get(projectId) ?? 0;
    if (owners <= 1) this.removingProjects.delete(projectId);
    else this.removingProjects.set(projectId, owners - 1);
  }

  isProjectWriteFenced(projectId: string): boolean {
    return this.removingProjects.has(projectId);
  }

  constructor(private readonly context: StorageContext) {}

  private linksFile(): string {
    return this.context.file("linear-board-links.json");
  }

  private syncFile(): string {
    return this.context.file("linear-sync.json");
  }

  private createsFile(): string {
    return this.context.file("linear-issue-creates.json");
  }

  private mergedLabelsFile(): string {
    return this.context.file("linear-merged-labels.json");
  }

  private pendingCommentsFile(): string {
    return this.context.file("linear-pending-comments.json");
  }

  /** Completion comments still to be posted. */
  async listLinearPendingComments(): Promise<LinearPendingComment[]> {
    const records = await this.context.loadJson<unknown[]>(this.pendingCommentsFile(), () => []);
    return (Array.isArray(records) ? records : [])
      .map(parseLinearPendingComment)
      .filter((record): record is LinearPendingComment => record !== null);
  }

  /**
   * Queues a build's completion comment, replacing one queued for an earlier
   * ending of the same pipeline. `full` keeps what is queued and refuses this.
   */
  enqueueLinearPendingComment(
    input: LinearPendingCommentInput,
    failure: { error: string; nextAttemptAt: Date },
    now: Date = new Date(),
  ): "queued" | "full" {
    if (this.isProjectWriteFenced(input.projectId)) return "full";
    const record = parseLinearPendingComment({
      ...input,
      attempts: 0,
      createdAt: now.toISOString(),
      nextAttemptAt: failure.nextAttemptAt.toISOString(),
      lastError: failure.error.slice(0, MAX_LINEAR_WRITE_ERROR),
    });
    if (!record) throw new Error("Expected a Linear issue, pipeline, project and comment.");
    return this.context.updateStore(
      this.pendingCommentsFile(),
      (): unknown[] => [],
      (records) => {
        const index = records.findIndex(
          (entry) => isRecord(entry) && entry.pipelineId === record.pipelineId,
        );
        if (index >= 0) {
          const previous = parseLinearPendingComment(records[index]);
          if (previous?.outcome === record.outcome || previous?.outcome === "complete")
            return "queued";
          // Keep an older write that already started from overlapping the new ending.
          if (previous?.claim && Date.parse(previous.claim.expiresAt) > now.getTime()) {
            record.claim = previous.claim;
            record.nextAttemptAt = previous.claim.expiresAt;
          }
          records[index] = record;
        } else {
          if (records.length >= MAX_LINEAR_PENDING_COMMENTS) return "full";
          records.push(record);
        }
        return "queued";
      },
    );
  }

  /** Claims due comments. An explicit retry can skip backoff, while an active claim still wins. */
  claimLinearPendingComments(
    limit: number,
    until: Date,
    now: Date,
    owner: string,
    ending?: Pick<LinearPendingComment, "pipelineId" | "outcome">,
  ): LinearPendingComment[] {
    return this.claimWrites(
      this.pendingCommentsFile(),
      parseLinearPendingComment,
      limit,
      until,
      now,
      owner,
      (record) =>
        !record.receipt &&
        (!ending || (record.pipelineId === ending.pipelineId && record.outcome === ending.outcome)),
      ending !== undefined,
    );
  }

  /** Records delivery and consumes its claim atomically. Status reconciliation can retry without Linear. */
  recordLinearPendingCommentReceipt(
    pipelineId: string,
    outcome: LinearCommentOutcome,
    claim: LinearWriteClaimRef,
    receipt: LinearCommentReceipt,
    now: Date,
  ): boolean {
    return this.updatePendingComment(pipelineId, outcome, (record) => {
      if (!ownsLinearWrite(record, claim, now)) return false;
      record.receipt = receipt;
      record.nextAttemptAt = now.toISOString();
      delete record.claim;
      return true;
    });
  }

  finishLinearPendingComment(
    pipelineId: string,
    outcome: LinearCommentOutcome,
    commentId: string,
  ): boolean {
    return this.updatePendingComment(pipelineId, outcome, (record) =>
      record.receipt?.commentId === commentId ? "remove" : false,
    );
  }

  deferLinearPendingComment(
    pipelineId: string,
    outcome: LinearCommentOutcome,
    failure: { error: string; nextAttemptAt: Date },
    claim: LinearWriteClaimRef,
    now: Date,
  ): boolean {
    return this.updatePendingComment(pipelineId, outcome, (record) => {
      if (!ownsLinearWrite(record, claim, now)) return false;
      record.attempts += 1;
      record.lastError = failure.error.slice(0, MAX_LINEAR_WRITE_ERROR) || "Linear failed";
      record.nextAttemptAt = failure.nextAttemptAt.toISOString();
      delete record.claim;
      return true;
    });
  }

  private updatePendingComment(
    pipelineId: string,
    outcome: LinearCommentOutcome,
    change: (record: LinearPendingComment) => boolean | "remove",
  ): boolean {
    return this.context.updateStore(
      this.pendingCommentsFile(),
      (): unknown[] => [],
      (records) => {
        const index = records.findIndex(
          (entry) =>
            isRecord(entry) && entry.pipelineId === pipelineId && entry.outcome === outcome,
        );
        const record = index >= 0 ? parseLinearPendingComment(records[index]) : null;
        if (!record || this.isProjectWriteFenced(record.projectId)) return false;
        const changed = change(record);
        if (changed === "remove") records.splice(index, 1);
        else if (changed) records[index] = record;
        return Boolean(changed);
      },
    );
  }

  /** A removed project's comments are never posted: their text goes with it. */
  async deleteLinearPendingCommentsForProject(projectId: string): Promise<number> {
    // A read first, so a project with none writes nothing.
    const pending = await this.listLinearPendingComments();
    if (!pending.some((record) => record.projectId === projectId)) return 0;
    const removed = this.context.updateStore(
      this.pendingCommentsFile(),
      (): unknown[] => [],
      (records) => {
        const kept = records.filter((entry) => !(isRecord(entry) && entry.projectId === projectId));
        const count = records.length - kept.length;
        if (count > 0) records.splice(0, records.length, ...kept);
        return count;
      },
      { sensitive: true },
    );
    if (removed) this.context.scrubDeletedDatabaseContent();
    return removed;
  }

  deletePendingLinearMergedLabelsForProject(projectId: string): void {
    this.context.updateStore(
      this.mergedLabelsFile(),
      (): unknown[] => [],
      (records) => {
        const kept = records.filter(
          (entry) =>
            !(isRecord(entry) && entry.projectId === projectId && entry.status === "pending"),
        );
        records.splice(0, records.length, ...kept);
      },
    );
  }

  /** Every merged-label record, pending and applied. */
  async listLinearMergedLabels(): Promise<LinearMergedLabelRecord[]> {
    const records = await this.context.loadJson<unknown[]>(this.mergedLabelsFile(), () => []);
    return (Array.isArray(records) ? records : [])
      .map(parseLinearMergedLabelRecord)
      .filter((record): record is LinearMergedLabelRecord => record !== null);
  }

  /**
   * Queues the `merged` label for an issue whose build's pull request merged.
   * `exists` when this issue and pull request were queued before (pending or
   * applied), so replays never label twice. Pending obligations are never evicted;
   * the history limit applies only to applied records.
   */
  enqueueLinearMergedLabel(
    input: LinearMergedLabelInput,
    now: Date = new Date(),
  ): "queued" | "exists" {
    if (this.isProjectWriteFenced(input.projectId)) return "exists";
    const at = now.toISOString();
    const record = parseLinearMergedLabelRecord({
      ...input,
      key: linearMergedLabelKey(input.issueId, input.prUrl),
      status: "pending",
      attempts: 0,
      createdAt: at,
      nextAttemptAt: at,
    });
    if (!record) throw new Error("Expected a Linear issue, pipeline, project and pull request.");
    return this.context.updateStore(
      this.mergedLabelsFile(),
      (): unknown[] => [],
      (records) => {
        if (records.some((entry) => isRecord(entry) && entry.key === record.key)) return "exists";
        const kept = records.filter((entry) => parseLinearMergedLabelRecord(entry) !== null);
        while (kept.length >= MAX_LINEAR_MERGED_LABELS) {
          const applied = kept.findIndex((entry) => isRecord(entry) && entry.status === "applied");
          if (applied < 0) break;
          kept.splice(applied, 1);
        }
        kept.push(record);
        records.splice(0, records.length, ...kept);
        return "queued";
      },
    );
  }

  /** Marks a record applied. False when it is gone or already applied. */
  settleLinearMergedLabel(
    key: string,
    outcome: LinearMergedLabelOutcome,
    now: Date = new Date(),
    claim?: LinearWriteClaimRef,
  ): boolean {
    return this.updateMergedLabel(key, (record) => {
      if (record.status === "applied" || !maySettleLabel(record, claim, now)) return false;
      delete record.claim;
      record.status = "applied";
      record.outcome = outcome;
      record.appliedAt = now.toISOString();
      record.attempts += 1;
      delete record.lastError;
      return true;
    });
  }

  /** Records a failed attempt and when to try again. False when the record is gone or applied. */
  deferLinearMergedLabel(
    key: string,
    failure: { error: string; nextAttemptAt: Date },
    claim?: LinearWriteClaimRef,
    now = new Date(),
  ): boolean {
    return this.updateMergedLabel(key, (record) => {
      if (record.status === "applied" || !maySettleLabel(record, claim, now)) return false;
      delete record.claim;
      record.attempts += 1;
      record.lastError = failure.error.slice(0, MAX_LINEAR_WRITE_ERROR) || "Linear failed";
      record.nextAttemptAt = failure.nextAttemptAt.toISOString();
      return true;
    });
  }

  /** Why a label has not been tried here. Leaves it due; false when already noted. */
  noteLinearMergedLabelWaiting(key: string, reason: string): boolean {
    return this.updateMergedLabel(key, (record) => {
      if (record.status === "applied" || record.lastError === reason) return false;
      record.lastError = reason.slice(0, MAX_LINEAR_WRITE_ERROR);
      return true;
    });
  }

  claimLinearMergedLabels(
    limit: number,
    until: Date,
    now: Date,
    owner: string,
    key?: string,
  ): LinearMergedLabelRecord[] {
    return this.claimWrites(
      this.mergedLabelsFile(),
      parseLinearMergedLabelRecord,
      limit,
      until,
      now,
      owner,
      (record) => record.status === "pending" && (key === undefined || record.key === key),
    );
  }

  private claimWrites<
    T extends { projectId: string; nextAttemptAt: string; claim?: LinearWriteClaim },
  >(
    file: string,
    parse: (value: unknown) => T | null,
    limit: number,
    until: Date,
    now: Date,
    owner: string,
    eligible: (record: T) => boolean,
    force = false,
  ): T[] {
    return this.context.updateStore(
      file,
      (): unknown[] => [],
      (records) => {
        const claimed: T[] = [];
        for (let index = 0; index < records.length && claimed.length < limit; index += 1) {
          const record = parse(records[index]);
          if (!record || !eligible(record) || this.isProjectWriteFenced(record.projectId)) continue;
          if (record.claim && Date.parse(record.claim.expiresAt) > now.getTime()) continue;
          if (!force && Date.parse(record.nextAttemptAt) > now.getTime()) continue;
          record.claim = { id: randomUUID(), owner, expiresAt: until.toISOString() };
          record.nextAttemptAt = record.claim.expiresAt;
          records[index] = record;
          claimed.push(record);
        }
        return claimed;
      },
    );
  }

  private updateMergedLabel(
    key: string,
    change: (record: LinearMergedLabelRecord) => boolean,
  ): boolean {
    return this.context.updateStore(
      this.mergedLabelsFile(),
      (): unknown[] => [],
      (records) => {
        const index = records.findIndex((entry) => isRecord(entry) && entry.key === key);
        const record = index >= 0 ? parseLinearMergedLabelRecord(records[index]) : null;
        if (!record || this.isProjectWriteFenced(record.projectId) || !change(record)) return false;
        records[index] = record;
        // An outage may grow the pending backlog beyond the history target.
        // Prune only completed obligations as it drains; never discard pending work.
        while (records.length > MAX_LINEAR_MERGED_LABELS) {
          const applied = records.findIndex(
            (entry) => isRecord(entry) && entry.status === "applied",
          );
          if (applied < 0) break;
          records.splice(applied, 1);
        }
        return true;
      },
    );
  }

  /** Every link this machine keeps, tombstones included. */
  async listLinearBoardLinks(): Promise<LinearBoardLink[]> {
    const links = await this.context.loadJson<unknown[]>(this.linksFile(), () => []);
    return (Array.isArray(links) ? links : [])
      .map(parseLinearBoardLink)
      .filter((link): link is LinearBoardLink => link !== null);
  }

  /** The live link under `key`, or `null` (none, or cleared). */
  async getLinearBoardLink(key: string): Promise<LinearBoardLink | null> {
    const link = (await this.listLinearBoardLinks()).find((entry) => entry.key === key);
    return link && !link.cleared ? link : null;
  }

  /**
   * Links a project's board. Refused when a live link of one of `localKeys`
   * (this machine's other projects) already names that board.
   */
  saveLinearBoardLink(
    input: Omit<LinearBoardLink, "updatedAt" | "cleared">,
    localKeys: ReadonlySet<string>,
    describe: (key: string) => string = (key) => key,
  ): LinearBoardLink {
    const link = parseLinearBoardLink({ ...input, updatedAt: nowIso() });
    if (!link) throw new Error("Expected a Linear team for the board link.");
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        const conflict = links
          .map(parseLinearBoardLink)
          .find(
            (other) =>
              other !== null &&
              other.key !== link.key &&
              localKeys.has(other.key) &&
              sameLinearBoard(other, link),
          );
        if (conflict) {
          throw new Error(
            `That Linear board is already linked to ${describe(conflict.key)}. A board belongs to one project.`,
          );
        }
        const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
        if (index >= 0) links[index] = link;
        else links.push(link);
        boundLinks(links);
        return link;
      },
    );
  }

  /** Clears a link, leaving a tombstone so the clear reaches other machines. */
  clearLinearBoardLink(key: string): boolean {
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        const index = links.findIndex((entry) => isRecord(entry) && entry.key === key);
        const existing = index >= 0 ? parseLinearBoardLink(links[index]) : null;
        if (!existing || existing.cleared) return false;
        links[index] = {
          key,
          ...(existing.repositoryHint ? { repositoryHint: existing.repositoryHint } : {}),
          updatedAt: nowIso(),
          cleared: true,
        };
        return true;
      },
    );
  }

  /**
   * Applies links from another machine: for each key, the side that changed it
   * last wins. Only repository keys travel. Returns how many changed here.
   *
   * A board belongs to one project here too: when an incoming link names the
   * board a live link of another of `localKeys` (this machine's projects)
   * already has, the link changed last keeps it and the other is replaced by
   * a tombstone naming the winner (`supersededBy`), stamped now so the clear
   * reaches every machine and they all settle on the same owner. Two
   * machines that each linked a different repository to one board therefore
   * converge instead of leaving two projects on it.
   */
  mergeLinearBoardLinks(
    incoming: readonly unknown[],
    localKeys: ReadonlySet<string> = new Set(),
  ): number {
    const parsed = incoming
      .slice(0, MAX_LINEAR_BOARD_LINKS)
      .map(parseLinearBoardLink)
      .filter(
        (link): link is LinearBoardLink => link !== null && isSyncableLinearLinkKey(link.key),
      );
    if (parsed.length === 0) return 0;
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        let changed = 0;
        const put = (link: LinearBoardLink) => {
          const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
          if (index >= 0) links[index] = link;
          else links.push(link);
          changed += 1;
        };
        for (const link of parsed) {
          const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
          const existing = index >= 0 ? parseLinearBoardLink(links[index]) : null;
          if (existing && !newer(link.updatedAt, existing.updatedAt)) continue;
          // A synced link cannot grant relay authority. Carry local provenance
          // forward only while the authorized board is identical.
          const { projectId: _projectId, ...synced } = link;
          const portable: LinearBoardLink = synced;
          if (
            !portable.cleared &&
            existing?.projectId &&
            !existing.cleared &&
            portable.teamId === existing.teamId &&
            portable.linearProjectId === existing.linearProjectId
          ) {
            portable.projectId = existing.projectId;
          }
          const rivals = localKeys.has(portable.key)
            ? links
                .map(parseLinearBoardLink)
                .filter(
                  (other): other is LinearBoardLink =>
                    other !== null &&
                    other.key !== portable.key &&
                    localKeys.has(other.key) &&
                    sameLinearBoard(other, portable),
                )
            : [];
          const winner = [portable, ...rivals].reduce((best, candidate) =>
            newer(candidate.updatedAt, best.updatedAt) ||
            (candidate.updatedAt === best.updatedAt && candidate.key < best.key)
              ? candidate
              : best,
          );
          for (const loser of [portable, ...rivals]) {
            if (loser === winner) continue;
            log.warn("board-link.conflict", { kept: winner.key, cleared: loser.key });
            put(supersededTombstone(loser, winner.key));
          }
          if (winner === portable) put(portable);
        }
        if (changed > 0) boundLinks(links);
        return changed;
      },
    );
  }

  async listLinearRevocations(): Promise<LinearRevocation[]> {
    const document = await this.context.loadJson<LinearSyncDocument | null>(
      this.syncFile(),
      () => null,
    );
    const list =
      isRecord(document) && Array.isArray(document.revocations) ? document.revocations : [];
    return list
      .map(parseLinearRevocation)
      .filter((revocation): revocation is LinearRevocation => revocation !== null);
  }

  /** Records disconnects (this machine's, or another's); returns how many were new or newer. */
  mergeLinearRevocations(incoming: readonly unknown[]): number {
    const parsed = incoming
      .slice(0, MAX_LINEAR_REVOCATIONS * 2)
      .map(parseLinearRevocation)
      .filter((revocation): revocation is LinearRevocation => revocation !== null);
    if (parsed.length === 0) return 0;
    return this.context.updateStore(
      this.syncFile(),
      (): LinearSyncDocument => ({ revocations: [] }),
      (document) => {
        const current = (Array.isArray(document.revocations) ? document.revocations : [])
          .map(parseLinearRevocation)
          .filter((revocation): revocation is LinearRevocation => revocation !== null);
        let changed = 0;
        for (const revocation of parsed) {
          const existing = current.find(
            (entry) => entry.keyFingerprint === revocation.keyFingerprint,
          );
          if (!existing || newer(revocation.revokedAt, existing.revokedAt)) changed += 1;
        }
        document.revocations = boundRevocations([...current, ...parsed], Date.now());
        return changed;
      },
    );
  }

  /** The issue an earlier `create_linear_issue` with this request key created, if any. */
  async findLinearIssueCreate(requestKey: string): Promise<LinearIssueCreateRecord | null> {
    const records = await this.context.loadJson<unknown[]>(this.createsFile(), () => []);
    const found = (Array.isArray(records) ? records : []).find(
      (record) => isRecord(record) && record.requestKey === requestKey,
    );
    return isRecord(found) &&
      typeof found.issueId === "string" &&
      typeof found.linkKey === "string" &&
      typeof found.createdAt === "string"
      ? {
          requestKey,
          linkKey: found.linkKey,
          issueId: found.issueId,
          createdAt: found.createdAt,
        }
      : null;
  }

  recordLinearIssueCreate(record: Omit<LinearIssueCreateRecord, "createdAt">): void {
    this.context.updateStore(
      this.createsFile(),
      (): LinearIssueCreateRecord[] => [],
      (records) => {
        const next = { ...record, createdAt: nowIso() };
        const index = records.findIndex(
          (entry) => isRecord(entry) && entry.requestKey === record.requestKey,
        );
        if (index >= 0) records[index] = next;
        else records.push(next);
        if (records.length > MAX_LINEAR_ISSUE_CREATES) {
          records.splice(0, records.length - MAX_LINEAR_ISSUE_CREATES);
        }
      },
    );
  }
}

/** What callers outside the storage files reach as `storage.linear`. */
export type LinearStorage = Pick<
  LinearRepository,
  | "listLinearBoardLinks"
  | "getLinearBoardLink"
  | "saveLinearBoardLink"
  | "clearLinearBoardLink"
  | "mergeLinearBoardLinks"
  | "listLinearRevocations"
  | "mergeLinearRevocations"
  | "findLinearIssueCreate"
  | "recordLinearIssueCreate"
  | "listLinearMergedLabels"
  | "enqueueLinearMergedLabel"
  | "settleLinearMergedLabel"
  | "deferLinearMergedLabel"
  | "noteLinearMergedLabelWaiting"
  | "claimLinearMergedLabels"
  | "listLinearPendingComments"
  | "enqueueLinearPendingComment"
  | "claimLinearPendingComments"
  | "recordLinearPendingCommentReceipt"
  | "finishLinearPendingComment"
  | "isProjectWriteFenced"
  | "deferLinearPendingComment"
>;
