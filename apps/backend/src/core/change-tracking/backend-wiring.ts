/**
 * Builds the backend's ChangeTrackingService from the application's storage
 * and environment records. Kept apart from `index.ts` so the backend entry
 * only decides *when* tracking starts, not how it is assembled.
 */

import type { StorageDatabase } from "../storage-database.js";
import { openBackendDatabase } from "../storage-stores.js";
import type { StorageService } from "../storage.js";
import { baselineTargetBranch } from "../diff-baseline.js";
import { importOpenCodeCommandJournals } from "./legacy-import.js";
import { ChangeTrackingService } from "./service.js";
import type { WorktreeTarget } from "./worktree-owner.js";

export function createBackendChangeTracking(input: {
  dataDir: string;
  storage: Pick<StorageService, "getEnvironment" | "loadConfig">;
  emit: (event: string, payload: unknown) => void;
  refreshEnvironment: (environmentId: string) => void;
}): ChangeTrackingService {
  // The ledger shares orkestrator.sqlite through its own connection (WAL), as
  // other row engines do; it is opened on first use, after storage init.
  let database: StorageDatabase | null = null;
  const service = new ChangeTrackingService({
    dataDir: input.dataDir,
    database: () => {
      if (!database || database.isClosed()) database = openBackendDatabase(input.dataDir);
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
    requestEnvironmentRefresh: input.refreshEnvironment,
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
      console.warn(
        "[change-tracking] legacy journal import failed:",
        error instanceof Error ? error.message : error,
      );
    });
  });
  return service;
}
