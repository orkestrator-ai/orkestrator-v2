import { createHash } from "node:crypto";

import { isTicketSections, normalizeTicketContent } from "@orkestrator/protocol/ticket-sections";
import { parseTicketSyncItem, ticketUpdatedAt } from "@orkestrator/protocol/ticket-sync";
import { createLogger } from "@orkestrator/protocol/logger";

import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import {
  emptyKanbanSyncStore,
  imageRef,
  parseKanbanSyncStore,
  stampTicketChange,
  ticketSnapshot,
  touchTicket,
  type KanbanSyncStore,
} from "./storage-kanban-sync.js";
import { fs, nowIso, type KanbanTask } from "./storage-shared.js";

const log = createLogger("storage");

/**
 * A stored row as current content. Legacy rows get their kind and sections
 * derived on read; nothing is written back until the ticket is next changed,
 * so this is the migration and it never loses or rewrites text. Results a
 * hand-ticked legacy box records are dated with the ticket's creation, so
 * repeated reads return the same row. A row without `updatedAt` (written
 * before it existed) reads as last updated when it was created.
 */
export function normalizeKanbanTask(task: KanbanTask): KanbanTask {
  // Rows from before v2.34.2-beta (or synced from such a node) carry no
  // sections. Once the floor passes, this becomes a one-time record upgrade;
  // the `sectionsBasis` check below stays (to-do 7570 task 2).
  if (!isTicketSections(task.sections)) compatibilityPathUsage.record("kanban.legacy-row-derived");
  const content = normalizeTicketContent(task, { now: task.createdAt });
  return { ...task, ...content, updatedAt: ticketUpdatedAt(task) };
}

/**
 * The Kanban board's shared store access: its lease, its reads, and the one
 * commit that saves the board with the sync store. `KanbanRepository` (the
 * board) and `KanbanSyncRepository` (sync across machines) both hold this
 * one instance, so every board write takes the same lease and every local
 * change is stamped for sync the same way.
 */
export class KanbanBoardStore {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  /**
   * Serializes the complete Kanban read-modify-write transaction both within
   * this service instance and across backend processes sharing the data
   * directory. Background PR reconciliation and foreground edits otherwise
   * risk saving independent stale snapshots over each other.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.kanbanFile(), "Kanban storage", operation);
  }

  /** Every board's rows, as stored. */
  loadTasks(): Promise<KanbanTask[]> {
    return this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
  }

  /** One project's rows, normalized; indexed, so it reads one board without parsing every project's. */
  projectTasks(projectId: string): KanbanTask[] {
    const tasks = this.context.loadStoreRowsByOwner<KanbanTask>(this.files.kanbanFile(), projectId);
    return tasks.filter((task) => task.projectId === projectId).map(normalizeKanbanTask);
  }

  /** The sync store, minted (not yet saved) when there is none. */
  async loadSyncStore(): Promise<{ store: KanbanSyncStore; fresh: boolean }> {
    const stored = parseKanbanSyncStore(
      await this.context.loadJson<unknown>(this.files.kanbanSyncFile(), () => null),
    );
    return stored
      ? { store: stored, fresh: false }
      : { store: emptyKanbanSyncStore(), fresh: true };
  }

  /**
   * Saves the board with each change stamped for sync (`storage-kanban-sync.ts`),
   * in one commit with the sync store. Call inside the Kanban lease. Each
   * change names a ticket's row before (null when created) and the row being
   * saved (null when deleted). A leaf's outbox that is full refuses the write.
   * A change to the ticket's content or state also refreshes its `updatedAt`
   * (`touchTicket`); a move within its column does not.
   */
  async commit(
    tasks: KanbanTask[],
    changes: ReadonlyArray<{ before: KanbanTask | null; stored: KanbanTask | null }>,
    loaded?: { store: KanbanSyncStore; fresh: boolean },
  ): Promise<void> {
    const { store, fresh } = loaded ?? (await this.loadSyncStore());
    const sequence = store.nextSeq;
    const now = nowIso();
    let queued = false;
    for (const change of changes) {
      touchTicket({
        before: change.before,
        after: change.stored ? normalizeKanbanTask(change.stored) : null,
        stored: change.stored,
        now,
      });
      const controllers = stampTicketChange(store, {
        before: change.before,
        after: change.stored ? normalizeKanbanTask(change.stored) : null,
        stored: change.stored,
        now,
      });
      // Reject values that peers cannot read before either store is committed.
      if (change.stored) {
        parseTicketSyncItem({
          ...ticketSnapshot(normalizeKanbanTask(change.stored)),
          images: (change.stored.images ?? []).map((image) => imageRef(image)),
        });
      }
      if (controllers.length) queued = true;
    }
    const syncChanged = fresh || queued || store.nextSeq !== sequence || loaded !== undefined;
    await this.context.atomically(async () => {
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      if (syncChanged) await this.context.saveJson(this.files.kanbanSyncFile(), store);
    });
  }

  // A deletion retains only the last publication restriction, not ticket content.
  // Save it before removing the row so Verify can read it without the pipeline lock.
  deletedDeliveryFile(taskId: string): string {
    const key = createHash("sha256").update(taskId).digest("hex");
    return `${this.files.kanbanFile()}.delivery/${key}.json`;
  }

  async removeImageFilesBestEffort(imageIds: string[]): Promise<void> {
    await Promise.all(
      imageIds.map(async (imageId) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await fs.rm(this.files.kanbanImageFile(imageId), { force: true });
            return;
          } catch {
            if (attempt === 1) {
              // The authoritative metadata no longer references this image.
              // Keep the committed mutation successful; after the bounded
              // retries the remaining orphan is safe to remove later.
              log.warn("kanban.image-cleanup-failed");
            }
          }
        }
      }),
    );
  }
}
