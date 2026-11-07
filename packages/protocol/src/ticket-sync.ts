/**
 * Kanban sync between a command node and its leaves
 * (docs/architecture/tickets.md, "Sync across machines").
 *
 * - The command node's board is authoritative. A ticket keeps its id on every
 *   machine: a leaf's copy (a replica) has the command node's ticket id, so a
 *   coordinator never needs a leaf-local id.
 * - Down: the command node sends ticket snapshots and tombstones in its own
 *   change order (`seq`); the leaf applies them and keeps the last `seq` it
 *   applied as its cursor, so a leaf that reconnects after a long gap catches
 *   up from there rather than rescanning.
 * - Up: a change made on a leaf to a replica is journaled in the leaf's ticket
 *   outbox for that command node. The command node collects it (it dials
 *   out; a leaf never reaches it), applies it in order and exactly once (the
 *   outbox `epoch` and `seq`), acknowledges it, and fans the result out.
 * - Conflicts are per field: `title`, `content` (text, sections and labels) and
 *   `status` carry the revision of their last change. A leaf change made
 *   against an older revision than the board's is not applied; the board's
 *   value is kept and the conflict is recorded on the board and as a comment
 *   on the ticket. Comments merge by id; criteria results merge like Verify's.
 *   A deleted ticket leaves a tombstone, so a reconnecting leaf removes its
 *   copy instead of bringing the ticket back.
 *
 * Images are not synced: each machine keeps its own (see the design record).
 */

import { isTicketLabelList } from "./ticket-labels.js";
import {
  isAcceptanceCriterionCheck,
  isTicketKind,
  isTicketSections,
  type AcceptanceCriterionCheck,
  type TicketKind,
  type TicketSections,
} from "./ticket-sections.js";

/** Advertised by a backend that serves the leaf side of ticket sync. */
export const TICKET_SYNC_CAPABILITY = "ticket-sync";

/** A leaf announces queued ticket changes for one command node with this event. */
export const TICKET_SYNC_OUTBOX_READY_EVENT = "ticket-sync-outbox-ready";

/** The command node's view of its leaves' sync changed (renderer re-reads the status). */
export const TICKET_SYNC_STATUS_EVENT = "ticket-sync-status-changed";

export const TICKET_SYNC_LIMITS = {
  /** Snapshots or tombstones per `apply_ticket_sync` call. */
  maxBatchItems: 100,
  /** Outbox items per `collect_ticket_sync_outbox` answer. */
  maxCollectItems: 100,
  /** Queued changes a leaf holds for one command node before it refuses new ones. */
  maxOutboxItems: 10_000,
  /** Bytes of queued changes a leaf holds for one command node. */
  maxOutboxBytes: 32 * 1024 * 1024,
  /** Tombstones the command node keeps; older ones force a full resync. */
  maxTombstones: 5_000,
  /** Conflicts kept for display. */
  maxConflicts: 200,
  /** Characters of a conflicting value kept in its record. */
  maxConflictPreview: 500,
} as const;

export const TICKET_SYNC_FIELDS = ["title", "content", "status"] as const;
export type TicketSyncField = (typeof TICKET_SYNC_FIELDS)[number];
export type TicketFieldRevisions = Partial<Record<TicketSyncField, number>>;

export const TICKET_STATUSES = ["backlog", "in-progress", "review", "done"] as const;
export type TicketSyncStatus = (typeof TICKET_STATUSES)[number];

export interface TicketSyncComment {
  id: string;
  text: string;
  createdAt: string;
}

/** Where a ticket's build or environment runs, when that is another machine. */
export interface TicketWorkLocation {
  nodeId: string;
  nodeName?: string;
  buildPipelineId?: string;
  environmentId?: string;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  updatedAt: string;
}

/** Set on a leaf's copy of a command node's ticket. */
export interface TicketReplicaMeta {
  controllerId: string;
  /** The command node's project the ticket belongs to. */
  sourceProjectId: string;
  /** The command node's `seq` of the last snapshot applied (0 before the first). */
  seq: number;
  /** The command node's field revisions, as of that snapshot. */
  revs: TicketFieldRevisions;
  /** Created on this leaf; the command node has not confirmed it yet. */
  pendingCreate?: true;
}

/** Sync bookkeeping on a stored ticket row. */
export interface TicketSyncMeta {
  /** This node's change sequence of the ticket's latest synced change. */
  seq: number;
  /** The `seq` at which each field last changed on this node. */
  revs: TicketFieldRevisions;
  /** The node whose change produced each field's current revision; absent for this node. */
  revBy?: Partial<Record<TicketSyncField, string>>;
  replica?: TicketReplicaMeta;
  /** Work for the ticket on another machine. */
  work?: TicketWorkLocation;
}

export interface TicketContentValue {
  description: string;
  acceptanceCriteria: string;
  kind?: TicketKind;
  sections?: TicketSections;
  sectionsBasis?: string;
  /**
   * The ticket's labels; empty when it has none. Absent only from nodes that
   * predate labels, and then a receiver keeps the labels it has.
   */
  labels?: string[];
}

/** One ticket as the command node's board holds it. */
export interface TicketSnapshot extends TicketContentValue {
  id: string;
  seq: number;
  revs: TicketFieldRevisions;
  title: string;
  status: TicketSyncStatus;
  comments: TicketSyncComment[];
  createdAt: string;
  work?: TicketWorkLocation;
}

export interface TicketTombstone {
  id: string;
  seq: number;
  deleted: true;
  deletedAt: string;
}

export type TicketSyncItem = TicketSnapshot | TicketTombstone;

export function isTicketTombstone(item: TicketSyncItem): item is TicketTombstone {
  return (item as TicketTombstone).deleted === true;
}

/** A change made on a leaf, sent up to the command node. */
export type TicketSyncOp =
  | {
      kind: "create";
      ticket: TicketContentValue & {
        title: string;
        status: TicketSyncStatus;
        comments: TicketSyncComment[];
        createdAt: string;
      };
    }
  | { kind: "set-title"; value: string; baseRev: number }
  | { kind: "set-content"; value: TicketContentValue; baseRev: number }
  | { kind: "set-status"; value: TicketSyncStatus; baseRev: number }
  | {
      kind: "checks";
      checks: Array<{ id: string; text: string; check: AcceptanceCriterionCheck }>;
    }
  | { kind: "add-comment"; comment: TicketSyncComment }
  | { kind: "delete-comment"; commentId: string }
  | {
      kind: "work";
      work: Omit<TicketWorkLocation, "nodeId" | "nodeName" | "updatedAt">;
    }
  | { kind: "delete" };

export interface TicketSyncOutboxItem {
  seq: number;
  ticketId: string;
  /** The command node's project. */
  sourceProjectId: string;
  createdAt: string;
  op: TicketSyncOp;
  bytes: number;
}

/** A leaf change the command node did not apply, kept for the user. */
export interface TicketSyncConflict {
  at: string;
  ticketId: string;
  projectId: string;
  fromNodeId: string;
  fromNodeName?: string;
  field: TicketSyncField | "ticket";
  /** Why the board's value was kept. */
  reason: "stale-revision" | "ticket-deleted";
  /** The value that was not applied, bounded. */
  value: string;
}

/** The command node's sync with one leaf for one project, for the board and tools. */
export interface TicketSyncNodeState {
  nodeId: string;
  nodeName: string;
  /** The leaf's copy of the project. */
  projectId?: string;
  state: "in-sync" | "syncing" | "behind" | "offline" | "update-required" | "error";
  /** The board's latest change and the last one the leaf confirmed. */
  latestSeq: number;
  cursor: number;
  lastSyncedAt?: string;
  /** A short, content-free explanation for anything but in-sync. */
  message?: string;
}

export interface TicketSyncStatusResult {
  projectId: string;
  nodes: TicketSyncNodeState[];
  conflicts: TicketSyncConflict[];
}

/** A leaf that does not advertise `ticket-sync` (version-compatibility.md, Register). */
export function olderLeafTicketMessage(nodeName: string): string {
  return `${nodeName} runs an older Orkestrator that cannot sync tickets. Update that machine to see this board's tickets there and build them by id.`;
}

/**
 * A launch, build, review or other change for a machine that is not
 * connected. These are refused rather than queued: run hours later, a launch
 * would start from a stale base, and an ambiguous outcome could not be
 * resolved without running it twice. Ticket changes do wait (see above).
 */
export function offlineLaunchMessage(nodeName: string): string {
  return (
    `${nodeName} is not connected; changes to it are disabled. Nothing was started there: launches, builds and reviews on another machine are not queued. ` +
    `Retry when it reconnects (list_nodes), or run the work on another machine. Ticket tools still take its nodeId: their changes wait on this board until it reconnects.`
  );
}

export function offlineTicketMessage(nodeName: string): string {
  return `${nodeName} is not connected. Ticket changes wait here and reach it when it reconnects.`;
}

/*
 * Validation of what crosses the node link.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTicketSyncStatus(value: unknown): value is TicketSyncStatus {
  return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

function parseRevisions(value: unknown): TicketFieldRevisions {
  if (!isRecord(value)) throw new Error("Invalid ticket revisions.");
  const revs: TicketFieldRevisions = {};
  for (const field of TICKET_SYNC_FIELDS) {
    if (value[field] === undefined) continue;
    if (!isSeq(value[field])) throw new Error("Invalid ticket revisions.");
    revs[field] = value[field] as number;
  }
  return revs;
}

function parseComment(value: unknown): TicketSyncComment {
  if (
    !isRecord(value) ||
    !isBoundedString(value.id, 200) ||
    !value.id ||
    !isBoundedString(value.text, 100_000) ||
    !isBoundedString(value.createdAt, 64)
  ) {
    throw new Error("Invalid ticket comment.");
  }
  return { id: value.id, text: value.text, createdAt: value.createdAt };
}

function parseContent(value: Record<string, unknown>): TicketContentValue {
  if (
    !isBoundedString(value.description, 200_000) ||
    !isBoundedString(value.acceptanceCriteria, 200_000)
  ) {
    throw new Error("Invalid ticket content.");
  }
  if (value.kind !== undefined && !isTicketKind(value.kind)) {
    throw new Error("Invalid ticket kind.");
  }
  if (value.sections !== undefined && !isTicketSections(value.sections)) {
    throw new Error("Invalid ticket sections.");
  }
  if (value.sectionsBasis !== undefined && !isBoundedString(value.sectionsBasis, 200)) {
    throw new Error("Invalid ticket sections basis.");
  }
  if (value.labels !== undefined && !isTicketLabelList(value.labels)) {
    throw new Error("Invalid ticket labels.");
  }
  return {
    description: value.description,
    acceptanceCriteria: value.acceptanceCriteria,
    ...(value.kind !== undefined ? { kind: value.kind as TicketKind } : {}),
    ...(value.sections !== undefined ? { sections: value.sections as TicketSections } : {}),
    ...(value.sectionsBasis !== undefined ? { sectionsBasis: value.sectionsBasis as string } : {}),
    ...(Array.isArray(value.labels) ? { labels: [...(value.labels as string[])] } : {}),
  };
}

function parseWork(value: unknown): TicketWorkLocation {
  if (!isRecord(value) || !isBoundedString(value.nodeId, 200) || !value.nodeId) {
    throw new Error("Invalid ticket work location.");
  }
  const work: TicketWorkLocation = {
    nodeId: value.nodeId,
    updatedAt: isBoundedString(value.updatedAt, 64) ? value.updatedAt : "",
  };
  for (const key of ["nodeName", "buildPipelineId", "environmentId", "prUrl"] as const) {
    if (value[key] !== undefined) {
      if (!isBoundedString(value[key], 2_000)) throw new Error("Invalid ticket work location.");
      work[key] = value[key] as string;
    }
  }
  if (value.prState !== undefined) {
    if (value.prState !== "open" && value.prState !== "merged" && value.prState !== "closed") {
      throw new Error("Invalid ticket work location.");
    }
    work.prState = value.prState;
  }
  return work;
}

export function parseTicketSyncItem(value: unknown): TicketSyncItem {
  if (!isRecord(value) || !isBoundedString(value.id, 200) || !value.id || !isSeq(value.seq)) {
    throw new Error("Invalid ticket sync item.");
  }
  if (value.deleted === true) {
    return {
      id: value.id,
      seq: value.seq,
      deleted: true,
      deletedAt: isBoundedString(value.deletedAt, 64) ? value.deletedAt : "",
    };
  }
  if (
    !isBoundedString(value.title, 2_000) ||
    !isTicketSyncStatus(value.status) ||
    !Array.isArray(value.comments) ||
    value.comments.length > 2_000 ||
    !isBoundedString(value.createdAt, 64)
  ) {
    throw new Error("Invalid ticket snapshot.");
  }
  return {
    id: value.id,
    seq: value.seq,
    revs: parseRevisions(value.revs ?? {}),
    title: value.title,
    status: value.status,
    comments: value.comments.map(parseComment),
    createdAt: value.createdAt,
    ...parseContent(value),
    ...(value.work !== undefined ? { work: parseWork(value.work) } : {}),
  };
}

export function parseTicketSyncOp(value: unknown): TicketSyncOp {
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error("Invalid ticket change.");
  switch (value.kind) {
    case "create": {
      const ticket = value.ticket;
      if (
        !isRecord(ticket) ||
        !isBoundedString(ticket.title, 2_000) ||
        !isTicketSyncStatus(ticket.status) ||
        !Array.isArray(ticket.comments) ||
        ticket.comments.length > 2_000 ||
        !isBoundedString(ticket.createdAt, 64)
      ) {
        throw new Error("Invalid ticket creation.");
      }
      return {
        kind: "create",
        ticket: {
          title: ticket.title,
          status: ticket.status,
          comments: ticket.comments.map(parseComment),
          createdAt: ticket.createdAt,
          ...parseContent(ticket),
        },
      };
    }
    case "set-title":
      if (!isBoundedString(value.value, 2_000) || !isSeq(value.baseRev)) break;
      return { kind: "set-title", value: value.value, baseRev: value.baseRev };
    case "set-content":
      if (!isRecord(value.value) || !isSeq(value.baseRev)) break;
      return { kind: "set-content", value: parseContent(value.value), baseRev: value.baseRev };
    case "set-status":
      if (!isTicketSyncStatus(value.value) || !isSeq(value.baseRev)) break;
      return { kind: "set-status", value: value.value, baseRev: value.baseRev };
    case "checks": {
      if (!Array.isArray(value.checks) || value.checks.length > 500) break;
      const checks = value.checks.map((entry) => {
        if (
          !isRecord(entry) ||
          !isBoundedString(entry.id, 64) ||
          !isBoundedString(entry.text, 20_000) ||
          !isAcceptanceCriterionCheck(entry.check)
        ) {
          throw new Error("Invalid ticket criteria results.");
        }
        return { id: entry.id, text: entry.text, check: entry.check };
      });
      return { kind: "checks", checks };
    }
    case "add-comment":
      return { kind: "add-comment", comment: parseComment(value.comment) };
    case "delete-comment":
      if (!isBoundedString(value.commentId, 200) || !value.commentId) break;
      return { kind: "delete-comment", commentId: value.commentId };
    case "work": {
      if (!isRecord(value.work)) break;
      const {
        nodeId: _nodeId,
        nodeName: _nodeName,
        ...rest
      } = parseWork({
        ...value.work,
        nodeId: "leaf",
      });
      const { updatedAt: _updatedAt, ...work } = rest;
      return { kind: "work", work };
    }
    case "delete":
      return { kind: "delete" };
  }
  throw new Error("Invalid ticket change.");
}

export function parseTicketSyncOutboxItem(value: unknown): TicketSyncOutboxItem {
  if (
    !isRecord(value) ||
    !isSeq(value.seq) ||
    value.seq === 0 ||
    !isBoundedString(value.ticketId, 200) ||
    !value.ticketId ||
    !isBoundedString(value.sourceProjectId, 200) ||
    !value.sourceProjectId ||
    !isBoundedString(value.createdAt, 64)
  ) {
    throw new Error("Invalid ticket outbox item.");
  }
  return {
    seq: value.seq,
    ticketId: value.ticketId,
    sourceProjectId: value.sourceProjectId,
    createdAt: value.createdAt,
    op: parseTicketSyncOp(value.op),
    bytes: isSeq(value.bytes) ? value.bytes : 0,
  };
}

/** A conflicting value as a bounded, single-line preview. */
export function ticketSyncConflictPreview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TICKET_SYNC_LIMITS.maxConflictPreview
    ? `${flat.slice(0, TICKET_SYNC_LIMITS.maxConflictPreview - 1)}…`
    : flat;
}

/** The comment a ticket gets when a leaf's change to it could not be applied. */
export function ticketSyncConflictComment(conflict: TicketSyncConflict): string {
  const who = conflict.fromNodeName ?? conflict.fromNodeId;
  if (conflict.reason === "ticket-deleted") {
    return `⚠️ Sync conflict: a change from ${who} reached the command node after this ticket was deleted there, so it was not applied.`;
  }
  const field = conflict.field === "content" ? "description" : conflict.field;
  return (
    `⚠️ Sync conflict: ${who} changed the ${field} of this ticket while it was also changed on the command node. ` +
    `The command node's version was kept. ${who}'s version was: ${conflict.value}`
  );
}
