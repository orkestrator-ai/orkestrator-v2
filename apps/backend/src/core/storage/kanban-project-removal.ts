import path from "node:path";

import { createLogger } from "@orkestrator/protocol/logger";

import type { StorageContext } from "./context.js";
import { clearDeletion, deletionMarker, markDeletion } from "./deletion-fences.js";
import type { StorageFiles } from "./files.js";
import { fs, isCanonicalUuid, nowIso, type KanbanTask } from "./shared.js";

const log = createLogger("storage");

/** Scope of a project's content fence in `storage-deletion-fences`. */
const PROJECT_CONTENT_SCOPE = "project-content";

interface PendingImageDeletion {
  projectId: string;
  requestedAt: string;
}

/**
 * What project removal needs beyond deleting rows (#2295): a fence that
 * stops new content reaching a project being removed, a journal of the ticket
 * image files it still has to unlink, and the deleted-ticket delivery
 * sidecars it has to find. `KanbanBoardStore` holds the one instance, so the
 * board, ticket sync and the label catalogue share it.
 */
export class KanbanProjectRemovalStore {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  /**
   * Fences a project's content before removal deletes it. Every writer that
   * creates content for a project (tickets, ticket sync, labels, notes,
   * feature plans) checks the fence under its own lease or transaction, so a
   * write racing the removal either lands before the deletion takes that lease
   * (and is deleted with the rest) or is refused. The fence is a content-free
   * tombstone that outlives the removal; project ids are never reused.
   */
  fence(projectId: string): void {
    this.context.database.transaction(() =>
      markDeletion(this.context.database, PROJECT_CONTENT_SCOPE, projectId),
    );
  }

  /** Lifts the fence of a removal that failed and kept the project, so it stays usable. */
  release(projectId: string): void {
    this.context.database.transaction(() =>
      clearDeletion(this.context.database, PROJECT_CONTENT_SCOPE, projectId),
    );
  }

  fenced(projectId: string): boolean {
    return deletionMarker(this.context.database, PROJECT_CONTENT_SCOPE, projectId) > 0;
  }

  /** Refuses a write that would create content for a project being removed. */
  assertAcceptsContent(projectId: string): void {
    if (this.fenced(projectId)) throw new Error(`Project is being removed: ${projectId}`);
  }

  /**
   * Records the image files a removal is about to orphan. Call in the same
   * atomic commit that deletes the tickets naming them, under the Kanban
   * lease (the journal's only writers both hold it), so a failed or
   * interrupted unlink can still be found once the tickets are gone.
   */
  async journalImageDeletions(projectId: string, imageIds: readonly string[]): Promise<void> {
    const ids = imageIds.filter(isCanonicalUuid);
    if (!ids.length) return;
    const pending = await this.loadImageDeletions();
    const requestedAt = nowIso();
    for (const id of ids) pending[id] = { projectId, requestedAt };
    await this.context.saveJson(this.files.kanbanImageDeletionsFile(), pending);
  }

  private loadImageDeletions(): Promise<Record<string, PendingImageDeletion>> {
    return this.context.loadJson<Record<string, PendingImageDeletion>>(
      this.files.kanbanImageDeletionsFile(),
      () => ({}),
    );
  }

  /**
   * Unlinks every journaled image file, then drops the entries it finished.
   * Call inside the Kanban lease, so no ticket can gain one of these images
   * between the check and the unlink. An image a live ticket names again (a
   * sync copy) is kept and its entry dropped. Returns how many unlinks failed;
   * their entries stay for the next attempt, across restarts.
   */
  async replayImageDeletions(tasks: readonly KanbanTask[]): Promise<number> {
    const pending = await this.loadImageDeletions();
    const ids = Object.keys(pending);
    if (!ids.length) return 0;
    const referenced = new Set(
      tasks.flatMap((task) => (task.images ?? []).map((image) => image.id)),
    );
    const settled: string[] = [];
    let failed = 0;
    for (const id of ids) {
      if (!isCanonicalUuid(id) || referenced.has(id)) {
        settled.push(id);
        continue;
      }
      let removed = false;
      for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
        try {
          await fs.rm(this.files.kanbanImageFile(id), { force: true });
          removed = true;
        } catch {
          // Retried once here; the entry stays for the next attempt.
        }
      }
      if (removed) settled.push(id);
      else failed += 1;
    }
    if (settled.length) {
      for (const id of settled) delete pending[id];
      await this.context.saveJson(this.files.kanbanImageDeletionsFile(), pending);
    }
    if (failed) log.warn("kanban.removal-image-cleanup-pending");
    return failed;
  }

  /**
   * Deletes the delivery sidecars (`KanbanBoardStore.deletedDeliveryFile`) of
   * deleted tickets whose project `matches` (one project for a removal, every
   * project no longer stored for the removed-project sweep), with their
   * backup ladders. A sidecar is named by a hash of its ticket id, so each is
   * read to find its project; one that cannot be read is left alone. Returns
   * how many matched, and how many of those could not be removed.
   */
  async removeDeliverySidecars(
    matches: (projectId: unknown) => boolean,
  ): Promise<{ removed: number; failed: number }> {
    const directory = `${this.files.kanbanFile()}.delivery`;
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, failed: 0 };
      throw error;
    }
    const keys = new Set(
      entries
        .map((entry) => /^([0-9a-f]{64})\.json/.exec(entry)?.[1])
        .filter((key): key is string => key !== undefined),
    );
    let removed = 0;
    let failed = 0;
    for (const key of keys) {
      const sidecar = path.join(directory, `${key}.json`);
      // The reader falls back to the backups, so a sidecar whose primary is
      // already gone is still found and its backups removed.
      const saved = await this.context.loadJson<{ projectId?: unknown } | null>(
        sidecar,
        () => null,
      );
      if (!saved || !matches(saved.projectId)) continue;
      try {
        await Promise.all(
          [sidecar, ...this.context.jsonBackupPaths(sidecar)].map((target) =>
            fs.rm(target, { force: true }),
          ),
        );
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed) log.warn("kanban.delivery-sidecar-cleanup-failed");
    return { removed, failed };
  }
}
