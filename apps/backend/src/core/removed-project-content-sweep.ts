import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { NoStoredProjectsError } from "./storage-kanban-removed-projects.js";
import type { StorageService } from "./storage.js";

const log = createLogger("storage");

/**
 * Startup pass for #2328: deletes the rows that projects removed
 * before project removal deleted their content left behind
 * (`StorageService.sweepRemovedProjectContent`). Runs once per backend start,
 * in the background; it never rejects. A refusal deletes nothing and is
 * tried again at the next start: an unreadable projects store is logged, a
 * machine with no project stored is not.
 */
export async function sweepRemovedProjectContentAtStartup(
  storage: Pick<StorageService, "sweepRemovedProjectContent">,
): Promise<void> {
  try {
    const result = await storage.sweepRemovedProjectContent();
    if (result.projects || result.deliveryRecords || result.completionComments) {
      log.info("removed-project-sweep.removed", {
        projects: result.projects,
        tickets: result.tickets,
        deliveryRecords: result.deliveryRecords,
        labelCatalogues: result.labelCatalogues,
        notes: result.notes,
        featurePlans: result.featurePlans,
        completionComments: result.completionComments,
      });
    }
  } catch (error) {
    // A new install, or one with every project removed: nothing to compare with.
    if (error instanceof NoStoredProjectsError) return;
    log.warn("removed-project-sweep.refused", { error: formatLogError(error, { message: false }) });
  }
}
