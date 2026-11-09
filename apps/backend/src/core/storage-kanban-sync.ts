import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  TICKET_SYNC_FEATURES,
  TICKET_SYNC_LIMITS,
  parseTicketSyncOp,
  ticketSyncConflictPreview,
  type TicketContentValue,
  type TicketSnapshot,
  type TicketSyncConflict,
  type TicketSyncField,
  type TicketSyncImageRef,
  type TicketSyncMeta,
  type TicketSyncOp,
  type TicketSyncOutboxItem,
  type TicketTombstone,
  type TicketWorkLocation,
} from "@orkestrator/protocol/ticket-sync";

import type { KanbanImage, KanbanTask } from "./storage-shared.js";

/**
 * The pure half of Kanban sync (docs/architecture/tickets.md, "Sync across
 * machines"): the `kanban-sync` store, the stamp every local ticket change
 * gets, the outbox a leaf keeps for each command node, and the rules the
 * command node applies a leaf's change by. `KanbanRepository` calls these
 * inside the Kanban lease and commits the board and this store together.
 */

export interface KanbanSyncReplicaLink {
  controllerId: string;
  /** This leaf's project. */
  projectId: string;
  /** The command node's project it mirrors. */
  sourceProjectId: string;
  /** The command node's store epoch the cursor counts in. */
  sourceEpoch: string;
  cursor: number;
  appliedAt: string;
}

export interface KanbanSyncPeerProject {
  leafProjectId: string;
  cursor: number;
  syncedAt?: string;
}

export interface KanbanSyncPeer {
  /** The leaf outbox epoch `appliedSeq` counts in. */
  outboxEpoch?: string;
  appliedSeq: number;
  /** By this node's project. */
  projects: Record<string, KanbanSyncPeerProject>;
}

export interface KanbanSyncOutbox {
  epoch: string;
  nextSeq: number;
  items: TicketSyncOutboxItem[];
}

export interface KanbanSyncStore {
  version: 1;
  /** Minted with the store, so a cursor counted in another store's sequence is never trusted. */
  epoch: string;
  nextSeq: number;
  /** Deleted tickets this node's board owned, so leaves remove their copies. */
  tombstones: Record<string, { projectId: string; seq: number; deletedAt: string }>;
  /** Per project, the highest tombstone seq pruned: a cursor below it needs a full resync. */
  prunedThrough: Record<string, number>;
  /** Leaf: queued changes per command node. */
  outbox: Record<string, KanbanSyncOutbox>;
  /** Leaf: per `controllerId\0projectId`, what that command node last sent. */
  replicas: Record<string, KanbanSyncReplicaLink>;
  /** Command node: per leaf node. */
  peers: Record<string, KanbanSyncPeer>;
  conflicts: TicketSyncConflict[];
  /**
   * Leaf: what each command node declared it can apply when it last
   * collected (`TICKET_SYNC_FEATURES`). Changes it cannot read are not queued.
   */
  features: Record<string, string[]>;
}

export function emptyKanbanSyncStore(): KanbanSyncStore {
  return {
    version: 1,
    epoch: randomUUID(),
    nextSeq: 1,
    tombstones: {},
    prunedThrough: {},
    outbox: {},
    replicas: {},
    peers: {},
    conflicts: [],
    features: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored value, or `null` when there is none yet (the caller mints and saves one). */
export function parseKanbanSyncStore(value: unknown): KanbanSyncStore | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.epoch !== "string") return null;
  const record = <T>(field: string): Record<string, T> =>
    isRecord(value[field]) ? (value[field] as Record<string, T>) : {};
  return {
    version: 1,
    epoch: value.epoch,
    nextSeq:
      typeof value.nextSeq === "number" && Number.isSafeInteger(value.nextSeq) && value.nextSeq > 0
        ? value.nextSeq
        : 1,
    tombstones: record("tombstones"),
    prunedThrough: record("prunedThrough"),
    outbox: record("outbox"),
    replicas: record("replicas"),
    peers: record("peers"),
    conflicts: Array.isArray(value.conflicts) ? (value.conflicts as TicketSyncConflict[]) : [],
    features: record("features"),
  };
}

/** Whether a command node declared `feature` when it last collected this leaf's outbox. */
export function controllerHasFeature(
  store: KanbanSyncStore,
  controllerId: string,
  feature: string,
): boolean {
  const features = store.features[controllerId];
  return Array.isArray(features) && features.includes(feature);
}

export function replicaLinkKey(controllerId: string, projectId: string): string {
  return `${controllerId}\0${projectId}`;
}

/** The command node a new ticket in this leaf project goes up to: the one that synced it last. */
export function replicaLinkForProject(
  store: KanbanSyncStore,
  projectId: string,
): KanbanSyncReplicaLink | undefined {
  let best: KanbanSyncReplicaLink | undefined;
  for (const link of Object.values(store.replicas)) {
    if (link.projectId !== projectId) continue;
    if (!best || link.appliedAt > best.appliedAt) best = link;
  }
  return best;
}

export class TicketSyncOutboxFullError extends Error {
  readonly code = "ticket-sync-outbox-full";
}

/*
 * What a ticket change is, field by field.
 */

export function ticketContentValue(task: KanbanTask): TicketContentValue {
  return {
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    ...(task.kind !== undefined ? { kind: task.kind } : {}),
    ...(task.sections !== undefined ? { sections: task.sections } : {}),
    ...(task.sectionsBasis !== undefined ? { sectionsBasis: task.sectionsBasis } : {}),
    labels: task.labels ?? [],
  };
}

/** Synced content as a new row stores it: labels only when it has some. */
export function storedTicketContent(content: TicketContentValue): TicketContentValue {
  const { labels, ...rest } = content;
  return { ...rest, ...(labels?.length ? { labels: [...labels] } : {}) };
}

/**
 * Writes synced content onto a stored row. Content from a node that predates
 * labels carries none, and the row keeps its own; an empty list clears them.
 */
export function assignTicketContent(row: KanbanTask, content: TicketContentValue): void {
  delete row.kind;
  delete row.sections;
  delete row.sectionsBasis;
  const { labels, ...rest } = content;
  Object.assign(row, rest);
  if (labels === undefined) return;
  if (labels.length) row.labels = [...labels];
  else delete row.labels;
}

/** Content without criteria results, which merge on their own and never conflict. */
function contentKey(task: KanbanTask): string {
  const sections = task.sections
    ? {
        ...task.sections,
        ...(task.sections.acceptanceCriteria
          ? {
              acceptanceCriteria: task.sections.acceptanceCriteria.map(({ id, text }) => ({
                id,
                text,
              })),
            }
          : {}),
      }
    : undefined;
  return JSON.stringify([
    task.description,
    task.acceptanceCriteria,
    task.kind ?? null,
    sections,
    task.labels ?? [],
  ]);
}

function criteriaChecks(task: KanbanTask) {
  return (task.sections?.acceptanceCriteria ?? []).flatMap((criterion) =>
    criterion.check ? [{ id: criterion.id, text: criterion.text, check: criterion.check }] : [],
  );
}

type LocalWork = Omit<TicketWorkLocation, "nodeId" | "nodeName" | "updatedAt">;

function localWork(task: KanbanTask): LocalWork {
  return {
    ...(task.buildPipelineId ? { buildPipelineId: task.buildPipelineId } : {}),
    ...(task.environmentId ? { environmentId: task.environmentId } : {}),
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    ...(task.prState ? { prState: task.prState } : {}),
  };
}

interface TicketDiff {
  title: boolean;
  content: boolean;
  checks: boolean;
  status: boolean;
  addedComments: KanbanTask["comments"];
  removedComments: string[];
  /** Images by id: a reference gaining its bytes or a sync mark is not a change. */
  addedImages: KanbanImage[];
  removedImages: string[];
  work: boolean;
}

export function diffTickets(before: KanbanTask, after: KanbanTask): TicketDiff {
  const beforeComments = new Set(before.comments.map((comment) => comment.id));
  const afterComments = new Set(after.comments.map((comment) => comment.id));
  const beforeImages = new Set((before.images ?? []).map((image) => image.id));
  const afterImages = new Set((after.images ?? []).map((image) => image.id));
  return {
    title: before.title !== after.title,
    content: contentKey(before) !== contentKey(after),
    checks: !isDeepStrictEqual(criteriaChecks(before), criteriaChecks(after)),
    status: before.status !== after.status || before.prMergeDoneUrl !== after.prMergeDoneUrl,
    addedComments: after.comments.filter((comment) => !beforeComments.has(comment.id)),
    removedComments: before.comments
      .filter((comment) => !afterComments.has(comment.id))
      .map((comment) => comment.id),
    addedImages: (after.images ?? []).filter((image) => !beforeImages.has(image.id)),
    removedImages: (before.images ?? [])
      .filter((image) => !afterImages.has(image.id))
      .map((image) => image.id),
    work: !isDeepStrictEqual(localWork(before), localWork(after)),
  };
}

function syncedChange(diff: TicketDiff): boolean {
  return (
    diff.title ||
    diff.content ||
    diff.checks ||
    diff.status ||
    diff.addedComments.length > 0 ||
    diff.removedComments.length > 0 ||
    diff.addedImages.length > 0 ||
    diff.removedImages.length > 0
  );
}

/** An image as a synced reference; `nodeId` is set by whoever knows where its bytes are. */
export function imageRef(image: KanbanImage, nodeId?: string): TicketSyncImageRef {
  const holder = image.nodeId ?? nodeId;
  return {
    id: image.id,
    filename: image.filename,
    createdAt: image.createdAt,
    ...(holder ? { nodeId: holder } : {}),
    ...(image.nodeId && image.nodeName ? { nodeName: image.nodeName } : {}),
  };
}

/** The images whose bytes are on this machine. */
function ownImages(task: KanbanTask): KanbanImage[] {
  return (task.images ?? []).filter((image) => !image.nodeId);
}

function nextSeq(store: KanbanSyncStore): number {
  const seq = store.nextSeq;
  store.nextSeq = seq + 1;
  return seq;
}

/*
 * The leaf outbox.
 */

function outboxFor(store: KanbanSyncStore, controllerId: string): KanbanSyncOutbox {
  const existing = store.outbox[controllerId];
  if (existing) return existing;
  const created: KanbanSyncOutbox = { epoch: randomUUID(), nextSeq: 1, items: [] };
  store.outbox[controllerId] = created;
  return created;
}

function opBytes(op: TicketSyncOp): number {
  return Buffer.byteLength(JSON.stringify(op));
}

/**
 * Queues an immutable change for a command node. Over the bounds the change
 * is refused rather than dropped.
 */
export function journalTicketOp(
  store: KanbanSyncStore,
  controllerId: string,
  ticketId: string,
  sourceProjectId: string,
  op: TicketSyncOp,
  now: string,
): void {
  parseTicketSyncOp(op);
  const outbox = outboxFor(store, controllerId);
  // Collection and acknowledgement are separate RPCs. Every queued record may
  // already have been applied remotely, so its payload and sequence are immutable.
  const bytes = opBytes(op);
  const total = outbox.items.reduce((sum, item) => sum + item.bytes, 0) + bytes;
  if (
    outbox.items.length + 1 > TICKET_SYNC_LIMITS.maxOutboxItems ||
    total > TICKET_SYNC_LIMITS.maxOutboxBytes
  ) {
    throw new TicketSyncOutboxFullError(
      "This machine has too many ticket changes waiting for its command node to collect. Reconnect the command node, then retry.",
    );
  }
  outbox.items.push({
    seq: outbox.nextSeq,
    ticketId,
    sourceProjectId,
    createdAt: now,
    op,
    bytes,
  });
  outbox.nextSeq += 1;
}

/** Fields of a ticket with a change queued for its command node, which a snapshot must not overwrite. */
export function pendingTicketFields(
  store: KanbanSyncStore,
  controllerId: string,
  ticketId: string,
): {
  fields: Set<TicketSyncField>;
  addedComments: Set<string>;
  removedComments: Set<string>;
  addedImages: Set<string>;
  removedImages: Set<string>;
  deleted: boolean;
  created: boolean;
} {
  const fields = new Set<TicketSyncField>();
  const addedComments = new Set<string>();
  const removedComments = new Set<string>();
  const addedImages = new Set<string>();
  const removedImages = new Set<string>();
  let deleted = false;
  let created = false;
  for (const item of store.outbox[controllerId]?.items ?? []) {
    if (item.ticketId !== ticketId) continue;
    const op = item.op;
    if (op.kind === "set-title") fields.add("title");
    else if (op.kind === "set-content") fields.add("content");
    else if (op.kind === "set-status") fields.add("status");
    else if (op.kind === "add-comment") addedComments.add(op.comment.id);
    else if (op.kind === "delete-comment") removedComments.add(op.commentId);
    else if (op.kind === "add-image") addedImages.add(op.image.id);
    else if (op.kind === "delete-image") removedImages.add(op.imageId);
    else if (op.kind === "delete") deleted = true;
    else if (op.kind === "create") {
      created = true;
      for (const image of op.ticket.images ?? []) addedImages.add(image.id);
    }
  }
  return { fields, addedComments, removedComments, addedImages, removedImages, deleted, created };
}

/*
 * The stamp of a local change.
 */

/**
 * Records a local change to one ticket: its seq and field revisions, a
 * tombstone for a deletion, and, for a leaf's copy of a command node's ticket,
 * the changes queued for that command node. `stored` is the row about to be
 * saved (null when deleted); `before` and `after` are both normalized.
 * Returns the controllers that got queued changes.
 */
export function stampTicketChange(
  store: KanbanSyncStore,
  input: {
    before: KanbanTask | null;
    after: KanbanTask | null;
    stored: KanbanTask | null;
    now: string;
  },
): string[] {
  const { before, after, stored, now } = input;
  if (!after || !stored) {
    if (!before) return [];
    const seq = nextSeq(store);
    const replica = before.sync?.replica;
    if (replica) {
      journalTicketOp(
        store,
        replica.controllerId,
        before.id,
        replica.sourceProjectId,
        { kind: "delete" },
        now,
      );
    }
    // A leaf keeps one too, so a snapshot sent before its deletion is collected
    // does not bring the ticket back.
    store.tombstones[before.id] = { projectId: before.projectId, seq, deletedAt: now };
    pruneTombstones(store);
    return replica ? [replica.controllerId] : [];
  }
  if (!before) {
    const seq = nextSeq(store);
    const meta: TicketSyncMeta = {
      seq,
      revs: { title: seq, content: seq, status: seq },
    };
    stored.sync = meta;
    const link = replicaLinkForProject(store, after.projectId);
    if (link) shareTicket(store, link, after, stored, now);
    return link ? [link.controllerId] : [];
  }
  const diff = diffTickets(before, after);
  const replica = stored.sync?.replica;
  if (!syncedChange(diff) && !(replica && diff.work)) return [];
  const meta: TicketSyncMeta = stored.sync
    ? { ...stored.sync, revs: { ...stored.sync.revs } }
    : { seq: 0, revs: {} };
  if (syncedChange(diff)) {
    const seq = nextSeq(store);
    meta.seq = seq;
    const revBy = { ...meta.revBy };
    for (const field of ["title", "content", "status"] as const) {
      if (!diff[field]) continue;
      meta.revs[field] = seq;
      delete revBy[field];
    }
    if (Object.keys(revBy).length) meta.revBy = revBy;
    else delete meta.revBy;
  }
  stored.sync = meta;
  if (!replica) return [];
  const queue = (op: TicketSyncOp) =>
    journalTicketOp(store, replica.controllerId, after.id, replica.sourceProjectId, op, now);
  const images = controllerHasFeature(store, replica.controllerId, TICKET_SYNC_FEATURES.images);
  if (diff.title)
    queue({ kind: "set-title", value: after.title, baseRev: replica.revs.title ?? 0 });
  if (diff.content) {
    queue({
      kind: "set-content",
      value: ticketContentValue(after),
      baseRev: replica.revs.content ?? 0,
    });
  } else if (diff.checks) {
    queue({ kind: "checks", checks: criteriaChecks(after) });
  }
  if (diff.status) {
    queue({
      kind: "set-status",
      value: after.status,
      baseRev: replica.revs.status ?? 0,
      ...(after.prMergeDoneUrl ? { prMergeDoneUrl: after.prMergeDoneUrl } : {}),
    });
  }
  for (const comment of diff.addedComments) {
    queue({
      kind: "add-comment",
      comment: { id: comment.id, text: comment.text, createdAt: comment.createdAt },
    });
  }
  for (const commentId of diff.removedComments) queue({ kind: "delete-comment", commentId });
  if (images) {
    // Only this machine's own images go up: a reference came from the board.
    for (const image of diff.addedImages) {
      if (!image.nodeId) queue({ kind: "add-image", image: imageRef(image) });
    }
    for (const imageId of diff.removedImages) queue({ kind: "delete-image", imageId });
  }
  if (diff.work) queue({ kind: "work", work: localWork(after) });
  return [replica.controllerId];
}

/**
 * Makes a ticket on this leaf the command node's: marks it a copy waiting for
 * confirmation and queues its creation, with its own images when the command
 * node reads them. A new leaf ticket does this as it is created; an older one
 * when the user shares it. `after` is normalized, `stored` the row to save.
 */
export function shareTicket(
  store: KanbanSyncStore,
  link: KanbanSyncReplicaLink,
  after: KanbanTask,
  stored: KanbanTask,
  now: string,
): void {
  const images = controllerHasFeature(store, link.controllerId, TICKET_SYNC_FEATURES.images)
    ? ownImages(after).map((image) => imageRef(image))
    : [];
  journalTicketOp(
    store,
    link.controllerId,
    after.id,
    link.sourceProjectId,
    {
      kind: "create",
      ticket: {
        ...ticketContentValue(after),
        title: after.title,
        status: after.status,
        ...(after.prMergeDoneUrl ? { prMergeDoneUrl: after.prMergeDoneUrl } : {}),
        comments: after.comments.map(({ id, text, createdAt }) => ({ id, text, createdAt })),
        ...(images.length ? { images } : {}),
        createdAt: after.createdAt,
      },
    },
    now,
  );
  stored.sync = {
    ...(stored.sync ?? { seq: 0, revs: {} }),
    replica: {
      controllerId: link.controllerId,
      sourceProjectId: link.sourceProjectId,
      seq: 0,
      revs: {},
      pendingCreate: true,
    },
  };
}

function pruneTombstones(store: KanbanSyncStore): void {
  const entries = Object.entries(store.tombstones);
  if (entries.length <= TICKET_SYNC_LIMITS.maxTombstones) return;
  entries.sort((left, right) => left[1].seq - right[1].seq);
  for (const [id, tombstone] of entries.slice(
    0,
    entries.length - TICKET_SYNC_LIMITS.maxTombstones,
  )) {
    store.prunedThrough[tombstone.projectId] = Math.max(
      store.prunedThrough[tombstone.projectId] ?? 0,
      tombstone.seq,
    );
    delete store.tombstones[id];
  }
}

/*
 * The command node's side.
 */

/**
 * One ticket as sent to a leaf. With `selfId`, its images go too, each naming
 * the machine with its bytes (this one, unless it is a leaf's reference).
 */
export function ticketSnapshot(task: KanbanTask, selfId?: string): TicketSnapshot {
  return {
    id: task.id,
    seq: task.sync?.seq ?? 0,
    revs: task.sync?.revs ?? {},
    title: task.title,
    status: task.status,
    ...(task.prMergeDoneUrl ? { prMergeDoneUrl: task.prMergeDoneUrl } : {}),
    comments: task.comments.map(({ id, text, createdAt }) => ({ id, text, createdAt })),
    ...(selfId ? { images: (task.images ?? []).map((image) => imageRef(image, selfId)) } : {}),
    createdAt: task.createdAt,
    ...ticketContentValue(task),
    ...(task.sync?.work ? { work: task.sync.work } : {}),
  };
}

export function ticketTombstone(
  id: string,
  tombstone: KanbanSyncStore["tombstones"][string],
): TicketTombstone {
  return { id, seq: tombstone.seq, deleted: true, deletedAt: tombstone.deletedAt };
}

/**
 * Whether a leaf's change to `field`, made against `baseRev`, may replace the
 * board's value: nobody changed it since the leaf saw it, or the change since
 * was that same leaf's own (an earlier change it made, not yet seen back).
 */
export function acceptsFieldChange(
  meta: TicketSyncMeta | undefined,
  field: TicketSyncField,
  baseRev: number,
  fromNodeId: string,
): boolean {
  const current = meta?.revs[field] ?? 0;
  return baseRev >= current || meta?.revBy?.[field] === fromNodeId;
}

/** Marks fields as changed by a leaf's applied change, after the stamp gave them a revision. */
export function attributeFields(
  stored: KanbanTask,
  fields: readonly TicketSyncField[],
  fromNodeId: string,
): void {
  if (!stored.sync || fields.length === 0) return;
  const revBy = { ...stored.sync.revBy };
  for (const field of fields) revBy[field] = fromNodeId;
  stored.sync = { ...stored.sync, revBy };
}

export function recordConflict(
  store: KanbanSyncStore,
  conflict: Omit<TicketSyncConflict, "value"> & { value: unknown },
): TicketSyncConflict {
  const recorded: TicketSyncConflict = {
    ...conflict,
    id: randomUUID(),
    value: ticketSyncConflictPreview(conflict.value),
  };
  store.conflicts = [...store.conflicts, recorded].slice(-TICKET_SYNC_LIMITS.maxConflicts);
  return recorded;
}

/** A conflict's id; records written before ids existed get a stable one from their content. */
export function ticketSyncConflictId(conflict: TicketSyncConflict): string {
  if (conflict.id) return conflict.id;
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        conflict.at,
        conflict.ticketId,
        conflict.projectId,
        conflict.fromNodeId,
        conflict.field,
        conflict.reason,
        conflict.value,
      ]),
    )
    .digest("hex");
  return `legacy-${hex.slice(0, 32)}`;
}

/**
 * A leaf's images after a command node's snapshot. `incoming` absent (an older
 * command node) keeps the row's. Otherwise each reference is kept, a
 * reference to an image whose bytes are here stays this machine's own, and an
 * own image the board does not list is kept while its upload is queued or if
 * it never reached the board, and removed once the board had it and dropped
 * it. Returns the images and the ids whose local copies to delete.
 */
export function mergeSnapshotImages(
  current: readonly KanbanImage[],
  incoming: readonly TicketSyncImageRef[] | undefined,
  pending: { addedImages: ReadonlySet<string>; removedImages: ReadonlySet<string> },
  controllerId: string,
): { images: KanbanImage[]; removed: string[] } {
  if (!incoming) return { images: [...current], removed: [] };
  const byId = new Map(current.map((image) => [image.id, image]));
  const listed = new Set(incoming.map((image) => image.id));
  const images: KanbanImage[] = [];
  for (const ref of incoming) {
    if (pending.removedImages.has(ref.id)) continue;
    const local = byId.get(ref.id);
    if (local && !local.nodeId) {
      images.push({ ...local, synced: true });
      continue;
    }
    const nodeId = ref.nodeId ?? controllerId;
    images.push({
      id: ref.id,
      filename: ref.filename,
      createdAt: ref.createdAt,
      nodeId,
      ...(ref.nodeName ? { nodeName: ref.nodeName } : {}),
    });
  }
  const removed: string[] = [];
  for (const image of current) {
    if (listed.has(image.id)) continue;
    if (!image.nodeId && (pending.addedImages.has(image.id) || !image.synced)) {
      images.push(image);
      continue;
    }
    removed.push(image.id);
  }
  return { images, removed };
}
