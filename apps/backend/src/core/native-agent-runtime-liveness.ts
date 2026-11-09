/**
 * Whether a provider cached for an id with no environment row still serves a
 * live runtime: a coordinator conversation or a bug report.
 *
 * The provider pruner disposes providers whose environment is gone, and reads
 * the environment rows to decide. Runtime ids never have one, so without this
 * a coordinator's provider was disposed on every launch scan, including one an
 * ensure or a read was still using.
 */
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { resolveBugReportRuntime } from "./bug-report-runtime.js";
import { resolveCoordinatorRuntime } from "./coordinator-runtime.js";
import type { StorageService } from "./storage.js";

export async function runtimeStillLive(storage: StorageService, id: string): Promise<boolean> {
  try {
    if (coordinatorIdFromRuntimeId(id)) {
      return (await resolveCoordinatorRuntime(storage, id)).status === "ready";
    }
    if (bugReportIdFromRuntimeId(id)) {
      return (await resolveBugReportRuntime(storage, id)).status === "ready";
    }
  } catch {
    // An unreadable store proves nothing either way; keep the provider.
    return true;
  }
  return false;
}
