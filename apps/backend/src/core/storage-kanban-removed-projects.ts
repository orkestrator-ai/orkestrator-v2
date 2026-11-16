import { createLogger } from "@orkestrator/protocol/logger";

import type { KanbanBoardStore } from "./storage-kanban-board.js";
import {
  forgetSyncProject,
  parseKanbanSyncStore,
  type KanbanSyncStore,
} from "./storage-kanban-sync.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import { isRecord, type KanbanTask } from "./storage-shared.js";

const log = createLogger("storage");

/**
 * The ids an owner store holds now, read strictly: throws rather than answer
 * from a missing, unreadable or partial store. Called again inside each
 * lease or transaction that deletes, so a project or pipeline added since an
 * earlier read is seen before anything naming it goes.
 */
export type LiveOwnerIds = () => ReadonlySet<string>;

/**
 * The removed-project sweep did not run because no project is stored (a new
 * install, or every project removed). Nothing was deleted; expected, so the
 * startup pass does not warn about it.
 */
export class NoStoredProjectsError extends Error {
  constructor() {
    super("No project is stored; removed-project sweep refused");
    this.name = "NoStoredProjectsError";
  }
}

/** What one sweep removed, by kind; content-free. */
export interface RemovedProjectSweepResult {
  /** Projects no longer stored that still had rows here. */
  projects: number;
  tickets: number;
  deliveryRecords: number;
  labelCatalogues: number;
  notes: number;
  featurePlans: number;
  completionComments: number;
  /** Steps refused or failed, each logged once by name; their rows stay for the next start. */
  skipped: string[];
}

/**
 * Deletes the rows that projects removed before to-do 5820 left behind
 * (to-do 8111 task 1): their tickets and ticket image files, the delivery
 * records of their deleted tickets, their label catalogues, notes and
 * feature plans, the ticket-sync bookkeeping naming them
 * (`forgetSyncProject`), and the Linear and GitHub completion comment
 * records of pipelines that no longer exist. A row is removed only when its
 * owner is absent from a strict, complete read of the owner store taken
 * inside the same lease or transaction (`liveProjects`, `livePipelines`); a
 * read that throws skips that step and deletes nothing. Every step fails
 * alone and nothing is written when nothing is orphaned.
 *
 * Project removal deletes this content itself since 5820, so on a machine
 * that never removed a project before that change every pass is a read.
 */
export async function sweepRemovedProjectRows(
  deps: {
    context: StorageContext;
    files: StorageFiles;
    board: KanbanBoardStore;
  },
  liveProjects: LiveOwnerIds,
  livePipelines: LiveOwnerIds,
): Promise<RemovedProjectSweepResult> {
  const { context, files, board } = deps;
  const result: RemovedProjectSweepResult = {
    projects: 0,
    tickets: 0,
    deliveryRecords: 0,
    labelCatalogues: 0,
    notes: 0,
    featurePlans: 0,
    completionComments: 0,
    skipped: [],
  };
  const orphanProjects = new Set<string>();
  const step = async (name: string, run: () => Promise<void> | void) => {
    try {
      await run();
    } catch {
      // The step's own message can name a store; the step name is enough.
      result.skipped.push(name);
    }
  };
  /** A store read strictly: absent is empty, unreadable throws. */
  const strictRows = <T>(file: string): T[] => {
    const snapshot = context.loadStoreStrict<unknown>(file);
    if (!snapshot) return [];
    if (!Array.isArray(snapshot.value)) throw new Error("Store is not a list");
    return snapshot.value as T[];
  };
  const orphan = (live: ReadonlySet<string>, owner: unknown): owner is string =>
    typeof owner === "string" && owner !== "" && !live.has(owner);

  await step("tickets", () =>
    board.enqueue(async () => {
      const tasks = strictRows<KanbanTask>(files.kanbanFile());
      const syncSnapshot = context.loadStoreStrict<unknown>(files.kanbanSyncFile());
      const sync = syncSnapshot ? parseKanbanSyncStore(syncSnapshot.value) : null;
      const live = liveProjects();
      const removed = tasks.filter((task) => orphan(live, task?.projectId));
      const kept = tasks.filter((task) => !orphan(live, task?.projectId));
      const syncProjects = sync ? syncProjectIds(sync).filter((id) => orphan(live, id)) : [];
      let syncChanged = false;
      for (const projectId of syncProjects) {
        syncChanged = forgetSyncProject(sync!, projectId) || syncChanged;
      }
      for (const task of removed) orphanProjects.add(task.projectId);
      for (const projectId of syncProjects) orphanProjects.add(projectId);
      if (removed.length || syncChanged) {
        await context.atomically(async () => {
          if (removed.length) {
            await context.saveSensitiveJson(files.kanbanFile(), kept);
            const images = new Map<string, string[]>();
            for (const task of removed) {
              const ids = images.get(task.projectId) ?? [];
              ids.push(...(task.images ?? []).map((image) => image.id));
              images.set(task.projectId, ids);
            }
            for (const [projectId, ids] of images) {
              await board.removal.journalImageDeletions(projectId, ids);
            }
          }
          if (syncChanged) await context.saveSensitiveJson(files.kanbanSyncFile(), sync);
        });
        result.tickets = removed.length;
      }
      // Unlinks the files just journaled; one that fails stays journaled for
      // the next pass or the next removal.
      await board.removal.replayImageDeletions(kept);
      // Delivery records are written under this lease, so the read of the
      // projects store here also covers a ticket deleted a moment ago.
      const sidecars = await board.removal.removeDeliverySidecars((owner) => orphan(live, owner));
      result.deliveryRecords = sidecars.removed;
    }),
  );

  // Keyed by project: one row each, deleted alone, the projects store read
  // again inside the row's transaction so a label created for a project
  // added since the scan is not lost.
  await step("labels", () => {
    const rows = strictRows<{ projectId?: unknown }>(files.kanbanLabelsFile());
    const live = liveProjects();
    for (const row of rows) {
      if (!orphan(live, row?.projectId)) continue;
      const projectId = row.projectId;
      const deleted = context.updateStoreRow<boolean>(
        files.kanbanLabelsFile(),
        projectId,
        (current) =>
          current !== undefined && orphan(liveProjects(), projectId)
            ? { result: true, delete: true }
            : { result: false },
      );
      if (!deleted) continue;
      orphanProjects.add(projectId);
      result.labelCatalogues += 1;
    }
  });

  const sweepList = (file: string, count: (removed: string[]) => void) => () => {
    const rows = strictRows<{ projectId?: unknown }>(file);
    if (!rows.length) return;
    const live = liveProjects();
    if (!rows.some((row) => orphan(live, row?.projectId))) return;
    const removed = context.updateStore(
      file,
      (): Array<{ projectId?: unknown }> => [],
      (current) => {
        if (!Array.isArray(current)) return [];
        const live = liveProjects();
        const gone: string[] = [];
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const owner = current[index]?.projectId;
          if (!orphan(live, owner)) continue;
          current.splice(index, 1);
          gone.push(owner);
        }
        return gone;
      },
      { sensitive: true },
    );
    for (const projectId of removed) orphanProjects.add(projectId);
    count(removed);
  };
  await step(
    "notes",
    sweepList(files.projectNotesFile(), (removed) => {
      result.notes = removed.length;
    }),
  );
  await step(
    "feature-plans",
    sweepList(files.featurePlansFile(), (removed) => {
      result.featurePlans = removed.length;
    }),
  );

  for (const [name, file] of [
    ["linear-completion-comments", files.linearCompletionCommentsFile()],
    ["github-completion-comments", files.githubCompletionCommentsFile()],
  ] as const) {
    await step(name, () => {
      const rows = strictRows<{ pipelineId?: unknown }>(file);
      if (!rows.length) return;
      const live = livePipelines();
      if (!rows.some((row) => orphan(live, row?.pipelineId))) return;
      result.completionComments += context.updateStore(
        file,
        (): Array<{ pipelineId?: unknown }> => [],
        (current) => {
          if (!Array.isArray(current)) return 0;
          const live = livePipelines();
          let count = 0;
          for (let index = current.length - 1; index >= 0; index -= 1) {
            if (!orphan(live, current[index]?.pipelineId)) continue;
            current.splice(index, 1);
            count += 1;
          }
          return count;
        },
        { sensitive: true },
      );
    });
  }

  result.projects = orphanProjects.size;
  if (orphanProjects.size || result.deliveryRecords || result.completionComments) {
    context.scrubDeletedDatabaseContent();
  }
  if (result.skipped.length) {
    log.warn("kanban.removed-project-sweep-skipped", { steps: result.skipped.join(",") });
  }
  return result;
}

/** Every project id the sync store names as this node's own. */
function syncProjectIds(store: KanbanSyncStore): string[] {
  const ids = new Set<string>();
  for (const link of Object.values(store.replicas)) {
    if (isRecord(link) && typeof link.projectId === "string") ids.add(link.projectId);
  }
  for (const tombstone of Object.values(store.tombstones)) {
    if (isRecord(tombstone) && typeof tombstone.projectId === "string") {
      ids.add(tombstone.projectId);
    }
  }
  for (const projectId of Object.keys(store.prunedThrough)) ids.add(projectId);
  for (const peer of Object.values(store.peers)) {
    if (isRecord(peer) && isRecord(peer.projects)) {
      for (const projectId of Object.keys(peer.projects)) ids.add(projectId);
    }
  }
  for (const conflict of store.conflicts) {
    if (isRecord(conflict) && typeof conflict.projectId === "string") ids.add(conflict.projectId);
  }
  return [...ids];
}
