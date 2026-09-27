import {
  isFeaturePlanningRecord,
  isTerminalFeaturePlanningPhase,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import type { StorageService } from "./storage.js";
import type { WorkflowDiscoveryResult } from "./workflow-supervisor.js";

/**
 * What a feature-planning record still owes the backend (step 08, task 1).
 *
 * | Obligation | Record state | Why it is runnable |
 * | --- | --- | --- |
 * | `dispatch` | `dispatching` | Environment/bridge/session readiness and launch retry; an existing `dispatchId` means reconcile the transcript instead of re-sending (ambiguous dispatch stays parked on that id). |
 * | `await-reply` | `running` | Reply and idle deadlines are elapsed-time, read from the provider. |
 * | `persist` | `persisting` | Apply the reply; with `resultAppliedAt`, only the durable result consumption outbox remains. |
 * | `cancelling` | `cancelling` | Abort and close the result slot, then detach the record. |
 *
 * `complete`/`failed` owe nothing: retry is a user command that wakes the key.
 */
export type FeaturePlanningObligation = "dispatch" | "await-reply" | "persist" | "cancelling";

export function featurePlanningObligation(record: unknown): FeaturePlanningObligation | null {
  if (!isFeaturePlanningRecord(record)) return null;
  if (isTerminalFeaturePlanningPhase(record.phase)) return null;
  switch (record.phase) {
    case "dispatching":
      return "dispatch";
    case "running":
      return "await-reply";
    case "persisting":
      return "persist";
    case "cancelling":
      return "cancelling";
    default:
      return null;
  }
}

export function featurePlanningTarget(record: FeaturePlanningRecord): string | undefined {
  return record.environmentId;
}

/**
 * Authoritative discovery over every stored plan. Plans are one store, so an
 * enumeration either succeeds completely or throws; a record that fails
 * validation is skipped (the service cannot advance it) without hiding others.
 */
export async function discoverFeaturePlanning(
  storage: Pick<StorageService, "listAllFeaturePlans">,
): Promise<WorkflowDiscoveryResult<FeaturePlanningObligation>> {
  const plans = await storage.listAllFeaturePlans();
  const entries: WorkflowDiscoveryResult<FeaturePlanningObligation>["entries"] = [];
  for (const plan of plans) {
    const record = plan.planning;
    const obligation = featurePlanningObligation(record);
    if (!obligation || !isFeaturePlanningRecord(record)) continue;
    const target = featurePlanningTarget(record);
    entries.push({ key: plan.id, obligation, ...(target ? { target } : {}) });
  }
  return { entries, scanned: plans.length, complete: true };
}
