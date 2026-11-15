import path from "node:path";

import { createLogger } from "@orkestrator/protocol/logger";

import type { StorageContext } from "./storage-context.js";
import { clearDeletion, deletionMarker, markDeletion } from "./storage-deletion-fences.js";
import type { StorageFiles } from "./storage-files.js";
import { fs, isCanonicalUuid, nowIso, type KanbanTask } from "./storage-shared.js";

/**
 * What project removal needs beyond deleting rows (to-do 5820): a fence that
 * stops new content reaching a project being removed, a journal of the ticket
 * image files it still has to unlink, and the deleted-ticket delivery
 * sidecars it has to find. `KanbanRepository.deleteProjectContent` and
 * `ProjectsRepository.removeProject` use these.
 */

const log = createLogger("storage");

/** Scope of a project's content fence in `storage-deletion-fences`. */
const PROJECT_CONTENT_SCOPE = "project-content";

/** Content-free journal of image files a removal still has to unlink, keyed by image id. */
const IMAGE_DELETIONS_STORE = "kanban-image-deletions.json";

interface PendingImageDeletion {
  projectId: string;
  requestedAt: string;
}

/**
 * Fences a project's content before removal deletes it. Every writer that
 * creates content for a project (tickets, ticket sync, labels, notes, feature
 * plans) checks the fence under its own lease or transaction, so a write
 * racing the removal either lands before the deletion takes that lease (and
 * is deleted with the rest) or is refused. The fence is a content-free
 * tombstone that outlives the removal; project ids are never reused.
 */
export function fenceProjectContent(context: StorageContext, projectId: string): void {
  context.database.transaction(() =>
    markDeletion(context.database, PROJECT_CONTENT_SCOPE, projectId),
  );
}

/** Lifts the fence of a removal that failed and kept the project, so it stays usable. */
export function releaseProjectContentFence(context: StorageContext, projectId: string): void {
  context.database.transaction(() =>
    clearDeletion(context.database, PROJECT_CONTENT_SCOPE, projectId),
  );
}

export function projectContentFenced(context: StorageContext, projectId: string): boolean {
  return deletionMarker(context.database, PROJECT_CONTENT_SCOPE, projectId) > 0;
}

/** Refuses a write that would create content for a project being removed. */
export function assertProjectAcceptsContent(context: StorageContext, projectId: string): void {
  if (projectContentFenced(context, projectId)) {
    throw new Error(`Project is being removed: ${projectId}`);
  }
}

function imageDeletionsFile(context: StorageContext): string {
  return context.file(IMAGE_DELETIONS_STORE);
}

/**
 * Records the image files a removal is about to orphan. Call in the same
 * atomic commit that deletes the tickets naming them, so a failed or
 * interrupted unlink can still be found once the tickets are gone.
 */
export function journalImageDeletions(
  context: StorageContext,
  projectId: string,
  imageIds: readonly string[],
): void {
  const ids = imageIds.filter(isCanonicalUuid);
  if (!ids.length) return;
  const requestedAt = nowIso();
  context.updateStore(
    imageDeletionsFile(context),
    (): Record<string, PendingImageDeletion> => ({}),
    (pending) => {
      for (const id of ids) pending[id] = { projectId, requestedAt };
    },
  );
}

/**
 * Unlinks every journaled image file, then drops the entries it finished.
 * Call inside the Kanban lease, so no ticket can gain one of these images
 * between the check and the unlink. An image a live ticket names again (a
 * sync copy) is kept and its entry dropped. Returns how many unlinks failed;
 * their entries stay for the next attempt, across restarts.
 */
export async function replayImageDeletions(
  context: StorageContext,
  files: StorageFiles,
  tasks: readonly KanbanTask[],
): Promise<number> {
  const file = imageDeletionsFile(context);
  const pending = await context.loadJson<Record<string, PendingImageDeletion>>(file, () => ({}));
  const ids = Object.keys(pending);
  if (!ids.length) return 0;
  const referenced = new Set(tasks.flatMap((task) => (task.images ?? []).map((image) => image.id)));
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
        await fs.rm(files.kanbanImageFile(id), { force: true });
        removed = true;
      } catch {
        // Retried once here; the entry stays for the next attempt.
      }
    }
    if (removed) settled.push(id);
    else failed += 1;
  }
  if (settled.length) {
    context.updateStore(
      file,
      (): Record<string, PendingImageDeletion> => ({}),
      (current) => {
        for (const id of settled) delete current[id];
      },
    );
  }
  if (failed) log.warn("kanban.removal-image-cleanup-pending");
  return failed;
}

/**
 * Deletes the delivery sidecars (`KanbanBoardStore.deletedDeliveryFile`)
 * of this project's deleted tickets, with their backup ladders. A sidecar is
 * named by a hash of its ticket id, so each is read to find its project; one
 * that cannot be read is left alone. Returns how many could not be removed.
 */
export async function removeDeliverySidecars(
  context: StorageContext,
  files: StorageFiles,
  projectId: string,
): Promise<number> {
  const directory = `${files.kanbanFile()}.delivery`;
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const primaries = new Set(
    entries
      .map((entry) => /^([0-9a-f]{64})\.json/.exec(entry)?.[1])
      .filter((key): key is string => key !== undefined),
  );
  let failed = 0;
  for (const key of primaries) {
    const sidecar = path.join(directory, `${key}.json`);
    const saved = await context.loadJson<{ projectId?: unknown } | null>(sidecar, () => null);
    if (saved?.projectId !== projectId) continue;
    try {
      await Promise.all(
        [sidecar, ...context.jsonBackupPaths(sidecar)].map((target) =>
          fs.rm(target, { force: true }),
        ),
      );
      await context.deleteStore(sidecar);
    } catch {
      failed += 1;
    }
  }
  if (failed) log.warn("kanban.delivery-sidecar-cleanup-failed");
  return failed;
}
