import { effectiveDeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import {
  TICKET_SYNC_FEATURES,
  isTicketTombstone,
  ticketSyncConflictComment,
  TICKET_SYNC_LIMITS,
  type TicketSyncConflict,
  type TicketSyncField,
  type TicketSyncImageRef,
  type TicketSyncItem,
  type TicketSyncOutboxItem,
  type TicketWorkLocation,
  ticketUpdatedAt,
} from "@orkestrator/protocol/ticket-sync";

import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import { clearKanbanLifecycleOwnership } from "./kanban-merge-closure.js";
import { KanbanBoardStore, normalizeKanbanTask } from "./storage-kanban-board.js";
import {
  acceptsFieldChange,
  assignTicketContent,
  attributeFields,
  mergeSnapshotImages,
  pendingTicketFields,
  recordConflict,
  replicaLinkForProject,
  replicaLinkKey,
  replicaUpdatedAt,
  shareTicket,
  stampTicketChange,
  storedTicketContent,
  ticketContentValue,
  ticketSnapshot,
  ticketSyncConflictId,
  ticketTombstone,
  touchTicket,
} from "./storage-kanban-sync.js";
import {
  fs,
  nowIso,
  randomUUID,
  type KanbanImage,
  type KanbanStatus,
  type KanbanTask,
} from "./storage-shared.js";

/**
 * Kanban sync across machines (docs/architecture/tickets.md, "Sync across
 * machines"): a collaborator of `KanbanRepository` that shares its board
 * store (`KanbanBoardStore`: the Kanban lease, the reads and the commit), so
 * a sync write and a board edit are serialized against each other. Callers
 * reach it as `storage.ticketSync`. The pure rules are in
 * `storage-kanban-sync.ts`.
 */
export class KanbanSyncRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly board: KanbanBoardStore,
  ) {}

  /**
   * Command node: one project's changes after `cursor`, in change order. A
   * cursor from another epoch, or older than a pruned tombstone, gets a full
   * resync (`reset`, with the ids that exist). Rows written before sync existed
   * are stamped on the first read, so every ticket has a place in the order.
   */
  async ticketSyncChangesSince(
    projectId: string,
    cursor: number,
    epoch: string | undefined,
    limit: number = TICKET_SYNC_LIMITS.maxBatchItems,
    /** This node's id: with it, snapshots carry image references (`ticketSnapshot`). */
    selfId?: string,
  ): Promise<{
    epoch: string;
    items: TicketSyncItem[];
    cursor: number;
    more: boolean;
    reset: boolean;
    liveIds?: string[];
  }> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const loaded = await this.board.loadSyncStore();
      const { store } = loaded;
      const own = tasks.filter((task) => task.projectId === projectId && !task.sync?.replica);
      const unstamped = own.filter((task) => !task.sync);
      for (const task of unstamped) {
        const seq = store.nextSeq;
        store.nextSeq += 1;
        task.sync = { seq, revs: { title: seq, content: seq, status: seq } };
      }
      if (unstamped.length || loaded.fresh) {
        await this.context.atomically(async () => {
          if (unstamped.length) await this.context.saveJson(this.files.kanbanFile(), tasks);
          await this.context.saveJson(this.files.kanbanSyncFile(), store);
        });
      }
      const reset = epoch !== store.epoch || cursor < (store.prunedThrough[projectId] ?? 0);
      const from = reset ? 0 : cursor;
      const items: TicketSyncItem[] = [
        ...own
          .filter((task) => (task.sync?.seq ?? 0) > from)
          .map((task) => ticketSnapshot(normalizeKanbanTask(task), selfId)),
        ...(reset
          ? []
          : Object.entries(store.tombstones)
              .filter(([, tombstone]) => tombstone.projectId === projectId && tombstone.seq > from)
              .map(([id, tombstone]) => ticketTombstone(id, tombstone))),
      ].sort((left, right) => left.seq - right.seq);
      const page = items.slice(0, Math.max(1, limit));
      return {
        epoch: store.epoch,
        items: page,
        cursor: page.at(-1)?.seq ?? from,
        more: items.length > page.length,
        reset,
        ...(reset ? { liveIds: own.map((task) => task.id) } : {}),
      };
    });
  }

  /**
   * Leaf: applies a command node's snapshots and tombstones to this node's
   * copy of the project. A field with a change still queued here keeps the
   * local value until the command node has decided it; a ticket deleted here
   * is not brought back. Returns the cursor to resume from.
   */
  async applyTicketSync(input: {
    controllerId: string;
    projectId: string;
    sourceProjectId: string;
    epoch: string;
    items: readonly TicketSyncItem[];
    cursor: number;
    reset?: boolean;
    liveIds?: readonly string[];
  }): Promise<{ cursor: number; applied: number }> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const { store } = await this.board.loadSyncStore();
      const key = replicaLinkKey(input.controllerId, input.projectId);
      const other = Object.values(store.replicas).find(
        (link) =>
          link.controllerId === input.controllerId &&
          link.sourceProjectId === input.sourceProjectId &&
          link.projectId !== input.projectId,
      );
      if (other) {
        throw new Error(
          "That command node's tickets for this repository already sync into another project here.",
        );
      }
      const now = nowIso();
      const removedImages: string[] = [];
      let applied = 0;
      let next = tasks;
      const ofThisController = (task: KanbanTask) =>
        task.projectId === input.projectId &&
        task.sync?.replica?.controllerId === input.controllerId;
      if (input.reset && input.liveIds) {
        const live = new Set(input.liveIds);
        next = next.filter((task) => {
          const gone =
            ofThisController(task) && !task.sync?.replica?.pendingCreate && !live.has(task.id);
          if (gone) removedImages.push(...task.images.map((image) => image.id));
          return !gone;
        });
        if (next.length !== tasks.length) applied += tasks.length - next.length;
      }
      const orderIn = (status: KanbanStatus, except?: string) =>
        Math.max(
          -1,
          ...next
            .filter(
              (candidate) =>
                candidate.projectId === input.projectId &&
                candidate.status === status &&
                candidate.id !== except,
            )
            .map((candidate) => candidate.order),
        ) + 1;
      for (const item of input.items) {
        const index = next.findIndex((task) => task.id === item.id);
        const row = index >= 0 ? next[index]! : null;
        // An id that is another project's here, or another command node's copy.
        if (row && row.projectId !== input.projectId)
          throw new Error("Ticket sync id belongs to another project.");
        if (row?.sync?.replica && row.sync.replica.controllerId !== input.controllerId)
          throw new Error("Ticket sync id belongs to another controller.");
        if (isTicketTombstone(item)) {
          if (row) {
            removedImages.push(...row.images.map((image) => image.id));
            next = next.filter((task) => task.id !== item.id);
            applied += 1;
          }
          const seq = store.nextSeq;
          store.nextSeq += 1;
          store.tombstones[item.id] = { projectId: input.projectId, seq, deletedAt: now };
          continue;
        }
        const pending = pendingTicketFields(store, input.controllerId, item.id);
        if (store.tombstones[item.id] || pending.deleted) continue;
        const replica = {
          controllerId: input.controllerId,
          sourceProjectId: input.sourceProjectId,
          seq: item.seq,
          revs: item.revs,
        };
        const content = {
          description: item.description,
          acceptanceCriteria: item.acceptanceCriteria,
          ...(item.kind !== undefined ? { kind: item.kind } : {}),
          ...(item.sections !== undefined ? { sections: item.sections } : {}),
          ...(item.sectionsBasis !== undefined ? { sectionsBasis: item.sectionsBasis } : {}),
          ...(item.labels !== undefined ? { labels: item.labels } : {}),
        };
        if (!row) {
          next = [
            ...next,
            {
              id: item.id,
              projectId: input.projectId,
              title: item.title,
              ...storedTicketContent(content),
              status: item.status,
              ...(item.prMergeDoneUrl ? { prMergeDoneUrl: item.prMergeDoneUrl } : {}),
              comments: item.comments,
              images: mergeSnapshotImages([], item.images, pending, input.controllerId).images,
              createdAt: item.createdAt,
              updatedAt: ticketUpdatedAt(item),
              order: orderIn(item.status),
              prMergeCommented: false,
              sync: {
                seq: 0,
                revs: {},
                replica,
                ...(item.work ? { work: item.work } : {}),
              },
            },
          ];
          applied += 1;
          continue;
        }
        const updated: KanbanTask = { ...row };
        if (!pending.fields.has("title")) updated.title = item.title;
        if (!pending.fields.has("content")) {
          assignTicketContent(updated, content);
        }
        if (!pending.fields.has("status")) {
          if (updated.status !== item.status) {
            updated.status = item.status;
            updated.order = orderIn(item.status, row.id);
            // Moved on the command node: no longer the build lifecycle's column.
            clearKanbanLifecycleOwnership(updated);
          } else if ((item.revs.status ?? 0) > (row.sync?.replica?.revs.status ?? 0)) {
            // The same column with a newer revision: this leaf's own lifecycle
            // move coming back, or someone moving the ticket away and back
            // between two pulls, which is a hand move all the same.
            if (updated.lifecycleEcho) delete updated.lifecycleEcho;
            else clearKanbanLifecycleOwnership(updated);
          }
          // Older peers omit the marker; they must not erase one already known.
          if (item.prMergeDoneUrl) updated.prMergeDoneUrl = item.prMergeDoneUrl;
        }
        const authority = new Set(item.comments.map((comment) => comment.id));
        updated.comments = [
          ...item.comments.filter((comment) => !pending.removedComments.has(comment.id)),
          ...row.comments.filter(
            (comment) => pending.addedComments.has(comment.id) && !authority.has(comment.id),
          ),
        ];
        const merged = mergeSnapshotImages(
          row.images ?? [],
          item.images,
          pending,
          input.controllerId,
        );
        updated.images = merged.images;
        removedImages.push(...merged.removed);
        const { work: _work, ...meta } = row.sync ?? { seq: 0, revs: {} };
        updated.sync = { ...meta, replica, ...(item.work ? { work: item.work } : {}) };
        updated.updatedAt = replicaUpdatedAt({
          before: normalizeKanbanTask(row),
          after: normalizeKanbanTask(updated),
          incoming: item.updatedAt,
          pendingLocal: pending.queued,
          now,
        });
        next = next.map((task) => (task.id === row.id ? updated : task));
        applied += 1;
      }
      const link = store.replicas[key];
      store.replicas[key] = {
        controllerId: input.controllerId,
        projectId: input.projectId,
        sourceProjectId: input.sourceProjectId,
        sourceEpoch: input.epoch,
        cursor:
          input.reset || !link || link.sourceEpoch !== input.epoch
            ? input.cursor
            : Math.max(link.cursor, input.cursor),
        appliedAt: now,
      };
      await this.context.atomically(async () => {
        if (applied) await this.context.saveJson(this.files.kanbanFile(), next);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      if (applied) this.context.changes.announce("kanban", input.projectId);
      await this.board.removeImageFilesBestEffort(removedImages);
      return { cursor: store.replicas[key]!.cursor, applied };
    });
  }

  /** Leaf: where a command node's sync of this project stands, in that command node's epoch. */
  async getTicketSyncCursor(
    controllerId: string,
    projectId: string,
  ): Promise<{ cursor: number; epoch?: string; pending: number }> {
    const { store } = await this.board.loadSyncStore();
    const link = store.replicas[replicaLinkKey(controllerId, projectId)];
    return {
      cursor: link?.cursor ?? 0,
      ...(link ? { epoch: link.sourceEpoch } : {}),
      pending: store.outbox[controllerId]?.items.length ?? 0,
    };
  }

  /**
   * Leaf: queued changes for a command node after `after`, oldest first.
   * `features` is what the command node declared it can apply
   * (`TICKET_SYNC_FEATURES`); it is recorded so later changes it could not
   * read are not queued for it. An older command node declares none.
   */
  async collectTicketSyncOutbox(
    controllerId: string,
    after: number,
    limit: number = TICKET_SYNC_LIMITS.maxCollectItems,
    features?: readonly string[],
  ): Promise<{ epoch: string | null; items: TicketSyncOutboxItem[]; more: boolean }> {
    if (features !== undefined) await this.recordControllerFeatures(controllerId, features);
    const { store } = await this.board.loadSyncStore();
    const outbox = store.outbox[controllerId];
    if (!outbox) return { epoch: null, items: [], more: false };
    const waiting = outbox.items.filter((item) => item.seq > after);
    return {
      epoch: outbox.epoch,
      items: waiting.slice(0, limit),
      more: waiting.length > limit,
    };
  }

  private async recordControllerFeatures(
    controllerId: string,
    features: readonly string[],
  ): Promise<void> {
    const known = new Set<string>(Object.values(TICKET_SYNC_FEATURES));
    const declared = [...new Set(features.filter((feature) => known.has(feature)))].sort();
    const { store: current } = await this.board.loadSyncStore();
    if (JSON.stringify(current.features[controllerId] ?? []) === JSON.stringify(declared)) return;
    await this.board.enqueue(async () => {
      const { store } = await this.board.loadSyncStore();
      if (declared.length) store.features[controllerId] = declared;
      else delete store.features[controllerId];
      await this.context.saveJson(this.files.kanbanSyncFile(), store);
    });
  }

  /** Leaf: the command node applied everything up to `upTo` in this epoch. */
  async ackTicketSyncOutbox(
    controllerId: string,
    epoch: string,
    upTo: number,
  ): Promise<{ remaining: number }> {
    return this.board.enqueue(async () => {
      const { store } = await this.board.loadSyncStore();
      const outbox = store.outbox[controllerId];
      if (!outbox || outbox.epoch !== epoch) return { remaining: outbox?.items.length ?? 0 };
      const remaining = outbox.items.filter((item) => item.seq > upTo);
      if (remaining.length !== outbox.items.length) {
        outbox.items = remaining;
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      }
      return { remaining: remaining.length };
    });
  }

  /** Leaf: the command nodes with changes waiting for them. */
  async ticketSyncOutboxControllers(): Promise<string[]> {
    const { store } = await this.board.loadSyncStore();
    return Object.entries(store.outbox)
      .filter(([, outbox]) => outbox.items.length > 0)
      .map(([controllerId]) => controllerId);
  }

  /**
   * Leaf: a command node detached. Its copies become this node's own tickets,
   * keeping what they say now, and nothing more is queued for it.
   */
  async forgetTicketSyncController(controllerId: string): Promise<void> {
    await this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const { store, fresh } = await this.board.loadSyncStore();
      if (fresh) return;
      let changed = false;
      for (const task of tasks) {
        if (task.sync?.replica?.controllerId !== controllerId) continue;
        const { replica: _replica, work: _work, ...meta } = task.sync;
        task.sync = meta;
        changed = true;
      }
      const links = Object.keys(store.replicas).filter(
        (key) => store.replicas[key]!.controllerId === controllerId,
      );
      if (!changed && !links.length && !store.outbox[controllerId] && !store.features[controllerId])
        return;
      for (const key of links) delete store.replicas[key];
      delete store.outbox[controllerId];
      delete store.features[controllerId];
      await this.context.atomically(async () => {
        if (changed) await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      if (changed) {
        for (const projectId of new Set(tasks.map((task) => task.projectId))) {
          this.context.changes.announce("kanban", projectId);
        }
      }
    });
  }

  /**
   * Command node: applies a leaf's queued changes in order, each once (its
   * outbox epoch and seq), under the rules of `storage-kanban-sync.ts`. A
   * change that loses is recorded as a conflict and, when the ticket still
   * exists, as a comment on it.
   */
  async applyTicketSyncOps(input: {
    nodeId: string;
    nodeName?: string;
    epoch: string;
    items: readonly TicketSyncOutboxItem[];
  }): Promise<{ appliedSeq: number; applied: number; conflicts: TicketSyncConflict[] }> {
    return this.board.enqueue(async () => {
      let tasks = await this.board.loadTasks();
      const loaded = await this.board.loadSyncStore();
      const { store } = loaded;
      const existing = store.peers[input.nodeId];
      const peer =
        existing && existing.outboxEpoch === input.epoch
          ? { ...existing }
          : { outboxEpoch: input.epoch, appliedSeq: 0, projects: existing?.projects ?? {} };
      const now = nowIso();
      const changes = new Map<string, { before: KanbanTask | null; stored: KanbanTask | null }>();
      // A ticket this batch creates, as its creation brought it: a later op in
      // the same batch that edits it is an update (`touchTicket`).
      const createdAs = new Map<string, KanbanTask>();
      const attributed = new Map<string, Set<TicketSyncField>>();
      const workChanged = new Set<string>();
      const conflicts: TicketSyncConflict[] = [];
      const removedImages: string[] = [];
      let applied = 0;
      const track = (row: KanbanTask) => {
        if (!changes.has(row.id)) {
          changes.set(row.id, { before: normalizeKanbanTask(structuredClone(row)), stored: row });
        }
      };
      const attribute = (id: string, field: TicketSyncField) => {
        const fields = attributed.get(id) ?? new Set<TicketSyncField>();
        fields.add(field);
        attributed.set(id, fields);
      };
      const orderIn = (projectId: string, status: KanbanStatus, except?: string) =>
        Math.max(
          -1,
          ...tasks
            .filter(
              (candidate) =>
                candidate.projectId === projectId &&
                candidate.status === status &&
                candidate.id !== except,
            )
            .map((candidate) => candidate.order),
        ) + 1;
      const conflict = (
        item: TicketSyncOutboxItem,
        field: TicketSyncConflict["field"],
        reason: TicketSyncConflict["reason"],
        value: unknown,
        row?: KanbanTask,
      ) => {
        const recorded = recordConflict(store, {
          at: now,
          ticketId: item.ticketId,
          projectId: item.sourceProjectId,
          fromNodeId: input.nodeId,
          ...(input.nodeName ? { fromNodeName: input.nodeName } : {}),
          field,
          reason,
          value,
        });
        conflicts.push(recorded);
        if (row) {
          track(row);
          row.comments = [
            ...row.comments,
            { id: randomUUID(), text: ticketSyncConflictComment(recorded), createdAt: now },
          ];
        }
      };
      // A leaf sends only its own images: their bytes are on that leaf.
      const leafImage = (image: TicketSyncImageRef): KanbanImage => ({
        id: image.id,
        filename: image.filename,
        createdAt: image.createdAt,
        nodeId: input.nodeId,
        ...(input.nodeName ? { nodeName: input.nodeName } : {}),
      });
      const items = [...input.items].sort((left, right) => left.seq - right.seq);
      for (const item of items) {
        if (item.seq <= peer.appliedSeq) continue;
        peer.appliedSeq = item.seq;
        applied += 1;
        const op = item.op;
        const row =
          tasks.find(
            (task) =>
              task.id === item.ticketId &&
              task.projectId === item.sourceProjectId &&
              !task.sync?.replica,
          ) ?? null;
        const deleted = Boolean(store.tombstones[item.ticketId]);
        if (op.kind === "create") {
          if (row) continue;
          if (deleted || tasks.some((task) => task.id === item.ticketId)) {
            conflict(item, "ticket", "ticket-deleted", op.ticket.title);
            continue;
          }
          const created: KanbanTask = {
            id: item.ticketId,
            projectId: item.sourceProjectId,
            title: op.ticket.title,
            ...storedTicketContent(ticketContentValue({ ...op.ticket } as KanbanTask)),
            status: op.ticket.status,
            ...(op.ticket.prMergeDoneUrl ? { prMergeDoneUrl: op.ticket.prMergeDoneUrl } : {}),
            comments: op.ticket.comments,
            images: (op.ticket.images ?? []).map((image) => leafImage(image)),
            createdAt: op.ticket.createdAt,
            updatedAt: ticketUpdatedAt(op.ticket),
            order: orderIn(item.sourceProjectId, op.ticket.status),
            prMergeCommented: false,
          };
          tasks = [...tasks, created];
          changes.set(created.id, { before: null, stored: created });
          createdAs.set(created.id, normalizeKanbanTask(structuredClone(created)));
          for (const field of ["title", "content", "status"] as const) attribute(created.id, field);
          continue;
        }
        if (!row) {
          if (deleted && op.kind !== "delete") conflict(item, "ticket", "ticket-deleted", op);
          continue;
        }
        switch (op.kind) {
          case "set-title":
          case "set-content":
          case "set-status": {
            const field: TicketSyncField =
              op.kind === "set-title" ? "title" : op.kind === "set-content" ? "content" : "status";
            const current =
              field === "title"
                ? row.title
                : field === "status"
                  ? row.status
                  : ticketContentValue(normalizeKanbanTask(row));
            const incoming = op.value;
            // A leaf that predates labels sends none; its change leaves them alone.
            if (op.kind === "set-content" && op.value.labels === undefined) {
              delete (current as { labels?: string[] }).labels;
            }
            const mergeChanged =
              op.kind === "set-status" &&
              op.prMergeDoneUrl !== undefined &&
              row.prMergeDoneUrl !== op.prMergeDoneUrl;
            if (JSON.stringify(current) === JSON.stringify(incoming) && !mergeChanged) break;
            if (!acceptsFieldChange(row.sync, field, op.baseRev, input.nodeId)) {
              conflict(
                item,
                field,
                "stale-revision",
                op.kind === "set-content" ? op.value.description : op.value,
                row,
              );
              break;
            }
            track(row);
            if (op.kind === "set-title") row.title = op.value;
            if (op.kind === "set-status") {
              if (row.status !== op.value) {
                row.order = orderIn(row.projectId, op.value, row.id);
                // A leaf's move, whatever made it, is not this node's lifecycle.
                clearKanbanLifecycleOwnership(row);
              }
              row.status = op.value;
              if (op.prMergeDoneUrl) row.prMergeDoneUrl = op.prMergeDoneUrl;
            }
            if (op.kind === "set-content") {
              assignTicketContent(row, op.value);
            }
            attribute(row.id, field);
            break;
          }
          case "checks": {
            const normalized = normalizeKanbanTask(row);
            let changed = false;
            const criteria = (normalized.sections?.acceptanceCriteria ?? []).map((criterion) => {
              const result = op.checks.find(
                (check) => check.id === criterion.id && check.text === criterion.text,
              );
              if (!result) return criterion;
              changed = true;
              return { ...criterion, check: result.check };
            });
            if (!changed) break;
            track(row);
            assignTicketContent(row, ticketContentValue(normalized));
            row.sections = { ...normalized.sections, acceptanceCriteria: criteria };
            break;
          }
          case "add-comment":
            if (row.comments.some((comment) => comment.id === op.comment.id)) break;
            track(row);
            row.comments = [...row.comments, op.comment];
            break;
          case "delete-comment":
            if (!row.comments.some((comment) => comment.id === op.commentId)) break;
            track(row);
            row.comments = row.comments.filter((comment) => comment.id !== op.commentId);
            break;
          case "add-image":
            if ((row.images ?? []).some((image) => image.id === op.image.id)) break;
            track(row);
            row.images = [...(row.images ?? []), leafImage(op.image)];
            break;
          case "delete-image": {
            const image = (row.images ?? []).find((candidate) => candidate.id === op.imageId);
            if (!image) break;
            track(row);
            row.images = row.images.filter((candidate) => candidate.id !== op.imageId);
            // This machine's bytes, or its cached copy of another machine's.
            removedImages.push(image.id);
            break;
          }
          case "work": {
            track(row);
            const meta = row.sync ?? { seq: 0, revs: {} };
            const hasWork = Object.keys(op.work).length > 0;
            if (hasWork) {
              row.sync = {
                ...meta,
                work: {
                  nodeId: input.nodeId,
                  ...(input.nodeName ? { nodeName: input.nodeName } : {}),
                  ...op.work,
                  updatedAt: now,
                },
              };
            } else if (meta.work?.nodeId === input.nodeId) {
              const { work: _work, ...rest } = meta;
              row.sync = rest;
            }
            workChanged.add(row.id);
            break;
          }
          case "delete": {
            const before = changes.get(row.id)?.before ?? normalizeKanbanTask(structuredClone(row));
            await this.context.saveJson(this.board.deletedDeliveryFile(row.id), {
              projectId: row.projectId,
              policy: effectiveDeliveryPolicy(normalizeKanbanTask(row).sections?.delivery?.policy),
            });
            tasks = tasks.filter((task) => task !== row);
            changes.set(row.id, { before, stored: null });
            removedImages.push(...row.images.map((image) => image.id));
            break;
          }
        }
      }
      store.peers[input.nodeId] = peer;
      const stamp = nowIso();
      for (const change of changes.values()) {
        const seqBefore = change.stored?.sync?.seq;
        touchTicket({
          // A creation keeps the leaf's time unless this batch also edited it.
          before: change.before ?? (change.stored ? createdAs.get(change.stored.id) : null) ?? null,
          after: change.stored ? normalizeKanbanTask(change.stored) : null,
          stored: change.stored,
          now: stamp,
        });
        // Where its build runs is on the ticket too (`TicketWorkLocation`).
        if (change.stored && workChanged.has(change.stored.id)) change.stored.updatedAt = stamp;
        stampTicketChange(store, {
          before: change.before,
          after: change.stored ? normalizeKanbanTask(change.stored) : null,
          stored: change.stored,
          now: stamp,
        });
        if (!change.stored) continue;
        attributeFields(change.stored, [...(attributed.get(change.stored.id) ?? [])], input.nodeId);
        // Work on another machine is shown everywhere, so it is a synced change here.
        if (workChanged.has(change.stored.id) && change.stored.sync?.seq === seqBefore) {
          change.stored.sync = {
            ...(change.stored.sync ?? { revs: {} }),
            seq: store.nextSeq,
          } as KanbanTask["sync"];
          store.nextSeq += 1;
        }
      }
      await this.context.atomically(async () => {
        if (changes.size) await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      for (const projectId of new Set(items.map((item) => item.sourceProjectId))) {
        if (changes.size) this.context.changes.announce("kanban", projectId);
      }
      await this.board.removeImageFilesBestEffort(removedImages);
      return { appliedSeq: peer.appliedSeq, applied, conflicts };
    });
  }

  /** Command node: what a leaf confirmed for one of this node's projects. */
  async recordTicketSyncPeer(
    nodeId: string,
    projectId: string,
    leafProjectId: string,
    cursor: number,
  ): Promise<void> {
    await this.board.enqueue(async () => {
      const { store } = await this.board.loadSyncStore();
      const peer = store.peers[nodeId] ?? { appliedSeq: 0, projects: {} };
      const previous = peer.projects[projectId];
      if (previous && previous.cursor === cursor && previous.leafProjectId === leafProjectId) {
        // Only the time moved; keep writes to real progress.
        previous.syncedAt = nowIso();
      } else {
        peer.projects = {
          ...peer.projects,
          [projectId]: { leafProjectId, cursor, syncedAt: nowIso() },
        };
      }
      store.peers[nodeId] = peer;
      await this.context.saveJson(this.files.kanbanSyncFile(), store);
    });
  }

  /** Command node: the inputs of one project's sync status. */
  async getTicketSyncOverview(projectId: string): Promise<{
    latestSeq: number;
    peers: Array<{ nodeId: string; leafProjectId: string; cursor: number; syncedAt?: string }>;
    conflicts: TicketSyncConflict[];
    knownNodes: string[];
  }> {
    const tasks = this.board.projectTasks(projectId);
    const { store } = await this.board.loadSyncStore();
    const latestSeq = Math.max(
      0,
      ...tasks.filter((task) => !task.sync?.replica).map((task) => task.sync?.seq ?? 0),
      ...Object.values(store.tombstones)
        .filter((tombstone) => tombstone.projectId === projectId)
        .map((tombstone) => tombstone.seq),
    );
    return {
      latestSeq,
      peers: Object.entries(store.peers).flatMap(([nodeId, peer]) => {
        const project = peer.projects[projectId];
        return project ? [{ nodeId, ...project }] : [];
      }),
      conflicts: store.conflicts
        .filter((conflict) => conflict.projectId === projectId)
        .map((conflict) => ({ ...conflict, id: ticketSyncConflictId(conflict) })),
      knownNodes: Object.keys(store.peers),
    };
  }

  /**
   * Command node: a ticket's work started on another machine. The leaf will
   * report its own progress; this shows where it runs at once.
   */
  async recordTicketRemoteWork(taskId: string, work: TicketWorkLocation): Promise<KanbanTask> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const task = tasks.find((candidate) => candidate.id === taskId && !candidate.sync?.replica);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      const { store } = await this.board.loadSyncStore();
      const seq = store.nextSeq;
      store.nextSeq += 1;
      task.sync = { ...(task.sync ?? { revs: {} }), seq, work } as KanbanTask["sync"];
      // Where its build runs is on the ticket, like its own build links.
      task.updatedAt = nowIso();
      await this.context.atomically(async () => {
        await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  /**
   * Command node: removes conflicts from the project's list (`ids`, or all of
   * them). The comments they left on tickets stay.
   */
  async dismissTicketSyncConflicts(
    projectId: string,
    ids?: readonly string[],
  ): Promise<{ dismissed: number; remaining: number }> {
    return this.board.enqueue(async () => {
      const { store, fresh } = await this.board.loadSyncStore();
      if (fresh) return { dismissed: 0, remaining: 0 };
      const chosen = ids ? new Set(ids) : null;
      const kept = store.conflicts.filter(
        (conflict) =>
          conflict.projectId !== projectId ||
          (chosen !== null && !chosen.has(ticketSyncConflictId(conflict))),
      );
      const dismissed = store.conflicts.length - kept.length;
      if (dismissed) {
        store.conflicts = kept;
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      }
      return {
        dismissed,
        remaining: kept.filter((conflict) => conflict.projectId === projectId).length,
      };
    });
  }

  /**
   * Leaf: the inputs of a board's sync line here. `links` are the command
   * nodes whose copies this project holds; `unshared` counts the tickets
   * Share would send (made here before sync began, or kept after a command
   * node detached); `linkedProjects` are every project here that a command
   * node syncs, for naming the copy that syncs when this one does not.
   */
  async getTicketSyncLeafOverview(projectId: string): Promise<{
    links: Array<{
      controllerId: string;
      sourceProjectId: string;
      appliedAt: string;
      pending: number;
    }>;
    unshared: number;
    linkedProjects: Array<{ projectId: string; controllerId: string }>;
  }> {
    const { store } = await this.board.loadSyncStore();
    const links = Object.values(store.replicas)
      .filter((link) => link.projectId === projectId)
      .map((link) => ({
        controllerId: link.controllerId,
        sourceProjectId: link.sourceProjectId,
        appliedAt: link.appliedAt,
        pending: store.outbox[link.controllerId]?.items.length ?? 0,
      }));
    const unshared = links.length
      ? this.board.projectTasks(projectId).filter((task) => !task.sync?.replica).length
      : 0;
    return {
      links,
      unshared,
      linkedProjects: Object.values(store.replicas).map((link) => ({
        projectId: link.projectId,
        controllerId: link.controllerId,
      })),
    };
  }

  /**
   * Leaf: sends tickets this board has and its command node does not (made
   * before sync began) to that command node, under their own ids, as a new
   * leaf ticket goes. `taskIds` absent shares them all. Only an explicit
   * action calls this: adopting them on first sync could duplicate tickets a
   * user had already copied by hand, and could not be undone.
   */
  async shareTicketsWithCommandNode(
    projectId: string,
    taskIds?: readonly string[],
  ): Promise<{ shared: number; controllerId: string }> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const loaded = await this.board.loadSyncStore();
      const link = replicaLinkForProject(loaded.store, projectId);
      if (!link) {
        throw new Error(
          "This board is not synced with a command node, so there is nothing to share it with.",
        );
      }
      const chosen = taskIds ? new Set(taskIds) : null;
      const now = nowIso();
      let shared = 0;
      for (const task of tasks) {
        if (task.projectId !== projectId || task.sync?.replica) continue;
        if (chosen && !chosen.has(task.id)) continue;
        if (loaded.store.tombstones[task.id]) continue;
        const before = normalizeKanbanTask(structuredClone(task));
        shareTicket(loaded.store, link, before, task, now);
        shared += 1;
      }
      if (!shared) return { shared, controllerId: link.controllerId };
      // The rows changed only their sync marks: no stamp, one commit with the outbox.
      await this.context.atomically(async () => {
        await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), loaded.store);
      });
      this.context.changes.announce("kanban", projectId);
      return { shared, controllerId: link.controllerId };
    });
  }

  /** The row holding an image, with the image. */
  async findTicketImage(imageId: string): Promise<{ task: KanbanTask; image: KanbanImage } | null> {
    for (const task of await this.board.loadTasks()) {
      const image = (task.images ?? []).find((candidate) => candidate.id === imageId);
      if (image) return { task: normalizeKanbanTask(task), image };
    }
    return null;
  }

  /**
   * Leaf: an image's bytes for the command node that asks, when they are here
   * and the image is on a ticket that command node has (a copy of its ticket,
   * or one sent up to it). `null` otherwise.
   */
  async readTicketImageFor(controllerId: string, imageId: string): Promise<string | null> {
    const found = await this.findTicketImage(imageId);
    if (!found || found.image.nodeId) return null;
    if (found.task.sync?.replica?.controllerId !== controllerId) return null;
    try {
      const data = await fs.readFile(this.files.kanbanImageFile(imageId));
      const encoded = data.toString("base64");
      return encoded.length <= TICKET_SYNC_LIMITS.maxImageDataChars ? encoded : null;
    } catch {
      return null;
    }
  }

  /**
   * Keeps a copy of another machine's image here, so it is read over the link
   * once. Only for an image this board references from `fromNodeId` (a leaf
   * whose image a command node read, or the command node that delivered it to
   * a leaf). Returns whether it was stored.
   */
  async storeTicketImageCopy(fromNodeId: string, imageId: string, data: string): Promise<boolean> {
    if (data.length > TICKET_SYNC_LIMITS.maxImageDataChars) return false;
    // Under the lease, so a removal of the image either precedes this check or
    // follows the write and deletes the copy with it.
    return this.board.enqueue(async () => {
      const found = await this.findTicketImage(imageId);
      if (!found?.image.nodeId) return false;
      const from =
        found.task.sync?.replica?.controllerId === fromNodeId || found.image.nodeId === fromNodeId;
      if (!from) return false;
      await fs.mkdir(this.files.kanbanImagesDir(), { recursive: true });
      await fs.writeFile(this.files.kanbanImageFile(imageId), Buffer.from(data, "base64"));
      return true;
    });
  }
}

/**
 * Kanban sync across machines: what callers reach as `storage.ticketSync`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to. Add a method here only when code outside the storage
 * files calls it.
 */
export type TicketSyncStorage = Pick<
  KanbanSyncRepository,
  | "ticketSyncChangesSince"
  | "applyTicketSync"
  | "getTicketSyncCursor"
  | "collectTicketSyncOutbox"
  | "ackTicketSyncOutbox"
  | "ticketSyncOutboxControllers"
  | "forgetTicketSyncController"
  | "applyTicketSyncOps"
  | "recordTicketSyncPeer"
  | "getTicketSyncOverview"
  | "recordTicketRemoteWork"
  | "dismissTicketSyncConflicts"
  | "getTicketSyncLeafOverview"
  | "shareTicketsWithCommandNode"
  | "findTicketImage"
  | "readTicketImageFor"
  | "storeTicketImageCopy"
>;
