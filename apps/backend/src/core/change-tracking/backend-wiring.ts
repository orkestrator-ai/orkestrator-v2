/**
 * Builds the backend's ChangeTrackingService from the application's storage
 * and environment records. Kept apart from `index.ts` so the backend entry
 * only decides *when* tracking starts, not how it is assembled.
 */

import type { BackendEmit } from "../backend-emit.js";
import type { StorageDatabase } from "../storage-database.js";
import { openBackendDatabase } from "../storage-stores.js";
import type { StorageService } from "../storage.js";
import type { DiffStatsTracking } from "../diff-stats-tracking.js";
import { baselineTargetBranch } from "../diff-baseline.js";
import { importOpenCodeCommandJournals } from "./legacy-import.js";
import { openChangeLedgerDatabase } from "./ledger-schema.js";
import { ChangeTrackingService } from "./service.js";
import type { WorktreeTarget } from "./worktree-owner.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("change-tracking");

export function createBackendChangeTracking(input: {
  dataDir: string;
  storage: Pick<StorageService, "getEnvironment" | "loadConfig"> &
    Partial<Pick<StorageService, "loadEnvironmentIdsForCleanup">>;
  emit: BackendEmit;
  /** Pass the scan owner so production cannot omit the explicit-refresh path. */
  diffStats: Pick<DiffStatsTracking, "refreshExplicitly"> & {
    service: Pick<DiffStatsTracking["service"], "refresh">;
  };
}): ChangeTrackingService {
  // The ledger has its own file, change-tracking.sqlite, opened on first use,
  // after storage init.
  let database: StorageDatabase | null = null;
  const service = new ChangeTrackingService({
    dataDir: input.dataDir,
    database: () => {
      if (!database || database.isClosed()) {
        // The main database's migration 7 moves an older ledger into the
        // ledger file, replacing its rows. It must have run before the ledger
        // is first written, so open (and migrate) the main database first.
        openBackendDatabase(input.dataDir).close();
        database = openChangeLedgerDatabase(input.dataDir);
      }
      return database;
    },
    emit: input.emit,
    environmentTarget: async (environmentId): Promise<WorktreeTarget | null> => {
      const environment = await input.storage.getEnvironment(environmentId).catch(() => null);
      if (!environment) return null;
      if (environment.environmentType === "local") {
        return environment.worktreePath
          ? { kind: "local", worktreePath: environment.worktreePath }
          : null;
      }
      return environment.containerId && environment.status === "running"
        ? { kind: "container", containerId: environment.containerId }
        : null;
    },
    requestEnvironmentRefresh: (id) => input.diffStats.service.refresh(id),
    requestExplicitEnvironmentRefresh: (id) => input.diffStats.refreshExplicitly(id),
    // The strict owner read: it throws on a missing or invalid store rather
    // than answer empty, which would request a purge for every environment.
    liveEnvironmentIds: input.storage.loadEnvironmentIdsForCleanup
      ? () => input.storage.loadEnvironmentIdsForCleanup!()
      : undefined,
    prBaseBranch: async (environmentId) => {
      const environment = await input.storage.getEnvironment(environmentId).catch(() => null);
      if (!environment) return null;
      const config = await input.storage.loadConfig().catch(() => null);
      return baselineTargetBranch(environment, config?.repositories?.[environment.projectId]);
    },
    durable: process.env.NODE_ENV !== "test",
    manualScheduling: process.env.NODE_ENV === "test",
  });
  service.onClose(() => {
    database?.close();
    database = null;
  });
  service.onStart(() => {
    // Phase 7: surviving backend-local journals become legacy summaries.
    void importOpenCodeCommandJournals(service, input.dataDir).catch((error) => {
      log.warn("journal-import.failed", { error: formatLogError(error) });
    });
  });
  return service;
}
