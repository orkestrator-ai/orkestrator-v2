import {
  SCHEDULED_JOB_LIMITS,
  scheduleOwnerKey,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
import type { StorageDatabase } from "../storage-database.js";
import { SCHEDULED_JOBS_STORE } from "./layout.js";
import { parseScheduledJob } from "./model.js";

/**
 * Scheduled jobs as rows of the backend database (`scheduled-jobs`), one row
 * per schedule, the row owner being {@link scheduleOwnerKey}.
 *
 * Every write is one {@link StorageDatabase.updateStoreRow} transaction
 * (`BEGIN IMMEDIATE`), the store's only kind of writer. That transaction is
 * what makes a claim exactly-once: SQLite's write lock serializes it across
 * every connection and process, so two backends sharing a data directory
 * cannot both move a fire to running. Mutations are synchronous and never
 * span an `await`. Reads use the uncached row API.
 */

export class ScheduledJobCapacityError extends Error {}

export interface ScheduledJobStoreOptions {
  /** The backend database; called per operation so a reopened connection is used. */
  database: () => StorageDatabase;
  /** Announces a committed change (resource kind `scheduled-job`). */
  announce?: (scheduleId: string) => void;
}

export type JobMutation<T> =
  | { result: T }
  | { result: T; value: ScheduledJob }
  | { result: T; delete: true };

export class ScheduledJobStore {
  constructor(private readonly options: ScheduledJobStoreOptions) {}

  get(id: string): ScheduledJob | null {
    const database = this.options.database();
    if (!database.hasStore(SCHEDULED_JOBS_STORE)) return null;
    const raw = database.rows(SCHEDULED_JOBS_STORE).get(id);
    return raw === undefined ? null : parse(raw);
  }

  list(options: { ownerKey?: string } = {}): ScheduledJob[] {
    const database = this.options.database();
    if (!database.hasStore(SCHEDULED_JOBS_STORE)) return [];
    const entries = database
      .rows(SCHEDULED_JOBS_STORE)
      .list({ values: true, ...(options.ownerKey ? { owner: options.ownerKey } : {}) });
    const jobs: ScheduledJob[] = [];
    for (const entry of entries) {
      const job = entry.value === null ? null : parse(entry.value);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * One row's read-modify-write. `mutate` sees the committed value (null when
   * absent) and must be synchronous. Inserts are checked against the store
   * and per-owner bounds inside the same transaction.
   */
  mutate<T>(id: string, mutate: (current: ScheduledJob | null) => JobMutation<T>): T {
    let changed = false;
    const result = this.options
      .database()
      .updateStoreRow<T>(SCHEDULED_JOBS_STORE, id, (current) => {
        const existing = current === undefined ? null : parseScheduledJob(current);
        const update = mutate(existing);
        if ("delete" in update) {
          if (current === undefined) return { result: update.result };
          changed = true;
          return { result: update.result, delete: true };
        }
        if (!("value" in update)) return { result: update.result };
        if (!existing) this.assertCapacity(update.value);
        changed = !existing || existing.revision !== update.value.revision;
        return { result: update.result, value: update.value };
      });
    if (changed) this.options.announce?.(id);
    return result;
  }

  /** Deletes every schedule of one owner; returns the deleted ids. */
  deleteByOwner(ownerKey: string): string[] {
    const database = this.options.database();
    if (!database.hasStore(SCHEDULED_JOBS_STORE)) return [];
    const ids = database
      .rows(SCHEDULED_JOBS_STORE)
      .list({ owner: ownerKey, values: false })
      .map((entry) => entry.key);
    for (const id of ids) this.mutate(id, () => ({ result: undefined, delete: true }));
    return ids;
  }

  private assertCapacity(job: ScheduledJob): void {
    const rows = this.options.database().rows(SCHEDULED_JOBS_STORE);
    const all = rows.list({ values: false });
    if (all.length >= SCHEDULED_JOB_LIMITS.maxSchedules) {
      throw new ScheduledJobCapacityError(
        `At most ${SCHEDULED_JOB_LIMITS.maxSchedules} schedules can exist; delete some first`,
      );
    }
    const ownerKey = scheduleOwnerKey(job.owner);
    if (ownerKey === "operator") return;
    const owned = all.filter((entry) => entry.owner === ownerKey).length;
    if (owned >= SCHEDULED_JOB_LIMITS.maxPerOwner) {
      throw new ScheduledJobCapacityError(
        `This owner already has ${SCHEDULED_JOB_LIMITS.maxPerOwner} schedules; cancel some first`,
      );
    }
  }
}

function parse(raw: string): ScheduledJob | null {
  try {
    return parseScheduledJob(JSON.parse(raw));
  } catch {
    return null;
  }
}
