import { ScheduledJobStore } from "./scheduled-jobs/store.js";
import type { StorageContext } from "./storage-context.js";

/** Adapts the scheduled-job engine to the shared database and change journal. */
export class ScheduledJobsRepository {
  private storeInstance: ScheduledJobStore | null = null;

  constructor(private readonly context: StorageContext) {}

  store(): ScheduledJobStore {
    this.storeInstance ??= new ScheduledJobStore({
      database: () => this.context.database,
      announce: (scheduleId) => this.context.changes.announce("scheduled-job", scheduleId),
    });
    return this.storeInstance;
  }
}
